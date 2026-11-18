import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { all, one } from "@/lib/db";
import { storageStats } from "@/lib/retention";
import { getSetting } from "@/lib/settings";
import { getProfileData } from "@/lib/profile";
import { PageHead, Empty, Flash, Progress } from "@/components/ui";
import { formatBytes, formatDate, formatDateTime, param } from "@/lib/format";
import { UploadForm } from "@/components/UploadForm";
import { SubmitButton } from "@/components/SubmitButton";
import { applyExtractionAction, discardExtractionAction } from "@/lib/actions/documents";
import { Icon } from "@/components/icons";
import { DocumentDeleteButton } from "@/components/DocumentDeleteButton";
import { DocumentsBulkTable } from "@/components/DocumentsBulkTable";

export const dynamic = "force-dynamic";

type DocRow = {
  id: string;
  kind: string;
  display_name: string;
  file_name: string;
  mime: string;
  size_bytes: number;
  version: string | null;
  status: string;
  pinned: number;
  ats_score: number | null;
  quality_status: string | null;
  quality_score: number | null;
  created_at: string;
  expires_at: string | null;
  company: string | null;
  title: string | null;
  job_id: string | null;
};

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const profile = getProfileData();
  const pending = getSetting<{
    documentId: string;
    fileName: string;
    fields: { name?: string; email?: string; phone?: string; linkedin?: string; skills?: string[] };
    preview: string;
    extractedAt: string;
  } | null>("pending_cv_extraction", null);

  const documents = all<DocRow>(
    `SELECT d.id, d.kind, d.display_name, d.file_name, d.mime, d.size_bytes, d.version, d.status, d.pinned, d.ats_score,
            d.quality_status, d.quality_score, d.created_at, d.expires_at, j.company, j.title, d.job_id
     FROM documents d LEFT JOIN jobs j ON j.id = d.job_id
     WHERE d.user_id = ? AND d.deleted_at IS NULL ORDER BY d.created_at DESC`,
    [user.id],
  ).map((doc) => ({ ...doc }));
  const kindParam = param(sp.kind);
  const kindFilter = kindParam === "tailored_cv" || kindParam === "cover_letter" ? kindParam : null;
  const originals = documents.filter((d) => d.kind === "original_cv");
  const generated = documents.filter((d) => d.kind !== "original_cv" && (!kindFilter || d.kind === kindFilter));
  const stats = storageStats();
  const retention = getSetting<number>("retention_days", 30);
  const autoDelete = getSetting<boolean>("auto_delete_expired", true);
  const activeCv = profile.profile.source_cv_id ? one<{ id: string }>("SELECT id FROM documents WHERE id = ? AND deleted_at IS NULL", [profile.profile.source_cv_id]) : null;

  return (
    <>
      <Flash
        ok={param(sp.ok)}
        error={param(sp.error)}
        saved={param(sp.saved)}
        deleted={param(sp.deleted)}
        discarded={param(sp.discarded)}
        cleanup={param(sp.cleanup)}
        freed={param(sp.freed)}
      />
      <PageHead
        title="My CV & documents"
        sub="Your original CV is preserved until you replace or delete it. Tailored documents are versioned per vacancy and expire under your retention policy."
        actions={<a href="/api/export/applications" className="btn">Export applications CSV</a>}
      />

      {pending ? (
        <section className="card mb-4" style={{ borderColor: "var(--accent)" }}>
          <div className="card-head">
            <div>
              <h2>Review extracted information</h2>
              <p className="card-sub">
                Parsed from {pending.fileName} · {formatDateTime(pending.extractedAt)}. Nothing is applied until you confirm.
              </p>
            </div>
            <span className="badge badge-warn">Awaiting review</span>
          </div>
          <div className="card-body">
            <div className="split" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.2fr)" }}>
              <form action={applyExtractionAction} className="stack" style={{ gap: 12 }}>
                <div>
                  <label className="label">Detected values</label>
                  <div className="stack" style={{ gap: 8 }}>
                    {[
                      ["include_name", "Full name", pending.fields.name],
                      ["include_email", "Email", pending.fields.email],
                      ["include_phone", "Phone", pending.fields.phone],
                      ["include_linkedin", "LinkedIn", pending.fields.linkedin],
                    ].map(([name, label, value]) => (
                      <label key={String(name)} className="flex items-center gap-2 text-[12.5px]" style={{ opacity: value ? 1 : 0.5 }}>
                        <input type="checkbox" name={String(name)} defaultChecked={Boolean(value)} disabled={!value} />
                        <span style={{ minWidth: 70, color: "var(--muted)" }}>{label}</span>
                        <span>{value || "Not detected — add manually in your profile"}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="label">Recognised technologies ({pending.fields.skills?.length ?? 0})</label>
                  <div className="row">
                    {(pending.fields.skills ?? []).map((skill) => (
                      <span key={skill} className="chip">{skill}</span>
                    ))}
                  </div>
                  <label className="mt-2 flex items-center gap-2 text-[12.5px]">
                    <input type="checkbox" name="include_skills" defaultChecked /> Add missing skills to my library
                  </label>
                </div>
                <div className="row">
                  <SubmitButton className="btn btn-primary" pendingLabel="Applying…" trackDirty={false}>Apply to profile</SubmitButton>
                </div>
              </form>
              <div>
                <div className="label">Text preview</div>
                <pre
                  className="card-quiet p-3 text-[11.5px] leading-relaxed"
                  style={{ maxHeight: 230, overflow: "auto", whiteSpace: "pre-wrap", color: "var(--ink-soft)" }}
                >
                  {pending.preview}
                </pre>
                <form action={discardExtractionAction} className="mt-2">
                  <SubmitButton className="btn btn-sm">Discard extraction</SubmitButton>
                </form>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <div className="split mb-4">
        <section className="card" id="upload">
          <div className="card-head">
            <div>
              <h2>Original CV</h2>
              <p className="card-sub">The authoritative source for employment history. Uploading a new CV archives the previous one.</p>
            </div>
            {originals.length > 0 ? <span className="badge badge-good">On file</span> : <span className="badge badge-warn">Not uploaded</span>}
          </div>
          <div className="card-body">
            <UploadForm />
            {originals.length > 0 ? (
              <div className="mt-4 stack" style={{ gap: 8 }}>
                {originals.map((doc) => (
                  <div key={doc.id} className="card-quiet p-3">
                    <div className="between">
                      <div className="min-w-0">
                        <div className="truncate text-[12.5px] font-medium">{doc.display_name}</div>
                        <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                          {formatBytes(doc.size_bytes)} · uploaded {formatDate(doc.created_at)} · {doc.status}
                          {activeCv?.id === doc.id ? " · active profile source" : ""}
                        </div>
                      </div>
                      <div className="row">
                        <Link href={`/documents/${doc.id}`} className="btn btn-sm">Preview</Link>
                        <a href={`/api/documents/${doc.id}`} className="btn btn-sm">Download</a>
                        <DocumentDeleteButton id={doc.id} documentName={doc.display_name} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h2>Storage</h2>
              <p className="card-sub">Files are stored privately in ./data/uploads and served only through authenticated downloads.</p>
            </div>
            <Link href="/settings#documents" className="btn btn-sm">Retention</Link>
          </div>
          <div className="card-body stack" style={{ gap: 10 }}>
            <div>
              <div className="between text-[12px]"><span>Total used</span><span className="num">{formatBytes(stats.totalBytes)}</span></div>
              <div className="mt-1.5"><Progress value={Math.min(100, (stats.totalBytes / (50 * 1024 * 1024)) * 100)} /></div>
              <p className="hint">{stats.originalCount} original · {stats.tailoredCount} tailored CV files · {stats.coverCount} cover letter files</p>
            </div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Original CV</span><span className="num">{formatBytes(stats.originalBytes)}</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Tailored CVs</span><span className="num">{formatBytes(stats.tailoredBytes)}</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Cover letters</span><span className="num">{formatBytes(stats.coverBytes)}</span></div>
            <div className="card-quiet p-3 text-[11.5px]" style={{ color: "var(--muted)" }}>
              Retention: {retention} days after confirmed submission · automatic deletion {autoDelete ? "enabled" : "disabled"}. Original CV, profile and application history are never auto-deleted.
              {stats.expiringSoon.length ? ` ${stats.expiringSoon.length} document(s) expire within 7 days.` : ""}
            </div>
          </div>
        </section>
      </div>

      <section className="card" id="tailored-documents">
        <div className="card-head">
          <div>
            <h2>{kindFilter === "tailored_cv" ? "Tailored CVs" : kindFilter === "cover_letter" ? "Cover letters" : "Tailored documents"}</h2>
            <p className="card-sub">Each file is tied to the vacancy it was written for. ATS scores are internal self-assessments.</p>
          </div>
          <div className="row">
            {kindFilter ? <Link href="/documents#tailored-documents" className="btn btn-sm">Show all documents</Link> : null}
            <Link href="/jobs" className="btn btn-sm"><Icon name="jobs" /> Find a vacancy</Link>
          </div>
        </div>
        {generated.length === 0 ? (
          <Empty title={kindFilter ? `No ${kindFilter === "tailored_cv" ? "tailored CVs" : "cover letters"} yet` : "No tailored documents yet"}>
            Open a vacancy and generate a package. The CV agent will only use facts from your master profile.
          </Empty>
        ) : (
          <div className="card-body documents-table-body">
            <DocumentsBulkTable documents={generated} />
          </div>
        )}
      </section>
    </>
  );
}
