//! Timeline markers — point or region annotations on ONE composition's timeline.
//!
//! Wire twin of `src/main/state/model.ts` `Marker`; the TS writer owns every
//! rule (`src/main/state/validate.ts`, `src/main/state/mutations/markers.ts`).
//!
//! `label` and `note` are two fields, not one: `label` feeds the marker lane's
//! inline text and the `Ctrl+K` result row, both of which a paragraph ruins, so
//! the long text lives in `note`. Premiere (Name + Comments) and Resolve
//! (Name + Notes) split them for the same reason.
//!
//! `anchor` is truth and `t_us` is a derived cache that stays STORED: the TS
//! reconcile pass re-derives `t_us` from the anchor layer's source window on
//! every commit, so every reader on both sides goes on reading `t_us`.

use serde::{Deserialize, Serialize};

use super::color::Rgba;
use super::ids::{LayerId, MarkerId};
use super::time::TimeUs;

/// One layer plus a time in that layer's SOURCE domain — the domain
/// `src_in_us`/`src_out_us` window. Source time, not timeline time, is what
/// lets the tie survive a trim: the marked frame keeps its identity however the
/// clip is later cut, and a `src_us` that falls outside the window HIBERNATES
/// (retained, unpainted, revived by undoing the trim) rather than being lost.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarkerAnchor {
    pub layer: LayerId,
    pub src_us: TimeUs,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Marker {
    pub id: MarkerId,
    pub t_us: TimeUs,
    /// Region marker when set.
    pub end_t_us: Option<TimeUs>,
    pub label: String,
    /// Long text; the marker Panel's field. `#[serde(default)]` because the
    /// field was added without a schema bump — the TS parse path backfills the
    /// same `""` (`normalizeMarkerFields` in `serialize.ts`).
    #[serde(default)]
    pub note: String,
    pub color: Rgba,
    /// `None` = a FREE marker: it marks the composition's own time. Defaulted
    /// for the same reason `note` is.
    #[serde(default)]
    pub anchor: Option<MarkerAnchor>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Inline JSON written exactly as TS `JSON.stringify` emits it (key order =
    /// model.ts field order) — the cross-language contract check.
    #[test]
    fn anchored_marker_deserializes_from_ts_json() {
        let json = r#"{"id":"00000000-0000-0000-0000-000000000001","t_us":1000000,"end_t_us":2000000,"label":"chapter","note":"the long one","color":{"r":0,"g":128,"b":255,"a":255},"anchor":{"layer":"00000000-0000-0000-0000-000000000002","src_us":500000}}"#;
        let m: Marker = serde_json::from_str(json).expect("deserialize TS JSON");
        assert_eq!(m.t_us, 1_000_000);
        assert_eq!(m.end_t_us, Some(2_000_000));
        assert_eq!(m.note, "the long one");
        assert_eq!(m.anchor.expect("anchored").src_us, 500_000);
        // Byte-stable back out, so a project Rust deserialized and TS re-saved
        // does not churn the file.
        assert_eq!(serde_json::to_string(&m).expect("serialize"), json);
    }

    /// A project written before `note`/`anchor` existed — and one carrying the
    /// deleted free-schema `metadata` map, which only a hand-edited file can
    /// hold. Absent additive fields take their defaults; the unknown key is
    /// ignored at the serde boundary, which is why the deletion needs no
    /// migration step.
    #[test]
    fn old_shaped_marker_defaults_note_and_anchor() {
        let json = r#"{"id":"00000000-0000-0000-0000-000000000001","t_us":0,"end_t_us":null,"label":"m","color":{"r":0,"g":0,"b":0,"a":255},"metadata":{}}"#;
        let m: Marker = serde_json::from_str(json).expect("deserialize pre-anchor JSON");
        assert_eq!(m.note, "");
        assert_eq!(m.anchor, None);
        assert_eq!(m.end_t_us, None);
    }

    #[test]
    fn free_marker_round_trips() {
        let json = r#"{"id":"00000000-0000-0000-0000-000000000003","t_us":33367,"end_t_us":null,"label":"free","note":"","color":{"r":255,"g":0,"b":0,"a":255},"anchor":null}"#;
        let m: Marker = serde_json::from_str(json).expect("deserialize");
        assert_eq!(m.anchor, None);
        assert_eq!(serde_json::to_string(&m).expect("serialize"), json);
    }
}
