//! Persistent RGBA transport pool, independent of the optional FFmpeg addon.
//! All D3D objects and operations live on ONE worker. Caller owns admission and
//! must finish the consumer read before reusing the slot (same contract as video).
use crate::d3d::{
    create_device, create_texture, device, open_shared, wait_idle, with_key, DeviceWorker, NtHandle,
};
use crate::motif_error::{coded, to_napi, MotifCode};
use crate::motif_limits::textures_fit;
use crate::motif_runtime::ScratchHold;
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use windows::core::{Interface, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::{IDXGIKeyedMutex, IDXGIResource1};

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

/// One shared texture, the slot, and the worker that fills it.
#[napi]
pub struct MotifGpuPool {
    worker: DeviceWorker<Pool>,
    handle: Vec<u8>,
}

#[napi]
impl MotifGpuPool {
    /// An RGBA pool that reads stored frames. It holds a staging texture as
    /// large as its slot, which the caller's budget counts.
    #[napi(factory)]
    pub fn for_upload(width: u32, height: u32) -> napi::Result<Self> {
        Self::open(width, height, false, true)
    }

    /// A pool that copies shared textures of `bgra` or RGBA format.
    #[napi(factory)]
    pub fn for_copy(width: u32, height: u32, bgra: bool) -> napi::Result<Self> {
        Self::open(width, height, bgra, false)
    }

    fn open(width: u32, height: u32, bgra: bool, upload: bool) -> napi::Result<Self> {
        if !textures_fit(width, height, 1 + u32::from(upload)) {
            return Err(to_napi(coded(
                MotifCode::Oversize,
                anyhow::anyhow!("Motif GPU pool exceeds budget"),
            )));
        }
        let (worker, handle) = DeviceWorker::open("motif-gpu", "Motif GPU pool", move || {
            let pool = unsafe { Pool::new(width, height, bgra, upload) }?;
            let handle = (pool.slot.handle.0 as usize).to_le_bytes().to_vec();
            Ok((pool, handle))
        })?;
        Ok(Self { worker, handle })
    }

    /// The slot's NT handle, 8 little-endian bytes.
    #[napi]
    pub fn handle(&self) -> Buffer {
        self.handle.clone().into()
    }

    /// Reads, verifies and downscales the frame by `div` before the upload; the
    /// pool must be created at the scaled size. A `[motif:miss]` error is a
    /// miss; any other error is a transport failure.
    #[napi]
    pub async fn upload(&self, path: String, div: u32) -> napi::Result<MotifUploadTiming> {
        self.worker
            .run(move |pool| unsafe { pool.upload(&path, div) })
            .await
    }

    /// Copy an OSR texture's top-left slot-sized picture into our own pool before
    /// releasing Electron's scarce capture surface. Completion includes the GPU
    /// copy, not just submission.
    #[napi]
    pub async fn copy(&self, handle: Buffer) -> napi::Result<()> {
        let handle = NtHandle::from_buffer(&handle)?;
        self.worker
            .run(move |pool| unsafe { pool.copy(handle) })
            .await
    }

    #[napi]
    pub fn close(&mut self) {
        self.worker.close();
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
    height: u32,
    /// A shared texture cannot be CPU-writable: uploads land here first, so the
    /// slot's mutex covers one GPU copy instead of a CPU upload. Only an
    /// upload pool has one.
    staging: Option<ID3D11Texture2D>,
    slot: Slot,
    /// Only an upload pool decodes stored frames into band buffers.
    _scratch: Option<ScratchHold>,
}
impl Pool {
    unsafe fn new(width: u32, height: u32, bgra: bool, upload: bool) -> anyhow::Result<Self> {
        let (device, context) = create_device()?;
        let device: ID3D11Device1 = device.cast()?;
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
        let texture = create_texture(&device, &desc)?;
        let mutex = texture.cast()?;
        let resource: IDXGIResource1 = texture.cast()?;
        let handle = resource.CreateSharedHandle(None, 0x80000001, PCWSTR::null())?;
        let slot = Slot {
            texture,
            mutex,
            handle,
        };
        let staging = if upload {
            Some(create_texture(
                &device,
                &D3D11_TEXTURE2D_DESC {
                    Usage: D3D11_USAGE_STAGING,
                    BindFlags: 0,
                    CPUAccessFlags: D3D11_CPU_ACCESS_WRITE.0 as u32,
                    MiscFlags: 0,
                    ..desc
                },
            )?)
        } else {
            None
        };
        let mut query = None;
        device.CreateQuery(
            &D3D11_QUERY_DESC {
                Query: D3D11_QUERY_EVENT,
                MiscFlags: 0,
            },
            Some(&mut query),
        )?;
        let query = query.ok_or_else(|| anyhow::anyhow!("CreateQuery returned no query"))?;
        Ok(Self {
            device,
            context,
            query,
            width,
            height,
            staging,
            slot,
            _scratch: upload.then(ScratchHold::new),
        })
    }

    /// Reads `path` scaled by `div`, premultiplying each band into the staging
    /// texture as it decodes, then copies it into the slot.
    unsafe fn upload(&self, path: &str, div: u32) -> anyhow::Result<MotifUploadTiming> {
        let staging = self
            .staging
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Motif GPU pool does not upload"))?;
        let row = self.width as usize * 4;
        let start = std::time::Instant::now();
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        // The previous copy out of the staging texture completed before the
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
            self.write(|texture| self.context.CopyResource(texture, staging))?;
        Ok(MotifUploadTiming {
            read,
            map_ms,
            acquire_ms,
            gpu_ms,
        })
    }

    unsafe fn copy(&self, handle: NtHandle) -> anyhow::Result<()> {
        let source = open_shared(&self.device, handle)?;
        let (src, mut dst) = (source.desc, D3D11_TEXTURE2D_DESC::default());
        self.slot.texture.GetDesc(&mut dst);
        // The capture host's surface keeps marker rows below the picture.
        if src.Width != dst.Width || src.Height < dst.Height || src.Format != dst.Format {
            return Err(device(anyhow::anyhow!(
                "OSR texture dimensions/format changed"
            )));
        }
        let picture = D3D11_BOX {
            left: 0,
            top: 0,
            front: 0,
            right: dst.Width,
            bottom: dst.Height,
            back: 1,
        };
        source.with_key("OSR", |osr| {
            self.write(|texture| {
                self.context
                    .CopySubresourceRegion(texture, 0, 0, 0, 0, osr, 0, Some(&picture))
            })
            .map(|_| ())
        })
    }

    /// Runs `write` into the slot under its keyed mutex and waits for the
    /// device to finish it. Returns the acquire and GPU times.
    unsafe fn write(&self, write: impl FnOnce(&ID3D11Texture2D)) -> anyhow::Result<(f64, f64)> {
        let slot = &self.slot;
        let acquire = std::time::Instant::now();
        with_key(&slot.mutex, "Motif GPU", || {
            let acquire_ms = acquire.elapsed().as_secs_f64() * 1000.0;
            let gpu = std::time::Instant::now();
            write(&slot.texture);
            wait_idle(&self.context, &self.query)?;
            Ok((acquire_ms, gpu.elapsed().as_secs_f64() * 1000.0))
        })
    }
}
