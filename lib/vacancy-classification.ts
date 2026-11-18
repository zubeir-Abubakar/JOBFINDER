/**
 * Deterministic vacancy classification.
 *
 * A posting is not QA because it mentions "testing" once. Classification reads
 * the stated responsibilities and the title, then distinguishes hands-on
 * testing, automation, SDET/test-infrastructure, QA leadership, test
 * management, consulting, general engineering and product/business analysis.
 *
 * Every result is explainable: the matched signals, the responsibility lines and
 * each mandatory requirement are returned beside the category. No model is
 * involved, so a vendor cannot relabel a role to reach the 85% threshold.
 */

export type VacancyCategory =
  | "hands_on_testing"
  | "test_automation"
  | "sdet_infrastructure"
  | "qa_leadership"
  | "test_management"
  | "consulting"
  | "software_engineering"
  | "product_business_analysis"
  | "unclear";

export type RequirementKind =
  | "language"
  | "travel"
  | "onsite"
  | "certification"
  | "management"
  | "domain"
  | "authorisation"
  | "other";

export type MandatoryRequirement = {
  kind: RequirementKind;
  detail: string;
  language?: string;
  level?: string | null;
};

export type VacancyClassification = {
  category: VacancyCategory;
  label: string;
  isQa: boolean;
  testingIntensity: number;
  responsibilities: string[];
  signals: string[];
  mandatory: MandatoryRequirement[];
  preferences: string[];
  engine: string;
};

export type ClassificationInput = {
  title: string;
  company?: string;
  location?: string | null;
  description?: string | null;
};

const QA_TITLE =
  /\b(qa|quality assurance|quality analyst|test(?:ing)? engineer|test automation|sdet|software (?:development )?engineer in test|software test|test lead|test manager|lead qa|qa lead|qa automation|qa engineer|test analyst|quality engineer|test specialist|test consultant|test infrastructure|verification engineer|validation engineer)\b/i;

const TESTING_TERMS =
  /\b(test(?:ing|s|ed)?|quality assurance|qa|automation|automated|sdet|defect|bug|regression|exploratory|test cases?|test plans?|test strategy|test framework|release sign-?off|ci\/cd)\b/gi;

const AUTOMATION_TERMS =
  /\b(automation|automated tests?|test automation|playwright|cypress|selenium|appium|rest assured|pytest|testng|junit|framework|page objects?|scripting)\b/i;
const HANDS_ON_TERMS =
  /\b(manual|exploratory|regression|functional testing|test cases?|test execution|defect triage|bug reports?|acceptance testing|uat|smoke testing)\b/i;
const INFRA_TERMS =
  /\b(sdet|test infrastructure|test tooling|test framework|developer productivity|build system|internal tooling|ci\/cd pipeline|quality engineering platform)\b/i;
const LEADERSHIP_TERMS =
  /\b(qa lead|lead qa|head of (?:qa|quality)|qa manager|quality manager|test lead|test manager|engineering manager|director of quality)\b/i;
const MANAGEMENT_TERMS = /\b(test manager|quality manager|qa manager|head of (?:qa|quality))\b/i;
const CONSULTING_TERMS = /\b(consultant|consulting|client[- ]facing|client account|advisory|professional services)\b/i;
const PRODUCT_TERMS = /\b(product manager|product owner|program manager|project manager|business analyst|requirements engineer|product analyst)\b/i;
const ENGINEERING_TERMS = /\b(software engineer|backend engineer|front[- ]end engineer|full[- ]stack|developer|platform engineer|devops engineer|security engineer|data engineer|machine learning engineer|site reliability)\b/i;
const FINANCE_TERMS = /\b(fintech|bank|banking|payments?|trading|invoice|insurance|wealth|credit|ledger|financial)\b/i;

// A QA title in a laboratory or production environment is not a software QA
// vacancy. The software context must outweigh the non-software domain, so a
// LIMS mention inside a clinical laboratory posting does not qualify it.
const SOFTWARE_TERMS =
  /\b(software|application|web|api|mobile|ios|android|cloud|saas|backend|front[- ]end|database|sql|ci\/cd|test automation|playwright|selenium|appium|java|python|typescript|javascript|devops|microservice|platform|digital|agile|sprint|release)\b/gi;
const STRONG_SOFTWARE_TERMS =
  /\b(software|applications?|web|api|mobile|ios|android|cloud|saas|backend|front[- ]end|database|sql|ci\/cd|test automation|playwright|selenium|appium|java|python|typescript|javascript|devops|microservice)\b/gi;
const NON_SOFTWARE_TERMS =
  /\b(laborator(?:y|ies)?|chromatograph\w*|chemistry|chemical|pharmaceutical production|gmp|iso 13485|food|beverage|hospital|clinical|microbiolog\w*|production line|manufactur\w*|welding|machining|calibrat\w*|metrolog\w*|electronics|pcb|hardware)\b/gi;

const LANGUAGE_SENTENCE = /\b(german|deutsch|french|français|francais|english|englisch|anglais)\b/i;
const REQUIRED_SIGNAL =
  /\b(fluent|fluency|fließend|fliessend|native|mother tongue|muttersprache|required|mandatory|must|zwingend|minimum|ideally|[abc][12])\b/i;
const PREFERRED_SIGNAL =
  /\b(a plus|plus|advantage|advantageous|nice to have|desirable|optional|useful|von vorteil|wünschenswert|beneficial)\b/i;

const CERTIFICATIONS = [
  "ISTQB",
  "ISEB",
  "CSTE",
  "PMP",
  "Scrum Master",
  "AWS Certified",
  "Azure Certified",
  "Google Cloud Certified",
  "security clearance",
  "CISSP",
  "CISA",
];

function normalise(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[ \t\f\v]+/g, " ").toLowerCase();
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))].length;
}

/** Responsibility sentences that actually describe testing work. */
export function testingResponsibilities(description: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of normalise(description).split(/\n|•|(?<=[.!?;])\s+/)) {
    const line = raw.replace(/^[-*–—\s]+/, "").trim();
    if (line.length < 12 || line.length > 400) continue;
    if (!TESTING_TERMS.test(line)) continue;
    const key = line.replace(/\s+/g, " ").slice(0, 180);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line.slice(0, 300));
    if (out.length >= 8) break;
  }
  return out;
}

function languageRequirement(text: string): MandatoryRequirement[] {
  const out: MandatoryRequirement[] = [];
  for (const language of ["German", "French", "English"]) {
    const pattern = language === "German" ? /\b(german|deutsch)\b/i : language === "French" ? /\b(french|français|francais)\b/i : /\b(english|englisch|anglais)\b/i;
    for (const sentence of text.split(/\n|•|(?<=[.!?;])\s+/)) {
      if (!pattern.test(sentence)) continue;
      if (/\b(no|not|without|keine[n]?|nicht)\b[^.]{0,40}\b(required|needed|necessary|erforderlich)\b/i.test(sentence)) continue;
      if (PREFERRED_SIGNAL.test(sentence) && !/\b(required|mandatory|zwingend|must)\b/i.test(sentence)) continue;
      if (!REQUIRED_SIGNAL.test(sentence)) continue;
      const level = sentence.match(/\b(c1|c2|b2|b1)\b/i)?.[1]?.toUpperCase() ?? null;
      out.push({
        kind: "language",
        language,
        level,
        detail: `${language}${level ? ` ${level}` : ""} is mandatory: "${sentence.trim().slice(0, 180)}"`,
      });
      break;
    }
  }
  return out;
}

function preferenceLines(text: string): string[] {
  return text
    .split(/\n|•|(?<=[.!?;])\s+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 10 && PREFERRED_SIGNAL.test(line))
    .slice(0, 5)
    .map((line) => line.slice(0, 220));
}

function requirements(text: string, title: string): { mandatory: MandatoryRequirement[]; preferences: string[] } {
  const mandatory: MandatoryRequirement[] = [...languageRequirement(text)];

  const travel = text.match(/\b(?:up to\s*)?(\d{1,2})\s*%\s*(?:travel|reisen|déplacements|reisetätigkeit)\b/i);
  if (travel) mandatory.push({ kind: "travel", detail: `Travel of ${travel[1]}% is stated.` });
  else if (/\b(willing(?:ness)? to travel|travel (?:is )?required|reisebereitschaft)\b/i.test(text)) {
    mandatory.push({ kind: "travel", detail: "The posting requires willingness to travel." });
  }

  const onsiteDays = text.match(/\b(\d)\s*(?:\+\s*)?days?\s*(?:per week|a week|\/\s*week)\s*(?:in|at|on)[- ]?(?:the )?(?:office|site|zurich|geneva|basel|bern|lausanne)/i);
  if (onsiteDays) mandatory.push({ kind: "onsite", detail: `On-site attendance of ${onsiteDays[1]} day(s) per week is stated.` });
  else if (/\b(fully on-?site|100\s*%\s*(?:on-?site|office)|no remote(?: work)?)\b/i.test(text)) {
    mandatory.push({ kind: "onsite", detail: "The posting requires full on-site attendance." });
  }

  for (const cert of CERTIFICATIONS) {
    const needle = cert.toLowerCase();
    if (!text.includes(needle)) continue;
    const index = text.indexOf(needle);
    const context = text.slice(Math.max(0, index - 140), index + needle.length + 140);
    if (/\b(required|mandatory|must|zwingend|certified|certification)\b/i.test(context)) {
      mandatory.push({ kind: "certification", detail: `${cert} is stated as a requirement.` });
    }
  }

  if (/\b(line manage|manage a team|direct reports|lead a team of|people management|führungsverantwortung)\b/i.test(text)) {
    mandatory.push({ kind: "management", detail: "The role includes people-management responsibility." });
  }

  if (/\b(swiss (?:or eu|or eea) (?:citizens?|nationals?)|eu\/efta (?:citizens?|nationals?)|citizenship (?:is )?required|passport (?:is )?required)\b/i.test(text)) {
    mandatory.push({ kind: "authorisation", detail: "The posting restricts applicants to Swiss/EU citizens or nationals." });
  }
  if (/\b(no (?:visa )?sponsorship|without (?:visa )?sponsorship|sponsorship (?:is )?not (?:available|offered))\b/i.test(text)) {
    mandatory.push({ kind: "authorisation", detail: "The employer does not offer visa sponsorship." });
  }

  const domain = FINANCE_TERMS.exec(`${title}\n${text}`);
  if (domain) mandatory.push({ kind: "domain", detail: `Financial-services domain context: ${domain[0]}.` });

  return { mandatory, preferences: preferenceLines(text) };
}

const LABELS: Record<VacancyCategory, string> = {
  hands_on_testing: "Hands-on software testing",
  test_automation: "Test automation engineering",
  sdet_infrastructure: "SDET / test infrastructure",
  qa_leadership: "QA leadership",
  test_management: "Test management",
  consulting: "Consulting / client account leadership",
  software_engineering: "General software engineering",
  product_business_analysis: "Product management / business analysis",
  unclear: "Unclear from the posting",
};

export function classifyVacancy(input: ClassificationInput): VacancyClassification {
  const title = normalise(input.title ?? "");
  const description = normalise(input.description ?? "");
  const combined = `${title}\n${description}`;
  const qaTitle = QA_TITLE.test(input.title ?? "");
  const testHits = countMatches(combined, TESTING_TERMS);
  const testingIntensity = Math.min(1, Number((testHits / 7 + (qaTitle ? 0.4 : 0)).toFixed(2)));
  const responsibilities = testingResponsibilities(input.description ?? "");
  const signals: string[] = [];

  if (qaTitle) signals.push("QA/testing title");
  if (AUTOMATION_TERMS.test(combined)) signals.push("automation tooling");
  if (HANDS_ON_TERMS.test(combined)) signals.push("hands-on testing duties");
  if (INFRA_TERMS.test(combined)) signals.push("test infrastructure/framework work");
  if (LEADERSHIP_TERMS.test(combined)) signals.push("quality leadership title");
  if (CONSULTING_TERMS.test(combined)) signals.push("consulting/client wording");
  if (PRODUCT_TERMS.test(combined)) signals.push("product/business-analysis title");

  let category: VacancyCategory = "unclear";
  if (PRODUCT_TERMS.test(title)) category = "product_business_analysis";
  else if (MANAGEMENT_TERMS.test(title) || /\btest manager\b/i.test(title)) category = "test_management";
  else if (LEADERSHIP_TERMS.test(title)) category = "qa_leadership";
  else if (CONSULTING_TERMS.test(title)) category = "consulting";
  else if (/\bsdet\b/i.test(title) || INFRA_TERMS.test(title)) category = "sdet_infrastructure";
  else if (AUTOMATION_TERMS.test(title)) category = "test_automation";
  else if (HANDS_ON_TERMS.test(title) || qaTitle) category = "hands_on_testing";
  else if (ENGINEERING_TERMS.test(title)) category = "software_engineering";
  else if (INFRA_TERMS.test(combined) && testingIntensity >= 0.35) category = "sdet_infrastructure";
  else if (AUTOMATION_TERMS.test(combined) && testingIntensity >= 0.35) category = "test_automation";
  else if (testingIntensity >= 0.4) category = "hands_on_testing";

  const qaCategories: VacancyCategory[] = [
    "hands_on_testing",
    "test_automation",
    "sdet_infrastructure",
    "qa_leadership",
    "test_management",
  ];
  // A role is QA only when its title identifies QA/testing work. A security
  // engineer, program manager or account manager whose description mentions
  // testing is not a QA vacancy, however densely the word appears.
  const softwareHits = countMatches(combined, SOFTWARE_TERMS);
  const strongSoftwareHits = countMatches(combined, STRONG_SOFTWARE_TERMS);
  const nonSoftwareHits = countMatches(combined, NON_SOFTWARE_TERMS);
  // Positive evidence is required: absent laboratory wording is not enough.
  // A production quality engineer with no software signal is rejected, while a
  // short German software-QA posting still qualifies through its testing duties.
  const softwareContext =
    (nonSoftwareHits === 0 || softwareHits > nonSoftwareHits * 2) &&
    (strongSoftwareHits >= 2 || (softwareHits >= 1 && testingIntensity >= 0.5));
  const isQa = qaTitle && qaCategories.includes(category) && softwareContext;

  const { mandatory, preferences } = requirements(description, title);

  return {
    category,
    label: LABELS[category],
    isQa,
    testingIntensity,
    responsibilities,
    signals,
    mandatory,
    preferences,
    engine: "vacancy-classifier-v1",
  };
}

export function isQaClassification(value: VacancyClassification | null | undefined): boolean {
  return Boolean(value?.isQa);
}
