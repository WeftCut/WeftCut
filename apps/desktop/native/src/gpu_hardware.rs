//! Capacity of the default D3D11 device (`d3d::create_device`), the same
//! selection path as native preview transport. Capacity is not process usage or
//! free VRAM.
#![cfg_attr(test, allow(dead_code))] // Only called through NAPI in production.
use napi_derive::napi;
use windows::core::Interface;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;

#[napi(object)]
pub struct GpuHardwareInfo {
    pub name: String,
    pub luid: String,
    pub dedicated_memory_mib: f64,
    pub shared_memory_mib: f64,
}

#[napi]
pub fn gpu_hardware_info() -> napi::Result<GpuHardwareInfo> {
    let read = || -> windows::core::Result<GpuHardwareInfo> {
        unsafe {
            let (device, _) = crate::d3d::create_device()?;
            let dxgi: IDXGIDevice = device.cast()?;
            let desc = dxgi.GetAdapter()?.GetDesc()?;
            let end = desc
                .Description
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(desc.Description.len());
            Ok(GpuHardwareInfo {
                name: String::from_utf16_lossy(&desc.Description[..end]),
                luid: format!(
                    "{:08x}:{:08x}",
                    desc.AdapterLuid.HighPart as u32, desc.AdapterLuid.LowPart
                ),
                dedicated_memory_mib: desc.DedicatedVideoMemory as f64 / 1_048_576.0,
                shared_memory_mib: desc.SharedSystemMemory as f64 / 1_048_576.0,
            })
        }
    };
    read().map_err(|e| napi::Error::from_reason(e.to_string()))
}
