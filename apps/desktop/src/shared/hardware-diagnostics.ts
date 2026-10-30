/** Measurements and probe evidence are local diagnostics, never saved resource intent. */
export type HardwareFailure = 'permission-denied' | 'driver-unavailable' | 'component-unavailable'
  | 'unsupported' | 'timeout' | 'probe-failed' | 'resource-busy' | 'unknown';
export type HardwareStatus = 'available' | 'unavailable' | 'not-tested' | 'software';
export interface HardwareMemory {
  kind: 'dedicated' | 'shared' | 'local' | 'unknown';
  total_mib: number | null;
  used_mib: number | null;
  free_mib: number | null;
  source: 'nvml' | 'amdgpu' | 'drm' | 'unknown';
  reason: HardwareFailure | null;
}
export interface HardwareDevice {
  id: string;
  pci_address: string | null;
  vendor_id: number | null;
  device_id: number | null;
  name: string;
  name_source: 'nvml' | 'pci-ids' | 'electron' | 'device-id';
  driver: string | null;
  driver_version: string | null;
  render_nodes: string[];
  memory: HardwareMemory;
}
export interface HardwareProbeResult {
  status: HardwareStatus;
  reason: HardwareFailure | null;
  detail?: string;
}
export interface CodecHardwareProbe extends HardwareProbeResult {
  codec: 'h264' | 'hevc' | 'vp9';
  bit_depth: 8 | 10;
  backend: string;
  device_id: string | null;
  device_path: string | null;
}
export interface HardwareAccelerationDiagnostics {
  sampled_at: number | null;
  status: 'idle' | 'running' | 'complete' | 'failed';
  reason: HardwareFailure | null;
  decode: CodecHardwareProbe[];
  encode: CodecHardwareProbe[];
}
export interface HardwareDiagnostics {
  motif_gpu?: import('./motifs/gpuProbe').MotifGpuProbe;
  platform: string;
  sampled_at: number;
  devices: HardwareDevice[];
  render_device_id: string | null;
  inventory_reason: HardwareFailure | null;
  chromium: Record<'compositing' | 'rasterization' | 'video_decode' | 'video_encode', string>;
  acceleration: HardwareAccelerationDiagnostics;
}
export interface RendererHardwareDiagnostics {
  webgl: HardwareProbeResult & { renderer: string | null };
  webgpu: HardwareProbeResult & { renderer: string | null };
}

export const untestedAcceleration = (): HardwareAccelerationDiagnostics => ({
  sampled_at: null, status: 'idle', reason: null, decode: [], encode: [],
});
