"use client";

import { useEffect, useState } from "react";

type Summary = {
  state: string;
  label: string;
  detail: string;
  fallbacksLast24h: number;
  lastFallback: { provider: string; model: string; at: string } | null;
};

const TONE: Record<string, string> = {
  primary: "badge-good",
  fallback: "badge-info",
  degraded: "badge-warn",
  unavailable: "badge-bad",
  unconfigured: "badge-neutral",
};

/**
 * Truthful provider state from the server. It never claims a fallback is active
 * unless a fallback call was actually recorded, and a recoverable failure is
 * shown here without interrupting the conversation.
 */
export function ProviderStatusPill({ compact = false }: { compact?: boolean }) {
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/ai/status", { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as Summary;
        if (!cancelled) setSummary(payload);
      } catch {
        // Status is advisory; a network failure leaves the last known value.
      }
    };
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!summary) return null;
  const title = [
    summary.detail,
    summary.lastFallback
      ? `Last recorded fallback: ${summary.lastFallback.provider}/${summary.lastFallback.model} at ${summary.lastFallback.at}.`
      : "No fallback call has been recorded.",
    `${summary.fallbacksLast24h} fallback call(s) recorded in the last 24 hours.`,
  ].join("\n");

  return (
    <span
      className={`badge ${TONE[summary.state] ?? "badge-neutral"} vc-provider`}
      title={title}
      data-testid="provider-status"
      data-provider-state={summary.state}
    >
      {compact ? summary.label.replace(" provider", "") : summary.label}
    </span>
  );
}
