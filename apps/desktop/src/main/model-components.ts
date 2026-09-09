import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { net } from "electron";
import type { ModelProfile } from "../shared/inference-models";

const execute = promisify(execFile);
// Microsoft documents this serviced URL; validate the signed payload before launch.
// https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist
export const VC_REDIST_URL = "https://aka.ms/vc14/vc_redist.x64.exe";

export function missingModelComponents(p: ModelProfile, exists = fs.existsSync, platform = process.platform): boolean {
  if (platform !== "win32" || p.locality !== "local") return false;
  const runtimeDir = path.dirname(p.local?.binary ?? "");
  const systemDir = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const dlls = ["msvcp140.dll", "vcruntime140.dll"];
  if (p.backend === "whisper_cpp") dlls.push("vcomp140.dll");
  return dlls.some(dll => !exists(path.join(runtimeDir, dll)) && !exists(path.join(systemDir, dll)));
}

let installing: Promise<void> | undefined;
export function installModelComponents(cacheDir: string): Promise<void> {
  // Speech and vision may request the same OS component at once.
  installing ??= install(cacheDir).finally(() => { installing = undefined; });
  return installing;
}

async function install(cacheDir: string): Promise<void> {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Automatic runtime installation is available on Windows x64");
  const dir = await fs.promises.mkdtemp(path.join(cacheDir, "model-components-"));
  const installer = path.join(dir, "vc_redist.x64.exe");
  try {
    const response = await net.fetch(VC_REDIST_URL, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw new Error(`Runtime download failed (${response.status})`);
    const reader = response.body.getReader();
    const handle = await fs.promises.open(installer, "wx");
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 100 * 1024 * 1024) throw new Error("Unexpected runtime installer size");
        await handle.writeFile(value);
      }
    } finally { await reader.cancel().catch(() => {}); await handle.close(); }
    const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    // The path is passed as data via the environment, never interpolated into shell code.
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$signature = Get-AuthenticodeSignature -LiteralPath $env:WEFTCUT_COMPONENT_INSTALLER",
      "if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|,\\s*)O=Microsoft Corporation(,|$)') { throw 'Runtime installer signature is not Microsoft trusted' }",
      "$process = Start-Process -FilePath $env:WEFTCUT_COMPONENT_INSTALLER -ArgumentList '/install','/passive','/norestart' -Verb RunAs -WindowStyle Hidden -Wait -PassThru",
      "if ($process.ExitCode -notin 0,1638,3010) { throw ('Runtime installation failed: ' + $process.ExitCode) }",
    ].join("\n");
    await execute(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, timeout: 600_000, maxBuffer: 256 * 1024,
      env: { ...process.env, WEFTCUT_COMPONENT_INSTALLER: installer },
    });
  } finally {
    // mkdtemp created this exact child under the supplied cache; only our installer is removed.
    await fs.promises.rm(installer, { force: true }).catch(() => {});
    await fs.promises.rmdir(dir).catch(() => {});
  }
}
