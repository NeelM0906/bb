export function isExpectedFreshBuiltinPluginState(plugin) {
  if (plugin?.enabled !== true) return false;
  if (plugin.id === "account-pool") {
    return (
      plugin.status === "needs-configuration" &&
      plugin.statusDetail ===
        "Add and enable a Claude or Codex account with `bb pool account add`."
    );
  }
  return plugin.status === "running";
}
