import { describe, expect, it } from 'vitest'
import { mediaFolderPath, spelledKey } from './importSource'

const asSpelled = (p: string) => p

describe('mediaFolderPath', () => {
  it('keeps the path of a file already under Media/ with portable names', () => {
    expect(mediaFolderPath('/proj', '/proj/Media/sub/clip.mp4', asSpelled, spelledKey(asSpelled, 'linux'), 'linux')).toBe('Media/sub/clip.mp4')
    expect(mediaFolderPath('C:\\proj', 'C:\\proj\\Media\\sub\\clip.mp4', asSpelled, spelledKey(asSpelled, 'win32'), 'win32')).toBe('Media/sub/clip.mp4')
  })

  // `take?.mp4` is a valid Linux name and no Windows one: recorded as found,
  // the project could not be opened on Windows. Null makes the import copy it
  // in under a portable name.
  it('answers null for a file under Media/ whose name is not portable', () => {
    expect(mediaFolderPath('/proj', '/proj/Media/take?.mp4', asSpelled, spelledKey(asSpelled, 'linux'), 'linux')).toBeNull()
    expect(mediaFolderPath('/proj', '/proj/Media/con/clip.mp4', asSpelled, spelledKey(asSpelled, 'linux'), 'linux')).toBeNull()
  })

  it('answers null for a file outside Media/', () => {
    expect(mediaFolderPath('/proj', '/proj/clip.mp4', asSpelled, spelledKey(asSpelled, 'linux'), 'linux')).toBeNull()
    expect(mediaFolderPath('/proj', '/elsewhere/Media/clip.mp4', asSpelled, spelledKey(asSpelled, 'linux'), 'linux')).toBeNull()
  })

  it('finds Media/ however the source spells the folder', () => {
    // Two spellings of one folder: the file key says they are the same.
    const key = (p: string) => p.replace('/link/', '/proj/')
    expect(mediaFolderPath('/proj', '/link/Media/clip.mp4', asSpelled, key, 'linux')).toBe('Media/clip.mp4')
  })
})
