import type { MasterCv, MasterRole } from "./master-cv";
import type { JobAnalysis } from "./scoring";
import { generateText } from "./providers";
import {
  coverLetterLengthIssues,
  extractCoverLetterRequirements,
  measureCoverLetter,
  type CoverLetterRequirements,
} from "./cover-letter-requirements";
import {
  claimsNoSponsorship,
  claimsRequiresSponsorship,
  hasGenericCoverLanguage,
  hasKeywordStuffing,
  hasSwissPermitB,
  mentionsSalaryExpectation,
  unsupportedTechClaims,
  workAuthorisationRequired,
} from "./claim-validation";

export type TailoredCv = {
  summary: string;
  roles: MasterRole[];
  tailoredWithAi: boolean;
  provider: string | null;
  model: string | null;
  warnings: string[];
};

export type CoverLetterContent = {
  salutation: string;
  paragraphs: string[];
  closing: string;
  tailoredWithAi: boolean;
  provider: string | null;
  model: string | null;
  warnings: string[];
};

type JobLike = {
  title: string;
  company: string;
  location: string | null;
  description: string;
  url?: string | null;
};

type AiContext = {
  job: JobLike;
  analysis: JobAnalysis;
  taskId: string | null;
  workflowId: string | null;
  /** Resolved from persisted vacancy requirements; falls back to the description. */
  coverLetterRequirements?: CoverLetterRequirements;
};

const STOP_WORDS = new Set(
  "about above after again against all also and any are because been before being between both but can could did does doing down during each few for from further had has have having her here hers herself him himself his how into its itself just more most other our ours ourselves out over own same she should some such than that the their theirs them themselves then there these they this those through too under until very was were what when where which while who whom why will with would you your yours yourself yourselves role job work team teams experience years year strong excellent good ability able across within using use used ensure ensuring support supporting help helping including include includes etc our you'll we're role. candidate candidates company companies".split(
    " ",
  ),
);

function words(value: string): string[] {
  return value.toLowerCase().match(/[a-z][a-z0-9+#./-]{2,}/g) ?? [];
}

function keywordSet(job: JobLike, analysis: JobAnalysis): Set<string> {
  const values = [
    job.title,
    job.company,
    job.description,
    ...(analysis.matched ?? []),
    ...(analysis.missing ?? []),
    ...(analysis.concerns ?? []),
  ].join(" ");
  return new Set(words(values).filter((word) => !STOP_WORDS.has(word)));
}

function relevance(value: string, keywords: Set<string>): number {
  const tokens = new Set(words(value));
  let score = 0;
  for (const keyword of keywords) if (tokens.has(keyword)) score += keyword.length > 5 ? 2 : 1;
  return score;
}

function hasMetric(value: string): boolean {
  return /\b\d+(?:\.\d+)?\+?\s*(?:%|percent|hours?|hrs?|minutes?|days?|weeks?|months?|tests?|cases?|engineers?|people?|users?|clients?|countries?|projects?|releases?)(?![A-Za-z])/i.test(
    value,
  ) || /\bzero\s+(?:critical|sev(?:erity)?[- ]?1|p1)\b/i.test(value);
}

function achievementCandidates(master: MasterCv, keywords: Set<string>): Array<{ role: MasterRole; bullet: string; score: number }> {
  const candidates: Array<{ role: MasterRole; bullet: string; score: number }> = [];
  for (const role of master.roles) {
    for (const bullet of role.bullets) {
      let score = relevance(`${role.title} ${role.company} ${bullet}`, keywords);
      if (hasMetric(bullet)) score += 25;
      if (/\b(?:led|built|reduced|improved|automated|introduced|achieved|delivered|migrated|designed)\b/i.test(bullet)) score += 1;
      candidates.push({ role, bullet, score });
    }
  }
  return candidates.sort((a, b) => b.score - a.score || Number(hasMetric(b.bullet)) - Number(hasMetric(a.bullet)));
}

function pickAchievements(master: MasterCv, keywords: Set<string>, count = 2): Array<{ role: MasterRole; bullet: string }> {
  const candidates = achievementCandidates(master, keywords);
  const selected: Array<{ role: MasterRole; bullet: string }> = [];
  for (const candidate of candidates) {
    if (selected.some((item) => item.bullet.toLowerCase() === candidate.bullet.toLowerCase())) continue;
    selected.push({ role: candidate.role, bullet: candidate.bullet });
    if (selected.length >= count) break;
  }
  return selected;
}

function relevantSkills(master: MasterCv, keywords: Set<string>, count = 8): string[] {
  const values = master.skillGroups
    .flatMap((group) => group.values)
    .filter((value) => relevance(value, keywords) > 0)
    .sort((a, b) => relevance(b, keywords) - relevance(a, keywords));
  return [...new Set(values)].slice(0, count);
}

function lowerFirst(value: string): string {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}

export function deterministicSummary(master: MasterCv, job: JobLike, analysis: JobAnalysis): string {
  const keywords = keywordSet(job, analysis);
  const lead = master.roles[0];
  const skills = relevantSkills(master, keywords, 5);
  const achievements = pickAchievements(master, keywords, 2);
  const skillPhrase = skills.length > 0 ? skills.join(", ") : "automation, API and release quality";
  const company = job.company;
  const role = job.title;
  const evidence = achievements.length
    ? achievements.map((item) => `${item.bullet.replace(/\.$/, "")}`).join("; ")
    : "delivering reliable releases and improving test feedback loops";
  const leadText = lead ? `Most recently ${lead.title} at ${lead.company}, ` : "";
  return `${role} candidate with hands-on strength in ${skillPhrase}. ${leadText}I combine automation, risk-based testing and release ownership to help teams ship dependable software. Evidence includes ${evidence}. I am targeting ${company} because the role calls for the same balance of technical depth, clear communication and measurable quality improvement.`
    .replace(/\s+/g, " ")
    .trim();
}

function requirementPhrase(analysis: JobAnalysis, job: JobLike): string {
  const matched = [...new Set((analysis.matched ?? []).filter(Boolean))];
  if (matched.length > 0) return matched.slice(0, 3).join(", ");
  const responsibility = analysis.classification?.responsibilities?.[0];
  if (responsibility) return lowerFirst(responsibility.replace(/\.$/, ""));
  return `the quality needs described in the ${job.title} vacancy`;
}

function authorisationSentence(master: MasterCv, job: JobLike): string {
  if (!hasSwissPermitB(master.permit) || !workAuthorisationRequired(job.description)) return "";
  return "I hold a valid Swiss Permit B with work authorisation and do not require employer sponsorship. ";
}

function sentenceParts(value: string): string[] {
  return (value.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [value]).map((part) => part.trim()).filter(Boolean);
}

/** Trim only optional sentences when a recruiter maximum is exceeded. */
function fitCoverLetterToMaximum(
  content: CoverLetterContent,
  job: JobLike,
  requirements: CoverLetterRequirements,
): CoverLetterContent {
  const exceedsMaximum = () =>
    coverLetterLengthIssues(measureCoverLetter(content), requirements).some(
      (issue) => issue.code === "too_long" || issue.code === "characters_above_maximum",
    );
  if (!exceedsMaximum()) return content;

  const paragraphs = content.paragraphs.map((paragraph) => sentenceParts(paragraph));
  // Keep the opening target, one verified achievement and the closing. Remove
  // supporting sentences first rather than padding or deleting evidence wholesale.
  const priorities = [2, 1, 3, 0];
  for (let pass = 0; pass < 24 && exceedsMaximum(); pass += 1) {
    let removed = false;
    for (const paragraphIndex of priorities) {
      const parts = paragraphs[paragraphIndex];
      if (!parts || parts.length <= 1) continue;
      for (let sentenceIndex = parts.length - 1; sentenceIndex >= 0; sentenceIndex -= 1) {
        const sentence = parts[sentenceIndex];
        if (paragraphIndex === 3 && /\b(?:Permit B|sponsorship)\b/i.test(sentence)) continue;
        const candidateParts = [...parts.slice(0, sentenceIndex), ...parts.slice(sentenceIndex + 1)];
        const candidateParagraphs = paragraphs.map((item, index) =>
          index === paragraphIndex ? candidateParts.join(" ") : item.join(" "),
        );
        const candidateText = candidateParagraphs.join(" ");
        if (!candidateText.toLowerCase().includes(job.company.toLowerCase())) continue;
        if (!hasMetric(candidateText)) continue;
        paragraphs[paragraphIndex] = candidateParts;
        removed = true;
        break;
      }
      if (removed) break;
    }
    if (!removed) break;
  }
  return {
    ...content,
    paragraphs: paragraphs.map((parts) => parts.join(" ")).filter(Boolean),
    warnings: [...content.warnings, "Optional supporting detail was condensed to respect the stated cover-letter maximum."],
  };
}

export function deterministicCoverLetter(
  master: MasterCv,
  job: JobLike,
  analysis: JobAnalysis,
  requirements: CoverLetterRequirements = extractCoverLetterRequirements(job.description),
): CoverLetterContent {
  const keywords = keywordSet(job, analysis);
  const achievements = pickAchievements(master, keywords, 3);
  const skills = relevantSkills(master, keywords, 4);
  const lead = master.roles[0];
  const salutation = "Dear Hiring Team,";
  const requirementSummary = requirementPhrase(analysis, job);
  const skillPhrase = skills.length > 0 ? skills.join(", ") : "test automation, API testing and release quality";
  const first = achievements[0];
  const evidence = achievements.length
    ? achievements
        .map((item, index) => {
          const text = lowerFirst(item.bullet.replace(/\.$/, ""));
          if (index === 0) return `As ${item.role.title} at ${item.role.company}, I ${text}.`;
          if (item.role.key === first?.role.key) return `In the same role, I ${text}.`;
          return `Earlier, as ${item.role.title} at ${item.role.company}, I ${text}.`;
        })
        .join(" ")
    : `At ${lead?.company ?? "my most recent employer"} I owned test planning, automation and release validation for business-critical products.`;
  const requirementMap =
    (analysis.matched ?? []).length > 0
      ? `That evidence is relevant to the vacancy's focus on ${(analysis.matched ?? []).slice(0, 2).join(" and ")}.`
      : "The evidence above reflects the technical depth and release ownership described in the vacancy.";

  return fitCoverLetterToMaximum(
    {
      salutation,
      paragraphs: [
        `The ${job.title} role at ${job.company} calls for ${requirementSummary}. My verified experience covers ${skillPhrase}, with a record of turning test evidence into release decisions rather than simply adding more checks.`,
        evidence,
        `${requirementMap} I work by making risk visible early, automating the checks that decide quality and keeping evidence traceable for engineering and product teams. I also make release trade-offs explicit, so decisions are based on evidence rather than opinion and the test approach stays proportionate to the risk.`,
        `${authorisationSentence(master, job)}I would value the chance to discuss how I can contribute to ${job.company}'s quality engineering work.`,
      ],
      closing: "Sincerely,",
      tailoredWithAi: false,
      provider: null,
      model: null,
      warnings: ["Generated from the verified master CV using the deterministic fallback."],
    },
    job,
    requirements,
  );
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  const cleaned = value.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim() : null;
}

function invalidGenericOpening(value: string): boolean {
  return /^(i am writing to (?:apply|express)|i am excited to apply|as a (?:seasoned|passionate|results-driven) professional|i believe i would be a great fit)/i.test(
    value.trim(),
  );
}

function metricsIn(value: string): string[] {
  return value.match(/\b\d+(?:\.\d+)?\+?\s*(?:%|percent|hours?|hrs?|minutes?|days?|weeks?|months?|tests?|cases?|engineers?|people?|users?|clients?|countries?|projects?|releases?)(?![A-Za-z])/gi) ?? [];
}

function sourceMetrics(master: MasterCv): Set<string> {
  return new Set(metricsIn(master.sourceText).map((metric) => metric.toLowerCase().replace(/\s+/g, " ")));
}

function validateSummary(summary: string, master: MasterCv): string | null {
  if (summary.length < 80 || summary.length > 1_200) return "Summary length is outside the accepted range.";
  if (invalidGenericOpening(summary)) return "Summary uses a generic opening.";
  if (/\b(?:lorem ipsum|placeholder|insert|tbd|xxx)\b/i.test(summary)) return "Summary contains placeholder text.";
  const lower = summary.toLowerCase();
  for (const role of master.roles) {
    if (role.company.length > 2 && !master.sourceText.toLowerCase().includes(role.company.toLowerCase())) return "Master source is missing a company.";
    if (lower.includes(`at ${role.company.toLowerCase()}`) && !master.roles.some((item) => item.company === role.company)) {
      return "Summary introduces an unknown employer.";
    }
  }
  return null;
}

function mergeTailoredRoles(master: MasterCv, parsedRoles: unknown): { roles: MasterRole[]; changed: boolean } {
  if (!Array.isArray(parsedRoles)) return { roles: master.roles, changed: false };
  let changed = false;
  const roles = master.roles.map((role, index) => {
    const candidate = parsedRoles.find((item) => {
      if (!item || typeof item !== "object") return false;
      const object = item as Record<string, unknown>;
      return object.key === role.key || (object.company === role.company && object.title === role.title);
    }) as Record<string, unknown> | undefined;
    const fallback = candidate ?? (parsedRoles[index] as Record<string, unknown> | undefined);
    if (!fallback || !Array.isArray(fallback.bullets) || fallback.bullets.length !== role.bullets.length) return role;
    const bullets = fallback.bullets.map((bullet, bulletIndex) => {
      const value = cleanString(bullet);
      if (!value) return role.bullets[bulletIndex];
      const minimum = Math.max(4, Math.floor(role.bullets[bulletIndex].split(/\s+/).length * 0.45));
      if (value.split(/\s+/).length < minimum) return role.bullets[bulletIndex];
      return value;
    });
    const originalMetrics = new Set(metricsIn(role.bullets.join(" ")).map((metric) => metric.toLowerCase()));
    const allowedSourceMetrics = sourceMetrics(master);
    for (const metric of metricsIn(bullets.join(" "))) {
      const normalised = metric.toLowerCase();
      if (!originalMetrics.has(normalised) && !allowedSourceMetrics.has(normalised)) return role;
    }
    if (bullets.some((bullet, bulletIndex) => bullet !== role.bullets[bulletIndex])) changed = true;
    return { ...role, bullets };
  });
  return { roles, changed };
}

const CV_SCHEMA = {
  name: "tailored_cv",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      roles: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            key: { type: "string" },
            title: { type: "string" },
            company: { type: "string" },
            bullets: { type: "array", items: { type: "string" } },
          },
          required: ["key", "title", "company", "bullets"],
        },
      },
    },
    required: ["summary", "roles"],
  },
} as const;

const COVER_SCHEMA = {
  name: "cover_letter",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      salutation: { type: "string" },
      paragraphs: { type: "array", items: { type: "string" } },
      closing: { type: "string" },
    },
    required: ["salutation", "paragraphs", "closing"],
  },
} as const;

function jobBrief(job: JobLike, analysis: JobAnalysis, requirements?: CoverLetterRequirements): string {
  return JSON.stringify({
    title: job.title,
    company: job.company,
    location: job.location,
    score: analysis.score,
    matched: analysis.matched,
    missing: analysis.missing,
    concerns: analysis.concerns,
    coverLetterRequirements: requirements ?? null,
    description: job.description.slice(0, 7_000),
  });
}

export async function tailorCv(master: MasterCv, context: AiContext): Promise<TailoredCv> {
  const fallback: TailoredCv = {
    summary: deterministicSummary(master, context.job, context.analysis),
    roles: master.roles,
    tailoredWithAi: false,
    provider: null,
    model: null,
    warnings: [],
  };
  const prompt = `You are editing an existing CV, not creating a new one. Return JSON only, matching the schema.

NON-NEGOTIABLE:
- Keep every role and exactly the same number of bullets for each role.
- Never invent employers, titles, dates, certifications, skills, responsibilities or metrics.
- Preserve the original meaning and all measurable achievements.
- You may rewrite bullets for clarity, relevance and stronger action verbs.
- Tailor the summary and wording to the vacancy, but keep all claims grounded in the CV below.
- Include the role key exactly as supplied.

VACANCY AND ANALYSIS:
${jobBrief(context.job, context.analysis)}

MASTER CV:
${JSON.stringify({
  name: master.name,
  headline: master.headline,
  summary: master.summary,
  skillGroups: master.skillGroups,
  roles: master.roles.map((role) => ({
    key: role.key,
    title: role.title,
    company: role.company,
    dates: role.dates,
    summary: role.summary,
    projects: role.projects,
    bullets: role.bullets,
  })),
  certifications: master.certifications,
  education: master.education,
  languages: master.languages,
})}`;

  try {
    const result = await generateText({
      agentKey: "cv",
      taskId: context.taskId,
      workflowId: context.workflowId,
      source: "task",
      priority: 1,
      system: `You are a precise CV editor. Return only valid JSON matching this schema: ${JSON.stringify(CV_SCHEMA)}. Never fabricate experience.`,
      prompt,
      maxTokens: 3_200,
      temperature: 0.2,
      maxWaitMs: 35_000,
    });
    const parsed = parseJsonObject(result.text);
    if (!parsed) return { ...fallback, provider: result.provider, model: result.model, warnings: ["AI returned malformed JSON; source bullets were retained."] };
    const summary = cleanString(parsed.summary);
    const summaryError = summary ? validateSummary(summary, master) : "AI summary was empty.";
    const merged = mergeTailoredRoles(master, parsed.roles);
    const hasChangedRoles = merged.changed;
    const hasChangedSummary = Boolean(summary && !summaryError && summary !== master.summary);
    const changed = hasChangedSummary || hasChangedRoles;
    if (!changed) {
      return {
        summary: summary && !summaryError ? summary : fallback.summary,
        roles: merged.roles,
        tailoredWithAi: false,
        provider: result.provider,
        model: result.model,
        warnings: [summaryError ?? "AI revision passed validation but made no material change."],
      };
    }
    return {
      summary: summary && !summaryError ? summary : fallback.summary,
      roles: merged.roles,
      tailoredWithAi: true,
      provider: result.provider,
      model: result.model,
      warnings: summaryError ? [summaryError] : [],
    };
  } catch (error) {
    return {
      ...fallback,
      warnings: [`AI tailoring was unavailable (${error instanceof Error ? error.message : "unknown error"}); the master CV was used verbatim.`],
    };
  }
}

export async function generateCoverLetter(
  master: MasterCv,
  context: AiContext,
): Promise<CoverLetterContent> {
  const requirements =
    context.coverLetterRequirements ?? extractCoverLetterRequirements(context.job.description);
  const fallback = deterministicCoverLetter(master, context.job, context.analysis, requirements);
  const limitRule = requirements.source === "recruiter"
    ? `The vacancy states an EXPLICIT recruiter limit. The complete letter body, including salutation and closing, must satisfy: ${
        [
          requirements.minWords !== null ? `at least ${requirements.minWords} words` : "",
          requirements.maxWords !== null ? `at most ${requirements.maxWords} words` : "",
          requirements.minCharacters !== null ? `at least ${requirements.minCharacters} characters` : "",
          requirements.maxCharacters !== null ? `at most ${requirements.maxCharacters} characters` : "",
          requirements.maxPages !== null ? `at most ${requirements.maxPages} rendered page(s)` : "",
        ]
          .filter(Boolean)
          .join(" and ")
      }. Count the actual final text. Do not add irrelevant filler.`
    : "No explicit recruiter word or character limit was found. Use the internal professional target of 180 to 320 words. This is an internal default, not a recruiter requirement.";
  const prompt = `Write a concise, achievement-led cover letter for this specific vacancy. Return JSON only.

RULES:
- ${limitRule}
- Use 3 to 5 coherent paragraphs.
- No generic opening such as "I am writing to apply" or "I am excited to apply".
- Use one or two achievements from the master CV that are genuinely relevant to this vacancy.
- Use only verified facts. Never invent employers, tools, certifications, metrics or responsibilities.
- Mention the employer and role naturally.
- Address at least two requirements named in the vacancy analysis, using only verified evidence.
- Explain the measurable impact of the achievements and connect it to the employer's needs.
- Do not mention salary or compensation.
- If the vacancy asks about work authorisation or sponsorship, state exactly: "I hold a valid Swiss Permit B with work authorisation and do not require employer sponsorship." Only make that statement when the master CV supports it.
- End with a confident professional close.

VACANCY AND ANALYSIS:
${jobBrief(context.job, context.analysis, requirements)}

MASTER CV:
${JSON.stringify({
  name: master.name,
  headline: master.headline,
  summary: master.summary,
  skillGroups: master.skillGroups,
  roles: master.roles.map((role) => ({ title: role.title, company: role.company, dates: role.dates, summary: role.summary, projects: role.projects, bullets: role.bullets })),
  certifications: master.certifications,
  education: master.education,
  languages: master.languages,
})}`;

  try {
    const result = await generateText({
      agentKey: "cover",
      taskId: context.taskId,
      workflowId: context.workflowId,
      source: "task",
      priority: 1,
      system: `You write evidence-led cover letters. Return only valid JSON matching this schema: ${JSON.stringify(COVER_SCHEMA)}. Never invent facts.`,
      prompt,
      maxTokens: 1_500,
      temperature: 0.35,
      maxWaitMs: 35_000,
    });
    const parsed = parseJsonObject(result.text);
    if (!parsed) return { ...fallback, provider: result.provider, model: result.model, warnings: ["AI returned malformed JSON; deterministic letter retained."] };
    const paragraphs = Array.isArray(parsed.paragraphs)
      ? parsed.paragraphs.map(cleanString).filter((paragraph): paragraph is string => Boolean(paragraph))
      : [];
    const salutation = cleanString(parsed.salutation) ?? fallback.salutation;
    const closing = cleanString(parsed.closing) ?? fallback.closing;
    const text = paragraphs.join(" ");
    const candidateLength = measureCoverLetter({ salutation, paragraphs, closing });
    const lengthIssues = coverLetterLengthIssues(candidateLength, requirements);
    const source = sourceMetrics(master);
    const usedMetrics = [...new Set(metricsIn(text).map((metric) => metric.toLowerCase()))];
    const requirementTerms = [...new Set((context.analysis.matched ?? []).map((item) => item.toLowerCase()).filter(Boolean))];
    const requirementHits = requirementTerms.filter((term) => text.toLowerCase().includes(term)).length;
    const authorisationAsked = workAuthorisationRequired(context.job.description);
    const permitB = hasSwissPermitB(master.permit);
    const authorisationMentioned = /\b(?:permit\s*b|work\s+authoris|work\s+authoriz|right\s+to\s+work|sponsorship)\b/i.test(text);
    const invalid =
      paragraphs.length < 3 ||
      paragraphs.length > 6 ||
      lengthIssues.length > 0 ||
      invalidGenericOpening(paragraphs[0] ?? "") ||
      hasGenericCoverLanguage(text) ||
      hasKeywordStuffing(text, 6) ||
      (requirementTerms.length > 0 && requirementHits < Math.min(2, requirementTerms.length)) ||
      !text.toLowerCase().includes(context.job.company.toLowerCase()) ||
      usedMetrics.length === 0 ||
      usedMetrics.some((metric) => !source.has(metric)) ||
      unsupportedTechClaims(text, master.sourceText, master.skillGroups.flatMap((group) => group.values)).length > 0 ||
      mentionsSalaryExpectation(text) ||
      (authorisationAsked && permitB && !authorisationMentioned) ||
      claimsRequiresSponsorship(text);
    if (invalid) {
      const reason = lengthIssues[0]?.message ?? "grounding, length or vacancy-targeting checks";
      return { ...fallback, provider: result.provider, model: result.model, warnings: [`AI cover letter was rejected (${reason}); the deterministic letter was used.`] };
    }
    return { salutation, paragraphs, closing, tailoredWithAi: true, provider: result.provider, model: result.model, warnings: [] };
  } catch (error) {
    return { ...fallback, warnings: [`AI cover letter was unavailable (${error instanceof Error ? error.message : "unknown error"}); deterministic letter retained.`] };
  }
}
