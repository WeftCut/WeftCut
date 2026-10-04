import { describe, expect, it } from 'vitest';
import type { MotionPath, PathNode } from '../../shared/position';
import { evaluateMotionPath } from '../eval';
import { progressAtParameter } from './pathProgress';

const node = (x: number, y = 0): PathNode => ({
    id: crypto.randomUUID(), point: { x, y }, tangent_mode: 'Corner',
    in_handle: { x: 0, y: 0 }, out_handle: { x: 0, y: 0 }, segment: 'Line',
});

describe('node progress on the playback path', () => {
    it('distinguishes coincident nodes on different parts of the route', () => {
        const path: MotionPath = { nodes: [node(0), node(100), node(0), node(200)] };
        expect(path.nodes.map((_, index) => progressAtParameter(path, index))).toEqual([0, 0.25, 0.5, 1]);
        for (let i = 0; i < path.nodes.length; i++) {
            expect(evaluateMotionPath(path, progressAtParameter(path, i))).toEqual(path.nodes[i]!.point);
        }
    });

    it('handles zero-length spans and stationary paths without NaN', () => {
        const path: MotionPath = { nodes: [node(0), node(0), node(100), node(100)] };
        expect(path.nodes.map((_, index) => progressAtParameter(path, index))).toEqual([0, 0, 1, 1]);
        for (const nodes of [[node(40)], [node(40), node(40), node(40)]]) {
            expect(nodes.map((_, index) => progressAtParameter({ nodes }, index))).toEqual(nodes.map(() => 0));
        }
    });
});
