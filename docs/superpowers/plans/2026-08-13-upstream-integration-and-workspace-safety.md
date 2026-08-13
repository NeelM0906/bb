# Upstream Integration and Workspace Safety Completion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the latest `get-bb/bb` `main`, preserve the fork's critical-stability invariants, finish protected unmanaged-workspace mutation leases, and publish a fully verified branch.

**Architecture:** Treat upstream as the new product baseline and reconcile the fork's stability work by invariant rather than blindly preferring either side. Keep host capacity admission and path-scoped workspace leases as separate durable gates joined at the common provider-work dispatch seam. Regenerate Drizzle migrations from the reconciled schema after upstream's migration history is present.

**Tech Stack:** TypeScript, React, Node.js, better-sqlite3/Drizzle, Zod, Vitest, Turbo, Electron, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-12-critical-stability-tranche-design.md`

## Global Constraints

- Follow `AGENTS.md`, including Turbo-only build and typecheck commands.
- Preserve every invariant in the critical-stability design while adopting upstream fixes that supersede implementation details.
- Keep the current unfinished workspace-safety tree recoverable on a checkpoint branch before integration.
- Do not hand-edit Drizzle snapshots; regenerate migrations and snapshots from the final schema.
- Any daemon/server wire change requires the current upstream protocol version to be incremented and its mismatch tests updated.
- Database tests use migrated SQLite connections, never database mocks.
- Every regression repair is supported by a focused failing or already-failing test and a passing rerun.
- Do not publish until formatting, lint, typecheck, build, unit tests, integration tests, and original-symptom checks are fresh and green.

---

### Task 1: Checkpoint unfinished work and create the isolated integration workspace

**Files:**
- Modify: `.gitignore`
- Create: `docs/superpowers/plans/2026-08-13-upstream-integration-and-workspace-safety.md`
- Checkpoint: every currently modified/untracked workspace-safety file

**Interfaces:**
- Produces: branch `wip/workspace-safety-before-upstream` with one recoverable checkpoint commit; worktree `.worktrees/upstream-integration` on `integration/upstream-2026-08-13` from `origin/main`.

- [ ] **Step 1: Record the current tree.** Run `git status --short`, `git diff --check`, and `git diff --stat`; confirm no unrelated path appeared after the audit.
- [ ] **Step 2: Create the checkpoint branch.** Run `git switch -c wip/workspace-safety-before-upstream` and commit the complete dirty tree as `wip: checkpoint unmanaged workspace safety`.
- [ ] **Step 3: Verify worktree isolation.** Confirm `.worktrees/` is ignored with `git check-ignore -q .worktrees`.
- [ ] **Step 4: Create the integration worktree.** Run `git worktree add .worktrees/upstream-integration -b integration/upstream-2026-08-13 origin/main`.
- [ ] **Step 5: Establish the baseline.** Reuse the repository dependency store, run `pnpm install --offline --frozen-lockfile`, then run focused baseline typechecks for `@bb/agent-runtime`, `@bb/host-daemon`, `@bb/server`, and `@bb/db`.

### Task 2: Merge upstream and resolve critical-stability conflicts by invariant

**Files:**
- Modify conflict set reported by `git merge-tree`, concentrated in:
  - `packages/agent-runtime/src/runtime-provider-process.ts`
  - `packages/agent-runtime/src/runtime.ts`
  - `packages/agent-runtime/src/pi/bridge/sdk-session.ts`
  - `apps/host-daemon/src/runtime-manager.ts`
  - `apps/server/src/routes/threads/base.ts`
  - `packages/host-daemon-contract/src/commands.ts`
  - `packages/thread-view/src/completed-turn-grouping.ts`
  - associated tests and migration metadata

**Interfaces:**
- Consumes: latest fetched `upstream/main` and the existing critical-stability design.
- Produces: a merge commit whose tree contains upstream product changes plus fork-only lifecycle, admission, read-worker, canonical-path, migration-repair, and timeline guarantees.

- [ ] **Step 1: Merge without committing.** Run `git merge --no-ff --no-commit upstream/main` and list unresolved files with `git diff --name-only --diff-filter=U`.
- [ ] **Step 2: Resolve provider finalization.** Keep upstream's newer process-exit settlement and provider APIs while preserving generation-safe stdout/stderr finalization, bounded inherited-pipe cleanup, diagnostics, and shared-provider reaping.
- [ ] **Step 3: Resolve Pi lifecycle.** Keep upstream checkpoint-return behavior and bridge changes while preserving bind-before-use, idempotent concurrent close, exactly-once shutdown, and a graceful-close deadline that also bounds extension shutdown.
- [ ] **Step 4: Resolve runtime/daemon settlement.** Combine upstream pre-start/prompt settlement fixes with pending-turn snapshots, stale ACP steer handling, process diagnostics, host reservation validation, and the current protocol contract.
- [ ] **Step 5: Resolve timeline and server reads.** Retain upstream context-cleared/ownership projection and routing improvements alongside visible assistant prose and off-event-loop read-worker behavior.
- [ ] **Step 6: Resolve schema history temporarily.** Accept upstream journal and migration `0093`; leave workspace-safety schema absent until Task 3 generates its migration against the reconciled baseline.
- [ ] **Step 7: Verify the merge tree.** Run `rg -n '^(<<<<<<<|=======|>>>>>>>)'` over tracked source files, focused runtime/daemon/thread-view tests, and package typechecks.
- [ ] **Step 8: Commit the upstream merge.** Commit as `merge: integrate upstream bb main`.

### Task 3: Reapply and complete unmanaged-workspace mutation safety

**Files:**
- Reapply from checkpoint and modify:
  - `packages/db/src/schema.ts`
  - `packages/db/src/data/unmanaged-workspace-mutation-leases.ts`
  - `apps/server/src/services/threads/work-admission.ts`
  - `apps/host-daemon/src/command-router.ts`
  - `packages/server-contract/src/api/projects.ts`
  - `packages/server-contract/src/api/threads.ts`
  - `apps/app/src/views/ProjectSettingsView.tsx`
  - CLI, SDK, guide, and test surfaces from the checkpoint
- Regenerate: next available `packages/db/drizzle/NNNN_*.sql`, snapshot, and `_journal.json`

**Interfaces:**
- Produces: project policy `protectUnmanagedWorkspace`; unique lease keyed by `(hostId, canonicalPath)`; FIFO waiter promotion; consistent API/SDK/CLI/UI wait state.

- [ ] **Step 1: Apply the checkpoint without committing.** Cherry-pick the WIP commit with `--no-commit`, resolve upstream overlaps using current contracts, and exclude the old `0093`/`0094` migration artifacts.
- [ ] **Step 2: Restore the API policy surface.** Add required project response state with a false database default, partial update request support, SDK/CLI/UI controls, documentation, and all typed fixture defaults.
- [ ] **Step 3: Restore lease persistence.** Add lease, waiter, and audit-event schema plus transaction-safe acquire/cancel/release/recovery data functions.
- [ ] **Step 4: Fix cancellation wake-up.** Ensure cancelling a workspace waiter wakes its in-process admission loop and that the loop re-reads terminal state instead of hanging.
- [ ] **Step 5: Enforce daemon fail-closed admission.** For `thread.start` and `turn.submit`, reject both an absent controller and an invalid reservation before any provider dispatch.
- [ ] **Step 6: Preserve atomic promotion.** Release by generation and promote exactly one FIFO waiter in the same immediate transaction; signal the promoted workspace and host capacity loops after commit.
- [ ] **Step 7: Repair tests and fixtures.** Add `protectUnmanagedWorkspace: false` to every typed fixture; rewrite the telemetry and durable-admission assertions so each action has valid provider identity and independently persisted work.
- [ ] **Step 8: Regenerate migrations.** Run the repository Drizzle generation command against the reconciled schema and verify migration tests cover both the upstream `0093` and the newly generated tail.
- [ ] **Step 9: Run focused verification.** Run DB lease/admission tests, server dispatch/recovery tests, host router/controller tests, app/CLI/SDK/contract typechecks, and formatting.
- [ ] **Step 10: Commit the completed feature.** Commit as `feat(workspaces): serialize protected unmanaged mutations`.

### Task 4: Reconcile superseded and duplicate stability implementations

**Files:**
- Modify only files identified by comparison or failing tests in agent runtime, host daemon, server read worker, migration recovery, and thread view.

**Interfaces:**
- Produces: one implementation per invariant with no dead parallel path and no fork regression hidden by upstream refactors.

- [ ] **Step 1: Compare unique fork commits.** Run `git cherry -v upstream/main HEAD` and map each remaining `+` commit to a preserved invariant or an implementation superseded by upstream.
- [ ] **Step 2: Exercise original provider symptoms.** Run focused tests for failed startup finalization, inherited pipes, pre-start exit, prompt completion without start, stale steer, shared idle reaping with background work, and hung Pi extension shutdown.
- [ ] **Step 3: Exercise database/server symptoms.** Run migration-tail recovery, worker parity/cancellation/crash, large timeline responsiveness, work-admission restart reconciliation, and workspace lease recovery tests.
- [ ] **Step 4: Exercise timeline symptoms.** Run assistant/tool/assistant ordering, subagent projection, context-cleared events, whole-item ownership, CLI snapshots, and public conversation outline tests.
- [ ] **Step 5: Remove only proven duplication.** Delete a fork path only when upstream tests and the design invariant demonstrate equivalent or stronger behavior; otherwise adapt the fork path to upstream APIs.
- [ ] **Step 6: Commit reconciliation changes.** Commit as `fix: reconcile stability guarantees with upstream` when code changes exist.

### Task 5: Full verification and publication

**Files:**
- Modify only code/tests/docs required by failures from the acceptance gates.
- Update this plan's checkboxes after evidence exists.

**Interfaces:**
- Produces: pushed branch `integration/upstream-2026-08-13` and a pull request against `NeelM0906/bb:main`.

- [ ] **Step 1: Run repository formatting and lint.** Run `pnpm exec prettier . --check --ignore-unknown` and `pnpm exec turbo run lint --force`, saving long output under `/tmp`.
- [ ] **Step 2: Run full typecheck and build.** Run `pnpm exec turbo run typecheck --force` and `pnpm exec turbo run build --force`.
- [ ] **Step 3: Run full unit and integration suites.** Run `pnpm exec turbo run test --force` and `env -u OPENAI_API_KEY pnpm exec turbo run test:integration --force`.
- [ ] **Step 4: Run manual/local symptom checks.** Exercise server startup/migration on a copied database, provider stop/restart and idle reap, protected same-path concurrency/cancellation/recovery, and timeline rendering with multiple assistant blocks.
- [ ] **Step 5: Review the final diff.** Run `git diff origin/main...HEAD --check`, inspect generated migrations, verify no secret or temporary artifacts, and confirm every spec invariant maps to code plus evidence.
- [ ] **Step 6: Fix and rerun.** Address every failure and repeat the complete affected gate; then rerun the full acceptance commands fresh.
- [ ] **Step 7: Push and open the PR.** Push `integration/upstream-2026-08-13`, create a PR containing the required `> AGENT GENERATED: by GPT-5.6` footer, and inspect all available checks/review threads.
- [ ] **Step 8: Address remote feedback.** Fix actionable review or CI failures, reply on threads, rerun verification, and push until the PR is clean.
