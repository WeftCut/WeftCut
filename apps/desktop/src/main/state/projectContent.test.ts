import { describe, expect, it } from 'vitest'
import { DEFAULT_GITIGNORE, PACK_TOP_LEVEL, PROJECT_CONTENT, PROJECT_MACHINE_LOCAL, copyLateFiles, copyProjectContent, ensureGitignore, packFiles, placeFilePlans, type ProjectContentFs } from './projectContent'
import { parseProjectPath } from '../../shared/projectPath'
import { errno } from './__tests__/fixtures/memAtomicIo'
import { memDisk } from './__tests__/fixtures/memDisk'

/** A project folder holding content and machine-local files alike. */
function projectAt(dir: string) {
  const disk = memDisk()
  const content = {
    [`${dir}/Media/clip.mp4`]: 'clip', [`${dir}/Media/sub/x.wav`]: 'x', [`${dir}/Media/sub/deeper/y.png`]: 'y',
    [`${dir}/TASTE.md`]: 'taste', [`${dir}/export.json`]: '{}', [`${dir}/view.json`]: '{}',
    [`${dir}/Fonts/Example-Bold.ttf`]: 'font', [`${dir}/Styles/mine/STYLE.md`]: 'style',
    [`${dir}/.gitignore`]: '/my-notes/\n',
  }
  const local = {
    [`${dir}/project.json`]: '{}', [`${dir}/project.pre-v6.json`]: '{}',
    [`${dir}/Cache/proxies/h.mp4`]: 'p', [`${dir}/Backups/project-1.json`]: '{}', [`${dir}/Logs/log.jsonl`]: '',
    [`${dir}/output/render.mp4`]: 'r',
  }
  let mtime = 1_700_000_000
  for (const [p, data] of Object.entries({ ...content, ...local })) disk.put(p, data, mtime++)
  disk.fs.mkdirp('/to')
  return { disk, content: Object.keys(content), local: Object.keys(local) }
}
const moved = (p: string) => p.replace(/^\/from\//, '/to/')

describe('copyProjectContent', () => {
  it('copies the content list into the new folder and nothing that is this machine\'s', async () => {
    const { disk, content, local } = projectAt('/from')
    await copyProjectContent('/from', '/to', disk.contentFs, 'linux')
    const copied = disk.files().filter(p => p.startsWith('/to/'))
    expect(copied.sort()).toEqual(content.map(moved).sort())
    for (const p of local) expect(copied).not.toContain(moved(p))
    for (const p of content) expect(disk.read(moved(p))).toBe(disk.read(p))
  })

  it('keeps each copied file\'s modification time', async () => {
    const { disk, content } = projectAt('/from')
    disk.refuse.clone = 'ENOTSUP'
    disk.refuse.link = 'EXDEV'
    await copyProjectContent('/from', '/to', disk.contentFs, 'linux')
    for (const p of content) expect(disk.mtimeMs(moved(p))).toBe(disk.mtimeMs(p))
  })

  it('links a file when the volume makes no clone', async () => {
    const { disk } = projectAt('/from')
    disk.refuse.clone = 'ENOTSUP'
    await copyProjectContent('/from', '/to', disk.contentFs, 'linux')
    expect(disk.linked('/from/Media/sub/x.wav', '/to/Media/sub/x.wav')).toBe(true)
    expect(disk.log.slice(0, 2)).toEqual(['clone', 'link'])
  })

  it('copies the bytes when the link is refused across volumes', async () => {
    const { disk } = projectAt('/from')
    disk.refuse.clone = 'EXDEV'
    disk.refuse.link = 'EXDEV'
    await copyProjectContent('/from', '/to', disk.contentFs, 'linux')
    expect(disk.linked('/from/Media/sub/x.wav', '/to/Media/sub/x.wav')).toBe(false)
    expect(disk.read('/to/Media/sub/x.wav')).toBe('x')
    expect(disk.log.slice(0, 3)).toEqual(['clone', 'link', 'copy'])
  })

  it('never writes into a file already at the target, which may be linked to another folder', async () => {
    const { disk } = projectAt('/from')
    disk.put('/elsewhere/clip.mp4', 'theirs')
    await disk.contentFs.mkdir('/to/Media', { recursive: true })
    await disk.contentFs.link('/elsewhere/clip.mp4', '/to/Media/clip.mp4')
    await copyProjectContent('/from', '/to', disk.contentFs, 'linux')
    expect(disk.read('/to/Media/clip.mp4')).toBe('clip')
    expect(disk.read('/elsewhere/clip.mp4')).toBe('theirs')
  })

  it('skips symbolic links', async () => {
    const { disk } = projectAt('/from')
    disk.entries.set('/from/Media/link.mp4', { kind: 'symlink', target: '/from/Media/clip.mp4' })
    await copyProjectContent('/from', '/to', disk.contentFs, 'linux')
    expect(disk.entries.has('/to/Media/link.mp4')).toBe(false)
  })

  it('copies nothing when both name one folder', async () => {
    const { disk } = projectAt('/from')
    await copyProjectContent('/from', '/from/', disk.contentFs, 'linux')
    expect(disk.log).toEqual([])
  })

  it.each(['Media/sub', 'Fonts', 'Styles/mine', 'Motifs/intro'])('refuses a target inside the source\'s %s folder, which it would copy into itself', async (inside) => {
    const { disk } = projectAt('/from')
    const target = `/from/${inside}/Copy`
    await disk.contentFs.mkdir(target, { recursive: true })
    await expect(copyProjectContent('/from', target, disk.contentFs, 'linux')).rejects.toThrow(`${inside.split('/')[0]} folder`)
    expect(disk.log).toEqual([])
  })

  it('fails on a file that cannot be copied', async () => {
    const { disk } = projectAt('/from')
    disk.refuse.clone = 'ENOTSUP'
    disk.refuse.link = 'EXDEV'
    disk.refuse.copy = (src) => (src === '/from/Media/sub/x.wav' ? 'EIO' : null)
    await expect(copyProjectContent('/from', '/to', disk.contentFs, 'linux')).rejects.toMatchObject({ code: 'EIO' })
    expect(disk.files().filter(p => p.startsWith('/to/Media/sub/'))).toEqual([])
  })
})

describe('copyProjectContent on volumes that refuse', () => {
  /** NTFS: renaming a name of a file needs delete access against every open
   *  handle of that file, across its links, and a decoder holds media open
   *  without sharing delete. A name with another name linked to it is such a
   *  file here. */
  function windowsWhileDecoding(disk: ReturnType<typeof memDisk>): ProjectContentFs {
    return {
      ...disk.contentFs,
      rename: async (a, b) => {
        if (disk.files().some(f => f !== a && disk.linked(a, f))) throw errno('EPERM')
        return disk.contentFs.rename(a, b)
      },
    }
  }

  it('links media where the volume makes no clone, even while the source is held open', async () => {
    const { disk } = projectAt('/from')
    disk.refuse.clone = 'ENOSYS'
    await copyProjectContent('/from', '/to', windowsWhileDecoding(disk), 'linux')
    expect(disk.linked('/from/Media/clip.mp4', '/to/Media/clip.mp4')).toBe(true)
    expect(disk.files().filter(f => f.endsWith('.tmp'))).toEqual([])
  })

  it('never links the files people edit, so editing the copy leaves the source alone', async () => {
    const { disk } = projectAt('/from')
    disk.refuse.clone = 'ENOSYS'
    await copyProjectContent('/from', '/to', disk.contentFs, 'linux')
    for (const name of ['TASTE.md', 'export.json', 'view.json', 'Fonts/Example-Bold.ttf', 'Styles/mine/STYLE.md']) {
      expect(disk.linked(`/from/${name}`, `/to/${name}`), name).toBe(false)
      expect(disk.read(`/to/${name}`), name).toBe(disk.read(`/from/${name}`))
    }
  })

  it('copies the bytes whatever error the link fails with', async () => {
    const { disk } = projectAt('/from')
    disk.refuse.clone = 'ENOSYS'
    disk.refuse.link = 'EISDIR' // exFAT through libuv on Windows
    await copyProjectContent('/from', '/to', disk.contentFs, 'linux')
    expect(disk.read('/to/Media/sub/x.wav')).toBe('x')
    expect(disk.linked('/from/Media/sub/x.wav', '/to/Media/sub/x.wav')).toBe(false)
  })

  it('leaves hidden and temporary files behind', async () => {
    const { disk } = projectAt('/from')
    disk.put('/from/Media/.DS_Store', 'finder')
    disk.put('/from/Media/new.mp4.tmp', 'half an import')
    disk.put('/from/Fonts/.Example-Bold.ttf.0f1e.part', 'half a font copy')
    await copyProjectContent('/from', '/to', disk.contentFs, 'linux')
    expect(disk.read('/to/Media/.DS_Store')).toBeUndefined()
    expect(disk.read('/to/Media/new.mp4.tmp')).toBeUndefined()
    expect(disk.read('/to/Fonts/.Example-Bold.ttf.0f1e.part')).toBeUndefined()
  })
})

describe('packFiles', () => {
  /** The project of `projectAt`, with Motif folders its table names and one
   *  it does not, Motif backups, and files no copy carries. */
  function packable() {
    const project = projectAt('/from')
    const { disk } = project
    disk.put('/from/Motifs/title-card/index.html', 'html')
    disk.put('/from/Motifs/title-card/.motif-notes', 'kept whole')
    disk.put('/from/Motifs/title-card/assets/logo.png', 'png')
    disk.put('/from/Motifs/lower-third/index.html', 'html')
    disk.put('/from/Motifs/left-behind/index.html', 'untracked')
    disk.put('/from/Backups/motifs/title-card/1/index.html', 'backup')
    disk.put('/from/Media/.DS_Store', 'finder')
    disk.put('/from/Media/new.mp4.tmp', 'half an import')
    disk.entries.set('/from/Media/link.mp4', { kind: 'symlink', target: '/from/Media/clip.mp4' })
    return project
  }
  const listed = async (disk: ReturnType<typeof memDisk>, ids = ['title-card', 'lower-third']) =>
    (await packFiles('/from', ids, disk.contentFs, 'linux')).map(e => e.path as string)

  it('holds exactly what Save As copies into a new folder, beside project.json and the table\'s Motifs', async () => {
    const { disk } = packable()
    await copyProjectContent('/from', '/to', disk.contentFs, 'linux')
    const savedAs = disk.files().filter(p => p.startsWith('/to/')).map(p => p.slice('/to/'.length))
    const pack = await listed(disk)
    expect(pack.filter(p => p !== 'project.json' && !p.startsWith('Motifs/')).sort()).toEqual(savedAs.sort())
  })

  it('puts project.json first, then the Motif folders the table names, whole', async () => {
    const { disk } = packable()
    const pack = await listed(disk)
    expect(pack[0]).toBe('project.json')
    expect(pack.filter(p => p.startsWith('Motifs/')).sort()).toEqual([
      'Motifs/lower-third/index.html', 'Motifs/title-card/.motif-notes', 'Motifs/title-card/assets/logo.png', 'Motifs/title-card/index.html',
    ])
  })

  it('leaves out machine-local entries, Motif backups, untracked Motif folders, scratch files and links', async () => {
    const { disk, local } = packable()
    const pack = await listed(disk)
    for (const p of local.filter(p => !p.endsWith('/project.json'))) expect(pack).not.toContain(p.slice('/from/'.length))
    for (const p of pack) {
      expect(p.startsWith('Backups/'), p).toBe(false)
      expect(p.startsWith('Motifs/left-behind/'), p).toBe(false)
    }
    expect(pack).not.toContain('Media/.DS_Store')
    expect(pack).not.toContain('Media/new.mp4.tmp')
    expect(pack).not.toContain('Media/link.mp4')
  })

  it('holds a pool file under Media/ whose name the folder walk skips, as Save As carries it', async () => {
    const { disk } = packable()
    disk.put('/from/Media/.voice.wav', 'voice')
    const pooled = ['Media/.voice.wav', 'Media/clip.mp4', 'Cache/proxies/h.mp4'].map(p => parseProjectPath(p))
    const pack = (await packFiles('/from', [], disk.contentFs, 'linux', pooled)).map(e => e.path as string)
    expect(pack).toContain('Media/.voice.wav')
    expect(pack.filter(p => p === 'Media/clip.mp4')).toHaveLength(1)
    expect(pack).not.toContain('Cache/proxies/h.mp4')
    expect(pack).not.toContain('Media/.DS_Store')

    await copyProjectContent('/from', '/to', disk.contentFs, 'linux')
    await copyLateFiles('/from', '/to', pooled, disk.contentFs, 'linux')
    expect(disk.read('/to/Media/.voice.wav')).toBe('voice')
  })

  it('gives each file its size', async () => {
    const { disk } = packable()
    for (const e of await packFiles('/from', [], disk.contentFs, 'linux')) expect(e.size, e.path).toBe(disk.read(`/from/${e.path}`)!.length)
  })

  it('allows at the top level exactly project.json, the project content and Motifs/, none of them machine-local', () => {
    expect([...PACK_TOP_LEVEL].sort()).toEqual(['project.json', 'Motifs', ...PROJECT_CONTENT].sort())
    const localTops = PROJECT_MACHINE_LOCAL.map(p => p.replace(/^\//, '').replace(/\/$/, ''))
    for (const top of PACK_TOP_LEVEL) expect(localTops, top).not.toContain(top)
  })

  it('names under the allowed tops only', async () => {
    const { disk } = packable()
    for (const p of await listed(disk)) expect(PACK_TOP_LEVEL, p).toContain(p.split('/')[0])
  })
})

describe('ensureGitignore', () => {
  const join = (...parts: string[]) => parts.join('/')

  it('gives a folder without one the default, which ignores every machine-local directory', () => {
    const disk = memDisk()
    disk.fs.mkdirp('/p')
    ensureGitignore('/p', disk.fs, join)
    expect(disk.read('/p/.gitignore')).toBe(DEFAULT_GITIGNORE)
    const patterns = DEFAULT_GITIGNORE.split('\n')
    for (const local of ['/Cache/', '/Backups/', '/Logs/', '/output/', '/project.pre-v*.json']) expect(patterns).toContain(local)
  })

  it('keeps the one the user has', () => {
    const disk = memDisk()
    disk.put('/p/.gitignore', '/my-notes/\n')
    ensureGitignore('/p', disk.fs, join)
    expect(disk.read('/p/.gitignore')).toBe('/my-notes/\n')
  })
})

describe('copyLateFiles', () => {
  it('copies a pooled file that reached the old folder after the content copy', async () => {
    const { disk } = projectAt('/from')
    await copyProjectContent('/from', '/to', disk.contentFs, 'linux')
    disk.put('/from/Media/late.mp4', 'late')
    await copyLateFiles('/from', '/to', [parseProjectPath('Media/late.mp4'), parseProjectPath('Media/clip.mp4')], disk.contentFs, 'linux')
    expect(disk.read('/to/Media/late.mp4')).toBe('late')
  })

  it('does not throw when a file cannot be copied: the folders have already switched', async () => {
    const { disk } = projectAt('/from')
    disk.put('/from/Media/late.mp4', 'late')
    disk.refuse.clone = 'ENOSYS'
    disk.refuse.link = 'EXDEV'
    disk.refuse.copy = () => 'ENOSPC'
    await expect(copyLateFiles('/from', '/to', [parseProjectPath('Media/late.mp4')], disk.contentFs, 'linux')).resolves.toBeUndefined()
    expect(disk.read('/to/Media/late.mp4')).toBeUndefined()
  })
})

describe('placeFilePlans', () => {
  const HASH = 'a'.repeat(64)

  it('moves and copies inside the folder, copying with the source\'s time', async () => {
    const disk = memDisk()
    disk.put(`/ws/Cache/proxies/${HASH}.mp4`, 'proxy')
    disk.put(`/ws/Cache/voiceover/${HASH}.mp3`, 'voice', 1_700_000_000)
    const missing = await placeFilePlans('/ws', [
      { from: `Cache/proxies/${HASH}.mp4`, to: `Cache/proxies/${HASH}.full-p7.mp4`, mode: 'move' },
      { from: `Cache/voiceover/${HASH}.mp3`, to: 'Media/Voiceover/voiceover-aaaaaaaa.mp3', mode: 'copy' },
    ], disk.contentFs, 'linux')
    expect(missing).toEqual([])
    expect(disk.read(`/ws/Cache/proxies/${HASH}.full-p7.mp4`)).toBe('proxy')
    expect(disk.read(`/ws/Cache/proxies/${HASH}.mp4`)).toBeUndefined()
    expect(disk.read('/ws/Media/Voiceover/voiceover-aaaaaaaa.mp3')).toBe('voice')
    expect(disk.linked(`/ws/Cache/voiceover/${HASH}.mp3`, '/ws/Media/Voiceover/voiceover-aaaaaaaa.mp3')).toBe(false)
    expect(disk.mtimeMs('/ws/Media/Voiceover/voiceover-aaaaaaaa.mp3')).toBe(disk.mtimeMs(`/ws/Cache/voiceover/${HASH}.mp3`))
  })

  it('skips a move whose source is gone and reports a copy whose source is', async () => {
    const disk = memDisk()
    disk.put('/ws/project.json', '{}')
    const missing = await placeFilePlans('/ws', [
      { from: `Cache/proxies/${HASH}.mp4`, to: `Cache/proxies/${HASH}.full-p7.mp4`, mode: 'move' },
      { from: `Cache/voiceover/${HASH}.mp3`, to: 'Media/Voiceover/voiceover-aaaaaaaa.mp3', mode: 'copy' },
    ], disk.contentFs, 'linux')
    expect(missing.map(m => m.path)).toEqual(['Media/Voiceover/voiceover-aaaaaaaa.mp3'])
  })

  it('reports a copy that fails', async () => {
    const disk = memDisk()
    disk.put(`/ws/Cache/voiceover/${HASH}.mp3`, 'voice')
    disk.refuse.clone = 'ENOTSUP'
    disk.refuse.copy = () => 'ENOSPC'
    const missing = await placeFilePlans('/ws', [
      { from: `Cache/voiceover/${HASH}.mp3`, to: 'Media/Voiceover/voiceover-aaaaaaaa.mp3', mode: 'copy' },
    ], disk.contentFs, 'linux')
    expect(missing).toEqual([{ path: 'Media/Voiceover/voiceover-aaaaaaaa.mp3', diagnostic: expect.stringContaining('ENOSPC') }])
    expect(disk.files().filter(p => p.startsWith('/ws/Media/'))).toEqual([])
  })

  it('leaves a target that is already there as it is', async () => {
    const disk = memDisk()
    disk.put(`/ws/Cache/voiceover/${HASH}.mp3`, 'voice')
    disk.put('/ws/Media/Voiceover/voiceover-aaaaaaaa.mp3', 'kept')
    const missing = await placeFilePlans('/ws', [
      { from: `Cache/voiceover/${HASH}.mp3`, to: 'Media/Voiceover/voiceover-aaaaaaaa.mp3', mode: 'copy' },
    ], disk.contentFs, 'linux')
    expect(missing).toEqual([])
    expect(disk.read('/ws/Media/Voiceover/voiceover-aaaaaaaa.mp3')).toBe('kept')
  })
  it('copies a voiceover from the path the old file recorded when the folder has no cache of it', async () => {
    const disk = memDisk()
    disk.put('/ws/project.json', '{}')
    disk.put(`/elsewhere/Cache/voiceover/${HASH}.mp3`, 'voice')
    const missing = await placeFilePlans('/ws', [{
      from: `Cache/voiceover/${HASH}.mp3`, to: 'Media/Voiceover/voiceover-aaaaaaaa.mp3', mode: 'copy',
      recorded: `/elsewhere/Cache/voiceover/${HASH}.mp3`,
    }], disk.contentFs, 'linux')
    expect(missing).toEqual([])
    expect(disk.read('/ws/Media/Voiceover/voiceover-aaaaaaaa.mp3')).toBe('voice')
  })
})
