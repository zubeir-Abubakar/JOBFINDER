import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { one } from "@/lib/db";
import { PageHead } from "@/components/ui";
import { DocumentPreview } from "@/components/DocumentPreview";
import { formatBytes, formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function DocumentPreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const doc = one<{
    id: string;
    user_id: string;
    kind: string;
    display_name: string;
    file_name: string;
    mime: string;
    size_bytes: number;
    ats_score: number | null;
    quality_status: string | null;
    quality_score: number | null;
    quality_report: string | null;
    version: string | null;
    created_at: string;
    deleted_at: string | null;
  }>("SELECT id, user_id, kind, display_name, file_name, mime, size_bytes, ats_score, quality_status, quality_score, quality_report, version, created_at, deleted_at FROM documents WHERE id = ?", [id]);
  if (!doc || doc.deleted_at) notFound();
  if (user.role !== "admin" && doc.user_id !== user.id) notFound();

  const label = doc.kind === "tailored_cv" ? "Tailored CV" : doc.kind === "cover_letter" ? "Cover letter" : "Original CV";
  let quality: {
    status: string;
    score: number;
    checks: Array<{ label: string; passed: boolean; detail: string }>;
    issues: Array<{ severity: string; message: string }>;
  } | null = null;
  try {
    quality = doc.quality_report ? JSON.parse(doc.quality_report) : null;
  } catch {
    quality = null;
  }

  return (
    <>
      <div className="mb-4">
        <Link href="/documents" className="text-[12px]" style={{ color: "var(--muted)" }}>← Back to documents</Link>
      </div>
      <PageHead
        title={`${label} · ${doc.display_name.split("·")[0].trim()}`}
        sub={`${formatBytes(doc.size_bytes)} · ${doc.mime.includes("pdf") ? "PDF" : "DOCX"}${doc.version ? ` · v${doc.version}` : ""}${doc.ats_score !== null ? ` · ATS ${doc.ats_score}/100` : ""}${doc.quality_status ? ` · Quality ${doc.quality_status}${doc.quality_score !== null ? ` (${doc.quality_score}/100)` : ""}` : ""} · created ${formatDateTime(doc.created_at)}`}
        actions={
          <>
            <a href={`/api/documents/${doc.id}`} className="btn" download={doc.file_name}>Download original</a>
            <Link href="/documents" className="btn">All documents</Link>
          </>
        }
      />
      <section className="card">
        <DocumentPreview id={doc.id} name={doc.file_name} mime={doc.mime} />
      </section>
      {quality ? (
        <section className="card mt-4">
          <div className="card-head">
            <div>
              <h2>Document quality gate</h2>
              <p className="card-sub">Validated against the uploaded original: role and section retention, bullet-level history, contact details, claims, page integrity and extractable text.</p>
            </div>
            <span className={`badge ${quality.status === "passed" ? "badge-good" : quality.status === "failed" ? "badge-warn" : "badge-neutral"}`}>
              {quality.status} · {quality.score}/100
            </span>
          </div>
          <div className="card-body">
            <div className="split" style={{ gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr)" }}>
              <div className="stack" style={{ gap: 6 }}>
                {quality.checks.map((item) => (
                  <div key={item.label} className="text-[12px]">
                    <span style={{ color: item.passed ? "var(--good, #137a4b)" : "var(--danger, #a33a2b)" }}>{item.passed ? "Pass" : "Fail"}</span>{" "}
                    <strong>{item.label}</strong> — <span style={{ color: "var(--muted)" }}>{item.detail}</span>
                  </div>
                ))}
              </div>
              <div className="card-quiet p-3">
                <div className="label">Issues</div>
                {quality.issues.length ? (
                  <ul className="mt-2 text-[12px]" style={{ paddingLeft: 16, color: "var(--ink-soft)" }}>
                    {quality.issues.map((item, index) => (
                      <li key={`${item.message}-${index}`}><strong>{item.severity}</strong>: {item.message}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-[12px]" style={{ color: "var(--muted)" }}>No issues recorded.</p>
                )}
              </div>
            </div>
          </div>
        </section>
      ) : null}
      <p className="hint" style={{ padding: "10px 4px" }}>
        This preview is private to your session. The file is streamed from local private storage through an authenticated route, never a public URL.
      </p>
    </>
  );
}
