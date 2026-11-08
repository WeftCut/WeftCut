//! OSR texture to the straight-RGBA frame cache, without PNG or pixel IPC, and
//! the capture host's frame marker check. Each reader keeps its D3D11 device
//! and staging texture on its own worker. `MotifTextureEncoder::read` runs
//! under the caller's OSR lease; `finish` runs after it (ADR 0158).
use crate::motif_error::{coded, to_napi, MotifCode};
use crate::motif_gpu::{acquire_sync, device};
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use std::sync::mpsc;

use windows::core::Interface;
use windows::Win32::Foundation::{HANDLE, HMODULE};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::IDXGIKeyedMutex;

/// For errors that are not `anyhow::Error`; those go through `to_napi`.
fn error(e: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(e.to_string())
}

/// The reader's worker is gone or dropped the reply without answering.
fn worker_lost(e: impl std::fmt::Display) -> napi::Error {
    to_napi(device(anyhow::anyhow!("Motif reader worker lost: {e}")))
}

/// Worker replies carry `format!("{e:#}")`, which keeps a `[motif:<code>]` tag.
type Reply = tokio::sync::oneshot::Sender<Result<Pixels, String>>;

struct Pixels {
    width: u32,
    height: u32,
    bgra: bool,
    premultiplied: Vec<u8>,
}

/// One frame read back from a texture. Its pixels stay native until `finish`.
#[napi]
pub struct MotifRawFrame {
    pixels: std::sync::Mutex<Option<Pixels>>,
}

#[napi]
impl MotifRawFrame {
    /// Straightens and encodes off the D3D11 worker, so the next `read` does not
    /// wait for this frame.
    #[napi]
    pub async fn finish(&self) -> napi::Result<Buffer> {
        let pixels = self
            .pixels
            .lock()
            .map_err(error)?
            .take()
            .ok_or_else(|| error("motif frame already finished"))?;
        tokio::task::spawn_blocking(move || encode_pixels(pixels))
            .await
            .map_err(error)?
            .map_err(to_napi)
    }

    /// The same pixels as a PNG, for captures that leave the app as images.
    #[napi]
    pub async fn finish_png(&self) -> napi::Result<Buffer> {
        let pixels = self
            .pixels
            .lock()
            .map_err(error)?
            .take()
            .ok_or_else(|| error("motif frame already finished"))?;
        tokio::task::spawn_blocking(move || {
            let Pixels {
                width,
                height,
                bgra,
                premultiplied: mut rgba,
            } = pixels;
            crate::motif_frame::straighten(&mut rgba, bgra);
            crate::motif_frame::encode_png(width, height, rgba).map(Buffer::from)
        })
        .await
        .map_err(error)?
        .map_err(to_napi)
    }
}

fn encode_pixels(pixels: Pixels) -> anyhow::Result<Buffer> {
    let Pixels {
        width,
        height,
        bgra,
        mut premultiplied,
    } = pixels;
    Ok(crate::motif_frame::encode_premultiplied(width, height, &mut premultiplied, bgra)?.into())
}

type Job = (usize, Region, Reply);

/// One D3D11 device and its staging texture on a dedicated thread.
fn spawn_reader(name: &str) -> napi::Result<mpsc::Sender<Job>> {
    let (tx, rx) = mpsc::channel::<Job>();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            let mut reader = match unsafe { Reader::new() } {
                Ok(reader) => {
                    let _ = ready_tx.send(Ok(()));
                    reader
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("{:#}", device(e))));
                    return;
                }
            };
            while let Ok((handle, region, reply)) = rx.recv() {
                let result = unsafe { reader.read(handle, region) }.map_err(|e| format!("{e:#}"));
                let _ = reply.send(result);
            }
        })
        .map_err(|e| to_napi(device(e)))?;
    ready_rx.recv().map_err(worker_lost)?.map_err(error)?;
    Ok(tx)
}

async fn request(
    tx: Option<&mpsc::Sender<Job>>,
    handle: Buffer,
    region: Region,
) -> napi::Result<Pixels> {
    let bits: [u8; 8] = handle.as_ref().try_into().map_err(error)?;
    let (reply, rx) = tokio::sync::oneshot::channel();
    tx.ok_or_else(|| {
        to_napi(coded(
            MotifCode::Closed,
            anyhow::anyhow!("Motif reader closed"),
        ))
    })?
    .send((u64::from_le_bytes(bits) as usize, region, reply))
    .map_err(worker_lost)?;
    rx.await.map_err(worker_lost)?.map_err(error)
}

#[napi]
pub struct MotifTextureEncoder {
    tx: Option<mpsc::Sender<Job>>,
}

#[napi]
impl MotifTextureEncoder {
    #[napi(constructor)]
    pub fn new() -> napi::Result<Self> {
        Ok(Self {
            tx: Some(spawn_reader("motif-bake")?),
        })
    }

    /// The picture: the texture's top `height` rows, above the capture host's
    /// marker rows.
    #[napi]
    pub async fn read(&self, handle: Buffer, height: u32) -> napi::Result<MotifRawFrame> {
        let pixels = request(self.tx.as_ref(), handle, Region::Top(height)).await?;
        Ok(MotifRawFrame {
            pixels: std::sync::Mutex::new(Some(pixels)),
        })
    }

    #[napi]
    pub fn close(&mut self) {
        self.tx.take();
    }
}

/// Reads the frame marker of capture host textures. Its own thread, so a
/// marker check never queues behind a whole-picture readback.
#[napi]
pub struct MotifMarkerReader {
    tx: Option<mpsc::Sender<Job>>,
}

#[napi]
impl MotifMarkerReader {
    #[napi(constructor)]
    pub fn new() -> napi::Result<Self> {
        Ok(Self {
            tx: Some(spawn_reader("motif-marker")?),
        })
    }

    /// The first `pixels` of the texture's last row, as RGBA.
    #[napi]
    pub async fn read(&self, handle: Buffer, pixels: u32) -> napi::Result<Buffer> {
        let mut row = request(self.tx.as_ref(), handle, Region::LastRow(pixels)).await?;
        if row.bgra {
            for px in row.premultiplied.as_chunks_mut::<4>().0 {
                px.swap(0, 2);
            }
        }
        Ok(row.premultiplied.into())
    }

    #[napi]
    pub fn close(&mut self) {
        self.tx.take();
    }
}

/// The part of an OSR texture a read returns.
#[derive(Clone, Copy)]
enum Region {
    /// The top rows.
    Top(u32),
    /// The first pixels of the last row.
    LastRow(u32),
}

struct Reader {
    device: ID3D11Device1,
    context: ID3D11DeviceContext,
    staging: Option<ID3D11Texture2D>,
    size: (u32, u32, DXGI_FORMAT),
}

impl Reader {
    unsafe fn new() -> anyhow::Result<Self> {
        let (mut device, mut context) = (None, None);
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )?;
        Ok(Self {
            device: device.unwrap().cast()?,
            context: context.unwrap(),
            staging: None,
            size: (0, 0, DXGI_FORMAT_UNKNOWN),
        })
    }

    unsafe fn read(&mut self, handle: usize, region: Region) -> anyhow::Result<Pixels> {
        let source: ID3D11Texture2D = self
            .device
            .OpenSharedResource1(HANDLE(handle as *mut _))
            .map_err(device)?;
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        source.GetDesc(&mut desc);
        if desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM && desc.Format != DXGI_FORMAT_R8G8B8A8_UNORM {
            return Err(device(anyhow::anyhow!("unsupported OSR format")));
        }
        if desc.Width == 0
            || desc.Height == 0
            || u64::from(desc.Width) * u64::from(desc.Height) * 4 > 128 * 1024 * 1024
        {
            return Err(coded(
                MotifCode::Oversize,
                anyhow::anyhow!("readback budget"),
            ));
        }
        let (left, top, width, height) = match region {
            Region::Top(rows) => {
                anyhow::ensure!(
                    rows > 0 && rows <= desc.Height,
                    "{rows} rows of a {}-row texture",
                    desc.Height
                );
                (0, 0, desc.Width, rows)
            }
            Region::LastRow(pixels) => {
                anyhow::ensure!(
                    pixels > 0 && pixels <= desc.Width,
                    "{pixels} pixels of a {}-pixel row",
                    desc.Width
                );
                (0, desc.Height - 1, pixels, 1)
            }
        };
        let size = (width, height, desc.Format);
        if self.size != size {
            let staging_desc = D3D11_TEXTURE2D_DESC {
                Width: width,
                Height: height,
                Usage: D3D11_USAGE_STAGING,
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                MiscFlags: 0,
                ..desc
            };
            let mut staging = None;
            self.device
                .CreateTexture2D(&staging_desc, None, Some(&mut staging))
                .map_err(device)?;
            self.staging = staging;
            self.size = size;
        }
        let mutex = source.cast::<IDXGIKeyedMutex>().ok();
        if let Some(ref m) = mutex {
            acquire_sync(m, "OSR")?;
        }
        let staging = self.staging.as_ref().unwrap();
        let result = (|| -> anyhow::Result<Vec<u8>> {
            let area = D3D11_BOX {
                left,
                top,
                front: 0,
                right: left + width,
                bottom: top + height,
                back: 1,
            };
            self.context
                .CopySubresourceRegion(staging, 0, 0, 0, 0, &source, 0, Some(&area));
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.context
                .Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .map_err(device)?;
            let row = width as usize * 4;
            let mut pixels = vec![0; row * height as usize];
            for y in 0..height as usize {
                let src = std::slice::from_raw_parts(
                    mapped.pData.cast::<u8>().add(y * mapped.RowPitch as usize),
                    row,
                );
                pixels[y * row..(y + 1) * row].copy_from_slice(src);
            }
            self.context.Unmap(staging, 0);
            Ok(pixels)
        })();
        if let Some(m) = mutex {
            m.ReleaseSync(0).map_err(device)?;
        }
        Ok(Pixels {
            width,
            height,
            bgra: desc.Format == DXGI_FORMAT_B8G8R8A8_UNORM,
            premultiplied: result?,
        })
    }
}
