"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { moveApplicationCardAction } from "@/lib/actions/applications";
import type { BoardColumnKey } from "@/lib/application-board";

export type BoardCardView = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  status: string;
  statusLabel: string;
  statusTone: string;
  matchScore: number | null;
  lastUpdateLabel: string;
  verifiedSubmission: boolean;
};

export type BoardColumnView = {
  key: BoardColumnKey;
  label: string;
  hint: string;
  count: number;
  cards: BoardCardView[];
};

type MoveMessage = { tone: "ok" | "error"; text: string };

/**
 * Drag and drop is only a pointer for the authoritative server rule. The same
 * action is also exposed as a visible "Move" control for keyboard, touch and
 * screen-reader users, so there is no second, weaker status pathway.
 */
export function ApplicationBoard({ columns }: { columns: BoardColumnView[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [message, setMessage] = useState<MoveMessage | null>(null);
  const [dragOver, setDragOver] = useState<BoardColumnKey | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const busy = useRef(false);

  const move = (id: string, column: BoardColumnKey) => {
    if (busy.current) return;
    busy.current = true;
    setPendingId(id);
    setMessage(null);
    moveApplicationCardAction({ id, column })
      .then((result) => {
        setMessage({ tone: result.ok ? "ok" : "error", text: result.message });
        if (result.ok) startTransition(() => router.refresh());
      })
      .catch(() => {
        setMessage({
          tone: "error",
          text: "The move could not be completed. Nothing was changed; reload the board and try again.",
        });
      })
      .finally(() => {
        busy.current = false;
        setPendingId(null);
      });
  };

  return (
    <>
      {message ? (
        <p
          role="status"
          aria-live="polite"
          className={`kanban-notice ${message.tone === "error" ? "kanban-notice-error" : "kanban-notice-ok"}`}
        >
          {message.text}
        </p>
      ) : null}

      <section className="kanban" id="board" data-visual-id="recruitment-pipeline" aria-label="Application board">
        {columns.map((column) => {
          const droppable = column.key !== "needs_attention";
          return (
            <section
              key={column.key}
              className={`kanban-col ${dragOver === column.key ? "is-drop-target" : ""}`}
              data-column={column.key}
              data-visual-id={column.key === "needs_attention" ? "approval-queue" : undefined}
              aria-label={`${column.label}, ${column.count} applications`}
              onDragOver={
                droppable
                  ? (event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setDragOver(column.key);
                    }
                  : undefined
              }
              onDragLeave={() => setDragOver((current) => (current === column.key ? null : current))}
              onDrop={
                droppable
                  ? (event) => {
                      event.preventDefault();
                      setDragOver(null);
                      const id = event.dataTransfer.getData("text/plain");
                      if (id) move(id, column.key);
                    }
                  : undefined
              }
            >
              <div className="kanban-col-head">
                <h2>{column.label}</h2>
                <span className="num" style={{ color: "var(--muted)" }}>{column.count}</span>
              </div>
              <p className="hint">{column.hint}</p>
              {column.cards.length === 0 ? (
                <p className="hint" style={{ padding: "8px 2px" }}>No applications here.</p>
              ) : (
                column.cards.map((card) => (
                  <article
                    key={card.id}
                    className={`kanban-card ${draggingId === card.id ? "is-dragging" : ""}`}
                    draggable={pendingId !== card.id}
                    data-card-id={card.id}
                    data-status={card.status}
                    onDragStart={(event) => {
                      event.dataTransfer.setData("text/plain", card.id);
                      event.dataTransfer.effectAllowed = "move";
                      setDraggingId(card.id);
                    }}
                    onDragEnd={() => setDraggingId(null)}
                  >
                    <div className="between">
                      <span className={`badge ${card.statusTone}`}>{card.statusLabel}</span>
                      <span className="num text-[11px]" title="Candidate-to-job suitability">{card.matchScore ?? "—"}%</span>
                    </div>
                    <Link href={`/applications/${card.id}`} className="kanban-title">{card.title}</Link>
                    <div className="kanban-sub">{card.company}{card.location ? ` · ${card.location}` : ""}</div>
                    <div className="between kanban-meta">
                      <span>{card.lastUpdateLabel}</span>
                      <Link href={`/applications/${card.id}`} className="table-link">Open →</Link>
                    </div>
                    {pendingId === card.id ? (
                      <p className="kanban-move-pending" role="status">Applying the server check…</p>
                    ) : (
                      <details className="kanban-move">
                        <summary className="kanban-move-summary">Move</summary>
                        <div className="kanban-move-panel">
                          {columns
                            .filter((target) => target.key !== column.key)
                            .map((target) => (
                              <button
                                key={target.key}
                                type="button"
                                className="btn btn-sm kanban-move-btn"
                                onClick={() => move(card.id, target.key)}
                                disabled={pendingId !== null}
                              >
                                Move to {target.label}
                                {target.key === "applied" && !card.verifiedSubmission ? (
                                  <span className="kanban-move-note">needs confirmed submission</span>
                                ) : null}
                              </button>
                            ))}
                        </div>
                      </details>
                    )}
                  </article>
                ))
              )}
              {column.count > column.cards.length ? (
                <Link href={`/applications?column=${column.key}#board`} className="btn btn-sm w-full">
                  View all {column.count}
                </Link>
              ) : null}
            </section>
          );
        })}
      </section>
    </>
  );
}
