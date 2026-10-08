//! Host memory telemetry is optional: an OS query failure is not zero RAM.

pub(super) fn available_memory(system: &sysinfo::System) -> Option<f64> {
    #[cfg(target_os = "macos")]
    let available = macos_available_bytes(system.total_memory());
    #[cfg(not(target_os = "macos"))]
    let available = valid_available_bytes(system.total_memory(), system.available_memory());
    available.map(|bytes| bytes as f64 / 1048576.0)
}

fn valid_available_bytes(total: u64, available: u64) -> Option<u64> {
    // sysinfo initializes totals to zero when Windows/Linux queries fail.
    // A valid zero availability must still trigger real host pressure.
    (total > 0 && available <= total).then_some(available)
}

#[cfg(any(target_os = "macos", test))]
fn reclaimable_bytes(
    total: u64,
    page_size: u64,
    free: u64,
    inactive: u64,
    purgeable: u64,
) -> Option<u64> {
    if page_size == 0 {
        return None;
    }
    let available = free
        .checked_add(inactive)?
        .checked_add(purgeable)?
        .checked_mul(page_size)?;
    valid_available_bytes(total, available)
}

#[cfg(target_os = "macos")]
fn macos_available_bytes(total: u64) -> Option<u64> {
    // sysinfo 0.37 subtracts compressor pages from free + inactive + purgeable.
    // Those pages already occupy a separate VM queue: subtracting them again
    // can report zero usable RAM on an otherwise healthy compressed-memory Mac.
    // Speculative pages are already included in free_count (Apple's
    // osfmk/mach/vm_statistics.h); do not add them a second time either.
    unsafe extern "C" {
        fn mach_port_deallocate(
            task: libc::mach_port_t,
            name: libc::mach_port_t,
        ) -> libc::kern_return_t;
    }
    // SAFETY: the initialized statistics buffer and count match HOST_VM_INFO64.
    // mach_host_self creates a send right which is returned after every query.
    unsafe {
        let page_size = libc::sysconf(libc::_SC_PAGESIZE);
        if page_size <= 0 {
            return None;
        }
        #[allow(deprecated)]
        let host = libc::mach_host_self();
        let mut stats: libc::vm_statistics64 = std::mem::zeroed();
        let mut count = libc::HOST_VM_INFO64_COUNT;
        let result = libc::host_statistics64(
            host,
            libc::HOST_VM_INFO64,
            (&mut stats as *mut libc::vm_statistics64).cast(),
            &mut count,
        );
        #[allow(deprecated)]
        mach_port_deallocate(libc::mach_task_self(), host);
        // Older supported macOS kernels return a shorter struct than current
        // libc headers. Only require the prefix containing the fields we use.
        let required_count = (std::mem::offset_of!(libc::vm_statistics64, purgeable_count)
            + std::mem::size_of::<libc::natural_t>())
            / std::mem::size_of::<libc::integer_t>();
        if result != libc::KERN_SUCCESS || (count as usize) < required_count {
            return None;
        }
        reclaimable_bytes(
            total,
            page_size as u64,
            stats.free_count.into(),
            stats.inactive_count.into(),
            stats.purgeable_count.into(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compressed_memory_does_not_erase_reclaimable_pages() {
        let page_size = 16384;
        let free = 8192u64;
        let inactive = 114688;
        let purgeable = 4096;
        let compressor = 155648;
        // Regression: the old subtraction saturates to zero, despite ~2 GiB
        // of reclaimable pages. Compressor occupancy is not an input anymore.
        assert_eq!(
            (free + inactive + purgeable).saturating_sub(compressor),
            0u64
        );
        assert_eq!(
            reclaimable_bytes(8 * 1024 * 1024 * 1024, page_size, free, inactive, purgeable),
            Some(2080374784)
        );
    }

    #[test]
    fn failed_or_impossible_queries_are_unknown_but_real_zero_is_valid() {
        assert_eq!(valid_available_bytes(0, 0), None);
        assert_eq!(valid_available_bytes(1024, 2048), None);
        assert_eq!(valid_available_bytes(1024, 0), Some(0));
        assert_eq!(reclaimable_bytes(1024, 0, 1, 0, 0), None);
        assert_eq!(reclaimable_bytes(u64::MAX, 16384, u64::MAX, 1, 0), None);
    }

    #[test]
    fn few_reclaimable_pages_still_report_low_memory() {
        assert_eq!(
            reclaimable_bytes(8 * 1024 * 1024 * 1024, 16384, 1024, 2048, 0),
            Some(48 * 1024 * 1024)
        );
    }
}
