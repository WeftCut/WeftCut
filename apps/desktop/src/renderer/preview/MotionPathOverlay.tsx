import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { setPosition, type LayerSummary, type CompositionSummary } from '../ipc';
import { usePathEditingStore } from '../state/pathEditingStore';
import { type PositionAnimation, type PathPosition, type Point } from '../../shared/position';
import { evaluatePosition, setPositionPreview, previewPosition, subscribePositionPreviews, positionPreviewRevision } from '../render/position';
import { getGizmoProbe } from './gizmoProbeRegistry';
import { containFit } from './gizmoGeometry';
import { focusedPlayheadUs } from '../state/playheadProjection';
import { logMutationFailure } from '../errors/tryMutate';
import { transformOverrideFor } from '../render/transformOverrides';
export function MotionPathOverlay({ layer, composition }: {
    layer: LayerSummary;
    composition: CompositionSummary;
}) {
    const editing = usePathEditingStore(s => s.layerId === layer.id);
    useSyncExternalStore(subscribePositionPreviews, positionPreviewRevision);
    const selected = usePathEditingStore(s => s.nodeId);
    const svg = useRef<SVGSVGElement>(null), group = useRef<SVGGElement>(null), marker = useRef<SVGCircleElement>(null);
    const [draft, setDraft] = useState<PathPosition | null>(null);
    const [busy, setBusy] = useState(false);
    const drag = useRef<{
        source: PathPosition;
        node: number;
        part: 'point' | 'inHandle' | 'outHandle';
    } | null>(null);
    const source: PositionAnimation | null = 'x' in layer.params ? (layer.params.position ?? { mode: 'XY', x: layer.params.x, y: layer.params.y }) : null;
    const current = draft ?? (source ? previewPosition(source) : null);
    const live = useRef(current);
    live.current = current;
    useEffect(() => () => { if (source)
        setPositionPreview(source, null); }, [source]);
    useEffect(() => {
        const cancel = (e: KeyboardEvent) => {
            const d = drag.current;
            if (e.key !== 'Escape' || !d)
                return;
            e.preventDefault();
            e.stopPropagation();
            drag.current = null;
            live.current = d.source;
            setDraft(null);
            setPositionPreview(d.source, null);
        };
        window.addEventListener('keydown', cancel, true);
        return () => window.removeEventListener('keydown', cancel, true);
    }, []);
    useEffect(() => {
        let raf = 0;
        const draw = () => {
            raf = requestAnimationFrame(draw);
            const rect = getGizmoProbe()?.canvasRect();
            const root = svg.current;
            const g = group.current;
            if (!rect || !root || !g)
                return;
            const fit = containFit(rect, composition.width, composition.height);
            if (!fit)
                return;
            const own = root.getBoundingClientRect();
            const delta = transformOverrideFor(layer.id);
            g.setAttribute('transform', `translate(${fit.offX - own.left + (delta?.dx ?? 0) * fit.scale} ${fit.offY - own.top + (delta?.dy ?? 0) * fit.scale}) scale(${fit.scale})`);
            for (const circle of g.querySelectorAll<SVGCircleElement>('[data-handle-radius]'))
                circle.setAttribute('r', String(Number(circle.dataset.handleRadius) / fit.scale));
            const now = focusedPlayheadUs();
            root.style.visibility = now >= layer.t_start_us && now < layer.t_end_us ? 'visible' : 'hidden';
            if (live.current && marker.current) {
                const p = evaluatePosition(live.current, now - layer.t_start_us);
                marker.current.setAttribute('cx', String(p.x));
                marker.current.setAttribute('cy', String(p.y));
                marker.current.setAttribute('r', String(5 / fit.scale));
            }
        };
        draw();
        return () => cancelAnimationFrame(raf);
    }, [composition.width, composition.height, layer.id, layer.t_start_us, layer.t_end_us]);
    const route = useMemo(() => {
        if (!current)
            return '';
        if (current.mode === 'XY')
            return Array.from({ length: 129 }, (_, i) => { const p = evaluatePosition(current, (layer.t_end_us - layer.t_start_us) * i / 128); return `${i ? 'L' : 'M'}${p.x} ${p.y}`; }).join(' ');
        return current.path.nodes.map((n, i) => {
            if (!i)
                return `M${n.point.x} ${n.point.y}`;
            const a = current.path.nodes[i - 1]!;
            return a.segment === 'Line' ? `L${n.point.x} ${n.point.y}` : `C${a.point.x + a.outHandle.x} ${a.point.y + a.outHandle.y} ${n.point.x + n.inHandle.x} ${n.point.y + n.inHandle.y} ${n.point.x} ${n.point.y}`;
        }).join(' ');
    }, [current, layer.t_start_us, layer.t_end_us]);
    if (!source || (!editing && source.mode === 'XY'))
        return null;
    const pointer = (e: React.PointerEvent): Point | null => {
        const rect = getGizmoProbe()?.canvasRect();
        const fit = rect ? containFit(rect, composition.width, composition.height) : null;
        return fit ? { x: (e.clientX - fit.offX) / fit.scale, y: (e.clientY - fit.offY) / fit.scale } : null;
    };
    const begin = (e: React.PointerEvent<SVGCircleElement>, node: number, part: 'point' | 'inHandle' | 'outHandle') => {
        if (e.button !== 0 || source.mode !== 'Path' || busy || previewPosition(source) !== source)
            return;
        e.stopPropagation();
        e.preventDefault();
        usePathEditingStore.getState().setNode(source.path.nodes[node]!.id);
        drag.current = { source, node, part };
        e.currentTarget.setPointerCapture(e.pointerId);
    };
    const move = (e: React.PointerEvent<SVGCircleElement>) => {
        const d = drag.current, p = pointer(e);
        if (!d || !p)
            return;
        const next: PathPosition = { ...d.source, path: { nodes: d.source.path.nodes.map((n, i) => i !== d.node ? n : { ...n, [d.part]: d.part === 'point' ? p : { x: p.x - n.point.x, y: p.y - n.point.y } }) } };
        live.current = next;
        setDraft(next);
        setPositionPreview(d.source, next);
    };
    const end = async (e: React.PointerEvent<SVGCircleElement>) => {
        const d = drag.current;
        drag.current = null;
        if (!d)
            return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        try {
            if (e.type !== 'pointercancel' && live.current && live.current !== d.source) {
                setBusy(true);
                await setPosition(layer.id, live.current, true);
            }
        }
        catch (error) {
            logMutationFailure(error, 'Edit motion path');
        }
        finally {
            setPositionPreview(d.source, null);
            setDraft(null);
            setBusy(false);
        }
    };
    const handle = (node: number, part: 'point' | 'inHandle' | 'outHandle', p: Point) => <circle key={`${node}-${part}`} data-testid={`path-${node}-${part}`} data-handle-radius={part === 'point' ? 6 : 4} cx={p.x} cy={p.y} r={part === 'point' ? 6 : 4} fill={part === 'point' ? '#fff' : '#65d8ff'} stroke="#17394b" strokeWidth={1} vectorEffect="non-scaling-stroke" style={{ pointerEvents: editing && !busy ? 'all' : 'none', cursor: 'move' }} onPointerDown={e => begin(e, node, part)} onPointerMove={move} onPointerUp={e => void end(e)} onPointerCancel={e => void end(e)}/>;
    return <svg ref={svg} data-testid="motion-path-overlay" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'hidden', visibility: 'hidden' }}>
    <g ref={group}>
      <path d={route} fill="none" stroke="#111" strokeWidth={4} vectorEffect="non-scaling-stroke"/>
      <path d={route} fill="none" stroke="#65d8ff" strokeWidth={2} vectorEffect="non-scaling-stroke"/>
      {editing && current?.mode === 'Path' && current.path.nodes.map((n, i) => <g key={n.id}>
        {handle(i, 'point', n.point)}
        {n.id === selected && (['inHandle', 'outHandle'] as const).filter(part => (part === 'outHandle' ? n.segment === 'Cubic' && i < current.path.nodes.length - 1 : i > 0 && current.path.nodes[i - 1]!.segment === 'Cubic') && (n[part].x !== 0 || n[part].y !== 0)).map(part => { const p = { x: n.point.x + n[part].x, y: n.point.y + n[part].y }; return <g key={part}><line x1={n.point.x} y1={n.point.y} x2={p.x} y2={p.y} stroke="#65d8ff" strokeWidth={1} vectorEffect="non-scaling-stroke"/>{handle(i, part, p)}</g>; })}
      </g>)}
      <circle ref={marker} fill="#ffca66" stroke="#111" strokeWidth={1} vectorEffect="non-scaling-stroke"/>
    </g>
  </svg>;
}
