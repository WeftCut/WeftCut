import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { staticPosition } from '../../shared/position';
import { runPositionConversion, type ConversionResponse } from './runPositionConversion';

class TestWorker {
    static instances: TestWorker[] = [];
    onmessage: ((event: { data: ConversionResponse }) => void) | null = null;
    onerror: ((event: { message: string; preventDefault: () => void }) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    postMessage = vi.fn();
    terminate = vi.fn();
    constructor() { TestWorker.instances.push(this); }
}
const source = staticPosition(10, 20);
const options = { fpsNum: 30, fpsDen: 1, startFrame: 0, endFrame: 60, tolerancePx: 1, everyFrames: 1 };
beforeEach(() => { TestWorker.instances = []; vi.stubGlobal('Worker', TestWorker); });
afterEach(() => vi.unstubAllGlobals());

it('passes inputs to the worker, returns its result and releases it', async () => {
    const controller = new AbortController();
    const promise = runPositionConversion(source, options, controller.signal);
    const worker = TestWorker.instances[0]!;
    expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({ position: source, options });
    const result = { position: source, sampleCount: 2, nodeCount: 0, maxErrorPx: 0, checkCount: 241, withinTolerance: true, limit: null };
    worker.onmessage!({ data: { ok: true, result } });
    expect(await promise).toBe(result);
    controller.abort();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.onmessage).toBeNull();
});

it('cancels running work and removes its handlers', async () => {
    const controller = new AbortController();
    const promise = runPositionConversion(source, options, controller.signal);
    const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    const worker = TestWorker.instances[0]!;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
});

it('does not spawn work for an already cancelled request', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(runPositionConversion(source, options, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(TestWorker.instances).toHaveLength(0);
});

it('preserves typed conversion errors across the worker boundary', async () => {
    const promise = runPositionConversion(source, options, new AbortController().signal);
    const rejected = expect(promise).rejects.toMatchObject({ code: 'jump_error' });
    TestWorker.instances[0]!.onmessage!({ data: { ok: false, code: 'jump_error', message: 'jump_error' } });
    await rejected;
    expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledTimes(1);
});

it('reports worker load failures and releases the worker', async () => {
    const promise = runPositionConversion(source, options, new AbortController().signal);
    const rejected = expect(promise).rejects.toThrow('Worker load failed');
    TestWorker.instances[0]!.onerror!({ message: 'Worker load failed', preventDefault: vi.fn() });
    await rejected;
    expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledTimes(1);
});
