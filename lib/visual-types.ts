import type { AgentKey } from "./agent-definitions";

/**
 * Shared, serialisable definitions for Visual Companion Mode.
 *
 * Only these destinations and highlight targets can ever be requested. The
 * client resolves highlights against real `data-visual-id` attributes and never
 * fabricates an element when the target is absent.
 */

export type VisualViewKey =
  | "dashboard"
  | "agents"
  | "agent_activity"
  | "jobs"
  | "applications"
  | "documents"
  | "profile"
  | "analytics"
  | "inbox"
  | "assistant"
  | "settings"
  | "providers"
  | "workflow";

export type HighlightTarget =
  | "dashboard-metrics"
  | "recruitment-pipeline"
  | "workflow-timeline"
  | "system-health"
  | "job-results"
  | "application-tracker"
  | "document-library"
  | "document-preview"
  | "agent-roster"
  | "agent-activity"
  | "provider-usage"
  | "approval-queue";

export type VisualHighlight = {
  target: HighlightTarget;
  label: string;
  explanation: string;
};

export type VisualCommand =
  | {
      type: "navigate";
      view: VisualViewKey;
      href: string;
      label: string;
      highlight?: VisualHighlight;
    }
  | { type: "highlight"; highlight: VisualHighlight }
  | { type: "clear" };

export const VISUAL_VIEWS: Record<VisualViewKey, { href: string; label: string; description: string }> = {
  dashboard: {
    href: "/dashboard",
    label: "Application dashboard",
    description: "Four owner metrics and the actionable items that need attention.",
  },
  agents: {
    href: "/agents",
    label: "Agent workspace",
    description: "The live Central Command Hub, with the existing agent list one toggle away.",
  },
  agent_activity: {
    href: "/agents/list#activity",
    label: "Agent activity",
    description: "Recent workflow runs and the recorded status of every agent.",
  },
  jobs: {
    href: "/jobs#vacancies",
    label: "Job discovery",
    description: "Stored vacancies with their real match scores and analysis evidence.",
  },
  applications: {
    href: "/applications#board",
    label: "Application board",
    description: "Every application record in four Kanban columns.",
  },
  documents: {
    href: "/documents#tailored-documents",
    label: "CV and documents",
    description: "The original CV and every tailored CV or cover letter.",
  },
  profile: {
    href: "/profile",
    label: "Professional profile",
    description: "The stored profile facts used to ground every generated document.",
  },
  analytics: {
    href: "/analytics",
    label: "Analytics",
    description: "Recorded recruitment and provider measurements.",
  },
  inbox: {
    href: "/inbox",
    label: "Inbox",
    description: "Recruiter email and notifications stored by the Email agent.",
  },
  assistant: {
    href: "/assistant",
    label: "AI assistant",
    description: "The full text conversation with the active agent.",
  },
  settings: {
    href: "/settings",
    label: "Settings",
    description: "Recruitment policy, retention and notification settings.",
  },
  providers: {
    href: "/admin/ai",
    label: "Provider configuration",
    description: "Administrator-only provider, model and policy view.",
  },
  workflow: {
    href: "/agents/list#activity",
    label: "Recruitment workflow",
    description: "Agent availability and the recorded stages of the latest workflow.",
  },
};

export const HIGHLIGHT_TARGETS: Record<HighlightTarget, { label: string; path: string; description: string }> = {
  "dashboard-metrics": {
    label: "Primary recruitment metrics",
    path: "/dashboard",
    description: "Active opportunities, employer-confirmed submissions, interviews and items needing attention, counted from stored records.",
  },
  "recruitment-pipeline": {
    label: "Applications board",
    path: "/applications",
    description: "Applications grouped into Considering, To be applied, Applied and Needs attention.",
  },
  "workflow-timeline": {
    label: "Agent roster",
    path: "/agents/list",
    description: "Agent availability, current task and the latest recorded workflow history.",
  },
  "system-health": {
    label: "System status",
    path: "/agents/list",
    description: "Actionable agent and workflow status in the owner workspace. Technical diagnostics live in Admin.",
  },
  "job-results": {
    label: "Stored vacancies",
    path: "/jobs",
    description: "Vacancies read from the database with their real match scores and analysis.",
  },
  "application-tracker": {
    label: "Application records",
    path: "/applications",
    description: "Applications grouped into the four owner Kanban columns.",
  },
  "document-library": {
    label: "Document library",
    path: "/documents",
    description: "The original CV and generated tailored documents, private to this account.",
  },
  "document-preview": {
    label: "Document preview",
    path: "/documents/",
    description: "The authenticated in-app preview of the open document.",
  },
  "agent-roster": {
    label: "Agent roster",
    path: "/agents/list",
    description: "The eight agents with availability, responsibility and current task.",
  },
  "agent-activity": {
    label: "Agent activity",
    path: "/agents/list",
    description: "Recent runs and the recorded current task of each agent.",
  },
  "provider-usage": {
    label: "Provider and model configuration",
    path: "/admin/ai",
    description: "Administrator-only view of the configured route, actual model and token usage.",
  },
  "approval-queue": {
    label: "Applications needing your attention",
    path: "/applications",
    description: "Applications blocked for a legitimate human step, such as an unknown essential answer or a security challenge. Eligible applications do not wait for per-application approval.",
  },
};

/** Pure client-safe mapping from a browser path to an approved view. */
export function visualViewForPath(pathname: string): VisualViewKey | undefined {
  const path = (pathname || "").split("?")[0];
  if (path === "/" || path.startsWith("/dashboard")) return "dashboard";
  if (path.startsWith("/analytics")) return "analytics";
  if (path.startsWith("/jobs")) return "jobs";
  if (path.startsWith("/applications")) return "applications";
  if (path.startsWith("/documents")) return "documents";
  if (path.startsWith("/profile")) return "profile";
  if (path.startsWith("/agents")) return "agents";
  if (path.startsWith("/inbox")) return "inbox";
  if (path.startsWith("/settings")) return "settings";
  if (path.startsWith("/recruitment")) return "dashboard";
  return undefined;
}

export function isVisualViewKey(value: unknown): value is VisualViewKey {
  return typeof value === "string" && value in VISUAL_VIEWS;
}

export function isHighlightTarget(value: unknown): value is HighlightTarget {
  return typeof value === "string" && value in HIGHLIGHT_TARGETS;
}

export type VisualToolOutcome = {
  ok: boolean;
  message: string;
  visual?: VisualCommand;
  facts?: Record<string, unknown>;
  agentKeys?: AgentKey[];
};
