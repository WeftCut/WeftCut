import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/button';
import type { PerformanceResourceInfo } from '../../shared/performance-budgets';
import type { RendererHardwareDiagnostics } from '../../shared/hardware-diagnostics';
import type { PreviewDecodeDevice } from '../render/decoder/session';
import { HardwareDiagnosticsDialog } from './HardwareDiagnosticsDialog';
import { probeRendererHardware } from './probeRendererHardware';
import { AppSelect } from '../components/AppSelect';

const size = (mib: number) => `${(mib / 1024).toFixed(1)} GiB`;
const emptyDevices: PreviewDecodeDevice[] = [];

function describeDecodeDevices(resources: PerformanceResourceInfo | null, devices: PreviewDecodeDevice[], t: TFunction) {
  const labels = new Map<string, string>();
  for (const decoder of devices) {
    if (decoder.kind === 'software') { labels.set('cpu', t('hardware.decode_cpu')); continue; }
    if (decoder.kind === 'browser') { labels.set('browser', t('hardware.decode_browser')); continue; }
    const inventory = resources?.hardware?.devices ?? [];
    // VAAPI supplies an explicit node. NVDEC currently opens the default CUDA
    // device, so associate it only when inventory contains exactly one NVIDIA GPU.
    const candidates = decoder.backend === 'vaapi' && decoder.device
      ? inventory.filter(device => device.render_nodes.includes(decoder.device!))
      : decoder.backend === 'nvdec' ? inventory.filter(device => device.vendor_id === 0x10de) : [];
    if (candidates.length === 1) labels.set(candidates[0]!.id, candidates[0]!.name);
    else if (decoder.backend === 'd3d11va' && resources?.gpu) labels.set(resources.gpu.luid, resources.gpu.name);
    else labels.set(`${decoder.backend}:${decoder.device}`, t(decoder.backend === 'videotoolbox' ? 'hardware.decode_system' : 'hardware.decode_device_unknown'));
  }
  return labels;
}

function DecodeDevices({ resources, devices }: { resources: PerformanceResourceInfo | null; devices: PreviewDecodeDevice[] }) {
  const { t } = useTranslation();
  const labels = describeDecodeDevices(resources, devices, t);
  return <dd data-testid="current-decode-devices">
    {labels.size ? <ul className="settings-decode-devices">{[...labels].map(([key, label]) => <li key={key}>{label}</li>)}</ul>
      : t('hardware.decode_idle')}
  </dd>;
}

export function HardwareSection({ resources, decodeDevices = emptyDevices, stale, refresh, decodeDevice = 'auto', chooseDevice, deviceSelectionDisabled = false }: {
  resources: PerformanceResourceInfo | null; decodeDevices?: PreviewDecodeDevice[]; stale: boolean; refresh(): Promise<void>;
  decodeDevice?: string; chooseDevice?: ((device: string) => void) | undefined; deviceSelectionDisabled?: boolean;
}) {
  const { t } = useTranslation();
  const hardware = resources?.hardware;
  const [renderer, setRenderer] = useState<RendererHardwareDiagnostics | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    if (diagnosticsOpen && hardware?.platform === 'linux') void probeRendererHardware().then(value => { if (alive) setRenderer(value); });
    return () => { alive = false; };
  }, [diagnosticsOpen, hardware?.platform]);
  const detect = async () => {
    setPending(true); setError(false);
    try {
      await Promise.all([window.api.performanceResources.probe(), probeRendererHardware().then(setRenderer)]);
      await refresh();
    } catch { setError(true); }
    finally { setPending(false); }
  };
  return <section className="settings-section" data-testid="hardware-section">
    <div className="settings-performance-heading">
      <h3>{t('performance.hardware_heading')}</h3>
      {hardware && <Button variant="outline" onClick={() => setDiagnosticsOpen(true)}>{t('hardware.open_diagnostics')}</Button>}
    </div>
    <dl className="settings-performance-allocation">
      {resources?.cpu && <div><dt>{t('hardware.cpu')}</dt><dd>{resources.cpu.name}<br />{t('hardware.cpu_processors', { count: resources.cpu.logical_processors })}</dd></div>}
      <div><dt>{t('performance.hardware_ram')}</dt><dd>{resources && !stale ? size(resources.total_memory_mib) : t('performance.unknown')}</dd></div>
      <div><dt>{t('hardware.current_decode_device')}</dt><DecodeDevices resources={resources} devices={decodeDevices} /></div>
    </dl>
    {chooseDevice && hardware?.platform === 'linux' && <div className="settings-control-row">
      <div className="settings-performance-copy"><span className="settings-toggle-label">{t('hardware.preferred_decode_device')}</span>
        <p className="settings-toggle-hint">{t('hardware.decode_device_hint')}</p></div>
      <AppSelect className="settings-select" ariaLabel={t('hardware.preferred_decode_device')} value={decodeDevice}
        disabled={deviceSelectionDisabled} onValueChange={chooseDevice}
        options={[
          { value: 'auto', label: t('hardware.decode_auto') },
          { value: 'cpu', label: t('hardware.decode_cpu') },
          ...hardware.devices.filter(d => d.pci_address).map(d => ({ value: d.id,
            label: `${d.name} · ${d.vendor_id === 0x10de ? 'NVDEC' : 'VAAPI'}${d.memory.total_mib !== null ? ' · ' + size(d.memory.total_mib) : ''}`,
            disabled: d.vendor_id === 0x10de && hardware.devices.filter(g => g.vendor_id === 0x10de).length !== 1 })),
          ...(!['auto','cpu',...hardware.devices.map(d => d.id)].includes(decodeDevice)
            ? [{ value: decodeDevice, label: `${decodeDevice} · ${t('hardware.status_unavailable')}`, disabled: true }] : []),
        ]} />
    </div>}
    {chooseDevice && hardware?.devices.filter(d => d.vendor_id && d.memory.total_mib !== null).map(device => <div key={device.id} className="settings-control-row" data-testid="hardware-memory-meter">
      <div className="settings-performance-copy"><span className="settings-toggle-label">{device.name}</span>
        <p className="settings-toggle-hint">{t('hardware.memory_scope')} · {t(`hardware.source_${device.memory.source}`)}</p></div>
      <div><div>{device.memory.used_mib === null ? t('hardware.source_unknown') : size(device.memory.used_mib)} / {size(device.memory.total_mib!)}
      </div>{device.memory.used_mib !== null && <meter aria-label={device.name} min={0} max={device.memory.total_mib!} value={device.memory.used_mib} />}</div>
    </div>)}
    {decodeDevices.length > 0 && <p className="settings-toggle-hint">{t('hardware.decode_session_scope')}</p>}
    {stale && <p className="settings-toggle-hint" role="status">{t('hardware.stale')}</p>}
    {diagnosticsOpen && hardware && <HardwareDiagnosticsDialog hardware={hardware} renderer={renderer}
      testing={pending || hardware.acceleration.status === 'running'} onDetect={() => void detect()}
      onRefresh={() => { setError(false); void refresh().catch(() => setError(true)); }}
      error={error ? t('hardware.reason_probe-failed') : hardware.acceleration.status === 'failed'
        ? t(`hardware.reason_${hardware.acceleration.reason ?? 'probe-failed'}`) : null}
      onClose={() => setDiagnosticsOpen(false)} />}
  </section>;
}
