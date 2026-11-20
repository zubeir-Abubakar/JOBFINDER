export const E2E = {
  owner: {
    name: "E2E Owner",
    email: "e2e-owner@example.test",
    password: "E2E-Owner!2026",
  },
  admin: {
    email: "e2e-admin@example.test",
    password: "E2E-Admin!2026",
  },
  setupToken: "e2e-setup-token-2026-owner-safe",
  dataDir: ".e2e-runtime/data",
  ownerState: ".e2e-runtime/auth/owner.json",
  adminState: ".e2e-runtime/auth/admin.json",
  jobControlURL: "http://127.0.0.1:3314/__control",
} as const;

export const AGENT_IDENTITIES = [
  { key: "coordinator", name: "Chief", role: "Orchestrator", title: "Chief Coordinator / Orchestrator" },
  { key: "research", name: "Saffa", role: "Discovery", title: "Job Research Agent / Discovery" },
  { key: "analysis", name: "Ali", role: "Matching", title: "Job Analysis Agent / Matching" },
  { key: "cv", name: "Kora", role: "Documents", title: "CV Optimisation Agent / Documents" },
  { key: "ats", name: "Kali", role: "Assurance", title: "ATS Quality Control Agent" },
  { key: "cover", name: "Amira", role: "Documents", title: "Application Agent / Cover Letter & Documents" },
  { key: "application", name: "Noor", role: "Submission", title: "Application Agent / Submission" },
  { key: "email", name: "Rayna", role: "Tracking", title: "Email & Tracking Agent" },
] as const;
