//! Exact coordinate remainders and per-instance time mapping (TS wire twin).
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "FractionWire")]
pub struct Fraction {
    pub num: i64,
    pub den: i64,
}
#[derive(Deserialize)]
struct FractionWire {
    num: i64,
    den: i64,
}
impl TryFrom<FractionWire> for Fraction {
    type Error = String;
    fn try_from(v: FractionWire) -> Result<Self, Self::Error> {
        weftcut_eval::time_mapping::Exact::from_wire(v.num, v.den)
            .map_err(|e| format!("invalid exact time: {e:?}"))?;
        Ok(Self {
            num: v.num,
            den: v.den,
        })
    }
}
impl Fraction {
    pub fn value(self) -> f64 {
        self.num as f64 / self.den as f64
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum TimeMap {
    Affine {
        #[serde(deserialize_with = "positive_rate")]
        rate: Fraction,
    },
}
fn positive_rate<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Fraction, D::Error> {
    let r = Fraction::deserialize(d)?;
    if r.num <= 0 {
        return Err(serde::de::Error::custom("rate must be positive"));
    }
    Ok(r)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Phase {
    #[serde(rename = "in")]
    pub in_: Fraction,
    pub out: Fraction,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ContentWindow {
    pub in_us: i64,
    pub out_us: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum FrameInterpolation {
    FrameSampling,
    FrameBlending,
    OpticalFlow,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TimingFields {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_map: Option<TimeMap>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_phase: Option<Phase>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_window: Option<ContentWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fade_phase: Option<Phase>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preserve_pitch: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_interpolation: Option<FrameInterpolation>,
}
impl TimingFields {
    pub fn rate(&self) -> f64 {
        match self.time_map {
            Some(TimeMap::Affine { rate }) => rate.value(),
            None => 1.0,
        }
    }
    pub fn content_time(&self, origin_us: i64, local_us: f64) -> f64 {
        let origin = self.content_window.as_ref().map_or(origin_us, |w| w.in_us);
        origin as f64
            + self.source_phase.as_ref().map_or(0.0, |p| p.in_.value())
            + local_us * self.rate()
    }
    pub fn source_end(&self, end_us: i64) -> f64 {
        self.content_window.as_ref().map_or(end_us, |w| w.out_us) as f64
            + self.source_phase.as_ref().map_or(0.0, |p| p.out.value())
    }
}
