/**
 * Destination-aware ATS capability registry.
 *
 * A platform is not certified because a URL matches or a page opens. Each row
 * states which execution path exists, what has actually been proven, and the
 * blocker that prevents a real submission. Real platforms remain uncertified
 * until their own workflow has produced employer evidence.
 */

export type AtsPlatform =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "workday"
  | "smartrecruiters"
  | "umantis"
  | "direct_employer"
  | "unknown";

export type AtsExecutionRoute = "employer_api" | "browser_form" | "http_form" | "human_handoff";
export type AtsCertification = "uncertified" | "synthetic_fixture_only" | "human_only";

export type AtsCapability = {
  platform: AtsPlatform;
  name: string;
  route: AtsExecutionRoute;
  certification: AtsCertification;
  publicAccess: boolean;
  javascriptRendering: boolean;
  formInspection: "supported" | "partial" | "unsupported" | "unknown";
  fieldMapping: "supported" | "partial" | "unsupported" | "unknown";
  conditionalFields: boolean;
  languageLocationSelection: boolean;
  documentUpload: boolean;
  clientValidation: boolean;
  serverValidation: boolean;
  referenceExtraction: boolean;
  confirmationVerification: boolean;
  duplicatePrevention: boolean;
  authentication: string;
  securityControls: string;
  evidence: string;
  limitation: string;
};

const BASE = {
  publicAccess: true,
  javascriptRendering: true,
  conditionalFields: false,
  languageLocationSelection: true,
  documentUpload: true,
  clientValidation: true,
  serverValidation: true,
  referenceExtraction: true,
  confirmationVerification: true,
  duplicatePrevention: true,
} satisfies Omit<
  AtsCapability,
  | "platform"
  | "name"
  | "route"
  | "certification"
  | "formInspection"
  | "fieldMapping"
  | "authentication"
  | "securityControls"
  | "evidence"
  | "limitation"
>;

export const ATS_CAPABILITIES: Record<Exclude<AtsPlatform, "unknown">, AtsCapability> = {
  greenhouse: {
    ...BASE,
    platform: "greenhouse",
    name: "Greenhouse",
    route: "employer_api",
    certification: "uncertified",
    formInspection: "partial",
    fieldMapping: "partial",
    authentication: "Employer-issued Job Board API key for write access; the public form is browser-only.",
    securityControls: "Public hosted form; no captcha bypass attempted.",
    evidence: "Existing adapter reads the employer's public question schema and only sends when a board write credential is configured.",
    limitation: "A candidate cannot self-issue the employer's write credential, so no live certification is possible in this phase.",
  },
  lever: {
    ...BASE,
    platform: "lever",
    name: "Lever",
    route: "employer_api",
    certification: "uncertified",
    formInspection: "partial",
    fieldMapping: "partial",
    authentication: "Employer-issued postings API key; the public form is browser-only.",
    securityControls: "Public hosted form; no captcha bypass attempted.",
    evidence: "Existing adapter targets Lever's documented posting endpoint and requires an employer key.",
    limitation: "A candidate cannot self-issue the employer's Lever key, so no live certification is possible in this phase.",
  },
  ashby: {
    ...BASE,
    platform: "ashby",
    name: "Ashby",
    route: "employer_api",
    certification: "uncertified",
    formInspection: "partial",
    fieldMapping: "partial",
    authentication: "Employer-issued key with candidatesWrite plus the employer form definition.",
    securityControls: "Public hosted form; no captcha bypass attempted.",
    evidence: "Existing adapter accepts only the published standard answers and refuses unsupported required questions.",
    limitation: "The required write credential and form definition are employer-owned; not certified.",
  },
  workday: {
    ...BASE,
    platform: "workday",
    name: "Workday",
    route: "human_handoff",
    certification: "uncertified",
    formInspection: "unknown",
    fieldMapping: "unknown",
    authentication: "Employer Workday account and multi-step session.",
    securityControls: "Login, MFA and bot controls are common and are never bypassed.",
    evidence: "Public destination detection and stored 429/challenge evidence only.",
    limitation: "No authenticated Workday workflow has been executed or certified.",
  },
  smartrecruiters: {
    ...BASE,
    platform: "smartrecruiters",
    name: "SmartRecruiters",
    route: "browser_form",
    certification: "uncertified",
    formInspection: "partial",
    fieldMapping: "partial",
    authentication: "Some employers require an account or present a security challenge.",
    securityControls: "Security challenge observed in the live queue; never bypassed.",
    evidence: "Public form and challenge were observed read-only; no submission was made.",
    limitation: "Employer-specific challenge handling is not certified.",
  },
  umantis: {
    ...BASE,
    platform: "umantis",
    name: "Umantis",
    route: "human_handoff",
    certification: "human_only",
    formInspection: "partial",
    fieldMapping: "unknown",
    authentication: "Employer login required.",
    securityControls: "Login wall; never bypassed.",
    evidence: "Stored destination evidence only.",
    limitation: "Login-gated application is a human handoff.",
  },
  direct_employer: {
    ...BASE,
    platform: "direct_employer",
    name: "Direct employer form",
    route: "browser_form",
    certification: "synthetic_fixture_only",
    formInspection: "supported",
    fieldMapping: "supported",
    authentication: "None proven for the synthetic fixture; real employer forms vary.",
    securityControls: "CAPTCHA, MFA and login are always human handoffs.",
    evidence: "The Phase 2 fixture and Phase 3 orchestration proved hydration, uploads, validation and reference extraction on loopback only.",
    limitation: "No real employer form is certified by that fixture evidence.",
  },
};

function hostOf(raw: string | null | undefined): string {
  try {
    return new URL(raw ?? "").hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export type AtsDetection = {
  platform: AtsPlatform;
  confidence: "source" | "host" | "none";
  evidence: string;
};

/** Detect only from persisted source or an actual hostname. No company-name guessing. */
export function detectAtsDestination(input: {
  url?: string | null;
  source?: string | null;
}): AtsDetection {
  const source = (input.source ?? "").toLowerCase();
  for (const platform of ["greenhouse", "lever", "ashby"] as const) {
    if (source === platform || source.startsWith(`${platform}:`)) {
      return { platform, confidence: "source", evidence: `Stored source prefix identifies ${platform}.` };
    }
  }
  const host = hostOf(input.url);
  if (!host) return { platform: "unknown", confidence: "none", evidence: "No destination URL is stored." };
  if (host === "greenhouse.io" || host.endsWith(".greenhouse.io")) {
    return { platform: "greenhouse", confidence: "host", evidence: `Host ${host} is a Greenhouse domain.` };
  }
  if (host === "lever.co" || host.endsWith(".lever.co")) {
    return { platform: "lever", confidence: "host", evidence: `Host ${host} is a Lever domain.` };
  }
  if (host === "ashbyhq.com" || host.endsWith(".ashbyhq.com")) {
    return { platform: "ashby", confidence: "host", evidence: `Host ${host} is an Ashby domain.` };
  }
  if (host.endsWith("myworkdayjobs.com") || host.endsWith("workday.com")) {
    return { platform: "workday", confidence: "host", evidence: `Host ${host} is a Workday domain.` };
  }
  if (host === "smartrecruiters.com" || host.endsWith(".smartrecruiters.com")) {
    return { platform: "smartrecruiters", confidence: "host", evidence: `Host ${host} is a SmartRecruiters domain.` };
  }
  if (host.endsWith("umantis.com")) {
    return { platform: "umantis", confidence: "host", evidence: `Host ${host} is an Umantis domain.` };
  }
  return {
    platform: "direct_employer",
    confidence: "host",
    evidence: `Host ${host} is not a recognised ATS; treat it as an employer-hosted form.`,
  };
}

export function capabilityFor(platform: AtsPlatform): AtsCapability | null {
  return platform === "unknown" ? null : ATS_CAPABILITIES[platform];
}

export function capabilityMatrix(): AtsCapability[] {
  return Object.values(ATS_CAPABILITIES);
}
