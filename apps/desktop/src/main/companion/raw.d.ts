// Vite's `?raw` import as main sees it: main does not load `vite/client`'s
// types. `pageFiles.ts` reads the companion page's files this way.
declare module '*?raw' {
  const source: string
  export default source
}
