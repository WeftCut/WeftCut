import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { HardwareDevice, HardwareDiagnostics, HardwareFailure, HardwareMemory } from '../shared/hardware-diagnostics';
import { untestedAcceleration } from '../shared/hardware-diagnostics';

export interface NativeMemoryDevice {
  pciAddress: string | null; renderNode: string | null; name: string | null;
  kind: HardwareMemory['kind']; totalMib: number | null; usedMib: number | null; freeMib: number | null;
  source: HardwareMemory['source']; reason: HardwareFailure | null;
}
export interface NativeMemoryInfo { devices: NativeMemoryDevice[]; reason: HardwareFailure | null }
export interface LinuxHardwareIO {
  readdir(p: string): Promise<string[]>;
  realpath(p: string): Promise<string>;
  readFile(p: string): Promise<string>;
  nativeMemory(devices: HardwareDevice[]): Promise<NativeMemoryInfo>;
}
export const hardwareFailure = (error: unknown): HardwareFailure => {
  const code = (error as { code?: string })?.code;
  return code === 'EACCES' || code === 'EPERM' ? 'permission-denied' : 'unknown';
};
const io: LinuxHardwareIO = {
  readdir: p => fs.readdir(p), realpath: p => fs.realpath(p), readFile: p => fs.readFile(p, 'utf8'),
  async nativeMemory(devices) {
    const native = createRequire(import.meta.url)('@weftcut/core') as { linuxGpuMemoryInfo?: (json: string) => Promise<string> };
    if (!native.linuxGpuMemoryInfo) return { devices: [], reason: 'component-unavailable' };
    nativeMemoryTask ??= native.linuxGpuMemoryInfo(JSON.stringify(devices.map(d => ({
      pciAddress: d.pci_address, renderNode: d.render_nodes[0] ?? null, driver: d.driver, vendorId: d.vendor_id,
    })))).finally(() => { nativeMemoryTask = undefined; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([nativeMemoryTask, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 2500); })]);
      return result === null ? { devices: [], reason: 'timeout' } : JSON.parse(result);
    } finally { clearTimeout(timer); }
  },
};
// A timed-out driver call cannot be cancelled; share it until it drains instead
// of creating an unbounded number of native worker threads on subsequent polls.
let nativeMemoryTask: Promise<string> | undefined;
const vendorNames = new Map([[0x10de, 'NVIDIA'], [0x1002, 'AMD'], [0x8086, 'Intel']]);
const key = (vendor: number, device: number) => `${vendor.toString(16).padStart(4, '0')}:${device.toString(16).padStart(4, '0')}`;
const unknownMemory = (reason: HardwareFailure | null = 'unknown'): HardwareMemory => ({
  kind: 'unknown', total_mib: null, used_mib: null, free_mib: null, source: 'unknown', reason,
});

/** Ignore subsystem rows and class sections; no network lookup or external CLI. */
export function parsePciNames(text: string): Map<string, string> {
  const names = new Map<string, string>();
  let vendor = '';
  let vendorName = '';
  for (const line of text.split('\n')) {
    const header = line.match(/^([\da-f]{4})\s+(.+)$/i);
    if (header) { vendor = header[1].toLowerCase(); vendorName = header[2].trim(); }
    else if (/^\S/.test(line) && !line.startsWith('#')) vendor = '';
    const device = line.match(/^\t([\da-f]{4})\s+(.+)$/i);
    if (vendor && device) names.set(`${vendor}:${device[1].toLowerCase()}`, `${vendorName} ${device[2].trim()}`);
  }
  return names;
}
async function pciNames(io: LinuxHardwareIO): Promise<Map<string, string>> {
  for (const file of ['/usr/share/misc/pci.ids', '/usr/share/hwdata/pci.ids', '/usr/share/pci.ids']) {
    try { return parsePciNames(await io.readFile(file)); } catch { /* Optional local database. */ }
  }
  return new Map();
}
async function numberFile(io: LinuxHardwareIO, file: string, failed?: (reason: HardwareFailure) => void): Promise<number | null> {
  try { const text = (await io.readFile(file)).trim(); const n = Number(text); return text && Number.isSafeInteger(n) && n >= 0 ? n : null; }
  catch (error) { failed?.(hardwareFailure(error)); return null; }
}
function fallbackName(vendor: number | null, device: number | null): string {
  if (vendor === null || device === null) return 'GPU';
  return `${vendorNames.get(vendor) ?? 'GPU'} (${key(vendor, device)})`;
}

/** Enumeration never assumes a render-node number, first GPU or PCI name is the active adapter. */
export async function collectLinuxHardware(info: unknown, host: LinuxHardwareIO = io): Promise<HardwareDiagnostics> {
  const value = info as { gpuDevice?: { active?: boolean; vendorId?: number; deviceId?: number; deviceString?: string; driverVersion?: string }[] } | null;
  const electron = Array.isArray(value?.gpuDevice) ? value.gpuDevice : [];
  const names = await pciNames(host);
  const devices: HardwareDevice[] = [];
  let inventoryReason: HardwareFailure | null = null;
  try {
    const entries: { path: string; node: string | null }[] = [];
    try {
      entries.push(...(await host.readdir('/sys/class/drm')).filter(n => /^(?:renderD\d+|card\d+)$/.test(n)).sort()
        .map(name => ({ path: `/sys/class/drm/${name}/device`, node: name.startsWith('render') ? `/dev/dri/${name}` : null })));
    } catch (error) { inventoryReason = hardwareFailure(error); }
    // A bound NVIDIA/CUDA device need not have a DRM node. PCI display-class
    // enumeration also retains unbound GPUs without pretending they can render.
    try {
      const addresses = (await host.readdir('/sys/bus/pci/devices')).filter(n => /^[\da-f]{4}:[\da-f]{2}:[\da-f]{2}\.[\da-f]$/i.test(n)).slice(0, 512);
      const displayDevices = await Promise.all(addresses.map(async address => {
        const dir = `/sys/bus/pci/devices/${address}`;
        const cls = await numberFile(host, `${dir}/class`);
        return cls !== null && (cls >> 16) === 3 ? { path: dir, node: null } : null;
      }));
      for (const device of displayDevices) if (device) entries.push(device);
    } catch (error) { inventoryReason ??= hardwareFailure(error); }
    for (const entry of entries.slice(0, 128)) {
      try {
        const dir = await host.realpath(entry.path);
        const address = path.basename(dir);
        const pci = /^[\da-f]{4}:[\da-f]{2}:[\da-f]{2}\.[\da-f]$/i.test(address) ? address : null;
        const id = pci ?? dir;
        const node = entry.node;
        const existing = devices.find(d => d.id === id);
        if (existing) { if (node) existing.render_nodes.push(node); continue; }
        const identityFailed = (reason: HardwareFailure) => { inventoryReason ??= reason; };
        const vendor = await numberFile(host, `${dir}/vendor`, identityFailed), device = await numberFile(host, `${dir}/device`, identityFailed);
        let driver: string | null = null;
        try { driver = path.basename(await host.realpath(`${dir}/driver`)); } catch { /* Driver may not be bound. */ }
        const pciName = vendor !== null && device !== null ? names.get(key(vendor, device)) : null;
        const memory = unknownMemory();
        if (driver === 'amdgpu') {
          memory.source = 'amdgpu';
          const total = await numberFile(host, `${dir}/mem_info_vram_total`, reason => { memory.reason = reason; });
          const used = await numberFile(host, `${dir}/mem_info_vram_used`);
          if (total !== null) Object.assign(memory, { kind: 'local', source: 'amdgpu', total_mib: total / 1024 ** 2,
            used_mib: used === null ? null : used / 1024 ** 2, free_mib: used !== null && used <= total ? (total - used) / 1024 ** 2 : null, reason: null });
        }
        devices.push({ id, pci_address: pci, vendor_id: vendor, device_id: device,
          name: pciName || fallbackName(vendor, device), name_source: pciName ? 'pci-ids' : 'device-id', driver,
          driver_version: null, render_nodes: node ? [node] : [], memory });
      } catch (error) { inventoryReason ??= hardwareFailure(error); }
    }
  } catch (error) { inventoryReason = hardwareFailure(error); }
  // Electron can identify a GPU even when the sandbox cannot enumerate DRM.
  for (const [index, device] of electron.entries()) {
    // Vulkan headless Chromium reports a zero-ID placeholder, not a third GPU.
    if (!device.vendorId && !device.deviceId && !device.deviceString?.trim()) continue;
    const matches = devices.filter(d => d.vendor_id === device.vendorId && d.device_id === device.deviceId);
    if (matches.length === 1) {
      matches[0].driver_version = device.driverVersion || null;
      if (device.deviceString?.trim()) { matches[0].name = device.deviceString.trim(); matches[0].name_source = 'electron'; }
    } else if (matches.length === 0) devices.push({ id: `electron:${index}`, pci_address: null,
      vendor_id: device.vendorId ?? null, device_id: device.deviceId ?? null,
  name: device.deviceString?.trim() || names.get(key(device.vendorId ?? 0, device.deviceId ?? 0)) || fallbackName(device.vendorId ?? null, device.deviceId ?? null),
      name_source: device.deviceString?.trim() ? 'electron' : 'device-id', driver: null,
      driver_version: device.driverVersion || null, render_nodes: [], memory: unknownMemory(inventoryReason) });
  }
  let native: NativeMemoryInfo;
  try { native = await host.nativeMemory(devices); }
  catch (error) { native = { devices: [], reason: hardwareFailure(error) }; }
  for (const device of devices) {
    const measurement = native.devices.find(d => {
      if (d.source === 'nvml' && device.vendor_id !== 0x10de || d.source === 'drm' && device.vendor_id !== 0x8086) return false;
      return d.pciAddress ? d.pciAddress.toLowerCase() === device.pci_address?.toLowerCase()
        : d.renderNode && device.render_nodes.includes(d.renderNode);
    });
    if (measurement) {
      if (measurement.name) { device.name = measurement.name; device.name_source = 'nvml'; }
      device.memory = { kind: measurement.kind, source: measurement.source, total_mib: measurement.totalMib,
        used_mib: measurement.usedMib, free_mib: measurement.freeMib, reason: measurement.reason };
    } else if (device.memory.source === 'unknown') device.memory.reason = native.reason ?? device.memory.reason;
  }
  const active = electron.filter(d => d.active);
  const renderMatches = active.length === 1 ? devices.filter(d => d.vendor_id === active[0].vendorId && d.device_id === active[0].deviceId) : [];
  return { platform: 'linux', sampled_at: Date.now(), devices, render_device_id: renderMatches.length === 1 ? renderMatches[0].id : null,
    inventory_reason: inventoryReason, chromium: { compositing: 'unknown', rasterization: 'unknown', video_decode: 'unknown', video_encode: 'unknown' },
    acceleration: untestedAcceleration() };
}
