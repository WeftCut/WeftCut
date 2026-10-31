import { expect, it, vi } from 'vitest';
import { collectLinuxHardware, parsePciNames, type LinuxHardwareIO } from './linuxHardware';

function fixture(options: { duplicate?: boolean; denied?: boolean; nvml?: boolean } = {}): LinuxHardwareIO {
  const files: Record<string, string> = {
    '/sys/devices/intel/vendor': '0x8086', '/sys/devices/intel/device': '0xa782',
    '/sys/devices/nvidia/vendor': '0x10de', '/sys/devices/nvidia/device': '0x2508',
    '/sys/devices/amd/vendor': '0x1002', '/sys/devices/amd/device': '0x744c',
    '/sys/devices/amd/mem_info_vram_total': String(16 * 1024 ** 3),
    '/sys/devices/amd/mem_info_vram_used': String(2 * 1024 ** 3),
    '/usr/share/misc/pci.ids': '8086  Intel\n\ta782  Integrated graphics\n10de  NVIDIA\n\t2508  RTX Example\n1002  AMD\n\t744c  Radeon Example\n',
  };
  const nodes = ['renderD128', 'renderD129', 'renderD130', ...(options.duplicate ? ['renderD131'] : [])];
  const paths: Record<string, string> = { renderD128: 'intel', renderD129: 'nvidia', renderD130: 'amd', renderD131: 'nvidia2' };
  if (options.duplicate) { files['/sys/devices/nvidia2/vendor'] = '0x10de'; files['/sys/devices/nvidia2/device'] = '0x2508'; }
  return {
    readdir: async () => nodes,
    realpath: async p => {
      const node = p.split('/')[4];
      if (p.endsWith('/driver')) return '/sys/bus/pci/drivers/' + ({ intel: 'i915', amd: 'amdgpu' }[p.split('/')[3]] ?? 'nvidia');
      return '/sys/devices/' + paths[node];
    },
    readFile: async p => { if (!(p in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files[p]; },
    nativeMemory: async () => options.denied ? { reason: 'permission-denied', devices: [] } : {
      reason: null,
      devices: [
        { renderNode: '/dev/dri/renderD128', kind: 'shared', totalMib: null, usedMib: null, freeMib: null, name: null, pciAddress: null, source: 'drm', reason: null },
        ...(options.nvml === false ? [] : [{ pciAddress: null, renderNode: '/dev/dri/renderD129', name: 'NVIDIA RTX Example', kind: 'dedicated' as const, totalMib: 8192, usedMib: 1024, freeMib: 7168, source: 'nvml' as const, reason: null }]),
      ],
    },
  };
}
const gpuInfo = { gpuDevice: [{ active: true, vendorId: 0x10de, deviceId: 0x2508, driverVersion: 'test-driver' }] };

it('resolves Linux IDs without Electron name strings and keeps memory per device', async () => {
  const result = await collectLinuxHardware(gpuInfo, fixture());
  const nvidia = result.devices.find(d => d.vendor_id === 0x10de)!;
  expect(nvidia.name).toBe('NVIDIA RTX Example');
  expect(nvidia.memory).toMatchObject({ kind: 'dedicated', total_mib: 8192, used_mib: 1024, source: 'nvml' });
  expect(result.render_device_id).toBe(nvidia.id);
  expect(result.devices.find(d => d.vendor_id === 0x8086)?.memory).toMatchObject({ kind: 'shared', total_mib: null });
  expect(result.devices.find(d => d.vendor_id === 0x1002)?.memory).toMatchObject({ kind: 'local', total_mib: 16384, used_mib: 2048 });
});
it('does not manufacture a GPU from the zero-ID Vulkan placeholder', async () => {
  const result = await collectLinuxHardware({ gpuDevice: [{ vendorId: 0, deviceId: 0, active: false }] }, fixture());
  expect(result.devices).toHaveLength(3);
  expect(result.devices.some(d => d.vendor_id === 0)).toBe(false);
});
it('keeps a PCI name when NVML is absent and never substitutes zero for unknown memory', async () => {
  const result = await collectLinuxHardware(gpuInfo, fixture({ nvml: false }));
  expect(result.devices.find(d => d.vendor_id === 0x10de)).toMatchObject({ name: 'NVIDIA RTX Example', name_source: 'pci-ids', memory: { total_mib: null } });
});
it('does not assign an active card or its VRAM when identical adapters are ambiguous', async () => {
  expect((await collectLinuxHardware(gpuInfo, fixture({ duplicate: true }))).render_device_id).toBeNull();
});
it('retains identities when memory access is denied and distinguishes the reason', async () => {
  const result = await collectLinuxHardware(gpuInfo, fixture({ denied: true }));
  expect(result.devices.find(d => d.vendor_id === 0x10de)?.memory).toMatchObject({ total_mib: null, reason: 'permission-denied' });
  expect(result.devices).toHaveLength(3);
});
it('handles an unavailable sysfs inventory independently of Electron identity', async () => {
  const io = fixture(); io.readdir = vi.fn().mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
  const result = await collectLinuxHardware(gpuInfo, io);
  expect(result.inventory_reason).toBe('permission-denied');
  expect(result.devices[0]).toMatchObject({ vendor_id: 0x10de, device_id: 0x2508, memory: { total_mib: null } });
});
it('parses PCI device names without mistaking subsystem IDs for devices', () => {
  const names = parsePciNames('10de  NVIDIA\n\t2508  RTX Example\n\t\t17aa c97a  Subsystem\n\t2600  Other\nC 03  Display\n');
  expect(names.get('10de:2508')).toBe('NVIDIA RTX Example');
  expect(names.has('10de:17aa')).toBe(false);
});

it('identifies PCI display devices even when no DRM render node exists', async () => {
  const base = fixture();
  const address = '0000:04:00.0';
  const io: LinuxHardwareIO = {
    ...base,
    readdir: async p => p === '/sys/bus/pci/devices' ? [address] : [],
    realpath: async p => p.endsWith('/driver') ? '/sys/bus/pci/drivers/nvidia' : `/sys/devices/${address}`,
    readFile: async p => p.endsWith('/class') ? '0x030200' : p.endsWith('/vendor') ? '0x10de'
      : p.endsWith('/device') ? '0x2508' : base.readFile(p),
    nativeMemory: async devices => {
      expect(devices[0]?.pci_address).toBe(address);
      return { reason: null, devices: [{ pciAddress: address, renderNode: null, name: 'Headless Example',
        kind: 'dedicated', totalMib: 8192, usedMib: 512, freeMib: 7680, source: 'nvml', reason: null }] };
    },
  };
  expect((await collectLinuxHardware(null, io)).devices[0]).toMatchObject({ name: 'Headless Example', render_nodes: [], memory: { total_mib: 8192 } });
});

it('does not attach stale NVML results through a reused render node when PCI identity differs', async () => {
  const io = fixture();
  io.nativeMemory = async () => ({ reason: null, devices: [{ pciAddress: '0000:09:00.0', renderNode: '/dev/dri/renderD129',
    name: 'Removed Example', kind: 'dedicated', totalMib: 4096, usedMib: 0, freeMib: 4096, source: 'nvml', reason: null }] });
  const result = await collectLinuxHardware(gpuInfo, io);
  expect(result.devices.some(d => d.name === 'Removed Example')).toBe(false);
  expect(result.devices.find(d => d.vendor_id === 0x10de)?.memory.total_mib).toBeNull();
});
