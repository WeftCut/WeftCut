import { initEval } from '../eval';
import { convertPosition, PositionConversionError } from './positionConversion';
import type { ConversionRequest, ConversionResponse } from './runPositionConversion';

// One request per worker. Termination cancels even a synchronous fitting loop.
self.onmessage = async ({ data }: MessageEvent<ConversionRequest>) => {
    let response: ConversionResponse;
    try {
        await initEval();
        response = { ok: true, result: convertPosition(data.position, data.options) };
    } catch (error) {
        response = {
            ok: false,
            code: error instanceof PositionConversionError ? error.code : null,
            message: error instanceof Error ? error.message : String(error),
        };
    }
    self.postMessage(response);
};
