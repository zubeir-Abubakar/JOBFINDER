"use client";

import Link from "next/link";
import { useActionState } from "react";
import { verifyMfaAction, type LoginState } from "@/app/login/actions";
import { SubmitButton } from "./SubmitButton";

export function MfaForm() {
  const [state, action] = useActionState<LoginState | undefined, FormData>(verifyMfaAction, undefined);

  return (
    <form action={action} className="stack" style={{ gap: 14 }}>
      {state?.error ? <div className="alert alert-error">{state.error}</div> : null}
      <div>
        <label className="label" htmlFor="mfa_code">
          Authenticator or recovery code
        </label>
        <input
          id="mfa_code"
          name="code"
          type="text"
          inputMode="text"
          autoComplete="one-time-code"
          autoFocus
          required
          className="input"
          placeholder="123456 or XXXX-XXXX-XXXX"
          maxLength={20}
        />
        <p className="hint mt-2">Open your authenticator app and enter the current six-digit code. Recovery codes also work once each.</p>
      </div>
      <SubmitButton trackDirty={false} pendingLabel="Verifying…" className="btn btn-primary w-full">
        Verify and continue
      </SubmitButton>
      <p className="text-center text-[11.5px]" style={{ color: "var(--muted)" }}>
        Wrong account? <Link href="/login">Start over</Link>
      </p>
    </form>
  );
}
