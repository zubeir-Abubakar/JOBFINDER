import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { setupPageState } from "@/lib/setup-security";
import { Brand } from "@/components/icons";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SetupForm } from "@/components/SetupForm";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const state = setupPageState(await headers());
  if (state.closed) redirect("/login");
  if (!state.allowed) notFound();
  return (
    <div className="auth-wrap">
      <aside className="auth-aside">
        <div className="auth-grid" />
        <div className="relative">
          <Brand href="/setup" />
        </div>
        <div className="relative max-w-[30rem]">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--muted)" }}>
            First-run setup
          </p>
          <h1 className="mt-3 text-[32px] leading-[1.14]">
            Provision your
            <br />
            private workforce.
          </h1>
          <p className="mt-4 text-[13.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
            This page is only available while no accounts exist. Create the owner workspace and a separate administrator console, then sign in.
          </p>
          <ul className="mt-6 space-y-2 text-[12px]" style={{ color: "var(--muted)" }}>
            <li>· scrypt password hashing, database-backed sessions</li>
            <li>· owner and admin roles enforced server-side</li>
            <li>· local SQLite database in ./data</li>
          </ul>
        </div>
        <p className="relative text-[11px]" style={{ color: "var(--muted)" }}>
          Alternatively set OWNER_EMAIL / OWNER_PASSWORD and ADMIN_EMAIL / ADMIN_PASSWORD before first start.
        </p>
      </aside>
      <main className="auth-form-wrap">
        <div className="auth-form" style={{ maxWidth: 420 }}>
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h2 className="text-[19px]">Create accounts</h2>
              <p className="mt-1 text-[12.5px]" style={{ color: "var(--muted)" }}>
                One-time provisioning.
              </p>
            </div>
            <ThemeToggle compact />
          </div>
          <SetupForm tokenRequired={state.tokenRequired} />
        </div>
      </main>
    </div>
  );
}
