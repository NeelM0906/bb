import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pluginSdkAliasFor } from "../../../src/services/plugins/plugin-runtime.js";

let directory: string;
let runtimePath: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "bb-plugin-sdk-alias-"));
  runtimePath = join(directory, "plugin-sdk-runtime.js");
  const sdkRoot = new URL(
    "../../../../../packages/plugin-sdk/",
    import.meta.url,
  );
  await cp(new URL("dist/index.js", sdkRoot), runtimePath);
  await cp(
    new URL("dist", sdkRoot),
    join(directory, "plugin-sdk-runtime/dist"),
    {
      recursive: true,
    },
  );
  await cp(
    new URL("package.json", sdkRoot),
    join(directory, "plugin-sdk-runtime/package.json"),
  );
  await symlink(
    fileURLToPath(new URL("../../../node_modules", import.meta.url)),
    join(directory, "node_modules"),
    "dir",
  );
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("pluginSdkAliasFor", () => {
  it("resolves the pre-rename specifier to the same SDK runtime bundle", () => {
    const alias = pluginSdkAliasFor(runtimePath);
    expect(alias["@get-bb/plugin-sdk"]).toBe(runtimePath);
    expect(alias["@bb/plugin-sdk"]).toBe(runtimePath);
  });

  it.each(["@get-bb/plugin-sdk", "@bb/plugin-sdk"])(
    "loads root, host, and nested provider exports for %s from packaged bundles",
    async (specifier) => {
      const entry = join(
        directory,
        `${specifier === "@bb/plugin-sdk" ? "legacy" : "current"}.ts`,
      );
      await writeFile(
        entry,
        `export { defineRpcContract } from "${specifier}";
export { experimental_defineHostEntry } from "${specifier}/host";
export { experimental_acpProviderBridge } from "${specifier}/provider-bridge/acp";
`,
      );
      const jiti = createJiti(import.meta.url, {
        alias: pluginSdkAliasFor(runtimePath),
        moduleCache: false,
      });
      const loaded = await jiti.import(entry);
      expect(loaded).toMatchObject({
        defineRpcContract: expect.any(Function),
        experimental_defineHostEntry: expect.any(Function),
        experimental_acpProviderBridge: expect.any(Object),
      });
    },
  );
});
