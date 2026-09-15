import { describe, expect, it } from "vitest";
import { CONTENT_CATALOG } from "./content-catalog";
import { contentPlatformKey } from "./content-download";

// The catalog is a supply-chain surface: every entry must stay pinned
// (immutable versioned URL + exact bytes + SHA-256) so a drive-by "bump the
// URL" edit cannot silently turn a verified artifact into a rolling one.
// These invariants gate every current AND future entry.

const allArtifacts = CONTENT_CATALOG.flatMap((item) =>
  Object.entries(item.platforms).map(([platform, artifact]) => ({
    id: item.id,
    platform,
    artifact,
  })),
);

describe("content catalog pinning invariants", () => {
  it("ids are unique and every item covers at least one platform", () => {
    const ids = CONTENT_CATALOG.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of CONTENT_CATALOG) {
      expect(Object.keys(item.platforms).length).toBeGreaterThan(0);
    }
  });

  it("every artifact pins an https URL that is not a rolling endpoint", () => {
    for (const { id, artifact } of allArtifacts) {
      expect(artifact.url, id).toMatch(/^https:\/\//);
      // "latest" anywhere in the URL is the canonical mutable-endpoint smell
      // (GitHub /releases/latest/, HF /resolve/main/ is caught by the next
      // assertion requiring the pinned revision to appear in the URL).
      expect(artifact.url, id).not.toContain("latest");
    }
  });

  it("model URLs embed the exact pinned revision, never a branch name", () => {
    for (const item of CONTENT_CATALOG) {
      for (const artifact of Object.values(item.platforms)) {
        if (artifact.url.includes("huggingface.co")) {
          expect(artifact.url, item.id).toContain(item.version);
          expect(artifact.url, item.id).not.toContain("/resolve/main/");
        }
      }
    }
  });

  it("every artifact pins a 64-hex sha256 and a positive byte count", () => {
    for (const { id, artifact } of allArtifacts) {
      expect(artifact.sha256, id).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.bytes, id).toBeGreaterThan(0);
      expect(Number.isInteger(artifact.bytes), id).toBe(true);
    }
  });

  it("entry paths are relative and traversal-free (they name a file inside the install dir)", () => {
    for (const { id, artifact } of allArtifacts) {
      expect(artifact.entryPath, id).not.toMatch(/^([a-zA-Z]:)?[\\/]/);
      expect(artifact.entryPath, id).not.toContain("..");
      expect(artifact.entryPath.length, id).toBeGreaterThan(0);
    }
  });

  it("config field paths obey the same relative/traversal-free rule", () => {
    for (const { id, artifact } of allArtifacts) {
      for (const rel of Object.values(artifact.fields)) {
        expect(rel, id).not.toMatch(/^([a-zA-Z]:)?[\\/]/);
        expect(rel, id).not.toContain("..");
        expect(rel.length, id).toBeGreaterThan(0);
      }
    }
  });

  it("every artifact names at least one field, and its entry point is one of them", () => {
    for (const { id, platform, artifact } of allArtifacts) {
      const paths = Object.values(artifact.fields);
      expect(paths.length, `${id}: ${platform}`).toBeGreaterThan(0);
      // The entry point is what `itemStatus` probes on disk; a path it does not
      // also hand to an engine config would leave the item "installed" and the
      // engine pointed at nothing.
      expect(paths, `${id}: ${platform}`).toContain(artifact.entryPath);
    }
  });

  it("a family only names fields its own engine config has", () => {
    for (const item of CONTENT_CATALOG) {
      for (const artifact of Object.values(item.platforms)) {
        const named = Object.keys(artifact.fields);
        if (item.speech) expect(named, item.id).not.toContain("mmproj");
        if (item.vlm) expect(named, item.id).not.toContain("tokens");
      }
    }
  });

  it("platform keys are the ContentPlatformKey scheme", () => {
    for (const { id, platform } of allArtifacts) {
      const [os, arch] = platform.split("-");
      expect(contentPlatformKey(os!, arch!), `${id}: ${platform}`).toBe(
        platform,
      );
    }
  });
});

describe("the ADR 0039 slice is present verbatim", () => {
  it("whisper.cpp v1.9.1 Windows runtime", () => {
    const runtime = CONTENT_CATALOG.find((i) => i.id === "whisper-cpp-runtime");
    const win = runtime?.platforms["win32-x64"];
    expect(win?.bytes).toBe(7982101);
    expect(win?.sha256).toBe(
      "7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539",
    );
    expect(win?.entryPath).toBe("Release/whisper-cli.exe");
    expect(win?.fields).toEqual({ binary: "Release/whisper-cli.exe" });
    expect(runtime?.speech).toEqual({ backend: "whisper_cpp" });
  });

  it("multilingual Base model at the pinned HF revision", () => {
    const model = CONTENT_CATALOG.find((i) => i.id === "whisper-model-base");
    const win = model?.platforms["win32-x64"];
    expect(win?.bytes).toBe(147951465);
    expect(win?.sha256).toBe(
      "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    );
    // The multilingual Base, not base.en and not a quantized variant.
    expect(win?.entryPath).toBe("ggml-base.bin");
    expect(win?.fields).toEqual({ model: "ggml-base.bin" });
    expect(model?.version).toBe("5359861c739e955e79d9a303bcbc70fb988958b1");
    expect(model?.speech).toEqual({ backend: "whisper_cpp" });
  });
});

describe("the ADR 0043 slice is present verbatim", () => {
  it("sherpa-onnx v1.13.4 shared-MD-Release Windows runtime", () => {
    const runtime = CONTENT_CATALOG.find((i) => i.id === "funasr-runtime");
    const win = runtime?.platforms["win32-x64"];
    expect(win?.bytes).toBe(20034576);
    expect(win?.sha256).toBe(
      "d4dacc8be5afe03f22ade4d50cfd587c03a625eaca8c41f2d99a24d3db463eab",
    );
    expect(win?.archive).toBe("tar.bz2");
    // The versioned tag URL, not the rolling one.
    expect(win?.url).toContain("/releases/download/v1.13.4/");
    expect(win?.fields).toEqual({
      binary:
        "sherpa-onnx-v1.13.4-win-x64-shared-MD-Release/bin/sherpa-onnx-offline.exe",
    });
    expect(runtime?.speech).toEqual({ backend: "funasr" });
  });

  it("Paraformer-zh 2023-09-14: one archive fills model AND tokens", () => {
    const model = CONTENT_CATALOG.find(
      (i) => i.id === "funasr-model-paraformer-zh",
    );
    const win = model?.platforms["win32-x64"];
    expect(win?.bytes).toBe(234051698);
    expect(win?.sha256).toBe(
      "9c49fd9c6fb63de8e18c1054cf3d100f804741b7e608e187923cd8ff09fa9f03",
    );
    expect(win?.archive).toBe("tar.bz2");
    expect(win?.fields).toEqual({
      model: "sherpa-onnx-paraformer-zh-2023-09-14/model.int8.onnx",
      tokens: "sherpa-onnx-paraformer-zh-2023-09-14/tokens.txt",
    });
    expect(model?.speech).toEqual({ backend: "funasr" });
  });
});

describe("the ADR 0073 Linux slice is present verbatim", () => {
  const linuxOf = (id: string) =>
    CONTENT_CATALOG.find((i) => i.id === id)?.platforms["linux-x64"];

  it("whisper.cpp v1.9.1 ubuntu-x64 runtime — the same upstream version as Windows", () => {
    const linux = linuxOf("whisper-cpp-runtime");
    expect(linux?.bytes).toBe(9379235);
    expect(linux?.sha256).toBe(
      "f3bf3b4369a99b54665b0f19b88483b30de27f25963b0414235dea03198515c5",
    );
    expect(linux?.archive).toBe("tar.gz");
    expect(linux?.entryPath).toBe("whisper-bin-ubuntu-x64/whisper-cli");
    expect(linux?.url).toContain("/releases/download/v1.9.1/");
    // No MSVC note travels to a platform that has no MSVC.
    expect(linux?.prerequisiteKey).toBeUndefined();
  });

  it("sherpa-onnx v1.13.4 linux-x64-shared runtime", () => {
    const linux = linuxOf("funasr-runtime");
    expect(linux?.bytes).toBe(27801563);
    expect(linux?.sha256).toBe(
      "18887dc13c7d313d0e0f6c164ed31715c27c1c2c4f71acd7c0147dc84cf02514",
    );
    expect(linux?.archive).toBe("tar.bz2");
    expect(linux?.entryPath).toBe(
      "sherpa-onnx-v1.13.4-linux-x64-shared/bin/sherpa-onnx-offline",
    );
  });

  it("llama.cpp b10103 ubuntu vulkan runtime — the Vulkan build here too", () => {
    const linux = linuxOf("llama-mtmd-runtime");
    expect(linux?.bytes).toBe(32238620);
    expect(linux?.sha256).toBe(
      "ca2c3db8aa2787b2e49655460787190d0619caeeff259ffa1bf909fe5133264d",
    );
    expect(linux?.archive).toBe("tar.gz");
    expect(linux?.entryPath).toBe("llama-b10103/llama-mtmd-cli");
    expect(linux?.url).toContain("vulkan");
  });

  it("the models are the same bytes on both platforms — only the runtimes differ", () => {
    for (const id of [
      "whisper-model-base",
      "funasr-model-paraformer-zh",
      "qwen3-vl-4b-model",
      "qwen3-vl-4b-mmproj",
    ]) {
      const item = CONTENT_CATALOG.find((i) => i.id === id);
      expect(item?.platforms["linux-x64"], id).toEqual(
        item?.platforms["win32-x64"],
      );
    }
  });

  it("every catalog item covers Linux — a half-covered engine has no usable row", () => {
    for (const item of CONTENT_CATALOG) {
      expect(Object.keys(item.platforms), item.id).toContain("linux-x64");
    }
  });
});
