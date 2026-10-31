import fs from 'node:fs';
import {extractAll} from '@electron/asar';
const runtime = '/opt/WeftCut';
extractAll(`${runtime}/resources/app.asar`, `${runtime}/resources/app`);
const target = `${runtime}/resources/app/out`;
fs.rmSync(target, {recursive:true,force:true});
fs.cpSync('/src/apps/desktop/out', target, {recursive:true});
// Build extras used by the packaged main, not only the renderer.
for (const name of ['cli','skills']) {
  fs.rmSync(`${runtime}/resources/${name}`, {recursive:true,force:true});
  fs.cpSync(`/src/apps/desktop/out/${name}`, `${runtime}/resources/${name}`, {recursive:true});
}
fs.rmSync(`${runtime}/resources/app.asar`);
fs.rmSync(`${runtime}/resources/app.asar.unpacked`, {recursive:true,force:true});
fs.copyFileSync('/src/LICENSE', `${runtime}/resources/Neith-WeftCut-LICENSE`);
fs.copyFileSync('/src/THIRD-PARTY-NOTICES.md', `${runtime}/resources/Neith-THIRD-PARTY-NOTICES.md`);
