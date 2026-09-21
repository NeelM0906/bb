import { describe, expect, it } from "vitest";
import { isExpectedFreshBuiltinPluginState } from "../scripts/builtin-plugin-smoke-state.mjs";

const unconfiguredAccountPool = {
  id: "account-pool",
  enabled: true,
  status: "needs-configuration",
  statusDetail:
    "Add and enable a Claude or Codex account with `bb pool account add`.",
};

describe("fresh builtin plugin smoke states", () => {
  it("accepts the enabled account pool's specific empty-account prompt", () => {
    expect(isExpectedFreshBuiltinPluginState(unconfiguredAccountPool)).toBe(
      true,
    );
  });

  it.each([
    { enabled: false },
    { status: "error" },
    { status: "running" },
    { statusDetail: "Provider artifact failed to load" },
    { statusDetail: null },
  ])("rejects an unexpected account pool state: %j", (override) => {
    expect(
      isExpectedFreshBuiltinPluginState({
        ...unconfiguredAccountPool,
        ...override,
      }),
    ).toBe(false);
  });

  it("does not relax startup requirements for other plugins", () => {
    expect(
      isExpectedFreshBuiltinPluginState({
        ...unconfiguredAccountPool,
        id: "provider-codex",
      }),
    ).toBe(false);
    expect(
      isExpectedFreshBuiltinPluginState({
        id: "provider-codex",
        enabled: true,
        status: "running",
      }),
    ).toBe(true);
    expect(
      isExpectedFreshBuiltinPluginState({
        id: "provider-codex",
        enabled: false,
        status: "running",
      }),
    ).toBe(false);
    expect(isExpectedFreshBuiltinPluginState(undefined)).toBe(false);
  });
});
