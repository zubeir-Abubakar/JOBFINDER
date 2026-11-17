import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { PasswordForm } from "@/components/PasswordForm";
import { Brand } from "@/components/icons";
import { ThemeToggle } from "@/components/ThemeToggle";

export const dynamic = "force-dynamic";

export default async function ChangePasswordPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!user.must_change_password) redirect(user.role === "admin" ? "/admin" : "/dashboard");

  return (
    <div className="auth-wrap">
      <aside className="auth-aside">
        <div className="auth-grid" />
        <div className="relative">
          <Brand href="/login" />
        </div>
        <div className="relative max-w-[30rem]">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--muted)" }}>
            Account security
          </p>
          <h1 className="mt-3 text-[32px] leading-[1.14]">
            Set a new
            <br />
            administrator password.
          </h1>
          <p className="mt-4 text-[13.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
            The existing administrator identity and records were preserved, but the current password is still a known default. Replace it before opening the workspace.
          </p>
        </div>
        <p className="relative text-[11px]" style={{ color: "var(--muted)" }}>
          Passwords are hashed with scrypt. The application never stores or logs them in plain text.
        </p>
      </aside>
      <main className="auth-form-wrap">
        <div className="auth-form">
          <div className="mb-6 flex items-start justify-between">
            <div>
              <h2 className="text-[19px]">Required password change</h2>
              <p className="mt-1 text-[12.5px]" style={{ color: "var(--muted)" }}>
                Signed in as {user.email}
              </p>
            </div>
            <ThemeToggle compact />
          </div>
          <PasswordForm required />
          <p className="mt-4 text-[11.5px]" style={{ color: "var(--muted)" }}>
            After the change, all sessions are cleared and you will sign in again with the new password.
          </p>
        </div>
      </main>
    </div>
  );
}
