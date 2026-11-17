import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface OriginalMediaPath {
  path: string
  filename: string
  local: boolean
}

/** Keep a foreign source's filename for relinking without opening its path. */
export function originalMediaPath(src: string, platform: NodeJS.Platform = process.platform): OriginalMediaPath {
  const invalid = () => new Error('Media must use an absolute local file URL (Windows drive or POSIX path). Network shares, devices and traversal are unsupported. Relink the original in the source editor and export again')
  if (!/^file:\/\/[^\\]/i.test(src) || /[\x00-\x1f\x7f\\]|%2f|%5c/i.test(src)) throw invalid()
  let url: URL, raw: string, pathname: string
  try {
    url = new URL(src)
    raw = decodeURIComponent(src)
    pathname = decodeURIComponent(url.pathname)
  } catch { throw invalid() }
  if (url.protocol !== 'file:' || url.hostname || url.search || url.hash ||
      /[\x00-\x1f\x7f\\]/.test(raw) || raw.split('/').some(part => part === '.' || part === '..')) throw invalid()

  const windows = /^\/[A-Za-z]:\//.test(pathname)
  if (pathname.startsWith('//') || pathname.endsWith('/') || (/^\/[A-Za-z]:/.test(pathname) && !windows)) throw invalid()
  let path: string
  try { path = fileURLToPath(url, { windows }) } catch { throw invalid() }
  const rules = windows ? win32 : posix
  if (!rules.isAbsolute(path)) throw invalid()
  if (windows) {
    const components = pathname.slice(4).split('/')
    const device = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]) *(?:\.|$)/i
    if (components.some(part => !part || /[<>:"|?*]|[. ]$/.test(part) || device.test(part))) throw invalid()
  }
  return { path, filename: rules.basename(path), local: windows === (platform === 'win32') }
}
