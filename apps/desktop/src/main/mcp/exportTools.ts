import { EXPORT_SETTINGS_SCHEMA } from '../../shared/exportValidation.js'
import type { CatalogTool } from './mcpCatalog.js'
const job = { type: 'object', properties: { job_id: {type:'string'} }, required: ['job_id'], additionalProperties: false }
export const EXPORT_TOOL_DEFS: Array<CatalogTool & {description:string;inputSchema:Record<string,unknown>}> = [
  {name:'get_export_options',description:'Get current project export defaults, settings schema, dimensions and frame rate. Settings keys mirror export.json.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'start_export',description:'Export the root composition asynchronously. Returns job_id; poll get_export_status. Existing destinations are refused. Settings keys mirror export.json; range is half-open microseconds.',inputSchema:{type:'object',properties:{output_path:{type:'string'},settings:EXPORT_SETTINGS_SCHEMA,range:{type:'object',properties:{startUs:{type:'integer'},endUs:{type:'integer'}},required:['startUs','endUs'],additionalProperties:false},allow_experimental_10bit:{type:'boolean'}},required:['output_path'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false}},
  {name:'get_export_status',description:'Read an export job status, progress and final output path. Jobs survive MCP reconnection until the application exits.',inputSchema:job,annotations:{readOnlyHint:true}},
  {name:'cancel_export',description:'Cancel an export job and clean partial output. Repeated cancellation is harmless. Project edits resume after cleanup.',inputSchema:job,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true}},
]
export const EXPORT_TOOLS = new Set(EXPORT_TOOL_DEFS.map(t => t.name))
