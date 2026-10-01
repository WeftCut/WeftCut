//! Opt-in tests at the real adapters, using synthetic media and installed models.
//! See docs/notes/inference-path-compatibility.md for environment and commands.
use std::path::{Path, PathBuf};

fn installed(name: &str) -> PathBuf {
    std::env::var_os(name)
        .unwrap_or_else(|| panic!("set {name}"))
        .into()
}

fn link_file(source: &Path, dest: &Path) {
    std::fs::hard_link(source, dest)
        .or_else(|_| std::fs::copy(source, dest).map(|_| ()))
        .unwrap();
}

fn runtime(source: &Path, root: &Path) -> PathBuf {
    let dest = root.join("引擎 日本語 🐱");
    std::fs::create_dir(&dest).unwrap();
    // Keep DLLs adjacent to the executable, as in the installed runtime.
    for item in std::fs::read_dir(source.parent().unwrap()).unwrap() {
        let item = item.unwrap();
        if item.file_type().unwrap().is_file() {
            link_file(&item.path(), &dest.join(item.file_name()));
        }
    }
    dest.join(source.file_name().unwrap())
}

fn fixture() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("模型, 日本語 café 🐱 ")
        .tempdir()
        .unwrap()
}

fn audio(root: &Path) -> PathBuf {
    let path = root.join("音声 & (测试).wav");
    let size = 32_000_u32;
    let mut wav = Vec::new();
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + size).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&16_000_u32.to_le_bytes());
    wav.extend_from_slice(&32_000_u32.to_le_bytes());
    wav.extend_from_slice(&2_u16.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&size.to_le_bytes());
    wav.resize(44 + size as usize, 0);
    std::fs::write(&path, wav).unwrap();
    path
}

#[tokio::test]
#[ignore = "installed whisper runtime/model required"]
async fn live_unicode_whisper_paths() {
    use crate::speech::{
        backends::whisper_cpp::WhisperCpp,
        parse::parse_raw,
        transcriber::{TranscribeRequest, Transcriber},
    };
    let dir = fixture();
    let model = dir.path().join("模型.bin");
    link_file(&installed("WEFTCUT_WHISPER_MODEL"), &model);
    let binary = runtime(&installed("WEFTCUT_WHISPER_CLI"), dir.path());
    let engine = WhisperCpp::new(binary, model, Some(4), Some("cpu".into()));
    let cache = crate::cache::CacheLayout::new(dir.path().join("项目, 缓存"));
    let extracted = crate::speech::audio_extract::extract_audio_window(
        &cache,
        &audio(dir.path()),
        "synthetic-path-regression",
        0,
        1_000_000,
    )
    .await
    .expect("ffmpeg must extract from/to Unicode project paths");
    for want_word_timing in [true, false] {
        let raw = engine
            .transcribe(TranscribeRequest {
                audio_path: extracted.clone(),
                language: Some("en".into()),
                want_word_timing,
            })
            .await
            .expect("Unicode audio/model/runtime and temporary output paths must work");
        parse_raw(raw).expect("read and parse the actual result file");
    }
}

#[tokio::test]
#[ignore = "installed sherpa runtime/model/tokens required"]
async fn live_unicode_funasr_paths() {
    use crate::speech::{
        backends::funasr::FunAsr,
        parse::parse_raw,
        transcriber::{TranscribeRequest, Transcriber},
    };
    let dir = fixture();
    let model = dir.path().join("模型.onnx");
    let tokens = dir.path().join("词表.txt");
    link_file(&installed("WEFTCUT_FUNASR_MODEL"), &model);
    link_file(&installed("WEFTCUT_FUNASR_TOKENS"), &tokens);
    let binary = runtime(&installed("WEFTCUT_FUNASR_CLI"), dir.path());
    let engine = FunAsr::new(binary, model, tokens, Some(4), Some("cpu".into()));
    let raw = engine
        .transcribe(TranscribeRequest {
            audio_path: audio(dir.path()),
            language: Some("zh".into()),
            want_word_timing: true,
        })
        .await
        .expect("Unicode audio/model/tokens/runtime paths must work");
    parse_raw(raw).expect("parse actual stdout");
}

#[tokio::test]
#[ignore = "installed llama runtime/model/projector required"]
async fn live_unicode_vlm_paths() {
    use crate::vlm::{
        describer::{DescribeRequest, Focus, Language, SceneDescriber},
        parser::parse_raw,
        sidecar::{LlamaMtmdSidecar, OutputStyle},
    };
    let dir = fixture();
    let model = dir.path().join("模型.gguf");
    let projector = dir.path().join("视觉.gguf");
    link_file(&installed("WEFTCUT_VLM_MODEL"), &model);
    link_file(&installed("WEFTCUT_VLM_MMPROJ"), &projector);
    let binary = runtime(&installed("WEFTCUT_VLM_CLI"), dir.path());
    let frame = dir.path().join("图像, 第一帧.png");
    image::RgbImage::from_pixel(64, 64, image::Rgb([40, 100, 180]))
        .save(&frame)
        .unwrap();
    let frames =
        crate::vlm::frame_extract::sample_frames(&frame, 0, &dir.path().join("抽帧, 缓存"), &[0])
            .await
            .expect("ffmpeg must sample a Unicode/comma image into a Unicode/comma directory");
    let style = match std::env::var("WEFTCUT_VLM_STYLE").as_deref() {
        Ok("minicpm") => OutputStyle::MiniCpmVText,
        Ok("qwen") | Err(_) => OutputStyle::Qwen3VlJson,
        Ok(other) => panic!("unknown WEFTCUT_VLM_STYLE: {other}"),
    };
    let engine = LlamaMtmdSidecar::new(binary, model, projector, None, style);
    let raw = engine
        .describe(DescribeRequest {
            frames,
            focus: Focus::General,
            language: Language::default(),
        })
        .await
        .expect("Unicode weights/runtime and comma-containing image paths must work");
    parse_raw(raw).expect("parse actual inference output");
}
