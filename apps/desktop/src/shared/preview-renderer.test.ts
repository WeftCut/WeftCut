import { expect, it } from 'vitest';
import { previewRendererArgument, readPreviewRendererArgument } from './preview-renderer';

it('uses GL for native Wayland server preview without changing other sessions', () => {
  expect(previewRendererArgument('linux', true, 'wayland')).toBe('--weftcut-preview-renderer=webgl');
  for (const [platform, server, ozone] of [['linux', true, 'x11'], ['linux', false, 'wayland'], ['win32', true, '']] as const) {
    expect(previewRendererArgument(platform, server, ozone)).toBe('--weftcut-preview-renderer=webgpu');
  }
});
it('accepts an explicit backend and ignores invalid values', () => {
  expect(previewRendererArgument('linux', true, 'wayland', 'webgpu')).toBe('--weftcut-preview-renderer=webgpu');
  expect(readPreviewRendererArgument(['--weftcut-preview-renderer=webgl'])).toBe('webgl');
  expect(readPreviewRendererArgument(['--weftcut-preview-renderer=invalid'])).toBe('webgpu');
});
