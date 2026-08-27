//! `Composition` — the container every timeline shares: settings (canvas, frame
//! rate, audio lattice, color space) plus tracks, markers, transitions and
//! links. The root and every Group are entries of the same type in
//! `Project.compositions`; there is no "sub" shape. Decision:
//! `docs/adr/0052-link-propagates-group-composes.md` §3.

use serde::{Deserialize, Serialize};

use super::color::{ColorSpace, Rgba};
use super::ids::CompositionId;
use super::layer::Layer;
use super::link::Link;
use super::marker::Marker;
use super::time::{Rational, TimeUs};
use super::track::{Track, TrackRole};
use super::transition::Transition;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Composition {
    /// Equals its key in `Project.compositions`; TS validates the pair.
    pub id: CompositionId,
    /// `None` ⇔ wire `null`: the renderer derives "Group N". ALWAYS emitted —
    /// no `skip_serializing_if`, unlike `Link.label`, because TS writes
    /// `label: null` and the fixture round-trip compares whole values.
    pub label: Option<String>,
    pub width: u32,
    pub height: u32,
    /// Equal to the root's in every composition (single lattice, ADR 0052 §5).
    pub fps: Rational,
    /// Composition length as an EXCLUSIVE boundary: the half-open interval
    /// of the timeline is `[0, duration_us)`. For a 10 s 30 fps comp,
    /// `duration_us = 10_000_000` (the boundary AFTER frame 299, not frame
    /// 299's own anchor at 9_966_667). The playhead, being a frame anchor,
    /// can never sit at `duration_us`; its upper bound is
    /// `lastFrameAnchorUs` in `apps/desktop/src/renderer/frames.ts`. See
    /// `docs/data-model.md` for the boundary-vs-anchor distinction.
    ///
    /// Auto-fits to `max(layer.t_end_us)` while `duration_pinned` is false.
    /// An explicit `set_composition { duration_us }` sets the pin and freezes
    /// the value until `fit_composition_to_layers` clears it. See ADR 0005.
    ///
    /// For a Group this is also the source duration every `CompositionRef`
    /// window is measured against (ADR 0052 §4).
    pub duration_us: TimeUs,
    /// When true, layer edits no longer mutate `duration_us` (except to
    /// guard the `duration_us >= max(layer.t_end_us)` invariant). Cleared
    /// by `fit_composition_to_layers`. Old projects deserialize with this
    /// false and self-heal on first edit.
    #[serde(default)]
    pub duration_pinned: bool,
    /// Lattice fields like `fps`: equal to the root's in every composition.
    pub sample_rate: u32,
    pub channels: u8,
    #[serde(default)]
    pub color_space: ColorSpace,
    #[serde(default)]
    pub background: Rgba,
    /// 0 = bottom of z-stack, last = top.
    pub tracks: imbl::Vector<Track>,
    pub markers: imbl::Vector<Marker>,
    /// Authorized layer-pair overlaps with transition semantics. Each entry
    /// authorizes a specific overlap between two adjacent layers on the same
    /// track; validation rejects the composition otherwise. `#[serde(default)]`
    /// is leniency only — TS always writes the field.
    #[serde(default)]
    pub transitions: imbl::Vector<Transition>,
    /// Links (`docs/features.md#links`), members drawn from THIS composition's
    /// layers only. Each `Link` owns a set of `LayerId`s; flat membership (a
    /// layer is in at most one link). The actor maintains a derived
    /// `LayerId → LinkId` index and fans out move/trim/split ops across
    /// members. `#[serde(default)]` is leniency only — TS always writes it.
    #[serde(default)]
    pub links: imbl::Vector<Link>,
}

impl Composition {
    /// Mirror of TS `newComposition` (model.ts): default settings, empty
    /// timeline, and the reserved A/B roll skeleton. Mints A roll, then B roll
    /// — the id order `Project::new_blank` and the fixtures assert.
    pub fn new_with_skeleton(id: CompositionId, label: Option<String>) -> Self {
        Self::from_skeleton(id, label, Self::skeleton_tracks())
    }

    /// The two reserved, kind-agnostic tracks (A roll, B roll) every fresh
    /// composition seeds; layers of any kind coexist on them. V+A pairs from
    /// import land on the same track and render as one combined row. See
    /// `docs/data-model.md`.
    ///
    /// A roll is the primary base and B roll overlays paint on top, per the
    /// z-order convention on `tracks`. Separated-audio rows insert adjacent to
    /// their source video; on-screen order is derived from data order, not
    /// stored.
    ///
    /// `label` is left `None`: a reserved track's name is DERIVED from its
    /// `role` in the renderer (ADR 0042), so a literal written here could
    /// never be localized.
    pub(crate) fn skeleton_tracks() -> imbl::Vector<Track> {
        let mut a_roll = Track::new();
        a_roll.removable = false;
        a_roll.role = Some(TrackRole::ARoll);

        let mut b_roll = Track::new();
        b_roll.removable = false;
        b_roll.role = Some(TrackRole::BRoll);

        imbl::vector![a_roll, b_roll]
    }

    /// Default settings (1080p30, 48 kHz stereo, BT.709, black) around an
    /// already-minted track list. Split from `new_with_skeleton` so a caller
    /// can mint the skeleton before the ids that name it (`Project::new_blank`).
    pub(crate) fn from_skeleton(
        id: CompositionId,
        label: Option<String>,
        tracks: imbl::Vector<Track>,
    ) -> Self {
        Self {
            id,
            label,
            width: 1920,
            height: 1080,
            fps: Rational::FPS_30,
            duration_us: 0,
            duration_pinned: false,
            sample_rate: 48_000,
            channels: 2,
            color_space: ColorSpace::Bt709,
            background: Rgba::BLACK,
            tracks,
            markers: imbl::Vector::new(),
            transitions: imbl::Vector::new(),
            links: imbl::Vector::new(),
        }
    }

    /// Every layer of this composition in track order (bottom track first).
    /// Does NOT descend into referenced compositions.
    pub fn layers(&self) -> impl Iterator<Item = &Layer> {
        self.tracks.iter().flat_map(|t| t.layers.iter())
    }
}
