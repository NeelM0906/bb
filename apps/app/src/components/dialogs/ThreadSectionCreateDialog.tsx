import { lazy, Suspense } from "react";
import { DialogTitle } from "@bb/shared-ui/dialog";
import { RenameDialog } from "./RenameDialog";

const sectionTitle = <DialogTitle>New section</DialogTitle>;
const loadingSection = (
  <>
    {sectionTitle}
    <p role="status">Loading section form…</p>
  </>
);

const ThreadSectionDialogContent = lazy(() =>
  import("./ThreadSectionDialogContent").catch(() => ({
    default: () => (
      <>
        {sectionTitle}
        <p role="alert">
          Couldn't load the section form. Close this dialog and reload bb to try
          again.
        </p>
      </>
    ),
  })),
);

interface ThreadSectionCreateDialogProps {
  errorMessage?: string | null;
  open: boolean;
  pending?: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string) => void;
}

export function ThreadSectionCreateDialog({
  errorMessage,
  open,
  pending = false,
  onOpenChange,
  onCreate,
}: ThreadSectionCreateDialogProps) {
  return (
    <RenameDialog open={open} onOpenChange={onOpenChange}>
      {(inputRef) =>
        open ? (
          <Suspense fallback={loadingSection}>
            <ThreadSectionDialogContent
              errorMessage={errorMessage}
              pending={pending}
              onSubmit={onCreate}
              inputRef={inputRef}
            />
          </Suspense>
        ) : null
      }
    </RenameDialog>
  );
}
