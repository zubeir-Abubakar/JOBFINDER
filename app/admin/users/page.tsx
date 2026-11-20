import { requireAdmin } from "@/lib/auth";
import { all } from "@/lib/db";
import { PageHead, Flash } from "@/components/ui";
import { formatDateTime, param } from "@/lib/format";
import { createUserAction, setUserStatusAction, resetUserPasswordAction, resetUserMfaAction } from "@/lib/actions/admin";
import { SubmitButton } from "@/components/SubmitButton";
import { PasswordInput } from "@/components/PasswordInput";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const admin = await requireAdmin();
  const sp = await searchParams;
  const users = all<{ id: string; email: string; name: string; role: string; status: string; created_at: string; last_login_at: string | null; mfa_enabled: number }>(
    "SELECT id, email, name, role, status, created_at, last_login_at, mfa_enabled FROM users ORDER BY created_at",
  );
  const sessions = all<{ user_id: string; count: number }>("SELECT user_id, COUNT(*) AS count FROM sessions WHERE expires_at > datetime('now') GROUP BY user_id");
  const sessionMap = new Map(sessions.map((s) => [s.user_id, s.count]));

  return (
    <>
      <Flash ok={param(sp.ok)} error={param(sp.error)} saved={param(sp.saved)} />
      <PageHead title="User accounts" sub="Roles are enforced on the server for every page and action. Administrator access is never available from the owner workspace." />

      <section className="card mb-4">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Account</th><th>Role</th><th>Status</th><th>Sessions</th><th>Last sign-in</th><th>Created</th><th /></tr></thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <div className="cell-title">{user.name}{user.id === admin.id ? " (you)" : ""}</div>
                    <div className="cell-sub">{user.email} · MFA {user.mfa_enabled ? "on" : "off"}</div>
                  </td>
                  <td><span className={`badge ${user.role === "admin" ? "badge-info" : "badge-neutral"}`}>{user.role}</span></td>
                  <td><span className={`badge ${user.status === "active" ? "badge-good" : "badge-bad"}`}>{user.status}</span></td>
                  <td className="num">{sessionMap.get(user.id) ?? 0}</td>
                  <td className="cell-sub">{user.last_login_at ? formatDateTime(user.last_login_at) : "never"}</td>
                  <td className="cell-sub">{formatDateTime(user.created_at)}</td>
                  <td>
                    <div className="row justify-end" style={{ gap: 4 }}>
                      {user.id !== admin.id ? (
                        <form action={setUserStatusAction}>
                          <input type="hidden" name="id" value={user.id} />
                          <input type="hidden" name="status" value={user.status === "active" ? "disabled" : "active"} />
                          <SubmitButton className="btn btn-sm" confirm={user.status === "active" ? `Disable ${user.email}? Existing sessions end immediately.` : undefined}>
                            {user.status === "active" ? "Disable" : "Enable"}
                          </SubmitButton>
                        </form>
                      ) : null}
                      {user.mfa_enabled ? (
                        <form action={resetUserMfaAction}>
                          <input type="hidden" name="id" value={user.id} />
                          <SubmitButton className="btn btn-sm" confirm={`Reset MFA for ${user.email}? Their sessions will end and they must re-enrol.`}>Reset MFA</SubmitButton>
                        </form>
                      ) : null}
                      <details>
                        <summary className="btn btn-sm" style={{ listStyle: "none", cursor: "pointer" }}>Reset password</summary>
                        <form action={resetUserPasswordAction} className="mt-2 flex gap-2" style={{ minWidth: "min(250px, 100%)" }}>
                          <input type="hidden" name="id" value={user.id} />
                          <PasswordInput id={`reset-password-${user.id}`} name="password" minLength={10} required placeholder="New password" autoComplete="new-password" />
                          <SubmitButton className="btn btn-sm" pendingLabel="Saving…">Set</SubmitButton>
                        </form>
                      </details>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" style={{ maxWidth: 640 }}>
        <div className="card-head">
          <div>
            <h2>Create an account</h2>
            <p className="card-sub">Only create accounts you control. No default credentials exist.</p>
          </div>
        </div>
        <div className="card-body">
          <form action={createUserAction} className="grid g2" style={{ gap: 10 }}>
            <div>
              <label className="label" htmlFor="name">Name</label>
              <input id="name" name="name" className="input" required />
            </div>
            <div>
              <label className="label" htmlFor="email">Email</label>
              <input id="email" name="email" type="email" className="input" required />
            </div>
            <div>
              <label className="label" htmlFor="role">Role</label>
              <select id="role" name="role" className="select" defaultValue="owner">
                <option value="owner">Owner (recruitment workspace)</option>
                <option value="admin">Administrator (system console)</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="password">Temporary password</label>
              <PasswordInput id="password" name="password" minLength={10} required autoComplete="new-password" />
            </div>
            <div className="flex items-end">
              <SubmitButton className="btn btn-primary" pendingLabel="Creating…">Create account</SubmitButton>
            </div>
          </form>
          <p className="hint mt-2">Password policy: 10+ characters, upper and lower case, a number and a symbol. Hashes use scrypt with per-password salts.</p>
        </div>
      </section>
    </>
  );
}
