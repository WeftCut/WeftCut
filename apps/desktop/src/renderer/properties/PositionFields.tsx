import { useTranslation } from 'react-i18next';
import { useEffect, useMemo, useState } from 'react';
import { CirclePlus, Eye, Plus, Spline, Trash2 } from 'lucide-react';
import { setPosition, type LayerSummary } from '../ipc';
import { PATH_PROGRESS, X, Y } from '../keyframe/descriptors';
import { InspectorAnimField } from './InspectorAnimField';
import { InspectorRow } from './InspectorRow';
import { PropSegmented } from './PropSegmented';
import { usePathEditingStore } from '../state/pathEditingStore';
import { IN_IDENTITY, OUT_IDENTITY, HOLD_EXTRAPOLATION } from '../../shared/keyframe';
import { type PathPosition, type PathNode, type PositionAnimation } from '../../shared/position';
import { evaluatePosition } from '../render/position';
import { PositionConversionFields, type ConversionKind } from './PositionConversionFields';
import { Button } from '@/components/ui/button';
import { insertPathNode, setPathNodeMode } from '../../shared/pathGeometry';

/// ADR 0060's node budget. The add/insert actions stop at it rather than
/// letting the actor refuse a gesture the panel offered.
const MAX_NODES = 128;

/// One node action. An icon with its name on `aria-label` + `title`: four
/// word-labelled buttons in a row read as four equal-weight decisions, and the
/// row's one decision is Edit / Done.
function NodeAction({ label, disabled, onClick, children }: {
    label: string;
    disabled: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return <Button size="icon-xs" variant="ghost" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
    {children}
  </Button>;
}

/// Position: the XY ⇄ Path mode choice, the values of whichever mode is
/// active, and — in Path mode — the path's own node controls.
///
/// The mode switcher is the ONLY entry to changing representation, and it
/// branches on what the data allows: static X/Y become a two-point path
/// immediately (one undo), keyframed X/Y have to be fitted, and leaving Path
/// always bakes. So no control is ever silently unavailable while a second one
/// elsewhere is the real route.
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
    const [conversion, setConversion] = useState<ConversionKind | null>(null);
    // Memoised on `layer.params` so identity tracks the stored params rather
    // than the render: the reset below keys on it, and a fresh object every
    // render would close the conversion the user is filling in.
    const position = useMemo<PositionAnimation | null>(
        () => ('x' in layer.params
            ? layer.params.position ?? { mode: 'XY' as const, x: layer.params.x, y: layer.params.y }
            : null),
        [layer.params],
    );
    // A selection change, an edit elsewhere or an undo invalidates an open
    // conversion: it was fitted against geometry that no longer exists.
    useEffect(() => { setConversion(null); }, [layer.id, position]);
    if (!position)
        return null;
    const path = position.mode === 'Path' ? position : null;
    const editing = edit.layerId === layer.id;
    const nodes = path?.path.nodes ?? [];
    const selected = path ? nodes.findIndex(n => n.id === edit.nodeId) : -1;
    // A span action needs a node with something after it.
    const inSpan = selected >= 0 && selected < nodes.length - 1;
    const change = async (next: PositionAnimation, geometryOnly = false) => {
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
    /// The instant XY → Path: a two-point line through where the layer already
    /// is, with progress running end to end over the layer's own duration.
    const create = async () => {
        const p = evaluatePosition(position, tInLayerUs);
        const nodes: PathNode[] = [0, 1].map(i => ({ tangentMode: 'Corner' as const, id: crypto.randomUUID(), point: { x: p.x + i * 200, y: p.y }, inHandle: { x: 0, y: 0 }, outHandle: { x: 0, y: 0 }, segment: 'Line' }));
        const duration = layer.t_end_us - layer.t_start_us;
        const next: PathPosition = { mode: 'Path', path: { nodes }, progress: { mode: 'Keyframed', extrapolate: HOLD_EXTRAPOLATION, value: [0, 1].map(value => ({ id: crypto.randomUUID(), t_us: value * duration, value, in: { ...IN_IDENTITY, mode: 'Free' }, out: { ...OUT_IDENTITY, mode: 'Free' }, continuity: 'Broken', segment: { kind: 'Linear' } })) } };
        if (await change(next))
            edit.setLayer(layer.id);
    };
    const chooseMode = (next: PositionAnimation['mode']) => {
        if (next === position.mode)
            return;
        // Static X/Y carry no timing to preserve, so a path can be built
        // outright; anything animated has to be fitted and measured first.
        if (next === 'Path' && position.mode === 'XY' && position.x.mode === 'Static' && position.y.mode === 'Static')
            void create();
        else
            setConversion(next === 'Path' ? 'to_path' : 'to_xy');
    };
    const updateNodes = (nodes: PathNode[]) => path && void change({ ...path, path: { nodes } }, true);
    const toggleCurve = () => {
        if (!path || !inSpan)
            return;
        const cubic = path.path.nodes[selected]!.segment === 'Line';
        updateNodes(path.path.nodes.map((n, i) => i === selected ? { ...n, tangentMode: 'Corner', segment: cubic ? 'Cubic' : 'Line', outHandle: cubic ? { x: 60, y: -60 } : n.outHandle } : i === selected + 1 && cubic ? { ...n, inHandle: { x: -60, y: -60 } } : n));
    };
    const insert = async () => {
        if (!path || !inSpan) return;
        const id = crypto.randomUUID();
        if (await change({ ...path, path: insertPathNode(path.path, selected, 0.5, id) }, true)) edit.setNode(id);
    };
    const append = () => {
        const last = nodes.at(-1);
        if (!last) return;
        updateNodes([...nodes, { ...last, tangentMode: 'Corner', id: crypto.randomUUID(), point: { x: last.point.x + 100, y: last.point.y }, inHandle: { x: 0, y: 0 }, outHandle: { x: 0, y: 0 }, segment: 'Line' }]);
    };
    return <div data-testid="position-fields">
    <InspectorRow label={t('property_panel.position')} reserveStopwatch>
      <PropSegmented
        label={t('property_panel.position')}
        value={position.mode}
        options={[{ value: 'XY' as const, label: t('motion_path.mode_xy') }, { value: 'Path' as const, label: t('motion_path.mode_path') }]}
        onSelect={chooseMode}/>
      {/* XY mode draws no trajectory unless asked (`MotionPathOverlay` returns
          null for an unedited XY position), so this is the only way to see the
          motion on canvas. Path mode always draws it, so the toggle there
          would be a no-op — the well's Edit/Done owns that flag instead. */}
      {!path && <Button size="icon-xs" variant={editing ? 'secondary' : 'ghost'} aria-pressed={editing} aria-label={t('motion_path.show')} title={t('motion_path.show')} onClick={() => edit.setLayer(editing ? null : layer.id)}>
        <Eye size={13} aria-hidden/>
      </Button>}
    </InspectorRow>
    {path
      ? <InspectorAnimField {...props} desc={PATH_PROGRESS}/>
      : <InspectorRow label={t('motion_path.mode_xy')}>
          <InspectorAnimField {...props} desc={X} layout="cell"/>
          <InspectorAnimField {...props} desc={Y} layout="cell"/>
        </InspectorRow>}
    {conversion
      ? <PositionConversionFields kind={conversion} position={position} layerId={layer.id} durationUs={layer.t_end_us - layer.t_start_us} busy={busy} onApply={change} onClose={() => setConversion(null)}/>
      : path && <div className="prop-well">
        <div className="prop-well-head">
          <span className="prop-well-title">{t('motion_path.path')} <em>· {t('motion_path.nodes', { count: nodes.length })}</em></span>
          <Button size="xs" variant={editing ? 'default' : 'secondary'} disabled={busy} onClick={() => edit.setLayer(editing ? null : layer.id)}>
            {editing ? t('motion_path.done') : t('motion_path.edit')}
          </Button>
        </div>
        {editing && (selected >= 0
          ? <InspectorRow label={t('motion_path.node_of', { index: selected + 1, count: nodes.length })} reserveStopwatch>
              <PropSegmented
                label={t('motion_path.node_mode')}
                value={nodes[selected]!.tangentMode}
                options={[{ value: 'Corner' as const, label: t('motion_path.mode_corner') }, { value: 'Smooth' as const, label: t('motion_path.mode_smooth') }, { value: 'Auto' as const, label: t('motion_path.mode_auto') }]}
                onSelect={mode => void change({ ...path, path: setPathNodeMode(path.path, selected, mode) }, true)}/>
            </InspectorRow>
          : <p className="prop-hint">{t('motion_path.select_node')}</p>)}
        {editing && <>
          {/* Appending needs no selection, so it is always here. The per-node
              actions appear WITH the selection they act on: shown greyed with
              nothing selected, they read as four dead controls rather than as
              "pick a point first", which the line above already says. */}
          <div className="prop-well-toolbar">
            <NodeAction label={t('motion_path.add')} disabled={busy || nodes.length >= MAX_NODES} onClick={append}><Plus size={13} aria-hidden/></NodeAction>
            {selected >= 0 && <>
              <NodeAction label={t('motion_path.insert')} disabled={busy || !inSpan || nodes.length >= MAX_NODES} onClick={() => void insert()}><CirclePlus size={13} aria-hidden/></NodeAction>
              <NodeAction label={t('motion_path.curve')} disabled={busy || !inSpan} onClick={toggleCurve}><Spline size={13} aria-hidden/></NodeAction>
              <NodeAction label={t('motion_path.remove')} disabled={busy || nodes.length < 2} onClick={() => updateNodes(nodes.filter((_, i) => i !== selected))}><Trash2 size={13} aria-hidden/></NodeAction>
            </>}
          </div>
          <p className="prop-hint">{t('motion_path.insert_hint')}</p>
        </>}
      </div>}
    {path && <p className="prop-hint">{t(layer.kind === 'Text' ? 'motion_path.anchor' : 'motion_path.corner')}</p>}
    {error && <p role="alert" className="prop-hint text-destructive">{error}</p>}
  </div>;
}
