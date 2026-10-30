import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Structural guard for this research lane: it must remain opt-in until a real
// project conformance/performance gate exists. GPU availability alone is not it.
test('native video prototype remains outside the editor export dispatcher',async()=>{
  const jobs=await readFile(new URL('../../src/main/exportJobs.ts',import.meta.url),'utf8');
  assert.doesNotMatch(jobs,/video-worker|native-gpu-encode/);
});
test('worker refuses unsupported content, color and clobbering instead of silently dropping them',async()=>{
  const worker=await readFile(new URL('./video-worker.cpp',import.meta.url),'utf8');
  for (const guard of ['Unsupported job field','Frame-rate conversion is not yet qualified','Source display transform requires','explicitly tagged BT.709','Source ended before requested','O_EXCL','refusing overwrite','Export cancelled']) {
    assert.ok(worker.includes(guard),guard);
  }
  assert.doesNotMatch(worker,/\bsystem\s*\(|\bpopen\s*\(/);
});
