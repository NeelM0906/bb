import fs, { realpath as mockedRealpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { provisionWorkspace } from "../src/index.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: vi.fn(actual.realpath),
  };
});

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.mocked(mockedRealpath).mockReset();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("canonical unmanaged workspace paths", () => {
  it("recovers stored case when realpath preserves caller casing", async () => {
    const fixtureRoot = await makeTempDir("bb-canonical-case-");
    const storedPath = path.join(
      fixtureRoot,
      "ProjectDirectory",
      "WorkspaceRoot",
    );
    await fs.mkdir(storedPath, { recursive: true });
    const expectedPath = await fs.realpath(storedPath);
    vi.mocked(mockedRealpath).mockResolvedValue(
      expectedPath
        .replace("ProjectDirectory", "projectdirectory")
        .replace("WorkspaceRoot", "workspaceroot"),
    );

    const workspace = await provisionWorkspace({
      workspaceProvisionType: "unmanaged",
      path: storedPath,
    });

    expect(workspace.path).toBe(expectedPath);
    await expect(fs.stat(workspace.path)).resolves.toBeDefined();
  });

  it("recovers stored Unicode normalization when realpath preserves caller spelling", async () => {
    const fixtureRoot = await makeTempDir("bb-canonical-unicode-");
    const storedPath = path.join(fixtureRoot, "Caf\u00e9Workspace");
    await fs.mkdir(storedPath);
    const expectedPath = await fs.realpath(storedPath);
    const storedName = path.basename(expectedPath);
    const alternateName =
      storedName.normalize("NFC") === storedName
        ? storedName.normalize("NFD")
        : storedName.normalize("NFC");
    expect(alternateName).not.toBe(storedName);
    vi.mocked(mockedRealpath).mockResolvedValue(
      path.join(path.dirname(expectedPath), alternateName),
    );

    const workspace = await provisionWorkspace({
      workspaceProvisionType: "unmanaged",
      path: storedPath,
    });

    expect(workspace.path).toBe(expectedPath);
    await expect(fs.stat(workspace.path)).resolves.toBeDefined();
  });

  it("reports path_not_found when the resolved directory disappears", async () => {
    const fixtureRoot = await makeTempDir("bb-canonical-disappeared-");
    const workspacePath = path.join(fixtureRoot, "WorkspaceRoot");
    await fs.mkdir(workspacePath);
    vi.mocked(mockedRealpath).mockImplementation(async () => {
      const resolvedPath = await fs.realpath(workspacePath);
      await fs.rm(workspacePath, { recursive: true });
      return resolvedPath;
    });

    await expect(
      provisionWorkspace({
        workspaceProvisionType: "unmanaged",
        path: workspacePath,
      }),
    ).rejects.toHaveProperty("code", "path_not_found");
  });
});
