import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOutputIcon } from 'lucide-react';
import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { Button } from '@/components/ui/button';
import { getMotifCover, type MotifSummary } from '../ipc';
import { formatTimecode } from '../frames';
import { MenuItem, contextMenuFinalFocus } from '../menu/Menu';
import { useCursorAnchor } from '../timeline/contextMenuAnchor';

export function MotifCard({ motif, selected, fpsNum, fpsDen, onSelect, onExport, onDelete }: {
  motif: MotifSummary; selected: boolean; fpsNum: number; fpsDen: number;
  onSelect: () => void; onExport: () => void; onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <div className={`motif-card${selected ? ' motif-card-selected' : ''}`}
      onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
      onKeyDown={e => {
        if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        setMenu({ x: rect.left + 12, y: rect.top + 12 });
      }}>
      <button type="button" className="motif-card-select" title={motif.id} aria-pressed={selected} onClick={onSelect}>
        <MotifCover key={`${motif.id}:${motif.content_hash}`} motif={motif} />
        <span className="motif-card-title">
          <span className="motif-card-name">{motif.name}</span>
          <span className={`motif-card-status status-${motif.status ?? 'builtin'}`}>
            {t(`motif_picker.status.${motif.status ?? 'builtin'}`)}
          </span>
        </span>
      </button>
      <div className="motif-card-footer">
        <span className="motif-card-meta">{motif.size[0]}×{motif.size[1]} · {formatTimecode(Math.round(motif.default_duration_s * 1_000_000), fpsNum, fpsDen)}</span>
        <Button variant="ghost" size="icon-xs" title={t('motif_picker.export_button')}
          aria-label={t('motif_picker.export_button')} onClick={onExport}>
          <FolderOutputIcon size={14} aria-hidden />
        </Button>
      </div>
      {menu && <MotifCardMenu motif={motif} {...menu} onClose={() => setMenu(null)} onExport={onExport} onDelete={onDelete} />}
    </div>
  );
}

function MotifCardMenu({ motif, x, y, onClose, onExport, onDelete }: {
  motif: MotifSummary; x: number; y: number;
  onClose: () => void; onExport: () => void; onDelete: () => void;
}) {
  const { t } = useTranslation();
  const anchor = useCursorAnchor(x, y);
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('scroll', close, true);
    return () => window.removeEventListener('scroll', close, true);
  }, [onClose]);
  return <MenuPrimitive.Root open modal={false} onOpenChange={open => { if (!open) onClose(); }}>
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner anchor={anchor} side="bottom" align="start" sideOffset={0} className="app-popup-positioner">
        <MenuPrimitive.Popup className="app-menu-list" finalFocus={contextMenuFinalFocus} aria-label={motif.name}>
          <MenuItem label={t('motif_picker.export_button')} onSelect={onExport} />
          {(motif.status === 'draft' || motif.status === 'installed') &&
            <MenuItem label={t('motif_picker.delete_button')} onSelect={onDelete} />}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  </MenuPrimitive.Root>;
}

/** Only visible cards request covers. Main owns capture, deduplication and disk
 * persistence; this module owns visibility and the lifetime of its image URL. */
function MotifCover({ motif }: { motif: MotifSummary }) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { root: host.current?.closest('.motif-picker-list') ?? null, rootMargin: '100px' });
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let imageUrl: string | undefined;
    void getMotifCover(motif.id, motif.content_hash ?? '').then(blob => {
      if (cancelled) return;
      imageUrl = URL.createObjectURL(blob);
      setUrl(imageUrl);
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; if (imageUrl) URL.revokeObjectURL(imageUrl); };
  }, [visible, motif.id, motif.content_hash]);
  return <div ref={host} className="motif-preview-host" style={{ maxWidth: 240 }}>
    {url && <img src={url} alt={`preview-${motif.id}`} />}
    {!url && !error && <span className="motif-preview-loading" role="status" aria-label={t('motif_picker.preview_loading')} />}
    {error && <span className="settings-status">{t('motif_picker.cover_unavailable')}</span>}
  </div>;
}
