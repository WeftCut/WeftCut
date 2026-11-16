import { describe, expect, it } from 'vitest'
import { originalMediaPath } from './mediaPath'

describe('FCPXML original file URLs', () => {
  it.each(['darwin', 'linux', 'win32'] as const)('keeps paths from both formats on %s', (platform) => {
    expect(originalMediaPath('file:///C:/Media/Fictional%20Caf%C3%A9.mov', platform)).toEqual({
      path: 'C:\\Media\\Fictional Café.mov', filename: 'Fictional Café.mov', local: platform === 'win32',
    })
    expect(originalMediaPath('file:///home/u/Fictional%20Caf%C3%A9.mov', platform)).toEqual({
      path: '/home/u/Fictional Café.mov', filename: 'Fictional Café.mov', local: platform !== 'win32',
    })
  })

  it.each([
    'file://files.example.invalid/Media/Take.mov',
    'file:////files.example.invalid/Media/Take.mov',
    'file:///C:/Media/../Take.mov',
    'file:///C:/Media/%2E%2E/Take.mov',
    'file:///C:/Media%5CTake.mov',
    'file:///C:/Media%2FTake.mov',
    'file:///C:/Media/NUL.mov',
    'file:///C:/Media/COM%C2%B9.mov',
    'file:///C:/Media/Take.mov%3Astream',
    'file:///C:/Media/Take.mov%20',
    'file:///C:Take.mov',
    'file:///home/u/Take.mov?download',
  ])('refuses unsafe or ambiguous URL %s on either platform', (url) => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(() => originalMediaPath(url, platform)).toThrow(/absolute local file URL/)
    }
  })
})
