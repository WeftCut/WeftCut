import type {ProjectOpenedPayload} from '../../shared/project-events'

/** Adopt main's authoritative open project even if its event preceded mount. */
export function createProjectRoute(deps: {
  listen: (opened:()=>void) => Promise<()=>void>
  read: () => Promise<ProjectOpenedPayload|null>
  editor: (remount:boolean) => void
  startup: () => void
  onError: (error:unknown) => void
}) {
  let selected = false
  let resolveReady!:()=>void
  const ready = new Promise<void>(resolve=>{resolveReady=resolve})
  const route = {
    ready,
    get selected() { return selected },
    editor(remount=false) { selected=true; deps.editor(remount) },
    startup() { if (!selected) deps.startup() },
    close() { selected=false; deps.startup() },
    mount() {
      let disposed=false, observed=false, off:(()=>void)|undefined
      // Attach before querying so an open concurrent with the query wins over
      // the snapshot, and never causes a duplicate editor remount.
      void deps.listen(()=>{observed=true;if(!disposed) route.editor(true)}).then(async unsubscribe=>{
        if(disposed) {unsubscribe();return}
        off=unsubscribe
        const project=await deps.read()
        if(!disposed&&!observed&&project!==null) route.editor(true)
        if(!disposed) resolveReady()
      }).catch(error=>{if(!disposed) {resolveReady();deps.onError(error)}})
      return ()=>{disposed=true;off?.()}
    },
  }
  return route
}
