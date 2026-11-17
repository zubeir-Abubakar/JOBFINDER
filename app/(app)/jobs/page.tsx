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

      <form method="get" className="card mb-4">
        <div className="card-body grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, paddingTop: 16 }}>
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
          <div className="flex items-end gap-2">
            <button className="btn btn-primary w-full" type="submit">Apply filters</button>
            <Link href="/jobs" className="btn">Reset</Link>
          </div>
        </div>
      </form>

      <section className="card mb-4" id="vacancies">
        <div className="card-head">
          <div>
            <h2>Vacancies <span className="num" style={{ color: "var(--muted)", fontWeight: 500 }}>({jobs.length})</span></h2>
            <p className="card-sub">Scores are internal estimates from the analysis agent, not employer feedback.</p>
          </div>
        </div>
        <div className="table-wrap">
          {jobs.length === 0 ? (
            <Empty title="No vacancies match these filters">
              Run a research pass or add a vacancy manually. The free Arbeitnow feed focuses on ATS-published European and remote roles.
            </Empty>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Location</th>
                  <th>Match</th>
                  <th>Status</th>
                  <th>Source</th>
                  <th>Discovered</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td style={{ minWidth: 220 }}>
                      <Link href={`/jobs/${job.id}`} className="cell-title">{job.title}</Link>
                      <div className="cell-sub">{job.company}{job.salary ? ` · ${job.salary}` : ""}</div>
                    </td>
                    <td>
                      <div>{job.location ?? "—"}</div>
                      <div className="cell-sub">{job.remote ? "Remote" : "On-site"}{job.employment_type ? ` · ${job.employment_type}` : ""}</div>
                    </td>
                    <td>
                      {job.match_score === null ? (
                        <span className="badge badge-neutral">Not analysed</span>
                      ) : (
                        <div className="row" style={{ gap: 6 }}>
                          <span className="num font-semibold">{job.match_score}%</span>
                          <span className={`badge ${flagClass(job.match_flag)}`}>{flagLabel(job.match_flag)}</span>
                        </div>
                      )}
                    </td>
                    <td><span className="badge badge-neutral">{job.status}</span></td>
                    <td className="cell-sub">{job.source === "arbeitnow" ? "Arbeitnow" : job.source}</td>
                    <td className="cell-sub">{formatDate(job.discovered_at)}</td>
                    <td className="text-right">
                      <Link href={`/jobs/${job.id}`} className="btn btn-sm">View</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
