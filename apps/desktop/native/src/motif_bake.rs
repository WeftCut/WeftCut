//! OSR texture to the straight-RGBA frame cache, without PNG or pixel IPC, and
//! the capture host's frame marker check. Each reader keeps its D3D11 device
//! and staging texture on its own worker. `MotifTextureEncoder::read` runs
//! under the caller's OSR lease; `finish` runs after it (ADR 0158).
use crate::d3d::{create_device, create_texture, device, open_shared, DeviceWorker, NtHandle};
use crate::motif_error::{coded, MotifCode};
use crate::motif_limits::textures_fit;
use crate::motif_pixels::{convert, MotifPixelSource, MotifPixelTarget, Pixels};
use crate::motif_runtime::blocking;
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;

/// For errors that are not `anyhow::Error`; those go through `to_napi`.
fn error(e: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(e.to_string())
}

/// One frame read back from a texture. Its pixels stay native until `finish`.
#[napi]
pub struct MotifRawFrame {
    pixels: std::sync::Mutex<Option<Pixels>>,
}

#[napi]
impl MotifRawFrame {
    /// Converts off the D3D11 worker, so the next `read` does not wait for this
    /// frame: to a stored frame, or a PNG for captures that leave the app as
    /// images.
    #[napi]
    pub async fn finish(&self, to: MotifPixelTarget) -> napi::Result<Buffer> {
        let pixels = self
            .pixels
            .lock()
            .map_err(error)?
            .take()
            .ok_or_else(|| error("motif frame already finished"))?;
        blocking(move || convert(pixels, to).map(Buffer::from)).await
    }
}

/// One D3D11 device and its staging texture on a dedicated thread.
fn open_reader(thread: &str) -> napi::Result<DeviceWorker<Reader>> {
    let (worker, ()) = DeviceWorker::open(thread, "Motif reader", || {
        Ok((unsafe { Reader::new() }?, ()))
    })?;
    Ok(worker)
}

async fn request(
    worker: &DeviceWorker<Reader>,
    handle: Buffer,
    region: Region,
) -> napi::Result<Pixels> {
    let handle = NtHandle::from_buffer(&handle)?;
    worker
        .run(move |reader| unsafe { reader.read(handle, region) })
        .await
}

#[napi]
pub struct MotifTextureEncoder {
    worker: DeviceWorker<Reader>,
}

#[napi]
impl MotifTextureEncoder {
    #[napi(constructor)]
    pub fn new() -> napi::Result<Self> {
        Ok(Self {
            worker: open_reader("motif-bake")?,
        })
    }

    /// The picture: the texture's top `height` rows, above the capture host's
    /// marker rows.
    #[napi]
    pub async fn read(&self, handle: Buffer, height: u32) -> napi::Result<MotifRawFrame> {
        let pixels = request(&self.worker, handle, Region::Top(height)).await?;
        Ok(MotifRawFrame {
            pixels: std::sync::Mutex::new(Some(pixels)),
        })
    }

    #[napi]
    pub fn close(&mut self) {
        self.worker.close();
    }
}

/// Reads the frame marker of capture host textures. Its own thread, so a
/// marker check never queues behind a whole-picture readback.
#[napi]
pub struct MotifMarkerReader {
    worker: DeviceWorker<Reader>,
}

#[napi]
impl MotifMarkerReader {
    #[napi(constructor)]
    pub fn new() -> napi::Result<Self> {
        Ok(Self {
            worker: open_reader("motif-marker")?,
        })
    }

    /// The texture's bottom `rows` rows, the capture host's marker rows, as
    /// RGBA, row after row.
    #[napi]
    pub async fn read(&self, handle: Buffer, rows: u32) -> napi::Result<Buffer> {
        let mut marker = request(&self.worker, handle, Region::Bottom(rows)).await?;
        if marker.source == MotifPixelSource::PremultipliedBgra {
            for px in marker.data.as_chunks_mut::<4>().0 {
                px.swap(0, 2);
            }
        }
        Ok(marker.data.into())
    }

    #[napi]
    pub fn close(&mut self) {
        self.worker.close();
    }
}

/// The part of an OSR texture a read returns.
#[derive(Clone, Copy)]
enum Region {
    /// The top rows.
    Top(u32),
    /// The bottom rows.
    Bottom(u32),
}

struct Reader {
    device: ID3D11Device1,
    context: ID3D11DeviceContext,
    /// Kept while reads keep its size and format.
    staging: Option<(ID3D11Texture2D, (u32, u32, DXGI_FORMAT))>,
}

impl Reader {
    unsafe fn new() -> anyhow::Result<Self> {
        let (device, context) = create_device()?;
        Ok(Self {
            device: device.cast()?,
            context,
            staging: None,
        })
    }

    unsafe fn read(&mut self, handle: NtHandle, region: Region) -> anyhow::Result<Pixels> {
        let source = open_shared(&self.device, handle)?;
        let desc = source.desc;
        if desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM && desc.Format != DXGI_FORMAT_R8G8B8A8_UNORM {
            return Err(device(anyhow::anyhow!("unsupported OSR format")));
        }
        if !textures_fit(desc.Width, desc.Height, 1) {
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
            Region::Bottom(rows) => {
                anyhow::ensure!(
                    rows > 0 && rows <= desc.Height,
                    "{rows} rows of a {}-row texture",
                    desc.Height
                );
                (0, desc.Height - rows, desc.Width, rows)
            }
        };
        let size = (width, height, desc.Format);
        let staging = match &self.staging {
            Some((staging, kept)) if *kept == size => staging.clone(),
            _ => {
                let staging = create_texture(
                    &self.device,
                    &D3D11_TEXTURE2D_DESC {
                        Width: width,
                        Height: height,
                        Usage: D3D11_USAGE_STAGING,
                        BindFlags: 0,
                        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                        MiscFlags: 0,
                        ..desc
                    },
                )
                .map_err(device)?;
                self.staging = Some((staging.clone(), size));
                staging
            }
        };
        let data = source.with_key("OSR", |texture| {
            let area = D3D11_BOX {
                left,
                top,
                front: 0,
                right: left + width,
                bottom: top + height,
                back: 1,
            };
            self.context
                .CopySubresourceRegion(&staging, 0, 0, 0, 0, texture, 0, Some(&area));
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
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
            self.context.Unmap(&staging, 0);
            Ok(pixels)
        })?;
        Ok(Pixels {
            width,
            height,
            source: if desc.Format == DXGI_FORMAT_B8G8R8A8_UNORM {
                MotifPixelSource::PremultipliedBgra
            } else {
                MotifPixelSource::PremultipliedRgba
            },
            data,
        })
    }
}
