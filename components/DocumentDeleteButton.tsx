"use client";

import { useRef, useState } from "react";
import { deleteDocumentAction } from "@/lib/actions/documents";
import { ConfirmDialog } from "./ConfirmDialog";

export function DocumentDeleteButton({
  id,
  documentName,
  className = "btn btn-sm btn-danger",
  children = "Delete",
}: {
  id: string;
  documentName: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  function confirm() {
    setBusy(true);
    setOpen(false);
    formRef.current?.requestSubmit();
  }

  return (
    <>
      <form ref={formRef} action={deleteDocumentAction}>
        <input type="hidden" name="id" value={id} />
        <button type="button" className={className} onClick={() => setOpen(true)} disabled={busy}>
          {children}
        </button>
      </form>
      <ConfirmDialog
        open={open}
        title="Delete this document?"
        description={
          <>
            <strong>{documentName}</strong> will be removed from your documents workspace. The database record is retained for audit purposes, and your master
            profile, application history and other files stay intact.
          </>
        }
        confirmLabel="Delete document"
        onCancel={() => setOpen(false)}
        onConfirm={confirm}
      />
    </>
  );
}
