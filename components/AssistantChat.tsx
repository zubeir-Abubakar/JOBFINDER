"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AgentAvatar } from "./AgentAvatar";
import { agentIdentity } from "@/lib/agent-identity";
import { formatDateTime } from "@/lib/format";
import { dispatchVisualCommand } from "@/lib/visual-session";
import { visualViewForPath, type VisualCommand } from "@/lib/visual-types";

type ChatMessage = {
  id: number | string;
  role: string;
  content: string;
  created_at: string;
  meta: string | null;
};

type MessageMeta = {
  agentKey?: string;
  agentKeys?: string[];
  handover?: { from?: string; to?: string; status?: string } | null;
};

type StreamEvent =
  | { type: "delta"; delta: string }
  | {
      type: "done";
      reply: string;
      agentKey?: string;
      agentKeys?: string[];
      handover?: MessageMeta["handover"];
      visual?: VisualCommand | null;
    }
  | { type: "error"; error: string };

function parseMeta(value: string | null): MessageMeta {
  if (!value) return {};
  try {
    return JSON.parse(value) as MessageMeta;
  } catch {
    return {};
  }
}

function metaFor(agentKey: string, agentKeys: string[], handover?: MessageMeta["handover"]): string {
  return JSON.stringify({ agentKey, agentKeys, handover: handover ?? null });
}

export function AssistantChat({
  initialMessages,
  activeAgentKey,
  activeName,
  direct,
}: {
  initialMessages: ChatMessage[];
  activeAgentKey: string;
  activeName: string;
  direct: boolean;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState(initialMessages);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [firstTokenMs, setFirstTokenMs] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, pending]);

  async function send(text: string) {
    const content = text.trim();
    if (!content) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const now = new Date().toISOString();
    const userId = `local-user-${Date.now()}`;
    const assistantId = `local-assistant-${Date.now()}`;
    let assistant = "";
    let completed = false;
    let firstToken: number | null = null;
    const startedAt = performance.now();
    setPending(true);
    setError("");
    setFirstTokenMs(null);
    setDraft("");
    setMessages((previous) => [
      ...previous,
      { id: userId, role: "user", content, created_at: now, meta: null },
      { id: assistantId, role: "assistant", content: "", created_at: now, meta: null },
    ]);

    const update = (value: string, meta?: string) => {
      setMessages((previous) =>
        previous.map((message) =>
          message.id === assistantId ? { ...message, content: value, meta: meta ?? message.meta } : message,
        ),
      );
    };

    try {
      const response = await fetch("/api/assistant/message/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: content,
          view: visualViewForPath(window.location.pathname) ?? null,
        }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `The assistant returned HTTP ${response.status}.`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line) continue;
          let event: StreamEvent;
          try {
            event = JSON.parse(line) as StreamEvent;
          } catch {
            continue;
          }
          if (event.type === "delta") {
            if (firstToken === null) {
              firstToken = Math.round(performance.now() - startedAt);
              setFirstTokenMs(firstToken);
            }
            assistant += event.delta;
            update(assistant);
          } else if (event.type === "done") {
            done = true;
            completed = true;
            if (event.visual) dispatchVisualCommand(event.visual);
            const finalText = event.reply || assistant;
            update(finalText, metaFor(event.agentKey ?? activeAgentKey, event.agentKeys ?? [event.agentKey ?? activeAgentKey], event.handover));
            setMessages((previous) =>
              previous.map((message) =>
                message.id === userId
                  ? message
                  : message.id === assistantId
                    ? { ...message, content: finalText }
                    : message,
              ),
            );
          } else if (event.type === "error") {
            throw new Error(event.error);
          }
        }
      }
      if (!completed) {
        if (assistant) update(assistant, metaFor(activeAgentKey, [activeAgentKey]));
        else {
          const reason = "I didn't receive a response. Please retry.";
          setError(reason);
          update(reason, metaFor(activeAgentKey, [activeAgentKey]));
        }
      }
      setPending(false);
      router.refresh();
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      const reason = cause instanceof Error ? cause.message : "The response could not be completed.";
      setError(reason);
      update(assistant || `I couldn't complete that: ${reason}`, metaFor(activeAgentKey, [activeAgentKey]));
      setPending(false);
    }
  }

  function stop() {
    abortRef.current?.abort();
    setPending(false);
  }

  return (
    <>
      <div className="chat-scroll assistant-thread" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="mx-auto max-w-md text-center">
            <div className="mx-auto mb-3 flex justify-center">
              <AgentAvatar agentKey={activeAgentKey} status="idle" size={54} />
            </div>
            <h3 className="text-[15px]">Talk directly to {activeName}</h3>
            <p className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
              {direct
                ? `You are in ${activeName}'s own session. Ask naturally, or say “return to ${agentIdentity("coordinator").name}”.`
                : "Ask naturally about the work, the vacancies, the applications or what you should do next. You do not need a command."}
            </p>
          </div>
        ) : (
          messages.map((message) => {
            const meta = parseMeta(message.meta);
            const agents = message.role === "assistant" ? (meta.agentKeys?.length ? meta.agentKeys : [meta.agentKey ?? "coordinator"]) : [];
            const messageAgent = meta.agentKey ?? agents[0] ?? "coordinator";
            return (
              <div key={message.id} style={{ display: "flex", flexDirection: "column" }}>
                <div className={`msg ${message.role === "user" ? "msg-user" : "msg-bot"}`}>
                  {message.content || <span className="hint">Thinking…</span>}
                </div>
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
        {pending ? (
          <div className="msg-meta" aria-live="polite">
            {firstTokenMs === null ? `${agentIdentity("coordinator").name} is thinking…` : `Replying… first token ${firstTokenMs} ms`}
          </div>
        ) : null}
      </div>
      <form
        className="assistant-composer"
        style={{ borderTop: "1px solid var(--line)", padding: 12 }}
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
      >
        <div className="flex items-end gap-2">
          <textarea
            className="textarea"
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send(draft);
              }
            }}
            placeholder={direct ? `Ask ${activeName} naturally, or say “return to ${agentIdentity("coordinator").name}”` : `Ask ${agentIdentity("coordinator").name} naturally — no command needed`}
            style={{ minHeight: 52 }}
            aria-label="Message the assistant"
          />
          <button type={pending ? "button" : "submit"} className={`btn ${pending ? "" : "btn-primary"}`} onClick={pending ? stop : undefined}>
            {pending ? "Stop" : "Send"}
          </button>
        </div>
        {error ? <p className="hint" style={{ color: "var(--bad)" }}>{error}</p> : null}
        <p className="hint">Answers stream as the model writes them. Discovery runs may take longer; destructive actions still require confirmation.</p>
      </form>
    </>
  );
}
