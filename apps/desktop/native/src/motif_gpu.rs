//! Persistent RGBA transport pool, independent of the optional FFmpeg addon.
//! All D3D objects and operations live on ONE worker. Caller owns admission and
//! must finish the consumer read before reusing a slot (same contract as video).
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use std::sync::mpsc;
use windows::core::{Interface, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HMODULE};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::{IDXGIKeyedMutex, IDXGIResource1};

type Reply = tokio::sync::oneshot::Sender<Result<(), String>>;

/// Disk frames have straight alpha; Electron imports premultiplied textures.
fn premultiply(pixels: &mut [u8]) {
    for px in pixels.as_chunks_mut::<4>().0 {
        match px[3] {
            0 => px[..3].fill(0),
            255 => {}
            alpha => {
                for c in &mut px[..3] {
                    *c = ((u32::from(*c) * u32::from(alpha) + 127) / 255) as u8;
                }
            }
        }
    }
}

enum Command {
    Upload(String, usize, Reply),
    Copy(usize, usize, Reply),
    Stop,
}

#[napi]
pub struct MotifGpuPool {
    tx: Option<mpsc::Sender<Command>>,
    handles: Vec<Vec<u8>>,
}

#[napi]
impl MotifGpuPool {
    #[napi(constructor)]
    pub fn new(width: u32, height: u32, count: u32, bgra: Option<bool>) -> napi::Result<Self> {
        if width == 0
            || height == 0
            || count == 0
            || count > 4
            || u64::from(width) * u64::from(height) * 4 * u64::from(count) > 128 * 1024 * 1024
        {
            return Err(napi::Error::from_reason("Motif GPU pool exceeds budget"));
        }
        let (tx, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("motif-gpu".into())
            .spawn(move || {
                let state = unsafe { Pool::new(width, height, count, bgra.unwrap_or(false)) };
                match state {
                    Err(e) => {
                        let _ = ready_tx.send(Err(e.to_string()));
                    }
                    Ok(pool) => {
                        let handles = pool
                            .slots
                            .iter()
                            .map(|s| (s.handle.0 as usize).to_le_bytes().to_vec())
                            .collect();
                        if ready_tx.send(Ok(handles)).is_err() {
                            return;
                        }
                        while let Ok(command) = rx.recv() {
                            let (path, slot, reply) = match command {
                                Command::Upload(path, slot, reply) => (path, slot, reply),
                                Command::Copy(handle, slot, reply) => {
                                    let result = unsafe { pool.copy(handle, slot) };
                                    let _ = reply.send(result.map_err(|e| e.to_string()));
                                    continue;
                                }
                                Command::Stop => break,
                            };
                            let result = (|| {
                                let (w, h, mut pixels) = crate::motif_frame::read_pixels(&path)?;
                                anyhow::ensure!(
                                    w == width && h == height,
                                    "Motif GPU size changed"
                                );
                                premultiply(&mut pixels);
                                unsafe { pool.upload(slot, &pixels) }
                            })();
                            let _ = reply.send(result.map_err(|e: anyhow::Error| e.to_string()));
                        }
                    }
                }
            })
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let handles = ready_rx
            .recv()
            .map_err(|e| napi::Error::from_reason(e.to_string()))?
            .map_err(napi::Error::from_reason)?;
        Ok(Self {
            tx: Some(tx),
            handles,
        })
    }

    #[napi]
    pub fn handles(&self) -> Vec<Buffer> {
        self.handles.iter().cloned().map(Buffer::from).collect()
    }

    #[napi]
    pub async fn upload_file(&self, path: String, slot: u32) -> napi::Result<()> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.tx
            .as_ref()
            .ok_or_else(|| napi::Error::from_reason("Motif GPU pool closed"))?
            .send(Command::Upload(path, slot as usize, tx))
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        rx.await
            .map_err(|e| napi::Error::from_reason(e.to_string()))?
            .map_err(napi::Error::from_reason)
    }

    /// Copy an OSR texture into our own pool before releasing Electron's scarce
    /// capture surface. Completion includes the GPU copy, not just submission.
    #[napi]
    pub async fn copy_texture(&self, handle: Buffer, slot: u32) -> napi::Result<()> {
        let bits: [u8; 8] = handle
            .as_ref()
            .try_into()
            .map_err(|_| napi::Error::from_reason("Invalid texture handle"))?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.tx
            .as_ref()
            .ok_or_else(|| napi::Error::from_reason("Motif GPU pool closed"))?
            .send(Command::Copy(
                u64::from_le_bytes(bits) as usize,
                slot as usize,
                tx,
            ))
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        rx.await
            .map_err(|e| napi::Error::from_reason(e.to_string()))?
            .map_err(napi::Error::from_reason)
    }

    #[napi]
    pub fn close(&mut self) {
        if let Some(tx) = self.tx.take() {
            let _ = tx.send(Command::Stop);
        }
    }
}
impl Drop for MotifGpuPool {
    fn drop(&mut self) {
        self.close();
    }
}

struct Slot {
    texture: ID3D11Texture2D,
    mutex: IDXGIKeyedMutex,
    handle: HANDLE,
}
impl Drop for Slot {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}
struct Pool {
    device: ID3D11Device1,
    context: ID3D11DeviceContext,
    query: ID3D11Query,
    width: u32,
    slots: Vec<Slot>,
}
impl Pool {
    unsafe fn new(width: u32, height: u32, count: u32, bgra: bool) -> anyhow::Result<Self> {
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
        let device = device.ok_or_else(|| anyhow::anyhow!("No D3D11 device"))?;
        let context = context.ok_or_else(|| anyhow::anyhow!("No D3D11 context"))?;
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: if bgra {
                DXGI_FORMAT_B8G8R8A8_UNORM
            } else {
                DXGI_FORMAT_R8G8B8A8_UNORM
            },
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
            MiscFlags: (D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0
                | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0) as u32,
            ..Default::default()
        };
        let mut slots = Vec::new();
        for _ in 0..count {
            let mut texture = None;
            device.CreateTexture2D(&desc, None, Some(&mut texture))?;
            let texture = texture.unwrap();
            let mutex = texture.cast()?;
            let resource: IDXGIResource1 = texture.cast()?;
            let handle = resource.CreateSharedHandle(None, 0x80000001, PCWSTR::null())?;
            slots.push(Slot {
                texture,
                mutex,
                handle,
            });
        }
        let mut query = None;
        device.CreateQuery(
            &D3D11_QUERY_DESC {
                Query: D3D11_QUERY_EVENT,
                MiscFlags: 0,
            },
            Some(&mut query),
        )?;
        Ok(Self {
            device: device.cast()?,
            context,
            query: query.unwrap(),
            width,
            slots,
        })
    }

    unsafe fn upload(&self, slot: usize, pixels: &[u8]) -> anyhow::Result<()> {
        self.write(slot, |texture| {
            self.context.UpdateSubresource(
                texture,
                0,
                None,
                pixels.as_ptr().cast(),
                self.width * 4,
                0,
            );
        })
    }

    unsafe fn copy(&self, handle: usize, slot: usize) -> anyhow::Result<()> {
        let source: ID3D11Texture2D = self.device.OpenSharedResource1(HANDLE(handle as *mut _))?;
        let target = self
            .slots
            .get(slot)
            .ok_or_else(|| anyhow::anyhow!("Invalid Motif GPU slot"))?;
        let (mut src, mut dst) = (
            D3D11_TEXTURE2D_DESC::default(),
            D3D11_TEXTURE2D_DESC::default(),
        );
        source.GetDesc(&mut src);
        target.texture.GetDesc(&mut dst);
        anyhow::ensure!(
            src.Width == dst.Width && src.Height == dst.Height && src.Format == dst.Format,
            "OSR texture dimensions/format changed"
        );
        let mutex = source.cast::<IDXGIKeyedMutex>().ok();
        if let Some(ref mutex) = mutex {
            let hr = (Interface::vtable(mutex).AcquireSync)(Interface::as_raw(mutex), 0, 1000);
            anyhow::ensure!(hr.0 == 0, "OSR mutex unavailable: {hr:?}");
        }
        let result = self.write(slot, |texture| self.context.CopyResource(texture, &source));
        if let Some(mutex) = mutex {
            mutex.ReleaseSync(0)?;
        }
        result
    }

    unsafe fn write(
        &self,
        slot: usize,
        write: impl FnOnce(&ID3D11Texture2D),
    ) -> anyhow::Result<()> {
        let slot = self
            .slots
            .get(slot)
            .ok_or_else(|| anyhow::anyhow!("Invalid Motif GPU slot"))?;
        let hr =
            (Interface::vtable(&slot.mutex).AcquireSync)(Interface::as_raw(&slot.mutex), 0, 1000);
        anyhow::ensure!(hr.0 == 0, "Motif GPU mutex unavailable: {hr:?}");
        // Always release after acquisition, even when device completion fails.
        let result = (|| {
            write(&slot.texture);
            self.context.End(&self.query);
            self.context.Flush();
            let start = std::time::Instant::now();
            loop {
                let mut ready = 0u32;
                self.context
                    .GetData(&self.query, Some((&mut ready as *mut u32).cast()), 4, 0)?;
                if ready != 0 {
                    break;
                }
                anyhow::ensure!(start.elapsed().as_secs() < 5, "Motif GPU upload timed out");
                std::thread::sleep(std::time::Duration::from_micros(100));
            }
            Ok(())
        })();
        let release = slot.mutex.ReleaseSync(0);
        result?;
        release?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::premultiply;

    #[test]
    fn premultiplication_preserves_rounding_for_every_alpha_and_channel() {
        let mut pixels = Vec::new();
        for alpha in 0..=255u8 {
            for channel in 0..=255u8 {
                pixels.extend_from_slice(&[channel, 255 - channel, channel ^ 127, alpha]);
            }
        }
        let mut expected = pixels.clone();
        for px in expected.as_chunks_mut::<4>().0 {
            let alpha = u32::from(px[3]);
            for c in &mut px[..3] {
                *c = ((u32::from(*c) * alpha + 127) / 255) as u8;
            }
        }
        premultiply(&mut pixels);
        assert_eq!(pixels, expected);
    }
}
