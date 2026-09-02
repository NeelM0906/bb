import { execFile } from "node:child_process";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const SYNC_INTERVAL_MS = 5 * 60_000;
const SYNC_RETRY_BASE_MS = 30_000;
const ISSUE_PAGE = 100;
const CLOSED_ISSUE_PAGE = 50;
const PR_PAGE = 50;
const CLOSED_PR_PAGE = 30;

const GH_HINT =
  "Install the GitHub CLI (https://cli.github.com) and run `gh auth login`, " +
  "then `bb plugin reload github`.";

const repoNameSchema = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
const itemNumberSchema = z.number().int().positive();
const itemInputSchema = z
  .object({ repo: repoNameSchema, number: itemNumberSchema })
  .strict();
const nonBlankStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be blank");
const repoInfoSchema = z
  .object({ repo: repoNameSchema, projectId: z.string().nullable() })
  .strict();
const itemSchema = z
  .object({
    repo: repoNameSchema,
    number: itemNumberSchema,
    kind: z.enum(["issue", "pr"]),
    title: z.string(),
    state: z.string(),
    author: z.string(),
    labels: z.array(z.string()),
    assignees: z.array(z.string()),
    url: z.string(),
    body: z.string(),
    updatedAt: z.string(),
  })
  .strict();
const syncResultSchema = z
  .object({
    repos: z.number().int().nonnegative(),
    items: z.number().int().nonnegative(),
  })
  .strict();
const okResultSchema = z.object({ ok: z.literal(true) }).strict();
const commentSchema = z
  .object({ author: z.string(), body: z.string(), createdAt: z.string() })
  .strict();
const threadLinkSchema = z
  .object({
    kind: z.enum(["issue", "pr"]),
    repo: repoNameSchema,
    number: itemNumberSchema,
    threadId: z.string().min(1),
    createdAt: z.string(),
  })
  .strict();
const pullSchema = z
  .object({
    repo: repoNameSchema,
    number: itemNumberSchema,
    title: z.string(),
    state: z.string(),
    author: z.string(),
    body: z.string(),
    url: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    baseRefName: z.string(),
    headRefName: z.string(),
    additions: z.number().nonnegative(),
    deletions: z.number().nonnegative(),
    changedFiles: z.number().int().nonnegative(),
    labels: z.array(z.string()),
    assignees: z.array(z.string()),
    reviewDecision: z.string(),
    mergeStateStatus: z.string(),
    reviewRequests: z.array(z.string()),
    checks: z.array(
      z
        .object({
          name: z.string(),
          status: z.enum(["success", "failure", "pending", "neutral"]),
          url: z.string(),
        })
        .strict(),
    ),
    comments: z.array(commentSchema),
    reviews: z.array(
      z
        .object({
          author: z.string(),
          state: z.string(),
          body: z.string(),
          createdAt: z.string(),
        })
        .strict(),
    ),
    reviewThreads: z.array(
      z
        .object({
          path: z.string(),
          line: z.number().int().nonnegative().nullable(),
          diffHunk: z.string(),
          comments: z.array(commentSchema),
        })
        .strict(),
    ),
    files: z.array(
      z
        .object({
          path: z.string(),
          status: z.string(),
          additions: z.number().nonnegative(),
          deletions: z.number().nonnegative(),
          patch: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const githubRpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z
      .object({
        ghOk: z.boolean(),
        ghState: z.enum(["ready", "needs_configuration", "unavailable"]),
        ghError: z.string().nullable(),
        repos: z.array(repoInfoSchema),
        lastSyncedAt: z.string().nullable(),
      })
      .strict(),
  },
  refresh: { input: z.null(), output: syncResultSchema },
  listItems: {
    input: z
      .object({
        kind: z.enum(["issue", "pr"]).optional(),
        repo: repoNameSchema.optional(),
        query: z.string().optional(),
        state: z.enum(["open", "closed"]).optional(),
        mine: z.boolean().optional(),
      })
      .strict(),
    output: z.object({ items: z.array(itemSchema) }).strict(),
  },
  viewer: {
    input: z.null(),
    output: z.object({ login: z.string().min(1) }).strict(),
  },
  assignableUsers: {
    input: z.object({ repo: repoNameSchema }).strict(),
    output: z.object({ users: z.array(z.string().min(1)) }).strict(),
  },
  repositoryLabels: {
    input: z.object({ repo: repoNameSchema }).strict(),
    output: z.object({ labels: z.array(z.string().min(1)) }).strict(),
  },
  setIssueState: {
    input: itemInputSchema
      .extend({ state: z.enum(["open", "closed"]) })
      .strict(),
    output: okResultSchema,
  },
  setAssignees: {
    input: itemInputSchema
      .extend({ assignees: z.array(z.string().min(1)) })
      .strict(),
    output: z
      .object({ ok: z.literal(true), assignees: z.array(z.string().min(1)) })
      .strict(),
  },
  setLabels: {
    input: itemInputSchema.extend({ labels: z.array(z.string()) }).strict(),
    output: z
      .object({ ok: z.literal(true), labels: z.array(z.string().min(1)) })
      .strict(),
  },
  getIssue: {
    input: itemInputSchema,
    output: z
      .object({
        issue: z
          .object({
            repo: repoNameSchema,
            number: itemNumberSchema,
            title: z.string(),
            state: z.string(),
            author: z.string(),
            body: z.string(),
            labels: z.array(z.string()),
            assignees: z.array(z.string()),
            url: z.string(),
            updatedAt: z.string(),
            comments: z.array(commentSchema),
          })
          .strict(),
      })
      .strict(),
  },
  getPull: {
    input: itemInputSchema,
    output: z.object({ pull: pullSchema }).strict(),
  },
  commentPull: {
    input: itemInputSchema.extend({ body: nonBlankStringSchema }).strict(),
    output: okResultSchema,
  },
  pullForThread: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z
      .object({
        pull: z
          .object({
            repo: repoNameSchema,
            number: itemNumberSchema,
            environmentId: z.string().nullable(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  },
  commentIssue: {
    input: itemInputSchema.extend({ body: nonBlankStringSchema }).strict(),
    output: okResultSchema,
  },
  createIssue: {
    input: z
      .object({
        repo: repoNameSchema,
        title: nonBlankStringSchema,
        body: z.string().optional(),
      })
      .strict(),
    output: z
      .object({ number: itemNumberSchema.nullable(), url: z.string() })
      .strict(),
  },
  startWork: {
    input: itemInputSchema,
    output: z.object({ threadId: z.string().min(1) }).strict(),
  },
  startReview: {
    input: itemInputSchema,
    output: z.object({ threadId: z.string().min(1) }).strict(),
  },
  listLinks: {
    input: z.null(),
    output: z
      .object({ links: z.record(z.string(), z.array(threadLinkSchema)) })
      .strict(),
  },
});

type RepoInfo = z.infer<typeof repoInfoSchema>;
type CachedItem = z.infer<typeof itemSchema>;

interface GhListEntry {
  number?: unknown;
  title?: unknown;
  state?: unknown;
  author?: { login?: unknown };
  labels?: Array<{ name?: unknown }>;
  assignees?: Array<{ login?: unknown }>;
  url?: unknown;
  body?: unknown;
  updatedAt?: unknown;
}

type GhRunner = (args: string[]) => Promise<string>;

interface ThreadLink {
  kind: "issue" | "pr";
  repo: string;
  number: number;
  threadId: string;
  createdAt: string;
}

interface BbProjectSummary {
  id: string;
  sources?: Array<{ type: string; path: string }>;
}

interface SpawnedThreadSummary {
  id: string;
}

function needsConfiguration(message: string): Error {
  return Object.assign(new Error(message), {
    name: "NeedsConfigurationError",
  });
}

function isNeedsConfigurationError(error: unknown): error is Error {
  return error instanceof Error && error.name === "NeedsConfigurationError";
}

function ghUnavailable(message: string): Error {
  return Object.assign(new Error(message), { name: "GhUnavailableError" });
}

function isGhUnavailableError(error: unknown): error is Error {
  return error instanceof Error && error.name === "GhUnavailableError";
}

const GH_NO_CREDENTIALS = /no oauth token|not logged in/i;
const GH_HOST = "github.com";

function parseGithubRemote(url: string): string | null {
  const match = url
    .trim()
    .match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  if (match === null) return null;
  return `${match[1]}/${match[2]}`;
}

function isRepoName(value: unknown): value is string {
  return typeof value === "string" && /^[\w.-]+\/[\w.-]+$/.test(value);
}

function repoKey(repo: string): string {
  return repo.toLowerCase();
}

export function isAuthoritativeMissingOrigin(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not a git repository|no such remote ['"]?origin/i.test(message);
}

/** Comma- or whitespace-separated owner/repo tokens, first occurrence wins. */
export function parseRepoList(raw: string): string[] {
  return parseRepoListWithInvalid(raw).repos;
}

export function parseRepoListWithInvalid(raw: string): {
  repos: string[];
  invalid: string[];
} {
  const repos: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const token of raw.split(/[\s,]+/)) {
    if (token === "") continue;
    if (!isRepoName(token)) {
      if (!invalid.includes(token)) invalid.push(token);
      continue;
    }
    const key = repoKey(token);
    if (seen.has(key)) continue;
    seen.add(key);
    repos.push(token);
  }
  return { repos, invalid };
}

export function describeInvalidRepoEntries(
  setting: string,
  invalid: string[],
): string {
  return (
    `ignoring ${invalid.length} ${setting} ${invalid.length === 1 ? "entry" : "entries"} ` +
    `that ${invalid.length === 1 ? "is" : "are"} not "owner/repo": ${invalid.join(", ")}`
  );
}

const AUTO_TRACK_PERMISSIONS = new Set([
  "TRIAGE",
  "WRITE",
  "MAINTAIN",
  "ADMIN",
]);

export type RepoAccess = "granted" | "denied" | "unknown";

/** True when GitHub granted more than public-read access. */
export function canAutoTrackPermission(permission: string | null): boolean {
  if (permission === null) return false;
  return AUTO_TRACK_PERMISSIONS.has(permission.toUpperCase());
}

export function repoAccessFromCheck(
  permission: string | null,
  checkFailed: boolean,
): RepoAccess {
  if (checkFailed) return "unknown";
  return canAutoTrackPermission(permission) ? "granted" : "denied";
}

export function selectTrackedRepos(args: {
  projectRepos: RepoInfo[];
  extraRepos: string[];
  ignoredRepos: string[];
  trackProjectRemotes: boolean;
  accessByRepo: ReadonlyMap<string, RepoAccess>;
  previouslyAutoTracked: readonly string[];
}): RepoInfo[] {
  const ignored = new Set(args.ignoredRepos.map(repoKey));
  const previous = new Set(args.previouslyAutoTracked.map(repoKey));
  const accessByRepo = new Map(
    [...args.accessByRepo].map(([repo, access]) => [repoKey(repo), access]),
  );
  const projectByRepo = new Map<string, RepoInfo>();
  for (const info of args.projectRepos) {
    const key = repoKey(info.repo);
    if (!projectByRepo.has(key)) projectByRepo.set(key, info);
  }
  const byRepo = new Map<string, RepoInfo>();

  if (args.trackProjectRemotes) {
    for (const info of args.projectRepos) {
      const key = repoKey(info.repo);
      if (ignored.has(key) || byRepo.has(key)) continue;
      const access = accessByRepo.get(key) ?? "unknown";
      const include =
        access === "granted" || (access === "unknown" && previous.has(key));
      if (include) byRepo.set(key, info);
    }
  }

  for (const repo of args.extraRepos) {
    const key = repoKey(repo);
    if (ignored.has(key) || byRepo.has(key)) continue;
    byRepo.set(key, projectByRepo.get(key) ?? { repo, projectId: null });
  }

  return [...byRepo.values()];
}

export function projectReposForTracking(args: {
  discoveredRepos: RepoInfo[];
  discoveryComplete: boolean;
  previouslyAutoTracked: readonly string[];
}): RepoInfo[] {
  if (args.discoveryComplete) return args.discoveredRepos;
  return selectTrackedRepos({
    projectRepos: args.discoveredRepos,
    extraRepos: [...args.previouslyAutoTracked],
    ignoredRepos: [],
    trackProjectRemotes: true,
    accessByRepo: new Map(),
    previouslyAutoTracked: args.previouslyAutoTracked,
  });
}

export function nextAutoTrackedRepos(args: {
  projectRepos: readonly string[];
  ignoredRepos: readonly string[];
  accessByRepo: ReadonlyMap<string, RepoAccess>;
  previouslyAutoTracked: readonly string[];
}): string[] {
  const ignored = new Set(args.ignoredRepos.map(repoKey));
  const project = new Map<string, string>();
  for (const repo of args.projectRepos) {
    const key = repoKey(repo);
    if (!project.has(key)) project.set(key, repo);
  }
  const accessByRepo = new Map(
    [...args.accessByRepo].map(([repo, access]) => [repoKey(repo), access]),
  );
  const next = new Map<string, string>();
  for (const repo of args.previouslyAutoTracked) {
    const key = repoKey(repo);
    const projectRepo = project.get(key);
    if (projectRepo === undefined || ignored.has(key)) continue;
    if ((accessByRepo.get(key) ?? "unknown") !== "denied") {
      next.set(key, projectRepo);
    }
  }
  for (const [repo, access] of args.accessByRepo) {
    const key = repoKey(repo);
    const projectRepo = project.get(key);
    if (projectRepo === undefined || ignored.has(key)) continue;
    if (access === "granted") next.set(key, projectRepo);
    if (access === "denied") next.delete(key);
  }
  return [...next.values()];
}

function run(
  file: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${file} ${args.slice(0, 3).join(" ")} failed: ${
                stderr.trim() || error.message
              }`,
            ),
          );
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

export function parsePaginatedGhApi(raw: string): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("GitHub API pagination returned a non-array response");
  }
  const rows: Record<string, unknown>[] = [];
  for (const page of parsed) {
    if (!Array.isArray(page)) {
      throw new Error("GitHub API pagination returned a malformed page");
    }
    for (const row of page) {
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new Error("GitHub API pagination returned a malformed row");
      }
      rows.push(row as Record<string, unknown>);
    }
  }
  return rows;
}

export function validateGithubCliArgs(argv: string[]): string | null {
  const [sub, arg, ...rest] = argv;
  if (rest.length > 0) return `Unexpected argument "${rest[0]}".`;
  if (sub === undefined) return null;
  if (sub === "help" || sub === "--help") {
    return arg === undefined ? null : `Unexpected argument "${arg}".`;
  }
  if (sub === "repos" || sub === "sync") {
    return arg === undefined
      ? null
      : `Subcommand "${sub}" does not accept arguments.`;
  }
  if ((sub === "issues" || sub === "prs") && arg !== undefined) {
    return isRepoName(arg)
      ? null
      : `Invalid repository "${arg}"; expected owner/repo.`;
  }
  return null;
}

function toItems(
  raw: string,
  repo: string,
  kind: "issue" | "pr",
): CachedItem[] {
  const entries = JSON.parse(raw) as GhListEntry[];
  return entries
    .filter(
      (entry): entry is GhListEntry & { number: number } =>
        typeof entry?.number === "number",
    )
    .map((entry) => ({
      repo,
      number: entry.number,
      kind,
      title: String(entry.title ?? ""),
      state: String(entry.state ?? "OPEN"),
      author: String(entry.author?.login ?? ""),
      labels: (entry.labels ?? []).map((label) => String(label?.name ?? "")),
      assignees: (entry.assignees ?? []).map((user) =>
        String(user?.login ?? ""),
      ),
      url: String(entry.url ?? ""),
      body: typeof entry.body === "string" ? entry.body : "",
      updatedAt: String(entry.updatedAt ?? ""),
    }));
}

export async function fetchRepoItems(
  gh: GhRunner,
  repo: string,
): Promise<CachedItem[]> {
  const fields =
    "number,title,state,author,labels,assignees,url,body,updatedAt";
  const ghIssuesTolerant = (args: string[]) =>
    gh(args).catch((error: unknown) => {
      if (String(error).toLowerCase().includes("disabled issues")) return "[]";
      throw error;
    });
  const [openIssues, closedIssues, openPrs, closedPrs] = await Promise.all([
    ghIssuesTolerant([
      "issue",
      "list",
      "-R",
      repo,
      "--state",
      "open",
      "--limit",
      String(ISSUE_PAGE),
      "--json",
      fields,
    ]),
    ghIssuesTolerant([
      "issue",
      "list",
      "-R",
      repo,
      "--state",
      "closed",
      "--limit",
      String(CLOSED_ISSUE_PAGE),
      "--json",
      fields,
    ]),
    gh([
      "pr",
      "list",
      "-R",
      repo,
      "--state",
      "open",
      "--limit",
      String(PR_PAGE),
      "--json",
      fields,
    ]),
    gh([
      "pr",
      "list",
      "-R",
      repo,
      "--state",
      "closed",
      "--limit",
      String(CLOSED_PR_PAGE),
      "--json",
      fields,
    ]),
  ]);
  return [
    ...toItems(openIssues, repo, "issue"),
    ...toItems(closedIssues, repo, "issue"),
    ...toItems(openPrs, repo, "pr"),
    ...toItems(closedPrs, repo, "pr"),
  ];
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    extraRepos: {
      type: "string",
      label: "Shared repositories",
      description:
        'Comma-separated "owner/repo" list you explicitly want to follow. These are tracked even without write access.',
      experimental_schema: z.string().superRefine((value, context) => {
        const { invalid } = parseRepoListWithInvalid(value);
        if (invalid.length > 0) {
          context.addIssue({
            code: "custom",
            message: `Use "owner/repo" for every entry. Invalid: ${invalid.join(", ")}`,
          });
        }
      }),
      default: "",
    },
    ignoredRepos: {
      type: "string",
      label: "Ignored repositories",
      description:
        'Comma-separated "owner/repo" list that must never be tracked, including read-only remotes such as an upstream clone.',
      default: "",
    },
    trackProjectRemotes: {
      type: "boolean",
      label: "Follow BB project remotes",
      description:
        "When enabled, also track each project's origin remote — but only if GitHub granted you more than public-read access. Upstream remotes are never followed.",
      default: true,
    },
    defaultProject: {
      type: "project",
      label: "Default BB project",
      description:
        "Where agent threads spawn for repos that are not attached to a BB project.",
    },
  });

  let ghPath: string | null = null;
  type GhState = "ready" | "needs_configuration" | "unavailable";
  let ghState: GhState = "unavailable";
  let ghAuthError: string | null = "checking gh…";

  async function resolveGh(): Promise<string> {
    if (ghPath !== null) return ghPath;
    const candidates = ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"];
    for (const candidate of candidates) {
      try {
        await run(candidate, ["--version"], 5_000);
        ghPath = candidate;
        return candidate;
      } catch {}
    }
    throw needsConfiguration(`GitHub CLI not found. ${GH_HINT}`);
  }

  async function gh(args: string[], timeoutMs?: number): Promise<string> {
    const file = await resolveGh();
    const { stdout } = await run(file, args, timeoutMs);
    return stdout;
  }

  async function probeAuth(): Promise<void> {
    try {
      await gh(["auth", "status", "--hostname", GH_HOST, "--active"], 10_000);
      ghState = "ready";
      ghAuthError = null;
      return;
    } catch (error) {
      ghAuthError = error instanceof Error ? error.message : String(error);
      if (isNeedsConfigurationError(error)) {
        ghState = "needs_configuration";
        throw error;
      }
    }
    let hasCredentials = true;
    try {
      await gh(["auth", "token", "--hostname", GH_HOST], 5_000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      hasCredentials = !GH_NO_CREDENTIALS.test(message);
    }
    if (!hasCredentials) {
      ghState = "needs_configuration";
      throw needsConfiguration(`GitHub CLI is not authenticated. ${GH_HINT}`);
    }
    ghState = "unavailable";
    throw ghUnavailable(
      `gh auth status failed; gh has credentials, so this is probably transient and will be retried: ${ghAuthError}`,
    );
  }

  let authProbe: Promise<void> | null = null;
  function checkAuth(): Promise<void> {
    if (authProbe === null) {
      authProbe = probeAuth().finally(() => {
        authProbe = null;
      });
    }
    return authProbe;
  }

  // ------------------------------------------------------------------
  // Repo discovery: shared extraRepos, plus project `origin` remotes the
  // viewer can write to. Never follow `upstream` or ignoredRepos.
  // ------------------------------------------------------------------
  interface RepoDiscoveryResult {
    repos: RepoInfo[];
    projectDiscoveryComplete: boolean;
  }

  let repoCache: (RepoDiscoveryResult & { fetchedAt: number }) | null = null;
  let invalidExtraRepos: string[] = [];
  let lastInvalidExtraReposKey: string | null = null;

  async function listProjectOriginRepos(): Promise<RepoDiscoveryResult> {
    const byRepo = new Map<string, RepoInfo>();
    let projectDiscoveryComplete = true;
    try {
      const projects =
        (await bb.sdk.projects.list()) as unknown as BbProjectSummary[];
      for (const project of projects) {
        for (const source of project.sources ?? []) {
          if (source.type !== "local_path") continue;
          try {
            const { stdout } = await run(
              "git",
              ["-C", source.path, "remote", "get-url", "origin"],
              5_000,
            );
            const repo = parseGithubRemote(stdout);
            if (repo !== null && !byRepo.has(repoKey(repo))) {
              byRepo.set(repoKey(repo), { repo, projectId: project.id });
            }
          } catch (error) {
            if (!isAuthoritativeMissingOrigin(error)) {
              projectDiscoveryComplete = false;
              bb.log.warn(
                `origin discovery failed for ${source.path}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        }
      }
      return { repos: [...byRepo.values()], projectDiscoveryComplete };
    } catch (error) {
      bb.log.warn(
        `project discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { repos: [...byRepo.values()], projectDiscoveryComplete: false };
    }
  }

  async function repoAccess(repo: string): Promise<RepoAccess> {
    try {
      const raw = await gh(
        ["repo", "view", repo, "--json", "viewerPermission"],
        15_000,
      );
      const permission = (JSON.parse(raw) as { viewerPermission?: unknown })
        .viewerPermission;
      return repoAccessFromCheck(
        typeof permission === "string" ? permission : null,
        false,
      );
    } catch (error) {
      bb.log.warn(
        `permission check failed for ${repo}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return "unknown";
    }
  }

  async function discoverReposWithStatus(
    force = false,
  ): Promise<RepoDiscoveryResult> {
    if (!force && repoCache !== null && Date.now() - repoCache.fetchedAt < 60_000) {
      return repoCache;
    }
    const { extraRepos, ignoredRepos, trackProjectRemotes } = await settings.get();
    const parsedExtra = parseRepoListWithInvalid(extraRepos);
    const extra = parsedExtra.repos;
    const ignored = parseRepoList(ignoredRepos);
    const invalidKey = parsedExtra.invalid.join(",");
    if (invalidKey !== lastInvalidExtraReposKey) {
      lastInvalidExtraReposKey = invalidKey;
      if (parsedExtra.invalid.length > 0) {
        bb.log.warn(describeInvalidRepoEntries("extraRepos", parsedExtra.invalid));
      }
    }
    invalidExtraRepos = parsedExtra.invalid;
    const previouslyAutoTracked =
      (await bb.storage.kv.get<string[]>("auto-tracked-repos")) ?? [];
    const projectDiscovery = await listProjectOriginRepos();
    const projectRepos = projectReposForTracking({
      discoveredRepos: projectDiscovery.repos,
      discoveryComplete: projectDiscovery.projectDiscoveryComplete,
      previouslyAutoTracked,
    });
    const accessByRepo = new Map<string, RepoAccess>();
    if (trackProjectRemotes && projectDiscovery.projectDiscoveryComplete) {
      const ignoredKeys = new Set(ignored.map(repoKey));
      const candidates = projectRepos.filter(
        (info) => !ignoredKeys.has(repoKey(info.repo)),
      );
      const results = await Promise.all(
        candidates.map(async (info) => ({
          repo: info.repo,
          access: await repoAccess(info.repo),
        })),
      );
      for (const { repo, access } of results) accessByRepo.set(repo, access);
    }
    const repos = selectTrackedRepos({
      projectRepos,
      extraRepos: extra,
      ignoredRepos: ignored,
      trackProjectRemotes,
      accessByRepo,
      previouslyAutoTracked,
    });
    if (projectDiscovery.projectDiscoveryComplete) {
      await bb.storage.kv.set(
        "auto-tracked-repos",
        nextAutoTrackedRepos({
          projectRepos: projectRepos.map((info) => info.repo),
          ignoredRepos: ignored,
          accessByRepo,
          previouslyAutoTracked,
        }),
      );
    }
    repoCache = {
      repos,
      projectDiscoveryComplete: projectDiscovery.projectDiscoveryComplete,
      fetchedAt: Date.now(),
    };
    return repoCache;
  }

  async function discoverRepos(force = false): Promise<RepoInfo[]> {
    return (await discoverReposWithStatus(force)).repos;
  }

  settings.onChange(() => {
    repoCache = null;
  });

  // ------------------------------------------------------------------
  // SQLite cache of open issues + PRs across tracked repos.
  // ------------------------------------------------------------------
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS items (
       repo TEXT NOT NULL,
       number INTEGER NOT NULL,
       kind TEXT NOT NULL,
       title TEXT NOT NULL,
       state TEXT NOT NULL,
       author TEXT NOT NULL,
       labels TEXT NOT NULL,
       url TEXT NOT NULL,
       body TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       PRIMARY KEY (repo, kind, number)
     )`,
    `ALTER TABLE items ADD COLUMN assignees TEXT NOT NULL DEFAULT '[]'`,
  ]);

  function parseStringArray(raw: unknown): string[] {
    try {
      const parsed = JSON.parse(String(raw));
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {}
    return [];
  }

  function rowToItem(row: Record<string, unknown>): CachedItem {
    return {
      repo: String(row.repo),
      number: Number(row.number),
      kind: row.kind === "pr" ? "pr" : "issue",
      title: String(row.title),
      state: String(row.state),
      author: String(row.author),
      labels: parseStringArray(row.labels),
      assignees: parseStringArray(row.assignees),
      url: String(row.url),
      body: String(row.body),
      updatedAt: String(row.updated_at),
    };
  }

  function listCachedItems(options: {
    kind?: "issue" | "pr";
    repo?: string;
    query?: string;
    state?: "open" | "closed";
    assignee?: string;
    /** When set, hide rows from repos that are no longer tracked. */
    trackedRepos?: readonly string[];
  }): CachedItem[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.kind !== undefined) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    if (options.repo !== undefined) {
      clauses.push("LOWER(repo) = ?");
      params.push(repoKey(options.repo));
    } else if (options.trackedRepos !== undefined) {
      if (options.trackedRepos.length === 0) return [];
      clauses.push(
        `LOWER(repo) IN (${options.trackedRepos.map(() => "?").join(", ")})`,
      );
      params.push(...options.trackedRepos.map(repoKey));
    }
    if (options.state === "open") {
      clauses.push("state = 'OPEN'");
    } else if (options.state === "closed") {
      clauses.push("state != 'OPEN'");
    }
    if (options.assignee !== undefined) {
      clauses.push("assignees LIKE ?");
      params.push(`%${JSON.stringify(options.assignee)}%`);
    }
    const query = options.query?.trim() ?? "";
    if (query.length > 0) {
      clauses.push(
        "(title LIKE ? OR CAST(number AS TEXT) LIKE ? OR repo LIKE ?)",
      );
      const like = `%${query.replace(/^#/, "")}%`;
      params.push(like, like, like);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db
      .prepare(`SELECT * FROM items ${where} ORDER BY updated_at DESC`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(rowToItem);
  }

  function getCachedItem(
    kind: "issue" | "pr",
    repo: string,
    number: number,
  ): CachedItem | null {
    const row = db
      .prepare("SELECT * FROM items WHERE LOWER(repo) = ? AND kind = ? AND number = ?")
      .get(repoKey(repo), kind, number) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToItem(row);
  }

  function replaceRepoRows(repo: string, items: CachedItem[]): void {
    const insert = db.prepare(
      `INSERT INTO items (repo, number, kind, title, state, author, labels, assignees, url, body, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.transaction(() => {
      db.prepare("DELETE FROM items WHERE LOWER(repo) = ?").run(repoKey(repo));
      for (const item of items) {
        insert.run(
          item.repo,
          item.number,
          item.kind,
          item.title,
          item.state,
          item.author,
          JSON.stringify(item.labels),
          JSON.stringify(item.assignees),
          item.url,
          item.body,
          item.updatedAt,
        );
      }
    })();
  }

  function dropUntrackedRepoRows(trackedRepos: readonly string[]): void {
    if (trackedRepos.length === 0) {
      db.prepare("DELETE FROM items").run();
      return;
    }
    db.prepare(
      `DELETE FROM items WHERE LOWER(repo) NOT IN (${trackedRepos.map(() => "?").join(", ")})`,
    ).run(...trackedRepos.map(repoKey));
  }

  /** Patch a cached row in place after a mutation so the UI updates without
      waiting for the next full sync. */
  function patchCachedItem(
    kind: "issue" | "pr",
    repo: string,
    number: number,
    patch: { state?: string; assignees?: string[]; labels?: string[] },
  ): void {
    if (patch.state !== undefined) {
      db.prepare("UPDATE items SET state = ? WHERE LOWER(repo) = ? AND kind = ? AND number = ?")
        .run(patch.state, repoKey(repo), kind, number);
    }
    if (patch.assignees !== undefined) {
      db.prepare("UPDATE items SET assignees = ? WHERE LOWER(repo) = ? AND kind = ? AND number = ?")
        .run(JSON.stringify(patch.assignees), repoKey(repo), kind, number);
    }
    if (patch.labels !== undefined) {
      db.prepare("UPDATE items SET labels = ? WHERE LOWER(repo) = ? AND kind = ? AND number = ?")
        .run(JSON.stringify(patch.labels), repoKey(repo), kind, number);
    }
    bb.realtime.publish("data-changed", {});
  }

  async function syncAll(
    force = false,
  ): Promise<{ repos: number; items: number }> {
    await checkAuth();
    const discovery = await discoverReposWithStatus(force);
    const repos = discovery.repos;
    const before = JSON.stringify(
      db
        .prepare(
          "SELECT repo, kind, number, updated_at FROM items ORDER BY repo, kind, number",
        )
        .all(),
    );
    let total = 0;
    let failed = 0;
    let lastFailure = "";
    for (const { repo } of repos) {
      try {
        const items = await fetchRepoItems(gh, repo);
        replaceRepoRows(repo, items);
        total += items.length;
      } catch (error) {
        failed += 1;
        lastFailure = error instanceof Error ? error.message : String(error);
        bb.log.warn(`sync failed for ${repo}: ${lastFailure}`);
      }
    }
    if (repos.length > 0 && failed === repos.length) {
      throw ghUnavailable(
        `sync failed for all ${repos.length} repo(s); last error: ${lastFailure}`,
      );
    }
    if (discovery.projectDiscoveryComplete) {
      dropUntrackedRepoRows(repos.map((entry) => entry.repo));
    }
    const after = JSON.stringify(
      db
        .prepare(
          "SELECT repo, kind, number, updated_at FROM items ORDER BY repo, kind, number",
        )
        .all(),
    );
    await bb.storage.kv.set("sync-cursor", {
      lastSyncedAt: new Date().toISOString(),
      repos: repos.length,
      items: total,
    });
    if (before !== after) {
      bb.realtime.publish("data-changed", { items: total });
    }
    bb.log.info(`synced ${total} item(s) across ${repos.length} repo(s)`);
    return { repos: repos.length, items: total };
  }

  bb.background.service("sync", {
    async start(signal) {
      let failures = 0;
      while (!signal.aborted) {
        let delayMs = SYNC_INTERVAL_MS;
        try {
          await syncAll();
          failures = 0;
        } catch (error) {
          if (!isGhUnavailableError(error)) throw error;
          failures += 1;
          delayMs = Math.min(
            SYNC_RETRY_BASE_MS * 2 ** (failures - 1),
            SYNC_INTERVAL_MS,
          );
          bb.log.warn(
            `sync failed (retry in ${Math.round(delayMs / 1000)}s): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        if (signal.aborted) break;
        await new Promise<void>((resolve) => {
          const onAbort = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          }, delayMs);
          signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    },
  });

  try {
    await checkAuth();
  } catch (error) {
    if (isNeedsConfigurationError(error)) {
      bb.status.needsConfiguration(error.message);
    } else if (isGhUnavailableError(error)) {
      bb.log.warn(error.message);
    } else {
      throw error;
    }
  }

  function linkKey(kind: "issue" | "pr", repo: string, number: number): string {
    return `link:${kind}:${repoKey(repo)}#${number}`;
  }

  async function addLink(link: ThreadLink): Promise<void> {
    const key = linkKey(link.kind, link.repo, link.number);
    const existing = (await bb.storage.kv.get<ThreadLink[]>(key)) ?? [];
    await bb.storage.kv.set(key, [...existing, link]);
    bb.realtime.publish("links-changed", { key });
  }

  async function listAllLinks(): Promise<Record<string, ThreadLink[]>> {
    const keys = await bb.storage.kv.list("link:");
    const result: Record<string, ThreadLink[]> = {};
    for (const key of keys) {
      const links = await bb.storage.kv.get<ThreadLink[]>(key);
      if (links !== undefined && links.length > 0) {
        const unprefixed = key.slice("link:".length);
        const parsed = /^(issue|pr):([\w.-]+\/[\w.-]+)#(\d+)$/.exec(unprefixed);
        const normalizedKey =
          parsed === null
            ? unprefixed
            : `${parsed[1]}:${repoKey(parsed[2])}#${parsed[3]}`;
        const existing = result[normalizedKey] ?? [];
        result[normalizedKey] = [
          ...existing,
          ...links.filter(
            (link) => !existing.some((item) => item.threadId === link.threadId),
          ),
        ];
      }
    }
    return result;
  }

  async function resolveProjectId(repo: string): Promise<string> {
    const repos = await discoverRepos();
    const info = repos.find((entry) => repoKey(entry.repo) === repoKey(repo));
    if (info?.projectId != null) return info.projectId;
    const { defaultProject } = await settings.get();
    if (defaultProject) return defaultProject;
    throw new Error(
      `No BB project is attached to ${repo}. Create a project whose checkout has ` +
        "that origin remote, or set the defaultProject plugin setting.",
    );
  }

  async function spawnOnItem(
    kind: "issue" | "pr",
    repo: string,
    number: number,
  ): Promise<{ threadId: string }> {
    const item = getCachedItem(kind, repo, number);
    const title = item?.title ?? `${kind === "pr" ? "PR" : "issue"} #${number}`;
    const projectId = await resolveProjectId(repo);
    const ref = `${repo}#${number}`;
    const prompt =
      kind === "issue"
        ? [
            `Work on GitHub issue ${ref}: ${title}`,
            "",
            "Read the full issue and its comments first:",
            `  gh issue view ${number} -R ${repo} --comments`,
            "",
            item !== null && item.body.length > 0
              ? `Issue description:\n\n${item.body}`
              : "(no cached description — read it with the command above)",
            "",
            "Implement a fix or the requested change in this checkout. " +
              `If you open a pull request, include "Fixes #${number}" in its body.`,
          ].join("\n")
        : [
            `Review GitHub pull request ${ref}: ${title}`,
            "",
            "Read the PR and its diff:",
            `  gh pr view ${number} -R ${repo} --comments`,
            `  gh pr diff ${number} -R ${repo}`,
            "",
            "Review the change for correctness, missing tests, and design issues. " +
              "Summarize your findings with file/line references. Do not push " +
              "changes or post to GitHub unless asked.",
          ].join("\n");
    const thread = (await bb.sdk.threads.spawn({
      projectId,
      environment: { type: "project-default" },
      title: `${ref}: ${title}`.slice(0, 120),
      prompt,
    })) as unknown as SpawnedThreadSummary;
    await addLink({
      kind,
      repo,
      number,
      threadId: thread.id,
      createdAt: new Date().toISOString(),
    });
    bb.log.info(`spawned thread ${thread.id} for ${kind} ${ref}`);
    return { threadId: thread.id };
  }

  let viewerCache: { login: string; fetchedAt: number } | null = null;

  async function getViewer(): Promise<string> {
    if (
      viewerCache !== null &&
      Date.now() - viewerCache.fetchedAt < 60 * 60_000
    ) {
      return viewerCache.login;
    }
    const raw = await gh(["api", "user"], 15_000);
    const login = String((JSON.parse(raw) as { login?: unknown })?.login ?? "");
    if (login.length === 0)
      throw new Error("could not resolve the gh viewer login");
    viewerCache = { login, fetchedAt: Date.now() };
    return login;
  }

  const assignableCache = new Map<
    string,
    { users: string[]; fetchedAt: number }
  >();
  const labelsCache = new Map<
    string,
    { labels: string[]; fetchedAt: number }
  >();

  async function getAssignableUsers(repo: string): Promise<string[]> {
    const key = repoKey(repo);
    const cached = assignableCache.get(key);
    if (cached !== undefined && Date.now() - cached.fetchedAt < 10 * 60_000) {
      return cached.users;
    }
    const raw = await gh(
      ["api", `repos/${repo}/assignees?per_page=100`],
      15_000,
    );
    const entries = JSON.parse(raw) as Array<{ login?: unknown }>;
    const users = entries
      .map((entry) => String(entry?.login ?? ""))
      .filter((login) => login.length > 0)
      .sort((a, b) => a.localeCompare(b));
    assignableCache.set(key, { users, fetchedAt: Date.now() });
    return users;
  }

  async function getRepoLabels(repo: string): Promise<string[]> {
    const key = repoKey(repo);
    const cached = labelsCache.get(key);
    if (cached !== undefined && Date.now() - cached.fetchedAt < 10 * 60_000) {
      return cached.labels;
    }
    const raw = await gh(["api", `repos/${repo}/labels?per_page=100`], 15_000);
    const entries = JSON.parse(raw) as Array<{ name?: unknown }>;
    const labels = entries
      .map((entry) => String(entry?.name ?? "").trim())
      .filter((name) => name.length > 0)
      .sort((a, b) => a.localeCompare(b));
    labelsCache.set(key, { labels, fetchedAt: Date.now() });
    return labels;
  }

  bb.rpc.register(githubRpcContract, {
    async status() {
      if (ghState !== "ready") {
        try {
          await checkAuth();
        } catch {}
      }
      const cursor = await bb.storage.kv.get<{
        lastSyncedAt: string;
        repos: number;
        items: number;
      }>("sync-cursor");
      const repos = await discoverRepos();
      return {
        ghOk: ghState === "ready",
        ghState,
        ghError: ghAuthError,
        repos,
        lastSyncedAt: cursor?.lastSyncedAt ?? null,
      };
    },

    async refresh() {
      return await syncAll(true);
    },

    async listItems(input) {
      const trackedRepos = (await discoverRepos()).map((entry) => entry.repo);
      return {
        items: listCachedItems({
          kind: input.kind,
          repo: input.repo,
          query: input.query,
          state: input.state,
          assignee: input.mine === true ? await getViewer() : undefined,
          trackedRepos: input.repo === undefined ? trackedRepos : undefined,
        }),
      };
    },

    async viewer() {
      return { login: await getViewer() };
    },

    async assignableUsers(input) {
      return { users: await getAssignableUsers(input.repo) };
    },

    async repositoryLabels(input) {
      return { labels: await getRepoLabels(input.repo) };
    },

    async setIssueState({ repo, number, state }): Promise<{ ok: true }> {
      await gh([
        "issue",
        state === "closed" ? "close" : "reopen",
        String(number),
        "-R",
        repo,
      ]);
      patchCachedItem("issue", repo, number, {
        state: state === "closed" ? "CLOSED" : "OPEN",
      });
      return { ok: true };
    },

    async setAssignees({
      repo,
      number,
      assignees,
    }): Promise<{ ok: true; assignees: string[] }> {
      const next = [...new Set(assignees)];
      const current = getCachedItem("issue", repo, number)?.assignees ?? [];
      const add = next.filter((login) => !current.includes(login));
      const remove = current.filter((login) => !next.includes(login));
      if (add.length === 0 && remove.length === 0)
        return { ok: true, assignees: next };
      const args = ["issue", "edit", String(number), "-R", repo];
      if (add.length > 0) args.push("--add-assignee", add.join(","));
      if (remove.length > 0) args.push("--remove-assignee", remove.join(","));
      await gh(args);
      patchCachedItem("issue", repo, number, { assignees: next });
      return { ok: true, assignees: next };
    },

    async setLabels({
      repo,
      number,
      labels,
    }): Promise<{ ok: true; labels: string[] }> {
      const next = [
        ...new Set(labels.map((label) => label.trim()).filter(Boolean)),
      ];
      const currentRaw = await gh(
        ["issue", "view", String(number), "-R", repo, "--json", "labels"],
        15_000,
      );
      const currentDetail = JSON.parse(currentRaw) as {
        labels?: Array<{ name?: unknown }>;
      };
      const current = (currentDetail.labels ?? [])
        .map((label) => String(label?.name ?? "").trim())
        .filter((label) => label.length > 0);
      const add = next.filter((label) => !current.includes(label));
      const remove = current.filter((label) => !next.includes(label));
      if (add.length === 0 && remove.length === 0)
        return { ok: true, labels: next };
      const args = ["issue", "edit", String(number), "-R", repo];
      for (const label of add) args.push("--add-label", label);
      for (const label of remove) args.push("--remove-label", label);
      await gh(args);
      patchCachedItem("issue", repo, number, { labels: next });
      return { ok: true, labels: next };
    },

    async getIssue({ repo, number }) {
      const raw = await gh([
        "issue",
        "view",
        String(number),
        "-R",
        repo,
        "--json",
        "number,title,body,state,author,createdAt,updatedAt,labels,assignees,url,comments",
      ]);
      const detail = JSON.parse(raw) as {
        comments?: Array<{
          author?: { login?: unknown };
          body?: unknown;
          createdAt?: unknown;
        }>;
      } & GhListEntry;
      return {
        issue: {
          repo,
          number,
          title: String(detail.title ?? ""),
          state: String(detail.state ?? ""),
          author: String(detail.author?.login ?? ""),
          body: typeof detail.body === "string" ? detail.body : "",
          labels: (detail.labels ?? []).map((label) =>
            String(label?.name ?? ""),
          ),
          assignees: (detail.assignees ?? []).map((user) =>
            String(user?.login ?? ""),
          ),
          url: String(detail.url ?? ""),
          updatedAt: String(detail.updatedAt ?? ""),
          comments: (detail.comments ?? []).map((comment) => ({
            author: String(comment.author?.login ?? ""),
            body: typeof comment.body === "string" ? comment.body : "",
            createdAt: String(comment.createdAt ?? ""),
          })),
        },
      };
    },

    async getPull({ repo, number }) {
      const prFields =
        "number,title,body,state,isDraft,author,createdAt,updatedAt,labels," +
        "assignees,url,baseRefName,headRefName,additions,deletions," +
        "changedFiles,reviewDecision,mergeStateStatus,statusCheckRollup," +
        "comments,reviews,reviewRequests";
      const [viewRaw, reviewCommentsRaw, filesRaw] = await Promise.all([
        gh(
          ["pr", "view", String(number), "-R", repo, "--json", prFields],
          30_000,
        ),
        gh(
          [
            "api",
            "--paginate",
            "--slurp",
            `repos/${repo}/pulls/${number}/comments?per_page=100`,
          ],
          30_000,
        ),
        gh(
          [
            "api",
            "--paginate",
            "--slurp",
            `repos/${repo}/pulls/${number}/files?per_page=100`,
          ],
          30_000,
        ),
      ]);

      interface GhPullView extends GhListEntry {
        isDraft?: unknown;
        createdAt?: unknown;
        baseRefName?: unknown;
        headRefName?: unknown;
        additions?: unknown;
        deletions?: unknown;
        changedFiles?: unknown;
        reviewDecision?: unknown;
        mergeStateStatus?: unknown;
        statusCheckRollup?: Array<{
          __typename?: unknown;
          name?: unknown;
          context?: unknown;
          status?: unknown;
          conclusion?: unknown;
          state?: unknown;
          detailsUrl?: unknown;
          targetUrl?: unknown;
        }>;
        comments?: Array<{
          author?: { login?: unknown };
          body?: unknown;
          createdAt?: unknown;
        }>;
        reviews?: Array<{
          author?: { login?: unknown };
          state?: unknown;
          body?: unknown;
          submittedAt?: unknown;
        }>;
        reviewRequests?: Array<{
          login?: unknown;
          name?: unknown;
          slug?: unknown;
        }>;
      }
      const view = JSON.parse(viewRaw) as GhPullView;

      const checks = (view.statusCheckRollup ?? []).map((entry) => {
        const conclusion = String(
          entry.conclusion ?? entry.state ?? "",
        ).toUpperCase();
        const running =
          entry.conclusion === "" ||
          ["IN_PROGRESS", "QUEUED", "PENDING", "EXPECTED", "WAITING"].includes(
            String(entry.status ?? entry.state ?? "").toUpperCase(),
          );
        const status: "success" | "failure" | "pending" | "neutral" =
          conclusion === "SUCCESS"
            ? "success"
            : conclusion === "FAILURE" ||
                conclusion === "ERROR" ||
                conclusion === "TIMED_OUT"
              ? "failure"
              : running
                ? "pending"
                : "neutral";
        return {
          name: String(entry.name ?? entry.context ?? "check"),
          status,
          url: String(entry.detailsUrl ?? entry.targetUrl ?? ""),
        };
      });

      interface GhReviewComment {
        id?: unknown;
        in_reply_to_id?: unknown;
        path?: unknown;
        line?: unknown;
        original_line?: unknown;
        diff_hunk?: unknown;
        body?: unknown;
        created_at?: unknown;
        user?: { login?: unknown };
      }
      const reviewComments = parsePaginatedGhApi(
        reviewCommentsRaw,
      ) as GhReviewComment[];
      interface ReviewThread {
        path: string;
        line: number | null;
        diffHunk: string;
        comments: Array<{ author: string; body: string; createdAt: string }>;
      }
      const threadByRootId = new Map<number, ReviewThread>();
      for (const comment of reviewComments) {
        const id = Number(comment.id ?? NaN);
        const replyTo = Number(comment.in_reply_to_id ?? NaN);
        const entry = {
          author: String(comment.user?.login ?? ""),
          body: typeof comment.body === "string" ? comment.body : "",
          createdAt: String(comment.created_at ?? ""),
        };
        const rootThread = Number.isFinite(replyTo)
          ? threadByRootId.get(replyTo)
          : undefined;
        if (rootThread !== undefined) {
          rootThread.comments.push(entry);
          if (Number.isFinite(id)) threadByRootId.set(id, rootThread);
          continue;
        }
        const line = Number(comment.line ?? comment.original_line ?? NaN);
        const thread: ReviewThread = {
          path: String(comment.path ?? ""),
          line: Number.isFinite(line) ? line : null,
          diffHunk:
            typeof comment.diff_hunk === "string" ? comment.diff_hunk : "",
          comments: [entry],
        };
        if (Number.isFinite(id)) threadByRootId.set(id, thread);
      }
      const reviewThreads = [...new Set(threadByRootId.values())];

      interface GhPullFile {
        filename?: unknown;
        status?: unknown;
        additions?: unknown;
        deletions?: unknown;
        patch?: unknown;
      }
      const files = (parsePaginatedGhApi(filesRaw) as GhPullFile[]).map(
        (file) => {
          const patch = typeof file.patch === "string" ? file.patch : null;
          return {
            path: String(file.filename ?? ""),
            status: String(file.status ?? "modified"),
            additions: Number(file.additions ?? 0),
            deletions: Number(file.deletions ?? 0),
            patch: patch !== null && patch.length <= 20_000 ? patch : null,
          };
        },
      );

      return {
        pull: {
          repo,
          number,
          title: String(view.title ?? ""),
          state:
            view.isDraft === true && String(view.state ?? "") === "OPEN"
              ? "DRAFT"
              : String(view.state ?? ""),
          author: String(view.author?.login ?? ""),
          body: typeof view.body === "string" ? view.body : "",
          url: String(view.url ?? ""),
          createdAt: String(view.createdAt ?? ""),
          updatedAt: String(view.updatedAt ?? ""),
          baseRefName: String(view.baseRefName ?? ""),
          headRefName: String(view.headRefName ?? ""),
          additions: Number(view.additions ?? 0),
          deletions: Number(view.deletions ?? 0),
          changedFiles: Number(view.changedFiles ?? files.length),
          labels: (view.labels ?? []).map((label) => String(label?.name ?? "")),
          assignees: (view.assignees ?? []).map((user) =>
            String(user?.login ?? ""),
          ),
          reviewDecision: String(view.reviewDecision ?? ""),
          mergeStateStatus: String(view.mergeStateStatus ?? ""),
          reviewRequests: (view.reviewRequests ?? [])
            .map((entry) =>
              String(entry.login ?? entry.name ?? entry.slug ?? ""),
            )
            .filter((name) => name.length > 0),
          checks,
          comments: (view.comments ?? []).map((comment) => ({
            author: String(comment.author?.login ?? ""),
            body: typeof comment.body === "string" ? comment.body : "",
            createdAt: String(comment.createdAt ?? ""),
          })),
          reviews: (view.reviews ?? []).map((review) => ({
            author: String(review.author?.login ?? ""),
            state: String(review.state ?? ""),
            body: typeof review.body === "string" ? review.body : "",
            createdAt: String(review.submittedAt ?? ""),
          })),
          reviewThreads,
          files,
        },
      };
    },

    async commentPull({ repo, number, body }): Promise<{ ok: true }> {
      await gh(["pr", "comment", String(number), "-R", repo, "--body", body]);
      return { ok: true };
    },

    async pullForThread({ threadId }) {
      let environmentId: string | null = null;
      try {
        const thread = (await bb.sdk.threads.get({ threadId })) as unknown as {
          environmentId?: string | null;
        };
        if (thread?.environmentId) {
          environmentId = thread.environmentId;
          const result = await bb.sdk.environments.pullRequest({
            environmentId: thread.environmentId,
          });
          const url =
            result.outcome === "available" ? result.pullRequest.url : null;
          const match =
            typeof url === "string"
              ? url.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/)
              : null;
          if (match !== null) {
            return {
              pull: {
                repo: match[1],
                number: Number(match[2]),
                environmentId,
              },
            };
          }
        }
      } catch {}
      const links = await listAllLinks();
      for (const [key, threadLinks] of Object.entries(links)) {
        const match = key.match(/^pr:([\w.-]+\/[\w.-]+)#(\d+)$/);
        if (match === null) continue;
        if (threadLinks.some((link) => link.threadId === threadId)) {
          return {
            pull: {
              repo: match[1],
              number: Number(match[2]),
              environmentId,
            },
          };
        }
      }
      return { pull: null };
    },

    async commentIssue({ repo, number, body }): Promise<{ ok: true }> {
      await gh([
        "issue",
        "comment",
        String(number),
        "-R",
        repo,
        "--body",
        body,
      ]);
      return { ok: true };
    },

    async createIssue(input) {
      const body = input.body ?? "";
      const stdout = await gh([
        "issue",
        "create",
        "-R",
        input.repo,
        "--title",
        input.title,
        "--body",
        body,
      ]);
      const match = stdout.trim().match(/\/issues\/(\d+)\s*$/);
      const number = match !== null ? Number(match[1]) : null;
      try {
        replaceRepoRows(input.repo, await fetchRepoItems(gh, input.repo));
        bb.realtime.publish("data-changed", {});
      } catch {}
      return { number, url: stdout.trim() };
    },

    async startWork({ repo, number }) {
      return await spawnOnItem("issue", repo, number);
    },

    async startReview({ repo, number }) {
      return await spawnOnItem("pr", repo, number);
    },

    async listLinks() {
      return { links: await listAllLinks() };
    },
  });

  // ------------------------------------------------------------------
  // Mentions: issues and PRs attach their details as agent context.
  // Search reads the cache (2s time box); resolve prefers a live gh view
  // and falls back to the cache so a network blip doesn't block the send.
  // ------------------------------------------------------------------
  async function mentionItems(kind: "issue" | "pr", query: string) {
    const trackedRepos = (await discoverRepos()).map((entry) => entry.repo);
    return listCachedItems({ kind, query, state: "open", trackedRepos })
      .slice(0, 8)
      .map((item) => ({
        id: `${item.repo}#${item.number}`,
        title: `#${item.number} ${item.title}`,
        subtitle: item.repo,
      }));
  }

  function parseMentionId(itemId: string): { repo: string; number: number } {
    const match = itemId.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
    if (match === null) throw new Error(`malformed mention id "${itemId}"`);
    return { repo: match[1], number: Number(match[2]) };
  }

  async function mentionContext(
    kind: "issue" | "pr",
    itemId: string,
  ): Promise<{ context: string }> {
    const { repo, number } = parseMentionId(itemId);
    const noun = kind === "pr" ? "pull request" : "issue";
    try {
      const raw = await gh(
        kind === "pr"
          ? [
              "pr",
              "view",
              String(number),
              "-R",
              repo,
              "--json",
              "number,title,body,state,author,url",
            ]
          : [
              "issue",
              "view",
              String(number),
              "-R",
              repo,
              "--json",
              "number,title,body,state,author,url",
            ],
        15_000,
      );
      const detail = JSON.parse(raw) as GhListEntry;
      return {
        context: [
          `# GitHub ${noun} ${repo}#${number}: ${String(detail.title ?? "")}`,
          "",
          `State: ${String(detail.state ?? "")} · Author: ${String(detail.author?.login ?? "")}`,
          `URL: ${String(detail.url ?? "")}`,
          "",
          typeof detail.body === "string" && detail.body.length > 0
            ? detail.body
            : "(no description)",
          "",
          `For full comments/diff run: gh ${kind === "pr" ? "pr" : "issue"} view ${number} -R ${repo} --comments`,
        ].join("\n"),
      };
    } catch (error) {
      const cached = getCachedItem(kind, repo, number);
      if (cached === null)
        throw error instanceof Error ? error : new Error(String(error));
      return {
        context: [
          `# GitHub ${noun} ${repo}#${number}: ${cached.title}`,
          "",
          `State: ${cached.state} · Author: ${cached.author}`,
          `URL: ${cached.url}`,
          "",
          cached.body.length > 0 ? cached.body : "(no description)",
        ].join("\n"),
      };
    }
  }

  bb.ui.registerMentionProvider({
    id: "issue",
    label: "GitHub issues",
    triggers: ["@", "#"],
    search({ query }) {
      return mentionItems("issue", query);
    },
    resolve(itemId) {
      return mentionContext("issue", itemId);
    },
  });

  bb.ui.registerMentionProvider({
    id: "pr",
    label: "GitHub pull requests",
    triggers: ["@", "#"],
    search({ query }) {
      return mentionItems("pr", query);
    },
    resolve(itemId) {
      return mentionContext("pr", itemId);
    },
  });

  const USAGE = [
    "Usage:",
    "  bb github repos              List tracked repositories",
    "  bb github issues [repo]      List cached open issues",
    "  bb github prs [repo]         List cached open pull requests",
    "  bb github sync               Refresh the cache from GitHub now",
  ].join("\n");

  bb.cli.register({
    name: "github",
    summary: "Browse tracked GitHub repos, issues, and PRs",
    commands: [
      {
        name: "repos",
        summary: "List tracked repositories",
        usage: "bb github repos",
      },
      {
        name: "issues",
        summary: "List cached open issues",
        usage: "bb github issues [owner/repo]",
      },
      {
        name: "prs",
        summary: "List cached open pull requests",
        usage: "bb github prs [owner/repo]",
      },
      {
        name: "sync",
        summary: "Refresh the cache from GitHub now",
        usage: "bb github sync",
      },
    ],
    async run(argv) {
      const [sub, arg] = argv;
      try {
        const validationError = validateGithubCliArgs(argv);
        if (validationError !== null) {
          return { exitCode: 1, stderr: `${validationError}\n${USAGE}` };
        }
        if (sub === undefined || sub === "help" || sub === "--help") {
          return { exitCode: 0, stdout: USAGE };
        }
        if (sub === "repos") {
          const repos = await discoverRepos(true);
          const warning =
            invalidExtraRepos.length > 0
              ? {
                  stderr: `${describeInvalidRepoEntries("extraRepos", invalidExtraRepos)}\n`,
                }
              : {};
          if (repos.length === 0) {
            return {
              exitCode: 0,
              stdout:
                "No tracked repos. Share owner/repo values via extraRepos, or enable Follow BB project remotes for origins you can write to.",
              ...warning,
            };
          }
          return {
            exitCode: 0,
            stdout: repos
              .map(
                (entry) =>
                  `${entry.repo}${entry.projectId !== null ? `\t(${entry.projectId})` : ""}`,
              )
              .join("\n"),
            ...warning,
          };
        }
        if (sub === "issues" || sub === "prs") {
          const trackedRepos = (await discoverRepos()).map((entry) => entry.repo);
          const items = listCachedItems({
            kind: sub === "prs" ? "pr" : "issue",
            repo: isRepoName(arg) ? arg : undefined,
            state: "open",
            trackedRepos: isRepoName(arg) ? undefined : trackedRepos,
          });
          if (items.length === 0) {
            return {
              exitCode: 0,
              stdout: "Nothing cached. Run `bb github sync` first.",
            };
          }
          return {
            exitCode: 0,
            stdout: items
              .map(
                (item) =>
                  `${item.repo}#${item.number}\t[${item.state}]\t${item.title}`,
              )
              .join("\n"),
          };
        }
        if (sub === "sync") {
          const { repos, items } = await syncAll(true);
          return {
            exitCode: 0,
            stdout: `Synced ${items} item(s) across ${repos} repo(s).`,
          };
        }
        return {
          exitCode: 1,
          stderr: `Unknown subcommand "${sub}".\n${USAGE}`,
        };
      } catch (error) {
        return {
          exitCode: 1,
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}
