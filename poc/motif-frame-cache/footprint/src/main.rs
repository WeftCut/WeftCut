use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::Instant;

struct Frame { w: u32, h: u32, lz4_len: usize, raw: Vec<u8> }

fn load_dir(dir: &Path) -> Vec<Frame> {
    let mut names: Vec<(u32, std::path::PathBuf)> = fs::read_dir(dir).unwrap().filter_map(|e| {
        let p = e.unwrap().path();
        let stem = p.file_stem()?.to_str()?.parse::<u32>().ok()?;
        (p.extension()?.to_str()? == "wfrm").then_some((stem, p))
    }).collect();
    names.sort();
    names.into_iter().map(|(_, p)| {
        let bytes = fs::read(&p).unwrap();
        assert_eq!(&bytes[..8], b"WCMFRM01");
        let n = |o: usize| u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
        let (w, h, codec) = (n(8), n(12), n(16));
        let size = (w * h * 4) as usize;
        let raw = match codec { 0 => bytes[52..].to_vec(), 1 => lz4_flex::block::decompress(&bytes[52..], size).unwrap(), _ => panic!() };
        assert_eq!(blake3::hash(&raw).as_bytes(), &bytes[20..52]);
        Frame { w, h, lz4_len: bytes.len() - 52, raw }
    }).collect()
}

fn time<T>(f: impl FnOnce() -> T) -> (T, f64) { let t = Instant::now(); let r = f(); (r, t.elapsed().as_secs_f64() * 1e3) }

fn sub_filter(raw: &[u8]) -> Vec<u8> { let mut o = raw.to_vec(); for i in (4..raw.len()).rev() { o[i] = raw[i].wrapping_sub(raw[i - 4]); } o }
fn unsub_filter(f: &[u8]) -> Vec<u8> { let mut o = f.to_vec(); for i in 4..f.len() { o[i] = o[i].wrapping_add(o[i - 4]); } o }
fn delta(a: &[u8], b: &[u8]) -> Vec<u8> { a.iter().zip(b).map(|(x, y)| x.wrapping_sub(*y)).collect() }
fn undelta(d: &[u8], b: &[u8]) -> Vec<u8> { d.iter().zip(b).map(|(x, y)| x.wrapping_add(*y)).collect() }
fn planar(raw: &[u8]) -> Vec<u8> { let n = raw.len() / 4; let mut o = vec![0u8; raw.len()]; for i in 0..n { for c in 0..4 { o[c * n + i] = raw[i * 4 + c]; } } o }
fn unplanar(p: &[u8]) -> Vec<u8> { let n = p.len() / 4; let mut o = vec![0u8; p.len()]; for i in 0..n { for c in 0..4 { o[i * 4 + c] = p[c * n + i]; } } o }

fn alpha_bbox(raw: &[u8], w: u32, h: u32) -> Option<(u32, u32, u32, u32)> {
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0u32, 0u32);
    for y in 0..h { for x in 0..w { if raw[((y * w + x) * 4 + 3) as usize] != 0 { x0 = x0.min(x); y0 = y0.min(y); x1 = x1.max(x); y1 = y1.max(y); } } }
    (x0 != u32::MAX).then_some((x0, y0, x1 - x0 + 1, y1 - y0 + 1))
}
fn crop(raw: &[u8], w: u32, bb: (u32, u32, u32, u32)) -> Vec<u8> {
    let mut o = Vec::with_capacity((bb.2 * bb.3 * 4) as usize);
    for y in bb.1..bb.1 + bb.3 { let s = ((y * w + bb.0) * 4) as usize; o.extend_from_slice(&raw[s..s + (bb.2 * 4) as usize]); }
    o
}

fn png_encode(raw: &[u8], w: u32, h: u32) -> Vec<u8> {
    let mut out = Vec::new();
    { let mut enc = png::Encoder::new(&mut out, w, h); enc.set_color(png::ColorType::Rgba); enc.set_depth(png::BitDepth::Eight);
      enc.set_compression(png::Compression::Fast); enc.set_filter(png::FilterType::Sub); enc.set_adaptive_filter(png::AdaptiveFilterType::Adaptive);
      let mut wr = enc.write_header().unwrap(); wr.write_image_data(raw).unwrap(); }
    out
}
fn png_decode(bytes: &[u8]) -> Vec<u8> { let d = png::Decoder::new(std::io::Cursor::new(bytes)); let mut r = d.read_info().unwrap(); let mut buf = vec![0; r.output_buffer_size()]; r.next_frame(&mut buf).unwrap(); buf }

#[derive(Default)]
struct Acc { frames: usize, raw: usize, lz4: usize, zstd1: usize, zstd3: usize, sub_lz4: usize, sub_zstd1: usize, planar_zstd1: usize, dprev_lz4: usize, dprev_zstd1: usize, dkey_zstd1: usize, crop_lz4: usize, crop_zstd1: usize, crop_px: f64, png: usize, dups: usize,
    t_lz4: f64, t_zstd1: f64, t_zstd3: f64, t_sub_zstd1: f64, t_planar_zstd1: f64, t_dprev_zstd1: f64, t_png: f64, e_lz4: f64, e_zstd1: f64, e_png: f64 }

fn main() {
    let arg = std::env::args().nth(1).expect("sample root"); let root = Path::new(&arg);
    let mut dirs: Vec<_> = fs::read_dir(root).unwrap().map(|e| e.unwrap().path()).filter(|p| p.is_dir()).collect();
    dirs.sort();
    let out_path = std::env::args().nth(2).unwrap_or_else(|| "footprint-results.tsv".into()); let mut out = fs::File::create(&out_path).unwrap();
    writeln!(out, "dir\tframes\tWxH\traw_MB\tlz4_MB\tzstd1_MB\tzstd3_MB\tsub+lz4_MB\tsub+zstd1_MB\tplanar+zstd1_MB\tdprev+lz4_MB\tdprev+zstd1_MB\tdkey30+zstd1_MB\tcrop+lz4_MB\tcrop+zstd1_MB\tcrop_area%\tpng_MB\tdup_frames\tdec_lz4_ms\tdec_zstd1_ms\tdec_zstd3_ms\tdec_sub+zstd1_ms\tdec_planar+zstd1_ms\tdec_dprev+zstd1_ms\tdec_png_ms\tenc_lz4_ms\tenc_zstd1_ms\tenc_png_ms").unwrap();
    for dir in dirs {
        let frames = load_dir(&dir);
        if frames.is_empty() { continue; }
        let (w, h) = (frames[0].w, frames[0].h);
        let mut a = Acc::default();
        let mut prev_hash = None;
        for (i, f) in frames.iter().enumerate() {
            let raw = &f.raw;
            a.frames += 1; a.raw += raw.len(); a.lz4 += f.lz4_len;
            let hsh = blake3::hash(raw);
            if prev_hash == Some(hsh) { a.dups += 1; }
            prev_hash = Some(hsh);

            let (lz, e) = time(|| lz4_flex::block::compress(raw)); a.e_lz4 += e;
            let (_, t) = time(|| lz4_flex::block::decompress(&lz, raw.len()).unwrap()); a.t_lz4 += t;
            let (z1, e) = time(|| zstd::bulk::compress(raw, 1).unwrap()); a.e_zstd1 += e; a.zstd1 += z1.len();
            let (_, t) = time(|| zstd::bulk::decompress(&z1, raw.len()).unwrap()); a.t_zstd1 += t;
            let z3 = zstd::bulk::compress(raw, 3).unwrap(); a.zstd3 += z3.len();
            let (_, t) = time(|| zstd::bulk::decompress(&z3, raw.len()).unwrap()); a.t_zstd3 += t;

            let sub = sub_filter(raw);
            a.sub_lz4 += lz4_flex::block::compress(&sub).len();
            let sz = zstd::bulk::compress(&sub, 1).unwrap(); a.sub_zstd1 += sz.len();
            let (_, t) = time(|| unsub_filter(&zstd::bulk::decompress(&sz, raw.len()).unwrap())); a.t_sub_zstd1 += t;

            let pl = planar(raw); let pz = zstd::bulk::compress(&pl, 1).unwrap(); a.planar_zstd1 += pz.len();
            let (_, t) = time(|| unplanar(&zstd::bulk::decompress(&pz, raw.len()).unwrap())); a.t_planar_zstd1 += t;

            if i > 0 {
                let d = delta(raw, &frames[i - 1].raw);
                a.dprev_lz4 += lz4_flex::block::compress(&d).len();
                let dz = zstd::bulk::compress(&d, 1).unwrap(); a.dprev_zstd1 += dz.len();
                let (_, t) = time(|| undelta(&zstd::bulk::decompress(&dz, raw.len()).unwrap(), &frames[i - 1].raw)); a.t_dprev_zstd1 += t;
            } else { a.dprev_lz4 += lz.len(); a.dprev_zstd1 += z1.len(); a.t_dprev_zstd1 += 0.0; }
            if i % 30 == 0 { a.dkey_zstd1 += z1.len(); } else { let d = delta(raw, &frames[i / 30 * 30].raw); a.dkey_zstd1 += zstd::bulk::compress(&d, 1).unwrap().len(); }

            match alpha_bbox(raw, w, h) {
                Some(bb) => { let c = crop(raw, w, bb); a.crop_px += (bb.2 * bb.3) as f64 / (w * h) as f64; a.crop_lz4 += lz4_flex::block::compress(&c).len() + 16; a.crop_zstd1 += zstd::bulk::compress(&c, 1).unwrap().len() + 16; }
                None => { a.crop_lz4 += 16; a.crop_zstd1 += 16; }
            }

            let (p, e) = time(|| png_encode(raw, w, h)); a.e_png += e; a.png += p.len();
            let (_, t) = time(|| png_decode(&p)); a.t_png += t;
        }
        let n = a.frames as f64; let mb = |b: usize| b as f64 / 1048576.0;
        let line = format!("{}\t{}\t{}x{}\t{:.1}\t{:.1}\t{:.1}\t{:.1}\t{:.1}\t{:.1}\t{:.1}\t{:.1}\t{:.1}\t{:.1}\t{:.1}\t{:.1}\t{:.0}\t{:.1}\t{}\t{:.1}\t{:.1}\t{:.1}\t{:.1}\t{:.1}\t{:.1}\t{:.1}\t{:.1}\t{:.1}\t{:.1}",
            dir.file_name().unwrap().to_str().unwrap(), a.frames, w, h, mb(a.raw), mb(a.lz4), mb(a.zstd1), mb(a.zstd3), mb(a.sub_lz4), mb(a.sub_zstd1), mb(a.planar_zstd1), mb(a.dprev_lz4), mb(a.dprev_zstd1), mb(a.dkey_zstd1), mb(a.crop_lz4), mb(a.crop_zstd1), a.crop_px / n * 100.0, mb(a.png), a.dups,
            a.t_lz4 / n, a.t_zstd1 / n, a.t_zstd3 / n, a.t_sub_zstd1 / n, a.t_planar_zstd1 / n, a.t_dprev_zstd1 / n, a.t_png / n, a.e_lz4 / n, a.e_zstd1 / n, a.e_png / n);
        println!("{line}"); writeln!(out, "{line}").unwrap();
    }
}
