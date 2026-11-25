// electron-builder.yml cannot import fileTypes.ts, so it carries the owned
// types as copies; this holds each copy to the table.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { PACK_EXTENSION, PROJECT_EXTENSION } from '../../shared/projectFile.js'
import { OWNED_FILE_TYPES } from './fileTypes.js'

const builder = parse(readFileSync(new URL('../../../electron-builder.yml', import.meta.url), 'utf8'))

describe('owned file types', () => {
  it('are the project file and the pack', () => {
    expect(OWNED_FILE_TYPES.map((type) => type.ext).sort()).toEqual([PROJECT_EXTENSION, PACK_EXTENSION].sort())
  })
})

describe('electron-builder.yml file associations', () => {
  it('registers each owned type once with Windows', () => {
    const entries = builder.win.fileAssociations
    expect(entries).toHaveLength(OWNED_FILE_TYPES.length)
    for (const type of OWNED_FILE_TYPES) {
      expect(entries).toContainEqual({ ext: type.ext, name: type.progId, description: type.description, mimeType: type.mime })
    }
  })

  it('registers the same types with the deb as with Windows', () => {
    expect(builder.linux.fileAssociations).toEqual(builder.win.fileAssociations)
  })

  it('exports one UTI per owned type from the macOS bundle', () => {
    const declarations = builder.mac.extendInfo.UTExportedTypeDeclarations
    expect(declarations).toHaveLength(OWNED_FILE_TYPES.length)
    for (const type of OWNED_FILE_TYPES) {
      expect(declarations).toContainEqual(expect.objectContaining({
        UTTypeIdentifier: type.uti,
        UTTypeDescription: type.description,
        UTTypeTagSpecification: { 'public.filename-extension': [type.ext], 'public.mime-type': [type.mime] },
      }))
    }
  })

  it('makes the macOS app the owner of each owned type', () => {
    const documents = builder.mac.extendInfo.CFBundleDocumentTypes
    expect(documents).toHaveLength(OWNED_FILE_TYPES.length)
    for (const type of OWNED_FILE_TYPES) {
      expect(documents).toContainEqual(expect.objectContaining({
        CFBundleTypeName: type.description,
        LSItemContentTypes: [type.uti],
        LSHandlerRank: 'Owner',
      }))
    }
  })
})

describe('build/installer.nsh', () => {
  const nsh = readFileSync(new URL('../../../build/installer.nsh', import.meta.url), 'utf8')

  it('releases each owned extension on uninstall, under its ProgID', () => {
    const released = [...nsh.matchAll(/!insertmacro weftcutReleaseExtension "([^"]+)" "([^"]+)"/g)].map(([, ext, progId]) => ({ ext, progId }))
    expect(released).toHaveLength(OWNED_FILE_TYPES.length)
    for (const type of OWNED_FILE_TYPES) expect(released).toContainEqual({ ext: type.ext, progId: type.progId })
  })
})
