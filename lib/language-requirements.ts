/**
 * Deterministic language-requirement analysis.
 *
 * The candidate does not speak German, so any vacancy that requires German at
 * any level is ineligible. This module is the single authority for that rule:
 * discovery, classification, scoring, readiness and submission all call it, so
 * a posting cannot be admitted by one path while another path excludes it.
 *
 * A mention is only treated as mandatory when the posting actually requires the
 * language. "German is an advantage" is not a requirement. A bare mention such
 * as "German-speaking team" is ambiguous, not optional: the application is held
 * for review rather than submitted on an assumption.
 */

export type GermanRequirementStatus = "required" | "optional" | "ambiguous" | "absent" | "unknown";

export const MANDATORY_GERMAN_REQUIREMENT = "MANDATORY_GERMAN_REQUIREMENT";
export const GERMAN_REQUIREMENT_UNRESOLVED = "GERMAN_REQUIREMENT_UNRESOLVED";

export type GermanRequirementAssessment = {
  status: GermanRequirementStatus;
  level: string | null;
  evidence: string[];
  detail: string;
  reasonCode: typeof MANDATORY_GERMAN_REQUIREMENT | typeof GERMAN_REQUIREMENT_UNRESOLVED | null;
};

const GERMAN =
  /\b(?:german|deutsch(?:e|en|er|es|kenntnisse|kenntnissen|sprachig\w*)?|deutschsprachig\w*)\b/i;

const NEGATED =
  /\b(?:no|not|without|kein(?:e|en|em|er)?|nicht)\b[^.\n]{0,60}\b(?:german|deutsch\w*)\b|\b(?:german|deutsch\w*)\b[^.\n]{0,60}\b(?:not|nicht|kein(?:e|en)?|n't)\b[^.\n]{0,30}\b(?:required|needed|necessary|erforderlich|vorausgesetzt)\b/i;

const OPTIONAL =
  /\b(?:a plus|advantage|advantageous|nice to have|desirable|optional|beneficial|useful|asset|von vorteil|wuenschenswert|wünschenswert|will be considered)\b/i;

const SOFT =
  /\b(?:preferred|ideally|wunsch|wünsch|would be helpful|helpful)\b/i;

const EXPLICIT_REQUIRED =
  /\b(?:required|requirement|mandatory|must|essential|necessary|obligatory|zwingend|erforderlich|vorausgesetzt|benoetigt|benötigt|notwendig|unerlaesslich|unerlässlich|verlangt|erwartet|voraussetzung|bedingung)\b/i;

const LEVEL = /\b(?:a1|a2|b1|b2|c1|c2)\b/i;

const PROFICIENCY =
  /\b(?:fluent|fluency|fliessend|fließend|native|mother tongue|muttersprache|business fluent|verhandlungssicher|conversational|conversation|intermediate|elementary|basic|beginner|professional|business|working|good|very good|solid|excellent|strong|proficient|proficiency|confident(?:ly)?|kenntnisse|knowledge|sprachkenntnisse|deutschkenntnisse|sehr gute|gute|guter|gutes|ausgezeichnete|perfekte)\b/i;

const CERTIFICATION =
  /\b(?:certificate|certification|certified|goethe|testdaf|telc|dsh|zertifikat|zertifiziert|sprachzertifikat)\b/i;

const SPEAKING = /\b(?:german[- ]speaking|deutschsprachig\w*)\b/i;

function sentences(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n|•|(?<=[.!?;])\s+/)
    .map((line) => line.replace(/^[-*–—\s]+/, "").trim())
    .filter(Boolean);
}

/**
 * Classify a vacancy's German requirement from its title and description.
 *
 * `unknown` is returned when no usable vacancy text exists. It is deliberately
 * unresolved rather than "absent": a missing description cannot prove that
 * German is not required, so the candidate must not be submitted automatically.
 */
export function analyseGermanRequirement(text: string): GermanRequirementAssessment {
  const normalised = text.replace(/\r\n?/g, "\n").replace(/[ \t\f\v]+/g, " ").trim();
  if (normalised.length < 20) {
    return {
      status: "unknown",
      level: null,
      evidence: [],
      detail: "No usable vacancy text is available, so a German requirement cannot be excluded.",
      reasonCode: GERMAN_REQUIREMENT_UNRESOLVED,
    };
  }

  const evidence: string[] = [];
  let level: string | null = null;
  let sawGerman = false;
  let sawOptional = false;
  let sawAmbiguous = false;

  for (const sentence of sentences(normalised)) {
    if (!GERMAN.test(sentence)) continue;
    sawGerman = true;
    const quote = sentence.slice(0, 220);

    // "German is not required", "keine Deutschkenntnisse erforderlich".
    if (NEGATED.test(sentence)) {
      evidence.push(quote);
      sawOptional = true;
      continue;
    }

    // "German is an advantage" is not a requirement. An explicit requirement
    // word or a CEFR level in the same sentence still wins.
    if (OPTIONAL.test(sentence) && !EXPLICIT_REQUIRED.test(sentence) && !LEVEL.test(sentence)) {
      evidence.push(quote);
      sawOptional = true;
      continue;
    }

    if (EXPLICIT_REQUIRED.test(sentence) || LEVEL.test(sentence) || CERTIFICATION.test(sentence)) {
      evidence.push(quote);
      level = level ?? sentence.match(LEVEL)?.[0]?.toUpperCase() ?? null;
      return {
        status: "required",
        level,
        evidence,
        detail: `German${level ? ` ${level}` : ""} is mandatory: "${quote}"`,
        reasonCode: MANDATORY_GERMAN_REQUIREMENT,
      };
    }

    if (PROFICIENCY.test(sentence)) {
      evidence.push(quote);
      level = level ?? sentence.match(LEVEL)?.[0]?.toUpperCase() ?? null;
      return {
        status: "required",
        level,
        evidence,
        detail: `German${level ? ` ${level}` : ""} is mandatory: "${quote}"`,
        reasonCode: MANDATORY_GERMAN_REQUIREMENT,
      };
    }

    // Soft wording ("ideally", "preferred") or a bare mention such as a
    // German-speaking team. The requirement cannot be resolved from the text.
    sawAmbiguous = true;
    evidence.push(quote);
    if (SOFT.test(sentence)) sawAmbiguous = true;
    if (SPEAKING.test(sentence)) sawAmbiguous = true;
  }

  if (!sawGerman) {
    return {
      status: "absent",
      level: null,
      evidence: [],
      detail: "No German requirement is stated.",
      reasonCode: null,
    };
  }

  if (sawAmbiguous) {
    return {
      status: "ambiguous",
      level,
      evidence,
      detail: `German is mentioned but the requirement could not be resolved: "${evidence[0] ?? "German mention"}"`,
      reasonCode: GERMAN_REQUIREMENT_UNRESOLVED,
    };
  }

  if (sawOptional) {
    return {
      status: "optional",
      level,
      evidence,
      detail: `German is mentioned only as optional: "${evidence[0] ?? "German mention"}"`,
      reasonCode: null,
    };
  }

  return {
    status: "ambiguous",
    level,
    evidence,
    detail: `German is mentioned but the requirement could not be resolved: "${evidence[0] ?? "German mention"}"`,
    reasonCode: GERMAN_REQUIREMENT_UNRESOLVED,
  };
}

/**
 * Vacancy-level wrapper. A missing description cannot prove German absent, so
 * it returns `unknown` even when the title happens to mention no language.
 */
export function analyseVacancyGermanRequirement(
  title: string,
  description: string | null | undefined,
): GermanRequirementAssessment {
  if (!description || description.trim().length < 20) {
    return {
      status: "unknown",
      level: null,
      evidence: [],
      detail: "No usable vacancy description is stored, so a German requirement cannot be excluded.",
      reasonCode: GERMAN_REQUIREMENT_UNRESOLVED,
    };
  }
  return analyseGermanRequirement(`${title}\n${description}`);
}

/** True when the posting must never be scored, prepared or submitted. */
export function isGermanRequired(assessment: GermanRequirementAssessment): boolean {
  return assessment.status === "required";
}

/** True when an automatic submission must stop until the wording is resolved. */
export function germanRequirementBlocksSubmission(assessment: GermanRequirementAssessment): boolean {
  return assessment.status === "required" || assessment.status === "ambiguous" || assessment.status === "unknown";
}
