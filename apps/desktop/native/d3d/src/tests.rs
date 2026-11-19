use windows::core::{Interface, HRESULT};
use windows::Win32::Foundation::{GetHandleInformation, HANDLE, HMODULE, LUID};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device1, ID3D11Texture2D, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_SDK_VERSION,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_R8G8B8A8_UNORM;
use windows::Win32::Graphics::Dxgi::IDXGIKeyedMutex;

use super::*;

#[test]
fn a_handle_crosses_as_its_value_in_eight_little_endian_bytes() {
    let handle = HANDLE(0x0102_0304_0506 as *mut _);
    let bytes = handle_to_bytes(handle);
    assert_eq!(bytes, [6, 5, 4, 3, 2, 1, 0, 0], "little-endian value");
    assert_eq!(handle_from_bytes(&bytes), Some(handle));
    for value in [0usize, 1, 0x1234, usize::MAX] {
        let handle = HANDLE(value as *mut _);
        assert_eq!(handle_from_bytes(&handle_to_bytes(handle)), Some(handle));
    }
    for len in [0, 4, 7, 9] {
        assert_eq!(
            handle_from_bytes(&vec![0u8; len]),
            None,
            "{len} bytes are not a handle"
        );
    }
}

#[test]
fn a_luid_reads_high_then_low_as_unsigned_hex() {
    let luid = LUID {
        LowPart: 0xabcd,
        HighPart: 1,
    };
    assert_eq!(luid_string(luid), "00000001:0000abcd");
    // A negative high part prints its bits, not a sign.
    let luid = LUID {
        LowPart: u32::MAX,
        HighPart: -1,
    };
    assert_eq!(luid_string(luid), "ffffffff:ffffffff");
}

#[test]
fn only_s_ok_grants_the_key() {
    assert_eq!(AcquireError::classify(HRESULT(0)), Ok(()));
    assert_eq!(
        AcquireError::classify(HRESULT(0x102)),
        Err(AcquireError::Timeout)
    );
    // Non-negative like S_OK, yet the surface is inconsistent.
    assert_eq!(
        AcquireError::classify(HRESULT(0x80)),
        Err(AcquireError::Abandoned)
    );
    let removed = HRESULT(0x887A_0005_u32 as i32); // DXGI_ERROR_DEVICE_REMOVED
    assert_eq!(
        AcquireError::classify(removed),
        Err(AcquireError::Failed(removed))
    );
}

/// A hardware device, or `None` on a host without one: these tests need a
/// GPU, the properties they check do not depend on which.
fn hardware_device() -> Option<ID3D11Device1> {
    let mut device = None;
    // SAFETY: plain device creation, no borrowed state.
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )
        .ok()?;
    }
    device?.cast().ok()
}

/// `texture` as a second device sees it through its handle, with its mutex.
fn open_elsewhere(
    device: &ID3D11Device1,
    texture: &SharedTexture,
) -> (ID3D11Texture2D, IDXGIKeyedMutex) {
    // SAFETY: the handle is live while `texture` is.
    let opened: ID3D11Texture2D = unsafe { device.OpenSharedResource1(texture.handle()) }
        .expect("the handle opens on another device");
    let mutex = opened.cast().expect("the opened texture has a keyed mutex");
    (opened, mutex)
}

#[test]
fn a_held_key_locks_out_the_other_side_until_its_guard_drops() {
    let (Some(owner), Some(other)) = (hardware_device(), hardware_device()) else {
        eprintln!("skipping: no hardware D3D11 device on this host");
        return;
    };
    // SAFETY: both devices live on this thread for the whole test.
    unsafe {
        let texture = SharedTexture::create(&owner, 16, 16, DXGI_FORMAT_R8G8B8A8_UNORM)
            .expect("create a shared texture");
        let (_opened, other_mutex) = open_elsewhere(&other, &texture);

        let held = KeyedMutexGuard::acquire(texture.mutex(), 0, 0).expect("the key is free");
        assert_eq!(
            KeyedMutexGuard::acquire(&other_mutex, 0, 0).err(),
            Some(AcquireError::Timeout),
            "the other side waits while the key is held"
        );
        drop(held);
        let other_held = KeyedMutexGuard::acquire(&other_mutex, 0, 0)
            .expect("a dropped guard gave the key back");
        other_held.release().expect("an explicit release succeeds");
        KeyedMutexGuard::acquire(texture.mutex(), 0, 0)
            .expect("a released guard gave the key back")
            .release()
            .unwrap();
    }
}

#[test]
fn dropping_a_shared_texture_closes_its_handle() {
    let Some(device) = hardware_device() else {
        eprintln!("skipping: no hardware D3D11 device on this host");
        return;
    };
    // SAFETY: the device lives on this thread for the whole test.
    unsafe {
        let texture = SharedTexture::create(&device, 16, 16, DXGI_FORMAT_R8G8B8A8_UNORM)
            .expect("create a shared texture");
        let handle = texture.handle();
        let mut flags = 0u32;
        assert!(
            GetHandleInformation(handle, &mut flags).is_ok(),
            "the handle is open while the texture lives"
        );
        drop(texture);
        assert!(
            GetHandleInformation(handle, &mut flags).is_err(),
            "the handle closed with the texture"
        );
    }
}
