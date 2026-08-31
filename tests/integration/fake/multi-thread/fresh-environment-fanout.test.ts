import fs from "node:fs/promises";
import path from "node:path";
import { shellSingleQuote, waitForSetupMarkerCount } from "@bb/test-helpers";
import { describe, expect, it } from "vitest";
import {
  createHostThread,
  getThreadEvents,
  getThreadOutput,
} from "../../helpers/api.js";
import { waitForThreadStatus } from "../../helpers/assertions.js";
import { createProjectFixture } from "../../helpers/fixtures.js";
import { withHarness } from "../../helpers/harness.js";
import { createTestGitRepo } from "../../helpers/seed.js";
import { scaleTimeoutMs } from "../../helpers/time.js";
import { DEFAULT_TIMEOUT_MS } from "./shared.js";

const FANOUT_PROVIDERS: ReadonlyArray<string> = [
  "fake",
  "fake-alpha",
  "fake-beta",
];
const THREADS_PER_PROVIDER = 2;
const FRESH_FANOUT_TIMEOUT_MS = scaleTimeoutMs(30_000);

describe.sequential(
  "fake provider fresh-environment fanout integration",
  () => {
    it("runs same-source managed worktree setup scripts concurrently", () =>
      withHarness(async (harness) => {
        const coordinationDir = path.join(
          path.dirname(harness.repoDir),
          "setup-coordination",
        );
        const markerDir = path.join(coordinationDir, "markers");
        const releaseFile = path.join(coordinationDir, "release");
        const sourceRepo = await createTestGitRepo({
          repoDir: path.join(path.dirname(harness.repoDir), "setup-project"),
          files: [
            {
              relativePath: "README.md",
              content: "setup project\n",
            },
            {
              relativePath: ".bb-env-setup.sh",
              content:
                [
                  "set -euo pipefail",
                  `marker_dir=${shellSingleQuote(markerDir)}`,
                  `release_file=${shellSingleQuote(releaseFile)}`,
                  'marker_name="$(basename "$(dirname "$PWD")")-$(basename "$PWD")"',
                  'mkdir -p "$marker_dir"',
                  'touch "$marker_dir/started-$marker_name"',
                  'while [ ! -f "$release_file" ]; do sleep 0.05; done',
                  "echo setup released",
                ].join("\n") + "\n",
            },
          ],
        });
        const project = await createProjectFixture(harness, {
          name: "Concurrent Setup Fanout",
          path: sourceRepo,
        });

        const [firstThread, secondThread] = await Promise.all([
          createHostThread(harness.api, {
            hostId: harness.hostId,
            input: [
              { type: "text", text: "first concurrent setup", mentions: [] },
            ],
            projectId: project.id,
            providerId: "fake",
            workspace: { type: "managed-worktree" },
          }),
          createHostThread(harness.api, {
            hostId: harness.hostId,
            input: [
              { type: "text", text: "second concurrent setup", mentions: [] },
            ],
            projectId: project.id,
            providerId: "fake-alpha",
            workspace: { type: "managed-worktree" },
          }),
        ]);

        try {
          await expect(
            waitForSetupMarkerCount({
              markerDir,
              expectedCount: 2,
              timeoutMs: DEFAULT_TIMEOUT_MS,
            }),
          ).resolves.toHaveLength(2);
        } finally {
          await fs.writeFile(releaseFile, "release\n", "utf8");
        }

        await Promise.all([
          waitForThreadStatus(
            harness.api,
            firstThread.id,
            "idle",
            DEFAULT_TIMEOUT_MS,
          ),
          waitForThreadStatus(
            harness.api,
            secondThread.id,
            "idle",
            DEFAULT_TIMEOUT_MS,
          ),
        ]);
        expect(await getThreadOutput(harness.api, firstThread.id)).toContain(
          "first concurrent setup",
        );
        expect(await getThreadOutput(harness.api, secondThread.id)).toContain(
          "second concurrent setup",
        );
      }));

    it(
      "starts two fresh managed-worktree threads per provider",
      () =>
        withHarness(async (harness) => {
          const sourceRepo = await createTestGitRepo({
            repoDir: path.join(path.dirname(harness.repoDir), "fanout-project"),
            files: [
              {
                relativePath: "README.md",
                content: "fanout project\n",
              },
            ],
          });
          const project = await createProjectFixture(harness, {
            name: "Fresh Environment Fanout",
            path: sourceRepo,
          });
          const requests = FANOUT_PROVIDERS.flatMap((providerId) =>
            Array.from({ length: THREADS_PER_PROVIDER }, (_, index) => ({
              index: index + 1,
              providerId,
            })),
          );

          // Sequential: same-source worktree adds serialize on the git metadata
          // lock, and overlapping provision RPCs retry instead of waiting.
          for (const request of requests) {
            const token = `${request.providerId}-fresh-${request.index}`;
            const created = await createHostThread(harness.api, {
              hostId: harness.hostId,
              input: [{ type: "text", text: token, mentions: [] }],
              projectId: project.id,
              providerId: request.providerId,
              workspace: { type: "managed-worktree" },
            });
            const thread = await waitForThreadStatus(
              harness.api,
              created.id,
              "idle",
              FRESH_FANOUT_TIMEOUT_MS,
            );
            expect(thread.environmentId).toBeTruthy();
            expect(await getThreadOutput(harness.api, thread.id)).toContain(
              token,
            );
            expect(
              (await getThreadEvents(harness.api, thread.id)).every(
                (event) => event.threadId === thread.id,
              ),
            ).toBe(true);
          }
        }),
      FRESH_FANOUT_TIMEOUT_MS *
        FANOUT_PROVIDERS.length *
        THREADS_PER_PROVIDER +
        scaleTimeoutMs(20_000),
    );
  },
);
