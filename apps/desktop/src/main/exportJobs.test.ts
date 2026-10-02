import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ExportJobs } from './exportJobs'
import type { TsActorHost } from './state/ts-actor-host'
import { exportBlocksChannel } from './state/router'
vi.mock('./state/snap', () => ({snapFrameRound:(t:number)=>t}))
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir,{recursive:true,force:true}) })
async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'weftcut-export-test-')); dirs.push(dir)
  const send = vi.fn(), native = vi.fn(async (_channel:string,_args:Record<string,unknown>) => null)
  const host = {openedProject:()=>({dir}),handleInvoke:async()=>null,actor:{snapshot:()=>({root_id:'root',compositions:{root:{width:1920,height:1080,fps:{num:30,den:1},duration_us:1_000_000}}})}} as unknown as TsActorHost
  const cleanupNativeSessions=vi.fn(async()=>{})
  const jobs = new ExportJobs({host:()=>host,send,native,cleanupNativeSessions}); jobs.rendererReady()
  return {dir,jobs,send,native,host,cleanupNativeSessions}
}
describe('export job admission and publication', () => {
  it('inspects defaults for an empty project but refuses to export it', async () => {
    const {dir,jobs,host}=await setup()
    const p=host.actor.snapshot(); p.compositions[p.root_id].duration_us=0
    vi.spyOn(host.actor,'snapshot').mockReturnValue(p)
    expect(await jobs.options()).toMatchObject({duration_us:0,extension:'mp4',dimensions:{width:1920,height:1080}})
    await expect(jobs.start({output_path:path.join(dir,'empty-project.mp4')})).rejects.toThrow()
    expect(jobs.isActive()).toBe(false)
  })
  it('stages an agent output, publishes only a nonempty result, and releases the edit gate', async () => {
    const {dir,jobs,send} = await setup(); const dest = path.join(dir,'video.mp4')
    const job = await jobs.start({output_path:dest})
    expect(job.state).toBe('preparing'); expect(()=>jobs.assertWritable()).toThrow('ExportInProgress')
    const stage = send.mock.calls.find(c=>c[0]==='export:run')![1].output_path
    expect(stage).not.toBe(dest); expect(path.extname(stage)).toBe('.mp4')
    await expect(fs.stat(dest)).rejects.toMatchObject({code:'ENOENT'})
    await fs.writeFile(stage,'video bytes')
    const result = await jobs.update({job_id:job.job_id,state:'completed',duration_us:1_000_000})
    expect(result).toMatchObject({state:'completed',output_path:dest,duration_us:1_000_000})
    expect(await fs.readFile(dest,'utf8')).toBe('video bytes'); expect(jobs.isActive()).toBe(false)
    await expect(fs.stat(stage)).rejects.toMatchObject({code:'ENOENT'})
    expect(jobs.status(job.job_id)).toEqual(result)
  })
  it('revalidates against the current composition after acquiring the admission gate', async()=>{
    const {dir,jobs,host,send}=await setup()
    const original=host.actor.snapshot(), updated=structuredClone(original)
    updated.compositions[updated.root_id].duration_us=2_000_000
    vi.spyOn(host.actor,'snapshot').mockImplementationOnce(()=>original).mockImplementation(()=>{
      expect(jobs.isActive()).toBe(true)
      return updated
    })
    const j=await jobs.start({output_path:path.join(dir,'current.mp4')})
    expect(j.range.endUs).toBe(2_000_000)
    expect(send.mock.calls.find(c=>c[0]==='export:run')![1].range.endUs).toBe(2_000_000)
    await jobs.update({job_id:j.job_id,state:'failed',error:'test cleanup'})
  })
  it('refuses duplicate admission and invalid/missing destinations', async () => {
    const {dir,jobs} = await setup()
    await expect(jobs.start({output_path:'relative.mp4'})).rejects.toThrow('absolute')
    await expect(jobs.start({output_path:path.join(dir,'wrong.mov')})).rejects.toThrow('extension')
    await fs.writeFile(path.join(dir,'exists.mp4'),'original')
    await expect(jobs.start({output_path:path.join(dir,'exists.mp4')})).rejects.toThrow('already exists')
    const j = await jobs.start({output_path:path.join(dir,'a.mp4')})
    await expect(jobs.start({output_path:path.join(dir,'b.mp4')})).rejects.toThrow('ExportInProgress')
    await jobs.update({job_id:j.job_id,state:'failed',error:'test cleanup'})
  })
  it('cannot overwrite a destination created while rendering', async () => {
    const {dir,jobs,send}=await setup(); const dest=path.join(dir,'race.mp4')
    const j=await jobs.start({output_path:dest}); const stage=send.mock.calls.find(c=>c[0]==='export:run')![1].output_path
    await fs.writeFile(stage,'export'); await fs.writeFile(dest,'other writer')
    expect((await jobs.update({job_id:j.job_id,state:'completed'})).state).toBe('failed')
    expect(await fs.readFile(dest,'utf8')).toBe('other writer'); expect(jobs.isActive()).toBe(false)
  })
  it('rejects empty output and cleans failed partials', async () => {
    const {dir,jobs,send}=await setup(); const j=await jobs.start({output_path:path.join(dir,'empty.mp4')})
    const stage=send.mock.calls.find(c=>c[0]==='export:run')![1].output_path; await fs.writeFile(stage,'')
    expect((await jobs.update({job_id:j.job_id,state:'completed'}))).toMatchObject({state:'failed',error:'Export produced no output'})
    await expect(fs.stat(stage)).rejects.toMatchObject({code:'ENOENT'})
  })
  it('preserves an existing UI destination on failure and replaces it only after success', async () => {
    const {dir,jobs,send}=await setup(); const dest=path.join(dir,'ui.mp4'); await fs.writeFile(dest,'previous')
    const failed=await jobs.start({output_path:dest,agent:false})
    await jobs.update({job_id:failed.job_id,state:'failed',error:'preparation failed'})
    expect(await fs.readFile(dest,'utf8')).toBe('previous')
    const success=await jobs.start({output_path:dest,agent:false})
    const stage=send.mock.calls.filter(c=>c[0]==='export:run').at(-1)![1].output_path
    await fs.writeFile(stage,'replacement')
    expect((await jobs.update({job_id:success.job_id,state:'completed'})).state).toBe('completed')
    expect(await fs.readFile(dest,'utf8')).toBe('replacement')
  })
  it('cancellation waits for cleanup acknowledgement, is idempotent, and beats late completion', async () => {
    const {dir,jobs,native,send}=await setup(); const j=await jobs.start({output_path:path.join(dir,'cancel.mp4')})
    await jobs.cancel(j.job_id); await jobs.cancel(j.job_id)
    expect(jobs.isActive()).toBe(true)
    expect(native.mock.calls.filter(c=>c[0]==='export_cancel')).toHaveLength(1)
    expect(send.mock.calls.filter(c=>c[0]==='export:cancel')).toHaveLength(1)
    expect((await jobs.update({job_id:j.job_id,state:'completed'})).state).toBe('cancelled')
    expect(jobs.isActive()).toBe(false); expect((await jobs.cancel(j.job_id)).state).toBe('cancelled')
  })
  it('renderer disappearance fails the job and requires readiness on reconnect', async () => {
    const {dir,jobs}=await setup(); const j=await jobs.start({output_path:path.join(dir,'gone.mp4')})
    await jobs.rendererGone(); expect(jobs.status(j.job_id)).toMatchObject({state:'failed',error:'Export renderer disconnected'})
    await expect(jobs.start({output_path:path.join(dir,'retry.mp4')})).rejects.toThrow('ExportRendererUnavailable')
    expect(jobs.isActive()).toBe(false)
  })
  it('controller disposal retains admission until renderer worker cleanup is acknowledged',async()=>{
    const {dir,jobs}=await setup(); const j=await jobs.start({output_path:path.join(dir,'dispose.mp4')})
    await jobs.rendererDetaching()
    expect(jobs.isActive()).toBe(true)
    jobs.rendererReady() // a new React controller can mount while the old one cleans up
    await expect(jobs.start({output_path:path.join(dir,'new.mp4')})).rejects.toThrow('ExportInProgress')
    expect((await jobs.update({job_id:j.job_id,state:'cancelled'})).state).toBe('cancelled')
    expect(jobs.isActive()).toBe(false)
  })
  it('joins orphan native decode sessions before releasing a crashed renderer job',async()=>{
    const {dir,jobs,cleanupNativeSessions}=await setup(); const j=await jobs.start({output_path:path.join(dir,'decode.mp4')})
    let joined!:()=>void, entered!:()=>void; const entry=new Promise<void>(resolve=>{entered=resolve})
    cleanupNativeSessions.mockImplementationOnce(()=>new Promise<void>(resolve=>{joined=resolve;entered()}))
    const gone=jobs.rendererGone(); await entry
    expect(jobs.isActive()).toBe(true); joined(); await gone
    expect(jobs.status(j.job_id).state).toBe('failed'); expect(jobs.isActive()).toBe(false)
  })
  it('holds the gate until native cancellation finishes on renderer failure', async () => {
    const {dir,jobs,native}=await setup(); const j=await jobs.start({output_path:path.join(dir,'wait.mp4')})
    let release!:()=>void, entered!:()=>void; const entry=new Promise<void>(resolve=>{entered=resolve})
    native.mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve(null);entered()}))
    const gone=jobs.rendererGone(); await entry; expect(jobs.isActive()).toBe(true); release(); await gone
    expect(jobs.status(j.job_id).state).toBe('failed'); expect(jobs.isActive()).toBe(false)
  })
  it('cancels before renderer dispatch without awaiting an impossible renderer acknowledgement', async () => {
    const {dir,jobs,native,send}=await setup()
    let begin!:()=>void, entered!:()=>void
    const entry = new Promise<void>(resolve=>{entered=resolve})
    native.mockImplementationOnce(()=>new Promise(resolve=>{begin=()=>resolve(null); entered()}))
    const start=jobs.start({output_path:path.join(dir,'early.mp4')}); await entry
    const id=send.mock.calls.find(c=>c[0]==='export:status')![1].job_id
    const cancellation=jobs.cancel(id)
    expect(native.mock.calls.filter(c=>c[0]==='export_cancel')).toHaveLength(0)
    begin(); await cancellation
    expect((await start).state).toBe('cancelled'); expect(jobs.isActive()).toBe(false)
    expect(send.mock.calls.filter(c=>c[0]==='export:run')).toHaveLength(0)
    expect(native.mock.calls.filter(c=>c[0]==='export_cancel')).toHaveLength(1)
  })
  it('retains the gate when native cleanup fails and permits cancellation retry',async()=>{
    const {dir,jobs,native}=await setup(); const j=await jobs.start({output_path:path.join(dir,'cleanup.mp4')})
    native.mockRejectedValueOnce(new Error('native failure'))
    expect(await jobs.cancel(j.job_id)).toMatchObject({phase:'cleanup_failed'})
    expect(jobs.isActive()).toBe(true)
    await jobs.cancel(j.job_id)
    expect((await jobs.update({job_id:j.job_id,state:'cancelled'})).state).toBe('cancelled')
    expect(jobs.isActive()).toBe(false)
  })
})
describe('export mutation channel gate',()=>{
  it('blocks edits, project lifecycle and motif edits while allowing reads and render primitives',()=>{
    for(const c of ['add_color_layer','project_open','project_new_workspace','project_save_as','project_close','import_media','install_motif','export_settings_set']) expect(exportBlocksChannel(c),c).toBe(true)
    for(const c of ['project_summary','get_project_settings','export_settings_get','get_media_thumbnail','list_motifs','ensure_export_audio_fx','export_project_audio_only','mux_export','export_job_update']) expect(exportBlocksChannel(c),c).toBe(false)
  })
})
