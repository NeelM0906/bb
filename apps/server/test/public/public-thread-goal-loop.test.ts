import { getLatestThreadSequence, getThread, listEvents } from "@bb/db";
import {
  FIRST_PARTY_GOAL_EXTENSION_KIND,
  createBuiltinGoalCommandTextInput,
  threadScope,
} from "@bb/domain";
import { describe, expect, it, vi } from "vitest";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  registerHostRpcResponder,
  type HostRpcHandlerResult,
} from "../helpers/host-rpc.js";
import { readJson } from "../helpers/json.js";
import { resolveThreadRuntimeCommandConfig } from "../../src/services/threads/thread-runtime-config.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function seedGoalThread(
  harness: TestAppHarness,
  args: { providerId: string; providerThreadId?: string; status?: "idle" },
) {
  const { host, session } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    providerId: args.providerId,
    status: args.status ?? "idle",
  });
  if (args.providerThreadId !== undefined) {
    seedThreadRuntimeState(harness.deps, {
      environmentId: environment.id,
      providerThreadId: args.providerThreadId,
      threadId: thread.id,
    });
  }
  return { environment, host, project, session, thread };
}

function registerSuccessfulTurnResponder(
  harness: TestAppHarness,
  args: { hostId: string; sessionId: string },
) {
  return registerHostRpcResponder(harness, {
    ...args,
    handle: ({ command }): HostRpcHandlerResult => {
      if (command.type === "host.admission.reserve") {
        return {
          ok: true,
          result: {
            outcome: "reserved",
            reservation: {
              generation: 1,
              hostId: args.hostId,
              reason: command.reason,
              token: `test-admission:${command.threadId}`,
            },
          },
        };
      }
      if (command.type === "host.admission.release") {
        return { ok: true, result: { released: true } };
      }
      if (command.type === "host.list_files") {
        return { ok: true, result: { files: [], truncated: false } };
      }
      if (command.type === "host.read_file") {
        return {
          ok: false,
          errorCode: "ENOENT",
          errorMessage: `Path does not exist: ${command.path}`,
        };
      }
      if (command.type === "thread.stop") {
        return { ok: true, result: { providerCheckpointId: null } };
      }
      return { ok: true, result: { appliedAs: "new-turn" } };
    },
  });
}

function firstPartyGoalEvents(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId }).flatMap((row) => {
    if (row.type !== "thread/extensionState/updated") return [];
    const data = JSON.parse(row.data) as {
      kind?: string;
      payload?: unknown;
    };
    return data.kind === FIRST_PARTY_GOAL_EXTENSION_KIND
      ? [
          {
            type: row.type,
            kind: data.kind,
            payload: data.payload,
          },
        ]
      : [];
  });
}

describe("first-party Goal send intercept", () => {
  it("persists an active bb/goal and sends the stripped objective on Claude", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedGoalThread(harness, {
        providerId: "claude-code",
        providerThreadId: "provider-thread-1",
      });
      const responder = registerSuccessfulTurnResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "start",
            input: [createBuiltinGoalCommandTextInput("ship the hybrid loop")],
          }),
        },
      );

      expect(
        response.status,
        JSON.stringify(await readJson(response.clone())),
      ).toBe(200);
      await vi.waitFor(() => {
        expect(
          responder.requests.some(
            ({ command }) => command.type === "turn.submit",
          ),
        ).toBe(true);
      });
      const turnSubmit = responder.requests.find(
        ({ command }) => command.type === "turn.submit",
      );
      expect(turnSubmit?.command).toMatchObject({
        type: "turn.submit",
        threadId: thread.id,
        input: [
          {
            type: "text",
            text: "ship the hybrid loop",
            mentions: [],
          },
        ],
      });
      expect(firstPartyGoalEvents(harness, thread.id)).toEqual([
        expect.objectContaining({
          type: "thread/extensionState/updated",
          kind: FIRST_PARTY_GOAL_EXTENSION_KIND,
          payload: {
            objective: "ship the hybrid loop",
            status: "active",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
          },
        }),
      ]);
    });
  });

  it("rejects a built-in /goal with no objective", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedGoalThread(harness, {
        providerId: "pi",
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "start",
            input: [createBuiltinGoalCommandTextInput("")],
          }),
        },
      );

      expect(response.status).toBe(400);
      expect(await readJson(response)).toMatchObject({
        code: "invalid_request",
        message: "Goal requires an objective",
      });
      expect(firstPartyGoalEvents(harness, thread.id)).toEqual([]);
      expect(
        listEvents(harness.db, { threadId: thread.id }).filter(
          (event) => event.type === "client/turn/requested",
        ),
      ).toHaveLength(0);
    });
  });

  it("does not intercept built-in /goal on Codex native Goal", async () => {
    await withTestHarness(async (harness) => {
      const { host, session, thread } = seedGoalThread(harness, {
        providerId: "codex",
        providerThreadId: "provider-thread-1",
      });
      const responder = registerSuccessfulTurnResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
      });
      const input = [
        createBuiltinGoalCommandTextInput("use the native Codex Goal"),
      ];

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "start",
            input,
          }),
        },
      );

      expect(
        response.status,
        JSON.stringify(await readJson(response.clone())),
      ).toBe(200);
      await vi.waitFor(() => {
        expect(
          responder.requests.some(
            ({ command }) => command.type === "turn.submit",
          ),
        ).toBe(true);
      });
      const turnSubmit = responder.requests.find(
        ({ command }) => command.type === "turn.submit",
      );
      expect(turnSubmit?.command).toMatchObject({
        type: "turn.submit",
        threadId: thread.id,
        input,
      });
      expect(firstPartyGoalEvents(harness, thread.id)).toEqual([]);
    });
  });

  it("clears a first-party Goal when /clear runs", async () => {
    await withTestHarness(async (harness) => {
      const { environment, host, session, thread } = seedGoalThread(harness, {
        providerId: "claude-code",
        providerThreadId: "provider-thread-1",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        sequence: getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
        type: "thread/extensionState/updated",
        scope: threadScope(),
        data: {
          providerThreadId: "provider-thread-1",
          kind: FIRST_PARTY_GOAL_EXTENSION_KIND,
          payload: {
            objective: "ship the hybrid loop",
            status: "active",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
          },
        },
      });
      registerSuccessfulTurnResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "start",
            input: [
              {
                type: "text",
                text: "/clear",
                mentions: [
                  {
                    start: 0,
                    end: 6,
                    resource: {
                      kind: "command",
                      trigger: "/",
                      name: "clear",
                      source: "command",
                      origin: "builtin",
                      label: "clear",
                      argumentHint: null,
                    },
                  },
                ],
              },
            ],
          }),
        },
      );

      expect(
        response.status,
        JSON.stringify(await readJson(response.clone())),
      ).toBe(200);
      const goals = firstPartyGoalEvents(harness, thread.id);
      expect(goals.at(-1)).toMatchObject({
        kind: FIRST_PARTY_GOAL_EXTENSION_KIND,
        payload: null,
      });

      const listResponse = await harness.app.request(
        `/api/v1/threads?projectId=${thread.projectId}`,
      );
      expect(listResponse.status).toBe(200);
      const threads = (await readJson(listResponse)) as Array<{
        id: string;
        activity: { activeGoalCount: number };
      }>;
      expect(
        threads.find((entry) => entry.id === thread.id)?.activity.activeGoalCount,
      ).toBe(0);
    });
  });

  it("clears a first-party Goal locally without a provider Goal RPC", async () => {
    await withTestHarness(async (harness) => {
      const { environment, host, session, thread } = seedGoalThread(harness, {
        providerId: "claude-code",
        providerThreadId: "provider-thread-1",
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        sequence: getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
        type: "thread/extensionState/updated",
        scope: threadScope(),
        data: {
          providerThreadId: "provider-thread-1",
          kind: FIRST_PARTY_GOAL_EXTENSION_KIND,
          payload: {
            objective: "ship the hybrid loop",
            status: "active",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
          },
        },
      });
      const responder = registerSuccessfulTurnResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/goal/clear`,
        { method: "POST" },
      );

      expect(
        response.status,
        JSON.stringify(await readJson(response.clone())),
      ).toBe(200);
      expect(
        responder.requests.some(
          ({ command }) => command.type === "thread.goal.clear",
        ),
      ).toBe(false);
      expect(firstPartyGoalEvents(harness, thread.id).at(-1)).toMatchObject({
        kind: FIRST_PARTY_GOAL_EXTENSION_KIND,
        payload: null,
      });
    });
  });
});

function seedActiveFirstPartyGoal(
  harness: TestAppHarness,
  args: {
    environmentId: string;
    objective?: string;
    providerThreadId: string;
    threadId: string;
  },
): void {
  seedEvent(harness.deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    providerThreadId: args.providerThreadId,
    sequence: getLatestThreadSequence(harness.db, { threadId: args.threadId }) + 1,
    type: "thread/extensionState/updated",
    scope: threadScope(),
    data: {
      providerThreadId: args.providerThreadId,
      kind: FIRST_PARTY_GOAL_EXTENSION_KIND,
      payload: {
        objective: args.objective ?? "ship the hybrid loop",
        status: "active",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
      },
    },
  });
}

describe("first-party goal.complete tool", () => {
  it("injects goal.complete only while a first-party Goal is active", async () => {
    await withTestHarness(async (harness) => {
      const { environment, host, thread } = seedGoalThread(harness, {
        providerId: "claude-code",
        providerThreadId: "provider-thread-1",
      });
      seedPrimaryHost(harness.deps, host.id);
      const loaded = getThread(harness.db, thread.id);
      if (!loaded) throw new Error("missing thread");

      const withoutGoal = await resolveThreadRuntimeCommandConfig(
        harness.deps,
        {
          thread: loaded,
          model: "test-model",
          environment: {
            hostId: environment.hostId,
            id: environment.id,
            path: environment.path,
            status: environment.status,
          },
        },
      );
      expect(withoutGoal.dynamicTools.map((tool) => tool.name)).toEqual([
        "update_environment_directory",
      ]);

      seedActiveFirstPartyGoal(harness, {
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        threadId: thread.id,
      });
      const withGoal = await resolveThreadRuntimeCommandConfig(harness.deps, {
        thread: loaded,
        model: "test-model",
        environment: {
          hostId: environment.hostId,
          id: environment.id,
          path: environment.path,
          status: environment.status,
        },
      });
      expect(withGoal.dynamicTools.map((tool) => tool.name)).toEqual([
        "update_environment_directory",
        "goal.complete",
      ]);
      expect(withGoal.instructions).toContain("goal.complete");
    });
  });

  it("marks the first-party Goal complete when the tool is called", async () => {
    await withTestHarness(async (harness) => {
      const { environment, session, thread } = seedGoalThread(harness, {
        providerId: "claude-code",
        providerThreadId: "provider-thread-1",
      });
      seedActiveFirstPartyGoal(harness, {
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        threadId: thread.id,
      });

      const response = await harness.app.request("/internal/session/tool-call", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          threadId: thread.id,
          providerThreadId: "provider-thread-1",
          turnId: "turn-goal-complete",
          callId: "call-goal-complete",
          tool: "goal.complete",
          arguments: { summary: "Shipped the hybrid loop" },
        }),
      });

      expect(
        response.status,
        JSON.stringify(await readJson(response.clone())),
      ).toBe(200);
      expect(await readJson(response)).toMatchObject({
        success: true,
      });
      expect(firstPartyGoalEvents(harness, thread.id).at(-1)).toMatchObject({
        kind: FIRST_PARTY_GOAL_EXTENSION_KIND,
        payload: expect.objectContaining({
          objective: "ship the hybrid loop",
          status: "complete",
        }),
      });
    });
  });

  it("refuses goal.complete when no first-party Goal is active", async () => {
    await withTestHarness(async (harness) => {
      const { session, thread } = seedGoalThread(harness, {
        providerId: "claude-code",
        providerThreadId: "provider-thread-1",
      });

      const response = await harness.app.request("/internal/session/tool-call", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          threadId: thread.id,
          providerThreadId: "provider-thread-1",
          turnId: "turn-goal-complete",
          callId: "call-goal-complete",
          tool: "goal.complete",
          arguments: {},
        }),
      });

      expect(response.status).toBe(200);
      expect(await readJson(response)).toMatchObject({
        success: false,
      });
      expect(firstPartyGoalEvents(harness, thread.id)).toEqual([]);
    });
  });
});
