import { execFile } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ProvisioningTranscriptEntry, WorkspaceStatus } from "@bb/domain";
import { pathExists } from "@bb/process-utils";
import type {
  CommitOptions,
  CommitResult,
  DiffOptions,
  DiffResult,
  DiffFilesArgs,
  DiffFilesResult,
  DiffPatchArgs,
  DiffPatchEntry,
  PullRequestActionOptions,
  StatusOptions,
} from "./workspace.js";
import { Workspace } from "./workspace.js";
import type {
  GitHostCliOptions,
  GitHostPullRequestLookup,
} from "./git-host.js";
import {
  detectGitRepo,
  detectLinkedWorktree,
  readDefaultBranch,
  WorkspaceError,
  type GitProcessOptions,
} from "./git.js";
import { resolveAdditionalWorkspaceWriteRoots } from "./workspace-write-roots.js";

type ProvisionProgressCallback = (entry: ProvisioningTranscriptEntry) => void;

function createProvisionCancelledError(cause?: unknown): WorkspaceError {
  return new WorkspaceError(
    "provision_cancelled",
    "Workspace provisioning was cancelled",
    { cause },
  );
}

export function throwIfProvisionAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createProvisionCancelledError(signal.reason);
  }
}

interface ProvisionBase {
  onProgress?: ProvisionProgressCallback;
  shellPath?: string;
  signal?: AbortSignal;
}

interface UnmanagedWorkspaceOpts extends ProvisionBase {
  path: string;
}

export type ProvisionWorkspaceArgs = UnmanagedWorkspaceOpts;

const WORKSPACE_BRANCH_GIT_TIMEOUT_MS = 15_000;
const execFileAsync = promisify(execFile);

export interface HostWorkspace {
  readonly path: string;
  readonly isGitRepo: boolean;
  readonly isWorktree: boolean;

  getDefaultBranch(): Promise<string | null>;
  getCurrentBranch(): Promise<string | null>;
  getHeadSha(): Promise<string | null>;
  getLocalStateFingerprint(): Promise<string>;
  getSharedGitRefsFingerprint(): Promise<string>;
  getAdditionalWorkspaceWriteRoots(): Promise<string[]>;
  getStatus(options?: StatusOptions): Promise<WorkspaceStatus>;
  getDiff(options?: DiffOptions): Promise<DiffResult>;
  diffFiles(args: DiffFilesArgs): Promise<DiffFilesResult>;
  diffPatch(args: DiffPatchArgs): Promise<DiffPatchEntry[]>;
  getPullRequest(
    options?: GitHostCliOptions,
  ): Promise<GitHostPullRequestLookup>;
  runPullRequestAction(
    action: PullRequestActionOptions,
    options?: GitHostCliOptions,
  ): Promise<void>;

  commit(options: CommitOptions): Promise<CommitResult>;
}

class ProvisionedHostWorkspace implements HostWorkspace {
  readonly path: string;
  readonly isGitRepo: boolean;
  readonly isWorktree: boolean;

  private readonly ws: Workspace;
  private readonly gitProcessOptions: GitProcessOptions;

  constructor(opts: {
    path: string;
    isGitRepo: boolean;
    isWorktree: boolean;
    shellPath?: string;
  }) {
    this.path = opts.path;
    this.isGitRepo = opts.isGitRepo;
    this.isWorktree = opts.isWorktree;
    this.gitProcessOptions = {
      ...(opts.shellPath !== undefined ? { shellPath: opts.shellPath } : {}),
    };
    this.ws = new Workspace(opts.path, this.gitProcessOptions);
  }

  async getCurrentBranch(): Promise<string | null> {
    return (await this.ws.currentBranch) ?? null;
  }

  async getDefaultBranch(): Promise<string | null> {
    if (!this.isGitRepo) {
      return null;
    }
    return (
      (await readDefaultBranch(this.path, {
        timeoutMs: WORKSPACE_BRANCH_GIT_TIMEOUT_MS,
        ...this.gitProcessOptions,
      })) ?? null
    );
  }

  getHeadSha(): Promise<string | null> {
    return this.ws.getHeadSha();
  }

  getLocalStateFingerprint(): Promise<string> {
    return this.ws.getLocalStateFingerprint();
  }

  getSharedGitRefsFingerprint(): Promise<string> {
    return this.ws.getSharedGitRefsFingerprint();
  }

  getAdditionalWorkspaceWriteRoots(): Promise<string[]> {
    if (!this.isGitRepo || !this.isWorktree) {
      return Promise.resolve([]);
    }
    return resolveAdditionalWorkspaceWriteRoots(
      this.path,
      this.gitProcessOptions,
    );
  }

  getStatus(options?: StatusOptions): Promise<WorkspaceStatus> {
    return this.ws.getStatus(options);
  }

  getDiff(options?: DiffOptions): Promise<DiffResult> {
    return this.ws.getDiff(options);
  }

  diffFiles(args: DiffFilesArgs): Promise<DiffFilesResult> {
    return this.ws.diffFiles(args);
  }

  diffPatch(args: DiffPatchArgs): Promise<DiffPatchEntry[]> {
    return this.ws.diffPatch(args);
  }

  getPullRequest(
    options?: GitHostCliOptions,
  ): Promise<GitHostPullRequestLookup> {
    return this.ws.getPullRequest(options);
  }

  runPullRequestAction(
    action: PullRequestActionOptions,
    options?: GitHostCliOptions,
  ): Promise<void> {
    return this.ws.runPullRequestAction(action, options);
  }

  commit(options: CommitOptions): Promise<CommitResult> {
    return this.ws.commit(options);
  }
}

function normalizedDirectoryEntryName(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

async function findStoredDirectoryEntryName(
  parentPath: string,
  resolvedName: string,
): Promise<string> {
  const entries = await readdir(parentPath);
  const exactEntry = entries.find((entry) => entry === resolvedName);
  if (exactEntry !== undefined) {
    return exactEntry;
  }

  const normalizedName = normalizedDirectoryEntryName(resolvedName);
  const equivalentEntries = entries.filter(
    (entry) => normalizedDirectoryEntryName(entry) === normalizedName,
  );
  if (equivalentEntries.length === 1 && equivalentEntries[0] !== undefined) {
    return equivalentEntries[0];
  }

  const resolvedStats = await lstat(path.join(parentPath, resolvedName), {
    bigint: true,
  });
  for (const entry of entries) {
    const entryStats = await lstat(path.join(parentPath, entry), {
      bigint: true,
    });
    if (
      entryStats.dev === resolvedStats.dev &&
      entryStats.ino === resolvedStats.ino
    ) {
      return entry;
    }
  }

  throw new WorkspaceError(
    "path_not_found",
    `Resolved workspace path component no longer exists: ${path.join(parentPath, resolvedName)}`,
  );
}

function hasFilesystemErrorCode(
  error: unknown,
  codes: readonly string[],
): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

async function canonicalizeFromWorkspaceCwd(
  resolvedPath: string,
): Promise<string> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--eval",
      'process.stdout.write(require("node:fs").realpathSync.native("."))',
    ],
    {
      cwd: resolvedPath,
      encoding: "utf8",
      timeout: WORKSPACE_BRANCH_GIT_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (!path.isAbsolute(stdout)) {
    throw new WorkspaceError(
      "canonical_path_unavailable",
      `Host returned a non-absolute canonical workspace path: ${stdout}`,
    );
  }

  const [resolvedStats, canonicalStats] = await Promise.all([
    lstat(resolvedPath, { bigint: true }),
    lstat(stdout, { bigint: true }),
  ]);
  if (
    resolvedStats.dev !== canonicalStats.dev ||
    resolvedStats.ino !== canonicalStats.ino
  ) {
    throw new WorkspaceError(
      "canonical_path_unavailable",
      `Host canonical workspace path resolved to a different directory: ${stdout}`,
    );
  }
  return stdout;
}

export async function canonicalizeUnmanagedWorkspacePath(
  existingPath: string,
): Promise<string> {
  try {
    const resolvedPath = await realpath(existingPath);
    const parsedPath = path.parse(resolvedPath);
    const rootPath =
      process.platform === "win32"
        ? parsedPath.root.normalize("NFC").toLowerCase()
        : parsedPath.root;
    const relativePath = path.relative(parsedPath.root, resolvedPath);
    if (relativePath === "") {
      return rootPath;
    }

    try {
      let canonicalPath = rootPath;
      for (const resolvedName of relativePath.split(path.sep)) {
        const storedName = await findStoredDirectoryEntryName(
          canonicalPath,
          resolvedName,
        );
        canonicalPath = path.join(canonicalPath, storedName);
      }
      return canonicalPath;
    } catch (error) {
      if (hasFilesystemErrorCode(error, ["EACCES", "EPERM"])) {
        return canonicalizeFromWorkspaceCwd(resolvedPath);
      }
      throw error;
    }
  } catch (error) {
    if (hasFilesystemErrorCode(error, ["ENOENT"])) {
      throw new WorkspaceError(
        "path_not_found",
        `Unmanaged workspace path does not exist: ${existingPath}`,
        { cause: error },
      );
    }
    throw error;
  }
}

export function provisionWorkspace(
  opts: ProvisionWorkspaceArgs,
): Promise<HostWorkspace> {
  return provisionUnmanaged(opts);
}

async function provisionUnmanaged(
  opts: UnmanagedWorkspaceOpts,
): Promise<HostWorkspace> {
  throwIfProvisionAborted(opts.signal);
  if (!(await pathExists(opts.path))) {
    throw new WorkspaceError(
      "path_not_found",
      `Unmanaged workspace path does not exist: ${opts.path}`,
    );
  }
  const canonicalPath = await canonicalizeUnmanagedWorkspacePath(opts.path);
  const isGitRepo = await detectGitRepo(canonicalPath, {
    ...(opts.shellPath !== undefined ? { shellPath: opts.shellPath } : {}),
  });
  const gitProcessOptions =
    opts.shellPath === undefined ? {} : { shellPath: opts.shellPath };
  const isWorktree = isGitRepo
    ? await detectLinkedWorktree(canonicalPath, gitProcessOptions)
    : false;

  return new ProvisionedHostWorkspace({
    path: canonicalPath,
    isGitRepo,
    isWorktree,
    shellPath: opts.shellPath,
  });
}
