//! `Project` — the top-level state. Single source of truth shared between the
//! UI, IR compiler, MCP server, and persistence layer.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::audio_role::{AudioRole, RoleMixSettings};
use super::composition::Composition;
use super::ids::{new_id, CompositionId, MediaId};
use super::media::MediaItem;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Project {
    /// `.vproj` schema version. **TS owns this number** — `state/model.ts`'s
    /// `SCHEMA_VERSION`, with the upgrade chain in `state/migrate.ts` and the
    /// gate in `state/persistence.ts`. Rust round-trips it opaquely: it never
    /// reads the value, never gates on it, and never writes a project to disk,
    /// so a constant here would be a version claim with no reader (ADR 0047).
    /// The fixtures in this crate's tests therefore write any valid version.
    pub schema_version: u32,
    pub project_id: Uuid,
    pub metadata: ProjectMetadata,
    /// Every timeline of the project — the root and each Group — keyed by
    /// `Composition::id` (ADR 0052 §3). Required on the wire, like `root_id`:
    /// a file without them is the pre-container shape and must fail to load
    /// rather than deserialize to an empty project.
    ///
    /// `OrdMap`, not `HashMap`: imbl's `HashMap` iterates in `RandomState`
    /// order, so two serializations of the same two-entry map could differ and
    /// `project_json_round_trip`'s byte-identity would be order-flaky. Sorted
    /// keys are deterministic (same reason `Link.members` is an `OrdSet`). TS
    /// writes insertion order; nothing compares TS bytes to Rust bytes.
    pub compositions: imbl::OrdMap<CompositionId, Composition>,
    /// Key of the root composition in `compositions`. TS validates that it
    /// resolves (`ValidationError::RootMissing`); `root()` trusts it.
    pub root_id: CompositionId,
    pub media_pool: imbl::HashMap<MediaId, MediaItem>,
    /// Per-role mix-bus settings (`docs/audio.md`). Absent keys resolve to
    /// `RoleMixSettings::default()` via `role_mix`. `#[serde(default)]`
    /// makes pre-roles `.vproj` files load with every role at unity.
    #[serde(default)]
    pub audio_roles: imbl::HashMap<AudioRole, RoleMixSettings>,
    pub settings: ProjectSettings,
}

impl Project {
    pub fn new_blank(name: impl Into<String>) -> Self {
        let now = Utc::now();
        // Mint order mirrors TS `blankProject` (model.ts): A roll, B roll,
        // project_id, root_id — the skeleton before the two ids that name it.
        let tracks = Composition::skeleton_tracks();
        let project_id = new_id();
        let root_id = new_id();
        let root = Composition::from_skeleton(root_id, None, tracks);
        Self {
            // TS owns the real number (see the field doc); this is a fixture.
            schema_version: 1,
            project_id,
            metadata: ProjectMetadata {
                name: name.into(),
                created_at: now,
                modified_at: now,
                description: None,
            },
            compositions: imbl::OrdMap::unit(root_id, root),
            root_id,
            media_pool: imbl::HashMap::new(),
            audio_roles: imbl::HashMap::new(),
            settings: ProjectSettings::default(),
        }
    }

    /// The root composition. Panics if `root_id` does not resolve — TS
    /// validates that before any project reaches Rust.
    pub fn root(&self) -> &Composition {
        self.compositions
            .get(&self.root_id)
            .expect("validated: root_id resolves")
    }

    pub fn root_mut(&mut self) -> &mut Composition {
        self.compositions
            .get_mut(&self.root_id)
            .expect("validated: root_id resolves")
    }

    pub fn composition(&self, id: &CompositionId) -> Option<&Composition> {
        self.compositions.get(id)
    }

    /// Mix settings for a role, defaulted when the table has no entry.
    pub fn role_mix(&self, role: AudioRole) -> RoleMixSettings {
        self.audio_roles.get(&role).cloned().unwrap_or_default()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProjectMetadata {
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub modified_at: DateTime<Utc>,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProjectSettings {
    /// Declared preview resolution. Wire-only — nothing reads the pair today;
    /// the Pixi preview sizes off the composition and the playback-resolution
    /// setting.
    pub preview_width: u32,
    pub preview_height: u32,
    pub autosave_interval_secs: Option<u32>,
    pub history_capacity: usize,
    /// When `true` (default), importing a video source that has an audio
    /// stream creates both a `VideoClip` and an `Audio` layer pointing at
    /// the same media, and links them. See `docs/features.md#links`. When
    /// `false`, only the `VideoClip` layer is created (audio is silently
    /// dropped).
    #[serde(default = "default_auto_pair_audio_on_import")]
    pub auto_pair_audio_on_import: bool,
    /// When `true`, preview decode prefers a generated proxy over the
    /// original source (per-clip `proxy_overrides` can force either way).
    /// Default `false` (native-decode-always, matching NLE convention).
    #[serde(default)]
    pub prefer_proxies: bool,
    /// Per-clip override of `prefer_proxies`, keyed by media id. Absent =
    /// follow the global preference. See `project_settings_patch_convention`.
    #[serde(default)]
    pub proxy_overrides: std::collections::HashMap<String, bool>,
}

fn default_auto_pair_audio_on_import() -> bool {
    true
}

/// Patch shape for `update_project_settings` — every field optional so the UI
/// can send tiny diffs without echoing the rest of the struct.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct ProjectSettingsPatch {
    pub prefer_proxies: Option<bool>,
    #[serde(default)]
    pub proxy_override: Option<ProxyOverridePatch>,
}

/// One entry of the `proxy_overrides` map, patched in or cleared.
/// `value: None` clears the override (falls back to the global preference).
#[derive(Clone, Debug, Deserialize)]
pub struct ProxyOverridePatch {
    pub media_id: String,
    pub value: Option<bool>,
}

/// Patch shape for `update_track_flags` — the timeline header's
/// eye/M/S/lock toggles. Preference-shaped like `ProjectSettingsPatch`:
/// applied to every history snapshot and never recorded, so Ctrl-Z never
/// flips a track toggle. Only `Some(_)` fields are applied.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct TrackFlagsPatch {
    pub enabled: Option<bool>,
    pub muted: Option<bool>,
    pub solo: Option<bool>,
    pub locked: Option<bool>,
}

impl Default for ProjectSettings {
    fn default() -> Self {
        Self {
            preview_width: 1280,
            preview_height: 720,
            autosave_interval_secs: Some(60),
            history_capacity: 200,
            auto_pair_audio_on_import: true,
            prefer_proxies: false,
            proxy_overrides: Default::default(),
        }
    }
}

#[cfg(test)]
mod role_tests {
    use super::*;

    #[test]
    fn legacy_project_without_audio_roles_defaults_to_unity() {
        let p = Project::new_blank("t");
        let mut v = serde_json::to_value(&p).unwrap();
        v.as_object_mut().unwrap().remove("audio_roles");
        let back: Project = serde_json::from_value(v).unwrap();
        assert!(back.audio_roles.is_empty());
        let m = back.role_mix(AudioRole::Music);
        assert_eq!(m.gain_db, 0.0);
        assert!(!m.muted && !m.solo);
    }

    #[test]
    fn role_mix_reads_table_entry() {
        let mut p = Project::new_blank("t");
        p.audio_roles.insert(
            AudioRole::Dialogue,
            RoleMixSettings {
                gain_db: 6.0,
                muted: false,
                solo: true,
            },
        );
        let m = p.role_mix(AudioRole::Dialogue);
        assert_eq!(m.gain_db, 6.0);
        assert!(m.solo);
    }
}
