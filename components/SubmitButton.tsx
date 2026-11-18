"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { BrandSpinner } from "./BrandLoader";

function isEditableControl(element: Element): boolean {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
  if (element instanceof HTMLInputElement) {
    return !["hidden", "submit", "button", "reset", "image"].includes(element.type);
  }
  return element instanceof HTMLElement && element.isContentEditable;
}

function formSnapshot(form: HTMLFormElement): string {
  return Array.from(new FormData(form).entries())
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : `${value.name}:${value.size}`}`)
    .join("|");
}

export function SubmitButton({
  children,
  pendingLabel,
  className = "btn btn-primary",
  confirm,
  formAction,
  name,
  value,
  trackDirty = true,
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  className?: string;
  confirm?: string;
  formAction?: (formData: FormData) => void | Promise<void>;
  name?: string;
  value?: string | number;
  /** Disable a save action until an editable field in its form changes. */
  trackDirty?: boolean;
}) {
  const { pending } = useFormStatus();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [ready, setReady] = useState(false);
  const [hasEditableFields, setHasEditableFields] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const form = buttonRef.current?.form;
    if (!form) {
      setReady(true);
      setDirty(true);
      return;
    }
    const editable = Array.from(form.elements).some(isEditableControl);
    setHasEditableFields(editable);
    setReady(true);
    setDirty(!editable);
    if (!editable) return;

    const initial = formSnapshot(form);
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (form.isConnected) setDirty(formSnapshot(form) !== initial);
      });
    };
    form.addEventListener("input", update);
    form.addEventListener("change", update);
    return () => {
      cancelAnimationFrame(frame);
      form.removeEventListener("input", update);
      form.removeEventListener("change", update);
    };
  }, []);

  const waitingForEdit = trackDirty && !formAction && ready && hasEditableFields && !dirty;

  return (
    <button
      ref={buttonRef}
      type="submit"
      name={name}
      value={value}
      formAction={formAction}
      className={className}
      disabled={pending || waitingForEdit}
      title={waitingForEdit ? "Edit a field to enable this button" : undefined}
      data-pending={pending ? "true" : undefined}
      data-dirty={dirty ? "true" : undefined}
      onClick={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault();
      }}
    >
      {pending ? (
        <>
          <BrandSpinner />
          {pendingLabel ?? "Working…"}
        </>
      ) : (
        children
      )}
    </button>
  );
}
