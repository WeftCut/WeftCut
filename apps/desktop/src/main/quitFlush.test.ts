import {describe,it,expect,vi} from 'vitest'
import {createQuitFlush} from './quitFlush'
describe('explicit application quit flush',()=>{
  it('terminates the renderer before cleanup and refuses reentrant quit until autosave settles',async()=>{
    const order:string[]=[]
    let done!:()=>void
    const pending=new Promise<void>(resolve=>{done=resolve})
    const event={preventDefault:vi.fn()}
    const quit=vi.fn(()=>handler(event))
    const handler=createQuitFlush({destroyRenderer:()=>{order.push('destroy');handler(event)},flush:async()=>{order.push('native cleanup');await pending;order.push('actor flush')},quit,onError:vi.fn()})
    handler(event)
    expect(order).toEqual(['destroy','native cleanup'])
    expect(event.preventDefault).toHaveBeenCalledTimes(2)
    expect(quit).not.toHaveBeenCalled()
    done();await vi.waitFor(()=>expect(quit).toHaveBeenCalledTimes(1))
    expect(order).toEqual(['destroy','native cleanup','actor flush'])
    expect(event.preventDefault).toHaveBeenCalledTimes(2) // final app.quit is allowed
  })
  it('reports flush failures and still completes explicit quit',async()=>{
    const quit=vi.fn(),onError=vi.fn(),error=new Error('disk failure')
    const handler=createQuitFlush({destroyRenderer:vi.fn(),flush:async()=>{throw error},quit,onError})
    handler({preventDefault:vi.fn()});await vi.waitFor(()=>expect(quit).toHaveBeenCalledOnce())
    expect(onError).toHaveBeenCalledWith(error)
  })
})
