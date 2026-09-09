import {
  providerCommandSectionRank,
  type CommandListResponse,
  type ProviderCommand,
} from "@bb/server-contract";
import type { HostProviderCommand } from "@bb/host-daemon-contract";
import type {
  ProviderRegistration,
  ProviderRegistryService,
} from "../providers/provider-registry.js";
import type { ResolvedSkillCatalogEntry } from "../skills/injected-skills.js";

const BUILT_IN_PROVIDER_COMMANDS: ProviderCommand[] = [
  {
    name: "clear",
    source: "command",
    origin: "builtin",
    description: "Start fresh context in this thread",
    argumentHint: null,
  },
  {
    name: "compact",
    source: "command",
    origin: "builtin",
    description: "Compact context",
    argumentHint: null,
  },
  {
    name: "goal",
    source: "command",
    origin: "builtin",
    description: "Keep working until this objective is complete",
    argumentHint: "<objective>",
  },
];

function providerComposerHasSkillsAction(
  composerActions: readonly { kind: string }[],
): boolean {
  return composerActions.some((action) => action.kind === "skills");
}

export function providerHasNativeGoal(
  registration: Pick<ProviderRegistration, "info">,
): boolean {
  return registration.info.composerActions.some(
    (action) => action.kind === "goal",
  );
}

export function providerIdHasNativeGoal(
  registry: ProviderRegistryService,
  providerId: string,
): boolean {
  const registration = registry.get(providerId);
  return registration !== null && providerHasNativeGoal(registration);
}

export function providerHasCommandSurface(
  registration: ProviderRegistration,
): boolean {
  return providerComposerHasSkillsAction(registration.info.composerActions);
}

function toProviderCommand(command: HostProviderCommand): ProviderCommand {
  return {
    name: command.name,
    source: command.source,
    origin: command.origin,
    description: command.description,
    argumentHint: command.argumentHint,
  };
}

function toSkillCommand(entry: ResolvedSkillCatalogEntry): ProviderCommand {
  const { provenance, runtimeSource } = entry;
  return {
    name: runtimeSource.name,
    source: "skill",
    origin: provenance.kind === "project" ? "project" : "user",
    description: runtimeSource.description,
    argumentHint: null,
    ...(provenance.kind === "plugin" ? { pluginId: provenance.pluginId } : {}),
  };
}

function dedupeBySourceAndName(commands: ProviderCommand[]): ProviderCommand[] {
  const byKey = new Map<string, ProviderCommand>();
  for (const command of commands) {
    const key = `${command.source} ${command.name}`;
    const existing = byKey.get(key);
    if (!existing || commandOriginRank(command) > commandOriginRank(existing)) {
      byKey.set(key, command);
    }
  }
  return [...byKey.values()];
}

function commandOriginRank(command: ProviderCommand): number {
  switch (command.origin) {
    case "builtin":
      return 2;
    case "project":
      return 1;
    case "user":
      return 0;
  }
}

function compareCommands(a: ProviderCommand, b: ProviderCommand): number {
  const bySection =
    providerCommandSectionRank(a) - providerCommandSectionRank(b);
  if (bySection !== 0) {
    return bySection;
  }
  return a.name.localeCompare(b.name);
}

interface BuildCommandListResponseArgs {
  commands: HostProviderCommand[];
  includeBuiltinCompact: boolean;
  includeBuiltinGoal: boolean;
  skillCatalog: readonly ResolvedSkillCatalogEntry[];
}

function includeBuiltInCommand(
  command: ProviderCommand,
  args: Pick<
    BuildCommandListResponseArgs,
    "includeBuiltinCompact" | "includeBuiltinGoal"
  >,
): boolean {
  if (command.name === "compact") return args.includeBuiltinCompact;
  if (command.name === "goal") return args.includeBuiltinGoal;
  return true;
}

export function buildCommandListResponse(
  args: BuildCommandListResponseArgs,
): CommandListResponse {
  return {
    commands: dedupeBySourceAndName([
      ...BUILT_IN_PROVIDER_COMMANDS.filter((command) =>
        includeBuiltInCommand(command, args),
      ),
      ...args.skillCatalog.map(toSkillCommand),
      ...args.commands.map(toProviderCommand),
    ]).sort(compareCommands),
  };
}
