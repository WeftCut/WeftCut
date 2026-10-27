//! Opt-in tests at real OpenAI-compatible servers (#69): whisper.cpp's
//! `whisper-server` for transcription and llama.cpp's `llama-server` for
//! description, both started here as children of the test (`kill_on_drop`), so
//! nothing outlives a run. Inputs are synthetic: a speech WAV the caller renders
//! (any TTS) and a generated video, never project media.
//!
//! Environment (all paths):
//! - `WEFTCUT_WHISPER_SERVER`, `WEFTCUT_WHISPER_MODEL`, `WEFTCUT_SPEECH_SHORT_WAV`
//!   (under ten minutes) and `WEFTCUT_SPEECH_LONG_WAV` (over ten minutes); both
//!   WAVs end on a sentence containing "pineapple".
//! - `WEFTCUT_LLAMA_SERVER`, `WEFTCUT_VLM_MODEL`, `WEFTCUT_VLM_MMPROJ`,
//!   `WEFTCUT_SCENES_MP4`.
//!
//! `WEFTCUT_SCENES_MP4` shows four 16 s scenes reading APPLE, BICYCLE, CASTLE
//! and DOLPHIN.
//!
//! Run with `cargo test --lib --features test-noop -- --ignored live_endpoint`.
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::compute_jobs::ModelPhase;

fn installed(name: &str) -> PathBuf {
    std::env::var_os(name)
        .unwrap_or_else(|| panic!("set {name}"))
        .into()
}

/// A real machine's admission limits, through the same entry point the app's
/// resource settings use: the defaults of a bare test process (1 GiB of working
/// memory) refuse any local model before it starts.
pub(crate) fn generous_limits() {
    crate::resources::resources_configure(
        serde_json::json!({
            "cpu_threads": 12,
            "task_threads": 6,
            "background_jobs": 2,
            "work_mib": 16_000,
            "disk_cache_mib": 2048,
            "background_playback": false,
        })
        .to_string(),
    )
    .expect("limits");
}

/// Start `program` and wait until `ready_url` answers 200 (llama-server says 503
/// while it loads). The child dies with the returned handle.
async fn serve(
    program: PathBuf,
    args: &[String],
    ready_url: &str,
    within: Duration,
) -> tokio::process::Child {
    let child = tokio::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn server");
    let started = Instant::now();
    loop {
        let up = crate::inference::http::shared_client()
            .get(ready_url)
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success());
        if up {
            return child;
        }
        assert!(
            started.elapsed() < within,
            "{ready_url} not ready within {within:?}"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// llama-server with the vision model on `port`, ready to answer.
async fn llama_server(port: u16) -> tokio::process::Child {
    let args = [
        "-m".to_string(),
        installed("WEFTCUT_VLM_MODEL").display().to_string(),
        "--mmproj".into(),
        installed("WEFTCUT_VLM_MMPROJ").display().to_string(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
        "-c".into(),
        "16384".into(),
    ];
    serve(
        installed("WEFTCUT_LLAMA_SERVER"),
        &args,
        &format!("http://127.0.0.1:{port}/health"),
        Duration::from_secs(600),
    )
    .await
}

#[tokio::test]
#[ignore = "whisper-server, a whisper model and speech WAVs required"]
async fn live_endpoint_whisper_server_transcribes_short_and_long_audio() {
    use crate::speech::{
        backends::endpoint::OpenAiCompatTranscriber, split::transcribe_network,
        transcriber::TranscribeRequest,
    };
    let args = [
        "-m".to_string(),
        installed("WEFTCUT_WHISPER_MODEL").display().to_string(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        "18080".into(),
        "--inference-path".into(),
        "/v1/audio/transcriptions".into(),
        "-t".into(),
        "6".into(),
    ];
    let _server = serve(
        installed("WEFTCUT_WHISPER_SERVER"),
        &args,
        "http://127.0.0.1:18080/",
        Duration::from_secs(120),
    )
    .await;
    let engine = OpenAiCompatTranscriber::new(
        "http://127.0.0.1:18080/v1/audio/transcriptions".into(),
        None,
        None,
        None,
    );

    for (var, min_pieces) in [
        ("WEFTCUT_SPEECH_SHORT_WAV", 1),
        ("WEFTCUT_SPEECH_LONG_WAV", 2),
    ] {
        let phases = Mutex::new(Vec::new());
        let observe = |p: ModelPhase| phases.lock().unwrap().push(p);
        let started = Instant::now();
        let transcript = transcribe_network(
            &engine,
            TranscribeRequest {
                audio_path: installed(var),
                language: Some("en".into()),
                want_word_timing: true,
            },
            &observe,
        )
        .await
        .unwrap_or_else(|e| panic!("{var}: {e}"));
        let text: String = transcript
            .segments
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let last = transcript.segments.last().expect("segments");
        println!(
            "{var}: {} segments in {:?}, word_timing {:?}, language {:?}, last [{} .. {}] {:?}, phases {:?}",
            transcript.segments.len(),
            started.elapsed(),
            transcript.word_timing,
            transcript.language,
            last.t_start_us,
            last.t_end_us,
            last.text,
            phases.lock().unwrap(),
        );
        assert!(
            text.to_lowercase().contains("pineapple"),
            "{var}: the closing sentence must be transcribed: {text}"
        );
        // Times are on the whole WAV's clock and never run backwards.
        for pair in transcript.segments.windows(2) {
            assert!(pair[1].t_start_us >= pair[0].t_start_us, "{var}: order");
        }
        let pieces = phases
            .lock()
            .unwrap()
            .iter()
            .filter(|p| matches!(p, ModelPhase::Inferring { done: Some(_), .. }))
            .count()
            .max(1);
        assert!(pieces >= min_pieces, "{var}: {pieces} pieces");
        if min_pieces > 1 {
            // The closing sentence sits after the first cut: shifted, not
            // restarted at zero.
            let closing = transcript
                .segments
                .iter()
                .find(|s| s.text.to_lowercase().contains("pineapple"))
                .unwrap();
            assert!(
                closing.t_start_us > 600_000_000,
                "{var}: closing sentence at {} us",
                closing.t_start_us
            );
        }
    }
}

#[tokio::test]
#[ignore = "llama-server, a vision model + projector and a test video required"]
async fn live_endpoint_llama_server_describes_jpeg_frames_and_honors_timeout() {
    use crate::vlm::{
        describer::{DescribeRequest, Focus, Language, SceneDescriber},
        endpoint::OpenAiCompatDescriber,
        frame_extract::{plan_anchors, sample_frames},
        parser::parse_raw,
        VlmBackend, VlmError,
    };
    generous_limits();
    let _server = llama_server(18081).await;

    let dir = tempfile::tempdir().unwrap();
    let anchors = plan_anchors(0, 16_000_000, 1.0);
    let frames = sample_frames(
        &installed("WEFTCUT_SCENES_MP4"),
        0,
        dir.path(),
        &anchors,
        |_| {},
        |_| {},
    )
    .await
    .expect("sample frames");
    assert!(frames
        .iter()
        .all(|f| f.path.extension().is_some_and(|e| e == "jpg")));
    let request = || DescribeRequest {
        frames: frames.clone(),
        focus: Focus::General,
        language: Language::default(),
    };
    let url = "http://127.0.0.1:18081/v1/chat/completions".to_string();

    // A ceiling the server cannot meet names itself.
    let hurried = OpenAiCompatDescriber::new(
        url.clone(),
        None,
        "qwen3-vl".into(),
        VlmBackend::ByoEndpoint,
        Some(Duration::from_secs(1)),
    );
    match hurried.describe(request()).await {
        Err(VlmError::EndpointTimeout { secs: 1, .. }) => {}
        Err(other) => panic!("expected the 1 s endpoint timeout, got {other}"),
        Ok(_) => panic!("a 16-frame request cannot finish within 1 s"),
    }

    let patient =
        OpenAiCompatDescriber::new(url, None, "qwen3-vl".into(), VlmBackend::ByoEndpoint, None);
    let started = Instant::now();
    let raw = patient.describe(request()).await.expect("describe");
    let segments = parse_raw(raw).expect("parse");
    println!("{} segments in {:?}", segments.len(), started.elapsed());
    for s in &segments {
        println!(
            "  [{} .. {}] {} {:?}",
            s.t_start_us, s.t_end_us, s.text, s.tags
        );
    }
    assert!(!segments.is_empty());
    let all = segments
        .iter()
        .map(|s| format!("{} {}", s.text, s.tags.join(" ")))
        .collect::<String>()
        .to_lowercase();
    assert!(
        all.contains("apple") || all.contains("red"),
        "the first scene reads APPLE on red: {all}"
    );
}

/// `describe_clip` end to end over a 64 s video of four 16 s scenes: at 1 fps
/// and 16 frames a request it takes four requests, two in flight, and each
/// chunk's prose lands on its own scene. A second call is a cache hit.
#[cfg(feature = "mcp")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "llama-server, a vision model + projector and a four-scene test video required"]
async fn live_endpoint_describe_clip_chunks_a_long_window() {
    generous_limits();
    let _server = llama_server(18082).await;
    describe_four_scenes(
        "byo_endpoint",
        serde_json::json!({
            "kind": "endpoint", "url": "http://127.0.0.1:18082/v1/chat/completions",
            "model": "qwen3-vl", "frames_per_request": 16, "concurrency": 2,
        }),
    )
    .await;
}

/// The same four scenes through the local sidecar: one 16-frame chunk at a
/// time, the model loaded per chunk.
#[cfg(feature = "mcp")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "llama-mtmd-cli, a vision model + projector and a four-scene test video required"]
async fn live_local_describe_clip_chunks_a_long_window() {
    generous_limits();
    describe_four_scenes(
        "qwen3_vl",
        serde_json::json!({
            "kind": "local",
            "binary": installed("WEFTCUT_VLM_CLI"),
            "model": installed("WEFTCUT_VLM_MODEL"),
            "mmproj": installed("WEFTCUT_VLM_MMPROJ"),
        }),
    )
    .await;
}

/// Describe `WEFTCUT_SCENES_MP4` whole through `backend`, then assert each 16 s
/// scene got its own prose and that the same call again is a cache hit.
#[cfg(feature = "mcp")]
async fn describe_four_scenes(backend_tag: &str, backend_config: serde_json::Value) {
    use crate::state::{
        new_id, DecodeRoute, Layer, LayerParams, MediaItem, MediaKind, MediaMetadata,
        VideoClipParams,
    };
    let source_us = 64_000_000;
    let media = MediaItem {
        id: new_id(),
        label: None,
        path_abs: installed("WEFTCUT_SCENES_MP4"),
        path_rel: None,
        kind: MediaKind::Video,
        metadata: MediaMetadata {
            duration_us: Some(source_us),
            ..Default::default()
        },
        decode_route: DecodeRoute::Bypass,
        waveform_path: None,
        conform_path: None,
        thumbnails_dir: None,
        file_hash_blake3: new_id().to_string(),
        file_size: 0,
        file_mtime: 0,
        imported_at: chrono::Utc::now(),
    };
    let layer = Layer {
        id: new_id(),
        label: None,
        t_start_us: 0,
        t_end_us: source_us,
        enabled: true,
        locked: false,
        metadata: Default::default(),
        params: LayerParams::VideoClip(VideoClipParams {
            timing: Default::default(),
            media: media.id,
            src_in_us: 0,
            src_out_us: source_us,
            transform: Default::default(),
            opacity: Default::default(),
            crop: None,
            flip_h: false,
            flip_v: false,
            blend_mode: Default::default(),
            fade_in_us: 0,
            fade_out_us: 0,
        }),
        effects: Vec::new(),
    };
    let backend = crate::napi_backend::Backend::new_for_test_with_sink(std::sync::Arc::new(
        crate::events::VecEventSink::new(),
    ));
    let args = serde_json::json!({
        "layer_id": layer.id.to_string(), "backend": backend_tag, "fps": 1.0,
        "layer": layer, "media": media,
        "vlm_config": { backend_tag: backend_config },
    });
    let call = || async {
        let reply: serde_json::Value = serde_json::from_str(
            &backend
                .mcp_call_tool("describe_clip".into(), args.to_string())
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(reply["ok"], true, "{reply}");
        let text = reply["result"]["content"][0]["text"].as_str().unwrap();
        serde_json::from_str::<serde_json::Value>(text).unwrap()["segments"].clone()
    };

    let started = Instant::now();
    let segments = call().await;
    println!("{backend_tag}: described 64 s in {:?}", started.elapsed());
    let segments = segments.as_array().unwrap();
    for s in segments {
        println!(
            "  [{} .. {}] {} {}",
            s["t_start_us"], s["t_end_us"], s["text"], s["tags"]
        );
    }
    for (i, word) in ["apple", "bicycle", "castle", "dolphin"].iter().enumerate() {
        let (a, b) = (i as i64 * 16_000_000, (i as i64 + 1) * 16_000_000);
        let inside: Vec<_> = segments
            .iter()
            .filter(|s| {
                s["t_start_us"].as_i64().unwrap() >= a && s["t_end_us"].as_i64().unwrap() <= b
            })
            .collect();
        assert!(!inside.is_empty(), "no segment inside scene {i} [{a}, {b}]");
        let prose = inside
            .iter()
            .map(|s| format!("{} {}", s["text"], s["tags"]))
            .collect::<String>()
            .to_lowercase();
        assert!(
            prose.contains(word),
            "scene {i} should read {word}: {prose}"
        );
    }

    let started = Instant::now();
    let again = call().await;
    assert_eq!(&again.as_array().unwrap()[..], segments, "cache hit");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "a cache hit sends nothing"
    );
}
