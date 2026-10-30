import { expect, it } from 'vitest';
import { nativeWaylandSwitches } from './linuxDisplay';
it('uses native Wayland GL only with an available Wayland socket', () => {
  expect(nativeWaylandSwitches('linux', '', true, '')).toContainEqual(['use-angle', 'gl']);
  expect(nativeWaylandSwitches('linux', 'wayland', true, 'vulkan')).toContainEqual(['use-angle', 'gl']);
  expect(nativeWaylandSwitches('linux', '', false, '')).toEqual([]);
  expect(nativeWaylandSwitches('linux', 'x11', true, 'vulkan')).toEqual([]);
  expect(nativeWaylandSwitches('win32', '', true, '')).toEqual([]);
  expect(nativeWaylandSwitches('linux', 'wayland', true, 'swiftshader')).not.toContainEqual(['use-angle', 'gl']);
});
