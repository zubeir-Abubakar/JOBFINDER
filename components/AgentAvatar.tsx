"use client";

import { useState, type ReactNode } from "react";
import { agentIdentity } from "@/lib/agent-identity";
import { normaliseStatus, statusMeta } from "@/lib/agent-status";

/**
 * The single illustrated identity component. Source filenames live in
 * lib/agent-identity.ts so task rows, timelines, dashboard cards and the
 * assistant all resolve the same asset for the same backend agent ID.
 * Animations are CSS-only and driven by the real backend status.
 */

const FALLBACKS: Record<string, ReactNode> = {
  coordinator: (
    <>
      <circle cx="17" cy="16" r="5" />
      <path d="M8 33c0-5 4-8.5 9-8.5s9 3.5 9 8.5" />
      <circle cx="31" cy="19" r="3.4" />
      <path d="M26 32c.6-3.6 3-6 6-6 2.3 0 4.2 1.3 5.2 3.4" />
      <path d="M23 15.5h5" strokeDasharray="1 3" />
    </>
  ),
  research: (
    <>
      <circle cx="16" cy="16" r="5" />
      <path d="M7 33c0-5 4-8.5 9-8.5 2.6 0 5 1 6.6 2.7" />
      <circle cx="32" cy="22" r="6.3" />
      <path d="M36.6 26.6L41 31" />
    </>
  ),
  analysis: (
    <>
      <circle cx="15" cy="15" r="4.6" />
      <path d="M7 33c0-4.7 3.6-8 8-8 2 0 3.8.7 5.1 1.9" />
      <path d="M27 32v-7M33 32v-12M39 32v-5" />
    </>
  ),
  cv: (
    <>
      <circle cx="14" cy="15" r="4.6" />
      <path d="M6 33c0-4.7 3.6-8 8-8 1.8 0 3.5.6 4.8 1.7" />
      <path d="M25 12h13v21H25z" />
      <path d="M28 18h7M28 22h7M28 26h4" />
    </>
  ),
  ats: (
    <>
      <circle cx="14" cy="15" r="4.6" />
      <path d="M6 33c0-4.7 3.6-8 8-8 1.8 0 3.5.6 4.8 1.7" />
      <path d="M27 12h12v21H27z" />
      <path d="M30 18l2 2 4-4M30 26h6" />
    </>
  ),
  cover: (
    <>
      <circle cx="14" cy="15" r="4.6" />
      <path d="M6 33c0-4.7 3.6-8 8-8 1.8 0 3.5.6 4.8 1.7" />
      <path d="M24 14h15v13H24z" />
      <path d="M24 14l7.5 6 7.5-6" />
      <path d="M38 29l3-7 2 2-7 3z" />
    </>
  ),
  application: (
    <>
      <circle cx="14" cy="15" r="4.6" />
      <path d="M6 33c0-4.7 3.6-8 8-8 1.8 0 3.5.6 4.8 1.7" />
      <path d="M25 27l16-8-6 16-3.5-6.5z" />
      <path d="M31.5 28.5L41 19" />
    </>
  ),
  email: (
    <>
      <circle cx="14" cy="15" r="4.6" />
      <path d="M6 33c0-4.7 3.6-8 8-8 1.8 0 3.5.6 4.8 1.7" />
      <path d="M24 17h16v13H24z" />
      <path d="M24 18l8 6 8-6" />
      <path d="M28 32v3h8v-3" />
    </>
  ),
};

export function AgentAvatar({
  agentKey,
  status,
  size = 46,
}: {
  agentKey: string;
  status: string;
  size?: number;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const identity = agentIdentity(agentKey);
  const state = normaliseStatus(status);
  const alt = `${identity.shortName} agent avatar`;

  return (
    <span
      className={`agent-avatar agent-avatar-photo is-${state}`}
      style={{ width: size, height: size }}
    >
      {imageFailed ? (
        <span className="agent-avatar-fallback" role="img" aria-label={alt}>
          <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {FALLBACKS[identity.key] ?? FALLBACKS.coordinator}
          </svg>
        </span>
      ) : (
        <span className="agent-avatar-media">
          <img
            src={identity.image}
            alt={alt}
            width={320}
            height={320}
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setImageFailed(true)}
          />
        </span>
      )}
    </span>
  );
}

export function AgentStatusBadge({ status, enabled = true }: { status: string; enabled?: boolean }) {
  if (!enabled) return <span className="badge badge-neutral">Disabled</span>;
  const meta = statusMeta(status);
  return (
    <span className={`badge ${meta.className}`}>
      <span className={`dot ${meta.active ? "dot-live" : ""}`} /> {meta.label}
    </span>
  );
}

export function AgentAvailabilityBadge({
  state,
  label,
  detail,
}: {
  state: "online" | "offline" | "initialising" | "unavailable" | "degraded";
  label: string;
  detail?: string;
}) {
  const className =
    state === "online"
      ? "badge-good"
      : state === "degraded"
        ? "badge-warn"
        : state === "unavailable"
          ? "badge-bad"
          : state === "initialising"
            ? "badge-info"
            : "badge-neutral";
  return (
    <span className={`badge ${className}`} title={detail}>
      <span className={`dot ${state === "online" || state === "initialising" ? "dot-live" : ""}`} /> {label}
    </span>
  );
}

export function AgentTaskBadge({
  state,
  label,
  detail,
}: {
  state: "idle" | "queued" | "running" | "thinking" | "waiting_tool" | "waiting_intervention" | "completed" | "failed" | "cancelled";
  label: string;
  detail?: string;
}) {
  const className =
    state === "failed"
      ? "badge-bad"
      : state === "completed"
        ? "badge-good"
        : ["running", "thinking", "waiting_tool", "waiting_intervention"].includes(state)
          ? "badge-info"
          : state === "queued"
            ? "badge-warn"
            : "badge-neutral";
  const active = ["running", "thinking", "waiting_tool", "waiting_intervention"].includes(state);
  return (
    <span className={`badge ${className}`} title={detail}>
      <span className={`dot ${active ? "dot-live" : ""}`} /> {label}
    </span>
  );
}
