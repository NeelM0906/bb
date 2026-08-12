# Task 5 failed-startup finalization fix

## Resolved finding

Fixed the Task 5 HIGH finding: a failed provider startup can no longer remove
its registry entry and allow a retry to spawn a replacement before the old
process has completed its bounded `exitFinalized` drain.

`cleanupFailedStartup()` now awaits `providerProcess.exitFinalized` after
terminating the child. The existing finalization contract waits for `close`, or
forces readline/stream cleanup after its one-second inherited-pipe grace.

## Regression coverage

Updated the required startup skill-configuration failure retry test to make
the first provider spawn a descendant holding inherited stdout for 1.5 seconds.
It records the first provider's SIGTERM exit and the replacement spawn, then
asserts the replacement starts at least 900 ms later. Before the fix, the
replacement started about 36 ms after exit; with the fix, the test passes in
about 1.1 seconds.

## Verification

- `pnpm exec turbo run test --filter=@bb/agent-runtime -- --run src/runtime.process-lifecycle.test.ts` — 26 passed
- `pnpm exec turbo run test typecheck --filter=@bb/agent-runtime --force` — 922 tests passed; typecheck passed
- `git diff --check` — passed

## Self-review

Reviewed the two owned runtime files against the finding and design invariant.
The new await is deliberately after termination, so it preserves normal
termination behavior while preventing replacement until final stream cleanup.
The regression exercises the real child-process exit and inherited-pipe path;
its timing assertion would fail if the await were removed. No findings.

An independent reviewer could not be allocated because all team slots were
occupied; the parent agent will arrange that review after a slot is free.
