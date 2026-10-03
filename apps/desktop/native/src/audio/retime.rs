//! Shared preview/export renderer. Every scope stretches once. Child role stems
//! are mixed before a Group's pitch policy is applied; role gain stays outside.
use super::{
    conform_reader::ConformReader,
    envelope::{sample_gain, sample_pan, Envelope},
    mix::{mix_block, us_to_frame, MixLayer, MixPlan, MIX_BLOCK_FRAMES},
};
use crate::state::audio_role::AudioRole;
use crate::state::timing::TimingFields;
use crate::state::{LayerParams, Project};
use anyhow::{Context, Result};
use std::{
    collections::HashMap,
    future::Future,
    io::Write,
    path::{Path, PathBuf},
    pin::Pin,
    sync::OnceLock,
};
use uuid::Uuid;

#[derive(Clone, serde::Serialize)]
pub struct Stem {
    pub role: AudioRole,
    pub path: PathBuf,
    pub duration_us: i64,
}

pub fn needed(project: &Project) -> bool {
    project.compositions.values().any(|c| {
        c.tracks.iter().any(|t| {
            t.layers.iter().any(|l| match &l.params {
                LayerParams::Audio(p) => p.timing.rate() != 1.0 || p.timing.source_phase.is_some(),
                LayerParams::CompositionRef(p) => {
                    p.timing.rate() != 1.0 || p.timing.source_phase.is_some()
                }
                _ => false,
            })
        })
    })
}

fn digest<T: serde::Serialize>(value: &T) -> Result<String> {
    Ok(blake3::hash(&serde_json::to_vec(value)?)
        .to_hex()
        .to_string())
}

/// Keep each atempo stage within [0.5, 2], including extreme legal rates.
fn rate_filter(mut rate: f64, pitch: bool) -> Result<String> {
    anyhow::ensure!(rate.is_finite() && rate > 0.0, "invalid audio rate");
    if rate == 1.0 {
        return Ok("anull".into());
    }
    if !pitch {
        // asetrate accepts integer Hz; compensate its rounding with atempo so
        // duration still follows the authored exact rate.
        let hz = (48_000.0 * rate).round().clamp(1.0, i32::MAX as f64);
        let remainder = rate / (hz / 48_000.0);
        return Ok(format!(
            "asetrate={hz},aresample=48000,{}",
            rate_filter(remainder, true)?
        ));
    }
    let mut filters = Vec::new();
    while rate > 2.0 {
        filters.push("atempo=2".to_owned());
        rate /= 2.0;
    }
    while rate < 0.5 {
        filters.push("atempo=0.5".to_owned());
        rate *= 2.0;
    }
    filters.push(format!("atempo={rate:.17}"));
    Ok(filters.join(","))
}

async fn stretch(
    source: &Path,
    timing: &TimingFields,
    src_in: i64,
    src_out: i64,
    duration: i64,
    dir: &Path,
) -> Result<PathBuf> {
    stretch_window(
        source,
        timing,
        timing.content_time(src_in, 0.0),
        timing.source_end(src_out),
        duration,
        dir,
    )
    .await
}

async fn stretch_window(
    source: &Path,
    timing: &TimingFields,
    start_us: f64,
    end_us: f64,
    duration: i64,
    dir: &Path,
) -> Result<PathBuf> {
    let frames = us_to_frame(duration).max(0) as u64;
    let start = start_us / 1e6;
    let end = end_us / 1e6;
    let graph = format!("[0:a]atrim=start={start:.17}:end={end:.17},asetpts=PTS-STARTPTS,{},apad=whole_len={frames},atrim=end_sample={frames}[out]", rate_filter(timing.rate(), timing.preserve_pitch != Some(false))?);
    let dest = dir.join(format!("retime-{}.vconf", digest(&(2, source, &graph))?));
    if !crate::cache::cached_ok(&dest) {
        let header = crate::jobs::conform::read_header(source)?;
        if start * 48_000.0 >= header.frame_count as f64 {
            // Legal Group overhangs can cover no child samples at all.
            let empty = MixPlan {
                window_start_frame: 0,
                window_end_frame: frames as i64,
                layers: Vec::new(),
            };
            let target = dest.clone();
            tokio::task::spawn_blocking(move || write_mix(empty, &target)).await??;
        } else {
            super::fx::render(source, &graph, &dest, Some(frames)).await?;
        }
    }
    Ok(dest)
}

fn write_mix(plan: MixPlan, dest: &Path) -> Result<()> {
    use crate::jobs::conform::{CONFORM_FORMAT_VERSION, CONFORM_SAMPLE_RATE, MAGIC};
    let tmp = crate::cache::claim_temp(dest)?;
    let result = (|| -> Result<()> {
        let mut f = std::io::BufWriter::new(std::fs::File::create(&tmp)?);
        f.write_all(MAGIC)?;
        f.write_all(&CONFORM_FORMAT_VERSION.to_le_bytes())?;
        f.write_all(&CONFORM_SAMPLE_RATE.to_le_bytes())?;
        f.write_all(&2u32.to_le_bytes())?;
        f.write_all(&(plan.window_end_frame as u64).to_le_bytes())?;
        let mut readers = plan
            .layers
            .iter()
            .map(|l| ConformReader::open(&l.conform_path))
            .collect::<Result<Vec<_>>>()?;
        let mut at = 0;
        while at < plan.window_end_frame {
            let n = MIX_BLOCK_FRAMES.min((plan.window_end_frame - at) as usize);
            let mut samples = vec![0.0; n * 2];
            mix_block(&plan, &mut readers, at, n, &mut samples)?;
            for s in samples {
                f.write_all(&s.to_le_bytes())?;
            }
            at += n as i64;
        }
        f.flush()?;
        drop(f);
        crate::cache::promote_temp(dest)?;
        Ok(())
    })();
    if result.is_err() {
        crate::cache::discard_temp(dest);
    }
    result
}

fn composition<'a>(
    project: &'a Project,
    id: Uuid,
    overrides: &'a HashMap<Uuid, PathBuf>,
    dir: &'a Path,
    signature: &'a str,
    depth: usize,
) -> Pin<Box<dyn Future<Output = Result<Vec<Stem>>> + Send + 'a>> {
    Box::pin(async move {
        anyhow::ensure!(depth <= 32, "audio composition nesting exceeds 32");
        let comp = project
            .composition(&id)
            .context("audio composition missing")?;
        let mut roles: HashMap<AudioRole, Vec<MixLayer>> = HashMap::new();
        for track in comp.tracks.iter().filter(|t| t.enabled) {
            for layer in track.layers.iter().filter(|l| l.enabled) {
                let duration = layer.t_end_us - layer.t_start_us;
                match &layer.params {
                    LayerParams::Audio(p)
                        if !layer.locked
                            && !p.mute
                            && super::mix::role_audible(
                                &project.role_mix(p.role),
                                super::mix::any_role_solo(project.audio_roles.values()),
                            ) =>
                    {
                        let media = project
                            .media_pool
                            .get(&p.media)
                            .context("audio media missing")?;
                        let source = overrides
                            .get(&layer.id)
                            .or(media.conform_path.as_ref())
                            .context("audio conform or effect bake not ready")?;
                        let path =
                            stretch(source, &p.timing, p.src_in_us, p.src_out_us, duration, dir)
                                .await?;
                        roles.entry(p.role).or_default().push(MixLayer {
                            label: layer.id.to_string(),
                            conform_path: path,
                            start_frame: us_to_frame(layer.t_start_us),
                            src_in_frame: 0,
                            src_out_frame: us_to_frame(duration),
                            head_frame: 0,
                            gain: sample_gain(
                                &p.gain_db,
                                p.fade_in_us as i64,
                                p.fade_out_us as i64,
                                duration,
                            ),
                            pan: sample_pan(&p.pan, duration),
                        });
                    }
                    LayerParams::CompositionRef(p) => {
                        for child in composition(
                            project,
                            p.composition,
                            overrides,
                            dir,
                            signature,
                            depth + 1,
                        )
                        .await?
                        {
                            let path = stretch_window(
                                &child.path,
                                &p.timing,
                                p.timing.content_time(p.src_in_us, 0.0),
                                p.timing.content_time(p.src_in_us, duration as f64),
                                duration,
                                dir,
                            )
                            .await?;
                            roles.entry(child.role).or_default().push(MixLayer {
                                label: layer.id.to_string(),
                                conform_path: path,
                                start_frame: us_to_frame(layer.t_start_us),
                                src_in_frame: 0,
                                src_out_frame: us_to_frame(duration),
                                head_frame: 0,
                                gain: Envelope::constant(1.0, duration),
                                pan: Envelope::constant(0.0, duration),
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
        let mut stems = Vec::new();
        for role in AudioRole::ALL {
            let Some(layers) = roles.remove(&role) else {
                continue;
            };
            let path = dir.join(format!("retime-{signature}-{id}-{}.vconf", role.as_str()));
            if !crate::cache::cached_ok(&path) {
                let plan = MixPlan {
                    window_start_frame: 0,
                    window_end_frame: us_to_frame(comp.duration_us),
                    layers,
                };
                let dest = path.clone();
                tokio::task::spawn_blocking(move || write_mix(plan, &dest)).await??;
            }
            stems.push(Stem {
                role,
                path,
                duration_us: comp.duration_us,
            });
        }
        Ok(stems)
    })
}

pub async fn prepare(
    project: &Project,
    id: Uuid,
    overrides: &HashMap<Uuid, PathBuf>,
) -> Result<Vec<Stem>> {
    // Concurrent preview/export requests share immutable files. Serialize cache
    // publication; a cancelled request releases this lock and ffmpeg on drop.
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    let _guard = LOCK.get_or_init(Default::default).lock().await;
    let Some(dir) = project
        .media_pool
        .values()
        .find_map(|m| m.conform_path.as_ref().and_then(|p| p.parent()))
    else {
        return Ok(Vec::new());
    };
    let signature_project = project.clone();
    let sorted: std::collections::BTreeMap<_, _> = overrides.iter().collect();
    let signature = digest(&(2, &signature_project, sorted))?;
    composition(project, id, overrides, dir, &signature, 0).await
}

pub fn stem_plan(project: &Project, stems: Vec<Stem>, window: Option<(i64, i64)>) -> MixPlan {
    let (start, end) = window.unwrap_or((0, project.root().duration_us));
    let solo = super::mix::any_role_solo(project.audio_roles.values());
    let layers = stems
        .into_iter()
        .filter_map(|s| {
            let role = project.role_mix(s.role);
            if !super::mix::role_audible(&role, solo) {
                return None;
            }
            Some(MixLayer {
                label: s.role.as_str().into(),
                conform_path: s.path,
                start_frame: 0,
                src_in_frame: 0,
                src_out_frame: us_to_frame(s.duration_us),
                head_frame: 0,
                gain: Envelope::constant(super::mix::role_gain_linear(&role), s.duration_us),
                pan: Envelope::constant(0.0, s.duration_us),
            })
        })
        .collect();
    MixPlan {
        window_start_frame: us_to_frame(start),
        window_end_frame: us_to_frame(end),
        layers,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::conform_reader::write_vconf;
    use crate::state::timing::{Fraction, TimeMap};

    fn timing(num: i64, den: i64, pitch: bool) -> TimingFields {
        TimingFields {
            time_map: Some(TimeMap::Affine {
                rate: Fraction { num, den },
            }),
            preserve_pitch: Some(pitch),
            ..Default::default()
        }
    }
    #[tokio::test]
    async fn a_group_window_past_content_is_exact_duration_silence() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("short.vconf");
        write_vconf(&source, 1, &[0.5; 480]);
        let path = stretch_window(
            &source,
            &timing(2, 1, true),
            1_000_000.0,
            3_000_000.0,
            1_000_000,
            dir.path(),
        )
        .await
        .unwrap();
        let mut pcm = ConformReader::open(&path).unwrap();
        assert_eq!(pcm.header.frame_count, 48_000);
        assert!(pcm
            .read_frames(0, 48_000)
            .unwrap()
            .iter()
            .all(|v| *v == 0.0));
    }

    fn frequency(samples: &[f32], channels: usize) -> f64 {
        let start = samples.len() / channels / 5;
        let end = samples.len() / channels * 4 / 5;
        let crossings = (start + 1..end)
            .filter(|&i| samples[(i - 1) * channels] <= 0.0 && samples[i * channels] > 0.0)
            .count();
        crossings as f64 * 48000.0 / (end - start) as f64
    }
    #[tokio::test]
    async fn duration_pitch_and_nested_policies_are_applied_per_scope() {
        assert!(
            crate::ffmpeg::ffmpeg_is_installed(),
            "this integration test requires ffmpeg"
        );
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("tone.vconf");
        let samples: Vec<f32> = (0..96_000)
            .map(|i| (i as f64 * 440.0 * std::f64::consts::TAU / 48000.0).sin() as f32 * 0.2)
            .collect();
        write_vconf(&source, 1, &samples);
        for pitch in [true, false] {
            let path = stretch(
                &source,
                &timing(2, 1, pitch),
                0,
                2_000_000,
                1_000_000,
                dir.path(),
            )
            .await
            .unwrap();
            let mut reader = ConformReader::open(&path).unwrap();
            assert_eq!(reader.header.frame_count, 48_000);
            let pcm = reader.read_frames(0, 48_000).unwrap();
            assert!((frequency(&pcm, 1) - if pitch { 440.0 } else { 880.0 }).abs() < 5.0);
            // The outer Group restores duration while keeping the child pitch.
            // Flattening the rates to 1 would incorrectly restore 440 Hz.
            let nested = stretch(
                &path,
                &timing(1, 2, true),
                0,
                1_000_000,
                2_000_000,
                dir.path(),
            )
            .await
            .unwrap();
            let mut reader = ConformReader::open(&nested).unwrap();
            assert_eq!(reader.header.frame_count, 96_000);
            let pcm = reader.read_frames(0, 96_000).unwrap();
            assert!((frequency(&pcm, 1) - if pitch { 440.0 } else { 880.0 }).abs() < 5.0);
        }
    }
}
