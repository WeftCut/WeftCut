/** Native Wayland cannot use Chromium's X11 Vulkan surface configuration.
 * Respect an explicit X11/software choice; no display server is installed or
 * replaced here. This only adapts an already available Wayland session. */
export function nativeWaylandSwitches(platform: string, ozone: string, socketAvailable: boolean, angle: string): [string, string][] {
  if (platform !== 'linux' || ozone === 'x11' || !socketAvailable || (ozone && ozone !== 'auto' && ozone !== 'wayland')) return [];
  const switches: [string, string][] = [['ozone-platform', 'wayland']];
  if (!angle || angle === 'vulkan') switches.push(['use-gl', 'angle'], ['use-angle', 'gl']);
  return switches;
}
