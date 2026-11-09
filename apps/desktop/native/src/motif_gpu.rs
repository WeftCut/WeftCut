//! Persistent RGBA transport pool, independent of the optional FFmpeg addon.
//! All D3D objects and operations live on ONE worker. Caller owns admission and
//! must finish the consumer read before reusing a slot (same contract as video).
use crate::motif_error::{coded, to_napi, MotifCode};
use crate::motif_limits::{textures_fit, MAX_POOL_SLOTS};
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use std::sync::mpsc;
use windows::core::{Interface, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HMODULE};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::{IDXGIKeyedMutex, IDXGIResource1};

/// Worker replies carry `format!("{e:#}")`, which keeps a `[motif:<code>]` tag.
type Reply = tokio::sync::oneshot::Sender<Result<(), String>>;
type TimedReply = tokio::sync::oneshot::Sender<Result<MotifUploadTiming, String>>;

/// `IDXGIKeyedMutex::AcquireSync` returns this success code when the other
/// side still holds the key after the wait.
const WAIT_TIMEOUT: i32 = 0x102;

/// The longest a Motif GPU path waits for a keyed mutex. A protocol deadline,
/// like those in `MOTIF_DEADLINES` (`src/shared/motifs/tuning.ts`).
const ACQUIRE_SYNC_TIMEOUT_MS: u32 = 1000;

/// Takes `mutex` with key 0, waiting at most `ACQUIRE_SYNC_TIMEOUT_MS`. A
/// timeout is transient: the other side still holds the key.
pub(crate) unsafe fn acquire_sync(mutex: &IDXGIKeyedMutex, what: &str) -> anyhow::Result<()> {
    let hr = (Interface::vtable(mutex).AcquireSync)(
        Interface::as_raw(mutex),
        0,
        ACQUIRE_SYNC_TIMEOUT_MS,
    );
    match hr.0 {
        0 => Ok(()),
        WAIT_TIMEOUT => Err(coded(
            MotifCode::Transient,
            anyhow::anyhow!("{what} mutex still held"),
        )),
        _ => Err(coded(
            MotifCode::Device,
            anyhow::anyhow!("{what} mutex unavailable: {hr:?}"),
        )),
    }
}

/// A D3D11 or DXGI call failed.
pub(crate) fn device(e: impl Into<anyhow::Error>) -> anyhow::Error {
    coded(MotifCode::Device, e)
}

fn closed() -> napi::Error {
    to_napi(coded(
        MotifCode::Closed,
        anyhow::anyhow!("Motif GPU pool closed"),
    ))
}

/// The worker is gone or dropped the reply without answering.
fn worker_lost(e: impl std::fmt::Display) -> napi::Error {
    to_napi(device(anyhow::anyhow!("Motif GPU worker lost: {e}")))
}

/// Stage times of one upload, in milliseconds.
#[napi(object)]
#[derive(Clone, Copy, Default)]
pub struct MotifUploadTiming {
    pub read: crate::motif_frame::MotifReadTiming,
    /// Mapping and unmapping the staging texture. Each band premultiplies into
    /// it as it decodes, inside `read.decode_ms`.
    pub map_ms: f64,
    /// Waiting for the consumer to release the slot's keyed mutex.
    pub acquire_ms: f64,
    /// The copy into the slot through device completion.
    pub gpu_ms: f64,
}

enum Command {
    Upload(String, usize, u32, TimedReply),
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
    /// `upload` pools read stored frames and hold a staging texture as large
    /// as a slot; the caller's budget counts it.
    pub fn new(
        width: u32,
        height: u32,
        count: u32,
        bgra: Option<bool>,
        upload: Option<bool>,
    ) -> napi::Result<Self> {
        let upload = upload.unwrap_or(false);
        if count == 0
            || count > MAX_POOL_SLOTS
            || !textures_fit(width, height, count + u32::from(upload))
        {
            return Err(to_napi(coded(
                MotifCode::Oversize,
                anyhow::anyhow!("Motif GPU pool exceeds budget"),
            )));
        }
        let (tx, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("motif-gpu".into())
            .spawn(move || {
                let state =
                    unsafe { Pool::new(width, height, count, bgra.unwrap_or(false), upload) };
                match state {
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("{:#}", device(e))));
                    }
                    Ok(pool) => {
                        let _live = Live::new();
                        let handles = pool
                            .slots
                            .iter()
                            .map(|s| (s.handle.0 as usize).to_le_bytes().to_vec())
                            .collect();
                        if ready_tx.send(Ok(handles)).is_err() {
                            return;
                        }
                        while let Ok(command) = rx.recv() {
                            let (path, slot, div, reply) = match command {
                                Command::Upload(path, slot, div, reply) => (path, slot, div, reply),
                                Command::Copy(handle, slot, reply) => {
                                    let result = unsafe { pool.copy(handle, slot) };
                                    let _ = reply.send(result.map_err(|e| format!("{e:#}")));
                                    continue;
                                }
                                Command::Stop => break,
                            };
                            let result = unsafe { pool.upload(slot, &path, div) };
                            let _ = reply.send(result.map_err(|e| format!("{e:#}")));
                        }
                    }
                }
            })
            .map_err(|e| to_napi(device(e)))?;
        let handles = ready_rx
            .recv()
            .map_err(worker_lost)?
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

    /// Reads, verifies and downscales the frame by `div` (default 1) before the
    /// upload; the pool must be created at the scaled size. A `[motif:miss]`
    /// error is a miss; any other error is a transport failure.
    #[napi]
    pub async fn upload_file(
        &self,
        path: String,
        slot: u32,
        div: Option<u32>,
    ) -> napi::Result<MotifUploadTiming> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.tx
            .as_ref()
            .ok_or_else(closed)?
            .send(Command::Upload(path, slot as usize, div.unwrap_or(1), tx))
            .map_err(worker_lost)?;
        rx.await
            .map_err(worker_lost)?
            .map_err(napi::Error::from_reason)
    }

    /// Copy an OSR texture's top-left slot-sized picture into our own pool before
    /// releasing Electron's scarce capture surface. Completion includes the GPU
    /// copy, not just submission.
    #[napi]
    pub async fn copy_texture(&self, handle: Buffer, slot: u32) -> napi::Result<()> {
        let bits: [u8; 8] = handle
            .as_ref()
            .try_into()
            .map_err(|_| napi::Error::from_reason("Invalid texture handle"))?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.tx
            .as_ref()
            .ok_or_else(closed)?
            .send(Command::Copy(
                u64::from_le_bytes(bits) as usize,
                slot as usize,
                tx,
            ))
            .map_err(worker_lost)?;
        rx.await
            .map_err(worker_lost)?
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
/// Counts live pool workers; the last to stop frees the kept band buffers.
struct Live;
static LIVE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

impl Live {
    fn new() -> Self {
        LIVE.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Self
    }
}
impl Drop for Live {
    fn drop(&mut self) {
        if LIVE.fetch_sub(1, std::sync::atomic::Ordering::SeqCst) == 1 {
            crate::motif_frame::release_scratch();
        }
    }
}

struct Pool {
    device: ID3D11Device1,
    context: ID3D11DeviceContext,
    query: ID3D11Query,
    width: u32,
    height: u32,
    /// A shared texture cannot be CPU-writable: uploads land here first, so the
    /// slot's mutex covers one GPU copy instead of a CPU upload. Only an
    /// upload pool has one.
    staging: Option<ID3D11Texture2D>,
    slots: Vec<Slot>,
}
impl Pool {
    unsafe fn new(
        width: u32,
        height: u32,
        count: u32,
        bgra: bool,
        upload: bool,
    ) -> anyhow::Result<Self> {
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
        let mut staging = None;
        if upload {
            device.CreateTexture2D(
                &D3D11_TEXTURE2D_DESC {
                    Usage: D3D11_USAGE_STAGING,
                    BindFlags: 0,
                    CPUAccessFlags: D3D11_CPU_ACCESS_WRITE.0 as u32,
                    MiscFlags: 0,
                    ..desc
                },
                None,
                Some(&mut staging),
            )?;
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
            height,
            staging,
            slots,
        })
    }

    /// Reads `path` scaled by `div`, premultiplying each band into the staging
    /// texture as it decodes, then copies it into the slot.
    unsafe fn upload(
        &self,
        slot: usize,
        path: &str,
        div: u32,
    ) -> anyhow::Result<MotifUploadTiming> {
        let staging = self
            .staging
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Motif GPU pool does not upload"))?;
        let row = self.width as usize * 4;
        let start = std::time::Instant::now();
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        // The previous copy out of the staging texture completed before its
        // slot was released, so this never waits on the GPU.
        self.context
            .Map(staging, 0, D3D11_MAP_WRITE, 0, Some(&mut mapped))
            .map_err(device)?;
        let pitch = mapped.RowPitch as usize;
        let len = pitch * (self.height as usize - 1) + row;
        // SAFETY: the mapping holds `height` rows `pitch` apart until Unmap.
        let out = std::slice::from_raw_parts_mut(mapped.pData.cast::<u8>(), len);
        let read = crate::motif_frame::read_into(
            path,
            div,
            (self.width, self.height),
            out,
            pitch,
            &|pixels, rows| crate::motif_pixels::premultiply_rows(pixels, rows, row, pitch),
        );
        self.context.Unmap(staging, 0);
        let read = read?;
        let map_ms =
            (start.elapsed().as_secs_f64() * 1000.0 - read.read_ms - read.decode_ms).max(0.0);
        // Waits for the copy even though the keyed mutex would order it (ADR 0078).
        let (acquire_ms, gpu_ms) =
            self.write(slot, |texture| self.context.CopyResource(texture, staging))?;
        Ok(MotifUploadTiming {
            read,
            map_ms,
            acquire_ms,
            gpu_ms,
        })
    }

    unsafe fn copy(&self, handle: usize, slot: usize) -> anyhow::Result<()> {
        let source: ID3D11Texture2D = self
            .device
            .OpenSharedResource1(HANDLE(handle as *mut _))
            .map_err(device)?;
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
        // The capture host's surface keeps marker rows below the picture.
        if src.Width != dst.Width || src.Height < dst.Height || src.Format != dst.Format {
            return Err(device(anyhow::anyhow!(
                "OSR texture dimensions/format changed"
            )));
        }
        let mutex = source.cast::<IDXGIKeyedMutex>().ok();
        if let Some(ref mutex) = mutex {
            acquire_sync(mutex, "OSR")?;
        }
        let picture = D3D11_BOX {
            left: 0,
            top: 0,
            front: 0,
            right: dst.Width,
            bottom: dst.Height,
            back: 1,
        };
        let result = self.write(slot, |texture| {
            self.context
                .CopySubresourceRegion(texture, 0, 0, 0, 0, &source, 0, Some(&picture))
        });
        if let Some(mutex) = mutex {
            mutex.ReleaseSync(0).map_err(device)?;
        }
        result.map(|_| ())
    }

    unsafe fn write(
        &self,
        slot: usize,
        write: impl FnOnce(&ID3D11Texture2D),
    ) -> anyhow::Result<(f64, f64)> {
        let slot = self
            .slots
            .get(slot)
            .ok_or_else(|| anyhow::anyhow!("Invalid Motif GPU slot"))?;
        let acquire = std::time::Instant::now();
        acquire_sync(&slot.mutex, "Motif GPU")?;
        let acquire_ms = acquire.elapsed().as_secs_f64() * 1000.0;
        // Always release after acquisition, even when device completion fails.
        let gpu = std::time::Instant::now();
        let result = (|| -> anyhow::Result<()> {
            write(&slot.texture);
            self.context.End(&self.query);
            self.context.Flush();
            let start = std::time::Instant::now();
            loop {
                let mut ready = 0u32;
                self.context
                    .GetData(&self.query, Some((&mut ready as *mut u32).cast()), 4, 0)
                    .map_err(device)?;
                if ready != 0 {
                    break;
                }
                if start.elapsed().as_secs() >= 5 {
                    return Err(device(anyhow::anyhow!("Motif GPU upload timed out")));
                }
                std::thread::sleep(std::time::Duration::from_micros(100));
            }
            Ok(())
        })();
        let gpu_ms = gpu.elapsed().as_secs_f64() * 1000.0;
        let release = slot.mutex.ReleaseSync(0);
        result?;
        release.map_err(device)?;
        Ok((acquire_ms, gpu_ms))
    }
}
