/** Central agent-ID to illustration mapping. Every UI surface uses this module. */
export type AgentIdentity = {
  key: string;
  name: string;
  shortName: string;
  image: string;
};

export const AGENT_IDENTITIES: Record<string, AgentIdentity> = {
  coordinator: {
    key: "coordinator",
    name: "Chief Coordinator",
    shortName: "Coordinator",
    image: "/assets/agents/coordinator.png",
  },
  research: {
    key: "research",
    name: "Job Research Agent",
    shortName: "Job Research",
    image: "/assets/agents/research.png",
  },
  analysis: {
    key: "analysis",
    name: "Job Analysis Agent",
    shortName: "Job Analysis",
    image: "/assets/agents/analysis.png",
  },
  cv: {
    key: "cv",
    name: "CV Optimisation Agent",
    shortName: "CV Optimisation",
    image: "/assets/agents/cv-specialist.png",
  },
  ats: {
    key: "ats",
    name: "ATS Quality Control Agent",
    shortName: "ATS Quality Control",
    image: "/assets/agents/ats-inspector.png",
  },
  cover: {
    key: "cover",
    name: "Cover Letter Agent",
    shortName: "Cover Letter",
    image: "/assets/agents/cover-letter.png",
  },
  application: {
    key: "application",
    name: "Application Agent",
    shortName: "Application",
    image: "/assets/agents/application.png",
  },
  email: {
    key: "email",
    name: "Email & Tracking Agent",
    shortName: "Email & Tracking",
    image: "/assets/agents/email-tracker.png",
  },
};

export function agentIdentity(key: string): AgentIdentity {
  return AGENT_IDENTITIES[key] ?? AGENT_IDENTITIES.coordinator;
}
