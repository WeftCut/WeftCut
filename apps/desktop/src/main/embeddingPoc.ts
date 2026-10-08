// PROTOTYPE: one in-memory index in a local Python process. Delete freely.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { EmbeddingPocResults, EmbeddingPocStatus } from '../shared/embedding-poc';
import type { Project } from './state/model';

const empty = (): EmbeddingPocStatus => ({
  phase: 'idle', projectId: null, totalVideos: 0, completedVideos: 0,
  frames: 0, elapsedSeconds: 0, currentVideo: '', device: '', failures: [], message: '',
});

export function createEmbeddingPoc(root: string, ffmpeg: string, snapshot: () => Project | null) {
  let state = empty();
  let child: ChildProcessWithoutNullStreams | null = null;
  let corpus = '';
  let sequence = 0;
  let started = 0;
  let stderr = '';
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const signature = (p: Project | null) => p ? JSON.stringify([p.project_id,
    Object.values(p.media_pool).filter(m => m.kind === 'Video')
      .map(m => [m.id, m.path_abs, m.file_hash_blake3]).sort(),
  ]) : '';

  function stop() {
    const worker = child;
    child = null;
    // Own the decoder too: killing Python during a native model call must not
    // leave its FFmpeg child blocked forever on the image pipe.
    const kill = (signal: NodeJS.Signals) => {
      if (!worker?.pid || worker.exitCode !== null || worker.signalCode !== null) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(worker.pid), '/T', '/F'], { windowsHide: true });
        killer.on('error', () => worker.kill());
      } else {
        try { process.kill(-worker.pid, signal); } catch { /* Already exited. */ }
      }
    };
    kill('SIGTERM');
    if (worker) {
      const timer = setTimeout(() => kill('SIGKILL'), 3000);
      timer.unref();
      worker.once('exit', () => clearTimeout(timer));
    }
    for (const request of pending.values()) request.reject(new Error('Index stopped.'));
    pending.clear();
  }

  function syncProject() {
    if (corpus && signature(snapshot()) !== corpus) {
      stop();
      corpus = '';
      state = { ...empty(), message: '素材池已变化，请重新建立索引。' };
    }
  }

  function status(): EmbeddingPocStatus {
    syncProject();
    return { ...state, elapsedSeconds: state.phase === 'loading' || state.phase === 'indexing'
      ? (Date.now() - started) / 1000 : state.elapsedSeconds };
  }

  function request(op: string, args: Record<string, unknown>): Promise<unknown> {
    const worker = child;
    if (!worker) return Promise.reject(new Error('请先建立视频索引。'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.stdin.write(JSON.stringify({ id, op, ...args }) + '\n', error => {
        if (error) { pending.delete(id); reject(error); }
      });
    });
  }

  function start(): EmbeddingPocStatus {
    syncProject();
    if (state.phase === 'loading' || state.phase === 'indexing') return status();
    stop();
    const project = snapshot();
    if (!project) throw new Error('请先打开项目。');
    const media = Object.values(project.media_pool).filter(m => m.kind === 'Video').map(m => ({
      mediaId: m.id, label: m.label ?? path.basename(m.path_abs), path: m.path_abs,
      startPtsUs: m.metadata.start_pts_us ?? 0,
    }));
    if (media.length === 0) throw new Error('素材池中没有视频。');
    const runtime = path.join(root, '.scratch/embeddinggemma-poc');
    const python = process.env.WEFTCUT_EMBEDDING_PYTHON ?? path.join(runtime, 'venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3');
    if (!existsSync(python)) throw new Error('请先在仓库目录运行 npm run poc:embedding:setup。');
    if (!existsSync(ffmpeg)) throw new Error('缺少应用自带的 FFmpeg，请运行 npm run ffmpeg:fetch（apps/desktop）。');
    corpus = signature(project);
    started = Date.now();
    stderr = '';
    state = { ...empty(), phase: 'loading', projectId: project.project_id, totalVideos: media.length,
      message: '正在加载 EmbeddingGemma 2；首次使用需要下载模型。' };
    const worker = spawn(python, ['-u', path.join(root, 'apps/desktop/scripts/embedding-poc/worker.py')], {
      cwd: root, windowsHide: true, detached: process.platform !== 'win32',
      env: { ...process.env, HF_HOME: process.env.HF_HOME ?? path.join(runtime, 'huggingface'),
        TOKENIZERS_PARALLELISM: 'false', PYTHONUNBUFFERED: '1' },
    });
    child = worker;
    const fail = (error: Error) => {
      if (child !== worker) return;
      state = { ...state, phase: 'error', elapsedSeconds: (Date.now() - started) / 1000,
        message: error.message, frames: 0 };
      stop();
    };
    worker.on('error', fail);
    worker.stdin.on('error', fail);
    worker.stderr.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-6000);
      console.log('[embedding-poc]', data.toString().trim());
    });
    worker.on('exit', code => fail(new Error(`Embedding worker exited (${code}). ${stderr}`)));
    createInterface({ input: worker.stdout }).on('line', line => {
      if (child !== worker) return;
      try {
        const message = JSON.parse(line);
        if (message.event === 'progress') {
          state = { ...state, ...message.status, elapsedSeconds: (Date.now() - started) / 1000 };
        } else {
          const waiting = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) waiting?.reject(new Error(message.error));
          else waiting?.resolve(message.result);
        }
      } catch { fail(new Error(`Invalid worker response: ${line.slice(0, 300)}`)); }
    });
    void request('index', { media, ffmpeg }).then(() => {
      if (child !== worker) return;
      syncProject();
      if (child === worker) state = { ...state, phase: 'ready', currentVideo: '',
        elapsedSeconds: (Date.now() - started) / 1000, message: '索引已就绪。' };
    }).catch(error => fail(error instanceof Error ? error : new Error(String(error))));
    return status();
  }

  return {
    status, start,
    cancel(): EmbeddingPocStatus {
      const elapsedSeconds = status().elapsedSeconds;
      stop();
      state = { ...empty(), phase: 'cancelled', elapsedSeconds, message: '已停止并释放内存索引。' };
      corpus = '';
      return state;
    },
    async search(query: string): Promise<EmbeddingPocResults> {
      syncProject();
      if (typeof query !== 'string' || !query.trim() || query.length > 2000) throw new Error('请输入 1–2000 字的搜索内容。');
      if (state.phase !== 'ready' || !state.frames) throw new Error('请先完成视频索引。');
      const index = child;
      const result = await request('search', { query: query.trim(), limit: 30 }) as EmbeddingPocResults;
      syncProject();
      if (child !== index) throw new Error('素材池已变化，请重新建立索引。');
      return result;
    },
    dispose: stop,
  };
}
