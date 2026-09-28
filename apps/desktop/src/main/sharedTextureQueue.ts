// One queue for all producers: preload correlates Electron's unlabelled texture
// callbacks with ordered slot announcements, including video and Motif pools.
let tail: Promise<unknown> = Promise.resolve()
export function withSharedTextureQueue<T>(open: () => Promise<T>): Promise<T> {
  const result = tail.catch(() => {}).then(open)
  tail = result
  return result
}
