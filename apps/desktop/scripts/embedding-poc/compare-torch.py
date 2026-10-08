"""PROTOTYPE control: same PNG frames and visual-token budgets as LiteRT."""
import io
import json
import os
from pathlib import Path
import time

root = Path(__file__).resolve().parents[4]
scratch = root / '.scratch/embeddinggemma-poc'
os.environ['HF_HOME'] = str(scratch / 'huggingface')
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'
import numpy as np
from PIL import Image
import torch
from sentence_transformers import SentenceTransformer

torch.set_num_threads(8)
assert torch.cuda.is_available()
frames = [(p.name, p.read_bytes()) for p in sorted((scratch / 'litert/frames').glob('*.png'))]
started = time.perf_counter()
model = SentenceTransformer('google/embeddinggemma-2', device='cuda', config_kwargs={'audio_config': None},
                            model_kwargs={'torch_dtype': torch.bfloat16})
model.eval()
summary = {'loadSeconds': time.perf_counter() - started, 'frames': len(frames), 'batchSize': 4, 'budgets': []}
queries = ['打瞌睡的猫', '射箭的人', '打网球', '戴墨镜的小孩翻书', '卡通森林']
with torch.inference_mode():
    for tokens in [280, 140, 70]:
        model[0].processing_kwargs = {'image': {'max_soft_tokens': tokens}}
        sample = Image.open(io.BytesIO(frames[0][1])).convert('RGB')
        features = model[0].tokenize([{'image': sample}])
        shapes = {k: list(v.shape) for k, v in features.items() if hasattr(v, 'shape')}
        sample.close()
        result = {'visionTokens': tokens, 'sampleShapes': shapes, 'runs': [], 'queries': []}
        for run in range(2):
            torch.cuda.synchronize()
            started = time.perf_counter()
            chunks = []
            for offset in range(0, len(frames), 4):
                images = [Image.open(io.BytesIO(data)).convert('RGB') for _, data in frames[offset:offset+4]]
                chunks.append(model.encode([{'image': image} for image in images], prompt='', batch_size=4,
                                          show_progress_bar=False, normalize_embeddings=True, convert_to_numpy=True))
                for image in images:
                    image.close()
            torch.cuda.synchronize()
            elapsed = time.perf_counter() - started
            vectors = np.concatenate(chunks).astype(np.float32)
            assert vectors.shape == (len(frames), 768) and np.isfinite(vectors).all()
            result['runs'].append({'seconds': elapsed, 'fps': len(frames)/elapsed})
            print('TORCH', tokens, run, elapsed, flush=True)
        for query in queries:
            started = time.perf_counter()
            vector = model.encode([query], prompt_name='SearchQuery', normalize_embeddings=True, convert_to_numpy=True)[0]
            scores = vectors @ vector
            order = np.argsort(-scores)[:3]
            result['queries'].append({'query': query, 'queryMs': (time.perf_counter()-started)*1000,
                                     'hits': [{'frame': frames[i][0], 'score': float(scores[i])} for i in order]})
        summary['budgets'].append(result)
(scratch / 'litert/torch-control.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
