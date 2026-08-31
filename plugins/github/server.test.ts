import { describe, expect, expectTypeOf, it } from "vitest";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import type { PluginRpcClient, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  canAutoTrackPermission,
  fetchRepoItems,
  githubRpcContract,
  isAuthoritativeMissingOrigin,
  nextAutoTrackedRepos,
  parseRepoListWithInvalid,
  parsePaginatedGhApi,
  parseRepoList,
  projectReposForTracking,
  repoAccessFromCheck,
  selectTrackedRepos,
  validateGithubCliArgs,
} from "./server";

type GithubRpcHandlers = PluginRpcHandlers<typeof githubRpcContract>;

function assertGithubFrontendInference(
  client: PluginRpcClient<typeof githubRpcContract>,
) {
  expectTypeOf(
    client.call("getPull", { repo: "get-bb/bb", number: 694 }),
  ).toEqualTypeOf<
    Promise<{
      pull: {
        repo: string;
        number: number;
        title: string;
        state: string;
        author: string;
        body: string;
        url: string;
        createdAt: string;
        updatedAt: string;
        baseRefName: string;
        headRefName: string;
        additions: number;
        deletions: number;
        changedFiles: number;
        labels: string[];
        assignees: string[];
        reviewDecision: string;
        mergeStateStatus: string;
        reviewRequests: string[];
        checks: Array<{
          name: string;
          status: "success" | "failure" | "pending" | "neutral";
          url: string;
        }>;
        comments: Array<{ author: string; body: string; createdAt: string }>;
        reviews: Array<{
          author: string;
          state: string;
          body: string;
          createdAt: string;
        }>;
        reviewThreads: Array<{
          path: string;
          line: number | null;
          diffHunk: string;
          comments: Array<{
            author: string;
            body: string;
            createdAt: string;
          }>;
        }>;
        files: Array<{
          path: string;
          status: string;
          additions: number;
          deletions: number;
          patch: string | null;
        }>;
      };
    }>
  >();

  // @ts-expect-error issue numbers must be numeric.
  void client.call("getIssue", { repo: "get-bb/bb", number: "694" });
  // @ts-expect-error unknown filter values are rejected by the contract.
  void client.call("listItems", { kind: "discussion" });
}

describe("GitHub RPC contract", () => {
  it("keeps pull requests when a repository has GitHub Issues disabled", async () => {
    const calls: string[][] = [];
    const openPulls = JSON.stringify([
      {
        number: 17,
        title: "Keep syncing pull requests",
        state: "OPEN",
        author: { login: "octocat" },
        labels: [{ name: "bug" }],
        assignees: [],
        url: "https://github.com/acme/widgets/pull/17",
        body: "",
        updatedAt: "2026-08-10T00:00:00Z",
      },
    ]);

    const items = await fetchRepoItems(async (args) => {
      calls.push(args);
      if (args[0] === "issue") {
        throw new Error(
          "gh issue list failed: the 'acme/widgets' repository has disabled Issues",
        );
      }
      return args.includes("open") ? openPulls : "[]";
    }, "acme/widgets");

    expect(calls).toHaveLength(4);
    expect(calls.filter(([kind]) => kind === "pr")).toHaveLength(2);
    expect(items).toEqual([
      expect.objectContaining({
        repo: "acme/widgets",
        number: 17,
        kind: "pr",
        title: "Keep syncing pull requests",
      }),
    ]);
  });

  it("flattens every paginated GitHub API page", () => {
    expect(
      parsePaginatedGhApi(
        JSON.stringify([[{ id: 1 }, { id: 2 }], [{ id: 3 }]]),
      ),
    ).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);

    expect(() => parsePaginatedGhApi(JSON.stringify([{ id: 1 }]))).toThrow(
      "malformed page",
    );
  });

  it("separates usable extraRepos entries from ones it cannot honor", () => {
    expect(parseRepoListWithInvalid("get-bb/bb, nonsense")).toEqual({
      repos: ["get-bb/bb"],
      invalid: ["nonsense"],
    });
    expect(parseRepoListWithInvalid("SOME-ORG/*")).toEqual({
      repos: [],
      invalid: ["SOME-ORG/*"],
    });
    expect(parseRepoListWithInvalid("")).toEqual({ repos: [], invalid: [] });
    expect(parseRepoListWithInvalid("  ,, \n ")).toEqual({
      repos: [],
      invalid: [],
    });
    expect(parseRepoListWithInvalid(" acme/one\nacme/two , acme/one ")).toEqual({
      repos: ["acme/one", "acme/two"],
      invalid: [],
    });
    expect(parseRepoListWithInvalid("bad/repo/shape acme").invalid).toEqual([
      "bad/repo/shape",
      "acme",
    ]);
  });

  it("rejects CLI arguments that would otherwise broaden a repository query", () => {
    expect(validateGithubCliArgs(["issues", "get-bb/bb"])).toBeNull();
    expect(validateGithubCliArgs(["issues", "bad/repo/shape"])).toContain(
      "expected owner/repo",
    );
    expect(validateGithubCliArgs(["prs", "get-bb/bb", "extra"])).toContain(
      "Unexpected argument",
    );
    expect(validateGithubCliArgs(["repos", "--json"])).toContain(
      "does not accept arguments",
    );
  });

  it("infers parsed handler inputs and frontend results", () => {
    expectTypeOf<
      Parameters<GithubRpcHandlers["createIssue"]>[0]
    >().toEqualTypeOf<{
      repo: string;
      title: string;
      body?: string;
    }>();
    expectTypeOf(assertGithubFrontendInference).toBeFunction();
  });

  it("rejects invalid method inputs and outputs at runtime", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "github-contract",
    });
    const contract = defineRpcContract({
      startWork: githubRpcContract.startWork,
    });
    bb.rpc.register(contract, {
      startWork() {
        return { threadId: "" };
      },
    });

    await expect(
      harness.callRpc("startWork", {
        repo: "not-a-repository",
        number: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      harness.callRpc("startWork", { repo: "get-bb/bb", number: 694 }),
    ).rejects.toMatchObject({ code: "invalid_output" });
  });
});

describe("GitHub repo tracking", () => {
  it("treats only an absent repository or origin as authoritative discovery", () => {
    expect(
      isAuthoritativeMissingOrigin(
        new Error("fatal: not a git repository (or any parent directory)"),
      ),
    ).toBe(true);
    expect(
      isAuthoritativeMissingOrigin(new Error("error: No such remote 'origin'")),
    ).toBe(true);
    expect(
      isAuthoritativeMissingOrigin(
        new Error("git remote get-url failed: operation timed out"),
      ),
    ).toBe(false);
    expect(
      isAuthoritativeMissingOrigin(new Error("spawn git EACCES")),
    ).toBe(false);
  });

  it("parses comma or whitespace separated owner/repo values", () => {
    expect(parseRepoList("get-bb/bb, acme/widgets\nowner/other")).toEqual([
      "get-bb/bb",
      "acme/widgets",
      "owner/other",
    ]);
    expect(parseRepoList("not-a-repo, acme/widgets, acme/widgets")).toEqual([
      "acme/widgets",
    ]);
    expect(parseRepoList("Get-BB/BB get-bb/bb")).toEqual(["Get-BB/BB"]);
  });

  it("auto-tracks only permissions the viewer was granted", () => {
    expect(canAutoTrackPermission("READ")).toBe(false);
    expect(canAutoTrackPermission("TRIAGE")).toBe(true);
    expect(canAutoTrackPermission("WRITE")).toBe(true);
    expect(canAutoTrackPermission("MAINTAIN")).toBe(true);
    expect(canAutoTrackPermission("ADMIN")).toBe(true);
    expect(canAutoTrackPermission(null)).toBe(false);
  });

  it("does not auto-track a read-only upstream remote", () => {
    expect(
      selectTrackedRepos({
        projectRepos: [
          { repo: "get-bb/bb", projectId: "proj_bb" },
          { repo: "acme/widgets", projectId: "proj_widgets" },
        ],
        extraRepos: [],
        ignoredRepos: [],
        trackProjectRemotes: true,
        accessByRepo: new Map([
          ["get-bb/bb", "denied"],
          ["acme/widgets", "granted"],
        ]),
        previouslyAutoTracked: [],
      }),
    ).toEqual([{ repo: "acme/widgets", projectId: "proj_widgets" }]);
  });

  it("keeps explicitly shared extra repos even without write access", () => {
    expect(
      selectTrackedRepos({
        projectRepos: [{ repo: "get-bb/bb", projectId: "proj_bb" }],
        extraRepos: ["get-bb/bb"],
        ignoredRepos: [],
        trackProjectRemotes: false,
        accessByRepo: new Map([["get-bb/bb", "denied"]]),
        previouslyAutoTracked: [],
      }),
    ).toEqual([{ repo: "get-bb/bb", projectId: "proj_bb" }]);
  });

  it("never tracks ignored repos, including extraRepos", () => {
    expect(
      selectTrackedRepos({
        projectRepos: [{ repo: "acme/widgets", projectId: "proj_widgets" }],
        extraRepos: ["get-bb/bb", "acme/widgets"],
        ignoredRepos: ["get-bb/bb", "acme/widgets"],
        trackProjectRemotes: true,
        accessByRepo: new Map([["acme/widgets", "granted"]]),
        previouslyAutoTracked: ["acme/widgets"],
      }),
    ).toEqual([]);
  });

  it("compares repository identity case-insensitively", () => {
    expect(
      selectTrackedRepos({
        projectRepos: [{ repo: "Get-BB/BB", projectId: "proj_bb" }],
        extraRepos: ["get-bb/bb"],
        ignoredRepos: ["GET-BB/bb"],
        trackProjectRemotes: true,
        accessByRepo: new Map([["get-bb/BB", "granted"]]),
        previouslyAutoTracked: ["GET-bb/bb"],
      }),
    ).toEqual([]);
    expect(
      nextAutoTrackedRepos({
        projectRepos: ["Get-BB/BB"],
        ignoredRepos: [],
        accessByRepo: new Map([["get-bb/bb", "granted"]]),
        previouslyAutoTracked: [],
      }),
    ).toEqual(["Get-BB/BB"]);
  });

  it("preserves prior auto-tracked repos when project discovery is incomplete", () => {
    expect(
      projectReposForTracking({
        discoveredRepos: [{ repo: "Acme/Widgets", projectId: "proj_widgets" }],
        discoveryComplete: false,
        previouslyAutoTracked: ["acme/widgets", "get-bb/fork"],
      }),
    ).toEqual([
      { repo: "Acme/Widgets", projectId: "proj_widgets" },
      { repo: "get-bb/fork", projectId: null },
    ]);
  });

  it("does not drop a previously tracked writable origin when the permission check fails", () => {
    expect(
      selectTrackedRepos({
        projectRepos: [{ repo: "acme/widgets", projectId: "proj_widgets" }],
        extraRepos: [],
        ignoredRepos: [],
        trackProjectRemotes: true,
        accessByRepo: new Map([["acme/widgets", "unknown"]]),
        previouslyAutoTracked: ["acme/widgets"],
      }),
    ).toEqual([{ repo: "acme/widgets", projectId: "proj_widgets" }]);
  });

  it("does not auto-track an unknown origin that was never granted", () => {
    expect(
      selectTrackedRepos({
        projectRepos: [{ repo: "get-bb/bb", projectId: "proj_bb" }],
        extraRepos: [],
        ignoredRepos: [],
        trackProjectRemotes: true,
        accessByRepo: new Map([["get-bb/bb", "unknown"]]),
        previouslyAutoTracked: [],
      }),
    ).toEqual([]);
  });

  it("treats a thrown permission check as unknown, not denied", () => {
    expect(repoAccessFromCheck(null, true)).toBe("unknown");
    expect(repoAccessFromCheck("READ", false)).toBe("denied");
    expect(repoAccessFromCheck("WRITE", false)).toBe("granted");
  });

  it("keeps a previously granted origin across an unknown check", () => {
    expect(
      nextAutoTrackedRepos({
        projectRepos: ["acme/widgets", "get-bb/bb"],
        ignoredRepos: [],
        accessByRepo: new Map([
          ["acme/widgets", "unknown"],
          ["get-bb/bb", "denied"],
        ]),
        previouslyAutoTracked: ["acme/widgets", "get-bb/bb"],
      }),
    ).toEqual(["acme/widgets"]);
  });
});
