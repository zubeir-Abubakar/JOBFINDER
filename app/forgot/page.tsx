import Link from "next/link";
import { Brand } from "@/components/icons";

export const dynamic = "force-dynamic";

export default function ForgotPage() {
  return (
    <div className="auth-form-wrap" style={{ minHeight: "100dvh" }}>
      <div className="auth-form card p-6">
        <Brand href="/login" />
        <h1 className="mt-6 text-[19px]">Password recovery</h1>
        <p className="mt-2 text-[13px] leading-relaxed" style={{ color: "var(--muted)" }}>
          Self-service reset needs an outbound email provider, which is not configured yet. Until then the administrator can reset your password from
          <span style={{ color: "var(--ink)" }}> Admin → User accounts</span>. No email address is disclosed on this page.
        </p>
        <div className="alert alert-info mt-4">Opening this page does not request a reset or write an audit entry.</div>
        <Link href="/login" className="btn btn-primary mt-5 w-full">
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
