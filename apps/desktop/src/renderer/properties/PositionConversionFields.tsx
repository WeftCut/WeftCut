import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { PositionAnimation } from '../../shared/position';
import { PositionConversionError, type ConversionOptions } from '../render/positionConversion';
import { useOpenComposition } from '../state/projectStore';
import { usePathEditingStore } from '../state/pathEditingStore';
import { usePositionConversion } from './usePositionConversion';
import { Field } from './Field';

export type ConversionKind = 'to_path' | 'to_xy';

/** Automatic, transient preview. Only Apply writes the measured result. */
export function PositionConversionFields({ kind, position, layerId, durationUs, busy, onApply, onClose }: {
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
    const fpsNum = comp?.fps_num ?? 0, fpsDen = comp?.fps_den ?? 0;
    const lastFrame = fpsNum > 0 && fpsDen > 0 ? Math.round(durationUs * fpsNum / (1e6 * fpsDen)) : 0;
    // Preserve empty/partial text while typing; it must not become a valid zero.
    const [draft, setDraft] = useState({ start: '0', end: String(lastFrame), tolerance: '1', interval: '1' });
    const [applyError, setApplyError] = useState('');
    const [applying, setApplying] = useState(false);
    const applyingRef = useRef(false);
    const locked = busy || applying;
    const parsed = useMemo((): { options: ConversionOptions | null; error: string | null } => {
        if (!fpsNum || !fpsDen) return { options: null, error: 'conversion_unavailable' };
        const number = (value: string) => value.trim() === '' ? NaN : Number(value);
        const startFrame = number(draft.start), endFrame = number(draft.end);
        const tolerancePx = number(draft.tolerance), everyFrames = number(draft.interval);
        if (![startFrame, endFrame].every(n => Number.isSafeInteger(n) && n >= 0)
            || endFrame <= startFrame || endFrame > lastFrame)
            return { options: null, error: 'range_error' };
        if (endFrame - startFrame > 16384) return { options: null, error: 'conversion_range_error' };
        if (!Number.isFinite(tolerancePx) || tolerancePx < 0.05 || !Number.isInteger(everyFrames) || everyFrames < 1)
            return { options: null, error: 'conversion_options_error' };
        return { options: { fpsNum, fpsDen, startFrame, endFrame, tolerancePx, everyFrames }, error: null };
    }, [draft, fpsNum, fpsDen, lastFrame]);
    const state = usePositionConversion(position, layerId, parsed.options);
    const result = !parsed.error && state.status === 'ready' ? state.result : null;
    const error = parsed.error ? t(`motion_path.${parsed.error}`)
        : state.status === 'error' ? (state.error instanceof PositionConversionError
            ? t(`motion_path.${state.error.code}`) : t('motion_path.conversion_failed')) : '';
    const calculating = !parsed.error && state.status === 'calculating';
    const apply = async () => {
        if (locked || applyingRef.current || !result?.withinTolerance) return;
        applyingRef.current = true;
        setApplying(true);
        setApplyError('');
        try {
            if (await onApply(result.position)) {
                // A successful conversion ends editing the old geometry. Cancel
                // restores it instead; keep another layer's new selection intact.
                const edit = usePathEditingStore.getState();
                if (edit.layerId === layerId) edit.setLayer(null);
                onClose();
            } else setApplyError(t('motion_path.conversion_apply_failed'));
        } catch {
            setApplyError(t('motion_path.conversion_apply_failed'));
        } finally {
            applyingRef.current = false;
            setApplying(false);
        }
    };
    const field = (key: keyof typeof draft, label: string, min: number, step = 1) => <Field label={label}>
        <input className="app-input app-number-input" type="number" min={min} step={step} value={draft[key]} disabled={locked}
            onChange={e => { setApplyError(''); setDraft({ ...draft, [key]: e.target.value }); }}/>
    </Field>;
    return <div data-testid="position-conversion" className="prop-well">
        <div className="prop-well-head">
            <span className="prop-well-title">{t(kind === 'to_path' ? 'motion_path.to_path' : 'motion_path.to_xy')}</span>
        </div>
        {field('start', t('motion_path.start_frame'), 0)}
        {field('end', t('motion_path.end_frame'), 1)}
        {field('tolerance', t('motion_path.tolerance'), 0.05, 0.05)}
        {kind === 'to_xy' && field('interval', t('motion_path.every_frames'), 1)}
        <p className="prop-hint">{t('motion_path.conversion_range_note')}</p>
        <div role="status" aria-live="polite" className="prop-hint">
            {locked ? t('motion_path.conversion_applying') : calculating ? t('motion_path.conversion_calculating')
                : result ? t(result.withinTolerance ? 'motion_path.conversion_ready' : 'motion_path.conversion_limited') : null}
        </div>
        {result && <p data-testid="conversion-error" className="prop-hint">{t('motion_path.error', { error: result.maxErrorPx.toFixed(3), count: result.checkCount })} · {result.sampleCount} {t('motion_path.samples_used')}{result.nodeCount > 0 ? ` · ${t('motion_path.nodes_used', { count: result.nodeCount })}` : ''}</p>}
        {result && !result.withinTolerance && <p role="alert" className="prop-hint text-destructive">{t(`motion_path.${result.limit ?? 'conversion_tolerance_error'}`)}</p>}
        {(error || applyError) && <p role="alert" className="prop-hint text-destructive">{error || applyError}</p>}
        <details className="prop-hint">
            <summary>{t('motion_path.conversion_details')}</summary>
            <p>{t('motion_path.conversion_note')}</p>
        </details>
        <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="default" disabled={locked || !result?.withinTolerance} onClick={() => void apply()}>{t('motion_path.apply')}</Button>
            <Button size="sm" variant="ghost" disabled={locked} onClick={onClose}>{t('motion_path.cancel')}</Button>
        </div>
    </div>;
}
