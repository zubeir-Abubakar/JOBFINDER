/**
 * Shared document claim checks.
 *
 * A generated document may only mention tools and numbers that already exist
 * in the verified master CV or the verified profile. Keeping these checks in
 * one module prevents the CV gate, cover-letter gate, ATS self-check and final
 * readiness gate from disagreeing about what counts as supported evidence.
 */

export const TECH_CLAIMS = [
  "playwright", "cypress", "selenium", "appium", "espresso", "xcuitest", "rest assured", "postman",
  "python", "javascript", "typescript", "java", "c#", ".net", "sql", "jenkins", "azure devops",
  "docker", "kubernetes", "terraform", "aws", "azure", "gcp", "ci/cd", "jmeter", "k6", "grafana",
  "jira", "xray", "testrail", "zephyr", "cucumber", "bdd", "robot framework", "testng", "junit",
  "pytest", "kotlin", "swift", "gatling", "loadrunner", "tricentis tosca", "github actions",
  "gitlab ci", "graphql", "kafka", "browserstack", "sauce labs", "maestro", "detox",
] as const;

export function normaliseClaimText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function containsTerm(haystack: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Allow ordinary punctuation as a boundary ("Jira."), while preventing
  // "java" from matching inside "javascript".
  return new RegExp(`(^|[^a-z0-9+#])${escaped}(?![a-z0-9+#])`, "i").test(haystack);
}

/**
 * Returns technologies mentioned in the document that are absent from both the
 * master source text and the verified skill list.
 */
export function unsupportedTechClaims(text: string, evidence: string, profileSkills: string[]): string[] {
  const haystack = normaliseClaimText(`${evidence} ${profileSkills.join(" ")}`);
  const candidate = normaliseClaimText(text);
  return TECH_CLAIMS.filter((tech) => containsTerm(candidate, tech) && !containsTerm(haystack, tech));
}

export function metricTokens(value: string): string[] {
  return (
    value.match(
      /\b\d+(?:\.\d+)?\+?\s*(?:%|percent|hours?|hrs?|minutes?|days?|weeks?|months?|tests?|cases?|engineers?|people?|users?|clients?|countries?|projects?|releases?)(?![A-Za-z])/gi,
    ) ?? []
  ).map((token) => token.toLowerCase().replace(/\s+/g, " "));
}

export function unsupportedMetricClaims(text: string, evidence: string, target = ""): string[] {
  const supported = new Set(metricTokens(`${evidence} ${target}`));
  return [...new Set(metricTokens(text))].filter((metric) => !supported.has(metric));
}

export function workAuthorisationRequired(jobDescription: string): boolean {
  return /\b(?:work\s*(?:permit|authorisation|authorization)|right\s+to\s+work|sponsorship|sponsor(?:ed|ing)?|visa)\b/i.test(
    jobDescription,
  );
}

export function hasSwissPermitB(text: string | null | undefined): boolean {
  return /\b(?:swiss\s+)?permit\s*b\b|\bb\s*permit\b/i.test(text ?? "");
}

export function claimsNoSponsorship(text: string): boolean {
  return /\b(?:do not|does not|no)\s+(?:require|need)\s+(?:employer\s+)?sponsorship\b|\bno\s+(?:employer\s+)?sponsorship\s+(?:is\s+)?required\b/i.test(
    text,
  );
}

export function claimsRequiresSponsorship(text: string): boolean {
  if (/\b(?:do not|does not|no)\s+(?:require|need)\s+(?:employer\s+)?sponsorship\b/i.test(text)) return false;
  return /\b(?:require|need|requires|needs)\s+(?:employer\s+)?sponsorship\b/i.test(text);
}

export function mentionsSalaryExpectation(text: string): boolean {
  return /\b(?:salary|compensation|remuneration)\b|\b(?:CHF|EUR|USD|GBP)\s?\d/i.test(text);
}

export function hasGenericCoverLanguage(text: string): boolean {
  return /\b(?:i am writing to (?:apply|express)|i am excited to apply|i would be a great fit|i believe i would be a great fit|as a (?:seasoned|passionate|results-driven) professional|my background is a direct match|i would bring the same|i would welcome the opportunity|proven track record|dynamic professional)\b/i.test(
    text,
  );
}

export function hasKeywordStuffing(text: string, minimum = 5): boolean {
  const commaRuns = text.match(/[^.!?]*?(?:\b[\w+#./-]{2,}\b\s*,\s*){5,}\b[\w+#./-]{2,}\b[^.!?]*/g) ?? [];
  return commaRuns.some((run) => {
    const values = run
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length >= 2 && item.length <= 40);
    return values.length >= minimum;
  });
}
