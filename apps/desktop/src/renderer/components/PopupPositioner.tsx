import { useSyncExternalStore, type ComponentProps } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Select } from '@base-ui/react/select';
import { Popover } from '@base-ui/react/popover';

function subscribeToResize(onChange: () => void) {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}

const viewportHeight = () => window.innerHeight;
const serverHeight = () => 0;

function usePopupPadding() {
  const height = useSyncExternalStore(subscribeToResize, viewportHeight, serverHeight);
  return { top: 5, right: 5, bottom: Math.max(5, Math.ceil(height * 0.1)), left: 5 };
}

// Reserve the bottom 10% of the window in the positioning boundary itself.
// Internal controls may shift into the safe area when opened near the bottom.
// The top-level app bar opts out to keep its dropdowns below their triggers.
export function AppMenuPositioner(props: ComponentProps<typeof Menu.Positioner>) {
  return <Menu.Positioner sticky {...props} collisionPadding={usePopupPadding()} />;
}

export function AppSelectPositioner(props: ComponentProps<typeof Select.Positioner>) {
  return <Select.Positioner sticky {...props} collisionPadding={usePopupPadding()} />;
}

export function AppPopoverPositioner(props: ComponentProps<typeof Popover.Positioner>) {
  return <Popover.Positioner sticky {...props} collisionPadding={usePopupPadding()} />;
}
