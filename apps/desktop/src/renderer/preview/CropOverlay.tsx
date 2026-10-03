import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { canonicalCrop, dragCrop, FULL_CROP, type CropHandle, type CropRect } from '../../shared/crop';
import { updateLayerParams, projectSummary, type CompositionSummary, type LayerSummary } from '../ipc';
import { logMutationFailure } from '../errors/tryMutate';
import { endCrop, useCropEditingStore } from '../state/cropEditingStore';
import { usePrimaryLayerId } from '../state/selectionStore';
import { useProjectStore, useOpenComposition } from '../state/projectStore';
import { usePreviewRenderTargetId } from '../state/compositionAnchorStore';
import { useFocusedPlayheadReader } from '../state/playheadProjection';
import { useActiveTool } from '../state/toolStore';
import { getGizmoProbe } from './gizmoProbeRegistry';
import { layerFrameAt } from './centerInFrame';
import { compToClient, containFit, layerQuad, handleOutwardDeg, resizeCursorForDeg, type Pt } from './gizmoGeometry';
import { observeClientRect } from './layoutRectCache';
import { cropDelta, cropQuad } from './cropGeometry';
import { isInTransientWidget } from '../shortcuts/match';

const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
const edges = ['n', 'e', 's', 'w'] as const;
const scaleHandle = { nw: 'tl', n: 't', ne: 'tr', e: 'r', se: 'br', s: 'b', sw: 'bl', w: 'l' } as const;

export function CropOverlayHost() {
  const editing = useCropEditingStore(s => s.layerId);
  const selected = usePrimaryLayerId();
  const composition = useOpenComposition();
  const target = usePreviewRenderTargetId();
  const tool = useActiveTool();
  const track = composition?.tracks.find(t => t.layers.some(l => l.id === editing));
  const layer = track?.layers.find(l => l.id === editing);
  const valid = editing !== null && editing === selected && target === composition?.id && tool === 'select'
    && layer?.params.kind === 'VideoClip' && layer.enabled && !layer.locked && track?.enabled && !track.locked;
  useEffect(() => { if (editing && !valid) endCrop(); }, [editing, valid]);
  return valid && layer && composition ? <CropOverlay key={layer.id} layer={layer} composition={composition} /> : null;
}

function CropOverlay({ layer, composition }: { layer: LayerSummary; composition: CompositionSummary }) {
  const { t } = useTranslation();
  const svg = useRef<SVGSVGElement>(null);
  const live = useRef(layer); live.current = layer;
  const readTime = useFocusedPlayheadReader();
  const reader = useRef(readTime); reader.current = readTime;
  const geometry = useRef<{ q: Pt[] } | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const drag = useRef<{ pointer: number; start: Pt; rect: CropRect; handle: CropHandle; q: Pt[] } | null>(null);
  const cancel = () => { drag.current = null; useCropEditingStore.setState({ draft: undefined }); };

  useEffect(() => {
    mounted.current = true;
    const el = svg.current!;
    const bounds = observeClientRect(el);
    let raf = 0;
    let drawn = '';
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const probe = getGizmoProbe(), canvas = probe?.canvasRect(), size = probe?.naturalSizeOf(layer.id);
      const now = reader.current(), current = live.current;
      const fit = canvas && containFit(canvas, composition.width, composition.height);
      if (!fit || !size || current.params.kind !== 'VideoClip' || now < current.t_start_us || now >= current.t_end_us) {
        el.style.visibility = 'hidden'; geometry.current = null; drawn = ''; return;
      }
      const frame = layerFrameAt(current, now, size);
      const q = layerQuad({ ...frame, visibleRect: null }).map(p => compToClient(p, fit));
      geometry.current = { q };
      const state = useCropEditingStore.getState();
      const r = (state.draft === undefined ? current.params.crop : state.draft) ?? FULL_CROP;
      const own = bounds.rect();
      const signature = JSON.stringify([q, r, own.left, own.top]);
      if (signature === drawn) return;
      drawn = signature;
      const points = cropQuad(q, r).map(p => ({ x: p.x - own.left, y: p.y - own.top }));
      const full = q.map(p => ({ x: p.x - own.left, y: p.y - own.top }));
      el.style.visibility = 'visible';
      el.querySelector('[data-crop-box]')?.setAttribute('points', points.map(p => `${p.x},${p.y}`).join(' '));
      el.querySelector('[data-crop-source]')?.setAttribute('points', full.map(p => `${p.x},${p.y}`).join(' '));
      const positions = [points[0]!, midpoint(points[0]!, points[1]!), points[1]!, midpoint(points[1]!, points[2]!), points[2]!, midpoint(points[2]!, points[3]!), points[3]!, midpoint(points[3]!, points[0]!)];
      handles.forEach((h, i) => {
        const target = el.querySelector(`[data-crop-handle="${h}"]`)!;
        target.setAttribute('transform', `translate(${positions[i]!.x} ${positions[i]!.y})`);
        const angle = handleOutwardDeg(q, scaleHandle[h]);
        (target as SVGGElement).style.cursor = resizeCursorForDeg(angle ?? 0);
      });
      edges.forEach((h, i) => {
        const edge = el.querySelector<SVGLineElement>(`[data-crop-edge="${h}"]`)!;
        const a = points[i]!, b = points[(i + 1) % 4]!;
        edge.setAttribute('x1', String(a.x)); edge.setAttribute('y1', String(a.y));
        edge.setAttribute('x2', String(b.x)); edge.setAttribute('y2', String(b.y));
        edge.style.cursor = resizeCursorForDeg(handleOutwardDeg(q, scaleHandle[h]) ?? 0);
      });
    };
    draw();
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      if (isInTransientWidget(e.target)) return;
      // Editing the inspector has its own Enter/Escape handling.
      if (e.target instanceof HTMLElement && e.target.closest('input,textarea,[contenteditable="true"]')) return;
      e.preventDefault(); e.stopPropagation();
      if (drag.current) cancel(); else if (!busy.current) endCrop();
    };
    window.addEventListener('keydown', key, true);
    return () => { mounted.current = false; cancelAnimationFrame(raf); bounds.dispose(); window.removeEventListener('keydown', key, true); cancel(); };
  }, [layer.id, composition.width, composition.height]);

  const down = (e: React.PointerEvent<SVGElement>, handle: CropHandle) => {
    if (e.button !== 0 || !geometry.current || busy.current || live.current.params.kind !== 'VideoClip') return;
    e.preventDefault(); e.stopPropagation();
    drag.current = { pointer: e.pointerId, start: { x: e.clientX, y: e.clientY }, rect: live.current.params.crop ?? { ...FULL_CROP }, handle, q: geometry.current.q };
    svg.current!.setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    const delta = cropDelta(d.q, e.clientX - d.start.x, e.clientY - d.start.y);
    if (delta) useCropEditingStore.setState({ draft: dragCrop(d.rect, d.handle, delta.x, delta.y) });
  };
  const up = async (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    move(e);
    const draft = useCropEditingStore.getState().draft;
    drag.current = null;
    svg.current?.releasePointerCapture(e.pointerId);
    if (draft === undefined || JSON.stringify(canonicalCrop(draft)) === JSON.stringify(canonicalCrop(d.rect))) { cancel(); return; }
    busy.current = true;
    try { await updateLayerParams(layer.id, { kind: 'VideoClip', crop: canonicalCrop(draft) }); useProjectStore.getState().apply(await projectSummary()); }
    catch (err) { logMutationFailure(err, 'Crop'); }
    finally { busy.current = false; if (mounted.current) cancel(); }
  };
  return <svg ref={svg} data-testid="crop-overlay" aria-label={t('crop.title')}
    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible', visibility: 'hidden', touchAction: 'none' }}
    onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} onLostPointerCapture={() => { if (drag.current) cancel(); }}>
    <polygon data-crop-source fill="none" stroke="white" strokeOpacity={0.4} strokeDasharray="4 4" />
    <polygon data-crop-box fill="transparent" stroke="white" strokeWidth={1.5} style={{ pointerEvents: 'all', cursor: 'move' }} onPointerDown={e => down(e, 'move')} />
    {edges.map(h => <line key={h} data-crop-edge={h} stroke="transparent" strokeWidth={12}
      style={{ pointerEvents: 'stroke' }} onPointerDown={e => down(e, h)} />)}
    {handles.map(h => <g key={h} data-crop-handle={h} style={{ pointerEvents: 'all' }} onPointerDown={e => down(e, h)}>
      <rect x={-10} y={-10} width={20} height={20} fill="transparent" />
      <rect x={-4} y={-4} width={8} height={8} fill="white" stroke="#222" />
    </g>)}
  </svg>;
}
function midpoint(a: Pt, b: Pt): Pt { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
