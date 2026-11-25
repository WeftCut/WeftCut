// The files that stand for a project on disk (ADR 0180): the project file in
// its folder, and the pack that carries the folder as one file.

/** The project file's extension, without its dot. */
export const PROJECT_EXTENSION = 'wcpr'

/** The project file: what an open picks and what autosave writes. A fixed name,
 *  so renaming the folder never leaves it pointing at a stale file name. */
export const PROJECT_FILE = `project.${PROJECT_EXTENSION}`

/** The project file of WeftCut 0.8 and earlier. An open renames it to
 *  `PROJECT_FILE`; nothing writes it. */
export const LEGACY_PROJECT_FILE = 'project.json'

/** The extension of a pack file, without its dot. */
export const PACK_EXTENSION = 'wcpk'
