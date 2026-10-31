import type { HardwareDevice } from '../shared/hardware-diagnostics';

/** No implicit switch to another GPU when an explicit device was selected.
 * NVDEC's existing ABI opens the default CUDA device, so an explicit NVIDIA
 * selection is honest only when exactly one NVIDIA device is visible. */
export function decodeDeviceTargets(choice: string, inventory: HardwareDevice[], advertised: string[]) {
  const nvidia = inventory.filter(d => d.vendor_id === 0x10de);
  const selected = inventory.find(d => d.id === choice);
  const nodes = inventory.filter(d => d.vendor_id !== 0x10de).flatMap(d => d.render_nodes);
  if (choice === 'cpu') return { lanes: [] as string[], nodes: [] as string[] };
  if (choice === 'auto') return { lanes: advertised, nodes };
  if (selected?.vendor_id === 0x10de && nvidia.length === 1)
    return { lanes: advertised.filter(l => l === 'nvdec'), nodes: [] as string[] };
  if (selected && selected.vendor_id !== 0x10de)
    return { lanes: advertised.filter(l => l === 'vaapi'), nodes: selected.render_nodes };
  return { lanes: [] as string[], nodes: [] as string[] };
}
