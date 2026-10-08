"""PROTOTYPE: 1 fps -> independent image embeddings -> brute-force text search.

JSON-lines stdin/stdout, diagnostics on stderr. The index and thumbnails live
only in this process. Model weights use the normal Hugging Face download cache.
"""
import base64
import contextlib
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

os.environ.setdefault("HF_HOME", str(Path(__file__).resolve().parents[4] / ".scratch/embeddinggemma-poc/huggingface"))
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

MODEL_ID = "google/embeddinggemma-2"
BATCH_SIZE = 4
model = None
vectors = None
rows = []
decoder = None


def send(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def progress(**status):
    send({"event": "progress", "status": status})


def stop_decoder():
    global decoder
    if decoder is not None:
        if decoder.poll() is None:
            decoder.kill()
        decoder.wait()
        decoder = None


def terminate(_signum, _frame):
    stop_decoder()
    raise SystemExit(0)


signal.signal(signal.SIGTERM, terminate)


def load_model():
    global model
    if model is not None:
        return
    import torch
    from sentence_transformers import SentenceTransformer

    device = os.environ.get("WEFTCUT_EMBEDDING_DEVICE", "auto")
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    # Avoid saturating every CPU thread while the editor is open.
    torch.set_num_threads(min(8, os.cpu_count() or 1))
    dtype = torch.bfloat16 if device.startswith("cuda") and torch.cuda.is_bf16_supported() else torch.float32
    progress(device=f"{device} / {str(dtype).removeprefix('torch.')}")
    with contextlib.redirect_stdout(sys.stderr):
        model = SentenceTransformer(
            MODEL_ID, device=device, config_kwargs={"audio_config": None},
            model_kwargs={"torch_dtype": dtype},
        )
    model.eval()


def encode(inputs, **kwargs):
    import numpy as np
    import torch

    with torch.inference_mode(), contextlib.redirect_stdout(sys.stderr):
        result = model.encode(inputs, batch_size=BATCH_SIZE, show_progress_bar=False,
                              convert_to_numpy=True, normalize_embeddings=True, **kwargs)
    result = np.asarray(result, dtype=np.float32)
    if not np.isfinite(result).all():
        raise RuntimeError("Model produced non-finite embeddings; float16 is unsupported.")
    return result


def frames(media, ffmpeg):
    """Stream PPMs so long sources never accumulate decoded frames on disk/RAM.

    copyts + subtract the app's container origin preserves the source clock.
    fps selects the frame at/before each integer second, including subsecond
    clips; each returned timestamp is that sampling anchor, in source time.
    """
    global decoder
    from PIL import Image

    origin = media["startPtsUs"] / 1_000_000
    filters = (f"setpts=PTS-({origin:.6f})/TB,"
               "fps=1:start_time=0:round=up:eof_action=pass,"
               "scale=w='min(768,iw)':h='min(768,ih)':force_original_aspect_ratio=decrease,setsar=1")
    with tempfile.TemporaryFile() as errors:
        decoder = subprocess.Popen([
            ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "2",
            "-copyts", "-i", media["path"], "-map", "0:v:0", "-an", "-sn",
            "-vf", filters, "-threads", "1", "-fps_mode", "passthrough",
            "-c:v", "ppm", "-pix_fmt", "rgb24", "-f", "image2pipe", "pipe:1",
        ], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=errors)
        try:
            second = 0
            while True:
                magic = decoder.stdout.readline()
                if not magic:
                    break
                if magic.strip() != b"P6":
                    raise RuntimeError("Unexpected FFmpeg frame format")
                width, height = map(int, decoder.stdout.readline().split())
                if decoder.stdout.readline().strip() != b"255":
                    raise RuntimeError("Unexpected FFmpeg pixel depth")
                size = width * height * 3
                data = decoder.stdout.read(size)
                if len(data) != size:
                    raise RuntimeError("Incomplete FFmpeg frame")
                yield second * 1_000_000, Image.frombytes("RGB", (width, height), data)
                second += 1
            code = decoder.wait()
            if code:
                errors.seek(0)
                raise RuntimeError(errors.read().decode(errors="replace")[-1500:])
        finally:
            if decoder is not None:
                decoder.stdout.close()
            stop_decoder()


def index(request):
    global rows, vectors
    import numpy as np

    rows, vectors = [], None
    load_model()
    chunks, failures = [], []
    for count, media in enumerate(request["media"]):
        progress(phase="indexing", currentVideo=media["label"], completedVideos=count,
                 message="正在按 1 fps 抽帧并编码。")
        local_rows, local_vectors, batch = [], [], []

        def flush():
            if not batch:
                return
            embeddings = encode([{"image": image} for _, image in batch], prompt="")
            if embeddings.ndim != 2 or embeddings.shape != (len(batch), 768):
                raise RuntimeError(f"Unexpected embedding shape: {embeddings.shape}")
            local_vectors.append(embeddings)
            for timestamp, image in batch:
                image.thumbnail((256, 144))
                thumbnail = io.BytesIO()
                image.save(thumbnail, format="JPEG", quality=75)
                local_rows.append({"mediaId": media["mediaId"], "label": media["label"],
                                   "timeUs": timestamp,
                                   "thumbnail": "data:image/jpeg;base64," + base64.b64encode(thumbnail.getvalue()).decode()})
                image.close()
            batch.clear()
            progress(frames=len(rows) + len(local_rows))

        try:
            with contextlib.closing(frames(media, request["ffmpeg"])) as stream:
                for timestamp, image in stream:
                    batch.append((timestamp, image))
                    if len(batch) == BATCH_SIZE:
                        flush()
                flush()
            if not local_rows:
                raise RuntimeError("No video frames decoded")
            rows.extend(local_rows)
            chunks.extend(local_vectors)
        except Exception as error:
            # Do not publish half a corrupt source. Other videos still run.
            failures.append(f"{media['label']}: {error}")
            for _, image in batch:
                image.close()
        progress(completedVideos=count + 1, frames=len(rows), failures=failures)
    if chunks:
        vectors = np.concatenate(chunks, axis=0)
    if not rows:
        raise RuntimeError("没有成功索引的视频帧。" + "\n".join(failures))
    return {"frames": len(rows)}


def search(request):
    import numpy as np

    if vectors is None or not rows:
        raise RuntimeError("Build the index first")
    started = time.perf_counter()
    query = encode([request["query"]], prompt_name="SearchQuery")[0]
    scores = vectors @ query
    # Raw top frames, deliberately no temporal merging/reranking for this POC.
    best = np.argsort(-scores, kind="stable")[:request.get("limit", 30)]
    return {"hits": [{**rows[int(i)], "score": float(scores[i])} for i in best],
            "queryMs": (time.perf_counter() - started) * 1000, "frames": len(rows)}


def main():
    for line in sys.stdin:
        request = json.loads(line)
        try:
            if request["op"] == "index":
                result = index(request)
            elif request["op"] == "search":
                result = search(request)
            else:
                raise ValueError("Unknown operation")
            send({"id": request["id"], "result": result})
        except Exception as error:
            import traceback
            traceback.print_exc(file=sys.stderr)
            send({"id": request["id"], "error": str(error)})
    stop_decoder()


if __name__ == "__main__":
    main()
