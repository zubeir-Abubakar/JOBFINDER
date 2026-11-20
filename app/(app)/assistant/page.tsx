import { requireUser } from "@/lib/auth";
import { Flash, PageHead } from "@/components/ui";
import { chatHistory, assistantSuggestions } from "@/lib/chat";
import { sendChatMessageAction, clearChatAction, switchAgentAction } from "@/lib/actions/chat";
import { param } from "@/lib/format";
import { SubmitButton } from "@/components/SubmitButton";
import { AssistantChat } from "@/components/AssistantChat";
import { AgentAvatar, AgentStatusBadge } from "@/components/AgentAvatar";
import { AGENT_IDENTITY_KEYS, agentIdentity } from "@/lib/agent-identity";
import { activeAgentSession } from "@/lib/agent-sessions";
import { voiceProfileForAgent } from "@/lib/agent-voices";
import { getOperationalSnapshot } from "@/lib/operations";

export const dynamic = "force-dynamic";

export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const messages = chatHistory(user.id);
  const active = activeAgentSession(user.id);
  const activeIdentity = agentIdentity(active.agentKey);
  const snapshot = await getOperationalSnapshot();
  const runtime = snapshot.agents.find((agent) => agent.key === active.agentKey);
  const activeVoice = voiceProfileForAgent(active.agentKey);
  const direct = active.agentKey !== "coordinator";

  return (
    <>
      <Flash ok={param(sp.ok)} error={param(sp.error)} />
      <PageHead
        title="AI assistance"
        sub={`Converse with ${agentIdentity("coordinator").name} or a named specialist, inspect live operational state, or run a grounded recruitment action. Nothing is submitted or sent without approval.`}
        actions={
          <form action={clearChatAction}>
            <SubmitButton className="btn" confirm="Clear the conversation history for this account?">Clear conversation</SubmitButton>
          </form>
        }
      />

      <div className="split assistant-layout">
        <section className="card assistant-chat-card" style={{ overflow: "hidden" }}>
          <div className="card-head">
            <div className="flex items-center gap-3">
              <AgentAvatar agentKey={active.agentKey} status={runtime?.status ?? "idle"} size={42} />
              <div>
                <h2>{activeIdentity.name}</h2>
                <p className="card-sub">
                  {activeIdentity.title} · {direct ? "direct specialist conversation" : "orchestrator"} · answers grounded in live operational data
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <AgentStatusBadge status={runtime?.status ?? "idle"} enabled={runtime?.enabled ?? true} />
              <span className={`badge ${direct ? "badge-info" : "badge-good"}`}>{direct ? "Direct" : "Coordinator"}</span>
            </div>
          </div>
          <div className="card-body" style={{ borderBottom: "1px solid var(--line)", paddingTop: 10, paddingBottom: 10 }}>
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px]" style={{ color: "var(--muted)" }}>
              <span>
                Provider <strong style={{ color: "var(--ink)" }}>{runtime?.provider ?? "not used yet"}</strong>
                {runtime?.model ? <> · Model <strong style={{ color: "var(--ink)" }}>{runtime.model}</strong></> : null}
                {" "}· Provider status <strong style={{ color: "var(--ink)" }}>{runtime?.providerStatus ?? "unchecked"}</strong>
                {" "}· Voice <strong style={{ color: "var(--ink)" }}>{activeVoice.voiceName}</strong>
              </span>
              <form action={switchAgentAction} className="flex items-center gap-2">
                <label htmlFor="agent-switch" className="sr-only">Switch direct agent</label>
                <select id="agent-switch" name="agent" className="select" defaultValue={active.agentKey} style={{ width: "auto", minWidth: 150 }}>
                  {AGENT_IDENTITY_KEYS.map((key) => (
                    <option key={key} value={key}>{agentIdentity(key).shortName}</option>
                  ))}
                </select>
                <SubmitButton className="btn btn-sm" pendingLabel="Switching…">Switch</SubmitButton>
              </form>
            </div>
          </div>
          <AssistantChat
            initialMessages={messages.map((message) => ({
              id: message.id,
              role: message.role,
              content: message.content,
              created_at: message.created_at,
              meta: message.meta,
            }))}
            activeAgentKey={active.agentKey}
            activeName={activeIdentity.shortName}
            direct={direct}
          />
        </section>

        <div className="stack assistant-side">
          <section className="card">
            <div className="card-head">
              <div>
                <h2>Try a message</h2>
                <p className="card-sub">Conversation is free-form; actions are explicitly grounded.</p>
              </div>
            </div>
            <div className="card-body stack" style={{ gap: 6 }}>
              {assistantSuggestions().map((suggestion) => (
                <form key={suggestion} action={sendChatMessageAction}>
                  <input type="hidden" name="message" value={suggestion} />
                  <SubmitButton className="btn w-full justify-start text-left" pendingLabel="Coordinating…">
                    {suggestion}
                  </SubmitButton>
                </form>
              ))}
            </div>
          </section>
          <section className="card">
            <div className="card-head"><div><h2>How it works</h2></div></div>
            <div className="card-body text-[12px] leading-relaxed stack" style={{ gap: 8, color: "var(--muted)" }}>
              <p>Conversational answers use the configured provider service and the same live operational snapshot as the agent dashboard. If inference is unavailable, deterministic answers still cover agents, providers, tokens, health, permissions and recruitment state.</p>
              <p>Transfer requests resolve against the registered agent IDs and names before any model call. A direct specialist session uses that agent&apos;s own instructions and provider attribution; it is not routed through the Coordinator&apos;s LLM.</p>
              <p>Inspection is read-only. Pausing, preferences and cleanup remain reversible and explicit. Applications and outgoing email remain approval-gated; credentials are never exposed.</p>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
