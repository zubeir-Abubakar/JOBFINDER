import { redirect } from "next/navigation";
import { currentUser, hasAnyUser } from "@/lib/auth";
import { LoginForm } from "@/components/LoginForm";
import { Brand } from "@/components/icons";
import { BrandMark } from "@/components/BrandMark";
import { AdminAccessMark } from "@/components/AdminAccessMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { AuthScene } from "@/components/AuthScene";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (!hasAnyUser()) redirect("/setup");
  const user = await currentUser();
  if (user) redirect(user.must_change_password ? "/change-password" : user.role === "admin" ? "/admin" : "/dashboard");

  return (
    <div className="auth-wrap auth-wrap-modern">
      <aside className="auth-aside auth-aside-rich">
        <div className="auth-aurora auth-aurora-one" aria-hidden="true" />
        <div className="auth-aurora auth-aurora-two" aria-hidden="true" />
        <div className="auth-grid" />
        <div className="relative auth-brand-row">
          <Brand href="/login" />
          <span className="auth-secure-pill"><span className="dot" /> Private workspace</span>
        </div>

        <div className="relative auth-hero-copy">
          <span className="auth-eyebrow">
            <span className="auth-eyebrow-spark"><BrandMark size={15} idPrefix="eyebrow" /></span>
            Multi-agent recruitment
          </span>
          <h1>
            Your job search,
            <br />
            <span className="gradient-text">on autopilot.</span>
          </h1>
          <p className="auth-hero-sub">
            Eight specialist agents research Swiss QA vacancies, score the fit, tailor ATS-ready documents and keep every application accountable — coordinated
            from one private workspace.
          </p>

          <div className="auth-proof-grid">
            {[
              ["01", "Research", "Finds real vacancies"],
              ["02", "Tailoring", "Writes from verified facts"],
              ["03", "Tracking", "Keeps you in control"],
            ].map(([number, label, detail]) => (
              <div key={label} className="auth-proof-card">
                <span className="auth-proof-number num">{number}</span>
                <span className="auth-proof-label">{label}</span>
                <span className="auth-proof-detail">{detail}</span>
              </div>
            ))}
          </div>

          <AuthScene />
        </div>

        <div className="relative auth-aside-footer">
          <span className="auth-trust-item"><span className="auth-trust-mark"><BrandMark size={14} idPrefix="trust" /></span> Local SQLite vault</span>
          <span className="auth-trust-item">No public CV data</span>
          <span className="auth-trust-item">Human approval by default</span>
        </div>
      </aside>

      <main className="auth-form-wrap auth-form-panel">
        <div className="auth-mobile-brand">
          <Brand href="/login" />
          <ThemeToggle compact />
        </div>
        <div className="auth-form auth-form-card">
          <div className="auth-form-top">
            <AdminAccessMark />
            <span className="auth-form-top-note">Secure session</span>
          </div>
          <div className="auth-form-heading">
            <span className="auth-kicker">Welcome back</span>
            <h2>Sign in to your workspace</h2>
            <p>Owner workspace or administrator console.</p>
          </div>
          <LoginForm />
          <div className="auth-form-footer">
            <span className="auth-lock-dot" aria-hidden="true" />
            Passwords are hashed with scrypt. Admin and owner areas stay separate.
          </div>
        </div>
        <div className="auth-mobile-scene">
          <AuthScene idPrefix="mini-me-mobile" />
        </div>
      </main>
    </div>
  );
}
