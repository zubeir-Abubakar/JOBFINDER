import { redirect } from "next/navigation";
import { currentUser, hasAnyUser } from "@/lib/auth";
import { LoginForm } from "@/components/LoginForm";
import { Brand } from "@/components/icons";
import { BrandMark } from "@/components/BrandMark";
import { AdminAccessMark } from "@/components/AdminAccessMark";
import { ThemeToggle } from "@/components/ThemeToggle";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (!hasAnyUser()) redirect("/setup");
  const user = await currentUser();
  if (user) redirect(user.must_change_password ? "/change-password" : user.role === "admin" ? "/admin" : "/dashboard");

  return (
    <div className="auth-wrap">
      <aside className="auth-aside">
        <div className="auth-grid" />
        <div className="relative">
          <Brand href="/login" />
        </div>
        <div className="relative max-w-[30rem]">
          <span className="auth-hero" aria-hidden>
            <BrandMark size={76} idPrefix="hero" />
          </span>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--muted)" }}>
            Multi-agent recruitment
          </p>
          <h1 className="mt-3 text-[34px] leading-[1.12]">
            One workforce for your
            <br />
            job search.
          </h1>
          <p className="mt-4 text-[13.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
            Specialist agents research Swiss QA vacancies, score the fit against your verified profile, produce ATS-ready documents and keep every
            application accountable — coordinated from a single workspace.
          </p>
          <div className="mt-7 grid grid-cols-3 gap-2 text-[11px]" style={{ color: "var(--muted)" }}>
            {["Research", "Tailoring", "Tracking"].map((label, i) => (
              <div key={label} className="glass p-3">
                <div className="num text-[18px] font-semibold" style={{ color: "var(--ink)" }}>
                  0{i + 1}
                </div>
                {label} agent
              </div>
            ))}
          </div>
        </div>
        <p className="relative text-[11px]" style={{ color: "var(--muted)" }}>
          Your CV and personal data stay in your own database. Nothing is published publicly.
        </p>
      </aside>

      <main className="auth-form-wrap">
        <div className="auth-form">
          <div className="mb-7 flex items-start justify-between">
            <div>
              <AdminAccessMark />
              <h2 className="mt-4 text-[19px]">Sign in</h2>
              <p className="mt-1 text-[12.5px]" style={{ color: "var(--muted)" }}>
                Owner workspace or administrator console.
              </p>
            </div>
            <ThemeToggle compact />
          </div>
          <LoginForm />
        </div>
      </main>
    </div>
  );
}
