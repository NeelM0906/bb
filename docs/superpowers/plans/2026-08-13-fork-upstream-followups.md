# Fork Upstream Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the fork-maintenance work identified in the 2026-08-13 upstream audit without losing the existing workspace-safety guarantees or dirty GitHub-plugin work.

**Architecture:** Treat each finding as an independent compatibility or correctness slice. Keep fork policy at repository and server boundaries, port upstream bug fixes by behavior, and add regression coverage at the component that owns each invariant. Event-history cloning remains a server/DB transaction so cache notifications and projections stay coherent.

**Tech Stack:** TypeScript, pnpm/Turbo, Vitest, Hono, Drizzle/SQLite, GitHub Actions.

**Spec:** The accepted audit response in BB thread `thr_xuxcst55sk`.

## Global Constraints

- Preserve the host-admission, workspace-lease, provider-lifecycle, read-worker, migration-repair, and timeline guarantees already merged into `origin/main`.
- Add a failing regression before each production behavior change; configuration-only workflow guards are exempt.
- Do not change host-daemon wire contracts unless required; if required, increment `HOST_DAEMON_PROTOCOL_VERSION` and its mismatch tests.
- Do not overwrite the dirty checkout at `/Users/zidane/BB/bb`; transplant only its intended GitHub-plugin behavior.
- Use Turbo for builds and typechecks.

---

### Task 1: Fork-safe automation

**Files:**
- Modify: `.github/workflows/deploy-web.yml`
- Modify: `.github/workflows/deploy-connect.yml`
- Modify: `.github/workflows/publish-bb-app.yml`

**Interfaces:**
- Consumes: GitHub Actions `github.repository` context.
- Produces: deployment and scheduled publishing jobs that run only in `get-bb/bb`; manual fork release workflows remain explicitly invocable where safe.

- [ ] Add repository-owner guards to upstream production deployment jobs and scheduled publishing.
- [ ] Validate each workflow with the repository's YAML/prettier checks and inspect the resulting Actions expressions.
- [ ] Commit as `ci: disable upstream publishing in forks`.

### Task 2: Safe GitHub repository tracking

**Files:**
- Modify: `plugins/github/server.test.ts`
- Modify: `plugins/github/server.ts`
- Modify: `plugins/github/app.tsx`
- Modify: `plugins/github/README.md`
- Modify: `plugins/github/package.json`

**Interfaces:**
- Consumes: project `origin` remotes, GitHub `viewerPermission`, `extraRepos`, `ignoredRepos`, and `trackProjectRemotes` settings.
- Produces: opt-in tracked repository selection that never follows `upstream`, automatically includes only writable project origins, preserves previously granted origins across transient permission-check failures, and drops stale cache rows.

- [ ] Transplant the dirty tracking tests only, then run `bb-plugin-github` tests and verify they fail because selectors/settings are absent.
- [ ] Implement parsing, access classification, persisted auto-tracked state, cache filtering, settings invalidation, and updated copy without reverting newer `origin/main` UI.
- [ ] Run plugin tests, typecheck, and build.
- [ ] Commit as `fix(github): make repository tracking explicit`.

### Task 3: Prevent managed-workspace plugin-source loss

**Files:**
- Modify: `packages/server-contract/src/api/plugins.ts`
- Modify: `packages/server-contract/test/contract.test.ts`
- Modify: `packages/sdk/src/areas/plugins.ts`
- Modify: `apps/server/src/routes/plugins.ts`
- Modify: `apps/server/src/services/plugins/plugin-service.ts`
- Modify: `apps/server/src/services/plugins/plugin-registration.ts`
- Modify: `apps/server/test/services/plugins/plugin-install.test.ts`
- Modify: `apps/cli/src/commands/plugin.ts`
- Modify: `apps/cli/src/__tests__/command-output/plugin.test.ts`
- Modify: `apps/server/src/services/skills/builtin-skills/bb-plugin-authoring/SKILL.md`

**Interfaces:**
- Consumes: path install request `{ source, allowManagedWorkspaceSource }` and `isBbManagedWorkspacePath({ dataDir, path })`.
- Produces: default refusal for path sources under BB-managed workspaces plus an explicit `--allow-managed-workspace-source` override with a destructive-lifecycle warning.

- [ ] Add contract, service, route, and CLI regressions proving default refusal and explicit override.
- [ ] Run focused tests and confirm the new cases fail for the missing guard/field.
- [ ] Implement the boundary flag, central service guard, CLI option, and agent documentation.
- [ ] Run server-contract, SDK, server, and CLI tests/typechecks/builds.
- [ ] Commit as `fix(plugins): protect managed workspace sources`.

### Task 4: Port accepted upstream correctness patches

**Files:**
- Modify upstream-owned files from PRs `#1506`, `#1563`, `#1560`, and `#1542`.

**Interfaces:**
- Produces: watcher IPC `EPIPE` recovery, terminal Codex stream-disconnect classification, idempotent retried `turn/started` ingestion/projection, and pending idle post-turn compaction.

- [ ] Apply each upstream regression test before its implementation and observe the expected failure.
- [ ] Apply the minimal corresponding production patch, adapting only conflicts caused by fork changes.
- [ ] Run each owning package's full tests and typecheck.
- [ ] Commit each independent patch with its upstream subject and PR reference in the body.

### Task 5: Close ACP turns after prompt failure

**Files:**
- Modify: `packages/agent-runtime/src/acp/bridge/bridge.test.ts`
- Modify: `packages/agent-runtime/src/acp/bridge/bridge.ts`
- Modify: `packages/agent-runtime/src/acp/bridge/fake-acp-agent.mjs`

**Interfaces:**
- Consumes: rejected in-protocol `session/prompt` requests.
- Produces: one `acp/turn/completed` notification with `refusal` or `cancelled`, while retaining the fork's structured stale-steer protocol.

- [ ] Add the prompt-error bridge regression and observe the missing completion failure.
- [ ] Finish the turn through the existing `finishTurn` helper on prompt failure.
- [ ] Run agent-runtime tests, typecheck, and build.
- [ ] Commit as `fix(acp): settle turns after prompt failures`.

### Task 6: Bind managed-server health to the spawned launcher

**Files:**
- Modify: `packages/bb-app/src/launcher.test.ts`
- Modify: `packages/bb-app/src/launcher.ts`
- Modify: `apps/server/src/routes/health.ts` or the existing health route owner.

**Interfaces:**
- Consumes: a per-launch random nonce passed only to the managed server child.
- Produces: a health response/verification that cannot be satisfied by a different BB server sharing the port.

- [ ] Add a launcher regression where an unrelated healthy server responds while the managed child exits with `EADDRINUSE`; assert no enrollment occurs.
- [ ] Observe the false-positive startup failure.
- [ ] Add a child-only startup identity and require an exact match before returning healthy.
- [ ] Run bb-app/server focused tests, typechecks, builds, and increment the wire version only if an enrolled daemon contract changes.
- [ ] Commit as `fix(bb-app): verify managed server identity`.

### Task 7: Strip Volta recursion state from child processes

**Files:**
- Modify: `packages/process-utils/test/index.test.ts`
- Modify: `packages/process-utils/src/index.ts`

**Interfaces:**
- Consumes: inherited process environments.
- Produces: child environments without `_VOLTA_TOOL_RECURSION`, alongside existing BB/NODE_ENV sanitation.

- [ ] Add a sanitizer regression and observe that the Volta guard leaks.
- [ ] Remove the guard in the shared sanitizer.
- [ ] Run process-utils plus host-daemon/agent-runtime consumers' tests and typechecks.
- [ ] Commit as `fix(process): clear inherited Volta recursion guard`.

### Task 8: Make deleted session working directories recoverable

**Files:**
- Modify the persistent-shell/session boundary identified by reproduction.
- Add its owning component regression.

**Interfaces:**
- Consumes: a stored cwd that no longer exists and an optional explicit working-directory override.
- Produces: a loud failure or fallback to the nearest valid approved directory; a valid override persists and heals later commands.

- [ ] Reproduce the deleted-cwd behavior against the owning implementation and identify whether it is BB-owned or provider-owned.
- [ ] If BB-owned, add a failing lifecycle regression and implement recovery; if provider-owned, add BB-side defensive instruction/diagnostic only where it measurably changes behavior and document the external blocker.
- [ ] Run the owning suite and original disposable reproduction.
- [ ] Commit the verified mitigation.

### Task 9: Clone source history into fork timelines

**Files:**
- Modify: `packages/db/src/data/events.ts`
- Modify: `packages/db/test/data/events.test.ts`
- Modify: `apps/server/src/services/threads/thread-fork.ts`
- Modify: `apps/server/test/threads/thread-create-seed-without-run.test.ts`

**Interfaces:**
- Consumes: source thread events through `sourceSeqEnd` and a newly created fork thread ID.
- Produces: cloned, parseable events with fork-local IDs/sequences and a normal post-commit thread-change notification, without copying live/pending-only state.

- [ ] Add DB and public fork regressions proving an idle fork renders inherited history and honors `sourceSeqEnd`.
- [ ] Observe the empty-timeline failures.
- [ ] Implement an immediate-transaction event clone and invoke it at fork creation before response publication.
- [ ] Run DB, server, thread-view, CLI, and SDK fork tests/typechecks/builds.
- [ ] Commit as `feat(threads): clone timeline history into forks`.

### Task 10: Full verification and review

**Files:**
- Modify only files required by verified failures.

**Interfaces:**
- Produces: a clean branch with review findings addressed and fresh verification evidence.

- [ ] Run formatting, lint, typecheck, build, unit, integration, and package-smoke gates with logs captured under `/tmp`.
- [ ] Reproduce the original high-risk symptoms where deterministic harnesses exist.
- [ ] Review the complete diff for security, data-loss, protocol, migration, and stale-generated-output risks.
- [ ] Fix review findings with regression-first cycles.
- [ ] Re-run every affected and full gate, then report exact results and remaining external limitations.
