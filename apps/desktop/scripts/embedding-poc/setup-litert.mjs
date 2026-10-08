// PROTOTYPE Linux x64 native SDK staging. No Python installation required.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export async function setupLiteRt(directory) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This benchmark currently provisions Linux x64 only');
  fs.mkdirSync(directory, { recursive: true });
  async function verifiedDownload(url, target, expected) {
    if (!fs.existsSync(target)) {
      console.log(`Downloading ${path.basename(target)}`);
      const staging = `${target}.download`;
      try {
        execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '2', '--output', staging, url], { stdio: 'inherit' });
        const hash = createHash('sha256');
        for await (const chunk of fs.createReadStream(staging)) hash.update(chunk);
        if (hash.digest('hex') !== expected) throw new Error(`Checksum mismatch: ${target}`);
        fs.renameSync(staging, target);
      } finally {
        fs.rmSync(staging, { force: true });
      }
    }
  }
  const library = path.join(directory, 'sdk/litert_lm');
  if (!fs.existsSync(path.join(library, 'liblitert-lm.so'))) {
    fs.mkdirSync(library, { recursive: true });
    const wheel = path.join(directory, 'litert-native-sdk.whl');
    await verifiedDownload('https://files.pythonhosted.org/packages/c9/8f/eb7a5203be1d48440c6b8d6e6382c3f744dd6d338fe400555718b4d695a1/litert_lm_api-0.18.0-py3-none-manylinux_2_27_x86_64.whl',
      wheel, 'b64e2cf6d7dcb90ff094b74af595cc5d53faa07e0889f967d15df8d3e696b53c');
    try {
      execFileSync('unzip', ['-j', '-o', wheel, 'litert_lm/liblitert-lm.so', '-d', library], { stdio: 'inherit' });
      fs.writeFileSync(path.join(directory, 'SDK-METADATA.txt'), execFileSync('unzip', ['-p', wheel, 'litert_lm_api-0.18.0.dist-info/METADATA']));
    } finally {
      fs.rmSync(wheel, { force: true });
    }
  }
  const include = path.join(directory, 'include/c');
  fs.mkdirSync(include, { recursive: true });
  for (const [name, sha] of Object.entries({
    'api_export.h': '97489762c154658c6180d44c0a4b3479781cfe982a42920221189fe587e40637',
    'embedding_engine.h': '54a5d82516c71529c42f86a031605dc47bdf5ee5c7379be65bf1dd0fae22d512',
    'engine.h': '41c38c182e736f3c239785b474e7c9d145cd711a1d5dc9882f403e0319953584',
  })) await verifiedDownload(`https://raw.githubusercontent.com/google-ai-edge/LiteRT-LM/v0.18.0/c/${name}`, path.join(include, name), sha);
  await verifiedDownload('https://huggingface.co/litert-community/embeddinggemma-2-text-vision-440m-litert-lm/resolve/e301f74d5551b0c2641bd5cb4652a76239d5c5f8/embeddinggemma-2-text-vision-440m.litertlm',
    path.join(directory, 'embeddinggemma-2-text-vision-440m.litertlm'), '92dcbea108899e5d6e30d919b0744f90d9967e80c67a4ab5503ac16d54f62eb0');
}
