import { htmlToText } from "./scoring";
import type { ProfileData } from "./profile";

export type AtsCheck = { label: string; ok: boolean; detail: string; weight: number };

export type AtsReport = {
  score: number;
  keywordCoverage: number;
  checks: AtsCheck[];
  missingKeywords: string[];
  warnings: string[];
  wordCount: number;
  engine: string;
  generatedAt: string;
  disclaimer: string;
};

const STOPWORDS = new Set(
  `the and for with you your our will are that this from have has can all not but who what their they them its it's about into over under more most other than then there here also experience work working role position team company job apply application candidate requirements responsibilities including within across using able strong good excellent knowledge years year plus etc must should would could may might ensure support develop developed develop support build built lead leading manage managing new well as at by in on of to a an is be or if while during per via such systems system software engineer engineering quality test testing qa senior`.split(
    /\s+/,
  ),
);

function keywords(text: string): string[] {
  const counts = new Map<string, number>();
  for (const raw of text.toLowerCase().match(/[a-z][a-z+#./-]{2,}/g) ?? []) {
    const word = raw.replace(/[./-]+$/, "");
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 28)
    .map(([word]) => word);
}

export function assessAts(text: string, jobDescription: string, profile: ProfileData, sourceText = "", sourceRoleCount?: number): AtsReport {
  const lower = text.toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);
  const jobKeywords = keywords(htmlToText(jobDescription));
  const matchedKeywords = jobKeywords.filter((k) => lower.includes(k));
  const missingKeywords = jobKeywords.filter((k) => !lower.includes(k)).slice(0, 12);
  const keywordCoverage = jobKeywords.length ? Math.round((matchedKeywords.length / jobKeywords.length) * 100) : 0;

  const checks: AtsCheck[] = [];
  const push = (label: string, ok: boolean, detail: string, weight: number) => checks.push({ label, ok, detail, weight });

  const hasEmail = Boolean(profile.profile.email && lower.includes(profile.profile.email.toLowerCase()));
  const hasPhone = Boolean(profile.profile.phone && text.includes(profile.profile.phone));
  push("Contact details", hasEmail || hasPhone, hasEmail && hasPhone ? "Email and phone present" : hasEmail || hasPhone ? "Only one contact channel present — add the other in your profile" : "No contact details found — add email and phone to your profile", 12);
  push("Professional summary", /professional summary|profile/i.test(text) && text.length > 200, "Summary section detected", 10);
  push("Skills section", /core skills|technical skills|skills/i.test(text), "Skills section detected", 10);
  push("Experience section", /professional experience|work experience|experience/i.test(text), "Experience section detected", 10);
  const roleCount = sourceRoleCount ?? profile.experiences.length;
  push("Employment history", roleCount > 0, roleCount ? `${roleCount} roles carried over from the master CV` : "No experience recorded in the profile", 10);
  push("Dates present", /(19|20)\d{2}|present|date to confirm/i.test(text), "Dates are rendered from the master CV; confirm any 'Date to confirm' entries", 8);
  push("Readable length", words.length >= 260 && words.length <= 1050, `${words.length} words — single-column, no tables or graphics`, 10);
  push("Keyword coverage", keywordCoverage >= 55, `${keywordCoverage}% of the vacancy's most frequent terms appear in the document`, 15);

  const ownedSkills = new Set(profile.skills.map((s) => s.name.toLowerCase()));
  const sourceLower = sourceText.toLowerCase();
  const techTokens = [
    "Cucumber",
    "Robot Framework",
    "Kotlin",
    "Swift",
    "Tosca",
    "LoadRunner",
    "GitHub Actions",
    "Kubernetes",
    "Terraform",
    "GraphQL",
    "Kafka",
    "TestRail",
    "Zephyr",
    "BrowserStack",
  ];
  const unknownClaims = techTokens.filter(
    (tech) => lower.includes(tech.toLowerCase()) && !ownedSkills.has(tech.toLowerCase()) && !sourceLower.includes(tech.toLowerCase()),
  );
  push("No unsupported claims", unknownClaims.length === 0, unknownClaims.length ? `Document mentions unverified technologies: ${unknownClaims.join(", ")}` : "Every technology mentioned maps to the verified master CV", 20);

  const totalWeight = checks.reduce((sum, c) => sum + c.weight, 0);
  const earned = checks.filter((c) => c.ok).reduce((sum, c) => sum + c.weight, 0);
  const score = Math.max(0, Math.min(100, Math.round((earned / totalWeight) * 100)));

  const warnings: string[] = [];
  if (missingKeywords.length) warnings.push(`Not present in the document: ${missingKeywords.slice(0, 6).join(", ")}.`);
  if (!hasEmail) warnings.push("Add an email address to the master profile so every generated document carries contact details.");
  if (!hasPhone) warnings.push("Add a phone number to the master profile.");
  if (sourceRoleCount === undefined && profile.experiences.some((e) => !e.start_date)) warnings.push("One or more roles have no dates. Dates are not invented — pull them from your original CV.");
  if (unknownClaims.length) warnings.push("The document references technologies the profile does not support. Regenerate after correcting the profile.");

  return {
    score,
    keywordCoverage,
    checks,
    missingKeywords,
    warnings,
    wordCount: words.length,
    engine: "ats-rules-v1",
    generatedAt: new Date().toISOString(),
    disclaimer:
      "Internal quality assessment against this platform's ATS rules. It is not a guarantee of passing any employer's applicant tracking system.",
  };
}
