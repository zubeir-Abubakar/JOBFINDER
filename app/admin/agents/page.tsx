import { requireAdmin } from "@/lib/auth";
import { all } from "@/lib/db";
import { PageHead, Flash } from "@/components/ui";
import { formatDateTime, param, relativeTime } from "@/lib/format";
import { toggleAgentAction, saveAgentConfigAction, setAgentStatusAction } from "@/lib/actions/agents";
import { SubmitButton } from "@/components/SubmitButton";
import { AgentAvatar, AgentStatusBadge } from "@/components/AgentAvatar";
import { agentIdentity } from "@/lib/agent-identity";

export const dynamic = "force-dynamic";

export default async function AdminAgentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const agents = all<{
    key: string;
    name: string;
    role: string;
    description: string;
    enabled: number;
    status: string;
    current_task: string | null;
    last_run_at: string | null;
    run_count: number;
    success_count: number;
    failure_count: number;
    config: string | null;
  }>("SELECT * FROM agents ORDER BY sort");
  const failures = all<{ id: string; agent_key: string; title: string; error: string | null; created_at: string }>(
    "SELECT id, agent_key, title, error, created_at FROM tasks WHERE status = 'failed' ORDER BY created_at DESC LIMIT 10",
  );

  return (
    <>
      <Flash ok={param(sp.ok)} error={param(sp.error)} saved={param(sp.saved)} />
      <PageHead
        title="Agent management"
        sub="Enable agents, pause execution, adjust JSON configuration and inspect failures. Execution stays sequential to fit an 8 GB machine."
      />

      <section className="card mb-4">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Agent</th><th>State</th><th>Runs</th><th>Last run</th><th>Controls</th></tr></thead>
            <tbody>
              {agents.map((agent) => {
                const identity = agentIdentity(agent.key);
                return (
                <tr key={agent.key}>
                  <td style={{ minWidth: 240 }}>
                    <div className="flex items-center gap-2.5">
                      <AgentAvatar agentKey={agent.key} status={agent.status} size={38} />
                      <div>
                        <div className="cell-title">{identity.name}</div>
                        <div className="cell-sub">{identity.title} · {agent.key}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <AgentStatusBadge status={agent.status} enabled={agent.enabled === 1} />
                    {agent.current_task ? <div className="cell-sub">{agent.current_task}</div> : null}
                  </td>
                  <td className="num">{agent.run_count}<div className="cell-sub">{agent.success_count} ok · {agent.failure_count} failed</div></td>
                  <td className="cell-sub">{agent.last_run_at ? relativeTime(agent.last_run_at) : "never"}</td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      <form action={toggleAgentAction}>
                        <input type="hidden" name="key" value={agent.key} />
                        <SubmitButton className="btn btn-sm">{agent.enabled ? "Disable" : "Enable"}</SubmitButton>
                      </form>
                      <form action={setAgentStatusAction}>
                        <input type="hidden" name="key" value={agent.key} />
                        <input type="hidden" name="status" value={agent.status === "paused" ? "idle" : "paused"} />
                        <SubmitButton className="btn btn-sm">{agent.status === "paused" ? "Resume" : "Pause"}</SubmitButton>
                      </form>
                      <details>
                        <summary className="btn btn-sm" style={{ listStyle: "none", cursor: "pointer" }}>Config</summary>
                        <form action={saveAgentConfigAction} className="mt-2 stack" style={{ gap: 6, minWidth: "min(320px, 100%)" }}>
                          <input type="hidden" name="key" value={agent.key} />
                          <textarea name="config" className="textarea" rows={6} defaultValue={agent.config ?? "{}"} spellCheck={false} style={{ fontFamily: "ui-monospace, monospace", fontSize: 11.5 }} />
                          <SubmitButton className="btn btn-sm" pendingLabel="Saving…">Save JSON</SubmitButton>
                        </form>
                      </details>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="split">
        <section className="card">
          <div className="card-head"><div><h2>Recent task failures</h2><p className="card-sub">Inspect the error before retrying the workflow.</p></div></div>
          <div className="table-wrap">
            {failures.length === 0 ? (
              <div className="empty">No failed tasks recorded.</div>
            ) : (
              <table className="data">
                <thead><tr><th>Task</th><th>Agent</th><th>Error</th><th>When</th></tr></thead>
                <tbody>
                  {failures.map((task) => (
                    <tr key={task.id}>
                      <td className="cell-title">{task.title}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          <AgentAvatar agentKey={task.agent_key} status="failed" size={24} />
                          <span className="cell-sub">{agentIdentity(task.agent_key).shortName}</span>
                        </div>
                      </td>
                      <td className="cell-sub">{task.error}</td>
                      <td className="cell-sub">{formatDateTime(task.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-head"><div><h2>Execution policy</h2></div></div>
          <div className="card-body text-[12px] leading-relaxed stack" style={{ gap: 8, color: "var(--muted)" }}>
            <p>One workflow runs at a time. {agentIdentity("coordinator").name} creates a task record per step and refuses to start while all agents are paused.</p>
            <p>Retries: a failed discovery or document task leaves its error on the task record; re-running the workflow retries the step. No silent retry loops.</p>
            <p>Agents share one professional profile and never write to each other&apos;s data. Application duplicates are blocked at the database level.</p>
          </div>
        </section>
      </div>
    </>
  );
}
