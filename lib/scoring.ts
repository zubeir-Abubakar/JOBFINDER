import type { ProfileData, Skill } from "./profile";

export type MatchFlag = "strong" | "possible" | "weak" | "not_suitable";

export type Dimension = "technical" | "experience" | "seniority" | "language" | "location" | "salary";

export type JobAnalysis = {
  score: number;
  flag: MatchFlag;
  breakdown: Record<Dimension, number>;
  weights: Record<Dimension, number>;
  matched: string[];
  missing: string[];
  preferred: string[];
  evidence: Record<Dimension, string>;
  concerns: string[];
  recommendation: string;
  seniority: string;
  yearsRequired: number | null;
  languages: string[];
  workPermitNote: string | null;
  engine: string;
  generatedAt: string;
};

const WEIGHTS: Record<Dimension, number> = {
  technical: 35,
  experience: 25,
  seniority: 15,
  language: 10,
  location: 10,
  salary: 5,
};

const ALIASES: Record<string, string[]> = {
  Playwright: ["playwright"],
  Cypress: ["cypress"],
  Selenium: ["selenium", "webdriver"],
  Appium: ["appium"],
  Espresso: ["espresso"],
  XCUITest: ["xcuitest", "xcuittest", "xcode ui test"],
  "REST Assured": ["rest assured", "restassured"],
  Postman: ["postman"],
  Swagger: ["swagger", "openapi"],
  Python: ["python"],
  JavaScript: ["javascript", "js "],
  TypeScript: ["typescript"],
  Java: ["java "],
  SQL: ["sql"],
  Jenkins: ["jenkins"],
  "Azure DevOps": ["azure devops", "azure pipelines"],
  Docker: ["docker"],
  Git: ["git "],
  "CI/CD": ["ci/cd", "continuous integration"],
  JMeter: ["jmeter"],
  k6: ["k6"],
  Grafana: ["grafana"],
  Jira: ["jira"],
  Xray: ["xray"],
  "QA Touch": ["qa touch"],
  "Test planning": ["test planning", "test plan"],
  "Test strategy": ["test strategy"],
  "Defect management": ["defect management", "bug management"],
  "Test reporting": ["test reporting", "test reports"],
  "Release readiness": ["release readiness", "release sign-off"],
  "Go/No-Go assessments": ["go/no-go", "go no go"],
  "Manual & exploratory testing": ["exploratory testing", "manual testing"],
  "Regression testing": ["regression testing", "regression"],
  "Integration testing": ["integration testing"],
  "End-to-end testing": ["end-to-end", "end to end", "e2e"],
};

const MISSING_DICTIONARY = [
  "Cucumber",
  "BDD",
  "Robot Framework",
  "TestNG",
  "JUnit",
  "PyTest",
  "Kotlin",
  "Swift",
  "C#",
  ".NET",
  "Gatling",
  "LoadRunner",
  "Tosca",
  "GitLab CI",
  "GitHub Actions",
  "AWS",
  "Azure",
  "GCP",
  "Kubernetes",
  "Terraform",
  "GraphQL",
  "Kafka",
  "Selenium Grid",
  "Maestro",
  "Detox",
  "TestRail",
  "Zephyr",
  "BrowserStack",
  "Sauce Labs",
];

const SWISS_SIGNALS = [
  "switzerland",
  "schweiz",
  "suisse",
  "svizzera",
  "zurich",
  "zürich",
  "geneva",
  "genève",
  "geneve",
  "lausanne",
  "bern",
  "basel",
  "zug",
  "lucerne",
  "luzern",
  "winterthur",
  "st. gallen",
  "lugano",
  "fribourg",
  "vaud",
  "ticino",
  "swiss",
];

const FINTECH_SIGNALS = ["fintech", "payments", "payment", "banking", "bank", "financial", "trading", "invoice", "insurance", "wealth", "credit", "ledger"];

export function htmlToText(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function has(text: string, needle: string): boolean {
  return text.includes(needle.toLowerCase());
}

export function detectMatchedSkills(text: string, profile: ProfileData): string[] {
  const lower = ` ${text.toLowerCase().replace(/\s+/g, " ")} `;
  const pool: Array<{ name: string; aliases: string[] }> = profile.skills.map((s: Skill) => ({
    name: s.name,
    aliases: ALIASES[s.name] ?? [s.name.toLowerCase()],
  }));
  const matched = new Set<string>();
  for (const skill of pool) {
    if (skill.aliases.some((alias) => lower.includes(alias.toLowerCase()))) matched.add(skill.name);
  }
  // Category-level signals map to the owner's underlying skills.
  if (/api test|api automation|rest api/.test(lower)) matched.add("API testing");
  if (/mobile (app|application)|ios|android/.test(lower)) matched.add("Mobile testing");
  if (/test automation|automation framework|automated test/.test(lower)) matched.add("Test automation");
  return [...matched];
}

export function detectMissingSkills(text: string, matched: string[], profile: ProfileData): string[] {
  const lower = ` ${text.toLowerCase().replace(/\s+/g, " ")} `;
  const owned = new Set(profile.skills.map((s) => s.name.toLowerCase()));
  const missing = MISSING_DICTIONARY.filter((tech) => {
    const needle = tech.toLowerCase();
    return lower.includes(needle) && !owned.has(needle) && !matched.some((m) => m.toLowerCase().includes(needle));
  });
  return missing;
}

export function detectLanguages(text: string): string[] {
  const lower = text.toLowerCase();
  const languages: string[] = [];
  if (/\b(german|deutsch)\b/.test(lower)) languages.push("German");
  if (/\b(french|français|francais)\b/.test(lower)) languages.push("French");
  if (/\b(english|englisch|anglais)\b/.test(lower)) languages.push("English");
  return languages;
}

const PREFERRED_SIGNAL = /\b(a plus|plus|advantage|advantageous|nice to have|desirable|optional|useful|willing to learn|von vorteil|wünschenswert)\b/i;
const REQUIRED_SIGNAL = /\b(fluent|fluency|native|mother tongue|muttersprache|required|mandatory|must|zwingend|minimum|ideally|c1|c2|b2|b1)\b/i;

function languageRequired(text: string, language: string): { required: boolean; level: string | null } {
  const lang = language === "German" ? /\b(german|deutsch)\b/i : language === "French" ? /\b(french|français|francais)\b/i : /\b(english|englisch|anglais)\b/i;
  // Evaluate each sentence separately. This prevents "Fluent English; German is
  // a plus" from being read as a German requirement.
  for (const sentence of text.split(/\n|(?<=[.!?;])\s+/)) {
    if (!lang.test(sentence)) continue;
    if (/\b(no|not|without|kein[e]?|nicht)\b[^.]{0,35}\b(required|needed|necessary|erforderlich)\b/i.test(sentence)) continue;
    if (PREFERRED_SIGNAL.test(sentence) && !/\b(required|mandatory|zwingend|must)\b/i.test(sentence)) continue;
    if (!REQUIRED_SIGNAL.test(sentence)) continue;
    const level = sentence.match(/\b(c1|c2|b2|b1)\b/i)?.[1]?.toUpperCase() ?? null;
    return { required: true, level };
  }
  return { required: false, level: null };
}

/** Skills mentioned only as a plus/useful are not treated as mandatory gaps. */
export function detectPreferredSkills(text: string, missing: string[]): string[] {
  const lower = text.toLowerCase();
  return missing.filter((tech) => {
    const index = lower.indexOf(tech.toLowerCase());
    if (index < 0) return false;
    const context = lower.slice(Math.max(0, index - 150), index + tech.length + 150);
    return PREFERRED_SIGNAL.test(context);
  });
}

export function analyseJob(
  job: {
    title: string;
    company: string;
    location: string | null;
    description: string | null;
    remote: number | boolean;
    tags?: string[];
    salary?: string | null;
  },
  profile: ProfileData,
): JobAnalysis {
  const description = htmlToText(job.description ?? "");
  const combined = `${job.title}\n${job.company}\n${job.location ?? ""}\n${description}${(job.tags ?? []).join(" ")}`;
  const lower = combined.toLowerCase();

  const matched = detectMatchedSkills(combined, profile);
  const allMissing = detectMissingSkills(combined, matched, profile);
  const preferred = detectPreferredSkills(combined, allMissing);
  const missing = allMissing.filter((tech) => !preferred.includes(tech));
  const languages = detectLanguages(combined);
  const german = languageRequired(combined, "German");
  const french = languageRequired(combined, "French");
  const english = languageRequired(combined, "English");

  // 1. Technical coverage — partial credit when a posting names no specific stack.
  let technical = 0.55;
  if (matched.length + missing.length + preferred.length > 0) {
    // Preferred-only technologies contribute a smaller denominator penalty and
    // are never described as mandatory requirements.
    technical = matched.length / (matched.length + missing.length + preferred.length * 0.6);
    // Exposure-only skills must not count as full evidence.
    const exposure = new Set(profile.skills.filter((s) => s.level === "exposure").map((s) => s.name));
    const penalty = matched.filter((m) => exposure.has(m)).length * 0.06;
    technical = Math.max(0, technical - penalty);
  }
  technical = Math.min(1, technical * 1.08);

  // 2. Experience duration.
  const yearsMatch = description.match(/(\d{1,2})\s*(?:\+|plus)?\s*(?:years|jahre|ans|anni)/i);
  const yearsRequired = yearsMatch ? Number(yearsMatch[1]) : null;
  const ownerYears = 5;
  let experience = 0.85;
  if (yearsRequired !== null) {
    experience = yearsRequired <= ownerYears ? 1 : Math.max(0.25, 1 - (yearsRequired - ownerYears) * 0.18);
  }
  if (/lead|manager|mentor|people management|line manage/i.test(combined) && /QA (Lead|Manager)|Lead QA|Test Manager/i.test(profile.profile.headline ?? "")) {
    experience = Math.min(1, experience + 0.1);
  }

  // 3. Seniority.
  const title = job.title.toLowerCase();
  let seniority = 0.7;
  let seniorityLabel = "Mid-level";
  if (/intern|working student|werkstudent|graduate|trainee|junior/.test(title)) {
    seniority = 0.25;
    seniorityLabel = "Junior / internship";
  } else if (/principal|head of|director|vp /.test(title)) {
    seniority = 0.55;
    seniorityLabel = "Principal / leadership";
  } else if (/senior|lead|manager|sdet/.test(title)) {
    seniority = 1;
    seniorityLabel = "Senior / lead";
  } else if (/engineer|specialist|consultant/.test(title)) {
    seniority = 0.8;
    seniorityLabel = "Professional";
  }

  // 4. Salary compatibility (5%). Unknown salaries are neutral, never penalised.
  const salaryText = `${job.salary ?? ""} ${description}`;
  const minSalary = profile.preferences.min_salary;
  let salary = 0.75;
  const annual = salaryText.match(/(?:chf|fr\.?)\s?([\d'’.,]{4,7})|([\d]{2,3})['’]?000/i);
  const advertised = annual ? Number((annual[1] ?? annual[2] ?? "").replace(/[^\d]/g, "")) : null;
  if (advertised && advertised > 0) {
    if (!minSalary) salary = advertised >= 90000 ? 1 : 0.7;
    else if (advertised >= minSalary) salary = 1;
    else salary = advertised >= minSalary * 0.85 ? 0.6 : 0.25;
  }

  // 5. Language compatibility.
  let language = 1;
  const concerns: string[] = [];
  if (german.required) {
    language = 0.15;
    concerns.push(`German${german.level ? ` ${german.level}` : ""} appears to be required — the profile currently evidences English only.`);
  } else if (french.required) {
    language = 0.6;
    concerns.push(`French${french.level ? ` ${french.level}` : ""} is requested; confirm your actual level before applying.`);
  }
  if (english.required && !(profile.languages ?? []).some((l) => /english/i.test(l))) {
    language = Math.min(language, 0.5);
    concerns.push("English is required but is not recorded in the profile languages.");
  }

  // 6. Location and authorisation.
  const remote = Boolean(job.remote);
  const locationText = `${job.location ?? ""}`.toLowerCase();
  const isSwiss = SWISS_SIGNALS.some((s) => has(locationText, s) || has(lower, s));
  let location = isSwiss ? 1 : remote ? 0.6 : 0.35;
  if (!isSwiss && remote) concerns.push("Remote role outside Switzerland — confirm it accepts Swiss-based applicants.");
  if (!remote && !isSwiss) concerns.push("Location outside Switzerland; relocation and permit implications need review.");
  const permitMentioned = /work permit|eligibility to work|authori[sz]ation to work|arbeitsbewilligung|visa sponsorship/i.test(lower);
  const permitBlocked = /no visa sponsorship|without sponsorship|citizenship required|passport required|swiss or eu (citizen|national)s? only|eu\/efta (citizen|national)s? only|keine visumsponsoring/i.test(lower);
  const candidatePermit = /permit b|swiss permit|authorised to work in switzerland|authorized to work in switzerland/i.test(profile.profile.work_authorisation ?? "");
  let workPermitNote: string | null = null;
  if (permitBlocked) {
    location = Math.min(location, 0.4);
    concerns.push("Posting includes a citizenship or sponsorship restriction — verify your Swiss Permit B eligibility with the employer.");
    workPermitNote = "Citizenship/sponsorship restriction needs verification.";
  } else if (permitMentioned && candidatePermit) {
    workPermitNote = "Requires eligibility to work in Switzerland; the verified profile records a Swiss Permit B.";
  } else if (permitMentioned) {
    concerns.push("Posting requires work authorisation that is not evidenced in the profile.");
    workPermitNote = "Work authorisation is required but not recorded in the profile.";
  }

  const breakdown: Record<Dimension, number> = { technical, experience, seniority, language, location, salary };
  const score = Math.round(
    (Object.keys(WEIGHTS) as Dimension[]).reduce((total, key) => total + breakdown[key] * WEIGHTS[key], 0),
  );
  const flag: MatchFlag = score >= 80 ? "strong" : score >= 65 ? "possible" : score >= 45 ? "weak" : "not_suitable";

  if (missing.length > 0) concerns.push(`Required or unverified gaps: ${missing.slice(0, 4).join(", ")}.`);
  if (preferred.length > 0) concerns.push(`Also named as a plus/useful, not mandatory: ${preferred.slice(0, 4).join(", ")}.`);
  if (matched.length === 0) concerns.push("No stack keywords from the verified profile were detected — review the original posting manually.");
  if (yearsRequired && yearsRequired > ownerYears) concerns.push(`Posting asks for ${yearsRequired} years; the profile records 5+.`);

  const recommendation =
    flag === "strong"
      ? "Strong match. Send to the CV agent and prepare an application package."
      : flag === "possible"
        ? "Possible match. Review the missing or preferred skills, then decide whether to tailor documents."
        : flag === "weak"
          ? "Weak match. Apply only if the role is strategically interesting; gaps outweigh the overlap."
          : "Not suitable. Keep for reference, but do not spend application effort.";

  const evidence: Record<Dimension, string> = {
    technical: matched.length
      ? `Matched profile evidence: ${matched.join(", ")}.${missing.length ? ` Required/unverified gaps: ${missing.join(", ")}.` : ""}${preferred.length ? ` Optional technologies: ${preferred.join(", ")}.` : ""}`
      : `No verified stack match found in the source text.${missing.length ? ` Required/unverified gaps: ${missing.slice(0, 5).join(", ")}.` : ""}`,
    experience: yearsRequired
      ? `The source requests ${yearsRequired} year(s); the verified profile records 5+ years.`
      : "The source states no explicit years requirement; the profile records 5+ years of QA experience.",
    seniority: `The source title reads as ${seniorityLabel}; the profile headline is Senior QA Engineer.`,
    language: [
      english.required ? `English${english.level ? ` ${english.level}` : ""} is required and is recorded in the profile.` : "No mandatory English requirement was detected.",
      german.required ? `German${german.level ? ` ${german.level}` : ""} is required and is not evidenced in the profile.` : "German is not stated as mandatory.",
      french.required ? `French${french.level ? ` ${french.level}` : ""} is requested; confirm your level.` : "French is not stated as mandatory.",
    ].join(" "),
    location: `${job.location ?? "Location not stated"}${remote ? " · remote" : ""}. ${workPermitNote ?? (isSwiss ? "Swiss location; no permit restriction detected." : "Location needs manual review.")}`,
    salary: salaryText.trim()
      ? `Salary evidence found in the posting; the profile sets ${minSalary ? `a CHF ${minSalary} minimum` : "no minimum"}.`
      : "No salary stated; treated as neutral rather than penalised.",
  };

  return {
    score,
    flag,
    breakdown,
    weights: WEIGHTS,
    matched,
    missing,
    preferred,
    evidence,
    concerns,
    recommendation,
    seniority: seniorityLabel,
    yearsRequired,
    languages,
    workPermitNote,
    engine: "at-rules-v2",
    generatedAt: new Date().toISOString(),
  };
}

export function flagLabel(flag: string | null | undefined): string {
  switch (flag) {
    case "strong":
      return "Strong match";
    case "possible":
      return "Possible match";
    case "weak":
      return "Weak match";
    case "not_suitable":
      return "Not suitable";
    default:
      return "Not analysed";
  }
}

export function flagClass(flag: string | null | undefined): string {
  switch (flag) {
    case "strong":
      return "badge-good";
    case "possible":
      return "badge-info";
    case "weak":
      return "badge-warn";
    case "not_suitable":
      return "badge-bad";
    default:
      return "badge-neutral";
  }
}
