// The file types WeftCut owns, and the names each OS registers them under
// (ADR 0181). The installers carry copies in electron-builder.yml, held to this
// table by fileTypes.test.ts; an AppImage registers itself from it
// (appImageRegistration.ts).
import { PACK_EXTENSION, PROJECT_EXTENSION } from '../../shared/projectFile.js'

export interface OwnedFileType {
  /** Without its dot. */
  ext: string
  /** Windows ProgID: the registry class the extension points at. */
  progId: string
  /** freedesktop MIME type. */
  mime: string
  /** macOS Uniform Type Identifier, exported by the app bundle. */
  uti: string
  /** What a file manager calls one: Explorer's Type, Finder's Kind, the MIME comment. */
  description: string
}

export const OWNED_FILE_TYPES: readonly OwnedFileType[] = [
  { ext: PROJECT_EXTENSION, progId: 'WeftCut.Project', mime: 'application/x-weftcut-project', uti: 'dev.weftcut.project', description: 'WeftCut Project' },
  { ext: PACK_EXTENSION, progId: 'WeftCut.Pack', mime: 'application/x-weftcut-pack', uti: 'dev.weftcut.pack', description: 'WeftCut Pack' },
]
