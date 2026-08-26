import type {
  HostDaemonEnvironmentChangePayload,
  HostDaemonEnvironmentMetadataChangePayload,
} from "@bb/host-daemon-contract";
import {
  getEnvironment,
  getEnvironmentCanonicalPath,
  type DbNotifier,
} from "@bb/db";
import { recordObservedEnvironmentWorkspaceMetadata } from "@bb/db/internal-environment-lifecycle";
import type { AppDeps } from "../types.js";

interface EnvironmentChangeNotificationDeps {
  hub: Pick<DbNotifier, "notifyEnvironment">;
}

interface NotifyDaemonEnvironmentChangeArgs extends HostDaemonEnvironmentChangePayload {
  hostId: string;
}

interface RecordDaemonEnvironmentMetadataChangeArgs extends HostDaemonEnvironmentMetadataChangePayload {
  hostId: string;
}

interface NotifyWorkspaceMutationResultArgs {
  environmentId: string;
  ok: boolean;
}

export function notifyWorkspaceMutationResult(
  deps: EnvironmentChangeNotificationDeps,
  args: NotifyWorkspaceMutationResultArgs,
): void {
  if (!args.ok) {
    return;
  }
  deps.hub.notifyEnvironment(args.environmentId, ["work-status-changed"]);
}

export function notifyDaemonEnvironmentChange(
  deps: Pick<AppDeps, "db" | "hub">,
  args: NotifyDaemonEnvironmentChangeArgs,
): void {
  const environment = getEnvironment(deps.db, args.environmentId);
  if (
    !environment ||
    environment.hostId !== args.hostId ||
    environment.status === "destroyed"
  ) {
    return;
  }

  deps.hub.notifyEnvironment(environment.id, [args.change]);
}

export function recordDaemonEnvironmentMetadataChange(
  deps: Pick<AppDeps, "db" | "hub">,
  args: RecordDaemonEnvironmentMetadataChangeArgs,
): void {
  const environment = getEnvironment(deps.db, args.environmentId);
  if (
    !environment ||
    environment.hostId !== args.hostId ||
    environment.status === "destroyed" ||
    getEnvironmentCanonicalPath(deps.db, environment.id) !== args.workspace.path
  ) {
    return;
  }

  recordObservedEnvironmentWorkspaceMetadata(
    deps.db,
    deps.hub,
    environment.id,
    args.workspace,
  );
}
