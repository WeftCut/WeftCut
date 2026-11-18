/** Returns a documented skip reason only for affirmative unavailability.
 * All other software paths are failures, never hardware coverage. `before`
 * is the pre-sampling snapshot; check again after pixel/SSIM measurements.
 * @param {object | null | undefined} current
 * @param {string} lane
 * @param {{ required?: boolean, before?: { hwFallbackCount: number } | null }} [options] */
export function verifyHardwareEvidence(current, lane, { required = false, before } = {}) {
  if (!current) throw new Error('Hardware evidence missing: no active clip')
  const details = JSON.stringify(current)
  if (!Number.isSafeInteger(current.hwFallbackCount) || current.hwFallbackCount < 0)
    throw new Error(`Hardware fallback history missing: ${details}`)
  if (current.hwFallbackCount > 0 || (before && current.hwFallbackCount !== before.hwFallbackCount))
    throw new Error(`Hardware decode fell back during the session: ${details}`)
  if (current.hwDiagnostic?.kind === 'failed')
    throw new Error(`Hardware probe/session failed: ${details}`)
  if (current.sourceKind === 'native-gpu' && current.hwLane === lane) {
    return null
  }
  if (!required && !before && current.sourceKind === 'sw' && current.hwLane === null
      && current.hwDiagnostic?.kind === 'unavailable') return current.hwDiagnostic.reason
  throw new Error(`Required hardware lane ${lane} did not remain engaged: ${details}`)
}

/** Only the exact Microsoft software adapter is affirmative absence. Unknown,
 * empty or mixed inventories must exercise the decoder and fail on errors.
 * Identity: chromium/src gpu/config/gpu_info.cc, GPUDevice::IsSoftwareRenderer. */
export function windowsSoftwareOnly(info) {
  return Array.isArray(info?.gpuDevice) && info.gpuDevice.length > 0
    && info.gpuDevice.every(d => d.vendorId === 0x1414 && d.deviceId === 0x008c)
}

export function linuxHardwareAbsent(hardware, auto = false) {
  return hardware?.inventory_reason === null && Array.isArray(hardware.devices)
    && hardware.devices.every(d => Number.isInteger(d.vendor_id) && d.vendor_id !== 0x10de
      && (!auto || (Array.isArray(d.render_nodes) && d.render_nodes.length === 0)))
}

export function hardwareRequired(lane, codec, platform, requiredVariants = '') {
  const allowed = new Set(['nvdec-h264', 'vaapi-h264', 'd3d11va-h264', 'videotoolbox-h264', 'videotoolbox-hevc10', 'videotoolbox-prores'])
  const selected = requiredVariants.split(',').map(x => x.trim()).filter(Boolean)
  for (const item of selected) if (!allowed.has(item)) throw new Error(`Unknown WEFTCUT_REQUIRE_HW_VARIANTS value: ${item}`)
  return selected.includes(`${lane}-${codec}`)
    || (platform === 'darwin' && lane === 'videotoolbox' && ['h264', 'hevc10'].includes(codec))
}
