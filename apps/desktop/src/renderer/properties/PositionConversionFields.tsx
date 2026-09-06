import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { PositionAnimation } from '../../shared/position';
import { convertPosition, type PositionConversion } from '../render/positionConversion';
import { setPositionPreview } from '../render/position';
import { usePathEditingStore } from '../state/pathEditingStore';
import { useOpenComposition } from '../state/projectStore';
export function PositionConversionFields({ position, layerId, durationUs, busy, onApply }: {
    position: PositionAnimation;
    layerId: string;
    durationUs: number;
    busy: boolean;
    onApply: (next: PositionAnimation) => Promise<boolean>;
}) {
    const { t } = useTranslation();
    const comp = useOpenComposition();
    const [open, setOpen] = useState(false);
    const [startFrame, setStart] = useState(0);
    const [endFrame, setEnd] = useState(1);
    const [pathSamples, setSamples] = useState(64);
    const [everyFrames, setEvery] = useState(1);
    const [result, setResult] = useState<PositionConversion | null>(null);
    const [error, setError] = useState('');
    // Selection changes, edits elsewhere and undo invalidate the entire preview.
    useEffect(() => {
        setOpen(false);
        setResult(null);
        setError('');
        return () => setPositionPreview(position, null);
    }, [position, layerId, durationUs]);
    const clear = () => { setPositionPreview(position, null); setResult(null); setError(''); };
    const close = () => { clear(); setOpen(false); usePathEditingStore.getState().setLayer(null); };
    const preview = () => {
        clear();
        if (!comp)
            return;
        try {
            const last = Math.round(durationUs * comp.fps_num / (1e6 * comp.fps_den));
            if (endFrame > last)
                throw new Error(t('motion_path.range_error'));
            const next = convertPosition(position, { fpsNum: comp.fps_num, fpsDen: comp.fps_den, startFrame, endFrame, pathSamples, everyFrames });
            setResult(next);
            setPositionPreview(position, next.position);
            usePathEditingStore.getState().setLayer(layerId);
        }
        catch (e) {
            setError(String(e));
        }
    };
    if (!open)
        return <Button size="sm" variant="outline" disabled={busy || !comp} onClick={() => {
                setStart(0);
                setEnd(Math.round(durationUs * comp!.fps_num / (1e6 * comp!.fps_den)));
                setOpen(true);
            }}>{t(position.mode === 'XY' ? 'motion_path.to_path' : 'motion_path.to_xy')}</Button>;
    const field = (label: string, value: number, set: (n: number) => void, min: number, max?: number) => <label className="flex items-center justify-between gap-2 text-xs">
    {label}<input className="w-20 rounded border bg-transparent px-2 py-1" type="number" min={min} max={max} step={1} value={value} disabled={busy} onChange={e => { clear(); set(Number(e.target.value)); }}/>
  </label>;
    return <div data-testid="position-conversion" className="mt-2 space-y-2 rounded border p-2">
    <p className="text-xs text-muted-foreground">{t('motion_path.conversion_note')}</p>
    {field(t('motion_path.start_frame'), startFrame, setStart, 0)}
    {field(t('motion_path.end_frame'), endFrame, setEnd, 1)}
    {position.mode === 'XY' ? field(t('motion_path.samples'), pathSamples, setSamples, 2, 128) : field(t('motion_path.every_frames'), everyFrames, setEvery, 1)}
    {result && <p data-testid="conversion-error" className="text-xs">{t('motion_path.error', { error: result.maxErrorPx.toFixed(3), count: result.checkCount })} · {result.sampleCount} {t('motion_path.samples_used')}</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={preview}>{t('motion_path.preview')}</Button>
      <Button size="sm" disabled={busy || !result} onClick={async () => { if (result && await onApply(result.position))
        close(); }}>{t('motion_path.apply')}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={close}>{t('motion_path.cancel')}</Button>
    </div>
  </div>;
}
