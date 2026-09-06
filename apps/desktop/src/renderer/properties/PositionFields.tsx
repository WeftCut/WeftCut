import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { setPosition, type LayerSummary } from '../ipc';
import { PATH_PROGRESS, X, Y } from '../keyframe/descriptors';
import { InspectorAnimField } from './InspectorAnimField';
import { usePathEditingStore } from '../state/pathEditingStore';
import { IN_IDENTITY, OUT_IDENTITY, HOLD_EXTRAPOLATION } from '../../shared/keyframe';
import { type PathPosition, type PathNode } from '../../shared/position';
import { evaluatePosition } from '../render/position';
import { PositionConversionFields } from './PositionConversionFields';
import { Button } from '@/components/ui/button';
export function PositionFields(props: {
    layer: LayerSummary;
    tInLayerUs: number;
    playheadInSpan: boolean;
    onMutated: () => Promise<void>;
}) {
    const { layer, tInLayerUs } = props;
    const { t } = useTranslation();
    const edit = usePathEditingStore();
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    if (!('x' in layer.params))
        return null;
    const position = layer.params.position ?? { mode: 'XY' as const, x: layer.params.x, y: layer.params.y };
    const path = position.mode === 'Path' ? position : null;
    const change = async (next: typeof position, geometryOnly = false) => {
        setBusy(true);
        setError('');
        try {
            await setPosition(layer.id, next, geometryOnly);
            await props.onMutated();
            return true;
        }
        catch (e) {
            setError(String(e));
            return false;
        }
        finally {
            setBusy(false);
        }
    };
    const create = async () => {
        const p = evaluatePosition(position, tInLayerUs);
        const nodes: PathNode[] = [0, 1].map(i => ({ id: crypto.randomUUID(), point: { x: p.x + i * 200, y: p.y }, inHandle: { x: 0, y: 0 }, outHandle: { x: 0, y: 0 }, segment: 'Line' }));
        const duration = layer.t_end_us - layer.t_start_us;
        const next: PathPosition = { mode: 'Path', path: { nodes }, progress: { mode: 'Keyframed', extrapolate: HOLD_EXTRAPOLATION, value: [0, 1].map(value => ({ id: crypto.randomUUID(), t_us: value * duration, value, in: { ...IN_IDENTITY, mode: 'Free' }, out: { ...OUT_IDENTITY, mode: 'Free' }, continuity: 'Broken', segment: { kind: 'Linear' } })) } };
        if (await change(next))
            edit.setLayer(layer.id);
    };
    const selected = path?.path.nodes.findIndex(n => n.id === edit.nodeId) ?? -1;
    const updateNodes = (nodes: PathNode[]) => path && void change({ ...path, path: { nodes } }, true);
    const toggleCurve = () => {
        if (!path || selected < 0 || selected >= path.path.nodes.length - 1)
            return;
        const cubic = path.path.nodes[selected]!.segment === 'Line';
        updateNodes(path.path.nodes.map((n, i) => i === selected ? { ...n, segment: cubic ? 'Cubic' : 'Line', outHandle: cubic ? { x: 60, y: -60 } : n.outHandle } : i === selected + 1 && cubic ? { ...n, inHandle: { x: -60, y: -60 } } : n));
    };
    return <div data-testid="position-fields">
    {path ? <InspectorAnimField {...props} desc={PATH_PROGRESS}/> : <div className="prop-field-pair"><InspectorAnimField {...props} desc={X}/><InspectorAnimField {...props} desc={Y}/></div>}
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
      {!path && <Button size="sm" variant="outline" disabled={busy || position.mode !== 'XY' || position.x.mode !== 'Static' || position.y.mode !== 'Static'} onClick={() => void create()}>{t('motion_path.create')}</Button>}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => edit.setLayer(edit.layerId === layer.id ? null : layer.id)}>{edit.layerId === layer.id ? t('motion_path.done') : path ? t('motion_path.edit') : t('motion_path.show')}</Button>
      {path && edit.layerId === layer.id && <>
        <Button size="sm" variant="outline" disabled={busy || path.path.nodes.length >= 128} onClick={() => { const last = path.path.nodes.at(-1)!; updateNodes([...path.path.nodes, { ...last, id: crypto.randomUUID(), point: { x: last.point.x + 100, y: last.point.y }, inHandle: { x: 0, y: 0 }, outHandle: { x: 0, y: 0 }, segment: 'Line' }]); }}>{t('motion_path.add')}</Button>
        <Button size="sm" variant="outline" disabled={busy || selected < 0 || selected >= path.path.nodes.length - 1} onClick={toggleCurve}>{t('motion_path.curve')}</Button>
        <Button size="sm" variant="outline" disabled={busy || selected < 0 || path.path.nodes.length < 2} onClick={() => updateNodes(path.path.nodes.filter((_, i) => i !== selected))}>{t('motion_path.remove')}</Button>
      </>}
    </div>
    {path && <p style={{ fontSize: 11, opacity: 0.7 }}>{t(layer.kind === 'Text' ? 'motion_path.anchor' : 'motion_path.corner')}</p>}
    <PositionConversionFields position={position} layerId={layer.id} durationUs={layer.t_end_us - layer.t_start_us} busy={busy} onApply={change}/>
    {error && <p role="alert">{error}</p>}
  </div>;
}
