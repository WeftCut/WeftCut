import type { PositionAnimation } from '../../shared/position';
import { PositionConversionError, type ConversionOptions, type PositionConversion } from './positionConversion';

export interface ConversionRequest { position: PositionAnimation; options: ConversionOptions }
export type ConversionResponse =
    | { ok: true; result: PositionConversion }
    | { ok: false; code: PositionConversionError['code'] | null; message: string };

/** Keep fitting off the UI thread. Every exit releases its worker and listener. */
export function runPositionConversion(
    position: PositionAnimation,
    options: ConversionOptions,
    signal: AbortSignal,
): Promise<PositionConversion> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) { reject(new DOMException('Conversion cancelled', 'AbortError')); return; }
        const worker = new Worker(new URL('./positionConversion.worker.ts', import.meta.url), { type: 'module' });
        const dispose = () => {
            signal.removeEventListener('abort', abort);
            worker.onmessage = null;
            worker.onerror = null;
            worker.onmessageerror = null;
            worker.terminate();
        };
        const fail = (error: unknown) => { dispose(); reject(error); };
        const abort = () => fail(new DOMException('Conversion cancelled', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
        worker.onmessage = ({ data }: MessageEvent<ConversionResponse>) => {
            dispose();
            if (data.ok) resolve(data.result);
            else reject(data.code ? new PositionConversionError(data.code) : new Error(data.message));
        };
        worker.onerror = event => { event.preventDefault(); fail(new Error(event.message)); };
        worker.onmessageerror = () => fail(new Error('Could not read the conversion result.'));
        try { worker.postMessage({ position, options } satisfies ConversionRequest); }
        catch (error) { fail(error); }
    });
}
