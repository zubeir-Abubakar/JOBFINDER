"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { loginAction, type LoginState } from "@/app/login/actions";
import { SubmitButton } from "./SubmitButton";
import { PasswordInput } from "./PasswordInput";

export function LoginForm() {
  const [state, action] = useActionState<LoginState | undefined, FormData>(loginAction, undefined);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    <form action={action} className="stack" style={{ gap: 14 }}>
      {state?.error ? <div className="alert alert-error">{state.error}</div> : null}

      <div>
        <label className="label" htmlFor="email">
          Email address
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="input"
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <div>
        <div className="flex items-center justify-between">
          <label className="label" htmlFor="password">
            Password
          </label>
          <Link href="/forgot" className="text-[11.5px]" style={{ color: "var(--muted)" }}>
            Forgot password?
          </Link>
        </div>
        <PasswordInput
          id="password"
          name="password"
          autoComplete="current-password"
          required
          placeholder="••••••••••"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      <label className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--ink-soft)" }}>
        <input type="checkbox" name="remember" defaultChecked /> Keep me signed in on this device
      </label>
      <SubmitButton trackDirty={false} pendingLabel="Signing in…" className="btn btn-primary w-full">
        Sign in
      </SubmitButton>
      <p className="text-center text-[11.5px]" style={{ color: "var(--muted)" }}>
        Protected by role-based access control. Admin and owner areas are separate.
      </p>
    </form>
  );
}
