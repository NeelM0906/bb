import { describe, expect, it, vi } from "vitest";
import type { Session } from "electron";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  WebContentsView: class {},
  session: { fromPartition: () => ({}) },
  nativeImage: { createFromBuffer: () => ({}) },
}));

import { createDesktopBrowserBroker } from "../src/desktop-browser-broker.js";
import type { DesktopBrowserViewManager } from "../src/desktop-browser-view.js";
import type { BrowserImportService } from "../src/browser-import/browser-import.js";

function createFakeManager(
  profileSession: DesktopBrowserViewManager["profileSession"],
  listTabs: DesktopBrowserViewManager["listTabs"] = () => [],
) {
  const manager: Pick<
    DesktopBrowserViewManager,
    | "listTabs"
    | "subscribeAutomationTabs"
    | "profileSession"
    | "destroyAll"
    | "prepareWindowReload"
  > = {
    listTabs,
    subscribeAutomationTabs: () => () => undefined,
    profileSession,
    destroyAll: () => undefined,
    prepareWindowReload: () => undefined,
  };
  return manager as DesktopBrowserViewManager;
}

function createFakeWindow() {
  return {
    webContents: {
      id: 7,
      isDestroyed: () => false,
      send: () => undefined,
    },
    isDestroyed: () => false,
    focus: () => undefined,
    show: () => undefined,
    restore: () => undefined,
    isMinimized: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    contentView: {
      addChildView: () => undefined,
      removeChildView: () => undefined,
    },
  };
}

describe("desktop browser broker cookie import commands", () => {
  it("lists sources and imports into the partition for the requested profile", async () => {
    const personalSession = { cookies: {} } as unknown as Session;
    const automationSession = { cookies: {} } as unknown as Session;
    const profileSession = vi.fn((profile: { kind: string }) =>
      profile.kind === "personal" ? personalSession : automationSession,
    );
    const browserImport: BrowserImportService = {
      listSources: vi.fn<BrowserImportService["listSources"]>(async () => [
        { id: "firefox", name: "Firefox", profiles: [] },
      ]),
      importCookies: vi.fn<BrowserImportService["importCookies"]>(async () => ({
        ok: true,
        imported: 1,
        skipped: 0,
        skippedDomains: [],
      })),
    };
    const broker = createDesktopBrowserBroker({
      isTrustedWindow: () => true,
      manager: createFakeManager(profileSession),
      product: "Chrome/1",
      browserImport,
      importCookies: (_window, request) =>
        browserImport.importCookies(
          {
            sourceId: request.sourceId,
            sourceProfileDirectory: request.sourceProfileDirectory,
          },
          profileSession(request.profile),
        ),
    });
    const window = createFakeWindow();
    broker.registerWindow(window as never);
    const [instance] = broker.listInstances();
    await expect(
      broker.execute({
        type: "desktop.browser.list_import_sources",
        instanceId: instance.instanceId,
        generation: instance.generation,
      }),
    ).resolves.toEqual({
      sources: [{ id: "firefox", name: "Firefox", profiles: [] }],
    });
    await expect(
      broker.execute({
        type: "desktop.browser.import_cookies",
        instanceId: instance.instanceId,
        generation: instance.generation,
        sourceId: "firefox",
        sourceProfileDirectory: "Profiles/p1",
        profile: { kind: "automation", id: "agent" },
      }),
    ).resolves.toEqual({
      ok: true,
      imported: 1,
      skipped: 0,
      skippedDomains: [],
    });
    expect(browserImport.importCookies).toHaveBeenCalledWith(
      { sourceId: "firefox", sourceProfileDirectory: "Profiles/p1" },
      automationSession,
    );
    await expect(
      broker.execute({
        type: "desktop.browser.import_cookies",
        instanceId: instance.instanceId,
        generation: "stale",
        sourceId: "firefox",
        sourceProfileDirectory: "Profiles/p1",
        profile: { kind: "personal" },
      }),
    ).rejects.toThrow(/unavailable or has reconnected/);
    broker.dispose();
  });

  it("rejects import commands when no import service is wired", async () => {
    const broker = createDesktopBrowserBroker({
      isTrustedWindow: () => true,
      manager: createFakeManager(() => {
        throw new Error("unused");
      }),
      product: "Chrome/1",
    });
    broker.registerWindow(createFakeWindow() as never);
    const [instance] = broker.listInstances();
    await expect(
      broker.execute({
        type: "desktop.browser.list_import_sources",
        instanceId: instance.instanceId,
        generation: instance.generation,
      }),
    ).rejects.toThrow("Browser cookie import is unavailable");
    broker.dispose();
  });
});

describe("desktop browser reveal", () => {
  it("sends the tab request without restoring, showing, or focusing the window", async () => {
    const broker = createDesktopBrowserBroker({
      isTrustedWindow: () => true,
      manager: createFakeManager(
        () => {
          throw new Error("unused");
        },
        () => [
          {
            tabId: "tab-a",
            threadId: "thread-a",
            generation: "tab-generation",
            profile: { kind: "automation", id: "profile-a" },
            presentation: "hidden",
            url: "about:blank",
            title: null,
            isLoading: false,
            canGoBack: false,
            canGoForward: false,
            errorText: null,
          },
        ],
      ),
      product: "Chrome/1",
    });
    const window = {
      ...createFakeWindow(),
      isMinimized: () => true,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };
    const send = vi.spyOn(window.webContents, "send");
    broker.registerWindow(window as never);
    broker.setHostId("host-a");
    const [instance] = broker.listInstances();
    try {
      await broker.execute({
        type: "desktop.browser.reveal_tab",
        instanceId: instance.instanceId,
        generation: instance.generation,
        threadId: "thread-a",
        tabId: "tab-a",
      });
      expect(send).toHaveBeenCalledWith("bb-desktop:browser:reveal", {
        threadId: "thread-a",
        tabId: "tab-a",
        desktopTarget: {
          hostId: "host-a",
          instanceId: instance.instanceId,
          generation: instance.generation,
        },
      });
      expect(window.restore).not.toHaveBeenCalled();
      expect(window.show).not.toHaveBeenCalled();
      expect(window.focus).not.toHaveBeenCalled();
    } finally {
      broker.dispose();
    }
  });
});

it("rejects broker imports and hides instances when a window becomes remote", async () => {
  let trusted = true;
  const importCookies = vi.fn();
  const broker = createDesktopBrowserBroker({
    manager: createFakeManager(() => {
      throw new Error("unused");
    }),
    product: "test",
    isTrustedWindow: () => trusted,
    importCookies,
  });
  broker.registerWindow(createFakeWindow() as never);
  const [instance] = broker.listInstances();
  trusted = false;
  expect(broker.listInstances()).toEqual([]);
  await expect(
    broker.execute({
      type: "desktop.browser.import_cookies",
      instanceId: instance.instanceId,
      generation: instance.generation,
      sourceId: "firefox",
      sourceProfileDirectory: "Profiles/p1",
      profile: { kind: "personal" },
    }),
  ).rejects.toThrow("unavailable");
  expect(importCookies).not.toHaveBeenCalled();
  broker.dispose();
});
it("publishes a new instance generation after navigation and rejects the old target", async () => {
  const manager = createFakeManager(() => {
    throw new Error("unused");
  });
  const hide = vi.spyOn(manager, "prepareWindowReload");
  const broker = createDesktopBrowserBroker({
    manager,
    product: "test",
    isTrustedWindow: () => true,
  });
  broker.registerWindow(createFakeWindow() as never);
  const [before] = broker.listInstances();
  const changed = vi.fn();
  broker.subscribeInstances(changed);
  broker.revokeWindow(7);
  expect(hide).toHaveBeenCalledOnce();
  const [after] = broker.listInstances();
  expect(after.generation).not.toBe(before.generation);
  expect(changed).toHaveBeenCalledOnce();
  await expect(
    broker.execute({
      type: "desktop.browser.list_tabs",
      instanceId: before.instanceId,
      generation: before.generation,
      threadId: "thread-a",
    }),
  ).rejects.toThrow("unavailable");
  await expect(
    broker.execute({
      type: "desktop.browser.list_tabs",
      instanceId: after.instanceId,
      generation: after.generation,
      threadId: "thread-a",
    }),
  ).resolves.toEqual({ tabs: [] });
  broker.dispose();
});
