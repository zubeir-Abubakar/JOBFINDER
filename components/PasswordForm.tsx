"use client";

import { useActionState } from "react";
import { changePasswordAction, changeRequiredPasswordAction } from "@/lib/actions/session";
import { SubmitButton } from "./SubmitButton";
import { PasswordInput } from "./PasswordInput";

type State = { error?: string; ok?: string } | undefined;

export function PasswordForm({ required = false }: { required?: boolean }) {
  const [state, action] = useActionState<State, FormData>(required ? changeRequiredPasswordAction : changePasswordAction, undefined);

  return (
    <form action={action} className="stack" style={{ gap: 10 }}>
      {state?.error ? <div className="alert alert-error">{state.error}</div> : null}
      {state?.ok ? <div className="alert alert-ok">{state.ok}</div> : null}
      <div>
        <label className="label" htmlFor="current">Current password</label>
        <PasswordInput id="current" name="current" autoComplete="current-password" required />
      </div>
      <div className="grid g2" style={{ gap: 8 }}>
        <div>
          <label className="label" htmlFor="next">New password</label>
          <PasswordInput id="next" name="next" autoComplete="new-password" required minLength={10} />
        </div>
        <div>
          <label className="label" htmlFor="confirm">Confirm</label>
          <PasswordInput id="confirm" name="confirm" autoComplete="new-password" required minLength={10} />
        </div>
      </div>
      <p className="hint">Minimum 10 characters with upper case, lower case, a number and a symbol. Other sessions are signed out.</p>
      <SubmitButton className="btn btn-primary" pendingLabel="Updating…">
        {required ? "Update password and continue" : "Change password"}
      </SubmitButton>
    </form>
  );
}
