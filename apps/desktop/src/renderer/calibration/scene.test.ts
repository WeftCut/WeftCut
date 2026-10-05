import { describe, expect, it } from 'vitest';
import { calibrationScene } from './scene';

describe('memory-only calibration scene', () => {
  it('places eight independent, visible 60fps clips using only the reference source', () => {
    const scene = calibrationScene({ path: 'reference.mp4', width: 3840, height: 2160,
      fps: 60, durationUs: 20_000_000, bytes: 1000, sha256: 'test' }, 8);
    const comp = scene.compositions[scene.root_id]!;
    expect(comp.fps_num / comp.fps_den).toBe(60);
    const layers = comp.tracks.flatMap(t => t.layers);
    expect(new Set(layers.map(l => l.id)).size).toBe(8);
    expect(scene.media).toHaveLength(1);
    for (const layer of layers) {
      expect(layer.enabled).toBe(true);
      expect(layer.params.kind).toBe('VideoClip');
      if (layer.params.kind !== 'VideoClip') throw new Error('Unexpected layer');
      expect(layer.params.opacity).toEqual({ mode: 'Static', value: 1 });
      expect(layer.params.scale_x).toEqual({ mode: 'Static', value: .25 });
      expect(layer.effects).toEqual([]);
    }
    expect(() => calibrationScene(scene.media[0] as never, 9)).toThrow('Invalid calibration count');
  });
});
