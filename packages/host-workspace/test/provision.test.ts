import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { provisionWorkspace } from "../src/index.js";
import { listBranches, runGit } from "../src/git.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), prefix)),
  );
  tempDirs.push(dir);
  return dir;
}

async function initRepo(): Promise<string> {
  const repoPath = await makeTempDir("bb-provision-repo-");
  await runGit(["init", "-b", "main"], { cwd: repoPath });
  await runGit(["config", "user.name", "BB Tests"], { cwd: repoPath });
  await runGit(["config", "user.email", "bb@example.com"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "hello\n", "utf8");
  await runGit(["add", "."], { cwd: repoPath });
  await runGit(["commit", "-m", "Initial commit"], { cwd: repoPath });
  return repoPath;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("provisionWorkspace", () => {
  describe("unmanaged", () => {
    it("returns one canonical path for symlink and alternate spellings", async () => {
      const repoPath = await initRepo();
      const canonicalRepoPath = await fs.realpath(repoPath);
      const aliasParent = await makeTempDir("bb-provision-alias-parent-");
      const aliasPath = path.join(aliasParent, "repo-alias");
      await fs.symlink(repoPath, aliasPath, "dir");

      const [targetWorkspace, aliasWorkspace, alternateWorkspace] =
        await Promise.all([
          provisionWorkspace({
            path: repoPath,
          }),
          provisionWorkspace({
            path: aliasPath,
          }),
          provisionWorkspace({
            path: `${repoPath}${path.sep}.`,
          }),
        ]);

      expect(targetWorkspace.path).toBe(canonicalRepoPath);
      expect(aliasWorkspace.path).toBe(canonicalRepoPath);
      expect(alternateWorkspace.path).toBe(canonicalRepoPath);
    });

    it("uses directory-entry spelling for case-insensitive path aliases", async () => {
      const fixtureRoot = await makeTempDir("bb-provision-case-alias-");
      const actualParentPath = path.join(fixtureRoot, "ProjectDirectory");
      const actualWorkspacePath = path.join(actualParentPath, "WorkspaceRoot");
      const aliasWorkspacePath = path.join(
        fixtureRoot,
        "projectdirectory",
        "workspaceroot",
      );
      await fs.mkdir(actualWorkspacePath, { recursive: true });

      try {
        await fs.stat(aliasWorkspacePath);
      } catch {
        return;
      }

      const aliasWorkspace = await provisionWorkspace({
        path: aliasWorkspacePath,
      });
      const canonicalFixtureRoot = await fs.realpath(fixtureRoot);
      const [storedParentName] = await fs.readdir(canonicalFixtureRoot);
      if (storedParentName === undefined) {
        throw new Error("Expected case-alias fixture parent");
      }
      const [storedWorkspaceName] = await fs.readdir(
        path.join(canonicalFixtureRoot, storedParentName),
      );
      if (storedWorkspaceName === undefined) {
        throw new Error("Expected case-alias workspace");
      }

      expect(aliasWorkspace.path).toBe(
        path.join(canonicalFixtureRoot, storedParentName, storedWorkspaceName),
      );
      await expect(fs.stat(aliasWorkspace.path)).resolves.toBeDefined();
    });

    it("uses directory-entry spelling for Unicode-normalized path aliases", async () => {
      const fixtureRoot = await makeTempDir("bb-provision-unicode-alias-");
      const composedName = "Caf\u00e9Workspace";
      const decomposedName = "Cafe\u0301Workspace";
      const actualWorkspacePath = path.join(fixtureRoot, composedName);
      const aliasWorkspacePath = path.join(fixtureRoot, decomposedName);
      await fs.mkdir(actualWorkspacePath);

      try {
        await fs.stat(aliasWorkspacePath);
      } catch {
        return;
      }

      const aliasWorkspace = await provisionWorkspace({
        path: aliasWorkspacePath,
      });
      const canonicalFixtureRoot = await fs.realpath(fixtureRoot);
      const [storedWorkspaceName] = await fs.readdir(canonicalFixtureRoot);
      if (storedWorkspaceName === undefined) {
        throw new Error("Expected Unicode-alias workspace");
      }

      expect(aliasWorkspace.path).toBe(
        path.join(canonicalFixtureRoot, storedWorkspaceName),
      );
      await expect(fs.stat(aliasWorkspace.path)).resolves.toBeDefined();
    });

    it("keeps case-distinct directories independent on case-sensitive filesystems", async () => {
      const fixtureRoot = await makeTempDir("bb-provision-case-distinct-");
      const upperPath = path.join(fixtureRoot, "WorkspaceRoot");
      const lowerPath = path.join(fixtureRoot, "workspaceroot");
      await fs.mkdir(upperPath);
      try {
        await fs.mkdir(lowerPath);
      } catch {
        return;
      }

      const [upperWorkspace, lowerWorkspace] = await Promise.all([
        provisionWorkspace({
          path: upperPath,
        }),
        provisionWorkspace({
          path: lowerPath,
        }),
      ]);

      expect(upperWorkspace.path).not.toBe(lowerWorkspace.path);
    });

    it("reports a broken symlink as a missing unmanaged workspace", async () => {
      const fixtureRoot = await makeTempDir("bb-provision-broken-alias-");
      const brokenAliasPath = path.join(fixtureRoot, "broken-workspace");
      await fs.symlink(
        path.join(fixtureRoot, "missing-target"),
        brokenAliasPath,
      );

      await expect(
        provisionWorkspace({
          path: brokenAliasPath,
        }),
      ).rejects.toHaveProperty("code", "path_not_found");
    });

    it("canonicalizes an accessible workspace below an execute-only ancestor", async () => {
      if (process.platform === "win32") {
        return;
      }
      const fixtureRoot = await makeTempDir("bb-provision-search-only-");
      const restrictedAncestor = path.join(fixtureRoot, "SearchOnlyParent");
      const workspacePath = path.join(restrictedAncestor, "WorkspaceRoot");
      await fs.mkdir(workspacePath, { recursive: true });
      const expectedPath = await fs.realpath(workspacePath);
      await fs.chmod(restrictedAncestor, 0o111);

      try {
        let readdirDenied = false;
        try {
          await fs.readdir(restrictedAncestor);
        } catch (error) {
          readdirDenied =
            error instanceof Error &&
            "code" in error &&
            (error.code === "EACCES" || error.code === "EPERM");
        }
        if (!readdirDenied) {
          return;
        }

        const workspace = await provisionWorkspace({
          path: workspacePath,
        });

        expect(workspace.path).toBe(expectedPath);
        await expect(fs.stat(workspace.path)).resolves.toBeDefined();
      } finally {
        await fs.chmod(restrictedAncestor, 0o700);
      }
    });

    it("provisions an unmanaged git repo and discovers properties", async () => {
      const repoPath = await initRepo();
      const canonicalRepoPath = await fs.realpath(repoPath);

      const ws = await provisionWorkspace({
        path: repoPath,
      });

      expect(ws.path).toBe(canonicalRepoPath);
      expect(ws.isGitRepo).toBe(true);
      expect(ws.isWorktree).toBe(false);
      expect(await ws.getCurrentBranch()).toBe("main");
    });

    it("provisions an unmanaged non-git directory", async () => {
      const dirPath = await makeTempDir("bb-provision-nongit-");

      const ws = await provisionWorkspace({
        path: dirPath,
      });

      expect(ws.isGitRepo).toBe(false);
      expect(ws.isWorktree).toBe(false);
    });

    it("detects a worktree as isWorktree=true", async () => {
      const repoPath = await initRepo();
      const parentDir = await makeTempDir("bb-provision-wt-parent-");
      const wtPath = path.join(parentDir, "wt");
      await runGit(["worktree", "add", "-B", "feature", wtPath], {
        cwd: repoPath,
      });

      const ws = await provisionWorkspace({
        path: wtPath,
      });

      expect(ws.isGitRepo).toBe(true);
      expect(ws.isWorktree).toBe(true);
    });

    it("resolves external git metadata roots for unmanaged worktrees", async () => {
      const repoPath = await initRepo();
      const parentDir = await makeTempDir("bb-provision-unmanaged-wt-roots-");
      const wtPath = path.join(parentDir, "wt");
      await runGit(["worktree", "add", "-B", "feature", wtPath], {
        cwd: repoPath,
      });
      const ws = await provisionWorkspace({
        path: wtPath,
      });
      const gitDir = (
        await runGit(["rev-parse", "--absolute-git-dir"], { cwd: ws.path })
      ).stdout.trim();
      const commonGitDir = path.resolve(
        ws.path,
        (
          await runGit(["rev-parse", "--git-common-dir"], { cwd: ws.path })
        ).stdout.trim(),
      );

      await expect(ws.getAdditionalWorkspaceWriteRoots()).resolves.toEqual([
        path.resolve(gitDir),
        path.join(commonGitDir, "objects"),
        path.join(commonGitDir, "refs"),
        path.join(commonGitDir, "logs"),
      ]);
    });

    it("throws for non-existent path", async () => {
      await expect(
        provisionWorkspace({
          path: "/tmp/does-not-exist-bb",
        }),
      ).rejects.toThrow(/does not exist/u);
    });
  });

  describe("HostWorkspace git operations", () => {
    it("delegates git operations to the underlying Workspace", async () => {
      const repoPath = await initRepo();
      const ws = await provisionWorkspace({
        path: repoPath,
      });

      const status = await ws.getStatus();
      expect(status.workingTree.state).toBe("clean");

      await fs.writeFile(path.join(repoPath, "new.txt"), "data\n", "utf8");
      const result = await ws.commit({
        message: "Test commit",
        noVerify: false,
      });
      expect(result.commitSha).toBeTruthy();

      const branches = await listBranches(ws.path);
      expect(branches).toContain("main");

      const diff = await ws.getDiff();
      expect(typeof diff.diff).toBe("string");
    });
  });
});
