import { toolJson, toolText, type ToolResultJson } from '../state/mcp-commands.js'
import { toolRecord } from '../state/mcp-results.js'
export function shapeMotifMcpResult(name:string,raw:unknown,_args:Record<string,unknown>={}):ToolResultJson {
  if(name==='list_motifs')return toolJson((raw as Array<Record<string,unknown>>).map(({html:_html,...rest})=>rest))
  if(name==='motif_staleness_report')return toolJson(raw)
  if(name==='acknowledge_motif_staleness')return toolText(String(raw))
  return toolRecord(raw as Record<string,unknown>)
}
