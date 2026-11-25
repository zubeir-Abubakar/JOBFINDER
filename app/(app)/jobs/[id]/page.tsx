import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { all, one } from "@/lib/db";
import { jobById } from "@/lib/jobs";
import { type JobAnalysis, flagClass, flagLabel } from "@/lib/scoring";
import { PageHead, Empty, Flash, Progress } from "@/components/ui";
import { formatDate, formatDateTime, param } from "@/lib/format";
import { analyseJobAction, setJobStatusAction, createApplicationForJobAction } from "@/lib/actions/jobs";
import { generatePackageAction } from "@/lib/actions/documents";
import { SubmitButton } from "@/components/SubmitButton";
import { Icon } from "@/components/icons";
import { statusLabel } from "@/lib/application-status";
import { AgentAvatar } from "@/components/AgentAvatar";
import { GermanRequirementCard } from "@/components/GermanRequirementCard";

export const dynamic = "force-dynamic";

const DIMENSION_LABELS: Record<string, string> = {
  technical: "Technical skills",
  experience: "Relevant experience",
  seniority: "Seniority",
  language: "Language compatibility",
  location: "Location & authorisation",
};

export default async function JobDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const job = jobById(id);
  if (!job) notFound();

  const analysis: JobAnalysis | null = job.analysis ? (JSON.parse(job.analysis) as JobAnalysis) : null;
  const application = one<{ id: string; status: string; approved_at: string | null; submitted_at: string | null; confirmation: string | null }>(
    "SELECT id, status, approved_at, submitted_at, confirmation FROM applications WHERE job_id = ?",
    [job.id],
  );
  const documents = all<{ id: string; display_name: string; kind: string; version: string; status: string; ats_score: number | null; quality_status: string | null; quality_score: number | null; created_at: string; mime: string }>(
    "SELECT id, display_name, kind, version, status, ats_score, quality_status, quality_score, created_at, mime FROM documents WHERE job_id = ? AND deleted_at IS NULL ORDER BY created_at DESC",
    [job.id],
  );

  return (
    <>
      <Flash ok={param(sp.ok)} error={param(sp.error)} />
      <div className="mb-4">
        <Link href="/jobs" className="text-[12px]" style={{ color: "var(--muted)" }}>← Back to job discovery</Link>
      </div>

      <PageHead
        title={job.title}
        sub={`${job.company}${job.location ? ` · ${job.location}` : ""}${job.remote ? " · Remote" : ""}${job.employment_type ? ` · ${job.employment_type}` : ""}${job.salary ? ` · ${job.salary}` : ""}`}
        actions={
          <>
            {job.url ? (
              <a href={job.url} target="_blank" rel="noreferrer noopener" className="btn">
                Original vacancy <Icon name="arrow" size={12} />
              </a>
            ) : null}
            <form action={analyseJobAction}>
              <input type="hidden" name="job_id" value={job.id} />
              <SubmitButton pendingLabel="Analysing…" className="btn">Re-analyse</SubmitButton>
            </form>
            <form action={setJobStatusAction}>
              <input type="hidden" name="job_id" value={job.id} />
              <input type="hidden" name="status" value="shortlisted" />
              <SubmitButton className="btn">Shortlist</SubmitButton>
            </form>
            <form action={setJobStatusAction}>
              <input type="hidden" name="job_id" value={job.id} />
              <input type="hidden" name="status" value="rejected" />
              <SubmitButton className="btn btn-danger" confirm="Reject this vacancy? Its records are kept.">Reject</SubmitButton>
            </form>
          </>
        }
      />

      <div className="split">
        <div className="stack">
          <section className="card">
            <div className="card-head">
              <div className="flex items-center gap-3">
                <AgentAvatar agentKey="analysis" status={analysis ? "completed" : "idle"} size={38} />
                <div>
                  <h2>Match analysis</h2>
                  <p className="card-sub">
                    {analysis
                      ? `${flagLabel(analysis.flag)} · scored ${formatDateTime(analysis.generatedAt)} by ${analysis.engine}`
                      : "Not analysed yet. Ali reads the full description against your verified profile."}
                  </p>
                </div>
              </div>
              {analysis ? (
                <div className="flex items-center gap-3">
                  <div className="score-ring num text-[30px]" style={{ color: analysis.score >= 80 ? "var(--accent)" : analysis.score >= 65 ? "var(--info)" : "var(--warn)" }}>
                    {analysis.score}
                    <span className="text-[13px]" style={{ color: "var(--muted)" }}>%</span>
                  </div>
                  <span className={`badge ${flagClass(analysis.flag)}`}>{flagLabel(analysis.flag)}</span>
                </div>
              ) : (
                <form action={analyseJobAction}>
                  <input type="hidden" name="job_id" value={job.id} />
                  <SubmitButton pendingLabel="Analysing…" className="btn btn-primary">Analyse vacancy</SubmitButton>
                </form>
              )}
            </div>
            <div className="card-body">
              {analysis ? (
                <div className="stack" style={{ gap: 16 }}>
                  <div className="grid g2" style={{ gap: 12 }}>
                    {Object.keys(DIMENSION_LABELS).map((key) => {
                      const dimension = key as keyof JobAnalysis["breakdown"];
                      const raw = Math.round(analysis.breakdown[dimension] * 100);
                      return (
                        <div key={key}>
                          <div className="between text-[12px]">
                            <span>{DIMENSION_LABELS[key]}</span>
                            <span className="num" style={{ color: "var(--muted)" }}>{raw}% · weight {analysis.weights[dimension]}%</span>
                          </div>
                          <div className="mt-1.5"><Progress value={raw} /></div>
                        </div>
                      );
                    })}
                  </div>

                  <div>
                    <div className="label">Matching skills ({analysis.matched.length})</div>
                    <div className="row">
                      {analysis.matched.length === 0 ? <span className="text-[12px]" style={{ color: "var(--muted)" }}>None detected.</span> : analysis.matched.map((skill) => <span key={skill} className="chip">{skill}</span>)}
                    </div>
                  </div>

                  <div>
                    <div className="label">Missing or unverified requirements ({analysis.missing.length})</div>
                    <div className="row">
                      {analysis.missing.length === 0 ? <span className="text-[12px]" style={{ color: "var(--muted)" }}>No mandatory stack gaps detected.</span> : analysis.missing.map((skill) => <span key={skill} className="chip chip-exposure">{skill}</span>)}
                    </div>
                  </div>

                  <div>
                    <div className="label">Preferred / optional technologies ({(analysis.preferred ?? []).length})</div>
                    <div className="row">
                      {(analysis.preferred ?? []).length === 0 ? <span className="text-[12px]" style={{ color: "var(--muted)" }}>None stated as optional.</span> : analysis.preferred.map((skill) => <span key={skill} className="chip chip-exposure">{skill}</span>)}
                    </div>
                  </div>

                  <div>
                    <div className="label">Score evidence</div>
                    <div className="stack" style={{ gap: 6 }}>
                      {Object.entries(analysis.evidence ?? {}).map(([dimension, evidence]) => (
                        <div key={dimension} className="card-quiet p-2.5 text-[11.5px] leading-relaxed">
                          <strong>{DIMENSION_LABELS[dimension] ?? dimension}:</strong> {evidence}
                        </div>
                      ))}
                    </div>
                  </div>

                  {job.ai_note ? (
                    <div className="card-quiet p-3">
                      <div className="label" style={{ marginBottom: 3 }}>AI advisory — not used for the score</div>
                      <p className="text-[11.5px] leading-relaxed" style={{ color: "var(--muted)" }}>{job.ai_note}</p>
                    </div>
                  ) : null}

                  <div>
                    <div className="label">Concerns</div>
                    {analysis.concerns.length === 0 ? (
                      <p className="text-[12.5px]" style={{ color: "var(--muted)" }}>No specific concerns recorded.</p>
                    ) : (
                      <ul className="stack text-[12.5px]" style={{ gap: 6, paddingLeft: 16, listStyle: "disc" }}>
                        {analysis.concerns.map((concern) => <li key={concern}>{concern}</li>)}
                      </ul>
                    )}
                  </div>

                  <div className="card-quiet p-3">
                    <div className="label" style={{ marginBottom: 3 }}>Recommended action</div>
                    <p className="text-[12.5px]">{analysis.recommendation}</p>
                  </div>
                  <p className="text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
                    Seniority read as {analysis.seniority}. Language signals: {analysis.languages.join(", ") || "none stated"}.
                    {analysis.yearsRequired ? ` Posting requests ${analysis.yearsRequired} years.` : ""} Scoring is deterministic and never rejects a vacancy solely for a preferred skill.
                  </p>
                </div>
              ) : (
                <Empty title="No analysis stored">Run the analysis to see skill overlap, gaps and language or permit concerns.</Empty>
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h2>Vacancy description</h2>
                <p className="card-sub">Extracted from the {job.source === "arbeitnow" ? "Arbeitnow feed" : "source posting"} · discovered {formatDate(job.discovered_at)}</p>
              </div>
            </div>
            <div className="card-body">
              <div
                className="text-[12.5px] leading-relaxed"
                style={{ whiteSpace: "pre-wrap", maxHeight: 520, overflowY: "auto", color: "var(--ink-soft)" }}
              >
                {job.description || "No description stored."}
              </div>
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="card">
            <div className="card-head">
              <div>
                <h2>Application package</h2>
                <p className="card-sub">Tailored CV, cover letter and separate CV-ATS/document-quality audits for this vacancy.</p>
              </div>
            </div>
            <div className="card-body stack" style={{ gap: 10 }}>
              <form action={generatePackageAction}>
                <input type="hidden" name="job_id" value={job.id} />
                <SubmitButton pendingLabel="Generating documents…" className="btn btn-primary w-full">
                  <Icon name="docs" /> Generate CV & cover letter
                </SubmitButton>
              </form>
              {!application ? (
                <form action={createApplicationForJobAction}>
                  <input type="hidden" name="job_id" value={job.id} />
                  <SubmitButton className="btn w-full">Create application record</SubmitButton>
                </form>
              ) : (
                <div className="card-quiet p-3">
                  <div className="between">
                    <div>
                      <div className="text-[12.5px] font-semibold">Application {statusLabel(application.status)}</div>
                      <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                        {application.submitted_at ? `Submitted ${formatDate(application.submitted_at)}` : application.approved_at ? "Approved, awaiting submission" : "Prepared in approval mode"}
                      </div>
                    </div>
                    <Link href={`/applications/${application.id}`} className="btn btn-sm">Open</Link>
                  </div>
                </div>
              )}
              {documents.length === 0 ? (
                <p className="text-[12px]" style={{ color: "var(--muted)" }}>No documents generated yet.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {documents.map((doc) => (
                    <div key={doc.id} className="between card-quiet px-3 py-2">
                      <div>
                        <div className="text-[12px] font-medium">{doc.kind === "tailored_cv" ? "CV" : "Cover letter"} · v{doc.version} · {doc.mime.includes("pdf") ? "PDF" : "DOCX"}</div>
                        <div className="text-[10.5px]" style={{ color: "var(--muted)" }}>
                          {doc.kind === "tailored_cv" ? `CV ATS compatibility ${doc.ats_score ?? "—"}/100` : `Cover quality ${doc.quality_status ?? "not checked"}${doc.quality_score !== null ? ` (${doc.quality_score}/100)` : ""}`} · {doc.status}
                        </div>
                      </div>
                      <a href={`/api/documents/${doc.id}`} className="btn btn-sm">Download</a>
                    </div>
                  ))}
                </div>
              )}
              <Link href="/documents" className="btn btn-ghost w-full">Manage all documents</Link>
            </div>
          </section>

          <GermanRequirementCard
            status={job.german_requirement}
            evidence={job.language_evidence}
            eligibility={job.eligibility}
          />

          <section className="card">
            <div className="card-head">
              <div>
                <h2>Vacancy record</h2>
              </div>
            </div>
            <div className="card-body stack text-[12.5px]" style={{ gap: 8 }}>
              <div className="between"><span style={{ color: "var(--muted)" }}>Source</span><span>{job.source}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Status</span><span className="badge badge-neutral">{job.status}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Work mode</span><span>{job.remote ? "Remote" : "On-site"}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Employment</span><span>{job.employment_type ?? "Not stated"}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Salary</span><span>{job.salary ?? "Not stated"}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Posted</span><span>{formatDate(job.posted_at)}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Languages</span><span>{job.language_text ?? "Not detected"}</span></div>
              {job.url ? (
                <a href={job.url} target="_blank" rel="noreferrer noopener" className="btn btn-sm mt-1">Open original posting</a>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
