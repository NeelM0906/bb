import type { ServerMoveStep, ServerMoveStepStatus } from "@bb/server-contract";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import type { ServerMoveStepId } from "@bb/domain";

const STEP_STATUS_PRESENTATION: Record<
  ServerMoveStepStatus,
  { icon: IconName; iconClassName: string; label: string }
> = {
  pending: {
    icon: "Circle",
    iconClassName: "text-subtle-foreground/60",
    label: "Waiting",
  },
  running: {
    icon: "Spinner",
    iconClassName: "animate-spin text-foreground",
    label: "In progress",
  },
  done: {
    icon: "CircleCheck",
    iconClassName: "text-foreground",
    label: "Done",
  },
  failed: {
    icon: "CircleX",
    iconClassName: "text-destructive-text",
    label: "Failed",
  },
  skipped: {
    icon: "Circle",
    iconClassName: "text-subtle-foreground/40",
    label: "Skipped",
  },
};

export default function ServerMoveStepList({
  steps,
  targetHostName,
}: {
  steps: readonly ServerMoveStep[];
  targetHostName: string;
}) {
  return (
    <ol className="space-y-2" aria-label="Move steps">
      {steps.map((step) => {
        const presentation = STEP_STATUS_PRESENTATION[step.status];
        return (
          <li
            key={step.id}
            data-step={step.id}
            data-status={step.status}
            className="flex items-start gap-2.5"
          >
            <Icon
              name={presentation.icon}
              aria-hidden
              className={cn(
                "mt-0.5 size-4 shrink-0",
                presentation.iconClassName,
              )}
            />
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "text-sm",
                  step.status === "failed"
                    ? "text-destructive-text"
                    : step.status === "pending" || step.status === "skipped"
                      ? "text-muted-foreground"
                      : "text-foreground",
                )}
              >
                <span>{serverMoveStepLabel(step.id, targetHostName)}</span>
                <span className="sr-only">{`, ${presentation.label}`}</span>
              </p>
              {step.status === "skipped" ? (
                <p className="text-xs text-subtle-foreground">Skipped</p>
              ) : step.message === null ? null : (
                <p className="text-xs break-words text-subtle-foreground">
                  {step.message}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function serverMoveStepLabel(
  stepId: ServerMoveStepId,
  targetHostName: string,
): string {
  switch (stepId) {
    case "stop-work":
      return "Stopping running work";
    case "update-target":
      return `Updating bb on ${targetHostName}`;
    case "export":
      return "Exporting server data";
    case "transfer":
      return `Sending data to ${targetHostName}`;
    case "start-target":
      return "Starting the new server";
    case "verify-address":
      return "Checking the new address";
    case "switch":
      return "Switching machines over";
  }
}
