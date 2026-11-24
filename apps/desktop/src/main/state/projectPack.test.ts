import { describe, expect, it } from 'vitest'
import { createProjectPacker, type ProjectPackDeps } from './projectPack'
import { PACK_TOP_LEVEL } from './projectContent'
import { SCHEMA_VERSION } from './model'
import { parseProjectPath } from '../../shared/projectPath'
import { parsePackRefusal, type PackJobProgress } from '../../shared/projectPack'
import { isWorkspaceFailure } from '../../shared/workspaceErrors'

interface Deferred { resolve(value: string): void; reject(error: Error): void }

/** A packer over a fake backend that records every step it is asked for, in
 *  order. Each native run stays pending until the test settles it. */
function rig(opts: { schema?: number; packSchema?: number; targetNames?: string[] | null; free?: number; totalBytes?: number; lateRegistration?: boolean } = {}) {
  const log: string[] = []
  const calls: { cmd: string; args: Record<string, unknown> }[] = []
  const runs: Deferred[] = []
  const progress: (PackJobProgress | null)[] = []
  const live = new Set<string>()
  const projectJson = (schema: number) => JSON.stringify({ schema_version: schema, metadata: { name: 'Example Project' } })
  const deps: ProjectPackDeps = {
    native: {
      invoke: (cmd, argsJson) => {
        const args = JSON.parse(argsJson) as Record<string, unknown>
        calls.push({ cmd, args })
        log.push(cmd)
        if (cmd === 'project_pack_inspect') {
          return Promise.resolve(JSON.stringify({
            manifest: { files: [{}, {}, {}] }, project_json: projectJson(opts.packSchema ?? SCHEMA_VERSION), total_bytes: opts.totalBytes ?? 300,
          }))
        }
        if (!opts.lateRegistration) live.add(args.jobId as string)
        return new Promise<string>((resolve, reject) => runs.push({
          resolve: (v) => { live.delete(args.jobId as string); resolve(v) },
          reject: (e) => { live.delete(args.jobId as string); reject(e) },
        }))
      },
      cancelComputeJob: (jobId) => {
        log.push(`cancel ${jobId}`)
        if (!live.has(jobId)) return false
        live.delete(jobId)
        runs.shift()?.reject(new Error('cancelled'))
        return true
      },
    },
    current: () => ({ dir: '/home/u/Example', name: 'Example: Project', motifIds: ['title-card'] }),
    settle: async () => { log.push('settle'); return { dir: '/home/u/Example', name: 'Example Project', motifIds: ['title-card'] } },
    list: async (dir, ids) => {
      log.push(`list ${dir} ${ids.join(',')}`)
      return [{ path: parseProjectPath('project.json'), size: 10 }, { path: parseProjectPath('Media/clip.mp4'), size: 90 }]
    },
    readFile: () => projectJson(opts.schema ?? SCHEMA_VERSION - 1),
    freeBytes: async () => opts.free ?? Number.MAX_SAFE_INTEGER,
    readdir: async () => opts.targetNames === undefined ? null : opts.targetNames,
    ensureGitignore: (dir) => { log.push(`gitignore ${dir}`) },
    open: async (dir) => { log.push(`open ${dir}`) },
    progress: (p) => { progress.push(p) },
    appVersion: '1.2.3',
    join: (...parts) => parts.join('/'),
    basename: (p) => p.slice(p.lastIndexOf('/') + 1),
    newJobId: (() => { let n = 0; return () => `job-${++n}` })(),
  }
  const packer = createProjectPacker(deps)
  /** Resolves once the packer has reached its native run: every step before
   *  it is a resolved promise, so microtasks reach it. */
  const atNative = async () => {
    for (let turn = 0; runs.length === 0; turn++) {
      if (turn > 1000) throw new Error('the packer never reached its native run')
      await Promise.resolve()
    }
  }
  /** The registry sees the job `jobId`, as it does a moment after the call. */
  const register = (jobId: string) => { live.add(jobId) }
  return { deps, packer, log, calls, runs, progress, atNative, register }
}

const refusal = async (p: Promise<unknown>) => {
  try { await p } catch (error) { return parsePackRefusal(error) ?? (isWorkspaceFailure(error) ? error.err : error) }
  throw new Error('expected a refusal')
}

describe('pack', () => {
  it('flushes what Save As flushes before it lists the files, and packs exactly that list', async () => {
    const { packer, log, calls, runs, atNative } = rig()
    const done = packer.pack('/home/u/out/Example.weftcut')
    await atNative()
    expect(log).toEqual(['settle', 'list /home/u/Example title-card', 'project_pack'])
    expect(calls[0]!.args).toEqual({
      jobId: 'job-1', folder: '/home/u/Example', archive: '/home/u/out/Example.weftcut',
      files: ['project.json', 'Media/clip.mp4'], appVersion: '1.2.3', schemaVersion: SCHEMA_VERSION - 1,
    })
    runs[0]!.resolve(JSON.stringify({ files: 2 }))
    await expect(done).resolves.toEqual({ outcome: 'done', archive: '/home/u/out/Example.weftcut', files: 2 })
  })

  it('gives a chosen name without the pack extension the extension', async () => {
    const { packer, calls, runs, atNative } = rig()
    const done = packer.pack('/home/u/out/Example')
    await atNative()
    expect(calls[0]!.args.archive).toBe('/home/u/out/Example.weftcut')
    runs[0]!.resolve(JSON.stringify({ files: 2 }))
    await expect(done).resolves.toMatchObject({ archive: '/home/u/out/Example.weftcut' })
  })

  it('records the schema version project.json declares on disk, which the unpacking app opens', async () => {
    const { packer, calls, runs, atNative } = rig({ schema: 4 })
    const done = packer.pack('/home/u/out/Example.weftcut')
    await atNative()
    expect(calls[0]!.args.schemaVersion).toBe(4)
    runs[0]!.resolve(JSON.stringify({ files: 2 }))
    await done
  })

  it('cancels through the job registry, answers cancelled, and clears the pill', async () => {
    const { packer, log, progress, atNative } = rig()
    const done = packer.pack('/home/u/out/Example.weftcut')
    await atNative()
    expect(packer.cancel()).toBe(true)
    await expect(done).resolves.toEqual({ outcome: 'cancelled' })
    expect(log).toContain('cancel job-1')
    expect(progress.at(-1)).toBeNull()
  })

  it('cancelled before its native run starts, never starts it', async () => {
    const rigged = rig()
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    const settle = async () => { await held; return { dir: '/home/u/Example', name: 'Example', motifIds: [] } }
    const packer = createProjectPacker({ ...rigged.deps, settle })
    const done = packer.pack('/home/u/out/Example.weftcut')
    expect(packer.cancel()).toBe(true)
    release()
    await expect(done).resolves.toEqual({ outcome: 'cancelled' })
    expect(rigged.calls.map(c => c.cmd)).not.toContain('project_pack')
  })

  it('sends a cancel the registry did not take again with the next progress', async () => {
    const { packer, log, atNative, register } = rig({ lateRegistration: true })
    const done = packer.pack('/home/u/out/Example.weftcut')
    await atNative()
    packer.cancel()
    expect(log.filter(l => l.startsWith('cancel'))).toEqual(['cancel job-1'])
    register('job-1')
    packer.nativeProgress({ jobId: 'job-1', done: 10, total: 100 })
    await expect(done).resolves.toEqual({ outcome: 'cancelled' })
    expect(log.filter(l => l.startsWith('cancel'))).toEqual(['cancel job-1', 'cancel job-1'])
  })

  it('runs one pack or unpack at a time', async () => {
    const { packer, runs, atNative } = rig()
    const first = packer.pack('/home/u/out/Example.weftcut')
    await atNative()
    expect(await refusal(packer.pack('/home/u/out/Other.weftcut'))).toEqual({ refusal: 'PackBusy' })
    expect(await refusal(packer.unpack('/home/u/in/Other.weftcut', '/home/u/Projects'))).toEqual({ refusal: 'PackBusy' })
    runs[0]!.resolve(JSON.stringify({ files: 2 }))
    await first
  })

  it('shows the bytes of its own run, under the pack file\'s name', async () => {
    const { packer, progress, runs, atNative } = rig()
    const done = packer.pack('/home/u/out/Example.weftcut')
    await atNative()
    packer.nativeProgress({ jobId: 'another-job', done: 1, total: 2 })
    packer.nativeProgress({ jobId: 'job-1', done: 40, total: 100 })
    expect(progress.at(-1)).toEqual({ job_id: 'job-1', kind: 'pack', file: 'Example.weftcut', done: 40, total: 100, cancelling: false })
    expect(progress.filter(p => p !== null && p.job_id !== 'job-1')).toEqual([])
    runs[0]!.resolve(JSON.stringify({ files: 2 }))
    await done
    expect(progress.at(-1)).toBeNull()
  })

  it('plans the same files it packs, named for the project', async () => {
    const { packer } = rig()
    // `current` names the project "Example: Project": a colon no OS file name takes everywhere.
    await expect(packer.plan()).resolves.toEqual({ files: 2, bytes: 100, file_name: 'Example_ Project.weftcut' })
  })
})

describe('unpack', () => {
  const archive = '/home/u/in/Example Project.weftcut'

  it('unpacks into a new folder named for the pack, writes its .gitignore, then opens it', async () => {
    const { packer, log, calls, runs, atNative } = rig()
    const done = packer.unpack(archive, '/home/u/Projects')
    await atNative()
    expect(calls.at(-1)).toEqual({ cmd: 'project_unpack', args: {
      jobId: 'job-1', folder: '/home/u/Projects/Example Project', archive, allowedTop: [...PACK_TOP_LEVEL],
    } })
    runs[0]!.resolve(JSON.stringify({ files: 3 }))
    await expect(done).resolves.toEqual({ outcome: 'done', dir: '/home/u/Projects/Example Project' })
    expect(log.slice(-3)).toEqual(['project_unpack', 'gitignore /home/u/Projects/Example Project', 'open /home/u/Projects/Example Project'])
  })

  it('refuses a pack of a newer schema before writing anything', async () => {
    const { packer, log } = rig({ packSchema: SCHEMA_VERSION + 1 })
    expect(await refusal(packer.unpack(archive, '/home/u/Projects')))
      .toEqual({ error: 'ProjectSchemaTooNew', found: SCHEMA_VERSION + 1, supported: SCHEMA_VERSION })
    expect(log).toEqual(['project_pack_inspect'])
  })

  it('refuses a folder of that name that is not empty', async () => {
    const { packer, log } = rig({ targetNames: ['notes.txt'] })
    expect(await refusal(packer.unpack(archive, '/home/u/Projects'))).toEqual({ refusal: 'FolderNotEmpty', folder: 'Example Project' })
    expect(log).toEqual(['project_pack_inspect'])
  })

  it('takes an empty folder of that name', async () => {
    const { packer, runs, atNative } = rig({ targetNames: [] })
    const done = packer.unpack(archive, '/home/u/Projects')
    await atNative()
    runs[0]!.resolve(JSON.stringify({ files: 3 }))
    await expect(done).resolves.toMatchObject({ outcome: 'done' })
  })

  it('refuses a parent without room for the pack', async () => {
    const { packer, log } = rig({ free: 299, totalBytes: 300 })
    expect(await refusal(packer.unpack(archive, '/home/u/Projects'))).toEqual({ refusal: 'NotEnoughSpace', needed: 300, available: 299 })
    expect(log).toEqual(['project_pack_inspect'])
  })

  it('opens nothing when cancelled', async () => {
    const { packer, log, atNative } = rig()
    const done = packer.unpack(archive, '/home/u/Projects')
    await atNative()
    packer.cancel()
    await expect(done).resolves.toEqual({ outcome: 'cancelled' })
    expect(log.some(l => l.startsWith('open') || l.startsWith('gitignore'))).toBe(false)
  })

  it('names the project and the folder it would create before anything is written', async () => {
    const { packer, log } = rig()
    await expect(packer.inspect(archive)).resolves.toEqual({ name: 'Example Project', folder_name: 'Example Project', files: 3, bytes: 300 })
    expect(log).toEqual(['project_pack_inspect'])
  })
})
