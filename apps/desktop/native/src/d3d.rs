//! The D3D11 plumbing shared by Motif transport (`motif_gpu`, `motif_bake`) and
//! the hardware probe (`gpu_hardware`): device creation, shared textures under
//! their keyed mutex, the device-idle wait and the one worker thread a device
//! lives on. Failures carry Motif error codes except from `create_device` (a
//! plain `windows` error), `create_texture` and `NtHandle::from_buffer` (each
//! says why).
use crate::motif_error::{coded, to_napi, MotifCode};
use napi::bindgen_prelude::Buffer;
use std::sync::mpsc;
use windows::core::Interface;
use windows::Win32::Foundation::{E_FAIL, HANDLE, HMODULE};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::IDXGIKeyedMutex;

/// `IDXGIKeyedMutex::AcquireSync` returns this success code when the other
/// side still holds the key after the wait.
const WAIT_TIMEOUT: i32 = 0x102;

/// The longest a Motif GPU path waits for a keyed mutex. A protocol deadline,
/// like those in `MOTIF_DEADLINES` (`src/shared/motifs/tuning.ts`).
const ACQUIRE_SYNC_TIMEOUT_MS: u32 = 1000;

/// The longest `wait_idle` waits for the device to finish submitted work. A
/// protocol deadline, like `ACQUIRE_SYNC_TIMEOUT_MS`.
const DEVICE_IDLE_TIMEOUT_MS: u128 = 5000;

/// A hardware device with BGRA support on the default adapter, the selection
/// native preview transport uses too.
pub(crate) unsafe fn create_device() -> windows::core::Result<(ID3D11Device, ID3D11DeviceContext)> {
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
    let device = device.ok_or_else(|| windows::core::Error::new(E_FAIL, "No D3D11 device"))?;
    let context = context.ok_or_else(|| windows::core::Error::new(E_FAIL, "No D3D11 context"))?;
    Ok((device, context))
}

/// A D3D11 or DXGI call failed.
pub(crate) fn device(e: impl Into<anyhow::Error>) -> anyhow::Error {
    coded(MotifCode::Device, e)
}

/// `CreateTexture2D` with its out-parameter unwrapped. Uncoded, like any call
/// inside a `DeviceWorker::open` init.
pub(crate) unsafe fn create_texture(
    device: &ID3D11Device1,
    desc: &D3D11_TEXTURE2D_DESC,
) -> anyhow::Result<ID3D11Texture2D> {
    let mut texture = None;
    device.CreateTexture2D(desc, None, Some(&mut texture))?;
    texture.ok_or_else(|| anyhow::anyhow!("CreateTexture2D returned no texture"))
}

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

/// Runs `body` holding key 0 of `mutex`, and always releases it after the
/// acquisition. The body's error wins over a release error.
pub(crate) unsafe fn with_key<T>(
    mutex: &IDXGIKeyedMutex,
    what: &str,
    body: impl FnOnce() -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    acquire_sync(mutex, what)?;
    let result = body();
    let release = mutex.ReleaseSync(0);
    let value = result?;
    release.map_err(device)?;
    Ok(value)
}

/// Ends `query` and waits until the device has finished the work submitted
/// before it, for at most `DEVICE_IDLE_TIMEOUT_MS`.
pub(crate) unsafe fn wait_idle(
    context: &ID3D11DeviceContext,
    query: &ID3D11Query,
) -> anyhow::Result<()> {
    context.End(query);
    context.Flush();
    let start = std::time::Instant::now();
    loop {
        let mut ready = 0u32;
        context
            .GetData(query, Some((&mut ready as *mut u32).cast()), 4, 0)
            .map_err(device)?;
        if ready != 0 {
            return Ok(());
        }
        if start.elapsed().as_millis() >= DEVICE_IDLE_TIMEOUT_MS {
            return Err(device(anyhow::anyhow!("Motif GPU upload timed out")));
        }
        std::thread::sleep(std::time::Duration::from_micros(100));
    }
}

/// An NT handle to a texture another device shares, as JS passes it: the
/// handle's value in 8 little-endian bytes.
#[derive(Clone, Copy)]
pub(crate) struct NtHandle(usize);

impl NtHandle {
    /// A buffer of another length is the caller's error, so it stays untagged.
    pub(crate) fn from_buffer(handle: &Buffer) -> napi::Result<Self> {
        let bits: [u8; 8] = handle
            .as_ref()
            .try_into()
            .map_err(|_| napi::Error::from_reason("Invalid texture handle"))?;
        Ok(Self(u64::from_le_bytes(bits) as usize))
    }
}

/// A texture opened from another device's NT handle. `mutex` is absent when
/// the texture has no keyed mutex.
pub(crate) struct SharedTexture {
    pub(crate) texture: ID3D11Texture2D,
    pub(crate) desc: D3D11_TEXTURE2D_DESC,
    mutex: Option<IDXGIKeyedMutex>,
}

/// Opens `handle` on `opener`; a failure is a device failure.
pub(crate) unsafe fn open_shared(
    opener: &ID3D11Device1,
    handle: NtHandle,
) -> anyhow::Result<SharedTexture> {
    let texture: ID3D11Texture2D = opener
        .OpenSharedResource1(HANDLE(handle.0 as *mut _))
        .map_err(device)?;
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    texture.GetDesc(&mut desc);
    let mutex = texture.cast::<IDXGIKeyedMutex>().ok();
    Ok(SharedTexture {
        texture,
        desc,
        mutex,
    })
}

impl SharedTexture {
    /// Runs `body` under the texture's keyed mutex, if it has one; see `with_key`.
    pub(crate) unsafe fn with_key<T>(
        &self,
        what: &str,
        body: impl FnOnce(&ID3D11Texture2D) -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        match &self.mutex {
            Some(mutex) => with_key(mutex, what, || body(&self.texture)),
            None => body(&self.texture),
        }
    }
}

type Job<S> = Box<dyn FnOnce(&mut S) + Send>;

/// A device and the state built on it, owned by one dedicated thread: every
/// D3D11 call on it runs there, in submission order. Jobs queued before
/// `close` still run; the state drops after the last of them.
pub(crate) struct DeviceWorker<S> {
    tx: Option<mpsc::Sender<Job<S>>>,
    /// Names the worker in `closed` and `worker_lost` errors.
    what: &'static str,
}

impl<S: 'static> DeviceWorker<S> {
    /// Starts thread `thread` and builds its state with `init` there, returning
    /// once it is ready, with `init`'s second value. An `init` failure is a
    /// device failure.
    pub(crate) fn open<R: Send + 'static>(
        thread: &str,
        what: &'static str,
        init: impl FnOnce() -> anyhow::Result<(S, R)> + Send + 'static,
    ) -> napi::Result<(Self, R)> {
        let (tx, rx) = mpsc::channel::<Job<S>>();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name(thread.into())
            .spawn(move || {
                let mut state = match init() {
                    Ok((state, ready)) => {
                        if ready_tx.send(Ok(ready)).is_err() {
                            return;
                        }
                        state
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("{:#}", device(e))));
                        return;
                    }
                };
                while let Ok(job) = rx.recv() {
                    job(&mut state);
                }
            })
            .map_err(|e| to_napi(device(e)))?;
        let worker = Self { tx: Some(tx), what };
        let ready = ready_rx
            .recv()
            .map_err(|e| worker.lost(e))?
            .map_err(napi::Error::from_reason)?;
        Ok((worker, ready))
    }

    /// Runs `job` on the worker. Its error comes back in the alternate form,
    /// which keeps a `[motif:<code>]` tag.
    pub(crate) async fn run<T: Send + 'static>(
        &self,
        job: impl FnOnce(&mut S) -> anyhow::Result<T> + Send + 'static,
    ) -> napi::Result<T> {
        let (reply, rx) = tokio::sync::oneshot::channel();
        let job: Job<S> = Box::new(move |state| {
            let _ = reply.send(job(state).map_err(|e| format!("{e:#}")));
        });
        self.tx
            .as_ref()
            .ok_or_else(|| self.closed())?
            .send(job)
            .map_err(|e| self.lost(e))?;
        rx.await
            .map_err(|e| self.lost(e))?
            .map_err(napi::Error::from_reason)
    }

    pub(crate) fn close(&mut self) {
        self.tx = None;
    }

    fn closed(&self) -> napi::Error {
        to_napi(coded(
            MotifCode::Closed,
            anyhow::anyhow!("{} closed", self.what),
        ))
    }

    /// The worker is gone or dropped the reply without answering.
    fn lost(&self, e: impl std::fmt::Display) -> napi::Error {
        to_napi(device(anyhow::anyhow!("{} worker lost: {e}", self.what)))
    }
}

#[cfg(test)]
mod tests {
    use super::{DeviceWorker, NtHandle};
    use crate::motif_error::{coded, MotifCode};
    use napi::bindgen_prelude::Buffer;

    fn counter() -> DeviceWorker<Vec<u32>> {
        let (worker, ready) =
            DeviceWorker::open("d3d-test", "Test worker", || Ok((Vec::new(), 7))).unwrap();
        assert_eq!(ready, 7);
        worker
    }

    #[tokio::test]
    async fn jobs_run_in_order_on_the_workers_state_and_keep_their_tag() {
        let worker = counter();
        for n in 0..3 {
            worker
                .run(move |seen| {
                    seen.push(n);
                    Ok(())
                })
                .await
                .unwrap();
        }
        assert_eq!(
            worker.run(|seen| Ok(seen.clone())).await.unwrap(),
            [0, 1, 2]
        );
        let miss = worker
            .run(|_| -> anyhow::Result<()> {
                Err(coded(MotifCode::Miss, anyhow::anyhow!("absent")))
            })
            .await
            .unwrap_err();
        assert_eq!(miss.reason, "[motif:miss] absent");
    }

    #[tokio::test]
    async fn a_closed_worker_refuses_jobs_and_a_lost_one_is_a_device_failure() {
        let mut worker = counter();
        worker.close();
        let closed = worker.run(|_| Ok(())).await.unwrap_err();
        assert_eq!(closed.reason, "[motif:closed] Test worker closed");
        let worker = counter();
        let lost = worker
            .run(|_| -> anyhow::Result<()> { panic!("synthetic") })
            .await
            .unwrap_err();
        assert!(
            lost.reason
                .starts_with("[motif:device] Test worker worker lost: "),
            "{}",
            lost.reason
        );
        let after = worker.run(|_| Ok(())).await.unwrap_err();
        assert!(
            after.reason.starts_with("[motif:device] "),
            "{}",
            after.reason
        );
    }

    #[test]
    fn a_failed_init_is_a_device_failure() {
        let failed =
            DeviceWorker::<()>::open("d3d-test", "Test worker", || -> anyhow::Result<((), ())> {
                Err(anyhow::anyhow!("no adapter"))
            })
            .err()
            .unwrap();
        assert_eq!(failed.reason, "[motif:device] no adapter");
    }

    #[test]
    fn a_handle_is_eight_little_endian_bytes_and_any_other_length_is_untagged() {
        let handle = NtHandle::from_buffer(&Buffer::from(0x1234usize.to_le_bytes().to_vec()));
        assert_eq!(handle.unwrap().0, 0x1234);
        let short = NtHandle::from_buffer(&Buffer::from(vec![0u8; 4]))
            .err()
            .unwrap();
        assert_eq!(short.reason, "Invalid texture handle");
    }
}
