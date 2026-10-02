import {describe,it,expect,vi} from 'vitest'
import {createProjectRoute} from './projectRoute'
function setup(read=vi.fn(async()=>null as {dir:string}|null)) {
  let opened!:()=>void
  const editor=vi.fn(),startup=vi.fn(),off=vi.fn(),onError=vi.fn()
  const listen=vi.fn(async(callback:()=>void)=>{opened=callback;return off})
  const route=createProjectRoute({listen,read,editor,startup,onError})
  return {route,read,editor,startup,off,onError,opened:()=>opened()}
}
describe('authoritative project routing during renderer boot',()=>{
  it('adopts a project opened before React subscribed, then ignores stale startup preferences',async()=>{
    const h=setup(vi.fn(async()=>({dir:'/agent-project'})))
    const dispose=h.route.mount();await h.route.ready
    expect(h.editor).toHaveBeenCalledWith(true)
    h.route.startup();expect(h.startup).not.toHaveBeenCalled()
    expect(h.route.selected).toBe(true);dispose();expect(h.off).toHaveBeenCalledOnce()
  })
  it('an event during initial snapshot wins without duplicate remount',async()=>{
    let finish!:(value:{dir:string})=>void
    const h=setup(vi.fn(()=>new Promise<{dir:string}|null>(resolve=>{finish=resolve})))
    const dispose=h.route.mount();await vi.waitFor(()=>expect(h.read).toHaveBeenCalledOnce())
    h.opened();finish({dir:'/old-snapshot'});await h.route.ready
    expect(h.editor).toHaveBeenCalledTimes(1);dispose()
  })
  it('keeps startup selection available with no open project and explicit close resets it',async()=>{
    const h=setup();const dispose=h.route.mount();await h.route.ready
    h.route.startup();expect(h.startup).toHaveBeenCalledOnce()
    h.route.editor();h.route.startup();expect(h.startup).toHaveBeenCalledOnce()
    h.route.close();expect(h.route.selected).toBe(false);expect(h.startup).toHaveBeenCalledTimes(2);dispose()
  })
  it('supports StrictMode unmount/remount during listener attachment',async()=>{
    const h=setup(vi.fn(async()=>({dir:'/open'})))
    const first=h.route.mount();first();const second=h.route.mount();await h.route.ready
    expect(h.editor).toHaveBeenCalledOnce();expect(h.off).toHaveBeenCalledOnce();second()
  })
})
