// Planning is deliberately independent of history, free-memory samples and
// playback observations. The executor consumes this frozen plan as written.
import { createHash } from 'node:crypto';
import { PERFORMANCE_DEFAULTS } from '../../src/shared/performance-settings.ts';

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createCalibrationPlan({ fixtureSet, fixtures, tracks, windowS, warmupS, quietS, seek, motif }) {
  const names = ['h264-1080', 'h264-2160', 'hevc-1080', 'hevc-2160'];
  if (!['short', 'full'].includes(fixtureSet)) throw new Error('Unknown fixture set');
  if (!fixtures?.length || new Set(fixtures).size !== fixtures.length || fixtures.some(name => !names.includes(name))) {
    throw new Error('Fixtures must be non-empty, supported and unique');
  }
  if (!tracks?.length || tracks.some((n, i) => !Number.isInteger(n) || n < 1 || n > 8 || (i > 0 && n <= tracks[i - 1]))) {
    throw new Error('Tracks must be ascending integers from 1 to 8');
  }
  for (const [name, value, min, max] of [['windowS', windowS, 1, 20], ['warmupS', warmupS, 0, 10], ['quietS', quietS, 0, 120]]) {
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  }
  if (typeof seek !== 'boolean' || typeof motif !== 'boolean') throw new Error('Seek and motif must be booleans');
  const startUs = 2_000_000;
  if (2 + warmupS + windowS + 2 > (fixtureSet === 'short' ? 20 : 60)) throw new Error('Window exceeds fixture duration');
  const scenario = (fixture, mixed) => {
    const name = mixed ? `${fixture}+motif` : fixture;
    const loads = mixed ? [1, 1] : [...tracks, tracks.at(-1)];
    return {
      name, fixture, mixed,
      windows: loads.map((n, i) => ({
        cell: `${name}/${n}路/${i === loads.length - 1 ? '复测' : '首次'}`,
        tracks: n, repeat: i === loads.length - 1, startUs, warmupS, windowS,
      })),
      seekTargetsUs: seek && !mixed ? [10_000_000, 10_500_000, fixtureSet === 'short' ? 16_000_000 : 24_000_000, 1_000_000] : [],
    };
  };
  const body = {
    version: 1,
    fixtureSet,
    selection: 'fixed-before-run',
    useHistory: false,
    adaptToMeasurements: false,
    quietS,
    initialSettings: {
      decode_engine: 'ffmpeg', playback_resolution: 'full', preview_effects_enabled: true,
      performance: {
        ...PERFORMANCE_DEFAULTS,
        preview_gpu_sessions: Math.max(...tracks),
        preview_gpu_pixel_area: Math.max(...tracks) * 3840 * 2160,
      },
    },
    environment: { profile: 'fresh-per-scenario', project: 'fresh-per-scenario', preferProxies: false },
    failurePolicy: 'keep-performance-failures; abort-broken-scenario-with-reason; never-replace-windows',
    scenarios: [...fixtures.map(name => scenario(name, false)), ...(motif ? [scenario('h264-1080', true)] : [])],
  };
  return freeze({ id: createHash('sha256').update(JSON.stringify(body)).digest('hex'), ...body });
}

/** Preserve pending/not-run rows so an incomplete run cannot look like a shorter plan. */
export function executionOf(plan, report) {
  return plan.scenarios.flatMap(s => [
    ...s.windows.map(w => ({ scenario: s.name, kind: 'playback', cell: w.cell, tracks: w.tracks, windowS: w.windowS,
      status: report.samples.some(sample => sample.cell === w.cell) ? 'recorded' : report.finishedAt ? 'not-run' : 'pending',
      reason: report.errors.filter(error => !error.cell || error.cell === s.name).map(error => error.error).join('; ') || (report.finishedAt ? 'Run ended before this item was recorded' : ''),
    })),
    ...s.seekTargetsUs.map(targetUs => ({ scenario: s.name, kind: 'seek', targetUs,
      status: report.seeks.some(result => result.cell === s.name && result.targetUs === targetUs) ? 'recorded' : report.finishedAt ? 'not-run' : 'pending',
      reason: report.errors.filter(error => !error.cell || error.cell === s.name).map(error => error.error).join('; ') || (report.finishedAt ? 'Run ended before this item was recorded' : ''),
    })),
  ]).map(item => ({ ...item, reason: item.status === 'recorded' ? null : item.reason }));
}
