import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { PositionAnimation } from '../../shared/position';
import { convertPosition, PositionConversionError, type PositionConversion } from '../render/positionConversion';
import { setPositionPreview } from '../render/position';
import { usePathEditingStore } from '../state/pathEditingStore';
import { useOpenComposition } from '../state/projectStore';
import { Field } from './Field';

/// Which representation the conversion is heading for. The mode switcher picks
/// it; this component never decides.
export type ConversionKind = 'to_path' | 'to_xy';

/// A conversion in flight: the range and quality targets, a measured result,
/// and the three ways out.
///
/// Inline in the panel rather than a dialog: the point of Preview is to judge
/// the fitted curve ON THE CANVAS, and a centred modal covers it. `Preview`
/// writes a preview position and turns the overlay on; nothing reaches the
/// project until `Apply`, which stays disabled while the measured error misses
/// the target (ADR 0060 permits previewing a missed target, never applying it).
export function PositionConversionFields({
    kind,
    position,
    layerId,
    durationUs,
    busy,
    onApply,
    onClose,
}: {
    kind: ConversionKind;
    position: PositionAnimation;
    layerId: string;
    durationUs: number;
    busy: boolean;
    onApply: (next: PositionAnimation) => Promise<boolean>;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const comp = useOpenComposition();
    const lastFrame = comp ? Math.round(durationUs * comp.fps_num / (1e6 * comp.fps_den)) : 1;
    const [startFrame, setStart] = useState(0);
    const [endFrame, setEnd] = useState(lastFrame);
    const [tolerancePx, setTolerance] = useState(1);
    const [everyFrames, setEvery] = useState(1);
    const [result, setResult] = useState<PositionConversion | null>(null);
    const [error, setError] = useState('');
    // The preview is a renderer-side overlay on geometry this component does
    // not own: it has to be dropped when this unmounts, or it outlives the
    // conversion it was measuring.
    useEffect(() => () => setPositionPreview(position, null), [position]);
    const clear = () => { setPositionPreview(position, null); setResult(null); setError(''); };
    const close = () => { clear(); usePathEditingStore.getState().setLayer(null); onClose(); };
    const preview = () => {
        clear();
        if (!comp)
            return;
        try {
            if (endFrame > lastFrame)
                throw new Error(t('motion_path.range_error'));
            const next = convertPosition(position, { fpsNum: comp.fps_num, fpsDen: comp.fps_den, startFrame, endFrame, tolerancePx, everyFrames });
            setResult(next);
            setPositionPreview(position, next.position);
            usePathEditingStore.getState().setLayer(layerId);
        }
        catch (e) {
            setError(e instanceof PositionConversionError ? t(`motion_path.${e.code}`) : String(e));
        }
    };
    const field = (label: string, value: number, set: (n: number) => void, min: number, step = 1) => <Field label={label}>
    <input className="app-input app-number-input" type="number" min={min} step={step} value={value} disabled={busy} onChange={e => { clear(); set(Number(e.target.value)); }}/>
  </Field>;
    return <div data-testid="position-conversion" className="prop-well">
    <div className="prop-well-head">
      <span className="prop-well-title">{t(kind === 'to_path' ? 'motion_path.to_path' : 'motion_path.to_xy')}</span>
    </div>
    {field(t('motion_path.start_frame'), startFrame, setStart, 0)}
    {field(t('motion_path.end_frame'), endFrame, setEnd, 1)}
    {field(t('motion_path.tolerance'), tolerancePx, setTolerance, 0.05, 0.05)}
    {kind === 'to_xy' && field(t('motion_path.every_frames'), everyFrames, setEvery, 1)}
    {result && <p data-testid="conversion-error" className="prop-hint">{t('motion_path.error', { error: result.maxErrorPx.toFixed(3), count: result.checkCount })} · {result.sampleCount} {t('motion_path.samples_used')}{result.nodeCount > 0 ? ` · ${t('motion_path.nodes_used', { count: result.nodeCount })}` : ''}</p>}
    {result && !result.withinTolerance && <p role="alert" className="prop-hint text-destructive">{t(`motion_path.${result.limit}`)}</p>}
    {error && <p role="alert" className="prop-hint text-destructive">{error}</p>}
    <p className="prop-hint">{t('motion_path.conversion_note')}</p>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={preview}>{t('motion_path.preview')}</Button>
      <Button size="sm" variant="default" disabled={busy || !result?.withinTolerance} onClick={async () => { if (result?.withinTolerance && await onApply(result.position))
        close(); }}>{t('motion_path.apply')}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={close}>{t('motion_path.cancel')}</Button>
    </div>
  </div>;
}
