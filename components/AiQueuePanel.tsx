import { aiQueueSnapshot, type AiJobStatus } from "@/lib/ai-queue";
import { relativeTime } from "@/lib/format";

const LABELS: Record<AiJobStatus, string> = {
  queued: "Queued",
  processing: "Processing",
  completed: "Completed",
  rate_limited: "Rate limited",
  failed: "Failed",
};

const TONES: Record<AiJobStatus, string> = {
  queued: "badge-info",
  processing: "badge-warn",
  completed: "badge-good",
  rate_limited: "badge-warn",
  failed: "badge-bad",
};

const KIND_LABELS: Record<string, string> = {
  agent_note: "Agent advisory",
  analysis_note: "Analysis narrative",
  email_classification: "Email classification",
};

function seconds(ms: number): number {
  return Math.max(0, Math.ceil(ms / 1000));
}

export function AiQueuePanel({ embedded = false }: { embedded?: boolean }) {
  const snapshot = aiQueueSnapshot();
  const total = Object.values(snapshot.counts).reduce((sum, count) => sum + count, 0);
  const cooling = snapshot.cooldown.remainingMs > 0;

  return (
    <section className={embedded ? "card system-inner" : "card mb-4"} id="ai-queue">
      <div className="card-head">
        <div>
          <h2>AI request queue</h2>
          <p className="card-sub">
            Optional advisory work waits for the pinned FreeLLMAPI route. Deterministic scoring, statuses and documents never wait here.
          </p>
        </div>
        <span className={`badge ${cooling ? "badge-warn" : "badge-good"}`}>
          {cooling ? `cooling down · ${seconds(snapshot.cooldown.remainingMs)}s` : "accepting work"}
        </span>
      </div>
      <div className="card-body stack" style={{ gap: 10 }}>
        <div className="flex flex-wrap items-center gap-1.5">
          {(Object.keys(LABELS) as AiJobStatus[]).map((status) => (
            <span key={status} className={`badge ${TONES[status]}`} title={`${snapshot.counts[status]} ${LABELS[status].toLowerCase()}`}>
              {LABELS[status]} <span className="num">{snapshot.counts[status]}</span>
            </span>
          ))}
          <span className="badge badge-neutral" title="Shared FreeLLMAPI concurrency">
            max {snapshot.slots.limit} concurrent
          </span>
          <span className="badge badge-neutral" title="Advisory jobs retry with backoff">
            up to {snapshot.maxAttempts} attempts
          </span>
        </div>

        {snapshot.cooldown.reason ? (
          <div className="text-[11.5px] leading-relaxed" style={{ color: "var(--warning, #a16207)" }}>
            {cooling ? `Gateway cooldown active: ${snapshot.cooldown.reason}` : `Last cooldown: ${snapshot.cooldown.reason}`}
          </div>
        ) : null}

        {total === 0 ? (
          <div className="text-[12px]" style={{ color: "var(--muted)" }}>
            No advisory work has needed the queue. Every AI call has fitted inside the shared concurrency limit.
          </div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Job</th>
                <th>Status</th>
                <th>Task</th>
                <th>Attempts</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.jobs.map((job) => (
                <tr key={job.id}>
                  <td>
                    <div className="cell-title">{KIND_LABELS[job.kind] ?? job.kind.replace(/_/g, " ")}</div>
                    <div className="cell-sub">
                      {job.agent_key} · {job.id}
                    </div>
                    {job.last_error ? (
                      <div className="cell-sub" title={job.last_error} style={{ color: "var(--danger)" }}>
                        {job.last_error.slice(0, 120)}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <span className={`badge ${TONES[job.status]}`}>{LABELS[job.status]}</span>
                    {job.status === "rate_limited" ? (
                      <div className="cell-sub">retry {relativeTime(job.available_at)}</div>
                    ) : null}
                  </td>
                  <td className="text-[11px]">
                    {job.task_id ? <span className="num">{job.task_id}</span> : <span style={{ color: "var(--muted)" }}>manual</span>}
                  </td>
                  <td className="num">{job.attempts}</td>
                  <td className="text-[11px]" style={{ color: "var(--muted)" }}>
                    {relativeTime(job.finished_at ?? job.started_at ?? job.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
          No paid provider, alternate model or unapproved route is ever tried. A queued job keeps its task ID for telemetry and is retried after the advertised cooldown.
        </div>
      </div>
    </section>
  );
}
