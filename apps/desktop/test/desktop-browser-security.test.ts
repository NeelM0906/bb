import { afterEach, describe, expect, it, vi } from "vitest";
import {
  importDesktopBrowserCookiesWithConsent,
  isTrustedDesktopBrowserFrame,
  isTrustedDesktopBrowserOrigin,
} from "../src/desktop-browser-security.js";
import type { BrowserImportService } from "../src/browser-import/browser-import.js";

afterEach(() => vi.useRealTimers());
describe("desktop browser authority", () => {
  it("trusts only the actual builtin runtime origin and its main frame", () => {
    const mainFrame = { url: "http://127.0.0.1:4567/projects" };
    const builtinRuntimeUrl = "http://127.0.0.1:4567";
    expect(
      isTrustedDesktopBrowserFrame({
        senderFrame: mainFrame,
        mainFrame,
        builtinRuntimeUrl,
      }),
    ).toBe(true);
    expect(
      isTrustedDesktopBrowserFrame({
        senderFrame: { ...mainFrame },
        mainFrame,
        builtinRuntimeUrl,
      }),
    ).toBe(false);
    expect(
      isTrustedDesktopBrowserFrame({
        senderFrame: null,
        mainFrame,
        builtinRuntimeUrl,
      }),
    ).toBe(false);
    for (const url of [
      "http://localhost:4567",
      "http://127.0.0.1:9999",
      "https://remote.example",
      "file:///app",
      "data:text/html,hello",
    ])
      expect(isTrustedDesktopBrowserOrigin(url, builtinRuntimeUrl)).toBe(false);
    expect(isTrustedDesktopBrowserOrigin(mainFrame.url, null)).toBe(false);
  });
});

function setup() {
  let authorization: string | null = "builtin:document1";
  const session = {
    cookies: { set: vi.fn(async () => {}), flushStore: vi.fn(async () => {}) },
  };
  const service: BrowserImportService = {
    listSources: vi.fn<BrowserImportService["listSources"]>(async () => [
      {
        id: "firefox",
        name: "Firefox",
        profiles: [{ name: "Work", directory: "Profiles/work" }],
      },
    ]),
    importCookies: vi.fn<BrowserImportService["importCookies"]>(
      async (_selection, destination) => {
        await destination.cookies.set({
          url: "https://account.example",
          name: "session",
          value: "secret",
        });
        return { ok: true, imported: 1, skipped: 0, skippedDomains: [] };
      },
    ),
  };
  const confirm = vi.fn(async (_detail: string) => true);
  const run = () =>
    importDesktopBrowserCookiesWithConsent({
      request: {
        sourceId: "firefox",
        sourceProfileDirectory: "Profiles/work",
        profile: { kind: "automation", id: "agent-a" },
      },
      service,
      authorization: () => authorization,
      confirm,
      session: () => session,
    });
  return {
    run,
    confirm,
    service,
    session,
    change: (value: string | null) => {
      authorization = value;
    },
  };
}

it("requires scoped native consent before reading and writing cookies", async () => {
  const state = setup();
  await expect(state.run()).resolves.toMatchObject({ ok: true });
  expect(state.confirm).toHaveBeenCalledWith(
    expect.stringContaining(
      "Firefox, profile Work (Profiles/work), into BB automation profile agent-a",
    ),
  );
  expect(state.session.cookies.set).toHaveBeenCalledOnce();
});
it("denied approval never imports", async () => {
  const state = setup();
  state.confirm.mockResolvedValue(false);
  await expect(state.run()).rejects.toThrow("declined");
  expect(state.service.importCookies).not.toHaveBeenCalled();
});
it.each([null, "builtin:document2"])(
  "rejects navigation or target changes during native approval: %s",
  async (next) => {
    const state = setup();
    state.confirm.mockImplementation(async () => {
      state.change(next);
      return true;
    });
    await expect(state.run()).rejects.toThrow("not authorized");
    expect(state.service.importCookies).not.toHaveBeenCalled();
  },
);
it("rejects remote callers before source enumeration or approval", async () => {
  const state = setup();
  state.change(null);
  await expect(state.run()).rejects.toThrow("not authorized");
  expect(state.service.listSources).not.toHaveBeenCalled();
  expect(state.confirm).not.toHaveBeenCalled();
});
it("expired native approval cannot import after the broker request expires", async () => {
  vi.useFakeTimers();
  const state = setup();
  state.confirm.mockImplementation(async () => {
    vi.advanceTimersByTime(10_000);
    return true;
  });
  await expect(state.run()).rejects.toThrow("not authorized");
  expect(state.service.importCookies).not.toHaveBeenCalled();
});
it("revalidates authorization at cookie writes after asynchronous import work", async () => {
  const state = setup();
  vi.mocked(state.service.importCookies).mockImplementation(
    async (_selection, destination) => {
      state.change("builtin:document2");
      await destination.cookies.set({
        url: "https://account.example",
        name: "session",
        value: "secret",
      });
      return { ok: true, imported: 1, skipped: 0, skippedDomains: [] };
    },
  );
  await expect(state.run()).rejects.toThrow("not authorized");
  expect(state.session.cookies.set).not.toHaveBeenCalled();
});
