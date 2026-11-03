use super::*;
use crate::events::VecEventSink;
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};
use vlm::{parser::RawDescription, DescribeRequest, DescriptionPurpose, Focus, Language, Task};

#[derive(Default)]
struct Frames(Mutex<Vec<Vec<i64>>>);

#[async_trait::async_trait]
impl FrameSampler for Frames {
    async fn sample(
        &self,
        _: &Path,
        start: i64,
        dest: &Path,
        anchors: &[i64],
        _: Option<(&JobReporter, u32, u32)>,
    ) -> Result<Vec<TimedFrame>, VlmError> {
        self.0
            .lock()
            .unwrap()
            .push(anchors.iter().map(|t| start + t).collect());
        Ok(anchors
            .iter()
            .map(|&t_us| TimedFrame {
                t_us,
                path: dest.join("frame.jpg"),
            })
            .collect())
    }
}

enum Reply {
    Timeline(&'static str),
    Summary(&'static str),
    Fail,
    Hold,
}

#[derive(Default)]
struct Script {
    replies: Mutex<VecDeque<Reply>>,
    calls: Mutex<Vec<DescribeRequest>>,
    entered: tokio::sync::Notify,
    dropped: AtomicUsize,
}

struct DropCount<'a>(&'a AtomicUsize);
impl Drop for DropCount<'_> {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[async_trait::async_trait]
impl SceneDescriber for Arc<Script> {
    async fn describe(&self, req: DescribeRequest) -> Result<RawDescription, VlmError> {
        let reply = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected inference");
        self.calls.lock().unwrap().push(req.clone());
        match reply {
            Reply::Timeline(text) => {
                assert!(matches!(req.task, Task::Timeline));
                Ok(RawDescription::JsonArray(
                    serde_json::json!([
                        { "t_start": 0, "t_end": 2, "text": text, "tags": [] }
                    ])
                    .to_string(),
                ))
            }
            Reply::Summary(text) => {
                assert!(matches!(req.task, Task::Summary { .. }));
                Ok(RawDescription::JsonArray(
                    serde_json::json!({ "summary": text }).to_string(),
                ))
            }
            Reply::Fail => Err(VlmError::Parse("refused".into())),
            Reply::Hold => {
                let _drop = DropCount(&self.dropped);
                self.entered.notify_one();
                std::future::pending().await
            }
        }
    }
}

fn request() -> DescriptionRequest {
    DescriptionRequest {
        source: "synthetic.mp4".into(),
        source_hash: "synthetic".into(),
        window: [0, 8_000_000],
        fps: 1.0,
        focus: Focus::General,
        language: Language::default(),
        purpose: DescriptionPurpose::Clip,
        refresh: false,
    }
}

fn runner(
    dir: &Path,
    describer: Box<dyn SceneDescriber>,
    concurrency: u32,
) -> (DescriptionRunner, Arc<Frames>, JobReporter) {
    let config = BackendConfig::Endpoint {
        url: "http://test.invalid".into(),
        api_key: None,
        model: Some("test".into()),
        timeout_s: None,
        frames_per_request: Some(2),
        concurrency: Some(concurrency),
    };
    let mut runner = DescriptionRunner::new(
        &CacheLayout::new(dir.into()),
        VlmBackend::ByoEndpoint,
        Some(&config),
        describer,
    );
    let frames = Arc::new(Frames::default());
    runner.sampler = frames.clone();
    (
        runner,
        frames,
        JobReporter::new(Arc::new(VecEventSink::new()), Some("test".into())),
    )
}

fn script(replies: impl IntoIterator<Item = Reply>) -> Arc<Script> {
    Arc::new(Script {
        replies: Mutex::new(replies.into_iter().collect()),
        ..Script::default()
    })
}

#[tokio::test]
async fn resumes_persisted_chunks_refreshes_and_retries_only_a_missing_summary() {
    use Reply::*;
    let dir = tempfile::tempdir().unwrap();
    let engine = script([
        Timeline("forest"),
        Timeline("city"),
        Fail,
        Timeline("ocean"),
        Timeline("stars"),
        Summary("four scenes"),
        Timeline("woods"),
        Timeline("town"),
        Timeline("sea"),
        Timeline("sky"),
        Fail,
        Summary("refreshed"),
    ]);
    {
        let (runner, _, job) = runner(dir.path(), Box::new(engine.clone()), 1);
        assert!(runner.describe(request(), &job).await.is_err());
        assert_eq!(engine.calls.lock().unwrap().len(), 3);
    }
    // A fresh runner proves the resume state lives on disk, not in memory.
    let (runner, frames, job) = runner(dir.path(), Box::new(engine.clone()), 1);
    let resumed = runner.describe(request(), &job).await.unwrap();
    assert_eq!(resumed.summary.as_deref(), Some("four scenes"));
    assert_eq!(
        resumed
            .segments
            .iter()
            .map(|s| (s.src_start_us, s.src_end_us, s.text.as_str()))
            .collect::<Vec<_>>(),
        [
            (0, 2_000_000, "forest"),
            (2_000_000, 4_000_000, "city"),
            (4_000_000, 6_000_000, "ocean"),
            (6_000_000, 8_000_000, "stars")
        ]
    );
    assert_eq!(frames.0.lock().unwrap()[0], [4_500_000, 5_500_000]);
    assert_eq!(engine.calls.lock().unwrap().len(), 6);
    let sub = runner
        .describe(
            DescriptionRequest {
                window: [2_000_000, 4_000_000],
                ..request()
            },
            &job,
        )
        .await
        .unwrap();
    assert_eq!(sub.summary, None);
    assert_eq!(sub.segments[0].text, "city");
    assert_eq!(engine.calls.lock().unwrap().len(), 6);
    let refreshed = runner
        .describe(
            DescriptionRequest {
                refresh: true,
                ..request()
            },
            &job,
        )
        .await
        .unwrap();
    assert_eq!(refreshed.summary, None);
    assert_eq!(refreshed.segments[0].text, "woods");
    assert_eq!(engine.calls.lock().unwrap().len(), 11);
    assert_eq!(
        runner
            .describe(request(), &job)
            .await
            .unwrap()
            .summary
            .as_deref(),
        Some("refreshed")
    );
    assert_eq!(engine.calls.lock().unwrap().len(), 12);
    runner.describe(request(), &job).await.unwrap();
    assert_eq!(engine.calls.lock().unwrap().len(), 12);
}

#[tokio::test]
async fn cancellation_drops_inference_and_resumes_after_the_last_saved_chunk() {
    let dir = tempfile::tempdir().unwrap();
    let engine = script([
        Reply::Timeline("forest"),
        Reply::Hold,
        Reply::Timeline("city"),
        Reply::Timeline("ocean"),
        Reply::Timeline("stars"),
        Reply::Summary("done"),
    ]);
    let (runner, frames, job) = runner(dir.path(), Box::new(engine.clone()), 1);
    {
        let work = runner.describe(request(), &job);
        tokio::pin!(work);
        tokio::select! {
            result = &mut work => panic!("completed before cancellation: {result:?}"),
            _ = engine.entered.notified() => {},
            _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => panic!("engine never entered"),
        }
    }
    assert_eq!(engine.dropped.load(Ordering::SeqCst), 1);
    frames.0.lock().unwrap().clear();
    let result = runner.describe(request(), &job).await.unwrap();
    assert_eq!(result.segments[0].text, "forest");
    assert_eq!(frames.0.lock().unwrap()[0], [2_500_000, 3_500_000]);
}

struct Concurrent {
    barrier: tokio::sync::Barrier,
    active: AtomicUsize,
    peak: AtomicUsize,
}
#[async_trait::async_trait]
impl SceneDescriber for Arc<Concurrent> {
    async fn describe(&self, req: DescribeRequest) -> Result<RawDescription, VlmError> {
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(active, Ordering::SeqCst);
        self.barrier.wait().await;
        self.active.fetch_sub(1, Ordering::SeqCst);
        assert_eq!(req.frames.len(), 2);
        Ok(RawDescription::JsonArray(
            r#"[{"t_start":-1,"t_end":9,"text":"scene","tags":[]}]"#.into(),
        ))
    }
}

#[tokio::test]
async fn chunks_run_concurrently_and_remain_on_their_own_source_windows() {
    let dir = tempfile::tempdir().unwrap();
    let engine = Arc::new(Concurrent {
        barrier: tokio::sync::Barrier::new(2),
        active: AtomicUsize::new(0),
        peak: AtomicUsize::new(0),
    });
    let (runner, frames, job) = runner(dir.path(), Box::new(engine.clone()), 2);
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        runner.describe(
            DescriptionRequest {
                window: [10_000_000, 18_000_000],
                purpose: DescriptionPurpose::Shot,
                ..request()
            },
            &job,
        ),
    )
    .await
    .expect("chunks must overlap")
    .unwrap();
    assert_eq!(engine.peak.load(Ordering::SeqCst), 2);
    assert_eq!(frames.0.lock().unwrap().len(), 4);
    assert_eq!(result.summary, None);
    assert_eq!(result.segments.first().unwrap().src_start_us, 10_000_000);
    assert_eq!(result.segments.last().unwrap().src_end_us, 18_000_000);
}

#[tokio::test]
async fn invalid_density_and_oversized_windows_do_no_sampling_or_inference() {
    let dir = tempfile::tempdir().unwrap();
    let engine = script([]);
    let (runner, frames, job) = runner(dir.path(), Box::new(engine.clone()), 1);
    for req in [
        DescriptionRequest {
            fps: f64::NAN,
            ..request()
        },
        DescriptionRequest {
            window: [0, 4_000_000_000],
            ..request()
        },
    ] {
        assert!(matches!(
            runner.describe(req, &job).await,
            Err(DescriptionError::InvalidArgument(_))
        ));
    }
    assert!(frames.0.lock().unwrap().is_empty());
    assert!(engine.calls.lock().unwrap().is_empty());
}

/// Answers every chunk, holding the second until `release`; says when it got there.
#[derive(Default)]
struct Gated {
    calls: AtomicUsize,
    second: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

#[async_trait::async_trait]
impl SceneDescriber for Arc<Gated> {
    async fn describe(&self, _: DescribeRequest) -> Result<RawDescription, VlmError> {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 1 {
            self.second.notify_one();
            self.release.notified().await;
        }
        Ok(RawDescription::JsonArray(
            serde_json::json!([{ "t_start": 0, "t_end": 2, "text": "scene", "tags": [] }])
                .to_string(),
        ))
    }
}

#[tokio::test]
async fn concurrent_calls_over_other_windows_of_one_source_keep_each_others_runs() {
    let dir = tempfile::tempdir().unwrap();
    let shot = |window| DescriptionRequest {
        window,
        purpose: DescriptionPurpose::Shot,
        ..request()
    };
    let gated = Arc::new(Gated::default());
    let (first, _, first_job) = runner(dir.path(), Box::new(gated.clone()), 1);
    let (second, _, second_job) = runner(dir.path(), Box::new(script([Reply::Timeline("b")])), 1);
    // The first call has persisted its first chunk and holds the rest while the
    // second describes another window of the same source and view.
    let (a, b) = tokio::join!(first.describe(shot([0, 4_000_000]), &first_job), async {
        gated.second.notified().await;
        let b = second
            .describe(shot([10_000_000, 12_000_000]), &second_job)
            .await;
        gated.release.notify_one();
        b
    });
    a.unwrap();
    b.unwrap();
    // Both windows answer from the file with no inference.
    let (reader, _, job) = runner(dir.path(), Box::new(script([])), 1);
    for window in [[0, 4_000_000], [10_000_000, 12_000_000]] {
        let held = reader.describe(shot(window), &job).await.unwrap();
        assert!(!held.segments.is_empty(), "{window:?} lost");
    }
}
