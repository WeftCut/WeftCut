//! A texture this process creates and another opens by its NT handle.

use std::fmt;

use windows::core::{Interface, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, E_FAIL, HANDLE};
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11Texture2D, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
    D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX, D3D11_RESOURCE_MISC_SHARED_NTHANDLE,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{IDXGIKeyedMutex, IDXGIResource1};

/// `DXGI_SHARED_RESOURCE_READ (0x80000000) | DXGI_SHARED_RESOURCE_WRITE (0x1)`.
/// Raw because the windows-crate newtype OR does not coerce to the method's
/// `u32` parameter.
const DXGI_SHARED_RESOURCE_RW: u32 = 0x8000_0001;

/// Which step of [`SharedTexture::create`] failed, and why.
#[derive(Debug)]
pub struct CreateError {
    pub step: &'static str,
    pub error: windows::core::Error,
}

impl fmt::Display for CreateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} failed: {}", self.step, self.error)
    }
}

impl std::error::Error for CreateError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.error)
    }
}

fn step(step: &'static str) -> impl FnOnce(windows::core::Error) -> CreateError {
    move |error| CreateError { step, error }
}

/// A shader-readable render target shared through an NT handle under a keyed
/// mutex. Owns the handle: `Drop` closes it, so a pool dropped half-built
/// closes exactly the handles it created.
pub struct SharedTexture {
    texture: ID3D11Texture2D,
    mutex: IDXGIKeyedMutex,
    handle: HANDLE,
}

impl SharedTexture {
    /// A `width` × `height` texture of `format` on `device`, with its handle.
    ///
    /// # Safety
    /// `device` must be one this thread may use.
    pub unsafe fn create(
        device: &ID3D11Device,
        width: u32,
        height: u32,
        format: DXGI_FORMAT,
    ) -> Result<Self, CreateError> {
        // D3D11 shares a texture by NT handle only with NTHANDLE and KEYEDMUTEX
        // set together. A shared texture takes no initial data: the first
        // write fills it.
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: format,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: (D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0
                | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0) as u32,
        };
        let mut texture = None;
        device
            .CreateTexture2D(&desc, None, Some(&mut texture))
            .map_err(step("CreateTexture2D"))?;
        let texture = texture
            .ok_or_else(|| windows::core::Error::new(E_FAIL, "no texture returned"))
            .map_err(step("CreateTexture2D"))?;
        let mutex: IDXGIKeyedMutex = texture.cast().map_err(step("cast IDXGIKeyedMutex"))?;
        let resource: IDXGIResource1 = texture.cast().map_err(step("cast IDXGIResource1"))?;
        let handle = resource
            .CreateSharedHandle(None, DXGI_SHARED_RESOURCE_RW, PCWSTR::null())
            .map_err(step("CreateSharedHandle"))?;
        Ok(Self {
            texture,
            mutex,
            handle,
        })
    }

    pub fn texture(&self) -> &ID3D11Texture2D {
        &self.texture
    }

    /// The mutex [`KeyedMutexGuard`](crate::KeyedMutexGuard) takes around each
    /// access.
    pub fn mutex(&self) -> &IDXGIKeyedMutex {
        &self.mutex
    }

    /// Valid while `self` lives.
    pub fn handle(&self) -> HANDLE {
        self.handle
    }

    pub fn desc(&self) -> D3D11_TEXTURE2D_DESC {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        // SAFETY: `texture` is a live COM object this struct owns.
        unsafe { self.texture.GetDesc(&mut desc) };
        desc
    }
}

impl Drop for SharedTexture {
    fn drop(&mut self) {
        // SAFETY: the handle was created by `create` and is closed only here.
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}
