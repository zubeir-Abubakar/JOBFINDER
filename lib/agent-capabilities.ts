import { agentDefinition, type AgentKey } from "./agent-definitions";

/**
 * Read-only permission inspection.
 *
 * `available` means the capability exists in this deployment.
 * `granted` means this agent is actually allowed to use it.
 * `usedInLastTask` is derived separately from the latest task record.
 *
 * No capability here can grant a new permission. Shell access, arbitrary SQL,
 * credential export and unapproved sending are permanently prohibited.
 */
export type CapabilityId =
  | "read_operational_data"
  | "read_job_sources"
  | "research_external"
  | "read_profile"
  | "read_documents"
  | "create_documents"
  | "prepare_application"
  | "submit_application"
  | "read_gmail"
  | "draft_gmail"
  | "send_approved_gmail"
  | "control_workflow"
  | "modify_profile"
  | "modify_policy"
  | "execute_shell"
  | "modify_database"
  | "export_credentials"
  | "message_other_agents";

export type AgentCapability = {
  id: CapabilityId;
  label: string;
  available: boolean;
  granted: boolean;
  /** Why it is restricted, or the policy gate that applies. */
  restriction: string | null;
  /** Permanently forbidden rather than merely ungranted. */
  prohibited: boolean;
  /** Current task rows do not instrument individual capability calls. */
  usedInLastTask?: boolean | null;
};

const READ_OPS: AgentCapability = {
  id: "read_operational_data",
  label: "Read live operational status and provider metadata",
  available: true,
  granted: true,
  restriction: "Read-only. Credentials are never returned.",
  prohibited: false,
};

const READ_PROFILE: AgentCapability = {
  id: "read_profile",
  label: "Read the verified professional profile",
  available: true,
  granted: true,
  restriction: "Read-only. No agent can change verified facts from a conversation.",
  prohibited: false,
};

/**
 * Shared read-only Agent Reach research. The exact channel set is enforced in
 * `lib/agent-reach.ts`; this record only states the grant and its limit.
 */
function researchCapability(restriction: string): AgentCapability {
  return {
    id: "research_external",
    label: "Read approved public sources through the shared research service",
    available: true,
    granted: true,
    restriction,
    prohibited: false,
  };
}

const COORDINATOR_RESEARCH = researchCapability(
  "Read-only. May delegate a research request to any specialist; may not use a login-walled, paid or write channel.",
);
const RESEARCH_AGENT = researchCapability(
  "Read-only: public web search/read, public GitHub, public YouTube metadata and public V2EX. No login, cookie import or write action.",
);
const TECHNICAL_RESEARCH = researchCapability(
  "Read-only: public web pages and public GitHub. No login or write action.",
);
const PAGE_RESEARCH = researchCapability(
  "Read-only public page reading only. No login, cookie import or employer contact.",
);

const READ_DOCS: AgentCapability = {
  id: "read_documents",
  label: "Read generated documents and quality reports",
  available: true,
  granted: true,
  restriction: "Read-only.",
  prohibited: false,
};

function prohibited(id: CapabilityId, label: string, restriction: string): AgentCapability {
  return { id, label, available: false, granted: false, restriction, prohibited: true };
}

const NEVER_SHELL = prohibited("execute_shell", "Execute shell commands", "No agent has shell access.");
const NEVER_DB = prohibited("modify_database", "Modify the database directly", "No agent has arbitrary SQL access.");
const NEVER_SECRETS = prohibited("export_credentials", "Read API keys, OAuth tokens or passwords", "Credential values are never exposed.");

export const AGENT_CAPABILITIES: Record<AgentKey, AgentCapability[]> = {
  coordinator: [
    READ_OPS,
    READ_PROFILE,
    COORDINATOR_RESEARCH,
    READ_DOCS,
    {
      id: "control_workflow",
      label: "Pause, stop or resume the existing recruitment workflow",
      available: true,
      granted: true,
      restriction: "Only after an explicit owner instruction; history is preserved.",
      prohibited: false,
    },
    {
      id: "message_other_agents",
      label: "Assign work to specialist agents",
      available: true,
      granted: true,
      restriction: "Through the existing sequential task runner, not free-form agent chat.",
      prohibited: false,
    },
    {
      id: "submit_application",
      label: "Submit an application",
      available: true,
      granted: false,
      restriction: "Only the recruitment policy and submission pipeline can submit, and only with standing authorisation or approval.",
      prohibited: false,
    },
    NEVER_SHELL,
    NEVER_DB,
    NEVER_SECRETS,
  ],
  research: [
    READ_OPS,
    RESEARCH_AGENT,
    {
      id: "read_job_sources",
      label: "Read configured public job sources",
      available: true,
      granted: true,
      restriction: "Only configured feeds and career pages; no arbitrary browsing.",
      prohibited: false,
    },
    NEVER_SHELL,
    NEVER_DB,
    NEVER_SECRETS,
  ],
  analysis: [READ_OPS, READ_PROFILE, TECHNICAL_RESEARCH, NEVER_SHELL, NEVER_DB, NEVER_SECRETS],
  cv: [
    READ_OPS,
    READ_PROFILE,
    READ_DOCS,
    PAGE_RESEARCH,
    {
      id: "create_documents",
      label: "Create tailored CV files",
      available: true,
      granted: true,
      restriction: "Only from verified profile facts and after the quality gate.",
      prohibited: false,
    },
    NEVER_SHELL,
    NEVER_DB,
    NEVER_SECRETS,
  ],
  ats: [
    READ_OPS,
    READ_PROFILE,
    READ_DOCS,
    PAGE_RESEARCH,
    {
      id: "create_documents",
      label: "Audit generated documents",
      available: true,
      granted: false,
      restriction: "The ATS agent reviews and blocks; it does not rewrite source facts.",
      prohibited: false,
    },
    NEVER_SHELL,
    NEVER_DB,
    NEVER_SECRETS,
  ],
  cover: [
    READ_OPS,
    READ_PROFILE,
    READ_DOCS,
    PAGE_RESEARCH,
    {
      id: "create_documents",
      label: "Create cover-letter files",
      available: true,
      granted: true,
      restriction: "Only from verified experience and after evidence checks.",
      prohibited: false,
    },
    NEVER_SHELL,
    NEVER_DB,
    NEVER_SECRETS,
  ],
  application: [
    READ_OPS,
    READ_DOCS,
    READ_PROFILE,
    PAGE_RESEARCH,
    {
      id: "prepare_application",
      label: "Prepare an application package",
      available: true,
      granted: true,
      restriction: "Preparation only; it cannot by itself mark a submission verified.",
      prohibited: false,
    },
    {
      id: "submit_application",
      label: "Submit through the configured application channel",
      available: true,
      granted: false,
      restriction: "Blocked unless standing authorisation/approval and the existing evidence checks pass. CAPTCHA, MFA, logins and payments always queue for the owner.",
      prohibited: false,
    },
    NEVER_SHELL,
    NEVER_DB,
    NEVER_SECRETS,
  ],
  email: [
    READ_OPS,
    READ_PROFILE,
    PAGE_RESEARCH,
    {
      id: "read_gmail",
      label: "Read the connected Gmail mailbox",
      available: true,
      granted: true,
      restriction: "Only the connected mailbox; no credential values are returned.",
      prohibited: false,
    },
    {
      id: "draft_gmail",
      label: "Create a Gmail draft",
      available: true,
      granted: true,
      restriction: "Draft only. Sending requires explicit owner approval.",
      prohibited: false,
    },
    {
      id: "send_approved_gmail",
      label: "Send an approved Gmail draft",
      available: true,
      granted: false,
      restriction: "Requires the existing explicit Approve & send action.",
      prohibited: false,
    },
    NEVER_SHELL,
    NEVER_DB,
    NEVER_SECRETS,
  ],
};

export function capabilitiesForAgent(agentKey: string): AgentCapability[] {
  return AGENT_CAPABILITIES[agentKey as AgentKey] ?? AGENT_CAPABILITIES.coordinator;
}

export function capabilityLabel(id: CapabilityId): string {
  for (const capabilities of Object.values(AGENT_CAPABILITIES)) {
    const found = capabilities.find((capability) => capability.id === id);
    if (found) return found.label;
  }
  return id;
}

/** A concise, secret-free summary suitable for the coordinator's prompt. */
export function permissionBrief(): string {
  const lines = Object.entries(AGENT_CAPABILITIES).map(([key, capabilities]) => {
    const definition = agentDefinition(key);
    const available = capabilities.filter((capability) => capability.available).map((capability) => capability.label);
    const granted = capabilities.filter((capability) => capability.granted).map((capability) => capability.label);
    const blocked = capabilities.filter((capability) => !capability.granted && !capability.prohibited).map((capability) => capability.label);
    const prohibitedLabels = capabilities.filter((capability) => capability.prohibited).map((capability) => capability.label);
    return `${definition?.name ?? key}: available ${available.join("; ") || "none"}. Granted ${granted.join("; ") || "none"}. Used in last task: not recorded per capability (task execution provenance is recorded separately). Policy-gated ${blocked.join("; ") || "none"}. Prohibited ${prohibitedLabels.join("; ") || "none"}.`;
  });
  return [
    "Permission states are kept distinct: available, granted, used, and blocked/prohibited. No agent can grant itself a capability.",
    ...lines,
  ].join("\n");
}
