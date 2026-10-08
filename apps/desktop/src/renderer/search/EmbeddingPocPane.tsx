// PROTOTYPE: expose raw frame matches and timing so retrieval can be judged.
import { useEffect, useRef, useState } from 'react';
import type { EmbeddingPocHit, EmbeddingPocResults, EmbeddingPocStatus } from '../../shared/embedding-poc';
import { convertFileSrc } from '../bridge/ipc';
import { localAtContent, sourceIn, sourceOut } from '../layerTiming';
import { approximateTime, exactTime } from '../timeMapping';
import { useProjectStore } from '../state/projectStore';
import { jumpToTimeUs, revealInMediaPool, revealLayerWithoutSeek } from '../state/navigation';
import { focusedRootUs } from '../state/playheadProjection';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const timestamp = (us: number) => {
  const seconds = Math.floor(us / 1_000_000);
  return `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds / 60 % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
};

export function EmbeddingPocPane({ onClose }: { onClose(): void }) {
  const summary = useProjectStore(s => s.summary);
  const key = JSON.stringify([summary?.project_id, summary?.media.filter(m => m.kind === 'Video').map(m => [m.id, m.path])]);
  return <EmbeddingPocSession key={key} onClose={onClose} />;
}

function EmbeddingPocSession({ onClose }: { onClose(): void }) {
  const summary = useProjectStore(s => s.summary);
  const [status, setStatus] = useState<EmbeddingPocStatus | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<EmbeddingPocResults | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [preview, setPreview] = useState<EmbeddingPocHit | null>(null);
  const requestId = useRef(0);
  const busy = status?.phase === 'loading' || status?.phase === 'indexing';
  const videoCount = summary?.media.filter(m => m.kind === 'Video').length ?? 0;

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await window.api.embeddingPoc.status();
        if (disposed) return;
        setStatus(next);
        if (next.phase !== 'ready') { setResults(null); setPreview(null); }
      } catch (e) { if (!disposed) setError(message(e)); }
      if (!disposed) timer = setTimeout(() => { void poll(); }, 1000);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); requestId.current++; };
  }, []);

  async function control(action: 'start' | 'cancel') {
    const id = ++requestId.current;
    setError(''); setResults(null); setPreview(null); setWorking(true);
    try {
      const next = await window.api.embeddingPoc[action]();
      if (id === requestId.current) setStatus(next);
    } catch (e) { if (id === requestId.current) setError(message(e)); }
    finally { if (id === requestId.current) setWorking(false); }
  }

  async function search() {
    const id = ++requestId.current;
    setWorking(true); setError(''); setResults(null); setPreview(null);
    try {
      const next = await window.api.embeddingPoc.search(query);
      if (id === requestId.current) setResults(next);
    } catch (e) { if (id === requestId.current) setError(message(e)); }
    finally { if (id === requestId.current) setWorking(false); }
  }

  function locate(hit: EmbeddingPocHit) {
    const current = useProjectStore.getState().summary;
    for (const composition of Object.values(current?.compositions ?? {})) {
      for (const track of composition.tracks) for (const layer of track.layers) {
        const params = layer.params;
        if (params.kind !== 'VideoClip' || params.media_id !== hit.mediaId) continue;
        if (hit.timeUs < approximateTime(sourceIn(params)) || hit.timeUs >= approximateTime(sourceOut({ ...layer, params }))) continue;
        if (revealLayerWithoutSeek(layer.id)) {
          const local = approximateTime(localAtContent(params, exactTime(hit.timeUs)));
          jumpToTimeUs(focusedRootUs(layer.t_start_us + local));
          onClose();
          return;
        }
      }
    }
    if (revealInMediaPool(hit.mediaId)) onClose();
    else setError('素材已被移除，请重新索引。');
  }

  const previewMedia = summary?.media.find(m => m.id === preview?.mediaId);
  return <section className="embedding-poc" aria-label="画面搜索 POC">
    <p>EmbeddingGemma 2 · 全部 {videoCount} 个视频 · 每秒一帧</p>
    <div className="embedding-poc-controls">
      <button type="button" disabled={busy || working || !videoCount} onClick={() => { void control('start'); }}>
        {status?.phase === 'ready' ? '全量重建索引' : '建立索引'}
      </button>
      <button type="button" disabled={(!busy && status?.phase !== 'ready') || working}
        onClick={() => { void control('cancel'); }}>{busy ? '取消索引' : '释放索引'}</button>
    </div>
    <div className="embedding-poc-status" role="status">
      {status ? <>
        <span>{status.message} {status.currentVideo}</span>
        <span>{status.completedVideos}/{status.totalVideos} 视频 · {status.frames} 帧 · {status.elapsedSeconds.toFixed(1)} s
          {status.elapsedSeconds > 0 && ` · ${(status.frames / status.elapsedSeconds).toFixed(2)} 帧/s`}
          {status.device && ` · ${status.device}`}</span>
      </> : '正在读取索引状态…'}
    </div>
    <small>索引仅保留在内存；素材池变化后需重建。结果按原始相似度排序，分数不是置信度。</small>
    {status?.failures.length ? <details><summary>{status.failures.length} 个视频索引失败</summary>
      {status.failures.map(f => <p key={f}>{f}</p>)}
    </details> : null}
    <form className="embedding-poc-controls" onSubmit={event => { event.preventDefault(); void search(); }}>
      <input aria-label="描述要查找的画面" placeholder="例如：夕阳下的海边、室内采访、人物近景"
        disabled={working} maxLength={2000} value={query} onChange={event => { setQuery(event.target.value); setResults(null); }} />
      <button type="submit" disabled={status?.phase !== 'ready' || working || !query.trim()}>
        {working ? '处理中…' : '搜索画面'}
      </button>
    </form>
    {error && <p role="alert" className="embedding-poc-error">{error}</p>}
    {results && <p>检索 {results.frames} 帧 · {results.queryMs.toFixed(0)} ms · 前 {results.hits.length} 帧</p>}
    {preview && previewMedia && <div className="embedding-poc-preview">
      <video key={`${preview.mediaId}:${preview.timeUs}`} controls preload="metadata"
        src={convertFileSrc(previewMedia.path)} poster={preview.thumbnail}
        onLoadedMetadata={event => { event.currentTarget.currentTime = preview.timeUs / 1_000_000; }}>
        <track kind="captions" />
      </video>
      <small>{preview.label} · 源时间 {timestamp(preview.timeUs)}（播放需浏览器支持源格式）</small>
    </div>}
    <div className="embedding-poc-results">
      {results?.hits.map(hit => <article key={`${hit.mediaId}:${hit.timeUs}`}>
        <button type="button" className="embedding-poc-thumbnail" onClick={() => setPreview(hit)}
          aria-label={`预览 ${hit.label} ${timestamp(hit.timeUs)}`}>
          <img src={hit.thumbnail} alt={`${hit.label}，源时间 ${timestamp(hit.timeUs)}`} />
        </button>
        <span title={hit.label}>{hit.label}</span>
        <small>{timestamp(hit.timeUs)} · 相似度 {hit.score.toFixed(3)}</small>
        <button type="button" onClick={() => locate(hit)}>定位片段 / 素材</button>
      </article>)}
    </div>
  </section>;
}
