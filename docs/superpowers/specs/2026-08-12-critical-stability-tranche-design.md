# Critical Stability Tranche Design

## Status

Approved design for the `stability/critical-tranche` branch.

This tranche addresses eight release-critical stability areas:

1. Startup migration recovery.
2. Pi extension lifecycle.
3. Provider exits before a turn starts.
4. ACP steering races.
5. Provider cleanup and host admission.
6. SQLite event-loop stalls.
7. Exclusive mutation leases for unmanaged workspaces.
8. Hidden assistant replies.

Security-only hardening, unrelated features, broad UI performance work, and
platform packaging are outside this tranche.

## Objectives and invariants

The finished system must preserve these invariants:

- A known, unambiguous missing canonical migration tail can repair itself at
  startup; ambiguous or incompatible histories still fail closed.
- Pi extensions receive `session_start` before the first prompt and
  `session_shutdown` before their session is disposed.
- A provider process exit always settles accepted work, including the window
  before `turn/started` exists.
- A late ACP steer is retried as a new turn only when the ACP session or turn is
  genuinely stale. Other provider errors remain errors.
- Every resident provider process has one observable host-daemon owner and a
  bounded lifetime.
- Interactive work, child threads, automations, and resumed work use one host
  admission policy; no work source bypasses capacity.
- Expensive SQLite reads do not execute on the server event loop.
- At most one mutation-capable run can own a protected unmanaged physical
  workspace at a time, across projects and work sources.
- Every non-empty assistant prose block is visible at rest and in source order.

## Delivery model

The tranche is split into independently testable changes. Each change begins
with a regression test that fails for the observed defect, implements the
smallest root-cause fix, and passes focused verification before integration.
Upstream pull requests are reference material rather than merge units. Stale,
conflicted, polluted, or reviewed-as-unsafe portions are not imported.

The implementation lands in this order where dependencies overlap:

1. Migration recovery and assistant-reply correctness.
2. Pi lifecycle, pre-start exit settlement, and ACP stale steering.
3. Provider-process finalization and observable provider leases.
4. Host admission and durable queue integration.
5. SQLite read isolation.
6. Unmanaged-workspace mutation leases.
7. Cross-track integration and recovery verification.

Independent steps may be developed in parallel, but changes that touch the
same runtime or server dispatch seams are integrated sequentially and reviewed
after every step.

## A. Startup migration recovery

### Problem

Drizzle uses the maximum `created_at` value in `__drizzle_migrations` as a
global high-water mark. A newer branch-local ledger row can therefore cause a
published canonical migration tail to be skipped. BB then detects the missing
canonical timestamps and refuses to start.

### Design

After Drizzle and the existing known collision repairs run, BB may replay a
missing canonical tail only when all of the following are true:

- At least one canonical journal migration is already applied and can serve as
  an anchor.
- Every missing canonical migration occurs strictly after the newest applied
  canonical migration.
- The missing entries form a contiguous suffix of the canonical journal.
- Canonical journal timestamps are unique and strictly increasing.
- No existing row at a canonical timestamp has a different hash.

The candidate suffix is computed before mutation. Its migrations are applied
in canonical journal order using the existing migration statement and ledger
helpers. Existing special-case repairs remain before this generic tail repair
because they understand known schema collisions that ledger inference cannot.

If there is no canonical anchor, an older interior hole, a hash mismatch, or an
incompatible DDL collision, startup remains fail-closed with actionable
diagnostics. The repair must not infer that an arbitrary partial schema is a
fresh database.

No server/daemon protocol or public contract changes are required.

### Verification

- Exact 0.35.1/0.36.0-style missing-tail fixture with a future branch row.
- Multiple missing canonical tail entries.
- Far-future branch row.
- Wrong hash at a canonical timestamp remains an error.
- Older interior hole remains an error without applying later schema changes.
- No canonical anchor does not replay the journal.
- A failing migration does not receive a ledger success row and is retryable.
- A repaired database reaches the current latest canonical migration.
- Existing migration and known branch-history tests continue to pass.

## B. Pi extension lifecycle

### Problem

The native Pi bridge constructs an `AgentSession` directly but does not bind
configured extensions. Consequently `session_start` never fires and extensions
such as lazy MCP adapters remain uninitialized. Direct disposal also bypasses
`session_shutdown`.

### Design

`PiSdkSession.start()` binds extensions in RPC mode after session construction
and before tools are activated or a prompt can be accepted. All normal teardown
and replacement paths use one awaited async disposal helper that:

1. Emits `session_shutdown` when handlers exist.
2. Awaits extension cleanup.
3. Disposes the Pi session in a `finally` block.
4. Ensures disposal happens at most once.

Emergency synchronous stop paths may initiate best-effort cleanup, but normal
bridge shutdown and replacement must await it. A replacement cannot attach
handlers while the replaced session is still shutting down.

This is local to the Pi provider bridge and requires no wire change.

### Verification

- A real fixture extension records `session_start` before the first prompt.
- Normal close records exactly one `session_shutdown`.
- Persisted-session replacement records shutdown before the next start.
- Repeated close/stop calls do not double-dispose.
- A lazy `pi-mcp-adapter` configuration reports status without an eager or
  keep-alive lifecycle workaround.
- Pi bridge tests, package typecheck, and provider smoke tests pass.

## C. Provider exit before `turn/started`

### Problem

The runtime tracks accepted turn starts in `pendingTurnStartThreadIds`, but the
provider-exit snapshot omits that state. The host daemon therefore mistakes a
provider that dies after turn dispatch but before `turn/started` for an idle
session and emits no terminal event. The thread can remain `Working` until a
long command timeout.

### Design

Add a required `pendingTurnStart` field to the runtime process-exit thread
snapshot. On an unexpected exit:

- A thread with an active turn retains the existing turn-scoped failed
  completion/error behavior.
- A thread with no active turn and `pendingTurnStart=true` receives exactly one
  thread-scoped `provider_process_exited` system error.
- An actually idle thread emits no new error.

The changed daemon-to-server event behavior receives the tranche's coordinated
host-daemon protocol bump. The implementation uses the current protocol number
as its base; stale PR protocol values are not reused.

### Verification

- A real provider fixture exits after dispatch and before `turn/started`.
- The exit snapshot carries `pendingTurnStart=true`.
- The daemon emits one thread-scoped error and the server transitions the
  thread from active to error promptly.
- Active-turn exits still produce their existing terminal sequence exactly
  once.
- Idle provider exits remain silent.
- Current/previous daemon protocol mismatch triggers the expected update path.

## D. ACP stale steering

### Problem

The runtime can observe an active turn immediately before the ACP bridge
settles it. A following steer then receives “no active turn” or “no active ACP
session.” Treating this narrow race as a hard failure loses the follow-up even
though BB can safely start a new turn.

### Design

ACP owns classification of its command errors. For `turn/steer`, only the
structured equivalents of “no active turn” and “no active session” map to the
existing stale result. The runtime clears only matching local active-turn state
and returns that result. The host daemon's existing auto/steer fallback starts
a new turn.

Authentication failures, malformed replies, transport failures, and unrelated
provider errors remain hard errors. The implementation must not add another
`turn/completed` event when the existing ACP error event translation already
settles the failed prompt.

### Verification

- A completion/steer race returns stale and starts one new turn.
- No follow-up message is duplicated or lost.
- Prompt failure settles exactly once.
- Unrelated ACP rejection remains an error.
- Concurrency tests cover completion arriving before, during, and after steer.

## E. Provider ownership, cleanup, and host admission

### Problem

Provider ownership is fragmented across environment runtimes. Idle reaping is
infrequent and provider-specific, process finalization can leave old streams
alive, and BB has no shared capacity gate across interactive work, child
threads, automations, and resumptions.

### Provider finalization

Provider replacement and shutdown use an awaited finalization state. Final
stdout/stderr is drained for a bounded grace period. At expiry, readline
interfaces are closed, old streams are destroyed, and callbacks are ignored
unless their process generation is still the current registry entry. A late
descendant write cannot enter a replacement session. The mixed provisioning,
documentation, and unrelated Codex portions of upstream PR #1385 are excluded.

### Provider leases

The host daemon owns observable provider lease records. Each resident provider
process has a generation and maps to:

- Environment and provider identity.
- Direct child PID and process state.
- Provider session identities.
- Owning thread and active turn, or a bounded idle-reuse deadline.

Completion, stop, unexpected exit, environment eviction, and reuse expiry
release their ownership. Shared provider processes are reclaimed only when all
their sessions are idle. Repeated thread creation must not cause resident
providers to grow monotonically after the configured reuse deadline.

This tranche guarantees ownership of direct provider children. Full cgroup or
process-group containment for daemonized and reparented tool descendants is a
separate platform isolation project.

### Admission

Admission has two layers matching the existing server/daemon boundary:

- The server owns durable queue policy, ordering, retry, and user-visible
  reasons.
- The host daemon owns atomic host reservations, current provider lease usage,
  idle-provider reclamation, and host-local capacity observations.

Every work source must reserve capacity before starting or resuming provider
work: interactive turns, child threads, automations, queued sends, and recovery.
The initial policy uses an explicit configurable slot limit. Retained provider
leases consume slots or are reclaimed before new work is rejected. Host memory
pressure may close admission early when the platform exposes reliable signals,
but cross-platform memory prediction is not used as the correctness invariant.

If capacity is unavailable, the server records a durable FIFO waiting entry and
surfaces the host and reason. A reservation token/generation prevents a stale
completion from releasing a successor. Restart reconciliation leaves each
entry queued, resumable, running with a valid reservation, or terminal with a
specific recovery reason.

Capacity RPCs, diagnostic fields, and queue states share one coordinated
host-daemon protocol bump with the pre-start-exit change.

### Verification

- Provider output drains before replacement.
- Inherited/late streams cannot deliver stale JSON-RPC.
- Shutdown does not hang on inherited pipes.
- PID-to-session-to-thread diagnostics match resident direct children.
- Idle shared providers are not killed while another session is active.
- Idle providers disappear after the reuse deadline.
- Interactive, child, automation, queued, and resumed work share one limit.
- Excess work waits FIFO with an actionable reason.
- Idle leases are reclaimed before otherwise rejecting work.
- Stale release tokens do not release successor reservations.
- Daemon/server restart reconciliation produces no orphaned running or waiting
  work and no invalid-message reconnect loop.

## F. SQLite read isolation

### Problem

BB uses synchronous `better-sqlite3` connections. Timeline and large thread-list
operations currently perform queries, decoding, and projection on the server
event loop. Production databases have blocked all clients for several seconds.

### Design

Create a server-owned database read service backed initially by one dedicated
worker. It is a shared seam rather than a timeline-only workaround. The worker:

- Opens a read-only, `query_only` connection to the same WAL database.
- Accepts a small discriminated operation protocol with request IDs and
  runtime validation.
- Implements complete thread-list/sidebar and timeline snapshot operations.
- Runs each multi-query operation in one deferred read transaction for snapshot
  consistency.
- Performs the expensive database reads, JSON decoding, compaction, and
  timeline projection off the main event loop.
- Returns structured-cloneable, contract-validated results.

The service uses a bounded FIFO queue. Client cancellation removes queued work
or detaches the caller from in-flight work without treating cancellation as a
server error. Because an in-flight synchronous query cannot be interrupted, a
deadline may terminate and replace the worker. Startup readiness, worker crash,
invalid response, and shutdown paths are explicit and tested.

Main-loop code overlays live daemon/session state and performs cache/delta
bookkeeping only after the worker result returns. Existing query-plan fixes and
guards remain; isolation contains latency but does not excuse inefficient SQL.

No host-daemon protocol change is required because worker IPC is internal to
the server.

### Verification

- Direct and worker-backed operations produce equivalent contract results.
- Timeline snapshot stays internally consistent during a concurrent writer.
- WAL writers continue while the worker reads.
- On a large file-backed database, a timer, `/health`, and a static response
  complete while a timeline/list read is running.
- Queue cap, FIFO behavior, cancellation, timeout, invalid worker output,
  worker crash/restart, startup, and shutdown are covered.
- Structured-clone payload and resident-memory growth are bounded in repeated
  large-read tests.
- Existing timeline paging, delta, cache, and query-plan tests pass.

## G. Unmanaged-workspace mutation leases

### Problem

Multiple threads and automations can mutate one unmanaged working tree
concurrently. Project-scoped environment identity cannot protect a physical
path shared through another project, spelling, or symlink.

### Policy

Current BB permission modes are all mutation-capable. Until BB has an
enforceable read-only runtime, every provider turn targeting a protected
unmanaged workspace requests an exclusive mutation lease. Managed worktrees,
different canonical paths, and different hosts remain independent.

Protection is an explicit project policy for compatibility. If any project
attached to a physical path enables it, the physical path is protected across
all attached projects; otherwise another project could bypass the invariant.

### Identity and persistence

The host resolves and reports the canonical real path during unmanaged
environment provisioning. The server persists this identity. The daemon wire
addition participates in the tranche protocol bump.

Persist:

- One current lease keyed by `(host_id, canonical_path)`.
- Holder thread, environment, request/turn identity, generation, acquisition,
  and update timestamps.
- Durable FIFO waiters keyed by accepted work identity.
- Auditable acquire, waiting, release, promotion, and recovery transitions.

The database unique key is the final concurrency arbiter.

### Acquisition and release

Acquisition, accepted request persistence, and running-state transition occur
in one immediate transaction. Active-thread steers that join the existing
holder do not attempt to acquire a second lease.

Release uses the holder generation and occurs on successful, failed, or
interrupted completion; start/submit failure; manual stop; confirmed runtime
loss; and recovery. A temporary socket disconnect retains the lease throughout
the existing grace period. Once loss is confirmed, release and promotion of
exactly one waiter happen atomically. Host dispatch follows commit and is
durably retryable. Server startup reconciles leases with durable thread state
and daemon-reported live work before reclaiming them.

The shared thread-start/turn-dispatch seam is authoritative. Interactive sends,
queued sends, parent/system sends, child threads, and automation SDK calls must
not have independent bypass paths.

### Product surfaces

Waiting state and current owner are visible through the server contract, SDK,
CLI, and UI. The message identifies that another run owns the unmanaged path;
it does not present the wait as a provider failure.

### Verification

- Concurrent manual/manual, manual/automation, automation/automation, child,
  queued, and resumed work against the same canonical path cannot overlap.
- Cross-project and symlink aliases resolve to the same lease identity.
- Different paths, hosts, and managed worktrees proceed independently.
- Steers to the active holder do not deadlock.
- Waiters promote FIFO; cancellation removes a waiter.
- Success, failure, stop, start failure, server restart, daemon restart, and
  confirmed disconnect release or recover correctly.
- Disconnect within grace retains ownership.
- A stale completion generation cannot release a successor.
- API, SDK, CLI, UI, and audit records report consistent state.

## H. Assistant-reply correctness

### Problem

Completed-turn grouping currently treats earlier assistant prose as summary
material and leaves only the last assistant block at the top level. Normal
timeline responses omit completed-turn children, so earlier answers become
hidden inside a collapsed `Worked for...` row.

### Design

Shared thread-view projection treats every non-empty `assistant-text` message
as an ungroupable conversation boundary. Accumulated tool activity is flushed
before each assistant block and may remain summarized. Assistant prose never
contributes to a work summary count.

For `assistant text 1 -> tool/hook -> assistant text 2`, the public projection
is:

1. Assistant text 1.
2. Collapsed work segment.
3. Assistant text 2.

The policy lives in shared projection, not the app, so the app, CLI, search,
conversation outline, selection, copying, and accessibility reading order all
agree. No schema, UI contract, or daemon protocol change is required.

### Verification

- Multiple assistant blocks without work remain visible with no empty turn row.
- Assistant/tool/assistant order is preserved and only work is summarized.
- Completed, failed, interrupted, nested, and delegated projections preserve
  assistant prose.
- Timeline summary counts exclude prose.
- CLI snapshots and public conversation outline contain every block.
- A real Claude Stop-hook reproduction shows the answer and acknowledgement
  without expanding `Worked for...`.

## Cross-cutting engineering constraints

- Follow `AGENTS.md`, including Turbo-only build/typecheck commands and a
  protocol bump for every changed daemon/server wire behavior.
- Parse and validate at process, worker, API, and daemon boundaries.
- Do not add optional contract fields to mask deployment incompatibility.
- Do not mock the database; use migrated SQLite databases and file-backed
  databases where performance or worker behavior matters.
- Preserve unrelated user changes and avoid broad refactors.
- Every code change receives TypeScript/JavaScript review and general code
  review. Runtime/API/input changes also receive security review, excluding
  security-only expansion beyond this tranche.
- No completion claim is made without fresh command output and manual evidence
  for the original symptom.

## Integration acceptance gate

The branch is accepted only when all focused regression suites pass together
and the following repository gates complete successfully:

- Turbo lint.
- Turbo typecheck.
- Turbo build.
- Turbo unit/package tests.
- Integration and package-smoke suites.
- Host-daemon protocol compatibility/update tests.
- Runtime/provider manual smoke matrix.
- Large-database event-loop responsiveness exercise.
- Concurrent unmanaged-workspace lease exercise.
- Multi-block assistant rendering exercise.

Any pre-existing or environmental failure must be reproduced on the untouched
base commit before it can be classified as unrelated. Otherwise it is treated
as a regression and fixed within the owning track.
