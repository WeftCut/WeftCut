/** Small release/automation client. Connection secrets are read from a private file. */
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function connect(file=process.env.WEFTCUT_CONNECTION_FILE) {
  if(!file)throw Error('Set WEFTCUT_CONNECTION_FILE to a private JSON containing url and key');
  const connection=JSON.parse(await fs.readFile(file,'utf8'));
  const transport=new StreamableHTTPClientTransport(new URL(connection.url),{
    requestInit:{headers:{Authorization:`Bearer ${connection.key}`}},
  });
  const client=new Client({name:'neith-editor-release',version:'1.0.0'});
  await client.connect(transport);
  return {client,transport,connection};
}

export function records(result) {
  if(result.isError)throw Error(result.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')||'MCP tool failed');
  if(result.structuredContent)return result.structuredContent;
  const text=result.content?.find(x=>x.type==='text')?.text;
  try{return JSON.parse(text);}catch{return text;}
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const {client,transport}=await connect();
  try {
    const name=process.argv[2]||'tools';
    const result=name==='tools'?await client.listTools():await client.callTool({name,arguments:JSON.parse(process.argv[3]||'{}')});
    console.log(JSON.stringify(result,(key,value)=>key==='data'&&typeof value==='string'&&value.length>1000?'[binary omitted]':value,null,2));
  }finally{await transport.terminateSession().catch(()=>{});await client.close();}
}
