import { describe, expect, it } from "vitest";
import {
  pluginCatalogInstallRequestSchema,
  pluginCatalogSearchResultSchema,
  pluginCatalogStatusSchema,
  pluginInstallSourceRequestSchema,
} from "../src/index.js";

describe("plugin catalog contracts", () => {
  it("keeps the managed-workspace override absent for older strict servers", () => {
    expect(
      pluginInstallSourceRequestSchema.parse({ source: "npm:@bb/notes@^1" }),
    ).toEqual({ source: "npm:@bb/notes@^1" });
    expect(
      pluginInstallSourceRequestSchema.parse({
        source: "path:/tmp/plugin",
        allowManagedWorkspaceSource: true,
      }),
    ).toEqual({
      source: "path:/tmp/plugin",
      allowManagedWorkspaceSource: true,
    });
  });

  it("accepts catalog install coordinates without marketplace nesting", () => {
    expect(
      pluginCatalogInstallRequestSchema.parse({
        entryId: "notes",
      }),
    ).toEqual({ entryId: "notes" });
    expect(() =>
      pluginCatalogInstallRequestSchema.parse({
        entryId: "notes",
        version: "1.2.0",
      }),
    ).toThrow();
    expect(() =>
      pluginCatalogInstallRequestSchema.parse({
        marketplace: { marketplaceId: "official", entryId: "notes" },
      }),
    ).toThrow();
  });

  it("keeps status to the bundled plugin count and search fields required", () => {
    const status = {
      pluginCount: 13,
      includedPluginCount: 8,
      optionalPluginCount: 5,
    };
    expect(pluginCatalogStatusSchema.parse(status)).toEqual(status);
    // Refresh-era freshness fields no longer survive parsing.
    expect(
      pluginCatalogStatusSchema.parse({ ...status, lastError: null }),
    ).toEqual(status);

    expect(() =>
      pluginCatalogSearchResultSchema.parse({
        entryId: "notes",
        displayName: "Notes",
        description: "Notes",
        icon: null,
        category: "Productivity",
        source: "builtin:notes",
        installed: false,
        compatible: true,
        incompatibleReason: null,
      }),
    ).toThrow();
  });
});
