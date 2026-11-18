import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { all } from "@/lib/db";
import { listJobs, jobCounts } from "@/lib/jobs";
import { flagClass, flagLabel } from "@/lib/scoring";
import { PageHead, Stat, Empty, Flash } from "@/components/ui";
import { formatDate, param } from "@/lib/format";
import { researchAction, toggleJobSourceAction } from "@/lib/actions/jobs";
import { SubmitButton } from "@/components/SubmitButton";
import { ManualJobForm } from "@/components/ManualJobForm";
import { Icon } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const sp = await searchParams;
  const filters = {
    search: param(sp.q),
    status: param(sp.status) || "all",
    flag: param(sp.flag) || "all",
    minScore: Number(param(sp.min) || 0),
    location: param(sp.location),
    company: param(sp.company),
    remote: param(sp.remote),
    source: param(sp.source) || "all",
    sort: param(sp.sort) || "newest",
    analysed: param(sp.analysed),
    limit: 100,
  };
  const jobs = listJobs(filters);
  const counts = jobCounts();
  const sources = all<{ key: string; name: string; kind: string; enabled: number; last_run_at: string | null; notes: string | null }>(
    "SELECT key, name, kind, enabled, last_run_at, notes FROM job_sources ORDER BY key",
  );
  const activeFilters = [
    filters.search,
    filters.location,
    filters.company,
    filters.status !== "all" ? filters.status : "",
    filters.flag !== "all" ? filters.flag : "",
    filters.minScore ? String(filters.minScore) : "",
    filters.analysed,
    filters.remote,
    filters.sort !== "newest" ? filters.sort : "",
  ].filter(Boolean).length;

  return (
    <>
      <Flash ok={param(sp.ok)} error={param(sp.error)} saved={param(sp.saved)} />
      <PageHead
        title="Job discovery"
        sub="Vacancies found by the research agent or added manually. Duplicate postings are blocked at insert time."
        actions={
          <>
            <form action={researchAction} className="row" style={{ gap: 6 }}>
              <select name="pages" className="select" defaultValue="2" style={{ width: 120 }} aria-label="Pages to search">
                <option value="1">1 page</option>
                <option value="2">2 pages</option>
                <option value="3">3 pages</option>
              </select>
              <SubmitButton pendingLabel="Searching…" className="btn btn-primary">
                <Icon name="jobs" /> Start research
              </SubmitButton>
            </form>
            <Link href="#manual" className="btn"><Icon name="plus" /> Add vacancy</Link>
          </>
        }
      />

      <section className="stats mb-4">
        <Stat label="Discovered" value={counts.total} />
        <Stat label="Analysed" value={counts.analysed} />
        <Stat label="Suitable" value={counts.suitable} tone="good" />
        <Stat label="Strong" value={counts.strong} tone="good" />
        <Stat label="New today" value={counts.newToday} />
      </section>

      <details className="card filter-shell mb-4">
        <summary className="filter-summary">
          <span className="filter-summary-icon"><Icon name="filter" size={15} /></span>
          <span className="filter-summary-copy">
            <span className="filter-summary-title">Refine discovery</span>
            <span className="filter-summary-sub">{activeFilters ? `${activeFilters} active filter${activeFilters === 1 ? "" : "s"}` : "Search, score, location and work mode"}</span>
          </span>
          <span className="filter-pill-row" aria-hidden="true">
            {filters.search ? <span className="filter-pill">{filters.search}</span> : null}
            {filters.location ? <span className="filter-pill">{filters.location}</span> : null}
            {filters.flag !== "all" ? <span className="filter-pill">{flagLabel(filters.flag)}</span> : null}
            {filters.minScore ? <span className="filter-pill">≥ {filters.minScore}%</span> : null}
            {filters.remote ? <span className="filter-pill">{filters.remote === "remote" ? "Remote" : "On-site"}</span> : null}
          </span>
          <span className="filter-chevron" aria-hidden="true"><Icon name="chevron" size={15} /></span>
        </summary>
        <form method="get" className="filter-panel">
          <div className="filter-grid">
            <div>
              <label className="label" htmlFor="q">Search</label>
              <input id="q" name="q" className="input" defaultValue={filters.search} placeholder="Title, company, text" />
            </div>
            <div>
              <label className="label" htmlFor="location">Location</label>
              <input id="location" name="location" className="input" defaultValue={filters.location} placeholder="Geneva" />
            </div>
            <div>
              <label className="label" htmlFor="company">Company</label>
              <input id="company" name="company" className="input" defaultValue={filters.company} />
            </div>
            <div>
              <label className="label" htmlFor="status">Status</label>
              <select id="status" name="status" className="select" defaultValue={filters.status}>
                {["all", "new", "shortlisted", "documents", "applied", "rejected"].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="flag">Match</label>
              <select id="flag" name="flag" className="select" defaultValue={filters.flag}>
                {["all", "strong", "possible", "weak", "not_suitable"].map((s) => (
                  <option key={s} value={s}>{flagLabel(s)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="min">Min score</label>
              <input id="min" name="min" type="number" min={0} max={100} className="input" defaultValue={filters.minScore || ""} />
            </div>
            <div>
              <label className="label" htmlFor="analysed">Analysis</label>
              <select id="analysed" name="analysed" className="select" defaultValue={filters.analysed}>
                <option value="">Any</option>
                <option value="1">Analysed</option>
                <option value="0">Awaiting analysis</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="remote">Work mode</label>
              <select id="remote" name="remote" className="select" defaultValue={filters.remote}>
                <option value="">Any</option>
                <option value="remote">Remote</option>
                <option value="onsite">On-site</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="sort">Sort</label>
              <select id="sort" name="sort" className="select" defaultValue={filters.sort}>
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="score">Match score</option>
                <option value="title">Title</option>
              </select>
            </div>
            <div className="filter-actions">
              <button className="btn btn-primary" type="submit">Apply filters</button>
              <Link href="/jobs" className="btn">Reset</Link>
            </div>
          </div>
        </form>
      </details>

      <section className="card mb-4" id="vacancies">
        <div className="card-head">
          <div>
            <h2>Vacancies <span className="num" style={{ color: "var(--muted)", fontWeight: 500 }}>({jobs.length})</span></h2>
            <p className="card-sub">Scores are internal estimates from the analysis agent, not employer feedback.</p>
          </div>
        </div>
        <div className="card-body job-results">
          {jobs.length === 0 ? (
            <Empty title="No vacancies match these filters">
              Run a research pass or add a vacancy manually. The free Arbeitnow feed focuses on ATS-published European and remote roles.
            </Empty>
          ) : (
            <div className="job-card-list">
              {jobs.map((job) => (
                <article key={job.id} className="job-card">
                  <div className={`job-score ${job.match_score === null ? "is-pending" : job.match_score >= 80 ? "is-strong" : job.match_score >= 65 ? "is-possible" : "is-weak"}`}>
                    {job.match_score === null ? (
                      <><span className="job-score-value">—</span><span className="job-score-label">Awaiting</span></>
                    ) : (
                      <><span className="job-score-value num">{job.match_score}</span><span className="job-score-label">% match</span></>
                    )}
                  </div>
                  <div className="job-card-body">
                    <div className="job-card-top">
                      <div className="job-card-title-wrap">
                        <Link href={`/jobs/${job.id}`} className="job-card-title">{job.title}</Link>
                        <div className="job-card-company">{job.company}{job.salary ? ` · ${job.salary}` : ""}</div>
                      </div>
                      <span className={`badge ${job.status === "shortlisted" ? "badge-good" : job.status === "rejected" ? "badge-bad" : "badge-neutral"}`}>{job.status}</span>
                    </div>
                    <div className="job-meta-row">
                      <span className="job-meta"><Icon name="target" size={12} /> {job.location ?? "Location not stated"}</span>
                      <span className="job-meta">{job.remote ? "Remote" : "On-site"}{job.employment_type ? ` · ${job.employment_type}` : ""}</span>
                      <span className="job-meta">Discovered {formatDate(job.discovered_at)}</span>
                      <span className="job-meta job-source">{job.source === "arbeitnow" ? "Arbeitnow" : job.source}</span>
                    </div>
                  </div>
                  <div className="job-card-side">
                    {job.match_score === null ? (
                      <span className="badge badge-neutral">Not analysed</span>
                    ) : (
                      <span className={`badge ${flagClass(job.match_flag)}`}>{flagLabel(job.match_flag)}</span>
                    )}
                    <Link href={`/jobs/${job.id}`} className="btn btn-sm">View role <Icon name="arrow" size={12} /></Link>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>

      <div className="split">
        <section className="card" id="manual">
          <div className="card-head">
            <div>
              <h2>Add a vacancy manually</h2>
              <p className="card-sub">For postings from jobs.ch, company sites or recruiters that the feed does not cover.</p>
            </div>
          </div>
          <div className="card-body">
            <ManualJobForm />
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h2>Search sources</h2>
              <p className="card-sub">Only enabled sources are queried.</p>
            </div>
          </div>
          <div className="card-body stack" style={{ gap: 10 }}>
            {sources.map((source) => (
              <div key={source.key} className="card-quiet p-3">
                <div className="between">
                  <div>
                    <div className="text-[12.5px] font-semibold">{source.name}</div>
                    <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                      {source.kind === "api" ? "Public API" : "Manual entry"} · last run {source.last_run_at ? formatDate(source.last_run_at) : "never"}
                    </div>
                  </div>
                  {source.kind === "api" ? (
                    <form action={toggleJobSourceAction}>
                      <input type="hidden" name="key" value={source.key} />
                      <SubmitButton className="btn btn-sm">{source.enabled ? "Disable" : "Enable"}</SubmitButton>
                    </form>
                  ) : (
                    <span className="badge badge-good">Always on</span>
                  )}
                </div>
                {source.notes ? <p className="mt-2 text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>{source.notes}</p> : null}
              </div>
            ))}
            <p className="text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
              Job data courtesy of{" "}
              <a href="https://www.arbeitnow.com" target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>Arbeitnow</a>.
              Respect each source&apos;s terms; no scraping of restricted portals is performed.
            </p>
          </div>
        </section>
      </div>
    </>
  );
}
