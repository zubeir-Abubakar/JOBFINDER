import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { all } from "@/lib/db";
import { PageHead, Empty, Flash } from "@/components/ui";
import { formatDate, param } from "@/lib/format";
import { Icon } from "@/components/icons";
import { markEmailHandoffSentAction } from "./actions";

export const dynamic = "force-dynamic";

type HandoffRow = {
  job_id: string;
  title: string;
  company: string;
  location: string | null;
  match_score: number | null;
  application_email: string;
  application_email_verified_at: string | null;
  employer_url: string | null;
  application_id: string | null;
  status: string | null;
  cv_document_id: string | null;
  cover_document_id: string | null;
  cv_name: string | null;
  cover_name: string | null;
  email_handoff_sent_at: string | null;
  email_handoff_note: string | null;
};

/**
 * Owner handoff for verified email-application vacancies.
 *
 * Nothing is sent from this page. It shows the verified employer address and
 * links the exact prepared documents. The owner sends from their own mail
 * client and records the send here; that receipt is an attestation, not
 * employer confirmation.
 */
export default async function EmailHandoffPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const sp = await searchParams;

  const rows = all<HandoffRow>(
    `SELECT j.id AS job_id, j.title, j.company, j.location, j.match_score, j.application_email,
            j.application_email_verified_at, j.employer_url,
            a.id AS application_id, a.status,
            a.cv_document_id, a.cover_letter_id AS cover_document_id,
            cv.file_name AS cv_name, cl.file_name AS cover_name,
            a.email_handoff_sent_at, a.email_handoff_note
     FROM jobs j
     LEFT JOIN applications a ON a.job_id = j.id
     LEFT JOIN documents cv ON cv.id = a.cv_document_id AND cv.deleted_at IS NULL
     LEFT JOIN documents cl ON cl.id = a.cover_letter_id AND cl.deleted_at IS NULL
     WHERE j.application_email IS NOT NULL
     ORDER BY (a.email_handoff_sent_at IS NOT NULL), j.match_score DESC NULLS LAST, j.company COLLATE NOCASE`,
  );

  const sent = rows.filter((row) => row.email_handoff_sent_at).length;
  const withPackage = rows.filter((row) => row.cv_document_id && row.cover_document_id).length;
  const documentsAvailable = rows.reduce(
    (sum, row) => sum + (row.cv_name ? 1 : 0) + (row.cover_name ? 1 : 0),
    0,
  );

  return (
    <>
      <Flash ok={param(sp.ok)} error={param(sp.error)} />
      <PageHead
        title="Email handoffs"
        sub="These employers accept applications by email. The address is verified from the employer's own page; nothing is sent automatically. Download the prepared documents, send them from your own mail client, then record the send."
        actions={
          <Link href="/recruitment" className="btn">
            <Icon name="docs" /> Recruitment queue
          </Link>
        }
      />

      <section className="stats mb-4">
        <div className="stat">
          <span className="stat-label">Email vacancies</span>
          <span className="stat-value">{rows.length}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Complete packages</span>
          <span className="stat-value">{withPackage}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Documents available</span>
          <span className="stat-value">{documentsAvailable}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Sent by you</span>
          <span className="stat-value">{sent}</span>
        </div>
      </section>

      {rows.length === 0 ? (
        <Empty title="No email handoffs">
          <p className="hint">
            Vacancies resolved to a verified employer email address will appear here. They are never sent automatically.
          </p>
        </Empty>
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          {rows.map((row) => {
            const subject = `Application: ${row.title} — ${row.company}`;
            const body = [
              "Hello,",
              "",
              `I would like to apply for the ${row.title} position at ${row.company}.`,
              "Please find my CV and cover letter attached.",
              "",
              "Kind regards,",
            ].join("\r\n");
            const mailto = `mailto:${row.application_email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
            const hasCv = Boolean(row.cv_document_id);
            const hasCover = Boolean(row.cover_document_id);
            const isSent = Boolean(row.email_handoff_sent_at);
            return (
              <section className="card" key={row.job_id}>
                <div className="card-head">
                  <div>
                    <h2>{row.title}</h2>
                    <p className="card-sub">
                      {row.company}
                      {row.location ? ` · ${row.location}` : ""}
                      {row.match_score !== null ? ` · ${row.match_score}% match` : ""}
                      {row.application_email_verified_at
                        ? ` · address verified ${formatDate(row.application_email_verified_at)}`
                        : ""}
                    </p>
                  </div>
                  <span className={`badge ${isSent ? "badge-good" : hasCv && hasCover ? "badge-good" : "badge-warn"}`}>
                    {isSent ? "Sent by you" : hasCv && hasCover ? "Documents ready" : "Package incomplete"}
                  </span>
                </div>
                <div className="card-body stack" style={{ gap: 12 }}>
                  <div className="between" style={{ gap: 12, flexWrap: "wrap" }}>
                    <div>
                      <div className="cell-sub">Verified employer address</div>
                      <code style={{ fontSize: 15 }}>{row.application_email}</code>
                    </div>
                    <div className="row" style={{ gap: 8 }}>
                      <a className="btn btn-primary" href={mailto}>
                        <Icon name="mail" /> Open email draft
                      </a>
                      {row.employer_url ? (
                        <a className="btn" href={row.employer_url} target="_blank" rel="noreferrer">
                          Employer page
                        </a>
                      ) : null}
                      {row.application_id ? (
                        <Link className="btn" href={`/applications/${row.application_id}`}>
                          Application
                        </Link>
                      ) : (
                        <Link className="btn" href={`/jobs/${row.job_id}`}>
                          Vacancy
                        </Link>
                      )}
                    </div>
                  </div>

                  <div>
                    <div className="cell-sub">Prepared documents</div>
                    <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                      {hasCv ? (
                        <a className="btn" href={`/api/documents/${row.cv_document_id}`}>
                          <Icon name="docs" /> {row.cv_name ?? "Tailored CV"}
                        </a>
                      ) : null}
                      {hasCover ? (
                        <a className="btn" href={`/api/documents/${row.cover_document_id}`}>
                          <Icon name="docs" /> {row.cover_name ?? "Cover letter"}
                        </a>
                      ) : null}
                      {!hasCv && !hasCover ? (
                        <span className="hint">
                          No documents are linked yet.{" "}
                          <Link href={`/jobs/${row.job_id}`}>Open the vacancy</Link> to prepare them.
                        </span>
                      ) : null}
                    </div>
                  </div>

                  {isSent ? (
                    <div className="card" style={{ boxShadow: "none", border: "1px solid var(--border)" }}>
                      <div className="card-body stack" style={{ gap: 6 }}>
                        <div className="between">
                          <strong>Sent by you</strong>
                          <span className="badge badge-good">{formatDate(row.email_handoff_sent_at!)}</span>
                        </div>
                        {row.email_handoff_note ? (
                          <p className="hint" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{row.email_handoff_note}</p>
                        ) : (
                          <p className="hint" style={{ margin: 0 }}>No note was recorded.</p>
                        )}
                        <p className="hint" style={{ margin: 0 }}>
                          This is your attestation. Employer confirmation is still pending and is not inferred from this receipt.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <form action={markEmailHandoffSentAction} className="stack" style={{ gap: 8 }}>
                      <input type="hidden" name="applicationId" value={row.application_id ?? ""} />
                      <label className="cell-sub" htmlFor={`note-${row.job_id}`}>
                        Note (optional): recipient, date, or anything worth remembering
                      </label>
                      <textarea
                        id={`note-${row.job_id}`}
                        name="note"
                        className="textarea"
                        rows={3}
                        maxLength={2000}
                        placeholder="For example: sent from abubakar@… on 27 Nov, attached CV and cover letter."
                      />
                      <div className="row" style={{ gap: 8 }}>
                        <button className="btn" type="submit" disabled={!row.application_id}>
                          <Icon name="check" /> Mark as sent
                        </button>
                        <span className="hint" style={{ margin: 0 }}>
                          Records the timestamp and note only. It never sends an email and never counts as employer confirmation.
                        </span>
                      </div>
                    </form>
                  )}

                  {!isSent ? (
                    <p className="hint" style={{ margin: 0 }}>
                      “Open email draft” only opens your mail client with the address and subject prefilled. Attach the downloaded
                      documents yourself.
                    </p>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
