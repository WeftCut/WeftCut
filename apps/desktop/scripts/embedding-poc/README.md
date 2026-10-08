# EmbeddingGemma 2 visual-search POC

Branch: `poc/embeddinggemma-video-search`.

Status: **On hold / 待定** (2026-10-08). This branch preserves the development
POC and runtime experiments for later evaluation. No production rollout or
runtime selection has been approved. The app POC uses Python; the native LiteRT
runner is a separate benchmark. Model weights, virtual environments and test
videos stay local and are not included in this branch.

Measured results are archived in `benchmark-results.json` beside this README.

Question: does indexing every video in the current media pool at **1 frame per
second**, with one image embedding per frame, produce useful Chinese/English
visual search results? This is a throwaway integration, not a production index.

## Run

From the repository root:

```sh
npm run poc:embedding
```

The runner creates a Python virtual environment under
`.scratch/embeddinggemma-poc/venv` if missing, installs the pinned dependencies,
then starts the normal desktop development app. Python 3.12+ and the app's
bundled FFmpeg are required. To install dependencies separately:

```sh
npm run poc:embedding:setup
```

Open a project, import videos into the media pool, then **Ctrl/Cmd+K → 画面搜索
POC → 建立索引**. Every video is included, whether or not it is on a timeline.
Enter a description and press **搜索画面**. Results show the raw top 30 frames,
thumbnail, source timestamp, and cosine similarity (not a confidence score).
Click a thumbnail to preview the source with browser-supported codecs. **定位
片段 / 素材** seeks the first timeline placement containing the source time, or
reveals the source in the media pool if no placement contains it.

The first index downloads `google/embeddinggemma-2`. Model weights are kept in
`.scratch/embeddinggemma-poc/huggingface` (or an explicitly supplied `HF_HOME`).
Media, frame vectors and thumbnails stay local. The index itself lives only in
the worker's memory: rebuilding, cancellation, application exit, or a changed
video corpus discards it. No vector DB, source-hash cache, incremental updates,
automatic import jobs, temporal merging, or description generation.

## Experiment details

- FFmpeg streams every source at 1 fps, with nominal source anchors 0s, 1s,
  2s, etc. The container origin comes from the existing media metadata. Decode
  one source at a time; bound decoded-frame memory to batches of four.
- Resize frames to fit 768×768 without cropping. Encode each as an independent
  **image** with the model's default image token budget; this experiment does
  not measure multi-frame temporal/video understanding.
- Load text + vision, disable the audio encoder. CPU uses float32; CUDA with
  BF16 support uses bfloat16. Never float16.
- Keep full 768-dimensional normalized vectors. Queries use `SearchQuery`;
  images have no text prefix. Search is a brute-force dot product.
- Report elapsed wall time (including model loading), frame count, average
  frames/second, device, failed sources, and query embedding + search time.
- A failed source contributes no partial index; remaining videos continue.
- This UI is available in development or builds with
  `VITE_WEFTCUT_EMBEDDING_POC=1`; its main-process endpoints are development-only.

The default installer uses CPU PyTorch for a reproducible baseline. With a
working NVIDIA driver supporting CUDA 13.0, install the GPU runtime with:

```sh
npm run poc:embedding:setup -- --cuda
npm run poc:embedding
```

Normal launches reuse the installed runtime. Explicit setup without `--cuda`
installs the CPU runtime. To use an existing CUDA environment, install the requirements and matching
PyTorch/torchvision there, then launch with
`WEFTCUT_EMBEDDING_PYTHON=/absolute/path/to/venv/bin/python3 npm run poc:embedding`.
`WEFTCUT_EMBEDDING_DEVICE=cpu|cuda|auto` overrides device selection.
Once all model files have downloaded, `HF_HUB_OFFLINE=1 npm run poc:embedding`
avoids startup network checks.

## Sources

- [Official model card](https://huggingface.co/google/embeddinggemma-2)
- [Official multimodal input examples](https://ai.google.dev/gemma/docs/embeddinggemma/multimodal-embeddinggemma-with-sentence-transformers)

User-media retrieval quality and long-library throughput remain the experiment
to judge in the app; a tiny smoke corpus is only an integration check.

## Initial integration check (2026-10-08)

Real Electron app, CPU float32, two 2.5-second videos made from Google's public
Golden Gate Bridge and kitchen example images: six frames indexed in 30.1 s
including model startup. The four queries below all ranked the corresponding
video's three frames above the other video. Query encoding + search took
45–60 ms. This is a two-scene sanity check, not a retrieval-quality benchmark.

| Query | Top scene | Best cosine similarity |
| --- | --- | --- |
| 跨海大桥 | Bridge | 0.682 |
| 厨房里的灶台和锅具 | Kitchen | 0.722 |
| a bridge over water | Bridge | 0.721 |
| a kitchen | Kitchen | 0.716 |

Typecheck, build, existing search tests (27), result preview, media-pool
navigation and cancellation passed. The initial React Doctor changed-scope scan
reported no issues (91/100), but omitted the then-untracked component. The final
scan with all files staged scored 84/100: one component-complexity warning and
three reviewed false positives. Polling already cancels its timer and guards
in-flight completion on unmount; both loading resets are already in `finally`,
guarded by request IDs to avoid resetting a newer operation. Component
decomposition remains deferred with this POC.
Local evidence: `.scratch/embeddinggemma-poc/smoke-results.json`
and `search-results.png`. A final rerun also verified source 2s → timeline 7s
navigation for a clip placed at 5s, corpus invalidation after importing another
video, and cancellation during indexing (`smoke-results-final.json`; 30.8 s
indexing, 60–77 ms queries). The initial run used CPU because the loaded NVIDIA
driver was older than its updated user-space libraries.

## GPU check (2026-10-08, after reboot)

The user's reboot loaded driver 595.99.02 and resolved the mismatch. The POC
venv now uses PyTorch 2.14.1+cu130 / torchvision 0.29.1+cu130 on an RTX 3050 OEM
with 8 GB VRAM. CUDA BF16 computation and `pip check` passed.

The actual Python worker indexed the five downloaded test videos (65.5 seconds
total) at the unchanged 1 fps / batch-of-four settings, producing 68 frames:

- Fresh worker, cached model weights, offline: 21.2 s including loading
  (3.2 frames/s); extraction and encoding alone: 14.0 s.
- Reindex in the same worker: 13.7 s (5.0 frames/s).
- Five Chinese queries: 22–25 ms each, with each query's top three frames from
  the corresponding source: cat, archery, tennis, baby/book, cartoon forest.

Evidence: `.scratch/embeddinggemma-poc/cuda-benchmark.json`. This measures the
worker directly; the earlier Electron smoke check covers UI integration. The
user's CPU screenshot showed 0.22 frames/s on a six-video project, so it is a
rough reference rather than a controlled same-corpus comparison. GPU dependency
downloads were staged in RAM and removed after verification.

## Native LiteRT-LM benchmark (2026-10-08)

Question: can a Python-free native deployment improve indexing speed on this
RTX 3050? This is a standalone throwaway benchmark; the app still uses the
working Python worker. No app indexing cache or persistence was added.

Run from the repo root (Linux x64; Node, g++, curl and unzip required):

```sh
npm run poc:embedding:litert -- gpu 140
npm run poc:embedding:litert -- gpu 70
npm run poc:embedding:litert -- cpu 140
```

The runner provisions pinned, SHA256-verified artifacts if missing, extracts
the same five local test videos at 1 fps to lossless PNGs, builds `litert-bench.cpp`,
and measures two indexing passes plus five Chinese queries. It requires the
previously downloaded `test-videos/*.mp4` fixtures. Inference runs in a C++
executable linked to Google's native `liblitert-lm.so` through its public C ABI.
The library is extracted from Google's `litert-lm-api` distribution archive;
Python is neither installed nor invoked by this runner. `ldd` confirms that the
executable/library do not depend on libpython or CUDA libraries. The runtime
selects the RTX 3050 using WebGPU over Vulkan.

Artifacts:

- LiteRT-LM v0.18.0 Linux x64 native library: 131,785,976 bytes.
- Official Text-Vision 440M QAT model: 387,710,976 bytes; text int4, vision int8.
- Combined native library + model: approximately 519.5 MB, excluding system
  libraries and runtime-generated kernel caches.
- Exact URLs and SHA256 values live in `setup-litert.mjs`; the model revision is
  `e301f74d5551b0c2641bd5cb4652a76239d5c5f8`.

The model supports 70/140 visual tokens; the original PyTorch POC defaults to
280. The comparison therefore also reruns PyTorch BF16 on the **same 68 PNGs**
at each budget, using batches of four and eight CPU threads:

```sh
.scratch/embeddinggemma-poc/venv/bin/python3 apps/desktop/scripts/embedding-poc/compare-torch.py
```

Measured warm-pass encoding times (exclude model loading and video extraction;
include PNG decode and preprocessing):

| Runtime | Visual tokens/frame | 68 frames | Frames/s |
| --- | ---: | ---: | ---: |
| PyTorch CUDA BF16 | 280 | 12.18 s | 5.58 |
| PyTorch CUDA BF16 | 140 | 5.59 s | 12.16 |
| LiteRT-LM native GPU | 140 | 7.80 s | 8.71 |
| PyTorch CUDA BF16 | 70 | 2.98 s | 22.80 |
| LiteRT-LM native GPU | 70 | 4.54 s | 14.97 |
| LiteRT-LM native CPU | 140 | 54.55 s | 1.25 |

At 140 tokens, requesting batches of four did not materially improve native
throughput versus individual requests. Explicitly requesting float16 activation
also gave 7.85 s, effectively unchanged; it does not imply all internal model
operations use float16. Native GPU queries took about 15–18 ms, CPU queries
31–43 ms. All five Chinese queries ranked the corresponding source in all top
three positions in the tested configurations. This small corpus cannot establish
general retrieval quality or parity after quantization.

Verdict: **native LiteRT works without Python and is far smaller to provision,
but it did not beat PyTorch CUDA at equal visual-token budgets on this machine.**
The apparent speedup over the original POC partly comes from reducing image
detail. The runtimes also differ in quantization and image preprocessing, so
this is a deployment comparison, not an isolated test of programming languages.

Video extraction to PNG took about 2.2 s separately; the production worker
streams PPM frames instead. Do not compare these encoding-only numbers directly
with the UI's cold end-to-end timer. Native initialization also depends on kernel
caches; the 140-token run above reused its compilation cache. Raw measurements,
logs, and the PyTorch control are under `.scratch/embeddinggemma-poc/litert/`.
Temporary PNGs, downloaded archive, and benchmark kernel caches are disposable;
the runner regenerates them. Keep the native library and model to rerun offline.

Sources: [LiteRT-LM v0.18.0](https://github.com/google-ai-edge/LiteRT-LM/releases/tag/v0.18.0),
[native embedding API](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.18.0/c/embedding_engine.h),
[official quantized model](https://huggingface.co/litert-community/embeddinggemma-2-text-vision-440m-litert-lm).
