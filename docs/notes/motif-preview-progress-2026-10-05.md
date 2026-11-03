# Motif preview progress during playback (2026-10-05)

**Finding.** Accepting only the exact target frame during forward playback
makes every tick a discontinuity: an asynchronous capture result is obsolete on
arrival, so the sprite never advances. Local transition traces showed 310–477 ms
holds with content 19–29 frames behind while composite submission p99 stayed
~19 ms — composite FPS alone does not reveal it. Do not reintroduce exact-target
acceptance for playback; it is correct only for pause/seek/scrub.

**What fixed it** (current behavior, see preview.md § Motifs): one admitted
request per sprite plus a single latest target; a late result may advance the
picture, newer cache hits overtake it, nothing rolls back; a miss may show a
cached frame within three frames of the target; prewarm admits content visible
now or within 500 ms.

**After.** Three fresh-process runs: incoming lag and outdated holds zero,
submission p99 19.2–19.8 ms. Two 42.5 s passes: 16.67 ms mean cadence, p99
18.9–19.4 ms (before 19.5–19.7), no >50 ms intervals; CPU 6.3–6.4 % vs
7.1–7.5 %. Differences establish no regression, not a speedup.

**Environment / probe.** Local dev box, native GPU video path. Restart the app
between timing runs — hot reloads contaminated an earlier run. Diagnostics:
compositor snapshot, PerfHUD and playback-perf JSON report Motif target/bound
frame, lag, hold time and pending/completion/discard counts. Electron tests
inject an 80 ms bitmap-delivery delay.
