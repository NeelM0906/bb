# Critical Stability Tranche Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make BB start safely, settle provider work reliably, bound provider and database impact, serialize mutations to shared unmanaged workspaces, and keep every assistant reply visible.

**Architecture:** Land eight root-cause repairs as independently reviewable changes. Provider lifecycle changes converge on host-daemon ownership and one coordinated protocol bump; database work uses fail-closed migration repair plus a server read worker; workspace safety uses durable path-scoped leases; message visibility is fixed in shared projection.

**Tech Stack:** TypeScript, Node.js worker threads, better-sqlite3/Drizzle, Vitest, React, Zod contracts, Turbo, Electron/host-daemon RPC.

## Global Constraints

- Follow `/Users/zidane/BB/bb/AGENTS.md`.
- Use `pnpm exec turbo run <task> --filter=@bb/<package>` for builds and typechecks.
- Test databases use migrated SQLite connections; do not mock the database.
- Every behavior change follows RED → GREEN → refactor and records the failing and passing command.
- Validate every worker, RPC, and API boundary; do not add optional fields to hide version skew.
- All daemon/server wire changes share one protocol bump from `106` to `107`.
- Security-only expansion and unrelated refactoring are out of scope.
- Every task ends with a focused commit and a clean task review.

---

### Task 1: Repair only unambiguous missing migration tails

**Files:**
- Modify: `packages/db/src/migrate.ts`
- Modify: `packages/db/test/migrate.test.ts`

**Interfaces:**
- Consumes: existing `readExpectedAppliedMigrations`, `readAppliedMigrationCreatedAts`, `applyMigrationStatements`, and migration validation.
- Produces: `replayMissingCanonicalTailAfterLatestAppliedCanonicalMigration(db, migrationsFolder): void`, called after Drizzle and known collision repairs.

- [ ] **Step 1: Add failing migration-history tests.** Add literal fixtures proving: a future branch row skips one or several canonical tail migrations; an interior gap, wrong canonical hash, and a ledger with no canonical anchor do not replay; a failed DDL migration never receives a ledger success row.
- [ ] **Step 2: Run RED.** Run `pnpm exec vitest run packages/db/test/migrate.test.ts`. Confirm the missing-tail fixture throws the current incomplete-history error while ambiguity fixtures still fail closed.
- [ ] **Step 3: Implement suffix discovery.** Precompute the newest applied canonical journal entry, validate unique increasing timestamps, require all missing canonical entries to form a suffix, and return without repair if there is no canonical anchor.
- [ ] **Step 4: Replay the suffix.** Apply candidates in journal order through the existing transactional helper, leaving known collision repairs before this generic repair and validation after it.
- [ ] **Step 5: Run GREEN and package gates.** Run the focused test, then `pnpm exec turbo run test typecheck --filter=@bb/db --force` and `git diff --check`.
- [ ] **Step 6: Commit.** Commit only DB migration code/tests as `fix(db): replay skipped canonical migration tails`.

### Task 2: Keep every assistant prose block visible

**Files:**
- Modify: `packages/thread-view/src/timeline-message-helpers.ts`
- Modify: `packages/thread-view/test/completed-turn-grouping.test.ts`
- Modify: `packages/thread-view/test/completed-turn-summary-rendering.test.ts`
- Modify if snapshots change: `packages/thread-view/test/timeline-cli-rendering.snapshots.test.ts`
- Modify: `apps/server/test/public/public-thread-data.test.ts`

**Interfaces:**
- Consumes: `isTimelineUngroupableMessage(message)` and existing assistant conversation rows.
- Produces: all non-empty `assistant-text` messages as top-level conversation boundaries; tool activity alone remains summarizable.

- [ ] **Step 1: Add failing projection tests.** Build literal assistant₁ → command → assistant₂ and assistant₁ → assistant₂ fixtures. Assert top-level text order, one intervening work summary, no empty `Worked` row, and summary counts excluding prose.
- [ ] **Step 2: Run RED.** Run the two focused thread-view test files and confirm assistant₁ is currently nested/grouped.
- [ ] **Step 3: Change shared grouping policy.** Make every non-empty `assistant-text` ungroupable without changing system/steer grouping or app rendering.
- [ ] **Step 4: Add public/CLI coverage.** Assert conversation outline and CLI rendering contain both prose blocks in order; update only snapshots whose old output encoded hidden prose.
- [ ] **Step 5: Run GREEN and package gates.** Run `pnpm exec turbo run test typecheck --filter=@bb/thread-view --filter=@bb/server --force` and `git diff --check`.
- [ ] **Step 6: Commit.** Commit as `fix(timeline): keep assistant prose visible`.

### Task 3: Bind and shut down Pi extensions correctly

**Files:**
- Modify: `packages/agent-runtime/src/pi/bridge/sdk-session.ts`
- Modify: `packages/agent-runtime/src/pi/bridge/__tests__/sdk-session.test.ts`
- Create: `packages/agent-runtime/src/pi/bridge/__tests__/sdk-session-lifecycle.test.ts`
- Modify: `packages/agent-runtime/src/pi/bridge/__tests__/bridge.test.ts`

**Interfaces:**
- Consumes: Pi `AgentSession.bindExtensions`, `extensionRunner.emit`, `hasExtensionHandlers`, and `dispose`.
- Produces: one awaited `disposeSession(session): Promise<void>` lifecycle and extension binding before prompts.

- [ ] **Step 1: Add a real fixture extension.** Record `session_start` and `session_shutdown` to a temporary marker for new and persisted sessions; add a repeated-close assertion.
- [ ] **Step 2: Run RED.** Run the lifecycle test and confirm `session_start` is absent on current code.
- [ ] **Step 3: Bind extensions before use.** Await `bindExtensions({ mode: "rpc" })` immediately after session creation and before tool activation/subscription exposure.
- [ ] **Step 4: Centralize awaited disposal.** Emit shutdown when registered, dispose in `finally`, clear ownership before awaiting, and make normal close/replacement idempotent. Constrain emergency stop to best-effort cleanup without double disposal.
- [ ] **Step 5: Run GREEN and package gates.** Run Pi bridge tests plus `pnpm exec turbo run test typecheck --filter=@bb/agent-runtime --force`.
- [ ] **Step 6: Commit.** Commit as `fix(pi): honor extension session lifecycle`.

### Task 4: Settle pre-start provider exits and stale ACP steers

**Files:**
- Modify: `packages/agent-runtime/src/types.ts`
- Modify: `packages/agent-runtime/src/runtime.ts`
- Modify: `packages/agent-runtime/src/runtime.process-lifecycle.test.ts`
- Modify: `packages/agent-runtime/src/acp/bridge/bridge.ts`
- Modify: `packages/agent-runtime/src/acp/bridge/bridge.test.ts`
- Modify: `packages/agent-runtime/src/runtime.lifecycle.test.ts`
- Modify: `apps/host-daemon/src/runtime-manager.ts`
- Modify: `apps/host-daemon/src/runtime-manager.test.ts`
- Modify fixtures in: `apps/host-daemon/src/app.test.ts`, `apps/host-daemon/test/command/thread-dispatch.test.ts`
- Modify: `packages/host-daemon-contract/src/commands.ts`
- Modify: `packages/host-daemon-contract/test/contract.test.ts`

**Interfaces:**
- Produces: required `AgentRuntimeProcessExitThreadState.pendingTurnStart: boolean`; ACP-only stale steer classification; `HOST_DAEMON_PROTOCOL_VERSION = 107`.

- [ ] **Step 1: Add failing exit-boundary tests.** Crash a provider after accepted dispatch but before `turn/started`; assert the exit snapshot flag and exactly one thread-scoped `provider_process_exited` event.
- [ ] **Step 2: Add failing ACP race tests.** Exercise completion racing `turn/steer`; assert no-active-turn/session maps to stale while auth/transport errors remain errors and prompt failure settles once.
- [ ] **Step 3: Run RED.** Run focused runtime, ACP bridge, runtime-manager, and contract tests and record expected failures.
- [ ] **Step 4: Implement exit snapshot and reconciliation.** Capture pending start state and emit the existing thread-scoped error only for pending/no-active exits; keep existing active and idle behavior.
- [ ] **Step 5: Implement ACP-owned classification.** Return the existing stale result for only structured no-active turn/session errors; do not emit an additional completion event.
- [ ] **Step 6: Bump and verify protocol.** Change 106→107 and update exact contract fixtures/version tests.
- [ ] **Step 7: Run GREEN and gates.** Run Turbo test/typecheck for agent-runtime, host-daemon, and host-daemon-contract plus relevant server lifecycle tests.
- [ ] **Step 8: Commit.** Commit as `fix(runtime): settle provider lifecycle races`.

### Task 5: Make provider finalization generation-safe and observable

**Files:**
- Modify: `packages/agent-runtime/src/runtime-provider-process.ts`
- Modify: `packages/agent-runtime/src/runtime.process-lifecycle.test.ts`
- Modify: `packages/agent-runtime/src/runtime.ts`
- Modify: `packages/agent-runtime/src/types.ts`
- Modify: `apps/host-daemon/src/runtime-manager.ts`
- Modify: `apps/host-daemon/src/runtime-manager.test.ts`
- Modify: `apps/host-daemon/src/app.ts`
- Modify: `apps/host-daemon/src/app.test.ts`

**Interfaces:**
- Produces: generation-tagged provider process/session diagnostics and bounded awaited exit finalization; all direct provider children map to current owners or an idle reuse deadline.

- [ ] **Step 1: Add failing process tests.** Cover final stdout/stderr drain, grace expiry with inherited pipes, late output after replacement, replacement waiting for finalization, shared-provider active session protection, and repeated thread creation followed by idle reap.
- [ ] **Step 2: Run RED.** Run focused lifecycle tests and confirm stale output/hanging or ownership assertions fail.
- [ ] **Step 3: Harden finalization.** Track a process generation, gate callbacks on current ownership, close readline and destroy streams at grace expiry, and await finalization before replacement/shutdown.
- [ ] **Step 4: Add provider lease diagnostics.** Expose direct PID, provider/environment, hosted sessions, owning thread/turn, generation, and idle deadline through runtime-manager diagnostics; reclaim a shared process only when all sessions are idle.
- [ ] **Step 5: Run GREEN and gates.** Run agent-runtime and host-daemon focused/full tests and typechecks.
- [ ] **Step 6: Commit.** Commit as `fix(host): own and finalize provider processes`.

### Task 6: Add host-wide admission reservations and durable waiting

**Files:**
- Create: `apps/host-daemon/src/host-admission-controller.ts`
- Create: `apps/host-daemon/src/host-admission-controller.test.ts`
- Modify: `apps/host-daemon/src/command-router.ts`
- Modify: `apps/host-daemon/src/command-router.test.ts`
- Modify: `apps/host-daemon/src/command-dispatch.ts`
- Modify: `packages/host-daemon-contract/src/commands.ts`
- Modify: `packages/host-daemon-contract/test/contract.test.ts`
- Add schema/data files under: `packages/db/src/schema.ts`, `packages/db/src/data/`
- Add migration under: `packages/db/src/migrations/`
- Modify shared dispatch services under: `apps/server/src/services/threads/`
- Modify: `packages/server-contract/src/`, `packages/sdk/src/areas/threads.ts`, `apps/cli/src/commands/thread.ts`

**Interfaces:**
- Produces: reservation `{ token, generation, hostId, reason }`; durable FIFO waiting records; one configured host slot limit; server-visible waiting reason.

- [ ] **Step 1: Add failing controller and contract tests.** Prove one atomic limit across interactive, child, automation, queued, and resumed sources; idle lease reclamation; FIFO; stale token rejection; and previous-protocol mismatch.
- [ ] **Step 2: Add failing server recovery tests.** Persist waiters, restart server/daemon, and assert every item becomes waiting, running with a valid reservation, or terminal with a reason.
- [ ] **Step 3: Run RED.** Run focused contract, daemon, DB, server, SDK, and CLI tests.
- [ ] **Step 4: Implement atomic host reservations.** Add a host-daemon controller around command admission with explicit slot count and provider-lease usage; reclaim idle providers before returning unavailable.
- [ ] **Step 5: Implement durable server queue.** Persist FIFO work with reservation generation and waiting reason, promote after release, and dispatch post-commit with idempotent recovery.
- [ ] **Step 6: Route every work source.** Ensure interactive, child, automation SDK, queued send, and resume paths pass through the common reservation seam.
- [ ] **Step 7: Surface status.** Extend server contract, SDK, CLI, and existing thread status UI data without adding a parallel state model.
- [ ] **Step 8: Run GREEN and gates.** Run focused packages, integration tests for all work-source pairs, and protocol tests.
- [ ] **Step 9: Commit.** Commit as `feat(host): enforce global work admission`.

### Task 7: Move heavy SQLite reads off the server event loop

**Files:**
- Create: `apps/server/src/db-read-worker/protocol.ts`
- Create: `apps/server/src/db-read-worker/worker.ts`
- Create: `apps/server/src/db-read-worker/service.ts`
- Create tests under: `apps/server/test/db-read-worker/`
- Modify: `apps/server/src/services/threads/timeline.ts`
- Modify: `apps/server/src/routes/threads/data.ts`
- Modify thread-list/sidebar services under: `apps/server/src/services/threads/`
- Modify server lifecycle/bootstrap files that own DB resources.

**Interfaces:**
- Produces: validated operations `timelineSnapshot` and `threadListSnapshot`; bounded FIFO worker service with cancellation, deadline, restart, and shutdown.

- [ ] **Step 1: Add parity and responsiveness tests.** On a migrated file-backed DB, compare direct and worker results, assert snapshot consistency during a writer, and prove a timer/health request completes before an intentionally slow read.
- [ ] **Step 2: Add lifecycle/backpressure tests.** Cover readiness, FIFO queue cap, queued cancellation, detached in-flight cancellation, timeout replacement, malformed worker output, crash/restart, and clean shutdown.
- [ ] **Step 3: Run RED.** Run new server tests and confirm no worker service exists/event loop blocks.
- [ ] **Step 4: Implement validated worker protocol/service.** Open read-only/query-only WAL connection, execute each multi-query operation in one deferred read transaction, and validate both directions.
- [ ] **Step 5: Move full expensive operations.** Execute DB reads, JSON decode, compaction, and projection in the worker; retain live-state overlay and cache/delta mutation on the main loop.
- [ ] **Step 6: Integrate timeline and thread-list paths.** Route production endpoints through the service while retaining query-plan guards and exact response contracts.
- [ ] **Step 7: Run GREEN and performance gates.** Run server tests/typecheck/build, integration tests, large file-backed responsiveness, repeated reads for RSS bounds, and query-plan tests.
- [ ] **Step 8: Commit.** Commit as `perf(server): isolate heavy sqlite reads`.

### Task 8: Persist canonical unmanaged workspace identity and mutation leases

**Files:**
- Modify: `packages/host-daemon-contract/src/commands.ts`
- Modify: `packages/host-daemon-contract/test/contract.test.ts`
- Modify unmanaged provisioning in: `packages/host-workspace/src/provision.ts`
- Modify: `apps/host-daemon/src/command-handlers/environment.ts`
- Modify environment schema/data under: `packages/db/src/schema.ts`, `packages/db/src/data/`
- Add migration under: `packages/db/src/migrations/`
- Create: `apps/server/src/services/threads/workspace-mutation-leases.ts`
- Create server tests for lease acquisition/recovery.
- Modify shared thread send/start/recovery services.
- Modify: `packages/server-contract/src/`, `packages/sdk/src/areas/threads.ts`, `apps/cli/src/commands/thread.ts`
- Modify: `apps/app/src/components/promptbox/banner/ThreadPromptContextBanner.tsx`
- Modify: `apps/app/src/components/promptbox/banner/ThreadPromptContextBanner.test.tsx`

**Interfaces:**
- Produces: canonical real path on unmanaged provision; unique current lease by `(hostId, canonicalPath)`; generation-checked FIFO waiters and auditable transitions.

- [ ] **Step 1: Add failing canonicalization tests.** Prove symlink and alternate spelling resolve to the same host-reported path and managed worktrees remain unchanged.
- [ ] **Step 2: Add failing lease race/recovery tests.** Concurrently acquire through manual/manual, manual/automation, automation/automation, child, queued, and resumed paths; cover FIFO, cancel, steer by holder, stale generation, grace disconnect, confirmed loss, and restart.
- [ ] **Step 3: Run RED.** Run focused host-workspace, contract, DB, server, SDK, CLI, app, and integration tests.
- [ ] **Step 4: Persist canonical identity and policy.** Add required wire/result field and environment persistence; add explicit project protection policy and physical-path activation rule.
- [ ] **Step 5: Implement transaction-safe lease service.** Use a unique DB key and immediate transaction for acquisition/accepted request/running transition; generation-check release and atomically promote one waiter.
- [ ] **Step 6: Integrate the common dispatch seam.** Cover every work source without treating current permission modes as read-only; retain lease through disconnect grace and reconcile daemon-reported work before startup reclamation.
- [ ] **Step 7: Surface owner/wait state.** Add consistent API, SDK, CLI, UI, and audit data using existing lifecycle status patterns.
- [ ] **Step 8: Run GREEN and gates.** Run focused/full packages and the complete concurrency/recovery matrix.
- [ ] **Step 9: Commit.** Commit as `feat(workspaces): serialize unmanaged mutations`.

### Task 9: Cross-track integration, manual symptom verification, and cleanup

**Files:**
- Modify only tests/docs required by verified integration findings.
- Update: `docs/superpowers/plans/2026-08-12-critical-stability-tranche.md` checkboxes/ledger through the SDD workspace, not with unverified claims.

**Interfaces:**
- Consumes: Tasks 1–8.
- Produces: one verified branch with no open Critical/Important review findings.

- [ ] **Step 1: Run formatting and static gates.** Run `pnpm exec prettier . --check --ignore-unknown`, `pnpm exec turbo run lint --force`, `pnpm exec turbo run typecheck --force`, and `pnpm exec turbo run build --force`, saving slow output under the plan workspace.
- [ ] **Step 2: Run test gates.** Run `pnpm exec turbo run test --force`, `env -u OPENAI_API_KEY pnpm exec turbo run test:integration --force`, and package smoke tasks. Reproduce any failure on base before classifying it as pre-existing.
- [ ] **Step 3: Run original-symptom exercises.** Verify migration recovery on a copied fixture DB; Pi lifecycle with lazy MCP; pre-start crash; ACP late steer; process reuse/expiry and admission; large-DB health responsiveness; workspace lease concurrency; and multi-block Stop-hook rendering.
- [ ] **Step 4: Run protocol/restart matrix.** Exercise previous/current daemon mismatch, daemon loss/reconnect, server restart with waiters/leases, and confirm no invalid-message reconnect loop.
- [ ] **Step 5: Request whole-branch reviews.** Run general, TypeScript, and security reviewers; fix every Critical/Important finding and re-run affected tests.
- [ ] **Step 6: Re-run fresh final gates.** Repeat all commands that support completion claims and record exit codes/test counts.
- [ ] **Step 7: Commit integration-only changes.** Commit as `test: verify critical stability tranche` if integration changes exist; otherwise leave no empty commit.
