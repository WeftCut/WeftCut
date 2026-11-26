import { describe, expect, it } from "vitest";

import {
  judgeFrameSelection,
  lateFrameThresholdMs,
  UnderrunTracker,
  type UnderrunSnapshot,
} from "./underrunTracker";

const FRAME_US = 33_333; // 30 fps comp grid used throughout

describe("judgeFrameSelection", () => {
  it("flags a starved painter (no paintable frame) as late", () => {
    expect(
      judgeFrameSelection({
        selectedPtsUs: null,
        selectedDurationUs: 0,
        srcTUs: 1_000_000,
        mediaDurationUs: null,
      }),
    ).toBe("late");
  });

  it("is fresh while srcTUs sits inside the bound frame's window", () => {
    expect(
      judgeFrameSelection({
        selectedPtsUs: 1_000_000,
        selectedDurationUs: FRAME_US,
        srcTUs: 1_000_000 + FRAME_US - 1,
        mediaDurationUs: null,
      }),
    ).toBe("fresh");
  });

  it("flags a frame whose presentation window has passed", () => {
    expect(
      judgeFrameSelection({
        selectedPtsUs: 1_000_000,
        selectedDurationUs: FRAME_US,
        srcTUs: 1_000_000 + 3 * FRAME_US,
        mediaDurationUs: null,
      }),
    ).toBe("late");
  });

  it("tolerates rational-rounding jitter past the window edge", () => {
    // 1 µs past pts+duration is grid jitter, not decoder lag.
    expect(
      judgeFrameSelection({
        selectedPtsUs: 1_000_000,
        selectedDurationUs: FRAME_US,
        srcTUs: 1_000_000 + FRAME_US + 1,
        mediaDurationUs: null,
      }),
    ).toBe("fresh");
  });

  it("treats a forward-clamped (CTS offset) selection as fresh", () => {
    expect(
      judgeFrameSelection({
        selectedPtsUs: 40_000,
        selectedDurationUs: FRAME_US,
        srcTUs: 10_000,
        mediaDurationUs: null,
      }),
    ).toBe("fresh");
  });

  it("falls back to the 100 ms gap when duration is unreported", () => {
    expect(
      judgeFrameSelection({
        selectedPtsUs: 1_000_000,
        selectedDurationUs: 0,
        srcTUs: 1_090_000,
        mediaDurationUs: null,
      }),
    ).toBe("fresh");
    expect(
      judgeFrameSelection({
        selectedPtsUs: 1_000_000,
        selectedDurationUs: 0,
        srcTUs: 1_150_000,
        mediaDurationUs: null,
      }),
    ).toBe("late");
  });

  it("exempts source times at/past media EOS — a held tail frame is not a drop", () => {
    expect(
      judgeFrameSelection({
        selectedPtsUs: 9_966_667,
        selectedDurationUs: FRAME_US,
        srcTUs: 10_500_000, // clip trimmed past a 10 s media
        mediaDurationUs: 10_000_000,
      }),
    ).toBe("fresh");
    // Even a starved ring is exempt past EOS.
    expect(
      judgeFrameSelection({
        selectedPtsUs: null,
        selectedDurationUs: 0,
        srcTUs: 10_500_000,
        mediaDurationUs: 10_000_000,
      }),
    ).toBe("fresh");
  });
});

/// Tracker with a hand-cranked clock. Hold decay, grace deadline and emit
/// throttle run on this fake now(); `frame` is one display frame of the
/// composite loop, advancing the clock by the same interval it reports.
function makeTracker(opts: { holdMs?: number; graceMaxMs?: number; minEmitIntervalMs?: number } = {}) {
  let nowMs = 0;
  const emissions: UnderrunSnapshot[] = [];
  const tracker = new UnderrunTracker({
    onChange: (s) => emissions.push(s),
    holdMs: opts.holdMs ?? 1_500,
    graceMaxMs: opts.graceMaxMs ?? 1_000,
    minEmitIntervalMs: opts.minEmitIntervalMs ?? 250,
    now: () => nowMs,
  });
  return {
    tracker,
    emissions,
    advance: (ms: number) => {
      nowMs += ms;
    },
    frame: (intervalMs: number) => {
      nowMs += intervalMs;
      tracker.noteFrame(intervalMs);
    },
  };
}

describe("UnderrunTracker", () => {
  it("clears the indicator after three quiet seconds but preserves diagnostic totals", () => {
    const { tracker, emissions, advance, frame } = makeTracker();
    tracker.beginPlay();
    tracker.judgeSweep(true, 0);
    frame(100);
    tracker.judgeSweep(true, FRAME_US); // also one late frame
    advance(2_999);
    tracker.tickDecay();
    expect(emissions.at(-1)).toEqual({ active: false, droppedFrames: 2, lateFrames: 1 });
    advance(1);
    tracker.tickDecay();
    expect(emissions.at(-1)).toEqual({ active: false, droppedFrames: 2, lateFrames: 1 });
    advance(16);
    tracker.tickDecay(); // confirm unchanged readings on the following sweep
    expect(emissions.at(-1)).toEqual({ active: false, droppedFrames: 0, lateFrames: 0 });
    expect(tracker.snapshot()).toEqual({ active: false, droppedFrames: 2, lateFrames: 1 });
    expect(tracker.takeSessionSummary()).toEqual({ droppedFrames: 2, lateFrames: 1 });
    const count = emissions.length;
    advance(1_000);
    tracker.tickDecay();
    expect(emissions).toHaveLength(count);
    tracker.judgeSweep(true, 2 * FRAME_US);
    expect(emissions.at(-1)).toEqual({ active: true, droppedFrames: 1, lateFrames: 0 });
    expect(tracker.snapshot().droppedFrames).toBe(3);
  });

  it("extends the quiet window for ongoing problems, even on an already-counted content frame", () => {
    const { tracker, emissions, advance } = makeTracker();
    tracker.beginPlay();
    tracker.judgeSweep(true, 0);
    advance(2_900);
    tracker.tickDecay();
    tracker.judgeSweep(true, 0); // same frame: no new count, still unhealthy
    advance(2_999);
    tracker.tickDecay();
    expect(emissions.at(-1)!.droppedFrames).toBe(1);
    advance(1);
    tracker.tickDecay();
    advance(16);
    tracker.tickDecay();
    expect(emissions.at(-1)!.droppedFrames).toBe(0);
    tracker.beginPlay();
    tracker.judgeSweep(true, FRAME_US);
    expect(emissions.at(-1)!.droppedFrames).toBe(1);
    expect(tracker.snapshot().droppedFrames).toBe(1);
  });

  it.each(['drop', 'late tick', 'same stale frame'])(
    'cancels a pending clear when the next sweep reports %s', (cause) => {
      const { tracker, emissions, advance, frame } = makeTracker();
      tracker.beginPlay();
      tracker.judgeSweep(true, 0);
      advance(3_000);
      tracker.tickDecay(); // take a candidate reading, do not clear yet
      expect(emissions.at(-1)!.droppedFrames).toBe(1);
      const before = emissions.length;
      if (cause === 'late tick') frame(100);
      else advance(16);
      tracker.judgeSweep(cause !== 'late tick', cause === 'same stale frame' ? 0 : FRAME_US);
      tracker.tickDecay();
      const expected = { active: true, droppedFrames: cause === 'drop' ? 2 : 1,
        lateFrames: cause === 'late tick' ? 1 : 0 };
      expect(emissions.at(-1)).toEqual(expected);
      expect(emissions.slice(before).every(s => s.droppedFrames > 0 || s.lateFrames > 0)).toBe(true);
      advance(2_999);
      tracker.tickDecay();
      expect(emissions.at(-1)!.droppedFrames).toBe(expected.droppedFrames);
      advance(1);
      tracker.tickDecay();
      advance(16);
      tracker.tickDecay();
      expect(emissions.at(-1)).toEqual({ active: false, droppedFrames: 0, lateFrames: 0 });
      expect(tracker.snapshot()).toEqual({ ...expected, active: false });
    },
  );

  it('preserves a report immediately after clearing as a new visible incident', () => {
    const { tracker, emissions, advance } = makeTracker();
    tracker.beginPlay();
    tracker.judgeSweep(true, 0);
    advance(3_000);
    tracker.tickDecay();
    advance(16);
    tracker.tickDecay();
    expect(emissions.at(-1)!.droppedFrames).toBe(0);
    tracker.judgeSweep(true, FRAME_US); // same timestamp, after the clear
    tracker.tickDecay();
    expect(emissions.at(-1)).toEqual({ active: true, droppedFrames: 1, lateFrames: 0 });
    expect(tracker.takeSessionSummary()).toEqual({ droppedFrames: 2, lateFrames: 0 });
  });

  it("activates immediately on the first late sweep and counts the frame", () => {
    const { tracker, emissions } = makeTracker();
    tracker.beginPlay();
    tracker.judgeSweep(true, 0);
    expect(tracker.snapshot()).toEqual({
      active: true,
      droppedFrames: 1,
      lateFrames: 0,
    });
    expect(emissions.at(-1)).toEqual({
      active: true,
      droppedFrames: 1,
      lateFrames: 0,
    });
  });

  it("counts a comp frame once across repeated rAF ticks", () => {
    const { tracker } = makeTracker();
    tracker.beginPlay();
    tracker.judgeSweep(true, 0);
    tracker.judgeSweep(true, 0); // same comp frame, second rAF tick
    tracker.judgeSweep(true, FRAME_US);
    expect(tracker.snapshot().droppedFrames).toBe(2);
  });

  it("throttles count-growth emissions but not edge flips", () => {
    const { tracker, emissions, advance } = makeTracker({ minEmitIntervalMs: 250 });
    tracker.beginPlay();
    tracker.judgeSweep(true, 0); // edge → emit
    advance(50);
    tracker.judgeSweep(true, FRAME_US); // growth within 250 ms → suppressed
    expect(emissions.at(-1)!.droppedFrames).toBe(1);
    advance(250);
    tracker.judgeSweep(true, 2 * FRAME_US); // past the interval → emitted
    expect(emissions.at(-1)!.droppedFrames).toBe(3);
  });

  it("decays active after holdMs of clean sweeps; the count survives", () => {
    const { tracker, emissions, advance } = makeTracker({ holdMs: 1_500 });
    tracker.beginPlay();
    tracker.judgeSweep(true, 0);
    advance(1_499);
    tracker.tickDecay();
    expect(tracker.snapshot().active).toBe(true);
    advance(2);
    tracker.tickDecay();
    expect(tracker.snapshot()).toEqual({
      active: false,
      droppedFrames: 1,
      lateFrames: 0,
    });
    expect(emissions.at(-1)).toEqual({
      active: false,
      droppedFrames: 1,
      lateFrames: 0,
    });
  });

  it("suppresses late sweeps during the post-seek grace window", () => {
    const { tracker, advance } = makeTracker({ graceMaxMs: 1_000 });
    tracker.beginPlay();
    tracker.noteSeekWhilePlaying();
    // Reported held back, so the fps meter can wait for the same re-prime.
    expect(tracker.judgeSweep(true, 0)).toBe(false);
    advance(500);
    expect(tracker.judgeSweep(true, FRAME_US)).toBe(false);
    expect(tracker.snapshot()).toEqual({
      active: false,
      droppedFrames: 0,
      lateFrames: 0,
    });
  });

  it("clears grace on the first clean sweep, then judges normally", () => {
    const { tracker } = makeTracker();
    tracker.beginPlay();
    tracker.noteSeekWhilePlaying();
    expect(tracker.judgeSweep(false, 0)).toBe(true); // re-primed
    expect(tracker.judgeSweep(true, FRAME_US)).toBe(true);
    expect(tracker.snapshot().droppedFrames).toBe(1);
  });

  it("expires grace after graceMaxMs even without a clean sweep", () => {
    const { tracker, advance } = makeTracker({ graceMaxMs: 1_000 });
    tracker.beginPlay();
    tracker.noteSeekWhilePlaying();
    expect(tracker.judgeSweep(true, 0)).toBe(false); // suppressed
    advance(1_001);
    expect(tracker.judgeSweep(true, FRAME_US)).toBe(true); // wedged decoder can't hide forever
    expect(tracker.snapshot().droppedFrames).toBe(1);
  });

  it("carries an unexpired grace across beginPlay into the session it was armed for", () => {
    // Grace armed during the pre-clock warm-up must survive beginPlay — see
    // underrunTracker.ts `beginPlay`.
    const { tracker, advance } = makeTracker({ graceMaxMs: 1_000 });
    tracker.noteSeekWhilePlaying(); // t=0 → grace deadline t=1000
    advance(100);
    tracker.beginPlay(); // inside the deadline — grace survives
    tracker.judgeSweep(true, 0); // the rebuild's stale sweep → suppressed
    expect(tracker.snapshot().droppedFrames).toBe(0);
    advance(16);
    tracker.judgeSweep(false, FRAME_US); // re-primed → grace clears
    advance(16);
    tracker.judgeSweep(true, 2 * FRAME_US); // judged normally again
    expect(tracker.snapshot().droppedFrames).toBe(1);
  });

  it("does not carry an expired grace into a new play session", () => {
    // The survival rule is the DEADLINE, not the armed flag: a grace whose
    // window already lapsed before the clock released would otherwise be an
    // eternal one for the session that follows.
    const { tracker, advance } = makeTracker({ graceMaxMs: 1_000 });
    tracker.noteSeekWhilePlaying(); // t=0 → grace deadline t=1000
    advance(1_001);
    tracker.beginPlay(); // deadline already passed — grace must not survive
    tracker.judgeSweep(true, 0);
    expect(tracker.snapshot().droppedFrames).toBe(1);
  });

  it("beginPlay resets counters and notifies the store", () => {
    const { tracker, emissions } = makeTracker();
    tracker.beginPlay();
    tracker.judgeSweep(true, 0);
    tracker.beginPlay();
    expect(tracker.snapshot()).toEqual({
      active: false,
      droppedFrames: 0,
      lateFrames: 0,
    });
    expect(emissions.at(-1)).toEqual({
      active: false,
      droppedFrames: 0,
      lateFrames: 0,
    });
  });

  it("reports the session summary exactly once", () => {
    const { tracker, frame } = makeTracker();
    tracker.beginPlay();
    tracker.judgeSweep(true, 0);
    frame(100); // one stalled frame, so both counts are exercised
    tracker.judgeSweep(true, FRAME_US);
    expect(tracker.takeSessionSummary()).toEqual({
      droppedFrames: 2,
      lateFrames: 1,
    });
    // pause-during-warmup fires setMasterPlayState(false) without a new
    // beginPlay — the latch keeps the stale count from re-logging.
    expect(tracker.takeSessionSummary()).toEqual({
      droppedFrames: 0,
      lateFrames: 0,
    });
    tracker.beginPlay();
    tracker.judgeSweep(true, 0);
    expect(tracker.takeSessionSummary()).toEqual({
      droppedFrames: 1,
      lateFrames: 0,
    });
  });

  it("never emits when nothing changed", () => {
    const { tracker, emissions, advance } = makeTracker();
    tracker.beginPlay();
    const baseline = emissions.length;
    tracker.judgeSweep(false, 0);
    tracker.tickDecay();
    advance(5_000);
    tracker.tickDecay();
    expect(emissions.length).toBe(baseline);
  });
});

/// Display and composition rates as frame intervals, in ms.
const ms = (perSecond: number) => 1_000 / perSecond;

/// Whole-refresh gaps up to `limitMs`, starting at one refresh.
function refreshGaps(displayMs: number, limitMs: number): number[] {
  const gaps = [displayMs];
  for (let n = 2; n * displayMs <= limitMs; n += 1) gaps.push(n * displayMs);
  return gaps;
}

describe("lateFrameThresholdMs", () => {
  it.each([
    [60, 60], [30, 60], [24, 60], [60, 144], [60, 120], [120, 60], [60, 75], [25, 50],
  ])("at %s fps on %s Hz, a gap within one comp frame passes and the next refresh trips", (fps, hz) => {
    const budget = ms(fps);
    const display = ms(hz);
    const threshold = lateFrameThresholdMs(budget, display);
    // Gaps no longer than a comp frame can't skip one; one refresh is
    // always healthy, even for a composition faster than the display.
    const healthy = refreshGaps(display, Math.max(budget, display));
    for (const gap of healthy) expect(gap, `${gap} ms`).toBeLessThan(threshold);
    const firstLate = (healthy.length + 1) * display;
    expect(firstLate).toBeGreaterThan(threshold);
    // A healthy refresh landing slightly long is still healthy.
    expect(display * 1.05).toBeLessThan(threshold);
  });

  it("does not count one missed refresh at 30 fps on a 59.94 Hz panel", () => {
    // Two refreshes are 33.37 ms against a 33.33 ms comp frame: no comp
    // frame can be skipped, the panel is just slightly slower than 60 Hz.
    const display = ms(59.94);
    expect(2 * display).toBeLessThan(lateFrameThresholdMs(ms(30), display));
  });
});

/// The late half: judder a full ring hides. Every sweep below passes
/// `anyLate: false` unless it is specifically testing the interaction, so
/// a count here can only have come from a frame interval.
describe("UnderrunTracker late frames", () => {
  /// Feed enough frames at `hz` for the tracker to learn the display rate.
  function settle(frame: (intervalMs: number) => void, tracker: UnderrunTracker, hz: number) {
    for (let i = 0; i < 30; i += 1) {
      frame(ms(hz));
      tracker.tickDecay();
    }
  }

  it("judges the display-frame interval, not the wall time between composites", () => {
    const { tracker, advance, frame } = makeTracker();
    tracker.bindFrameBudgetMs(ms(60));
    tracker.beginPlay();
    for (let i = 0; i < 20; i += 1) {
      advance(8); // this composite ran late, but its frame met the refresh
      frame(ms(60));
      tracker.judgeSweep(false, i * FRAME_US);
    }
    expect(tracker.snapshot().lateFrames).toBe(0);
    frame(2 * ms(60)); // a missed refresh
    tracker.judgeSweep(false, 20 * FRAME_US);
    expect(tracker.snapshot().lateFrames).toBe(1);
  });

  it("learns the display interval from the frame cadence", () => {
    const { tracker, frame } = makeTracker();
    tracker.bindFrameBudgetMs(ms(60));
    const twoMissed = 3 * ms(144); // can skip a 60 fps comp frame
    // Before any cadence the 60 Hz fallback reads this gap as healthy.
    expect(twoMissed).toBeLessThan(lateFrameThresholdMs(ms(60), ms(60)));
    settle(frame, tracker, 144);
    tracker.beginPlay();
    frame(2 * ms(144)); // one missed refresh: shorter than a comp frame
    tracker.judgeSweep(false, 0);
    expect(tracker.snapshot().lateFrames).toBe(0);
    frame(twoMissed);
    tracker.judgeSweep(false, FRAME_US);
    expect(tracker.snapshot().lateFrames).toBe(1);
  });

  it("keeps the learned display interval through a run of long frames", () => {
    const { tracker, frame } = makeTracker();
    tracker.bindFrameBudgetMs(ms(60));
    settle(frame, tracker, 60);
    tracker.beginPlay();
    for (let i = 0; i < 40; i += 1) {
      frame(i % 3 === 0 ? 100 : ms(60)); // a third of the frames stall
      tracker.judgeSweep(false, i * FRAME_US);
    }
    const lateBefore = tracker.snapshot().lateFrames;
    expect(lateBefore).toBe(14);
    frame(2 * ms(60));
    tracker.judgeSweep(false, 40 * FRAME_US);
    expect(tracker.snapshot().lateFrames).toBe(lateBefore + 1);
  });

  it("judges each frame interval once, and never one left from an unjudged frame", () => {
    const { tracker, frame } = makeTracker();
    tracker.beginPlay();
    frame(100);
    tracker.judgeSweep(false, 0);
    tracker.judgeSweep(false, FRAME_US); // a repaint composite in the same frame
    expect(tracker.snapshot().lateFrames).toBe(1);
    frame(100);
    tracker.tickDecay(); // paused or scrubbing: the frame is not judged
    tracker.judgeSweep(false, 2 * FRAME_US); // a later seek composite
    expect(tracker.snapshot().lateFrames).toBe(1);
  });

  it("counts one late frame per snapped comp frame", () => {
    const { tracker, frame } = makeTracker();
    tracker.beginPlay();
    frame(100);
    tracker.judgeSweep(false, 0);
    frame(100);
    tracker.judgeSweep(false, 0); // same comp frame, next display frame
    expect(tracker.snapshot().lateFrames).toBe(1);
    frame(100);
    tracker.judgeSweep(false, FRAME_US);
    expect(tracker.snapshot().lateFrames).toBe(2);
  });

  it("keeps the two causes on separate counters", () => {
    const { tracker, frame } = makeTracker();
    tracker.beginPlay();
    frame(ms(60));
    tracker.judgeSweep(true, 0); // decoder behind, frame on time
    frame(100);
    tracker.judgeSweep(false, FRAME_US); // ring fresh, loop stalled
    expect(tracker.snapshot()).toEqual({
      active: true,
      droppedFrames: 1,
      lateFrames: 1,
    });
  });

  it("suppresses late frames during the post-seek grace window", () => {
    const { tracker, frame } = makeTracker({ graceMaxMs: 1_000 });
    tracker.beginPlay();
    tracker.noteSeekWhilePlaying();
    frame(100); // the ring rebuild stalls the loop
    tracker.judgeSweep(false, 0);
    expect(tracker.snapshot()).toEqual({
      active: false,
      droppedFrames: 0,
      lateFrames: 0,
    });
  });

  it("clears grace once a frame lands on time again", () => {
    const { tracker, frame } = makeTracker();
    tracker.beginPlay();
    tracker.noteSeekWhilePlaying();
    frame(100);
    tracker.judgeSweep(false, 0); // still stalled → suppressed
    frame(ms(60));
    tracker.judgeSweep(false, FRAME_US); // on time → re-primed
    frame(100);
    tracker.judgeSweep(false, 2 * FRAME_US);
    expect(tracker.snapshot().lateFrames).toBe(1);
  });

  it("expires grace after graceMaxMs even while frames stay late", () => {
    const { tracker, advance, frame } = makeTracker({ graceMaxMs: 1_000 });
    tracker.beginPlay();
    tracker.noteSeekWhilePlaying();
    advance(1_000);
    frame(100);
    tracker.judgeSweep(false, 0);
    expect(tracker.snapshot().lateFrames).toBe(1);
  });

  it("decays active after a late frame; the count survives", () => {
    const { tracker, advance, frame } = makeTracker({ holdMs: 1_500 });
    tracker.beginPlay();
    frame(100);
    tracker.judgeSweep(false, 0);
    expect(tracker.snapshot().active).toBe(true);
    advance(1_501);
    tracker.tickDecay();
    expect(tracker.snapshot()).toEqual({
      active: false,
      droppedFrames: 0,
      lateFrames: 1,
    });
  });
});
