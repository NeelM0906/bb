import type { ProviderComposerCommand } from "@bb/domain";
import type { ProviderRegistryService } from "./provider-registry.js";

/**
 * The provider's declared `plan` composer command, or null when it declares no
 * plan action. This is the single answer for plan-mode eligibility: the
 * timeline projection and the thread-list banner pre-filter both read it
 * instead of repeating a `claude-code || codex` test.
 *
 * An id with no registration answers null — a provider whose plugin is
 * disabled mid-thread offers no plan action, which is the safe reading.
 */
export function resolveProviderPlanCommand(
  registry: ProviderRegistryService,
  providerId: string,
): ProviderComposerCommand | null {
  const action = registry
    .get(providerId)
    ?.info.composerActions.find((entry) => entry.kind === "plan");
  return action?.kind === "plan" ? action.command : null;
}

/**
 * Worker-safe snapshot of each live provider's plan composer command. The
 * database read worker has no process-local registry, so list routes send
 * this map with each snapshot request.
 */
export function snapshotProviderPlanCommands(
  registry: ProviderRegistryService,
): Record<string, ProviderComposerCommand> {
  const snapshot: Record<string, ProviderComposerCommand> = {};
  for (const registration of registry.list()) {
    const command = resolveProviderPlanCommand(registry, registration.info.id);
    if (command !== null) {
      snapshot[registration.info.id] = command;
    }
  }
  return snapshot;
}
