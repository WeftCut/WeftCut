// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HardwareSection } from './HardwareSection';
import { untestedAcceleration, type HardwareDiagnostics } from '../../shared/hardware-diagnostics';
import type { PerformanceResourceInfo } from '../../shared/performance-budgets';
import i18n from '../i18n';

const renderer = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock('./probeRendererHardware', () => ({ probeRendererHardware: renderer.probe }));
const probe = vi.fn(), refresh = vi.fn();
function resources(): PerformanceResourceInfo {
  const hardware: HardwareDiagnostics = { platform: 'linux', sampled_at: 1, render_device_id: 'gpu1', inventory_reason: null,
    chromium: { compositing: 'enabled', rasterization: 'enabled', video_decode: 'enabled', video_encode: 'disabled_software' },
    acceleration: untestedAcceleration(), devices: [
      { id: 'gpu0', pci_address: '0000:00:02.0', vendor_id: 0x8086, device_id: 0xa782, name: 'Intel Example', name_source: 'pci-ids', driver: 'i915', driver_version: null,
        render_nodes: ['/dev/dri/renderD128'], memory: { kind: 'shared', total_mib: null, used_mib: null, free_mib: null, source: 'drm', reason: null } },
      { id: 'gpu1', pci_address: '0000:01:00.0', vendor_id: 0x10de, device_id: 0x2508, name: 'NVIDIA Example', name_source: 'nvml', driver: 'nvidia', driver_version: 'example',
        render_nodes: ['/dev/dri/renderD129'], memory: { kind: 'dedicated', total_mib: 8192, used_mib: 1024, free_mib: 7168, source: 'nvml', reason: null } },
    ] };
  return { total_memory_mib: 32768, hardware, gpu_buffer_transport: 'copy-back', gpu_buffers: { used_bytes: 0, limit_bytes: 0, preview_bytes: 0, motif_bytes: 0 } };
}
beforeEach(async () => {
  vi.clearAllMocks(); await i18n.changeLanguage('en-US');
  renderer.probe.mockResolvedValue({ webgl: { status: 'available', reason: null, renderer: 'ANGLE NVIDIA Example' }, webgpu: { status: 'unavailable', reason: 'unsupported', renderer: null } });
  probe.mockResolvedValue(untestedAcceleration()); refresh.mockResolvedValue(undefined);
  Object.defineProperty(window, 'api', { configurable: true, value: { performanceResources: { probe } } });
});
afterEach(cleanup);
it('offers CPU and named hardware as local test preferences, with measured memory independent of renderer ID', async () => {
  const info = resources(); info.hardware!.render_device_id = null;
  const chooseDevice = vi.fn();
  render(<HardwareSection resources={info} stale={false} refresh={refresh} chooseDevice={chooseDevice} decodeDevice="auto" />);
  expect(screen.getAllByTestId('hardware-memory-meter')).toHaveLength(1);
  expect(screen.getByRole('meter', { name: 'NVIDIA Example' }).getAttribute('value')).toBe('1024');
  await userEvent.click(screen.getByRole('combobox', { name: 'Preview decoding device (test override)' }));
  await userEvent.click(screen.getByRole('option', { name: 'CPU (software decoding)' }));
  expect(chooseDevice).toHaveBeenCalledWith('cpu');
  expect(probe).not.toHaveBeenCalled();
});
it('shows no decoding session without substituting the rendering adapter or hardware inventory', () => {
  render(<HardwareSection resources={resources()} stale={false} refresh={refresh} />);
  expect(screen.getByText('No decoding sessions')).toBeDefined();
  expect(screen.queryByText('NVIDIA Example')).toBeNull();
  expect(screen.queryByText('Intel Example')).toBeNull();
  expect(screen.queryByText('8.0 GiB')).toBeNull();
  expect(screen.queryByText('ANGLE NVIDIA Example')).toBeNull();
  expect(screen.queryByText('Driver')).toBeNull();
  expect(screen.queryByText('0000:01:00.0')).toBeNull();
  expect(screen.queryByText('WebGPU')).toBeNull();
  expect(screen.queryByText(/No supported backend available/)).toBeNull();
  expect(probe).not.toHaveBeenCalled();
  expect(renderer.probe).not.toHaveBeenCalled();
});
it('runs explicit codec detection without writing settings and refreshes results', async () => {
  render(<HardwareSection resources={resources()} stale={false} refresh={refresh} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Hardware diagnostics' }));
  await user.click(screen.getByRole('button', { name: 'Test acceleration' }));
  expect(probe).toHaveBeenCalledTimes(1); expect(refresh).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('dialog')).toBeDefined();
});

it('offers a named refresh icon separately from the capability test action', async () => {
  render(<HardwareSection resources={resources()} stale={false} refresh={refresh} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Hardware diagnostics' }));
  const dialog = screen.getByRole('dialog', { name: 'Hardware diagnostics' });
  expect(within(dialog).getByRole('region', { name: 'Decode and encode acceleration' })).toBeDefined();
  await user.click(within(dialog).getByRole('button', { name: 'Refresh hardware' }));
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(probe).not.toHaveBeenCalled();
});

it('groups codec results by adapter and backend, with format verdicts and collapsed technical output', async () => {
  const info = resources();
  info.hardware!.acceleration = { ...untestedAcceleration(), status: 'complete', decode: [
    { codec: 'h264', bit_depth: 8, backend: 'nvdec', device_id: 'gpu1', device_path: null, status: 'available', reason: null },
    { codec: 'hevc', bit_depth: 8, backend: 'nvdec', device_id: 'gpu1', device_path: null, status: 'available', reason: null },
    { codec: 'h264', bit_depth: 8, backend: 'vaapi', device_id: 'gpu0', device_path: '/dev/dri/renderD128',
      status: 'unavailable', reason: 'probe-failed', detail: 'Detailed driver error\nConversion failed' },
  ], encode: [
    { codec: 'h264', bit_depth: 8, backend: 'h264_nvenc', device_id: 'gpu1', device_path: null, status: 'available', reason: null },
    { codec: 'hevc', bit_depth: 8, backend: 'hevc_nvenc', device_id: 'gpu1', device_path: null, status: 'available', reason: null },
    { codec: 'hevc', bit_depth: 10, backend: 'hevc_nvenc', device_id: 'gpu1', device_path: null, status: 'available', reason: null },
  ] };
  render(<HardwareSection resources={info} stale={false} refresh={refresh} />);
  const user = userEvent.setup();
  expect(screen.getByText('No decoding sessions')).toBeDefined();
  expect(screen.queryByText('Detailed driver error', { exact: false })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Hardware diagnostics' }));
  const nvdec = screen.getByRole('region', { name: 'NVDEC — NVIDIA Example' });
  expect(within(nvdec).getByText('NVIDIA Example')).toBeDefined();
  expect(within(nvdec).getAllByText('Test passed')).toHaveLength(2);
  expect(screen.getAllByTestId('hardware-codec-group')).toHaveLength(3);
  const nvenc = screen.getByRole('region', { name: 'NVENC — NVIDIA Example' });
  expect(within(nvenc).getAllByText('Test passed')).toHaveLength(3);
  expect(within(nvenc).getByText('10-bit')).toBeDefined();
  const vaapi = screen.getByRole('region', { name: 'VAAPI — Intel Example' });
  expect(within(vaapi).getByText('Unavailable')).toBeDefined();
  expect(within(vaapi).getByText('The probe did not complete successfully')).toBeDefined();
  const technical = within(vaapi).getByText('Technical details').closest('details')!;
  expect(technical.open).toBe(false);
  await user.click(within(vaapi).getByText('Technical details'));
  expect(technical.open).toBe(true);
  expect(technical.textContent).toContain('Detailed driver error\nConversion failed');
});

it('does not confuse browser software encoding with the independent FFmpeg backend', async () => {
  render(<HardwareSection resources={resources()} stale={false} refresh={refresh} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Hardware diagnostics' }));
  const dialog = screen.getByRole('dialog', { name: 'Hardware diagnostics' });
  expect(within(dialog).getByText('0000:01:00.0')).toBeDefined();
  expect(within(dialog).getByText('nvidia example')).toBeDefined();
  expect(within(dialog).getByText('ANGLE NVIDIA Example')).toBeDefined();
  const browser = screen.getByTestId('browser-media-status');
  expect(within(browser).getByText('Browser video encoding')).toBeDefined();
  expect(within(browser).getByText('Software processing')).toBeDefined();
  expect(within(browser).getByText(/not a per-format probe/)).toBeDefined();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByText('ANGLE NVIDIA Example')).toBeNull();
  expect(probe).not.toHaveBeenCalled();
});

it('shows the Intel VAAPI decode device even when NVIDIA is the rendering adapter, then updates on software fallback', () => {
  const { rerender } = render(<HardwareSection resources={resources()} decodeDevices={[{ kind: 'hardware', backend: 'vaapi', device: '/dev/dri/renderD128' }]} stale={false} refresh={refresh} />);
  expect(screen.getByText('Intel Example')).toBeDefined();
  expect(screen.queryByText('NVIDIA Example')).toBeNull();
  rerender(<HardwareSection resources={resources()} decodeDevices={[{ kind: 'software', backend: 'ffmpeg', device: null }]} stale={false} refresh={refresh} />);
  expect(screen.getByText('CPU (software decoding)')).toBeDefined();
  expect(screen.queryByText('Intel Example')).toBeNull();
});

it('shows concurrent devices once and retains unknown browser/device identities', () => {
  const info = resources();
  info.hardware!.devices.push({ ...info.hardware!.devices[1]!, id: 'gpu2', name: 'Second NVIDIA' });
  render(<HardwareSection resources={info} decodeDevices={[
    { kind: 'hardware', backend: 'nvdec', device: null },
    { kind: 'hardware', backend: 'vaapi', device: '/dev/dri/renderD128' },
    { kind: 'hardware', backend: 'vaapi', device: '/dev/dri/renderD128' },
    { kind: 'browser', backend: 'webcodecs', device: null },
  ]} stale={false} refresh={refresh} />);
  expect(screen.getAllByText('Intel Example')).toHaveLength(1);
  expect(screen.getByText('Hardware decoding (device unconfirmed)')).toBeDefined();
  expect(screen.getByText('Browser decoding (device not reported)')).toBeDefined();
  expect(screen.queryByText('NVIDIA Example')).toBeNull();
});

it('keeps hardware refresh and probe failures inside diagnostics', async () => {
  const info = resources();
  info.hardware!.acceleration = { ...untestedAcceleration(), status: 'failed', reason: 'timeout' };
  render(<HardwareSection resources={info} stale refresh={refresh} />);
  expect(screen.getByText(/Showing the last hardware reading/)).toBeDefined();
  expect(screen.queryByText(/Detection timed out/)).toBeNull();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Hardware diagnostics' }));
  expect(screen.getByText(/Detection timed out/)).toBeDefined();
});
it('does not show an old adapter or capacity when no device is identified', () => {
  const info = resources(); info.hardware!.devices = []; info.hardware!.render_device_id = null;
  render(<HardwareSection resources={info} stale={false} refresh={refresh} />);
  expect(screen.getByText('No decoding sessions')).toBeDefined();
  expect(screen.queryByText('8.0 GiB')).toBeNull();
});
