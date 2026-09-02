//! Per-span pixel measurement for the shot layer: brightness / motion /
//! sharpness plus the black / freeze / fade flags, over spans a caller names
//! rather than over a detection's own shots.
//!
//! Owns [`measure_span`](crate::jobs::shot::stats::measure_span) — the ONE
//! place three frames become four numbers, used both by `analyze_clip`'s
//! per-shot pass (`super::attach_stats`) and by the review surface's on-demand
//! [`attach_span_stats`](crate::jobs::shot::stats::attach_span_stats) — and
//! the `shot-stats/` sidecar the second accumulates into. It does not own
//! where a shot begins:
//! spans arrive from `super::reduce` by way of the Panel, and nothing here
//! detects, merges or re-indexes them. See ADR 0057.

use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use super::{
    extract_rgb, is_fade, mean_luma, motion_between, ssim, var_laplacian, write_json_atomic,
    ShotFlag, BLACK_LUMA, FREEZE_SSIM,
};
use crate::cache::CacheLayout;
use crate::state::MediaItem;

/// What [`measure_span`] found in one span's three frames. Every field is filled
/// — the pass is all-or-nothing by construction, because the same three
/// extractions answer all four questions — and it is the caller's job to keep
/// only the halves it asked for.
pub(crate) struct Measured {
    pub brightness: f64,
    pub motion: f64,
    pub sharpness: f64,
    pub flags: Vec<ShotFlag>,
}

/// One measured span, keyed by the span itself. Times are source-absolute and
/// the pair is exact: a span is either the one that was measured or a different
/// shot, the rule `super::reduce` states for carrying stats onto a reduced span.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpanStats {
    pub t_start_us: i64,
    pub t_end_us: i64,
    pub brightness: f64,
    pub motion: f64,
    pub sharpness: f64,
    pub flags: Vec<ShotFlag>,
}

/// Every span measured so far on one (source, tier), sorted by start then end.
///
/// ONE file per (source, tier) rather than one per span. A minutes-long source
/// at [`super::FLOOR_SENSITIVITY`] reduces to hundreds of spans, and a reviewer
/// who moves the threshold twice asks about hundreds more — so per-span sidecars
/// would put thousands of ~200-byte files under one flat directory, where every
/// hygiene walk of the cache tree pays a stat per entry and the measurement
/// itself pays an open per span. Accumulating into one file makes a whole
/// threshold's worth of lookups a single read and a single atomic promote, at
/// the cost of rewriting the file per batch — cheap next to the three ffmpeg
/// spawns each fresh span already costs.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SpanStatsCache {
    entries: Vec<SpanStats>,
}

impl SpanStatsCache {
    /// The measurement for each requested span, in request order, `None` where
    /// this cache holds none. Exact `[start, end]` match only.
    pub fn lookup(&self, spans: &[(i64, i64)]) -> Vec<Option<&SpanStats>> {
        spans.iter().map(|&span| self.find(span)).collect()
    }

    /// The requested spans this cache cannot answer, deduplicated and in request
    /// order — exactly what needs measuring, and the reason a threshold change
    /// that keeps most boundaries costs only the spans it actually reshaped.
    pub fn missing(&self, spans: &[(i64, i64)]) -> Vec<(i64, i64)> {
        let mut out: Vec<(i64, i64)> = Vec::new();
        for &span in spans {
            if self.find(span).is_some() || out.contains(&span) {
                continue;
            }
            out.push(span);
        }
        out
    }

    /// Fold fresh measurements in, replacing any entry for the same span. A
    /// re-measurement wins rather than being appended: two entries for one span
    /// would make [`lookup`](Self::lookup) depend on which came first, and the
    /// newer one was taken from the same frames the older was.
    pub fn merge(&mut self, fresh: Vec<SpanStats>) {
        for stats in fresh {
            match self
                .entries
                .iter_mut()
                .find(|e| e.t_start_us == stats.t_start_us && e.t_end_us == stats.t_end_us)
            {
                Some(slot) => *slot = stats,
                None => self.entries.push(stats),
            }
        }
        self.entries.sort_by_key(|e| (e.t_start_us, e.t_end_us));
    }

    fn find(&self, (t_start_us, t_end_us): (i64, i64)) -> Option<&SpanStats> {
        self.entries
            .iter()
            .find(|e| e.t_start_us == t_start_us && e.t_end_us == t_end_us)
    }
}

/// The sidecar key: `blake3(source_hash | tier)`. The source content hash makes
/// a relink / content change auto-invalidate; `tier` is the physical input the
/// measurements are taken on — the floor report's own tier
/// ([`super::report_source`]) — folded in for `super::cache_key`'s reason:
/// these numbers derive from that tier's swscale output, so a brightness
/// measured on the original must not be served as the proxy's. Detection
/// parameters are deliberately ABSENT: a span is a span
/// whatever threshold produced it, which is what lets a boundary that survives a
/// threshold move keep its measurement.
pub fn cache_key(source_hash: &str, tier: &str) -> String {
    let mut h = blake3::Hasher::new();
    h.update(source_hash.as_bytes());
    h.update(b"\0");
    h.update(tier.as_bytes());
    h.finalize().to_hex().to_string()
}

/// Measure `[t_start_us, t_end_us]` of `video` from three frames — one inside
/// each end and one at `keyframe_t_us` — writing the PNGs under `dir` prefixed
/// with `file_tag` so concurrent spans in one temp dir cannot collide.
///
/// The endpoints are inset by an eighth of the span (capped at 250 ms) so they
/// sit inside it rather than on a cut boundary shared with the neighbour, where
/// the decoder's choice of frame decides whose shot got measured.
pub(crate) async fn measure_span(
    video: &Path,
    dir: &Path,
    t_start_us: i64,
    t_end_us: i64,
    keyframe_t_us: i64,
    file_tag: &str,
) -> Result<Measured> {
    let dur = (t_end_us - t_start_us).max(0);
    let inset = (dur / 8).clamp(0, 250_000);
    let t_start = t_start_us + inset;
    let t_mid = keyframe_t_us;
    let t_end = (t_end_us - inset).max(t_start);

    let f_start = extract_rgb(video, t_start, &dir.join(format!("{file_tag}_a.png"))).await?;
    let f_mid = extract_rgb(video, t_mid, &dir.join(format!("{file_tag}_m.png"))).await?;
    let f_end = extract_rgb(video, t_end, &dir.join(format!("{file_tag}_z.png"))).await?;

    let l_start = mean_luma(&f_start);
    let l_mid = mean_luma(&f_mid);
    let l_end = mean_luma(&f_end);

    let mut flags = Vec::new();
    if l_start < BLACK_LUMA && l_mid < BLACK_LUMA && l_end < BLACK_LUMA {
        flags.push(ShotFlag::Black);
    }
    if ssim(&f_start, &f_mid) >= FREEZE_SSIM && ssim(&f_mid, &f_end) >= FREEZE_SSIM {
        flags.push(ShotFlag::Freeze);
    }
    if is_fade(l_start, l_mid, l_end) {
        flags.push(ShotFlag::Fade);
    }
    Ok(Measured {
        brightness: l_mid,
        sharpness: var_laplacian(&f_mid),
        motion: motion_between(&f_start, &f_end),
        flags,
    })
}

/// Measure the spans of `media` that have not been measured yet and answer for
/// all of them, in request order.
///
/// EXPENSIVE per fresh span (three ffmpeg extracts) and free per cached one,
/// which is the whole shape of the call: a reviewer who nudges the threshold
/// pays only for the spans the move reshaped. Nothing here decides which spans
/// are worth measuring — an empty request touches no disk at all — so an
/// automatic pass over every reduce would be the caller's mistake, not this
/// function's (see [`super::floor_opts`] for why the scan measures nothing).
pub async fn attach_span_stats(
    cache: &CacheLayout,
    media: &MediaItem,
    spans: &[(i64, i64)],
) -> Result<Vec<SpanStats>> {
    if spans.is_empty() {
        return Ok(Vec::new());
    }
    // Measure on the tier the floor report was scanned on — its tier is part of
    // the key, and the numbers must share the boundaries' provenance.
    let (video, tier) = super::report_source(cache, media);
    let path = cache.shot_stats(&cache_key(&media.file_hash_blake3, tier));
    crate::cache::touch_if_stale(&path);
    let mut measured = if crate::cache::cached_ok(&path) {
        match read_cache(&path) {
            Ok(cache) => cache,
            Err(e) => {
                tracing::warn!(
                    "shot-stats cache {} unreadable, re-measuring: {e:#}",
                    path.display()
                );
                SpanStatsCache::default()
            }
        }
    } else {
        SpanStatsCache::default()
    };

    let pending = measured.missing(spans);
    if !pending.is_empty() {
        let tmp = tempfile::Builder::new()
            .prefix("weftcut-span-stats")
            .tempdir()
            .context("span stat temp dir")?;
        let mut fresh = Vec::with_capacity(pending.len());
        for (i, &(t_start_us, t_end_us)) in pending.iter().enumerate() {
            // The span midpoint, which is what `super::reduce` picks for a span
            // it did not measure — so the frame this samples is the frame the
            // Panel row already shows as the shot's cover.
            let keyframe_t_us = t_start_us + (t_end_us - t_start_us) / 2;
            let m = measure_span(
                &video,
                tmp.path(),
                t_start_us,
                t_end_us,
                keyframe_t_us,
                &format!("q{i}"),
            )
            .await?;
            fresh.push(SpanStats {
                t_start_us,
                t_end_us,
                brightness: m.brightness,
                motion: m.motion,
                sharpness: m.sharpness,
                flags: m.flags,
            });
        }
        measured.merge(fresh);
        write_json_atomic(&path, &measured, "shot span stats").await?;
        cache.notify_write();
    }

    let mut out = Vec::with_capacity(spans.len());
    for (span, hit) in spans.iter().zip(measured.lookup(spans)) {
        match hit {
            Some(stats) => out.push(stats.clone()),
            // Unreachable: `missing` named every span the sidecar lacked and each
            // was just merged. Bailing beats returning a short list, which a
            // caller reading the answer positionally would silently misalign.
            None => anyhow::bail!("span [{}, {}] missing after measurement", span.0, span.1),
        }
    }
    Ok(out)
}

/// Read a `SpanStatsCache` back from its JSON sidecar.
fn read_cache(path: &Path) -> Result<SpanStatsCache> {
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_slice(&bytes)
        .with_context(|| format!("parse shot span stats {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stats(t_start_us: i64, t_end_us: i64, brightness: f64) -> SpanStats {
        SpanStats {
            t_start_us,
            t_end_us,
            brightness,
            motion: 0.2,
            sharpness: 4.0,
            flags: vec![],
        }
    }

    /// Two measured spans over a six-second source.
    fn seeded() -> SpanStatsCache {
        let mut cache = SpanStatsCache::default();
        cache.merge(vec![
            stats(0, 2_000_000, 0.1),
            stats(2_000_000, 6_000_000, 0.2),
        ]);
        cache
    }

    #[test]
    fn lookup_matches_a_span_exactly_or_not_at_all() {
        let cache = seeded();
        let got = cache.lookup(&[
            (0, 2_000_000),
            // One microsecond off, and a span the reduce merged: different
            // shots, so a neighbour's numbers are not theirs.
            (0, 2_000_001),
            (0, 6_000_000),
        ]);
        assert_eq!(got[0].map(|s| s.brightness), Some(0.1));
        assert!(got[1].is_none());
        assert!(got[2].is_none());
    }

    /// The acceptance for the on-demand pass: exactly one measurement per
    /// uncached span, and none for the cached ones.
    #[test]
    fn missing_names_only_the_unmeasured_spans() {
        let cache = seeded();
        let asked = [
            (0, 2_000_000),         // cached
            (2_000_000, 3_000_000), // fresh
            (3_000_000, 6_000_000), // fresh
            (2_000_000, 6_000_000), // cached
        ];
        assert_eq!(
            cache.missing(&asked),
            vec![(2_000_000, 3_000_000), (3_000_000, 6_000_000)]
        );
    }

    #[test]
    fn missing_is_empty_for_a_fully_measured_set() {
        // The second press of a Measure button, and the reason it costs no
        // ffmpeg: nothing is left to measure.
        assert!(seeded()
            .missing(&[(0, 2_000_000), (2_000_000, 6_000_000)])
            .is_empty());
    }

    #[test]
    fn missing_deduplicates_and_keeps_request_order() {
        let cache = SpanStatsCache::default();
        let asked = [
            (4_000_000, 5_000_000),
            (0, 1_000_000),
            (4_000_000, 5_000_000),
        ];
        assert_eq!(
            cache.missing(&asked),
            vec![(4_000_000, 5_000_000), (0, 1_000_000)]
        );
    }

    #[test]
    fn merge_replaces_a_same_span_entry_and_keeps_the_order_sorted() {
        let mut cache = seeded();
        cache.merge(vec![
            stats(1_000_000, 2_000_000, 0.5),
            stats(0, 2_000_000, 0.9),
        ]);
        assert_eq!(
            cache
                .entries
                .iter()
                .map(|e| (e.t_start_us, e.t_end_us, e.brightness))
                .collect::<Vec<_>>(),
            vec![
                (0, 2_000_000, 0.9),
                (1_000_000, 2_000_000, 0.5),
                (2_000_000, 6_000_000, 0.2),
            ]
        );
    }

    #[test]
    fn span_stats_json_round_trips() {
        let mut cache = seeded();
        cache.merge(vec![SpanStats {
            flags: vec![ShotFlag::Black, ShotFlag::Fade],
            ..stats(6_000_000, 7_000_000, 0.0)
        }]);
        let back: SpanStatsCache =
            serde_json::from_slice(&serde_json::to_vec(&cache).unwrap()).unwrap();
        assert_eq!(back, cache);
        assert_eq!(
            back.lookup(&[(6_000_000, 7_000_000)])[0].map(|s| s.flags.clone()),
            Some(vec![ShotFlag::Black, ShotFlag::Fade])
        );
    }

    #[test]
    fn cache_key_depends_on_source_and_tier_only() {
        let base = cache_key("h", "quick");
        assert_eq!(base, cache_key("h", "quick")); // deterministic
        assert_ne!(base, cache_key("h2", "quick")); // source hash
        assert_ne!(base, cache_key("h", "orig")); // source tier
                                                  // And it is NOT the VSHOT key: a report and the spans measured out of it
                                                  // live in different namespaces under different keys.
        assert_ne!(
            base,
            super::super::cache_key("h", "quick", &super::super::floor_opts())
        );
    }

    /// An empty request is answered without resolving a source, reading a
    /// sidecar or spawning ffmpeg — which is what lets a Panel call it
    /// unconditionally once every row is measured.
    #[tokio::test]
    async fn attach_span_stats_touches_no_disk_for_an_empty_request() {
        let tmp = tempfile::TempDir::new().unwrap();
        let cache = CacheLayout::new(tmp.path().to_path_buf());
        cache.ensure_dirs().unwrap();
        let media: MediaItem = serde_json::from_value(serde_json::json!({
            "id": uuid::Uuid::now_v7(),
            "label": null,
            "path_abs": "/nonexistent.mp4",
            "path_rel": null,
            "kind": "Video",
            "metadata": crate::state::MediaMetadata { duration_us: Some(6_000_000), ..Default::default() },
            "decode_route": { "route": "bypass" },
            "waveform_path": null,
            "conform_path": null,
            "thumbnails_dir": null,
            "file_hash_blake3": "cafef00d",
            "file_size": 0,
            "file_mtime": 0,
            "imported_at": chrono::Utc::now(),
        }))
        .unwrap();

        assert!(attach_span_stats(&cache, &media, &[])
            .await
            .unwrap()
            .is_empty());
        assert!(!crate::cache::cached_ok(
            &cache.shot_stats(&cache_key("cafef00d", "orig"))
        ));
    }
}
