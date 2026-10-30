import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AppIcon } from '@/components/AppIcon';
import { AppDialog } from '../components/AppDialog';
import type { CodecHardwareProbe, HardwareDevice, HardwareDiagnostics, HardwareProbeResult, RendererHardwareDiagnostics } from '../../shared/hardware-diagnostics';

function Status({ result }: { result: HardwareProbeResult }) {
  const { t } = useTranslation();
  return <span className="settings-hardware-status">
    <span className="settings-hardware-verdict" data-status={result.status}>{t(`hardware.status_${result.status}`)}</span>
    {result.reason && <span className="settings-hardware-reason">{t(`hardware.reason_${result.reason}`)}</span>}
  </span>;
}
const size = (mib: number) => `${(mib / 1024).toFixed(1)} GiB`;

function DiagnosticDevice({ device }: { device: HardwareDevice }) {
  const { t } = useTranslation();
  const memory = device.memory;
  return <div className="settings-hardware-device">
    <h4 className="settings-hardware-name">{device.name}</h4>
    <dl className="settings-performance-allocation">
      <div><dt>{t(`hardware.memory_${memory.kind}`)}</dt><dd>{memory.kind === 'shared' ? t('performance.shared_gpu_memory')
        : memory.total_mib !== null ? size(memory.total_mib) : t('hardware.source_unknown')}</dd></div>
      {memory.used_mib !== null && <div><dt>{t('hardware.device_memory_used')}</dt><dd>{size(memory.used_mib)}</dd></div>}
      {memory.free_mib !== null && <div><dt>{t('hardware.device_memory_free')}</dt><dd>{size(memory.free_mib)}</dd></div>}
      {device.driver && <div><dt>{t('hardware.driver')}</dt><dd>{device.driver}{device.driver_version ? ` ${device.driver_version}` : ''}</dd></div>}
      {device.pci_address && <div><dt>PCI</dt><dd>{device.pci_address}</dd></div>}
      {device.render_nodes.length > 0 && <div><dt>{t('hardware.render_nodes')}</dt><dd>{device.render_nodes.join(', ')}</dd></div>}
      <div><dt>{t('hardware.identity_source')}</dt><dd>{t(`hardware.source_${device.name_source}`)}</dd></div>
      <div><dt>{t('hardware.memory_source')}</dt><dd>{t(`hardware.source_${memory.source}`)}</dd></div>
    </dl>
    {memory.reason && <p className="settings-toggle-hint">{t(`hardware.reason_${memory.reason}`)}</p>}
    {memory.used_mib !== null && <p className="settings-toggle-hint">{t('hardware.memory_scope')}</p>}
  </div>;
}

function CodecResults({ title, results, devices }: { title: string; results: CodecHardwareProbe[]; devices: HardwareDevice[] }) {
  const { t } = useTranslation();
  const groups = new Map<string, { device: string; backend: string; rows: CodecHardwareProbe[] }>();
  const deviceNames = new Map(devices.map(device => [device.id, device.name]));
  for (const row of results) {
    const backend = (row.backend.split('_').at(-1) ?? row.backend).toUpperCase();
    const key = JSON.stringify([backend, row.device_id, row.device_path]);
    let group = groups.get(key);
    if (!group) {
      group = { device: deviceNames.get(row.device_id ?? '') ?? row.device_path ?? row.device_id ?? t('hardware.probe_device_unresolved'),
        backend, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  return <div className="settings-hardware-codecs"><h4>{title}</h4>
    {!results.length ? <p className="settings-toggle-hint">{t('hardware.status_not-tested')}</p>
      : [...groups].map(([key, group]) => <section key={key} className="settings-hardware-codec-group"
        aria-label={`${group.backend} — ${group.device}`} data-testid="hardware-codec-group">
        <h5>{group.backend}</h5><p className="settings-toggle-hint">{group.device}</p>
        <ul>{group.rows.map(row => <li key={`${row.codec}:${row.bit_depth}`}>
          <span>{row.codec === 'h264' ? 'H.264' : row.codec.toUpperCase()} <span className="settings-hardware-bit-depth">{row.bit_depth}-bit</span></span>
          <span className="settings-hardware-result"><Status result={row} /></span>
          {row.detail && <details className="settings-hardware-details"><summary>{t('hardware.probe_details')}</summary><pre className="settings-hardware-probe-output">{row.detail}</pre></details>}
        </li>)}</ul>
      </section>)}
  </div>;
}

function featureStatus(value: string) {
  return value.startsWith('enabled') ? 'hardware.enabled' : value.includes('software') ? 'hardware.software_processing'
    : value.startsWith('disabled') ? 'hardware.disabled' : 'performance.unknown';
}

export function HardwareDiagnosticsDialog({ hardware, renderer, onClose, testing, onDetect, onRefresh, error }: {
  hardware: HardwareDiagnostics; renderer: RendererHardwareDiagnostics | null; onClose(): void;
  testing: boolean; onDetect(): void; onRefresh(): void; error: string | null;
}) {
  const { t } = useTranslation();
  const probeHeadingId = useId();
  const probeStatus = testing ? 'hardware.testing' : hardware.acceleration.status === 'complete' ? 'hardware.test_complete'
    : error || hardware.acceleration.status === 'failed' ? 'hardware.test_incomplete' : 'hardware.status_not-tested';
  return <AppDialog title={t('hardware.diagnostics_title')} onClose={onClose} panelClassName="settings-panel settings-hardware-diagnostics"
    headerExtra={<Button className="settings-hardware-refresh" variant="ghost" size="icon-xs" disabled={testing} onClick={onRefresh}
      aria-label={t('hardware.refresh')} title={t('hardware.refresh')}>
      <AppIcon icon={RefreshCw} size="heading" aria-hidden />
    </Button>}>
    <div className="settings-body settings-card">
      <section className="settings-hardware-probe-card" aria-labelledby={probeHeadingId} aria-busy={testing}>
        <div className="settings-hardware-probe-heading">
          <div className="settings-hardware-probe-copy">
            <h3 id={probeHeadingId}>{t('hardware.probe_heading')}</h3>
            <p className="settings-toggle-hint">{t('hardware.probe_scope')}</p>
          </div>
          <Button variant="secondary" disabled={testing} onClick={onDetect}>
            {testing && <AppIcon icon={LoaderCircle} size="body" className="motion-safe:animate-spin" aria-hidden />}
            {t(testing ? 'hardware.testing' : 'hardware.detect')}
          </Button>
        </div>
        <div className="settings-hardware-probe-meta">
          <span role="status">{t(probeStatus)}</span>
          {!testing && hardware.acceleration.sampled_at && <span>{t('hardware.sampled_at', { time: new Date(hardware.acceleration.sampled_at).toLocaleString() })}</span>}
        </div>
        {error && <p className="settings-hardware-probe-error" role="alert">{error}</p>}
      </section>
      <section className="settings-section">
        <h3>{t('hardware.diagnostics_devices')}</h3>
        {hardware.devices.map(device => <DiagnosticDevice key={device.id} device={device} />)}
        {!hardware.devices.length && <p className="settings-toggle-hint">{t('hardware.no_devices')}</p>}
        {hardware.inventory_reason && <p className="settings-toggle-hint">{t(`hardware.reason_${hardware.inventory_reason}`)}</p>}
        {!hardware.render_device_id && hardware.devices.length > 0 && <p className="settings-toggle-hint">{t('hardware.render_unresolved')}</p>}
      </section>
      <section className="settings-section">
        <h3>{t('hardware.render_heading')}</h3>
        <dl className="settings-performance-allocation">
          <div><dt>{t('hardware.compositing')}</dt><dd>{t(featureStatus(hardware.chromium.compositing))}</dd></div>
          {(['webgl', 'webgpu'] as const).map(api => <div key={api}><dt>{api === 'webgl' ? 'WebGL2' : 'WebGPU'}</dt>
            <dd>{renderer ? <Status result={renderer[api]} /> : t('hardware.testing')}</dd></div>)}
        </dl>
        {(['webgl', 'webgpu'] as const).map(api => renderer?.[api].renderer && <pre key={api} className="settings-hardware-probe-output">{renderer[api].renderer}</pre>)}
        <div data-testid="browser-media-status">
          <h4 className="settings-hardware-subheading">{t('hardware.browser_media')}</h4>
          <dl className="settings-performance-allocation">
            {(['video_decode', 'video_encode'] as const).map(key => <div key={key}><dt>{t(`hardware.${key}`)}</dt><dd>{t(featureStatus(hardware.chromium[key]))}</dd></div>)}
          </dl>
          <p className="settings-toggle-hint">{t('hardware.browser_media_scope')}</p>
        </div>
      </section>
      <section className="settings-section">
        <h3>{t('hardware.acceleration_heading')}</h3>
        {hardware.motif_gpu && <div data-testid="motif-gpu-transport">
          <h4>{t('hardware.motif_gpu_heading')}</h4>
          <p role="status">{t(`hardware.motif_gpu_${hardware.motif_gpu.state}`)}</p>
          {hardware.motif_gpu.reason && <p className="settings-toggle-hint">{t(`hardware.motif_gpu_reason_${hardware.motif_gpu.reason}`)}</p>}
          {hardware.motif_gpu.gpu_ms !== null && hardware.motif_gpu.png_ms !== null && <dl className="settings-performance-allocation">
            <div><dt>{t('hardware.motif_gpu_timing')}</dt><dd>{hardware.motif_gpu.gpu_ms.toFixed(1)} ms</dd></div>
            <div><dt>{t('hardware.motif_png_timing')}</dt><dd>{hardware.motif_gpu.png_ms.toFixed(1)} ms</dd></div>
          </dl>}
          <p className="settings-toggle-hint">{t('hardware.motif_gpu_scope')}</p>
        </div>}
        <CodecResults title={t('hardware.decode_heading')} results={hardware.acceleration.decode} devices={hardware.devices} />
        <CodecResults title={t('hardware.encode_heading')} results={hardware.acceleration.encode} devices={hardware.devices} />
        <p className="settings-toggle-hint">{t('hardware.decode_scope')}</p>
      </section>
    </div>
  </AppDialog>;
}
