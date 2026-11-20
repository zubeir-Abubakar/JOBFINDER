"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { beginMfaSetupAction, confirmMfaSetupAction, disableMfaAction } from "@/lib/actions/mfa";
import { PasswordInput } from "./PasswordInput";

export function MfaSettings({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [setup, setSetup] = useState<{ secret: string; otpauth: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function begin() {
    setBusy(true);
    setError(null);
    setOk(null);
    const result = await beginMfaSetupAction();
    setBusy(false);
    if (result.error || !result.secret || !result.otpauth) {
      setError(result.error ?? "Authenticator setup could not start.");
      return;
    }
    setSetup({ secret: result.secret, otpauth: result.otpauth });
  }

  async function confirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await confirmMfaSetupAction(new FormData(event.currentTarget));
    setBusy(false);
    if (result.error || !result.recoveryCodes) {
      setError(result.error ?? "The authenticator code was not accepted.");
      return;
    }
    setRecoveryCodes(result.recoveryCodes);
    setSetup(null);
    router.refresh();
  }

  async function disable(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    const result = await disableMfaAction(new FormData(event.currentTarget));
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setOk(result.ok ?? "Two-factor authentication disabled.");
    router.refresh();
  }

  return (
    <section className="card mb-4" id="security">
      <div className="card-head">
        <div>
          <h2>Two-factor authentication</h2>
          <p className="card-sub">An authenticator code is required after your password. Recovery codes are shown once.</p>
        </div>
        <span className={`badge ${enabled ? "badge-good" : "badge-neutral"}`}>{enabled ? "Enabled" : "Not enabled"}</span>
      </div>
      <div className="card-body stack" style={{ gap: 12 }}>
        {error ? <div className="alert alert-error">{error}</div> : null}
        {ok ? <div className="alert alert-ok">{ok}</div> : null}

        {enabled && !recoveryCodes ? (
          <>
            <p className="text-[12.5px]" style={{ color: "var(--muted)" }}>
              Your account is protected by TOTP. Keep the recovery codes you saved during setup somewhere offline.
            </p>
            <form onSubmit={disable} className="grid g2" style={{ gap: 10, alignItems: "end" }}>
              <div>
                <label className="label" htmlFor="mfa_disable_password">Current password</label>
                <PasswordInput id="mfa_disable_password" name="password" autoComplete="current-password" required />
              </div>
              <div>
                <label className="label" htmlFor="mfa_disable_code">Authenticator code</label>
                <input id="mfa_disable_code" name="code" className="input" inputMode="numeric" autoComplete="one-time-code" placeholder="123456" required />
              </div>
              <div className="flex items-end" style={{ gridColumn: "1 / -1" }}>
                <button type="submit" className="btn btn-danger" disabled={busy}>{busy ? "Disabling…" : "Disable MFA"}</button>
              </div>
            </form>
          </>
        ) : null}

        {!enabled && !setup && !recoveryCodes ? (
          <>
            <p className="text-[12.5px]" style={{ color: "var(--muted)" }}>
              Add a second factor from any TOTP authenticator app. This protects the owner workspace and administrator console.
            </p>
            <div>
              <button type="button" className="btn btn-primary" onClick={begin} disabled={busy}>
                {busy ? "Preparing…" : "Set up authenticator"}
              </button>
            </div>
          </>
        ) : null}

        {setup ? (
          <div className="stack" style={{ gap: 12 }}>
            <p className="text-[12.5px]">
              1. Add this secret to your authenticator app. 2. Enter the current six-digit code below.
            </p>
            <div className="alert alert-info" style={{ wordBreak: "break-all" }}>
              <strong>{setup.secret}</strong>
              <div className="mt-2 text-[11px]">Manual setup key. The otpauth link is: <code>{setup.otpauth}</code></div>
            </div>
            <form onSubmit={confirm} className="flex items-end gap-2" style={{ flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 180px" }}>
                <label className="label" htmlFor="mfa_setup_code">Authenticator code</label>
                <input id="mfa_setup_code" name="code" className="input" inputMode="numeric" autoComplete="one-time-code" placeholder="123456" required autoFocus />
              </div>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Verifying…" : "Enable MFA"}</button>
              <button type="button" className="btn" disabled={busy} onClick={() => setSetup(null)}>Cancel</button>
            </form>
          </div>
        ) : null}

        {recoveryCodes ? (
          <div className="alert alert-ok">
            <strong>Save these recovery codes now.</strong>
            <p className="mt-1 text-[12px]">Each code works once. They are not shown again.</p>
            <div className="mt-3 grid g2" style={{ gap: 6 }}>
              {recoveryCodes.map((code) => <code key={code}>{code}</code>)}
            </div>
            <button type="button" className="btn btn-sm mt-3" onClick={() => setRecoveryCodes(null)}>I have saved them</button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
