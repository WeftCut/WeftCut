import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog } from '../components/AppDialog';
import { Button } from '../components/ui/button';
import { useOpenComposition, useProjectStore } from '../state/projectStore';
import { layerIdsOf, useSelectionStore } from '../state/selectionStore';
import { correctCaptionText, getProjectSettings, logEmit, setCorrectionScript } from '../ipc';
import { refusalText } from '../errors/tryMutate';
import { CORRECTION_SCRIPT_MAX } from '../../shared/textCorrectionRequest';
import './textCorrection.css';

export function TextCorrectionDialog({ onClose, onMutated }: { onClose: () => void; onMutated: () => Promise<void> }) {
  const { t } = useTranslation();
  const comp = useOpenComposition();
  const projectId = useProjectStore(s => s.summary?.project_id);
  const selection = useSelectionStore(s => s.selection);
  const selected = layerIdsOf(selection);
  const captions = (comp?.tracks ?? []).filter(tr => tr.role === 'caption').flatMap(tr => tr.layers.filter(l => l.params.kind === 'Text').map(l => ({ layer: l, locked: tr.locked || l.locked })));
  const selectedCaptions = captions.filter(c => selected.has(c.layer.id));
  const [scope, setScope] = useState<'selected' | 'all'>(() => selectedCaptions.length ? 'selected' : 'all');
  const [script, setScript] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<Promise<void>>(Promise.resolve());
  const saveError = useRef<unknown>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void getProjectSettings().then(settings => {
      if (!cancelled) { setScript(settings.correction_script ?? ''); setLoaded(true); }
    }).catch(err => { if (!cancelled) setError(refusalText(err)); });
    return () => { cancelled = true; mounted.current = false; };
  }, []);
  const targets = scope === 'selected' ? selectedCaptions : captions;
  const locked = targets.some(c => c.locked);
  const save = (value: string) => {
    setScript(value); setError('');
    const id = projectId;
    if (!id) return;
    // Serial writes preserve typing order. Close/apply await the final write.
    pending.current = pending.current.then(async () => {
      try { await setCorrectionScript(id, value); saveError.current = null; }
      catch (err) { saveError.current = err; if (mounted.current) setError(refusalText(err)); }
    });
  };
  const close = async () => {
    await pending.current;
    if (!saveError.current) onClose();
  };
  const submit = async () => {
    if (!projectId || !comp || busy || !loaded || !script.trim() || !targets.length || locked) return;
    setBusy(true); setError('');
    const targetIds = scope === 'selected' ? targets.map(c => c.layer.id) : null;
    const expected = { script, captions: targets.map(({ layer }) => ({ id: layer.id,
      text: layer.params.kind === 'Text' ? layer.params.content : '', t_start_us: layer.t_start_us, t_end_us: layer.t_end_us })) };
    try {
      await pending.current;
      if (saveError.current) throw saveError.current;
      const result = await correctCaptionText(projectId, comp.id, targetIds, expected);
      await onMutated();
      void logEmit({ level: 'info', category: { kind: 'Project' }, source: { kind: 'User' },
        message: `Text correction completed (${result.changed} captions changed)`,
        i18n_key: 'text_correction.completed', i18n_args: { count: result.changed } });
      onClose();
    } catch (err) { if (mounted.current) setError(refusalText(err)); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <AppDialog title={t('text_correction.title')} panelClassName="text-correction-panel" onClose={busy ? undefined : () => { void close(); }}>
    <label className="text-correction-field">
      <span>{t('text_correction.script')}</span>
      <textarea className="app-input" value={script} onChange={e => save(e.target.value)} rows={12} maxLength={CORRECTION_SCRIPT_MAX} disabled={!loaded || busy} spellCheck={false} autoFocus aria-label={t('text_correction.script')} placeholder={t('text_correction.placeholder')} />
    </label>
    <p className="text-correction-hint">{t('text_correction.saved_with_project')}</p>
    <label className="text-correction-scope">
      <span>{t('text_correction.scope')}</span>
      <select className="app-input" value={scope} onChange={e => setScope(e.target.value as 'selected' | 'all')} disabled={busy}>
        <option value="selected" disabled={!selectedCaptions.length}>{t('text_correction.selected', { count: selectedCaptions.length })}</option>
        <option value="all">{t('text_correction.all', { count: captions.length })}</option>
      </select>
    </label>
    {locked && <p role="status">{t('text_correction.locked')}</p>}
    {error && <p className="text-correction-error" role="alert">{error}</p>}
    <footer>
      <Button size="lg" variant="ghost" disabled={!loaded || busy || !script.length} onClick={() => save('')}>{t('text_correction.clear')}</Button>
      <Button size="lg" disabled={busy} onClick={() => { void close(); }}>{t('text_correction.close')}</Button>
      <Button size="lg" variant="default" disabled={!loaded || busy || !script.trim() || !targets.length || locked} onClick={() => { void submit(); }}>
        {busy ? t('text_correction.running') : t(scope === 'selected' ? 'text_correction.apply_selected' : 'text_correction.apply_all', { count: targets.length })}
      </Button>
    </footer>
  </AppDialog>;
}
