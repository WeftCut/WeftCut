import { useEffect, useMemo, useState } from 'react';
import type { PositionAnimation } from '../../shared/position';
import type { ConversionOptions, PositionConversion } from '../render/positionConversion';
import { runPositionConversion } from '../render/runPositionConversion';
import { setPositionPreview } from '../render/position';
import { usePathEditingStore } from '../state/pathEditingStore';

type State = { status: 'calculating' }
    | { status: 'ready'; result: PositionConversion }
    | { status: 'error'; error: unknown };

/** Own one preview session: debounce inputs, cancel superseded work, and never
 * expose a result for different inputs, even before effect cleanup has run. */
export function usePositionConversion(position: PositionAnimation, layerId: string, options: ConversionOptions | null): State {
    const request = useMemo(() => ({ position, layerId, options }), [position, layerId, options]);
    const [settled, setSettled] = useState<{ request: typeof request; state: State } | null>(null);

    useEffect(() => {
        const previous = usePathEditingStore.getState();
        return () => {
            const current = usePathEditingStore.getState();
            // Do not overwrite a selection made elsewhere while we were open.
            if (current.layerId === layerId) {
                current.setLayer(previous.layerId);
                current.setNode(previous.nodeId);
            }
        };
    }, [layerId]);

    useEffect(() => {
        if (!options) return;
        const controller = new AbortController();
        const timer = setTimeout(() => {
            void runPositionConversion(position, options, controller.signal).then(result => {
                if (controller.signal.aborted) return;
                setPositionPreview(position, result.position);
                const edit = usePathEditingStore.getState();
                if (edit.layerId !== layerId) edit.setLayer(layerId);
                setSettled({ request, state: { status: 'ready', result } });
            }, error => {
                if (!controller.signal.aborted) setSettled({ request, state: { status: 'error', error } });
            });
        }, 250);
        return () => {
            clearTimeout(timer);
            controller.abort();
            setPositionPreview(position, null);
        };
    }, [request, position, layerId, options]);

    return settled?.request === request ? settled.state : { status: 'calculating' };
}
