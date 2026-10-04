// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import type { PositionConversion } from '../render/positionConversion';
import { convertPosition, PositionConversionError } from '../render/positionConversion';
import { staticPosition } from '../../shared/position';
import { previewPosition } from '../render/position';
import { usePathEditingStore } from '../state/pathEditingStore';

const { run, composition } = vi.hoisted(() => ({
    run: vi.fn<typeof import('../render/runPositionConversion').runPositionConversion>(),
    composition: { current: { fps_num: 30, fps_den: 1 } as { fps_num: number; fps_den: number } | null },
}));
vi.mock('../render/runPositionConversion', () => ({ runPositionConversion: run }));
vi.mock('../state/projectStore', () => ({ useOpenComposition: () => composition.current }));
import { PositionConversionFields } from './PositionConversionFields';

const source = staticPosition(30, 50);
let pending: { resolve: (result: PositionConversion) => void; reject: (error: unknown) => void; signal: AbortSignal }[];
const onApply = vi.fn(async () => true);
const onClose = vi.fn();
const props = { kind: 'to_path' as const, position: source, layerId: 'L1', durationUs: 2_000_000, busy: false, onApply, onClose };
const apply = () => screen.getByRole('button', { name: 'Apply conversion' });
const change = (name: string, value: string) => fireEvent.change(screen.getByRole('spinbutton', { name }), { target: { value } });
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(250); });
const result = (error = 0): PositionConversion => ({
    ...convertPosition(source, { fpsNum: 30, fpsDen: 1, startFrame: 0, endFrame: 60, tolerancePx: 1, everyFrames: 1 }),
    maxErrorPx: error, withinTolerance: error <= 1, limit: error > 1 ? 'node_limit' : null,
});
const finish = async (index = 0, value = result()) => { await act(async () => { pending[index]!.resolve(value); }); return value; };

beforeEach(() => {
    vi.useFakeTimers();
    composition.current = { fps_num: 30, fps_den: 1 };
    pending = [];
    run.mockImplementation((_source, _options, signal) => new Promise((resolve, reject) => pending.push({ resolve, reject, signal })));
    onApply.mockResolvedValue(true);
    usePathEditingStore.getState().setLayer(null);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

describe('automatic conversion preview', () => {
    it('defaults to editable curves, exposes the interval only for baking, and cancels obsolete modes', async () => {
        render(<PositionConversionFields {...props} kind="to_xy" />);
        expect(screen.getByRole('button', { name: 'Editable curves' }).getAttribute('aria-pressed')).toBe('true');
        expect(screen.queryByRole('spinbutton', { name: 'Maximum frame interval' })).toBeNull();
        await tick();
        expect(run.mock.calls[0]![1].xyMode).toBe('editable');
        fireEvent.click(screen.getByRole('button', { name: 'Frame baking' }));
        expect(pending[0]!.signal.aborted).toBe(true);
        change('Maximum frame interval', '4');
        await tick();
        expect(run.mock.calls[1]![1]).toMatchObject({ xyMode: 'bake', everyFrames: 4 });
        change('Maximum frame interval', '');
        fireEvent.click(screen.getByRole('button', { name: 'Editable curves' }));
        await tick();
        expect(run.mock.calls[2]![1]).toMatchObject({ xyMode: 'editable', everyFrames: 1 });
        await finish(2, { ...result(), position: staticPosition(10, 20) });
        expect(screen.getByTestId('conversion-error').textContent).toContain('X: 0 keys · Y: 0 keys');
    });

    it('calculates on opening and applies the exact preview with no preview button', async () => {
        render(<PositionConversionFields {...props} />);
        expect(screen.queryByRole('button', { name: 'Preview conversion' })).toBeNull();
        expect(screen.getByRole('status').textContent).toContain('Calculating');
        expect(apply()).toHaveProperty('disabled', true);
        expect(onApply).not.toHaveBeenCalled();
        await tick();
        const next = await finish();
        expect(previewPosition(source)).toBe(next.position);
        expect(screen.getByRole('status').textContent).toContain('Preview updated');
        expect(apply()).toHaveProperty('disabled', false);
        await act(async () => { fireEvent.click(apply()); });
        expect(onApply).toHaveBeenCalledExactlyOnceWith(next.position);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(usePathEditingStore.getState().layerId).toBeNull();
    });

    it('debounces edits, immediately invalidates old results, and rejects late completions', async () => {
        render(<PositionConversionFields {...props} />);
        await tick();
        await finish();
        change('Target error (pixels)', '2');
        expect(apply()).toHaveProperty('disabled', true);
        expect(previewPosition(source)).toBe(source);
        change('Target error (pixels)', '3');
        await tick();
        expect(run).toHaveBeenCalledTimes(2);
        expect(run.mock.calls[1]![1].tolerancePx).toBe(3);
        change('Target error (pixels)', '4');
        expect(pending[1]!.signal.aborted).toBe(true);
        await tick();
        const latest = await finish(2);
        await finish(1, { ...result(), position: staticPosition(999, 999) });
        expect(previewPosition(source)).toBe(latest.position);
        await act(async () => { fireEvent.click(apply()); });
        expect(onApply).toHaveBeenCalledExactlyOnceWith(latest.position);
    });

    it.each([['Start frame (local)', ''], ['End frame (inclusive)', '61'], ['End frame (inclusive)', '0'], ['Target error (pixels)', '0.01']])(
        'does not calculate or apply invalid %s = %s', async (name, value) => {
            render(<PositionConversionFields {...props} />);
            await tick(); await finish();
            change(name, value);
            expect(previewPosition(source)).toBe(source);
            expect(apply()).toHaveProperty('disabled', true);
            expect(screen.getByRole('alert')).toBeTruthy();
            await tick();
            expect(run).toHaveBeenCalledTimes(1);
        },
    );

    it('keeps an out-of-tolerance preview visible and recovers automatically after an edit', async () => {
        render(<PositionConversionFields {...props} />);
        await tick(); const limited = await finish(0, result(5));
        expect(previewPosition(source)).toBe(limited.position);
        expect(apply()).toHaveProperty('disabled', true);
        expect(screen.getByRole('alert').textContent).toContain('128-node');
        change('Target error (pixels)', '6');
        await tick(); await finish(1);
        expect(screen.queryByRole('alert')).toBeNull();
        expect(apply()).toHaveProperty('disabled', false);
    });

    it('explains computation errors and recalculates when corrected', async () => {
        render(<PositionConversionFields {...props} />);
        await tick();
        await act(async () => { pending[0]!.reject(new PositionConversionError('jump_error')); });
        expect(screen.getByRole('alert').textContent).toContain('instantaneous position jump');
        expect(apply()).toHaveProperty('disabled', true);
        change('End frame (inclusive)', '30');
        await tick(); await finish(1);
        expect(apply()).toHaveProperty('disabled', false);
    });

    it('cancels before the debounce without starting a worker', async () => {
        const view = render(<PositionConversionFields {...props} />);
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        view.unmount(); await tick();
        expect(run).not.toHaveBeenCalled();
    });

    it('aborts on unmount, ignores its late result and restores the previous node selection', async () => {
        usePathEditingStore.getState().setLayer('L1');
        usePathEditingStore.getState().setNode('original');
        const view = render(<PositionConversionFields {...props} />);
        await tick(); await finish();
        change('Target error (pixels)', '2'); await tick();
        view.unmount();
        expect(pending[1]!.signal.aborted).toBe(true);
        await finish(1);
        expect(previewPosition(source)).toBe(source);
        expect(usePathEditingStore.getState()).toMatchObject({ layerId: 'L1', nodeId: 'original' });
    });

    it('invalidates the preview if the source or composition frame rate changes', async () => {
        const view = render(<PositionConversionFields {...props} />);
        await tick(); await finish();
        const nextSource = staticPosition(60, 80);
        composition.current = { fps_num: 24, fps_den: 1 };
        view.rerender(<PositionConversionFields {...props} position={nextSource} />);
        expect(previewPosition(source)).toBe(source);
        expect(apply()).toHaveProperty('disabled', true);
        // Old end frame 60 no longer lies inside this 48-frame clip.
        change('End frame (inclusive)', '48');
        await tick();
        expect(run.mock.calls[1]![0]).toBe(nextSource);
        expect(run.mock.calls[1]![1].fpsNum).toBe(24);
    });

    it('explains a missing composition instead of leaving a silently disabled Apply', () => {
        composition.current = null;
        render(<PositionConversionFields {...props} />);
        expect(screen.getByRole('alert').textContent).toContain('Open a composition');
        expect(apply()).toHaveProperty('disabled', true);
    });

    it('prevents duplicate writes, retains a failed preview and allows applying again', async () => {
        let finishApply!: (ok: boolean) => void;
        onApply.mockImplementationOnce(() => new Promise(resolve => { finishApply = resolve; }));
        render(<PositionConversionFields {...props} />);
        await tick(); const next = await finish();
        fireEvent.click(apply()); fireEvent.click(apply());
        expect(onApply).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true);
        await act(async () => { finishApply(false); });
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByRole('alert').textContent).toContain('try applying again');
        expect(previewPosition(source)).toBe(next.position);
        await act(async () => { fireEvent.click(apply()); });
        expect(onApply).toHaveBeenCalledTimes(2);
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
