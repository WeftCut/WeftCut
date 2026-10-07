//! One producer per physical artifact, with a completion for every subscriber.
use super::JobKind;
use crate::{cache::CacheLayout, state::MediaItem};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

type Outcome = Result<String, String>;
#[derive(Clone, Debug, Eq, PartialEq, Hash)]
struct Key {
    root: PathBuf,
    hash: String,
    kind: String,
    version: u32,
}
struct Flight {
    outcome: tokio::sync::watch::Sender<Option<Outcome>>,
}
fn flights() -> &'static Mutex<HashMap<Key, Arc<Flight>>> {
    static MAP: OnceLock<Mutex<HashMap<Key, Arc<Flight>>>> = OnceLock::new();
    MAP.get_or_init(Default::default)
}
struct Leader {
    key: Key,
    flight: Arc<Flight>,
}
impl Drop for Leader {
    fn drop(&mut self) {
        let mut map = flights().lock().unwrap();
        if self.flight.outcome.borrow().is_none() {
            self.flight
                .outcome
                .send_replace(Some(Err("workspace cancelled".into())));
        }
        map.remove(&self.key);
    }
}
pub(super) async fn run(
    cache: &CacheLayout,
    media: &MediaItem,
    kind: JobKind,
    generate: impl std::future::Future<Output = anyhow::Result<PathBuf>>,
) -> anyhow::Result<PathBuf> {
    let version = match kind {
        JobKind::Proxy => super::proxy::PROXY_FORMAT_VERSION,
        JobKind::QuickProxy => 4,
        JobKind::Waveform => 4,
        JobKind::Conform => super::conform::CONFORM_FORMAT_VERSION,
        _ => 1,
    };
    let key = Key {
        root: cache.current_root(),
        hash: media.file_hash_blake3.clone(),
        kind: format!("{kind:?}"),
        version,
    };
    run_key(cache, key, async {
        Ok(generate.await?.to_string_lossy().into_owned())
    })
    .await
    .map(PathBuf::from)
}

pub(crate) async fn source(
    cache: &CacheLayout,
    path: &std::path::Path,
    operation: &str,
    generate: impl std::future::Future<Output = anyhow::Result<String>>,
) -> anyhow::Result<String> {
    let metadata = std::fs::metadata(path)?;
    let identity = format!(
        "{}:{}:{:?}",
        path.canonicalize()?.display(),
        metadata.len(),
        metadata.modified()?
    );
    let key = Key {
        root: cache.current_root(),
        hash: identity,
        kind: operation.to_string(),
        version: 1,
    };
    run_key(cache, key, generate).await
}

async fn run_key(
    cache: &CacheLayout,
    key: Key,
    generate: impl std::future::Future<Output = anyhow::Result<String>>,
) -> anyhow::Result<String> {
    loop {
        cache.check_active()?;
        let (flight, leader) = {
            let mut map = flights().lock().unwrap();
            if let Some(flight) = map.get(&key) {
                (flight.clone(), false)
            } else {
                let (outcome, _) = tokio::sync::watch::channel(None);
                let flight = Arc::new(Flight { outcome });
                map.insert(key.clone(), flight.clone());
                (flight, true)
            }
        };
        if leader {
            let guard = Leader {
                key: key.clone(),
                flight,
            };
            let outcome = generate.await.map_err(|error| format!("{error:#}"));
            guard.flight.outcome.send_replace(Some(outcome.clone()));
            return outcome.map_err(anyhow::Error::msg);
        }
        let mut receiver = flight.outcome.subscribe();
        let outcome = loop {
            if let Some(outcome) = receiver.borrow().clone() {
                break outcome;
            }
            tokio::select! {
                result = receiver.changed() => { result?; },
                _ = cache.cancelled() => anyhow::bail!("workspace cancelled"),
            }
        };
        // A reopened workspace may encounter a previous generation still
        // reaping its child. Wait for that producer to release the filename,
        // then take over; never delete a live producer's deterministic temp.
        if matches!(&outcome, Err(e) if e.contains("workspace cancelled")) && !cache.is_cancelled()
        {
            tokio::task::yield_now().await;
            continue;
        }
        return outcome.map_err(anyhow::Error::msg);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn same_artifact_has_one_producer_and_a_result_for_each_subscriber() {
        let dir = tempfile::tempdir().unwrap();
        let cache = CacheLayout::new(dir.path().to_path_buf());
        let key = Key {
            root: cache.current_root(),
            hash: "same-source".into(),
            kind: "conform".into(),
            version: 1,
        };
        let runs = Arc::new(AtomicUsize::new(0));
        let (release, blocked) = tokio::sync::oneshot::channel::<()>();
        let (started, pending) = tokio::sync::oneshot::channel();
        let leader_cache = cache.clone();
        let leader_key = key.clone();
        let leader_runs = runs.clone();
        let leader = tokio::spawn(async move {
            run_key(&leader_cache, leader_key, async {
                leader_runs.fetch_add(1, Ordering::SeqCst);
                started.send(()).unwrap();
                blocked.await.unwrap();
                Ok("artifact".into())
            })
            .await
            .unwrap()
        });
        pending.await.unwrap();
        let mut subscribers = Vec::new();
        for _ in 0..20 {
            let cache = cache.clone();
            let key = key.clone();
            let runs = runs.clone();
            subscribers.push(tokio::spawn(async move {
                run_key(&cache, key, async {
                    runs.fetch_add(1, Ordering::SeqCst);
                    Ok("duplicate".into())
                })
                .await
                .unwrap()
            }));
        }
        // Every subscriber is registered before the producer is released.
        loop {
            if flights()
                .lock()
                .unwrap()
                .get(&key)
                .unwrap()
                .outcome
                .receiver_count()
                == 20
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        release.send(()).unwrap();
        assert_eq!(leader.await.unwrap(), "artifact");
        for subscriber in subscribers {
            assert_eq!(subscriber.await.unwrap(), "artifact");
        }
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        assert!(!flights().lock().unwrap().contains_key(&key));
    }

    #[tokio::test]
    async fn reopened_generation_waits_for_old_producer_teardown_then_retries() {
        let dir = tempfile::tempdir().unwrap();
        let owner = CacheLayout::new(dir.path().join("Cache"));
        let old = owner.clone();
        let key = Key {
            root: old.current_root(),
            hash: "same-source".into(),
            kind: "proxy".into(),
            version: 1,
        };
        let (started, pending) = tokio::sync::oneshot::channel();
        let (finish, teardown) = tokio::sync::oneshot::channel();
        let old_key = key.clone();
        let producer = tokio::spawn(async move {
            run_key(&old, old_key, async {
                started.send(()).unwrap();
                old.cancelled().await;
                teardown.await.unwrap();
                anyhow::bail!("workspace cancelled")
            })
            .await
        });
        pending.await.unwrap();
        owner.set_workspace(dir.path()).unwrap();
        let cache = owner.clone();
        let rebuilt = Arc::new(AtomicUsize::new(0));
        let runs = rebuilt.clone();
        let retry_key = key.clone();
        let retry = tokio::spawn(async move {
            run_key(&cache, retry_key, async {
                runs.fetch_add(1, Ordering::SeqCst);
                Ok("new".into())
            })
            .await
        });
        loop {
            if flights()
                .lock()
                .unwrap()
                .get(&key)
                .unwrap()
                .outcome
                .receiver_count()
                == 1
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(rebuilt.load(Ordering::SeqCst), 0);
        finish.send(()).unwrap();
        assert!(producer.await.unwrap().is_err());
        assert_eq!(retry.await.unwrap().unwrap(), "new");
        assert_eq!(rebuilt.load(Ordering::SeqCst), 1);
    }
}
