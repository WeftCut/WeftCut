import { Menu } from '@base-ui/react/menu';
import { useTranslation } from 'react-i18next';
import { useEffect } from 'react';
import { CROP_MENU_COMMAND_IDS, useCanEditCrop } from '../commands/cropCommands';
import { CommandContextItem } from '../menu/CommandContextItem';
import { contextMenuFinalFocus } from '../menu/Menu';
import { useCursorAnchor } from '../timeline/contextMenuAnchor';

export function CropContextMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  const { t } = useTranslation();
  const anchor = useCursorAnchor(x, y);
  const available = useCanEditCrop();
  useEffect(() => { if (!available) onClose(); }, [available, onClose]);
  return <Menu.Root open modal={false} onOpenChange={open => { if (!open) onClose(); }}>
    <Menu.Portal>
      <Menu.Positioner anchor={anchor} side="bottom" align="start" sideOffset={0} className="app-popup-positioner">
        <Menu.Popup className="app-menu-list" aria-label={t('crop.title')} finalFocus={contextMenuFinalFocus}>
          {CROP_MENU_COMMAND_IDS.map(id => <CommandContextItem key={id} id={id} onRun={onClose} />)}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>;
}
