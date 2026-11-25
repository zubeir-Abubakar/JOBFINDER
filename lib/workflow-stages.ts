import { agentIdentity } from "./agent-identity";

/**
 * Presentation order for the workflow chart.
 *
 * This is deliberately separate from the execution runner: the chart shows the
 * required owner-facing order, while dependencies and task state still come
 * from the persisted execution manifest.
 */
export type WorkflowStage = {
  key: string;
  label: string;
  agents: string[];
  hint: string;
  /** The stage that owns the human submission approval gate. */
  approvalGate?: boolean;
};

const coordinator = agentIdentity("coordinator");
const research = agentIdentity("research");
const analysis = agentIdentity("analysis");
const cv = agentIdentity("cv");
const cover = agentIdentity("cover");
const ats = agentIdentity("ats");
const application = agentIdentity("application");
const email = agentIdentity("email");

export function workflowOrderLabel(): string {
  return WORKFLOW_STAGES.flatMap((stage) => stage.agents)
    .map((key) => agentIdentity(key).name)
    .join(" → ");
}

export const WORKFLOW_STAGES: readonly WorkflowStage[] = [
  {
    key: "coordinator",
    label: coordinator.name,
    agents: [coordinator.key],
    hint: `${coordinator.title} — plans and sequences the run`,
  },
  {
    key: "research",
    label: research.name,
    agents: [research.key],
    hint: `${research.title} — finds traceable vacancies`,
  },
  {
    key: "analysis",
    label: analysis.name,
    agents: [analysis.key],
    hint: `${analysis.title} — scores fit against your profile`,
  },
  {
    key: "cv",
    label: cv.name,
    agents: [cv.key],
    hint: `${cv.title} — generates and preserves the tailored CV`,
  },
  {
    key: "cover",
    label: cover.name,
    agents: [cover.key],
    hint: `${cover.title} — writes from the validated CV`,
  },
  {
    key: "quality",
    label: ats.name,
    agents: [ats.key],
    hint: `${ats.title} — independently validates the complete package`,
  },
  {
    key: "submission",
    label: application.name,
    agents: [application.key],
    hint: `${application.title} — submits and records evidence`,
    approvalGate: true,
  },
  {
    key: "tracking",
    label: email.name,
    agents: [email.key],
    hint: `${email.title} — tracks replies and reports`,
  },
];
