import { describe, it, expect, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildMcpServer, handleCallTool } from './server'
import type { ExportJobs } from '../exportJobs'
import type { TsActorHost } from '../state/ts-actor-host'
vi.mock('../motif/capture.js', () => ({captureMotifFrameB64:async()=>''}))
function fixture(open=true) {
  const backend={mcpCatalog:async()=>JSON.stringify({tools:[],resources:[]}),mcpCallTool:vi.fn(async()=>{throw new Error('native MCP path must not run')})} as any
  const host={openedProject:()=>open ? {dir:'project'}:null} as unknown as TsActorHost
  const service={options:vi.fn(async()=>({settings:{},duration_us:0})),start:vi.fn(async()=>({job_id:'test',state:'preparing'})),status:vi.fn(()=>({job_id:'test',state:'completed'})),cancel:vi.fn(async()=>({job_id:'test',state:'cancelled'})),isActive:()=>false,assertWritable:vi.fn()} as unknown as ExportJobs
  const call=(name:string,args:Record<string,unknown>={})=>handleCallTool(backend,()=>host,name,args,undefined,undefined,undefined,undefined,service)
  return {backend,host,service,call}
}
describe('MCP export integration',()=>{
  it('advertises all four host tools and annotations over a real MCP connection',async()=>{
    const {backend,host,service}=fixture()
    const server=buildMcpServer(backend,{getTsHost:()=>host,exportJobs:service})
    const client=new Client({name:'export-test',version:'1'})
    const [a,b]=InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(a),client.connect(b)])
    try {
      const {tools}=await client.listTools()
      expect(tools.filter(t=>['get_export_options','start_export','get_export_status','cancel_export'].includes(t.name))).toHaveLength(4)
      const result=await client.callTool({name:'start_export',arguments:{output_path:'C:\\output.mp4'}})
      expect(result.isError).not.toBe(true); expect(service.start).toHaveBeenCalledWith({output_path:'C:\\output.mp4',agent:true})
    } finally {await client.close(); await server.close()}
  })
  it('refuses no-project starts while retaining session job lookup and cancellation',async()=>{
    const {call,service}=fixture(false)
    expect((await call('start_export',{output_path:'C:\\output.mp4'}) as any).isError).toBe(true)
    expect(service.start).not.toHaveBeenCalled()
    expect((await call('get_export_status',{job_id:'test'}) as any).isError).not.toBe(true)
    expect((await call('cancel_export',{job_id:'test'}) as any).isError).not.toBe(true)
  })
  it('validates arguments and returns structured tool failures',async()=>{
    const {call,service}=fixture()
    for(const args of [{},{output_path:42},{output_path:'C:\\output.mp4',agent:false}]) expect((await call('start_export',args) as any).isError).toBe(true)
    expect(service.start).not.toHaveBeenCalled()
    vi.mocked(service.start).mockRejectedValueOnce(new Error('bad settings'))
    const result=await call('start_export',{output_path:'C:\\output.mp4'}) as any
    expect(result.isError).toBe(true); expect(result.content[0].text).toContain('bad settings')
  })
  it('blocks project operations during export and allows reads',async()=>{
    const {backend,host,service}=fixture()
    vi.spyOn(service,'isActive').mockReturnValue(true)
    vi.mocked(service.assertWritable).mockImplementation(()=>{throw new Error('ExportInProgress')})
    const result=await handleCallTool(backend,()=>host,'add_track',{},undefined,undefined,undefined,undefined,service) as any
    expect(result.isError).toBe(true); expect(result.content[0].text).toContain('ExportInProgress')
    expect(backend.mcpCallTool).not.toHaveBeenCalled()
  })
})
