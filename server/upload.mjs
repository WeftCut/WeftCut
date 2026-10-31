import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';

export async function upload(connection, path, name) {
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(path))hash.update(chunk);
  const sha256=hash.digest('hex');
  const response=await fetch(new URL('/api/media/'+encodeURIComponent(name),connection.url),{
    method:'PUT',headers:{Authorization:'Bearer '+connection.key,'X-Content-SHA256':sha256},
    body:createReadStream(path),duplex:'half',
  });
  if(!response.ok)throw Error(`Upload ${name}: HTTP ${response.status} ${await response.text()}`);
  const result=await response.json();
  if(result.sha256!==sha256||result.bytes!==(await fs.stat(path)).size)throw Error('Upload verification failed: '+name);
  return result;
}
