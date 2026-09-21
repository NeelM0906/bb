import { lazy, Suspense, useEffect } from "react";
import { Popover, PopoverAnchor, PopoverContent } from "@bb/shared-ui/popover";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { useResponsiveDrawerRealization } from "@bb/shared-ui/responsive-overlay";
import { appToast } from "@/components/ui/app-toast";
import {
  closeNotificationCenter,
  toggleNotificationCenter,
  useNotificationCenterState,
} from "@/lib/notifications/notification-store";

const NotificationCenterContent = lazy(() =>
  import("./NotificationCenterContent").catch(() => ({
    default: () => (
      <div role="alert" className="p-3 text-sm">
        Couldn't load notifications.{" "}
        <button type="button" onClick={closeNotificationCenter}>
          Close
        </button>
      </div>
    ),
  })),
);

const loadingNotifications = (
  <div role="status" className="p-3 text-sm">
    Loading notifications…
  </div>
);

export function NotificationCenter() {
  const { open } = useNotificationCenterState();
  const { isContentRealized } = useResponsiveDrawerRealization({ open });

  useAppCommandHandler("notifications.open", () => {
    toggleNotificationCenter();
    return true;
  });

  useEffect(() => {
    if (!open) {
      return;
    }
    appToast.dismiss();
  }, [open]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          closeNotificationCenter();
        }
      }}
    >
      <PopoverAnchor asChild>
        <div
          aria-hidden="true"
          className="pointer-events-none fixed bottom-4 right-4 size-0"
        />
      </PopoverAnchor>
      <PopoverContent
        dismissOnOutsideInteraction={false}
        side="top"
        align="end"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
        }}
        mobileTitle="Notifications"
        aria-label="Notifications"
        data-testid="notification-center"
        className="w-96 max-w-[calc(100vw-2rem)] p-0"
        mobileClassName="p-0"
      >
        {isContentRealized ? (
          <Suspense fallback={loadingNotifications}>
            <NotificationCenterContent />
          </Suspense>
        ) : (
          loadingNotifications
        )}
      </PopoverContent>
    </Popover>
  );
}
