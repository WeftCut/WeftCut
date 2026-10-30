import { expect, it } from 'vitest';
import { decodeDeviceTargets } from './decodeDeviceTargets';
import { readDecodeDevice, validDecodeDevice } from '../shared/decode-device';
import type { HardwareDevice } from '../shared/hardware-diagnostics';
const inventory = [
  { id: '0000:01:00.0', vendor_id: 0x10de, render_nodes: ['/dev/dri/renderD128'] },
  { id: '0000:04:00.0', vendor_id: 0x1002, render_nodes: ['/dev/dri/renderD129'] },
] as HardwareDevice[];
it('pins CPU, NVIDIA NVDEC and AMD VAAPI without choosing another GPU', () => {
  expect(decodeDeviceTargets('cpu',inventory,['nvdec','vaapi']).lanes).toEqual([]);
  expect(decodeDeviceTargets('0000:01:00.0',inventory,['nvdec','vaapi'])).toEqual({lanes:['nvdec'],nodes:[]});
  expect(decodeDeviceTargets('0000:04:00.0',inventory,['nvdec','vaapi'])).toEqual({lanes:['vaapi'],nodes:['/dev/dri/renderD129']});
  expect(decodeDeviceTargets('auto',inventory,['nvdec','vaapi']).nodes).toEqual(['/dev/dri/renderD129']);
  expect(decodeDeviceTargets('0000:05:00.0',inventory,['nvdec','vaapi']).lanes).toEqual([]);
});
it('does not invent per-NVIDIA selection when the native ABI opens its default device', () => {
  expect(decodeDeviceTargets('0000:01:00.0',[...inventory,{...inventory[0]!,id:'0000:02:00.0'}],['nvdec']).lanes).toEqual([]);
});
it('accepts only local intent and stable PCI identities, never arbitrary device paths', () => {
  for (const value of ['cpu','auto','0000:AB:00.0']) expect(validDecodeDevice(value)).toBe(true);
  for (const value of [null,1,'/dev/dri/renderD129','../../file','0000:04:00.8','']) expect(validDecodeDevice(value)).toBe(false);
  expect(readDecodeDevice('0000:AB:00.0')).toBe('0000:ab:00.0');
  expect(readDecodeDevice(null)).toBe('auto');
});
