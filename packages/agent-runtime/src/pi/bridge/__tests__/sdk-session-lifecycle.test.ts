import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiSdkSession } from "../sdk-session.js";

const testRoots: string[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readLifecycle(markerPath: string): Promise<string[]> {
  try {
    return (await readFile(markerPath, "utf8")).trim().split("\n");
  } catch {
    return [];
  }
}

async function readLazyMcpAdapterStatus(
  statusPath: string,
): Promise<{ adapter: string; status: string } | null> {
  try {
    const value: unknown = JSON.parse(await readFile(statusPath, "utf8"));
    if (
      !isRecord(value) ||
      typeof value.adapter !== "string" ||
      typeof value.status !== "string"
    ) {
      return null;
    }
    return { adapter: value.adapter, status: value.status };
  } catch {
    return null;
  }
}

async function createLifecycleFixture(): Promise<{
  cwd: string;
  lazyMcpStatusPath: string;
  markerPath: string;
  modelRuntime: ModelRuntime;
  sessionFilePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "bb-pi-lifecycle-test-"));
  testRoots.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  const extensionDir = join(cwd, ".pi", "extensions");
  const markerPath = join(root, "lifecycle.txt");
  const lazyMcpStatusPath = join(root, "lazy-mcp-status.txt");
  await mkdir(agentDir, { recursive: true });
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultProjectTrust: "always" }),
  );
  await writeFile(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      extensions: [
        "./extensions/lifecycle.ts",
        "./extensions/lazy-mcp-adapter.ts",
      ],
    }),
  );
  await writeFile(
    join(extensionDir, "lifecycle.ts"),
    `import { appendFileSync } from "node:fs";
export default function lifecycle(pi) {
  pi.on("session_start", () => appendFileSync(${JSON.stringify(markerPath)}, "session_start\\n", "utf8"));
  pi.on("session_shutdown", () => appendFileSync(${JSON.stringify(markerPath)}, "session_shutdown\\n", "utf8"));
}
`,
  );
  await writeFile(
    join(extensionDir, "lazy-mcp-adapter.ts"),
    `import { writeFileSync } from "node:fs";
export default function piMcpAdapter(pi) {
  let status = "uninitialized";
  pi.on("session_start", () => {
    status = "ready";
    writeFileSync(${JSON.stringify(lazyMcpStatusPath)}, JSON.stringify({ adapter: "pi-mcp-adapter", status }), "utf8");
  });
}
`,
  );
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

  return {
    cwd,
    lazyMcpStatusPath,
    markerPath,
    modelRuntime: await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
    }),
    sessionFilePath: join(root, "sessions", "thread.jsonl"),
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    testRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("PiSdkSession extension lifecycle", () => {
  it("binds extensions before a new session can be used", async () => {
    const fixture = await createLifecycleFixture();
    const session = new PiSdkSession(fixture, vi.fn(), vi.fn());

    await session.start();
    expect(await readLifecycle(fixture.markerPath)).toEqual(["session_start"]);
    await session.closeGracefully(1_000);
  });

  it("reports lazy pi-mcp-adapter status from session_start without prompting", async () => {
    const fixture = await createLifecycleFixture();
    const session = new PiSdkSession(fixture, vi.fn(), vi.fn());

    expect(await readLazyMcpAdapterStatus(fixture.lazyMcpStatusPath)).toBeNull();
    await session.start();
    expect(await readLazyMcpAdapterStatus(fixture.lazyMcpStatusPath)).toEqual({
      adapter: "pi-mcp-adapter",
      status: "ready",
    });
    await session.closeGracefully(1_000);
  });

  it("shuts down an extension once when close is repeated", async () => {
    const fixture = await createLifecycleFixture();
    const session = new PiSdkSession(fixture, vi.fn(), vi.fn());

    await session.start();
    await session.closeGracefully(1_000);
    await session.closeGracefully(1_000);

    expect(await readLifecycle(fixture.markerPath)).toEqual([
      "session_start",
      "session_shutdown",
    ]);
  });

  it("shuts down a persisted session before its replacement starts", async () => {
    const fixture = await createLifecycleFixture();
    const firstSession = new PiSdkSession(fixture, vi.fn(), vi.fn());

    await firstSession.start();
    await firstSession.closeGracefully(1_000);

    const persistedSession = new PiSdkSession(fixture, vi.fn(), vi.fn());
    await persistedSession.start();
    expect(await readLifecycle(fixture.markerPath)).toEqual([
      "session_start",
      "session_shutdown",
      "session_start",
    ]);
    await persistedSession.closeGracefully(1_000);

    expect(await readLifecycle(fixture.markerPath)).toEqual([
      "session_start",
      "session_shutdown",
      "session_start",
      "session_shutdown",
    ]);
  });
});
