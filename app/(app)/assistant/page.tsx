import { requireUser } from "@/lib/auth";
import { PageHead } from "@/components/ui";
import { chatHistory, assistantSuggestions } from "@/lib/chat";
import { sendChatMessageAction, clearChatAction } from "@/lib/actions/chat";
import { formatDateTime } from "@/lib/format";
import { SubmitButton } from "@/components/SubmitButton";
import { AgentAvatar } from "@/components/AgentAvatar";
import { agentIdentity } from "@/lib/agent-identity";

export const dynamic = "force-dynamic";

type MessageMeta = { agentKeys?: string[]; pendingAction?: string | null };

function messageMeta(value: string | null): MessageMeta {
  if (!value) return {};
  try {
    return JSON.parse(value) as MessageMeta;
  } catch {
    return {};
  }
}

export default async function AssistantPage() {
  const user = await requireUser();
  const messages = chatHistory(user.id);

  return (
    <>
      <PageHead
        title="AI assistance"
        sub="Converse with the Chief Coordinator, ask about live workspace state, or run a grounded recruitment action. Nothing is submitted or sent without approval."
        actions={
          <form action={clearChatAction}>
            <SubmitButton className="btn" confirm="Clear the conversation history for this account?">Clear conversation</SubmitButton>
          </form>
        }
      />

      <div className="split">
        <section className="card" style={{ overflow: "hidden" }}>
          <div className="card-head">
            <div className="flex items-center gap-3">
              <AgentAvatar agentKey="coordinator" status="idle" size={42} />
              <div>
                <h2>Chief Coordinator</h2>
                <p className="card-sub">Conversation + deterministic workspace tools · answers grounded in SQLite</p>
              </div>
            </div>
            <span className="badge badge-good"><span className="dot" /> Ready</span>
          </div>
          <div className="chat-scroll">
            {messages.length === 0 ? (
              <div className="mx-auto max-w-md text-center">
                <div className="mx-auto mb-3 flex justify-center">
                  <AgentAvatar agentKey="coordinator" status="idle" size={54} />
                </div>
                <h3 className="text-[15px]">Talk, ask, or direct the workforce</h3>
                <p className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
                  Say hello, ask what is happening, or request vacancies, documents, reports and agent controls. Workspace actions execute against the real
                  database; conversational answers never pretend an action ran.
                </p>
              </div>
            ) : (
              messages.map((message) => {
                const meta = messageMeta(message.meta);
                const agents = message.role === "assistant" ? (meta.agentKeys?.length ? meta.agentKeys : ["coordinator"]) : [];
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
                          {agentIdentity(agents[0] ?? "coordinator").shortName}
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
          <form action={sendChatMessageAction} style={{ borderTop: "1px solid var(--line)", padding: 12 }}>
            <div className="flex items-end gap-2">
              <textarea
                name="message"
                className="textarea"
                rows={2}
                required
                placeholder="Ask what is happening, or request a real action such as “review application packages”"
                style={{ minHeight: 52 }}
              />
              <SubmitButton className="btn btn-primary" pendingLabel="Coordinating…">Send</SubmitButton>
            </div>
            <p className="hint">Discovery runs may take up to a minute. Destructive document cleanup requires a second confirmation.</p>
          </form>
        </section>

        <div className="stack">
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
              <p>Conversational answers use the configured free provider service and the live workspace snapshot. If inference is unavailable, local answers cover greetings and deterministic workspace questions.</p>
              <p>Workspace commands still run through the same deterministic backend tools. The assistant never claims a vacancy, score, message, submission or email exists unless it was read from the database.</p>
              <p>Pausing and preferences are reversible. Expired-document cleanup asks for confirmation. Applications and outgoing email remain approval-gated.</p>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
