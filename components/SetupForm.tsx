"use client";

import { useActionState } from "react";
import { setupAction, type SetupState } from "@/app/setup/actions";
import { SubmitButton } from "./SubmitButton";
import { PasswordInput } from "./PasswordInput";

export function SetupForm({ tokenRequired = false }: { tokenRequired?: boolean }) {
  const [state, action] = useActionState<SetupState | undefined, FormData>(setupAction, undefined);

  return (
    <form action={action} className="stack">
      {state?.error ? <div className="alert alert-error">{state.error}</div> : null}
      <div className="card p-4">
        <h3 className="text-[14px]">Owner account</h3>
        <p className="card-sub mb-3">Your private recruitment workspace.</p>
        <div className="stack" style={{ gap: 10 }}>
          <div>
            <label className="label" htmlFor="owner_name">Full name</label>
            <input id="owner_name" name="owner_name" className="input" defaultValue="Abubakar Towfiq" required />
          </div>
          <div>
            <label className="label" htmlFor="owner_email">Email</label>
            <input id="owner_email" name="owner_email" type="email" className="input" placeholder="you@example.com" required />
          </div>
          <div>
            <label className="label" htmlFor="owner_password">Password</label>
            <PasswordInput id="owner_password" name="owner_password" required minLength={10} autoComplete="new-password" describedBy="owner_password_hint" />
            <p className="hint" id="owner_password_hint">At least 10 characters with upper case, lower case, a number and a symbol.</p>
          </div>
        </div>
      </div>
      <div className="card p-4">
        <h3 className="text-[14px]">Administrator account</h3>
        <p className="card-sub mb-3">Separate role. Cannot be reached from the owner workspace.</p>
        <div className="stack" style={{ gap: 10 }}>
          <div>
            <label className="label" htmlFor="admin_email">Admin email</label>
            <input id="admin_email" name="admin_email" type="email" className="input" placeholder="admin@example.com" required />
          </div>
          <div>
            <label className="label" htmlFor="admin_password">Admin password</label>
            <PasswordInput id="admin_password" name="admin_password" required minLength={10} autoComplete="new-password" />
          </div>
        </div>
      </div>
      {tokenRequired ? (
        <div className="card p-4">
          <h3 className="text-[14px]">Setup authorization</h3>
          <p className="card-sub mb-3">Enter the one-time token configured by the operator. It is never displayed or returned by the server.</p>
          <label className="label" htmlFor="setup_token">Setup token</label>
          <input
            id="setup_token"
            name="setup_token"
            type="password"
            className="input"
            autoComplete="off"
            required
          />
        </div>
      ) : null}
      <SubmitButton pendingLabel="Provisioning…" className="btn btn-primary w-full">
        Create accounts and open workspace
      </SubmitButton>
      <p className="text-center text-[11px]" style={{ color: "var(--muted)" }}>
        Passwords are hashed with scrypt and never stored in plain text.
      </p>
    </form>
  );
}
