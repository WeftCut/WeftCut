// apps/desktop/src/main/mcp/projectTools.ts
//
// `open_project` / `create_project`: the start screen's Open and New Project,
// for an agent the user asked to open or make one. They run on the host — not
// the actor — because opening replaces the actor's whole state and the editor
// has to follow (`TsActorHost.projects`). Both answer with or without a project
// open (`APP_SCOPE_TOOLS`).
//
// Every refusal names the folder and the way out in its text: the workspace
// vocabulary (`shared/workspaceErrors.ts`) was written for the start screen,
// which already shows the path, so its variants carry none.
import type { ServerResult } from '@modelcontextprotocol/sdk/types.js'
import type { TsActorHost } from '../state/ts-actor-host.js'
import { mcpDef } from '../state/mcp-commands.js'
import { toolRecord } from '../state/mcp-results.js'
import { isWorkspaceFailure, type WorkspaceError } from '../../shared/workspaceErrors.js'
import { toolErrorResult } from './toolResult.js'

export const PROJECT_TOOLS: ReadonlySet<string> = new Set(['open_project', 'create_project'])

export async function runProjectTool(
  host: Pick<TsActorHost, 'projects' | 'projectStatus'>,
  name: string,
  args: Record<string, unknown>,
): Promise<ServerResult> {
  const p = mcpDef(name).parseDedicated!(args)
  if (host.projects.shuttingDown()) {
    return toolErrorResult({ code: 'invalid_request', message: 'WeftCut is quitting, so no project can be opened now. Nothing was changed.', data: { error: 'AppQuitting' } })
  }
  if (name === 'open_project') {
    const dir = p.path as string
    try { return toolRecord(await host.projects.open(dir)) as unknown as ServerResult }
    catch (e) { return refusal(e, dir) }
  }
  const parent = (p.parent_folder as string | null) ?? host.projectStatus().default_parent_folder
  if (parent === null) {
    return toolErrorResult({
      code: 'invalid_params',
      message: 'create_project needs parent_folder: no project has been created in WeftCut yet, so there is no default folder. Ask the user where the project should go. Nothing was changed.',
      data: { field: 'parent_folder' },
    })
  }
  const target = joinFolder(parent, p.name as string)
  try {
    return toolRecord(await host.projects.create({
      parentFolder: parent, name: p.name as string,
      width: p.width as number, height: p.height as number, fpsNum: p.fps_num as number, fpsDen: p.fps_den as number,
    })) as unknown as ServerResult
  } catch (e) { return refusal(e, target) }
}

/** The folder the orchestrator will create, spelled the way the path was sent
 *  (a `\` parent keeps `\`), for the refusal text only. */
function joinFolder(parent: string, name: string): string {
  const sep = parent.includes('\\') ? '\\' : '/'
  return parent.endsWith(sep) ? `${parent}${name}` : `${parent}${sep}${name}`
}

function refusal(e: unknown, dir: string): ServerResult {
  if (!isWorkspaceFailure(e)) throw e
  return toolErrorResult({ code: 'invalid_params', message: `${workspaceProblem(e.err, dir)} Nothing was changed.`, data: { ...e.err } })
}

export function workspaceProblem(err: WorkspaceError, dir: string): string {
  switch (err.error) {
    case 'ProjectFolderMissing': return `${dir} does not exist. read_project { view: "session" } lists recent_projects; otherwise ask the user where the project is.`
    case 'NotProjectFolder': return `${dir} is not a WeftCut project folder (it holds no project.json). Pass the folder that holds project.json, or create_project for a new one.`
    case 'ProjectSchemaUnreadable': return `${dir}/project.json is not a project file this WeftCut recognises (no schema_version).`
    case 'ProjectSchemaTooNew': return `${dir} was saved by a newer WeftCut (schema ${err.found}; this build reads up to ${err.supported}). Opening it here could drop what the newer version wrote; the user needs a WeftCut that reads schema ${err.found}.`
    case 'ProjectFileUnreadable': return `${dir}/project.json could not be read: ${err.detail}`
    case 'ProjectInvalid': return `${dir}/project.json loaded but failed validation: ${err.detail}`
    case 'ProjectFolderExists': return `${dir} already exists and is never overwritten. Pick another name, or open_project it if it is a WeftCut project.`
    case 'ProjectNameRequired': return 'name is required.'
    case 'InvalidCanvasPreset': return 'width, height and fps must all be non-zero.'
  }
}
