import { requireUser } from "@/lib/auth";
import { Flash, PageHead } from "@/components/ui";
import { chatHistory, assistantSuggestions } from "@/lib/chat";
import { sendChatMessageAction, clearChatAction, switchAgentAction } from "@/lib/actions/chat";
import { formatDateTime, param } from "@/lib/format";
import { SubmitButton } from "@/components/SubmitButton";
import { AgentAvatar, AgentStatusBadge } from "@/components/AgentAvatar";
import { agentIdentity } from "@/lib/agent-identity";
import { agentDefinition } from "@/lib/agent-definitions";
import { activeAgentSession } from "@/lib/agent-sessions";
import { voiceProfileForAgent } from "@/lib/agent-voices";
import { getOperationalSnapshot } from "@/lib/operations";

export const dynamic = "force-dynamic";

type MessageMeta = {
  agentKey?: string;
  agentKeys?: string[];
  sessionId?: string | null;
  handover?: { from?: string; to?: string; status?: string; note?: string | null } | null;
  pendingAction?: string | null;
};

function messageMeta(value: string | null): MessageMeta {
  if (!value) return {};
  try {
    return JSON.parse(value) as MessageMeta;
  } catch {
    return {};
  }
}

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
  const activeDefinition = agentDefinition(active.agentKey);
  const snapshot = await getOperationalSnapshot();
  const runtime = snapshot.agents.find((agent) => agent.key === active.agentKey);
  const activeVoice = voiceProfileForAgent(active.agentKey);
  const direct = active.agentKey !== "coordinator";

  return (
    <>
      <Flash ok={param(sp.ok)} error={param(sp.error)} />
      <PageHead
        title="AI assistance"
        sub="Converse with the Chief Coordinator or a specialist, inspect live operational state, or run a grounded recruitment action. Nothing is submitted or sent without approval."
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
                  {activeDefinition?.role ?? "Specialist"} · {direct ? "direct specialist conversation" : "orchestrator"} · answers grounded in live operational data
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
                  {["coordinator", "research", "analysis", "cv", "ats", "cover", "application", "email"].map((key) => (
                    <option key={key} value={key}>{agentIdentity(key).shortName}</option>
                  ))}
                </select>
                <SubmitButton className="btn btn-sm" pendingLabel="Switching…">Switch</SubmitButton>
              </form>
            </div>
          </div>
          <div className="chat-scroll assistant-thread">
            {messages.length === 0 ? (
              <div className="mx-auto max-w-md text-center">
                <div className="mx-auto mb-3 flex justify-center">
                  <AgentAvatar agentKey={active.agentKey} status="idle" size={54} />
                </div>
                <h3 className="text-[15px]">Talk directly to {activeIdentity.shortName}</h3>
                <p className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
                  {direct
                    ? `You are in ${activeIdentity.name}'s own session. Ask about its work, or say “return to the coordinator”.`
                    : "Ask about agents, providers, models, tokens, health, permissions or recruitment. Transfer requests switch the active session immediately, without waiting for the model to decide."}
                </p>
              </div>
            ) : (
              messages.map((message) => {
                const meta = messageMeta(message.meta);
                const agents = message.role === "assistant" ? (meta.agentKeys?.length ? meta.agentKeys : [meta.agentKey ?? "coordinator"]) : [];
                const messageAgent = meta.agentKey ?? agents[0] ?? "coordinator";
                return (
                  <div key={message.id} style={{ display: "flex", flexDirection: "column" }}>
                    <div className={`msg ${message.role === "user" ? "msg-user" : "msg-bot"}`}>{message.content}</div>
                    <div className={`msg-meta ${message.role === "user" ? "self-end" : "self-start"}`}>
                      {message.role === "user" ? (
                        "You"
                      ) : (
                        <span className="inline-flex items-center gap-1.5">
                          {[...new Set(agents)].map((key) => (
                            <AgentAvatar key={key} agentKey={key} status="idle" size={18} />
                          ))}
                          {agentIdentity(messageAgent).shortName}
                          {agents.length > 1 ? ` +${agents.length - 1}` : ""}
                        </span>
                      )}{" "}
                      · {formatDateTime(message.created_at)}
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <form action={sendChatMessageAction} className="assistant-composer" style={{ borderTop: "1px solid var(--line)", padding: 12 }}>
            <div className="flex items-end gap-2">
              <textarea
                name="message"
                className="textarea"
                rows={2}
                required
                placeholder={direct ? `Ask ${activeIdentity.shortName} about its work, or say “return to the coordinator”` : "Ask about agents, providers, tokens, health, permissions or recruitment"}
                style={{ minHeight: 52 }}
              />
              <SubmitButton className="btn btn-primary" pendingLabel="Coordinating…">Send</SubmitButton>
            </div>
            <p className="hint">Discovery runs may take up to a minute. Destructive document cleanup requires a second confirmation.</p>
          </form>
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
