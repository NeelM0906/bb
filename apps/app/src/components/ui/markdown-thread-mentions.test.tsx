// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { PromptTextMention } from "@bb/domain";
import type { ThreadResponse } from "@bb/server-contract";
import type { TimelineTitleLink } from "@bb/thread-view";
import { RouteNavigationProvider } from "@/components/ui/app-route-anchor";
import {
  type MarkdownMessageDirectives,
  type MessageDirectiveRegistry,
} from "@/components/ui/markdown-message-directives";
import { MarkdownPreview } from "@/components/ui/markdown-preview";
import { threadQueryKey } from "@/hooks/queries/query-keys";
import { sdk } from "@/lib/sdk";
import { setPreferredTheme } from "@/hooks/useTheme";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";

vi.mock("@/lib/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sdk")>();
  return {
    ...actual,
    sdk: {
      ...actual.sdk,
      threads: {
        ...actual.sdk.threads,
        get: vi.fn(() => Promise.reject(new Error("Thread not found"))),
      },
    },
  };
});

function markdownTree(node: ReactNode) {
  return (
    <MemoryRouter>
      <RouteNavigationProvider>{node}</RouteNavigationProvider>
    </MemoryRouter>
  );
}

function resolveThreadLink(link: TimelineTitleLink): string | null {
  return link.kind === "thread"
    ? `/projects/proj_demo/threads/${link.threadId}`
    : null;
}

function resolveUpdatedThreadLink(link: TimelineTitleLink): string | null {
  return link.kind === "thread"
    ? `/projects/proj_demo/threads/${link.threadId}?updated=1`
    : null;
}

function threadResponse(
  overrides: Partial<ThreadResponse> = {},
): ThreadResponse {
  return {
    id: "thr_child",
    projectId: "proj_demo",
    environmentId: null,
    providerId: "codex",
    title: "Rebuild comments",
    titleFallback: "Rebuild comments",
    sectionId: null,
    status: "idle",
    parentThreadId: null,
    sourceThreadId: null,
    originKind: null,
    originPluginId: null,
    visibility: "visible",
    childOrigin: null,
    archivedAt: null,
    pinnedAt: null,
    deletedAt: null,
    lastReadAt: 0,
    latestAttentionAt: 1,
    createdAt: 1,
    updatedAt: 1,
    runtime: {
      displayStatus: "idle",
      hostReconnectGraceExpiresAt: null,
    },
    canSpawnChild: true,
    ...overrides,
  };
}

function renderMarkdown(
  node: ReactNode,
  cachedThreads: readonly ThreadResponse[] = [threadResponse()],
) {
  const { queryClient, wrapper } = createQueryClientTestHarness();
  for (const thread of cachedThreads) {
    queryClient.setQueryData(threadQueryKey(thread.id), thread);
  }
  return {
    ...render(markdownTree(node), { wrapper }),
    queryClient,
  };
}

const THREAD_MENTION: PromptTextMention = {
  start: 0,
  end: "@thread:thr_child".length,
  resource: {
    kind: "thread",
    threadId: "thr_child",
    projectId: "proj_demo",
    label: "Rebuild comments",
  },
};

const UPDATED_THREAD_MENTION: PromptTextMention = {
  ...THREAD_MENTION,
  resource: {
    ...THREAD_MENTION.resource,
    label: "Updated child",
  },
};

const MESSAGE_DIRECTIVE_REGISTRY: MessageDirectiveRegistry = new Map([
  ["inline-vis", { status: "collision", pluginIds: ["plugin-a", "plugin-b"] }],
]);

const ACTIVE_MESSAGE_DIRECTIVES: MarkdownMessageDirectives = {
  registry: MESSAGE_DIRECTIVE_REGISTRY,
  message: {
    id: "msg_thread_mention",
    threadId: "thr_parent",
    turnId: "turn_thread_mention",
    projectId: "proj_demo",
  },
  openWorkspaceFile: null,
  openThreadPanel: null,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setPreferredTheme("system");
});

describe("MarkdownPreview thread mentions", () => {
  it("leaves an unresolvable raw thread id as text", async () => {
    const { container, queryClient } = renderMarkdown(
      <MarkdownPreview
        content="Continue in thr_2222222222 when this is ready."
        threadMentions={{ mentions: [], preserveSoftBreaks: true }}
      />,
      [],
    );

    await waitFor(() => {
      expect(
        queryClient.getQueryState(threadQueryKey("thr_2222222222"))?.status,
      ).toBe("error");
    });

    expect(container.textContent).toContain("thr_2222222222");
    expect(container.querySelector('[data-prompt-mention="true"]')).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("leaves raw thread ids inside inline and fenced code untouched", () => {
    const { container } = renderMarkdown(
      <MarkdownPreview
        content={[
          "Run `bb thread show thr_dcwivn5n8w`.",
          "",
          "```text",
          "thr_dcwivn5n8w",
          "```",
        ].join("\n")}
        threadMentions={{ mentions: [], preserveSoftBreaks: true }}
      />,
      [
        threadResponse({
          id: "thr_dcwivn5n8w",
          title: "Known code target",
          titleFallback: "Known code target",
        }),
      ],
    );

    const codeNodes = container.querySelectorAll("code");
    expect(codeNodes).toHaveLength(2);
    expect(
      Array.from(codeNodes).every((node) =>
        node.textContent?.includes("thr_dcwivn5n8w"),
      ),
    ).toBe(true);
    expect(container.querySelector('[data-prompt-mention="true"]')).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("matches only the exact thread id prefix, alphabet, length, and boundaries", () => {
    const untouched = [
      "env_dcwivn5n8w",
      "thr_dcwivn5n8o",
      "thr_dcwivn5n8",
      "thr_dcwivn5n8w2",
      "prefixthr_dcwivn5n8w",
      "thr_dcwivn5n8w.md",
      "thr_dcwivn5n8w/path",
    ].join(" ");
    const { container } = renderMarkdown(
      <MarkdownPreview
        content={untouched}
        threadMentions={{ mentions: [], preserveSoftBreaks: true }}
      />,
    );

    expect(container.textContent).toBe(untouched);
    expect(container.querySelector('[data-prompt-mention="true"]')).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(sdk.threads.get).not.toHaveBeenCalled();
  });

  it.each([
    ["straight closing quote", 'He said "Continue in thr_dcwivn5n8w."'],
    ["curly closing quote", "He said “Continue in thr_dcwivn5n8w.”"],
  ])(
    "recognizes a sentence-final raw thread id before a %s",
    (_label, content) => {
      renderMarkdown(
        <MarkdownPreview
          content={content}
          threadMentions={{ mentions: [], preserveSoftBreaks: true }}
        />,
        [
          threadResponse({
            id: "thr_dcwivn5n8w",
            projectId: "proj_target",
            title: "Quoted target",
            titleFallback: "Quoted target",
          }),
        ],
      );

      expect(
        screen
          .getByRole("link", { name: "Quoted target" })
          .getAttribute("href"),
      ).toBe("/projects/proj_target/threads/thr_dcwivn5n8w");
    },
  );

  it("routes a known raw id through its resolved project instead of the timeline resolver", () => {
    renderMarkdown(
      <MarkdownPreview
        content="Continue in thr_dcwivn5n8w."
        threadMentions={{
          mentions: [],
          preserveSoftBreaks: true,
          resolveLinkHref: resolveThreadLink,
        }}
      />,
      [
        threadResponse({
          id: "thr_dcwivn5n8w",
          projectId: "proj_target",
          title: "Cross-project raw target",
          titleFallback: "Cross-project raw target",
        }),
      ],
    );

    expect(
      screen
        .getByRole("link", { name: "Cross-project raw target" })
        .getAttribute("href"),
    ).toBe("/projects/proj_target/threads/thr_dcwivn5n8w");
  });

  it("resolves and links a thread absent from sidebar resources through the authoritative thread query", () => {
    const queriedThread = threadResponse({
      id: "thr_archived",
      projectId: "proj_archive",
      title: "Archived investigation",
      titleFallback: "Archived investigation",
      archivedAt: 10,
    });
    renderMarkdown(
      <MarkdownPreview
        content="See @thread:thr_archived for the report."
        threadMentions={{
          mentions: [],
          preserveSoftBreaks: true,
        }}
      />,
      [queriedThread],
    );

    const pill = screen.getByText("Archived investigation").closest("a");
    expect(pill).not.toBeNull();
    expect(pill?.getAttribute("href")).toBe(
      "/projects/proj_archive/threads/thr_archived",
    );
  });

  it("updates rendered mention pills when thread mention props change without content changing", () => {
    const { queryClient, rerender } = renderMarkdown(
      <MarkdownPreview
        content="See @thread:thr_child for the report."
        threadMentions={{
          mentions: [THREAD_MENTION],
          preserveSoftBreaks: true,
          resolveLinkHref: resolveThreadLink,
        }}
      />,
    );

    expect(screen.getByText("Rebuild comments")).toBeTruthy();

    act(() => {
      queryClient.setQueryData(
        threadQueryKey("thr_child"),
        threadResponse({ title: "Updated child" }),
      );
    });

    rerender(
      markdownTree(
        <MarkdownPreview
          content="See @thread:thr_child for the report."
          threadMentions={{
            mentions: [UPDATED_THREAD_MENTION],
            preserveSoftBreaks: true,
            resolveLinkHref: resolveUpdatedThreadLink,
          }}
        />,
      ),
    );

    expect(screen.queryByText("Rebuild comments")).toBeNull();
    const pill = screen.getByText("Updated child").closest("a");
    expect(pill).not.toBeNull();
    expect(pill?.getAttribute("href")).toBe(
      "/projects/proj_demo/threads/thr_child?updated=1",
    );
  });

  it("falls back to the thread id when no mention resource matches", () => {
    renderMarkdown(
      <MarkdownPreview
        content="See @thread:thr_unknown please."
        threadMentions={{
          mentions: [],
          preserveSoftBreaks: true,
          resolveLinkHref: resolveThreadLink,
        }}
      />,
      [
        threadResponse({
          id: "thr_unknown",
          title: "thr_unknown",
          titleFallback: "thr_unknown",
        }),
      ],
    );

    const pill = screen.getByText("thr_unknown").closest("a");
    expect(pill).not.toBeNull();
    expect(pill?.getAttribute("href")).toBe(
      "/projects/proj_demo/threads/thr_unknown",
    );
  });

  it("leaves a labeled text directive on the authored directive rendering path", () => {
    const { container } = renderMarkdown(
      <MarkdownPreview
        content="@thread:thr_child[label]"
        threadMentions={{
          mentions: [THREAD_MENTION],
          preserveSoftBreaks: true,
          resolveLinkHref: resolveThreadLink,
        }}
        messageDirectives={ACTIVE_MESSAGE_DIRECTIVES}
      />,
    );

    // The token is not a mention here, so it stays verbatim prose — one text
    // node, no pill and no directive mount.
    const paragraph = container.querySelector("p");
    expect(paragraph?.textContent).toBe("@thread:thr_child[label]");
    expect(paragraph?.querySelector("a")).toBeNull();
    expect(screen.queryByText("Rebuild comments")).toBeNull();
  });

  it("leaves an attributed text directive on the authored directive rendering path", () => {
    const { container } = renderMarkdown(
      <MarkdownPreview
        content="@thread:thr_child{#authored-directive}"
        threadMentions={{
          mentions: [THREAD_MENTION],
          preserveSoftBreaks: true,
          resolveLinkHref: resolveThreadLink,
        }}
        messageDirectives={ACTIVE_MESSAGE_DIRECTIVES}
      />,
    );

    const paragraph = container.querySelector("p");
    expect(paragraph?.textContent).toBe(
      "@thread:thr_child{#authored-directive}",
    );
    expect(paragraph?.querySelector("a")).toBeNull();
    expect(screen.queryByText("Rebuild comments")).toBeNull();
  });

  it("leaves a raw thread token inside an authored Markdown link", () => {
    renderMarkdown(
      <MarkdownPreview
        content="[@thread:thr_child](https://example.com)"
        threadMentions={{
          mentions: [THREAD_MENTION],
          preserveSoftBreaks: true,
          resolveLinkHref: resolveThreadLink,
        }}
      />,
    );

    const link = screen.getByRole("link", { name: "@thread:thr_child" });
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.queryByText("Rebuild comments")).toBeNull();
  });

  it("replaces a resolvable raw-id Markdown link label with one thread pill", () => {
    renderMarkdown(
      <MarkdownPreview
        content="[thr_dcwivn5n8w](https://example.com)"
        threadMentions={{
          mentions: [],
          preserveSoftBreaks: true,
          resolveLinkHref: resolveThreadLink,
        }}
      />,
      [
        threadResponse({
          id: "thr_dcwivn5n8w",
          projectId: "proj_target",
          title: "Linked-label target",
          titleFallback: "Linked-label target",
        }),
      ],
    );

    const pill = screen.getByRole("link", { name: "Linked-label target" });
    expect(pill.getAttribute("href")).toBe(
      "/projects/proj_target/threads/thr_dcwivn5n8w",
    );
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(pill.querySelector("a")).toBeNull();
  });

  it("preserves an unresolvable raw-id Markdown link", async () => {
    const { queryClient } = renderMarkdown(
      <MarkdownPreview
        content="[thr_2222222222](https://example.com)"
        threadMentions={{ mentions: [], preserveSoftBreaks: true }}
      />,
      [],
    );

    await waitFor(() => {
      expect(
        queryClient.getQueryState(threadQueryKey("thr_2222222222"))?.status,
      ).toBe("error");
    });

    const link = screen.getByRole("link", { name: "thr_2222222222" });
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("reconstructs a directive-split thread token inside an authored Markdown link", () => {
    renderMarkdown(
      <MarkdownPreview
        content="[@thread:thr_child](https://example.com)"
        threadMentions={{
          mentions: [THREAD_MENTION],
          preserveSoftBreaks: true,
          resolveLinkHref: resolveThreadLink,
        }}
        messageDirectives={ACTIVE_MESSAGE_DIRECTIVES}
      />,
    );

    const link = screen.getByRole("link", { name: "@thread:thr_child" });
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.queryByText("Rebuild comments")).toBeNull();
  });

  it("leaves assistant content (no mentions prop) untouched — token stays literal", () => {
    renderMarkdown(
      <MarkdownPreview content="See @thread:thr_child for the report." />,
    );

    // No mentions prop → no remark plugin → token is plain text, no pill anchor.
    expect(screen.queryByText("Rebuild comments")).toBeNull();
    expect(
      screen.getByText(/@thread:thr_child/u, { exact: false }),
    ).toBeTruthy();
  });

  it.each([
    ["without message directives", undefined],
    ["with message directives", ACTIVE_MESSAGE_DIRECTIVES],
  ])("uses complete token boundaries %s", (_label, messageDirectives) => {
    const content =
      "foo@thread:thr_embedded @thread:thr_continued/path @thread:thr_child";
    const { container } = renderMarkdown(
      <MarkdownPreview
        content={content}
        threadMentions={{
          mentions: [THREAD_MENTION],
          preserveSoftBreaks: true,
          resolveLinkHref: resolveThreadLink,
        }}
        messageDirectives={messageDirectives}
      />,
    );

    expect(screen.getAllByText("Rebuild comments")).toHaveLength(1);
    expect(container.textContent).toContain("foo@thread:thr_embedded");
    expect(container.textContent).toContain("@thread:thr_continued/path");
  });
});
