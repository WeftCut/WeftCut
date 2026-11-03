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
                "holders":Self::holder_uses(&s), "revision":s.revision});
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
            let id = s.next;
            if let std::collections::hash_map::Entry::Vacant(entry) = s.leases.entry(id) {
                entry.insert(claim);
                Self::name_lease(s, id, current_holder("export"));
                return id;
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
pub async fn interactive_export(mib: u64, parent: u32) -> Result<Permit, String> {
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

/// Working memory of the audio mix + encode tail (TS `EXPORT_AUDIO_MIX_MIB`,
/// which floors every plan of an export with audio at this size).
pub const EXPORT_AUDIO_MIX_MIB: u64 = 128;

impl Governor {
    /// The audio tail runs inside its export's admitted plan, before any video
    /// child exists, so it borrows the plan's memory and never waits: a plan
    /// that cannot cover it is expired or mis-sized, not busy. It takes none
    /// of the plan's threads: a returned child gives back only memory
    /// (`release_export`), and the encoder after it needs those threads.
    fn borrow_export_audio(self: &Arc<Self>, plan: u32) -> Result<Permit, String> {
        let claim = Claim {
            mib: EXPORT_AUDIO_MIX_MIB,
            threads: 0,
            background: false,
        };
        let id = Self::borrow_export(&mut self.state.lock().unwrap(), plan, claim).ok_or(
            "resource-capacity-exceeded: Export plan expired, too small for the audio mix, or host memory is critically low",
        )?;
        Ok(Permit {
            governor: self.clone(),
            id,
        })
    }
}

/// The export's audio mix, borrowed from its admitted plan.
pub fn export_audio(plan: u32) -> Result<Permit, String> {
    governor().borrow_export_audio(plan)
}

/// An admitted plan on the shared governor, for tests that drive production
/// code which borrows from one. Tests running alongside hold the same budget for
/// moments, so a refusal waits its turn.
#[cfg(test)]
pub(crate) fn test_export_plan(mib: u64) -> u32 {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let plan = governor().reserve_export(&[mib], false);
        if let Some(id) = plan["id"].as_u64() {
            return id as u32;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "test export plan refused: {plan}"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}
#[cfg(test)]
pub(crate) fn release_test_export_plan(id: u32) {
    governor().release(id);
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

impl Governor {
    /// An export enters while it waits for admission and leaves when it is
    /// admitted, refused or cancelled. While any waits, new background claims
    /// are refused; leaving wakes them.
    fn export_waiting(&self, entered: bool) {
        let mut s = self.state.lock().unwrap();
        if entered {
            s.export_waiting += 1;
            return;
        }
        s.export_waiting = s.export_waiting.saturating_sub(1);
        drop(s);
        self.notify_change();
    }
}

#[cfg_attr(test, allow(dead_code))] // Called through NAPI, not the Rust test binary.
#[napi]
pub fn resources_export_waiting(entered: bool) {
    governor().export_waiting(entered);
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
    /// The audio mix right after admission, while a proxy build holds the CPU
    /// a fresh claim needs: the mix borrows the plan instead of queuing, and
    /// leaves the plan's threads for the encoder after it.
    #[test]
    fn audio_mix_borrows_the_plan_while_a_derivative_holds_the_cpu() {
        let g = Arc::new(Governor::new());
        let proxy = g
            .reserve(Claim {
                mib: 128,
                threads: 1,
                background: true,
            })
            .unwrap();
        let id = plan(&g, &[512]);
        let fresh = Claim {
            mib: EXPORT_AUDIO_MIX_MIB,
            threads: 1,
            background: false,
        };
        assert!(
            g.reserve(fresh).is_none(),
            "a fresh audio claim waits behind the proxy"
        );
        let audio = g.borrow_export_audio(id).unwrap();
        assert_eq!(
            g.snapshot().reserved_mib,
            128 + 512,
            "the mix is charged inside the plan"
        );
        assert_eq!(g.snapshot().cpu_threads, 2);
        drop(audio);
        let encoder = g
            .reserve_for(
                Claim {
                    mib: 300,
                    threads: 1,
                    background: false,
                },
                Some(id),
            )
            .expect("the encoder still borrows the plan's thread");
        g.release(encoder);
        g.release(id);
        g.release(proxy);
        assert_eq!(g.snapshot().active, 0);
        assert!(
            g.borrow_export_audio(id).is_err(),
            "a released plan lends nothing"
        );
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
    async fn a_blocked_plan_names_what_holds_the_budget() {
        let g = Governor::new();
        let proxy = held_by(Holder::media("proxy", "m-1"), g.acquire(true, 900))
            .await
            .unwrap();
        let blocked = g.reserve_export(&[800], false);
        assert_eq!(blocked["kind"], "blocked");
        assert_eq!(
            blocked["holders"],
            serde_json::json!([{ "kind": "proxy", "media_id": "m-1", "mib": 900, "threads": 1 }])
        );
        drop(proxy);
        let id = plan(&g, &[800]);
        assert_eq!(g.snapshot().holders[0].holder, Holder::new("export"));
        g.release(id);
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
        let finish = tokio::spawn(async move { authority.acquire_finalization(id, |_| {}).await });
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
    #[tokio::test]
    async fn a_queued_export_holds_back_new_background_work_until_it_leaves() {
        let g = Governor::new();
        g.configure(Limits {
            cpu_threads: 4,
            background_jobs: 4,
            ..Limits::default()
        })
        .unwrap();
        let proxy = g.acquire(true, 900).await.unwrap();
        assert_eq!(g.reserve_export(&[800], false)["kind"], "blocked");
        g.export_waiting(true);
        let background = Claim {
            threads: 1,
            mib: 64,
            background: true,
        };
        // It fits the ledger, but a queued export goes first. The running
        // proxy keeps its lease; interactive work is unaffected.
        assert!(g.reserve(background).is_none());
        let interactive = g
            .reserve(Claim {
                background: false,
                ..background
            })
            .unwrap();
        g.release(interactive);
        let authority = g.clone();
        let queued = tokio::spawn(async move { authority.acquire(true, 64).await });
        tokio::task::yield_now().await;
        assert!(!queued.is_finished());
        assert_eq!(g.snapshot().active, 1, "the proxy still holds its lease");
        g.export_waiting(false);
        let admitted = tokio::time::timeout(std::time::Duration::from_secs(1), queued)
            .await
            .expect("leaving wakes queued background work")
            .unwrap()
            .unwrap();
        drop(admitted);
        drop(proxy);
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
