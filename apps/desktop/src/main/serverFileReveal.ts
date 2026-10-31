import fs from 'node:fs/promises';
import path from 'node:path';

/** Server containers have no desktop file manager. Publish an authenticated
 * reveal event to the browser gateway instead; it independently confines and
 * streams the completed output without exposing a general filesystem API. */
export async function revealServerFile(target: string, deps = {
  key: () => fs.readFile(path.join(process.env.WEFTCUT_DATA ?? '/data', 'access-key'), 'utf8'),
  post: (body: string, key: string) => fetch('http://127.0.0.1:8080/api/files/reveal', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body, signal: AbortSignal.timeout(5000),
  }),
}): Promise<void> {
  if (typeof target !== 'string' || !path.isAbsolute(target) || target.includes('\0')) throw new Error('Invalid export file path');
  const key = (await deps.key()).trim();
  if (key.length < 32) throw new Error('Browser gateway authentication is unavailable');
  const response = await deps.post(JSON.stringify({ path: target }), key);
  if (!response.ok) throw new Error(response.status === 404 ? 'The exported file no longer exists' : 'Cannot show this file in the browser export folder');
}
