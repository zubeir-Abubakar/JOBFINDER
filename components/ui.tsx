import Link from "next/link";
import { Icon } from "./icons";

export function PageHead({
  title,
  sub,
  actions,
}: {
  title: string;
  sub?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        {sub ? <p className="page-sub">{sub}</p> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </div>
  );
}

export function Stat({
  label,
  value,
  note,
  tone,
  href,
}: {
  label: string;
  value: number | string;
  note?: string;
  tone?: "good" | "warn" | "bad" | "info";
  href?: string;
}) {
  const color =
    tone === "good" ? "var(--accent)" : tone === "warn" ? "var(--warn)" : tone === "bad" ? "var(--danger)" : tone === "info" ? "var(--info)" : "var(--ink)";
  const body = (
    <>
      <div className="stat-top">
        <div className="stat-label">{label}</div>
        {href ? (
          <span className="stat-go" aria-hidden="true">
            <Icon name="arrow" size={12} />
          </span>
        ) : null}
      </div>
      <div className="stat-value num" style={{ color }}>
        {value}
      </div>
      {note ? <div className="stat-note">{note}</div> : null}
    </>
  );
  if (href) {
    return (
      <Link href={href} className="stat stat-link" aria-label={`${label}: ${value}${note ? `, ${note}` : ""}. Open details.`}>
        {body}
      </Link>
    );
  }
  return <div className="stat">{body}</div>;
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function Flash({
  ok,
  error,
  saved,
  deleted,
  cleanup,
  freed,
  discarded,
  denied,
  imported,
}: {
  ok?: string;
  error?: string;
  saved?: string;
  deleted?: string;
  cleanup?: string;
  freed?: string;
  discarded?: string;
  denied?: string;
  imported?: string;
}) {
  return (
    <>
      {ok ? <div className="alert alert-ok mb-4">{ok}</div> : null}
      {error ? <div className="alert alert-error mb-4">{error}</div> : null}
      {denied === "admin" ? <div className="alert alert-error mb-4">Administrator access is required for that area.</div> : null}
      {saved ? <div className="alert alert-ok mb-4">Changes saved.</div> : null}
      {deleted ? <div className="alert alert-ok mb-4">Document deleted. The database record is retained for audit purposes.</div> : null}
      {discarded ? <div className="alert alert-info mb-4">Extraction dismissed. Your profile was not changed.</div> : null}
      {cleanup !== undefined && cleanup !== "" ? (
        <div className="alert alert-ok mb-4">
          Retention run complete: {cleanup} document(s) removed{Number(freed ?? 0) > 0 ? `, ${(Number(freed) / 1024).toFixed(1)} KB freed` : ""}.
        </div>
      ) : null}
      {imported && Number(imported) > 0 ? <div className="alert alert-ok mb-4">{imported} skill(s) imported from your CV.</div> : null}
    </>
  );
}

export function CardLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="btn btn-sm">
      {label} <Icon name="arrow" size={12} />
    </Link>
  );
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="bar">
      <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}
