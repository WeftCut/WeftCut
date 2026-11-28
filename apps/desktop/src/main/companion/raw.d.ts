// Vite's `?raw` and `?inline` imports as main sees them: main does not load
// `vite/client`'s types. `pageFiles.ts` reads the companion page's files this
// way; `?inline` gives a file as a base64 `data:` URL, for binary files.
declare module '*?raw' {
  const source: string
  export default source
}
declare module '*?inline' {
  const dataUrl: string
  export default dataUrl
}
