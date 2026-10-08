//! Export admission reserves the simultaneous working set once. Children
//! borrow that reservation; releasing a child transfers it back atomically.
use super::*;

pub(super) struct ExportPlanState {
    threads: u32,
    released: bool,
}

impl Governor {
    fn reserve_export(&self, options: &[u64], native_encoder: bool) -> serde_json::Value {
        let mut s = self.state.lock().unwrap();
        let used: u64 = s.leases.values().map(|c| c.mib).sum();
        let threads: u32 = s.leases.values().map(|c| c.threads).sum();
        let request_threads = if native_encoder {
            s.limits.task_threads
        } else {
            0
        };
        let available = s.limits.work_mib.saturating_sub(used);
        let minimum = *options.iter().min().unwrap();
        let reason = if minimum > s.limits.work_mib {
            Some("budget-too-small")
        } else if s.critical {
            Some("host-pressure")
        } else if s.pressured {
            Some("pressure")
        } else if (native_encoder && s.plans.values().any(|p| p.threads > 0))
            || threads + request_threads > s.limits.cpu_threads
            || s.finalization_waiting > 0
        {
            Some("busy")
        } else {
            None
        };
        let choice = options.iter().position(|mib| *mib <= available);
        if reason.is_some() || choice.is_none() {
            return serde_json::json!({"kind":"blocked", "reason":reason.unwrap_or("busy"),
                "requestedMiB":minimum, "availableMiB":available, "workMiB":s.limits.work_mib,
                "revision":s.revision});
        }
        let index = choice.unwrap();
        let id = Self::insert_export_claim(
            &mut s,
            Claim {
                mib: options[index],
                threads: request_threads,
                background: false,
            },
        );
        s.plans.insert(
            id,
            ExportPlanState {
                threads: request_threads,
                released: false,
            },
        );
        s.finalizations.insert(id, FinalizationState::default());
        serde_json::json!({"kind":"admitted", "id":id, "index":index})
    }

    fn insert_export_claim(s: &mut State, claim: Claim) -> u32 {
        loop {
            s.next = s.next.wrapping_add(1).max(1);
            if let std::collections::hash_map::Entry::Vacant(entry) = s.leases.entry(s.next) {
                entry.insert(claim);
                return s.next;
            }
        }
    }

    pub(super) fn borrow_export(s: &mut State, parent: u32, claim: Claim) -> Option<u32> {
        let plan = s.plans.get(&parent)?;
        let remaining = s.leases.get_mut(&parent)?;
        if plan.released
            || s.critical
            || remaining.mib < claim.mib
            || remaining.threads < claim.threads
        {
            return None;
        }
        remaining.mib -= claim.mib;
        remaining.threads -= claim.threads;
        let id = Self::insert_export_claim(s, claim);
        s.production.insert(id, parent);
        Some(id)
    }

    pub(super) fn release_export(s: &mut State, id: u32) -> bool {
        if let Some(&parent) = s
            .production
            .get(&id)
            .filter(|parent| s.plans.contains_key(parent))
        {
            s.production.remove(&id);
            let claim = s.leases.remove(&id).unwrap();
            if !s.plans[&parent].released {
                let remaining = s.leases.get_mut(&parent).unwrap();
                remaining.mib += claim.mib;
                // The encoder's CPU phase is complete. Memory can serve later
                // spans; these threads return to the governor before mux.
                // Keeping the original plan thread demand prevents re-opening
                // another encoder against an already consumed CPU admission.
            } else if !s.production.values().any(|p| *p == parent) {
                s.plans.remove(&parent);
                s.finalizations.remove(&parent);
                s.leases.remove(&parent);
            }
            return true;
        }
        if let Some(plan) = s.plans.get_mut(&id) {
            plan.released = true;
            // Unused capacity returns now; live children remain charged through
            // their real teardown, even when the window has already gone away.
            let remaining = s.leases.get_mut(&id).unwrap();
            remaining.mib = 0;
            remaining.threads = 0;
            if !s.production.values().any(|parent| *parent == id) {
                s.plans.remove(&id);
                s.finalizations.remove(&id);
                s.leases.remove(&id);
            }
            return true;
        }
        false
    }

    pub(super) fn finish_export_production(
        s: &mut State,
        id: u32,
    ) -> Result<(), FinalizationBlocked> {
        if let Some(plan) = s.plans.get(&id) {
            if plan.released {
                return Err(FinalizationBlocked::Failed(
                    "Export production is still active or closed",
                ));
            }
            if s.production.values().any(|parent| *parent == id) {
                return Err(FinalizationBlocked::CpuBusy);
            }
            s.plans.remove(&id);
            let tail = s.leases.get_mut(&id).unwrap();
            tail.mib = 64;
            tail.threads = 0;
        }
        Ok(())
    }
}

/// Native sink borrows the same owner-validated export token as worker decoders.
pub async fn interactive_export(mib: u64, parent: Option<u32>) -> Result<Permit, String> {
    let Some(parent) = parent else {
        return super::interactive(mib).await;
    };
    let authority = governor();
    let threads = authority
        .state
        .lock()
        .unwrap()
        .plans
        .get(&parent)
        .ok_or("Export resource plan expired")?
        .threads;
    let id = authority
        .reserve_for(
            Claim {
                mib,
                threads,
                background: false,
            },
            Some(parent),
        )
        .ok_or(
            "resource-capacity-exceeded: Export plan exhausted or host memory is critically low",
        )?;
    Ok(Permit {
        governor: authority.clone(),
        id,
    })
}

#[cfg_attr(test, allow(dead_code))] // Called through NAPI, not the Rust test binary.
#[napi]
pub fn resources_plan_export(options_json: String, native_encoder: bool) -> napi::Result<String> {
    let options: Vec<u64> = serde_json::from_str(&options_json)
        .map_err(|_| napi::Error::from_reason("Invalid export resource plans"))?;
    if options.is_empty()
        || options.len() > 8
        || options
            .iter()
            .any(|mib| *mib < 64 || *mib > u32::MAX as u64)
    {
        return Err(napi::Error::from_reason("Invalid export resource plans"));
    }
    Ok(governor()
        .reserve_export(&options, native_encoder)
        .to_string())
}

/// Register before checking the revision: releases between rejection and wait
/// cannot be lost. A bounded native wait also bounds abandoned IPC requests.
#[cfg_attr(test, allow(dead_code))] // Called through NAPI, not the Rust test binary.
#[napi]
pub async fn resources_wait_for_change(revision: u32) {
    let g = governor();
    let changed = g.changed.notified();
    tokio::pin!(changed);
    changed.as_mut().enable();
    if g.state.lock().unwrap().revision != revision {
        return;
    }
    let _ = tokio::time::timeout(std::time::Duration::from_secs(15), changed).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    fn plan(g: &Governor, options: &[u64]) -> u32 {
        g.reserve_export(options, true)["id"].as_u64().unwrap() as u32
    }
    #[test]
    fn chooses_a_plan_and_children_do_not_double_charge() {
        let g = Governor::new();
        let id = plan(&g, &[1200, 800]);
        assert_eq!(g.snapshot().reserved_mib, 800);
        let a = g
            .reserve_for(
                Claim {
                    mib: 200,
                    threads: 1,
                    background: false,
                },
                Some(id),
            )
            .unwrap();
        let b = g
            .reserve_for(
                Claim {
                    mib: 600,
                    threads: 0,
                    background: false,
                },
                Some(id),
            )
            .unwrap();
        assert_eq!(g.snapshot().reserved_mib, 800);
        assert!(g
            .reserve_for(
                Claim {
                    mib: 1,
                    threads: 0,
                    background: false
                },
                Some(id)
            )
            .is_none());
        assert!(g.start_finalization(id).is_err());
        g.release(a);
        assert_eq!(g.snapshot().cpu_threads, 0);
        g.release(b);
        let mux = g.start_finalization(id).unwrap();
        assert_eq!(g.snapshot().reserved_mib, 64);
        drop(mux);
        g.release(id);
        assert_eq!(g.snapshot().active, 0);
    }
    #[test]
    fn owner_exit_does_not_release_running_children_early() {
        let g = Governor::new();
        let id = plan(&g, &[800]);
        let child = g
            .reserve_for(
                Claim {
                    mib: 200,
                    threads: 1,
                    background: false,
                },
                Some(id),
            )
            .unwrap();
        g.release(id);
        assert_eq!(g.snapshot().reserved_mib, 200);
        assert!(g
            .reserve_for(
                Claim {
                    mib: 1,
                    threads: 0,
                    background: false
                },
                Some(id)
            )
            .is_none());
        g.release(child);
        assert_eq!(g.snapshot().active, 0);
    }
    #[test]
    fn pressure_and_setting_reduction_do_not_strand_admitted_work_but_critical_does() {
        let g = Governor::new();
        let id = plan(&g, &[800]);
        {
            let mut s = g.state.lock().unwrap();
            s.pressured = true;
            s.limits.work_mib = 64;
        }
        let a = g
            .reserve_for(
                Claim {
                    mib: 100,
                    threads: 0,
                    background: false,
                },
                Some(id),
            )
            .unwrap();
        g.state.lock().unwrap().critical = true;
        assert!(g
            .reserve_for(
                Claim {
                    mib: 100,
                    threads: 0,
                    background: false
                },
                Some(id)
            )
            .is_none());
        g.release(a);
        g.release(id);
        assert_eq!(g.snapshot().active, 0);
    }
    #[tokio::test]
    async fn finalization_waits_for_real_child_teardown() {
        let g = Governor::new();
        let id = plan(&g, &[800]);
        let child = g
            .reserve_for(
                Claim {
                    mib: 100,
                    threads: 0,
                    background: false,
                },
                Some(id),
            )
            .unwrap();
        let authority = g.clone();
        let finish = tokio::spawn(async move { authority.acquire_finalization(id).await });
        tokio::task::yield_now().await;
        assert!(!finish.is_finished());
        assert_eq!(g.snapshot().reserved_mib, 800);
        g.release(child);
        let tail = finish.await.unwrap().unwrap();
        assert_eq!(g.snapshot().reserved_mib, 64);
        drop(tail);
        g.release(id);
        assert_eq!(g.snapshot().active, 0);
    }
    #[test]
    fn permanent_shortage_and_busy_are_distinct_and_waiters_hold_nothing() {
        let g = Governor::new();
        assert_eq!(
            g.reserve_export(&[2000], true)["reason"],
            "budget-too-small"
        );
        let id = plan(&g, &[800]);
        assert_eq!(g.reserve_export(&[800], true)["reason"], "busy");
        assert_eq!(g.snapshot().reserved_mib, 800);
        g.release(id);
        assert_eq!(g.reserve_export(&[800], true)["kind"], "admitted");
    }
}
