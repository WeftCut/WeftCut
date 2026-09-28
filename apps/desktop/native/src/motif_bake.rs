//! OSR texture to the existing straight-RGBA/LZ4 cache, without PNG or pixel IPC.
//! D3D11 device/staging resources stay on one worker; callers retain the OSR lease.
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use std::sync::mpsc;

use windows::core::Interface;
use windows::Win32::Foundation::{HANDLE, HMODULE};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::IDXGIKeyedMutex;

fn error(e: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(e.to_string())
}

type Reply = tokio::sync::oneshot::Sender<Result<Buffer, String>>;

#[napi]
pub struct MotifTextureEncoder {
    tx: Option<mpsc::Sender<(usize, Reply)>>,
}

#[napi]
impl MotifTextureEncoder {
    #[napi(constructor)]
    pub fn new() -> napi::Result<Self> {
        let (tx, rx) = mpsc::channel::<(usize, Reply)>();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("motif-bake".into())
            .spawn(move || {
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
            })
            .map_err(error)?;
        ready_rx.recv().map_err(error)?.map_err(error)?;
        Ok(Self { tx: Some(tx) })
    }

    #[napi]
    pub async fn encode(&self, handle: Buffer) -> napi::Result<Buffer> {
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

    unsafe fn encode(&mut self, handle: usize) -> anyhow::Result<Buffer> {
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

        straighten(&mut rgba, desc.Format == DXGI_FORMAT_B8G8R8A8_UNORM);

        let bytes = crate::motif_frame::encode(desc.Width, desc.Height, &rgba, true)?;
        Ok(bytes.into())
    }
}

fn straighten(rgba: &mut [u8], bgra: bool) {
    for px in rgba.as_chunks_mut::<4>().0 {
        if bgra {
            px.swap(0, 2);
        }
        let alpha = u32::from(px[3]);
        for c in &mut px[..3] {
            *c = (u32::from(*c) * 255 + alpha / 2)
                .checked_div(alpha)
                .unwrap_or(0)
                .min(255) as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::straighten;

    #[test]
    fn every_valid_premultiplied_channel_roundtrips_exactly() {
        for alpha in 0..=255u32 {
            for channel in 0..=alpha {
                let mut pixel = [channel as u8, 0, 0, alpha as u8];
                straighten(&mut pixel, false);
                assert_eq!((u32::from(pixel[0]) * alpha + 127) / 255, channel);
                assert_eq!(pixel[3], alpha as u8);
            }
        }
    }

    #[test]
    fn bgra_is_reordered_and_transparent_rgb_is_cleared() {
        let mut pixels = [16, 32, 64, 128, 20, 30, 40, 0];
        straighten(&mut pixels, true);
        assert_eq!(pixels, [128, 64, 32, 128, 0, 0, 0, 0]);
    }
}
