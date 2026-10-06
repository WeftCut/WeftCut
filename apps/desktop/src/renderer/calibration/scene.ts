import type { AnimTrack, MediaSummary, ProjectSummary, TrackSummary } from '../ipc';
import { PLAYBACK_CALIBRATION as protocol } from '../../shared/playback-calibration';
import type { CalibrationFixture } from '../../shared/calibration-fixture';
export type { CalibrationFixture } from '../../shared/calibration-fixture';

const value = (n: number): AnimTrack<number> => ({ mode: 'Static', value: n });

/** Immutable input shape for the existing compositor; no project store or disk project. */
export function calibrationScene(fixture: CalibrationFixture, count: number): ProjectSummary {
  if (!protocol.counts.includes(count)) throw new Error('Invalid calibration count');
  const media: MediaSummary = { id: 'reference', label: 'H.264 4K60 reference', path: fixture.path,
    kind: 'Video', duration_us: fixture.durationUs, width: fixture.width, height: fixture.height,
    size_bytes: fixture.bytes, available: true, decode_route: { route: 'bypass' }, codec: 'h264', pix_fmt: 'yuv420p',
    color_matrix: 'bt709', color_range: 'tv', color_primaries: 'bt709', color_transfer: 'bt709' };
  // A fixed 4x2 grid keeps every decoder visible; no covered/offscreen layers.
  const tracks: TrackSummary[] = Array.from({ length: count }, (_, i) => ({
    id: `track-${i}`, kind: 'Video', label: `V${i + 1}`, enabled: true, locked: false,
    muted: false, solo: false, role: 'a-roll', transient: false,
    layers: [{ id: `video-${i}`, label: `Video ${i + 1}`, kind: 'VideoClip', color_hint: '#4488cc',
      enabled: true, locked: false, effects: [], t_start_us: 0, t_end_us: fixture.durationUs,
      params: { kind: 'VideoClip', media_id: media.id, media_label: media.label,
        src_in_us: 0, src_out_us: fixture.durationUs, x: value((i % 4) * 960), y: value(Math.floor(i / 4) * 1080),
        scale_x: value(.25), scale_y: value(.25), scale_linked: true, rotation_deg: value(0), opacity: value(1),
        anchor_x: value(.5), anchor_y: value(.5), speed: 1, flip_h: false, flip_v: false, fade_in_us: 0, fade_out_us: 0 } }],
  }));
  return { project_id: 'calibration-memory', name: 'Playback calibration', root_id: 'root',
    track_count: count, layer_count: count, history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    media: [media], audio_roles: [], compositions: { root: {
      id: 'root', label: null, ordinal: 0, width: protocol.width, height: protocol.height,
      fps_num: protocol.fps, fps_den: 1, duration_us: fixture.durationUs,
      duration_pinned: true, fps_locked: true, tracks, markers: [], transitions: [], links: [],
    } } };
}
