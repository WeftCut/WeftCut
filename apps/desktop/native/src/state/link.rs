//! Links — a flat set of two or more layers, across any tracks, whose
//! structural edits (move, trim, split) fan out to every member.
//!
//! Design: `docs/features.md#links`; decision record
//! `docs/adr/0052-link-propagates-group-composes.md`. Membership is flat (a
//! layer is in at most one link). This module owns the wire shape plus the
//! derived-index helper; the TS writer owns enforcement
//! (`src/main/state/validate.ts`) and structural fan-out
//! (`src/main/state/mutations/links.ts`).
//!
//! Links carry only identity, an optional label, and membership. They have no
//! rendering significance.

#![allow(dead_code)]

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::ids::{LayerId, LinkId};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Link {
    pub id: LinkId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// `OrdSet` so the on-disk form is deterministic. Insertion order is
    /// not user-visible — link membership is a set.
    pub members: imbl::OrdSet<LayerId>,
}

impl Link {
    pub fn new(id: LinkId, label: Option<String>, members: imbl::OrdSet<LayerId>) -> Self {
        Self { id, label, members }
    }

    /// Convenience: build from an unordered iterator.
    pub fn from_iter<I: IntoIterator<Item = LayerId>>(
        id: LinkId,
        label: Option<String>,
        members: I,
    ) -> Self {
        Self {
            id,
            label,
            members: members.into_iter().collect(),
        }
    }
}

/// Build the derived `LayerId → LinkId` lookup — O(1) "what link is this in"
/// queries. Derived, never stored: recompute it from `Project.links` after any
/// mutation. The TS writer fans structural ops out through its own
/// `indexLinks` (`src/main/state/mutations/links.ts`).
pub fn index_links(links: &imbl::Vector<Link>) -> HashMap<LayerId, LinkId> {
    let mut idx = HashMap::new();
    for l in links.iter() {
        for &m in l.members.iter() {
            idx.insert(m, l.id);
        }
    }
    idx
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::ids::new_id;

    #[test]
    fn from_iter_collects_members() {
        let id = new_id();
        let a = new_id();
        let b = new_id();
        let l = Link::from_iter(id, Some("l".into()), vec![a, b]);
        assert_eq!(l.id, id);
        assert_eq!(l.members.len(), 2);
        assert!(l.members.contains(&a));
        assert!(l.members.contains(&b));
    }

    #[test]
    fn index_links_maps_each_member_once() {
        let l1_id = new_id();
        let l2_id = new_id();
        let a = new_id();
        let b = new_id();
        let c = new_id();
        let links: imbl::Vector<Link> = imbl::vector![
            Link::from_iter(l1_id, None, vec![a, b]),
            Link::from_iter(l2_id, None, vec![c]),
        ];
        let idx = index_links(&links);
        assert_eq!(idx[&a], l1_id);
        assert_eq!(idx[&b], l1_id);
        assert_eq!(idx[&c], l2_id);
    }
}
