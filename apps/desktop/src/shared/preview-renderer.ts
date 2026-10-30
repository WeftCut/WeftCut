export type PreviewRenderer = 'webgl' | 'webgpu';
const PREFIX = '--weftcut-preview-renderer=';

/** Keep the compatibility choice local to preview; export retains its own
 * capability probes and GPU selection. Native Wayland server presentation
 * currently needs GL, not Chromium's software WebGPU adapter. */
export function previewRendererArgument(platform: string, server: boolean, ozone: string, requested?: string): string {
  const renderer: PreviewRenderer = requested === 'webgl' || requested === 'webgpu'
    ? requested : platform === 'linux' && server && ozone === 'wayland' ? 'webgl' : 'webgpu';
  return PREFIX + renderer;
}

export function readPreviewRendererArgument(argv: readonly string[]): PreviewRenderer {
  return argv.includes(PREFIX + 'webgl') ? 'webgl' : 'webgpu';
}
