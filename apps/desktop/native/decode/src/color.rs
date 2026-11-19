//! The owned YCbCr → display conversion's numbers on the native side: the
//! matrices the decode lanes implement, the d3d11va conversion shader
//! (`preview_gpu/convert.rs` compiles it) with its baked constants, and a CPU
//! reference of that shader. Platform-neutral so its tests run everywhere.
//! Twin of the renderer's `render/yuv/colourConversion.ts`; both are held to
//! `colourConversionGolden.fixture.json`.

/// A YCbCr matrix the owned conversions implement, by its WebCodecs name. The
/// renderer's rule (`planeConversion` in `ffprobeColorSpace.ts`) decides what
/// a source whose matrix is none of these converts with; a name outside this
/// list reaching native is a bug and fails the open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Matrix {
    Bt709,
    /// BT.601, 525 lines.
    Smpte170m,
    /// BT.601, 625 lines: the same coefficients as `Smpte170m`.
    Bt470bg,
    /// BT.2020 non-constant luminance.
    Bt2020Ncl,
}

impl Matrix {
    pub fn parse(name: &str) -> Result<Matrix, String> {
        match name {
            "bt709" => Ok(Matrix::Bt709),
            "smpte170m" => Ok(Matrix::Smpte170m),
            "bt470bg" => Ok(Matrix::Bt470bg),
            "bt2020-ncl" => Ok(Matrix::Bt2020Ncl),
            other => Err(format!("no YCbCr matrix {other:?} is implemented")),
        }
    }

    #[cfg(any(windows, test))]
    pub fn coef(self) -> YuvCoef {
        match self {
            Matrix::Bt709 => YuvCoef {
                kr: 0.2126,
                kb: 0.0722,
            },
            Matrix::Smpte170m | Matrix::Bt470bg => YuvCoef {
                kr: 0.299,
                kb: 0.114,
            },
            Matrix::Bt2020Ncl => YuvCoef {
                kr: 0.2627,
                kb: 0.0593,
            },
        }
    }
}

/// Kr/Kb of a YCbCr matrix (Kg = 1 − Kr − Kb).
#[cfg(any(windows, test))]
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct YuvCoef {
    pub kr: f64,
    pub kb: f64,
}

/// Shader coefficients `[crR, cbG, crG, cbB]`: R = Y + crR·Cr,
/// G = Y − crG·Cr − cbG·Cb, B = Y + cbB·Cb.
#[cfg(any(windows, test))]
pub fn inverse_coef(c: YuvCoef) -> [f64; 4] {
    let kg = 1.0 - c.kr - c.kb;
    let cr_r = 2.0 * (1.0 - c.kr);
    let cb_b = 2.0 * (1.0 - c.kb);
    [cr_r, (c.kb * cb_b) / kg, (c.kr * cr_r) / kg, cb_b]
}

/// 8-bit normalization `(y_off, y_scale, c_scale)`, as `Nv12Ingest`'s
/// limited and full ranges.
#[cfg(any(windows, test))]
pub fn norm_consts(full_range: bool) -> (f64, f64, f64) {
    if full_range {
        (0.0, 255.0, 255.0)
    } else {
        (16.0, 219.0, 224.0)
    }
}

/// Row-major 3x3.
#[cfg(any(windows, test))]
pub type Mat3 = [[f64; 3]; 3];

/// CIE xy chromaticities of red, green and blue, by WebCodecs primaries name.
/// Every one of these standards uses the D65 white below.
#[cfg(any(windows, test))]
fn chromaticities(primaries: &str) -> Option<[(f64, f64); 3]> {
    match primaries {
        // ITU-R BT.709.
        "bt709" => Some([(0.640, 0.330), (0.300, 0.600), (0.150, 0.060)]),
        // ITU-R BT.2020.
        "bt2020" => Some([(0.708, 0.292), (0.170, 0.797), (0.131, 0.046)]),
        // ITU-R BT.470 System B/G (EBU Tech 3213), BT.601 625 lines.
        "bt470bg" => Some([(0.640, 0.330), (0.290, 0.600), (0.150, 0.060)]),
        // SMPTE 170M (SMPTE C), BT.601 525 lines.
        "smpte170m" => Some([(0.630, 0.340), (0.310, 0.595), (0.155, 0.070)]),
        _ => None,
    }
}

#[cfg(any(windows, test))]
const D65: (f64, f64) = (0.3127, 0.3290);

#[cfg(any(windows, test))]
fn xyz((x, y): (f64, f64)) -> [f64; 3] {
    [x / y, 1.0, (1.0 - x - y) / y]
}

#[cfg(any(windows, test))]
fn invert(m: Mat3) -> Mat3 {
    let [[a, b, c], [d, e, f], [g, h, i]] = m;
    let det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    [
        [
            (e * i - f * h) / det,
            (c * h - b * i) / det,
            (b * f - c * e) / det,
        ],
        [
            (f * g - d * i) / det,
            (a * i - c * g) / det,
            (c * d - a * f) / det,
        ],
        [
            (d * h - e * g) / det,
            (b * g - a * h) / det,
            (a * e - b * d) / det,
        ],
    ]
}

#[cfg(any(windows, test))]
fn multiply(a: Mat3, b: Mat3) -> Mat3 {
    let mut out = [[0.0; 3]; 3];
    for (r, row) in out.iter_mut().enumerate() {
        for (c, v) in row.iter_mut().enumerate() {
            *v = (0..3).map(|k| a[r][k] * b[k][c]).sum();
        }
    }
    out
}

#[cfg(any(windows, test))]
fn apply(m: Mat3, v: [f64; 3]) -> [f64; 3] {
    m.map(|row| row[0] * v[0] + row[1] * v[1] + row[2] * v[2])
}

/// Linear RGB in `primaries` → CIE XYZ: the primaries' XYZ columns scaled so
/// RGB white lands on D65.
#[cfg(any(windows, test))]
fn rgb_to_xyz(primaries: [(f64, f64); 3]) -> Mat3 {
    let cols = primaries.map(xyz);
    let m = [0, 1, 2].map(|r| [cols[0][r], cols[1][r], cols[2][r]]);
    let s = apply(invert(m), xyz(D65));
    [0, 1, 2].map(|r| [m[r][0] * s[0], m[r][1] * s[1], m[r][2] * s[2]])
}

/// The matrix taking linear RGB in `primaries` to linear BT.709 RGB, or
/// `None` for BT.709 itself, which converts nothing. A name the renderer's rule
/// cannot send fails the open, like `Matrix::parse`.
#[cfg(any(windows, test))]
pub fn primaries_to_bt709(primaries: &str) -> Result<Option<Mat3>, String> {
    let source = chromaticities(primaries)
        .ok_or_else(|| format!("no conversion from primaries {primaries:?} is implemented"))?;
    if primaries == "bt709" {
        return Ok(None);
    }
    let bt709 = chromaticities("bt709").expect("BT.709 is in the table");
    Ok(Some(multiply(
        invert(rgb_to_xyz(bt709)),
        rgb_to_xyz(source),
    )))
}

/// The display transfer both ways around the primaries conversion: BT.1886's
/// pure 2.4 power. The conversion is display-referred (the picture as an SDR
/// display shows it, re-shown in BT.709 primaries); inverting the camera OETF
/// instead would change the tone of every converted picture. Twin of
/// `DISPLAY_GAMMA` in `colourConversion.ts`.
#[cfg(any(windows, test))]
pub const DISPLAY_GAMMA: f64 = 2.4;

/// Everything the d3d11va conversion of one session does, fixed at open.
#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Conversion {
    coef: [f64; 4],
    norm: (f64, f64, f64),
    /// `None`: BT.709 primaries, and the shader has no primaries step.
    gamut: Option<Mat3>,
}

#[cfg(any(windows, test))]
impl Conversion {
    /// `matrix` and `primaries` are the renderer's decision for this source
    /// (`planeConversion`), not its tags.
    pub fn parse(matrix: &str, full_range: bool, primaries: &str) -> Result<Conversion, String> {
        Ok(Conversion {
            coef: inverse_coef(Matrix::parse(matrix)?.coef()),
            norm: norm_consts(full_range),
            gamut: primaries_to_bt709(primaries)?,
        })
    }

    /// The constants `HLSL` reads, as `#define`s: per-session, so the
    /// per-frame cost is the draw alone. `GAMUT` and its `Gij` only when the
    /// primaries are not BT.709, so a BT.709 source compiles without the step.
    ///
    /// 10 decimals is past f32's round-trip precision: each baked constant IS
    /// the f32 nearest the f64 the renderer's twin computes.
    pub fn hlsl_defines(&self) -> String {
        let [cr_r, cb_g, cr_g, cb_b] = self.coef;
        let (y_off, y_scale, c_scale) = self.norm;
        let mut defines = format!(
            "#define CRR {cr_r:.10}\n#define CBG {cb_g:.10}\n#define CRG {cr_g:.10}\n\
             #define CBB {cb_b:.10}\n#define YOFF {y_off:.1}\n#define YSCALE {y_scale:.1}\n\
             #define CSCALE {c_scale:.1}\n#define DISPLAY_GAMMA {DISPLAY_GAMMA:.1}\n"
        );
        if let Some(m) = self.gamut {
            defines.push_str("#define GAMUT 1\n");
            for (r, row) in m.iter().enumerate() {
                for (c, v) in row.iter().enumerate() {
                    defines.push_str(&format!("#define G{r}{c} {v:.10}\n"));
                }
            }
        }
        defines
    }

    /// CPU reference of `HLSL`'s `ps_main` for one 8-bit (Y, Cb, Cr): display
    /// R'G'B' in [0, 1].
    #[cfg(test)]
    pub fn reference(&self, codes: [u8; 3]) -> [f64; 3] {
        let [cr_r, cb_g, cr_g, cb_b] = self.coef;
        let (y_off, y_scale, c_scale) = self.norm;
        let y = (f64::from(codes[0]) - y_off) / y_scale;
        let cb = (f64::from(codes[1]) - 128.0) / c_scale;
        let cr = (f64::from(codes[2]) - 128.0) / c_scale;
        let rgb = [y + cr_r * cr, y - cr_g * cr - cb_g * cb, y + cb_b * cb];
        let saturate = |v: f64| v.clamp(0.0, 1.0);
        let shown = match self.gamut {
            None => rgb,
            Some(m) => {
                let linear = apply(m, rgb.map(|v| saturate(v).powf(DISPLAY_GAMMA)));
                linear.map(|v| saturate(v).powf(1.0 / DISPLAY_GAMMA))
            }
        };
        shown.map(saturate)
    }
}

/// The d3d11va NV12 → RGBA conversion, compiled with `Conversion::hlsl_defines`
/// prepended. RG order in the UV plane is U then V, so `.x` is Cb and `.y` is
/// Cr, as `Nv12Ingest`'s `texture(uUV).rg`. The primaries step mirrors the
/// ingest shaders' `toBt709` (`render/yuv/PlaneIngest.ts`).
#[cfg(any(windows, test))]
pub const HLSL: &str = r#"
Texture2D<float>  texY  : register(t0);
Texture2D<float2> texUV : register(t1);
SamplerState      samp  : register(s0);

struct VSOut { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };

VSOut vs_main(uint vid : SV_VertexID) {
    float2 clip[3] = { float2(-1.0, -3.0), float2(-1.0, 1.0), float2(3.0, 1.0) };
    float2 uvs[3]  = { float2(0.0, 2.0),  float2(0.0, 0.0),  float2(2.0, 0.0)  };
    VSOut o;
    o.pos = float4(clip[vid], 0.0, 1.0);
    o.uv  = uvs[vid];
    return o;
}

#ifdef GAMUT
float3 toBt709(float3 rgb) {
    float3 lin = pow(saturate(rgb), DISPLAY_GAMMA);
    float3 shown = float3(
        dot(float3(G00, G01, G02), lin),
        dot(float3(G10, G11, G12), lin),
        dot(float3(G20, G21, G22), lin));
    return pow(saturate(shown), 1.0 / DISPLAY_GAMMA);
}
#endif

float4 ps_main(VSOut i) : SV_TARGET {
    float y = (texY.Sample(samp, i.uv).r * 255.0 - YOFF) / YSCALE;
    float2 c = (texUV.Sample(samp, i.uv).rg * 255.0 - 128.0) / CSCALE;
    float3 rgb = float3(
        y + CRR * c.y,
        y - CRG * c.y - CBG * c.x,
        y + CBB * c.x);
#ifdef GAMUT
    rgb = toBt709(rgb);
#endif
    return float4(saturate(rgb), 1.0);
}
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// Shared with the renderer's `colourConversion.test.ts`.
    fn golden() -> Value {
        serde_json::from_str(include_str!(
            "../../../src/renderer/render/yuv/colourConversionGolden.fixture.json"
        ))
        .unwrap()
    }

    fn num(v: &Value) -> f64 {
        v.as_f64().unwrap()
    }

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol
    }

    #[test]
    fn every_matrix_has_the_golden_coefficients() {
        let golden = golden();
        let matrices = golden["matrices"].as_array().unwrap();
        assert!(!matrices.is_empty());
        for m in matrices {
            let name = m["matrix"].as_str().unwrap();
            let coef = Matrix::parse(name).unwrap().coef();
            assert_eq!((coef.kr, coef.kb), (num(&m["kr"]), num(&m["kb"])), "{name}");
            let inverse = inverse_coef(coef);
            for (got, want) in inverse.iter().zip(m["inverse"].as_array().unwrap()) {
                assert!(close(*got, num(want), 1e-12), "{name}: {inverse:?}");
            }
        }
    }

    #[test]
    fn only_the_implemented_matrices_parse() {
        for name in ["bt709", "smpte170m", "bt470bg", "bt2020-ncl"] {
            assert!(Matrix::parse(name).is_ok(), "{name}");
        }
        for name in [
            "",
            "rgb",
            "bt2020-cl",
            "smpte240m",
            "ycgco",
            "ictcp",
            "bt2020nc",
        ] {
            assert!(Matrix::parse(name).is_err(), "{name:?}");
        }
    }

    #[test]
    fn every_primaries_conversion_is_the_golden_matrix() {
        let golden = golden();
        let primaries = golden["primaries"].as_array().unwrap();
        assert!(primaries.len() > 1);
        for p in primaries {
            let name = p["primaries"].as_str().unwrap();
            let got = primaries_to_bt709(name).unwrap();
            match (&p["toBt709"], got) {
                (Value::Null, None) => {}
                (Value::Array(rows), Some(m)) => {
                    for (r, row) in rows.iter().enumerate() {
                        for (c, v) in row.as_array().unwrap().iter().enumerate() {
                            assert!(close(m[r][c], num(v), 1e-12), "{name}: {m:?}");
                        }
                    }
                }
                (want, got) => panic!("{name}: golden {want}, got {got:?}"),
            }
        }
        for name in ["", "smpte432", "film", "bt2020nc"] {
            assert!(primaries_to_bt709(name).is_err(), "{name:?}");
        }
    }

    #[test]
    fn the_shader_reference_shows_the_golden_colours() {
        let golden = golden();
        let cases: Vec<&Value> = golden["conversions"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["bits"] == 8)
            .collect();
        assert!(!cases.is_empty());
        for case in cases {
            let id = case["id"].as_str().unwrap();
            let conversion = Conversion::parse(
                case["matrix"].as_str().unwrap(),
                case["fullRange"].as_bool().unwrap(),
                case["primaries"].as_str().unwrap(),
            )
            .unwrap();
            let codes = case["codes"].as_array().unwrap();
            let codes = [0, 1, 2].map(|i| codes[i].as_u64().unwrap() as u8);
            let got = conversion.reference(codes);
            for (g, want) in got.iter().zip(case["rgb"].as_array().unwrap()) {
                assert!(close(*g, num(want), 1e-9), "{id}: {got:?}");
            }
        }
    }

    #[test]
    fn a_bt709_source_compiles_without_the_primaries_step() {
        let defines = Conversion::parse("bt709", false, "bt709")
            .unwrap()
            .hlsl_defines();
        assert!(!defines.contains("GAMUT"), "{defines}");
        assert!(!defines.contains("#define G0"), "{defines}");
        let defines = Conversion::parse("bt2020-ncl", false, "bt2020")
            .unwrap()
            .hlsl_defines();
        assert!(defines.contains("#define GAMUT 1\n"), "{defines}");
    }

    /// Every constant the shader names is baked in, with the value the
    /// reference computes with.
    #[test]
    fn the_defines_carry_every_constant_the_shader_reads() {
        let conversion = Conversion::parse("bt2020-ncl", true, "bt2020").unwrap();
        let defines = conversion.hlsl_defines();
        let baked: std::collections::HashMap<&str, f64> = defines
            .lines()
            .filter_map(|l| {
                let mut words = l.strip_prefix("#define ")?.split(' ');
                Some((words.next()?, words.next()?.parse().ok()?))
            })
            .collect();
        let read: std::collections::BTreeSet<&str> = HLSL
            .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .filter(|w| {
                w.len() > 1
                    && w.chars()
                        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
                    && w.chars().next().unwrap().is_ascii_uppercase()
            })
            .filter(|w| !matches!(*w, "SV_POSITION" | "TEXCOORD0" | "SV_TARGET"))
            .collect();
        for name in &read {
            assert!(
                baked.contains_key(name),
                "{name} is read but not defined:\n{defines}"
            );
        }
        let m = conversion.gamut.unwrap();
        for (r, row) in m.iter().enumerate() {
            for (c, v) in row.iter().enumerate() {
                assert!(close(baked[format!("G{r}{c}").as_str()], *v, 1e-9));
            }
        }
        assert_eq!(baked["DISPLAY_GAMMA"], DISPLAY_GAMMA);
        assert!(close(baked["CRR"], conversion.coef[0], 1e-9));
        assert!(close(baked["CBB"], conversion.coef[3], 1e-9));
    }

    #[test]
    fn greys_pass_the_primaries_step_unchanged() {
        for primaries in ["bt2020", "bt470bg", "smpte170m"] {
            let conversion = Conversion::parse("bt709", false, primaries).unwrap();
            let plain = Conversion::parse("bt709", false, "bt709").unwrap();
            for y in 16..=235u8 {
                let got = conversion.reference([y, 128, 128]);
                let want = plain.reference([y, 128, 128]);
                for (g, w) in got.iter().zip(want) {
                    assert!(close(*g, w, 1e-9), "{primaries} Y={y}: {got:?} vs {want:?}");
                }
            }
        }
    }
}
