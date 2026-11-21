"use client";

import { useSyncExternalStore } from "react";
import type { VisualCommand, VisualHighlight } from "./visual-types";

/**
 * Client-side Visual Companion session.
 *
 * The voice WebSocket lives in the shell and must survive route changes, so the
 * visual state is a small external store rather than local component state.
 * Navigation is always an internal path returned by the server registry; an
 * arbitrary or protocol-relative href is rejected here as a second boundary.
 */

export type VisualSessionStatus = "inactive" | "opening" | "ready" | "unavailable";

export type VisualSessionState = {
  active: boolean;
  label: string;
  href: string | null;
  command: VisualCommand | null;
  commandId: number;
  highlight: VisualHighlight | null;
  status: VisualSessionStatus;
  message: string | null;
  sharing: string | null;
};

const INITIAL: VisualSessionState = {
  active: false,
  label: "",
  href: null,
  command: null,
  commandId: 0,
  highlight: null,
  status: "inactive",
  message: null,
  sharing: null,
};

let state: VisualSessionState = INITIAL;
const listeners = new Set<() => void>();

function set(patch: Partial<VisualSessionState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): VisualSessionState {
  return state;
}

function getServerSnapshot(): VisualSessionState {
  return INITIAL;
}

export function useVisualSession(): VisualSessionState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function safeHref(value: string): string | null {
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  return value;
}

/** Apply a command from a voice tool result or the text assistant. */
export function dispatchVisualCommand(command: VisualCommand): void {
  if (command.type === "clear") {
    set({ highlight: null, message: null });
    return;
  }
  if (command.type === "highlight") {
    set({
      active: true,
      highlight: command.highlight,
      status: "ready",
      message: null,
      label: state.label || "Visual walkthrough",
    });
    return;
  }
  const href = safeHref(command.href);
  if (!href) {
    set({ active: true, status: "unavailable", message: "That destination is not an approved application route." });
    return;
  }
  set({
    active: true,
    label: command.label,
    href,
    command,
    commandId: state.commandId + 1,
    highlight: command.highlight ?? null,
    status: "opening",
    message: null,
  });
}

/** The visible page has been reached and the highlight can be resolved. */
export function markVisualReady(): void {
  if (!state.active || state.status !== "opening") return;
  set({ status: "ready" });
}

/** The requested element is genuinely absent from this page. */
export function markVisualUnavailable(message: string): void {
  set({ status: "unavailable", message });
}

/** Enter Visual Companion Mode on the current page without navigating away. */
export function startVisualWalkthrough(label = "Workspace walkthrough"): void {
  set({ active: true, label, status: "ready", message: null, highlight: null });
}

export function clearVisualHighlight(): void {
  set({ highlight: null, message: null });
}

export function setScreenShare(label: string | null): void {
  set({ sharing: label });
}

export function exitVisualMode(): void {
  set({ ...INITIAL, commandId: state.commandId + 1 });
}

/** For diagnostics and tests only: no document content, URLs or credentials. */
export function visualDiagnostic(): Record<string, unknown> {
  return {
    active: state.active,
    label: state.label,
    href: state.href,
    status: state.status,
    highlight: state.highlight?.target ?? null,
    sharing: state.sharing,
  };
}
