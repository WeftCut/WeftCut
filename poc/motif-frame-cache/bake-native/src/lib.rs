//! Benchmark-only addon. Reuses the production file codec without changing the app.
#[path = "../../../../apps/desktop/native/src/motif_frame.rs"]
mod motif_frame;

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use std::sync::mpsc;
use std::time::Instant;
use windows::core::Interface;
use windows::Win32::Foundation::{HANDLE, HMODULE};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::IDXGIKeyedMutex;

#[napi(object)]
pub struct Encoded {
    pub bytes: Buffer,
    pub readback_ms: f64,
    pub alpha_ms: f64,
    pub encode_ms: f64,
}

fn error(e: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(e.to_string())
}

#[napi]
pub async fn encode_rgba(width: u32, height: u32, rgba: Buffer) -> napi::Result<Encoded> {
    let rgba = rgba.to_vec();
    tokio::task::spawn_blocking(move || {
        let start = Instant::now();
        let bytes = motif_frame::encode(width, height, &rgba, true).map_err(error)?;
        Ok(Encoded {
            bytes: bytes.into(),
            readback_ms: 0.0,
            alpha_ms: 0.0,
            encode_ms: start.elapsed().as_secs_f64() * 1000.0,
        })
    })
    .await
    .map_err(error)?
}

type Reply = tokio::sync::oneshot::Sender<Result<Encoded, String>>;

#[napi]
pub struct TextureEncoder {
    tx: Option<mpsc::Sender<(usize, Reply)>>,
}

#[napi]
impl TextureEncoder {
    #[napi(constructor)]
    pub fn new() -> napi::Result<Self> {
        let (tx, rx) = mpsc::channel::<(usize, Reply)>();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut reader = match unsafe { Reader::new() } {
                Ok(reader) => {
                    let _ = ready_tx.send(Ok(()));
                    reader
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e.to_string()));
                    return;
                }
            };
            while let Ok((handle, reply)) = rx.recv() {
                let result = unsafe { reader.encode(handle) }.map_err(|e| e.to_string());
                let _ = reply.send(result);
            }
        });
        ready_rx.recv().map_err(error)?.map_err(error)?;
        Ok(Self { tx: Some(tx) })
    }

    #[napi]
    pub async fn encode(&self, handle: Buffer) -> napi::Result<Encoded> {
        let bits: [u8; 8] = handle.as_ref().try_into().map_err(error)?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.tx
            .as_ref()
            .ok_or_else(|| error("encoder closed"))?
            .send((u64::from_le_bytes(bits) as usize, tx))
            .map_err(error)?;
        rx.await.map_err(error)?.map_err(error)
    }

    #[napi]
    pub fn close(&mut self) {
        self.tx.take();
    }
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

    // Keep the measured prototype's explicit arithmetic and iteration unchanged.
    // This is an experimental benchmark, not the proposed production pixel loop.
    #[allow(clippy::chunks_exact_to_as_chunks, clippy::manual_checked_ops)]
    unsafe fn encode(&mut self, handle: usize) -> anyhow::Result<Encoded> {
        let start = Instant::now();
        let source: ID3D11Texture2D = self.device.OpenSharedResource1(HANDLE(handle as *mut _))?;
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        source.GetDesc(&mut desc);
        anyhow::ensure!(
            desc.Format == DXGI_FORMAT_B8G8R8A8_UNORM || desc.Format == DXGI_FORMAT_R8G8B8A8_UNORM,
            "unsupported OSR format"
        );
        anyhow::ensure!(
            desc.Width > 0
                && desc.Height > 0
                && u64::from(desc.Width) * u64::from(desc.Height) * 4 <= 128 * 1024 * 1024,
            "readback budget"
        );
        let size = (desc.Width, desc.Height, desc.Format);
        if self.size != size {
            let staging_desc = D3D11_TEXTURE2D_DESC {
                Usage: D3D11_USAGE_STAGING,
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                MiscFlags: 0,
                ..desc
            };
            let mut staging = None;
            self.device
                .CreateTexture2D(&staging_desc, None, Some(&mut staging))?;
            self.staging = staging;
            self.size = size;
        }
        let mutex = source.cast::<IDXGIKeyedMutex>().ok();
        if let Some(ref m) = mutex {
            let hr = (Interface::vtable(m).AcquireSync)(Interface::as_raw(m), 0, 1000);
            anyhow::ensure!(hr.0 == 0, "OSR mutex unavailable: {hr:?}");
        }
        let staging = self.staging.as_ref().unwrap();
        let result = (|| -> anyhow::Result<Vec<u8>> {
            self.context.CopyResource(staging, &source);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.context
                .Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
            let row = desc.Width as usize * 4;
            let mut pixels = vec![0; row * desc.Height as usize];
            for y in 0..desc.Height as usize {
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
            m.ReleaseSync(0)?;
        }
        let mut rgba = result?;
        let readback_ms = start.elapsed().as_secs_f64() * 1000.0;
        let start = Instant::now();
        for px in rgba.chunks_exact_mut(4) {
            if desc.Format == DXGI_FORMAT_B8G8R8A8_UNORM {
                px.swap(0, 2);
            }
            let alpha = u32::from(px[3]);
            for c in &mut px[..3] {
                *c = if alpha == 0 {
                    0
                } else {
                    ((u32::from(*c) * 255 + alpha / 2) / alpha).min(255) as u8
                };
            }
        }
        let alpha_ms = start.elapsed().as_secs_f64() * 1000.0;
        let start = Instant::now();
        let bytes = motif_frame::encode(desc.Width, desc.Height, &rgba, true)?;
        Ok(Encoded {
            bytes: bytes.into(),
            readback_ms,
            alpha_ms,
            encode_ms: start.elapsed().as_secs_f64() * 1000.0,
        })
    }
}
