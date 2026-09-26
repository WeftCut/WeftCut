// The main -> renderer event that brings the editor to a project an AGENT
// opened or created (`open_project` / `create_project`). The UI's own open
// paths navigate from their callbacks and never send it.
export const PROJECT_OPENED_EVENT = 'project:opened'
export interface ProjectOpenedPayload { dir: string }
