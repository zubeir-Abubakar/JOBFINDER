"use client";

import { useFormStatus } from "react-dom";
import { BrandSpinner } from "./BrandLoader";

export function SubmitButton({
  children,
  pendingLabel,
  className = "btn btn-primary",
  confirm,
  formAction,
  name,
  value,
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  className?: string;
  confirm?: string;
  formAction?: (formData: FormData) => void | Promise<void>;
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
      formAction={formAction}
      className={className}
      disabled={pending}
      data-pending={pending ? "true" : undefined}
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
