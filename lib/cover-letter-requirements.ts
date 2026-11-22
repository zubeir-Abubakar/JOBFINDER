/**
 * Recruiter-aware cover-letter limits.
 *
 * A fixed 180–320 word target is a professional default, not an employer
 * requirement. This module extracts only explicit word/character limits from
 * the vacancy text, keeps the exact source evidence with the constraint, and
 * never attributes the internal default to a recruiter.
 */

export type CoverLetterRequirementSource = "recruiter" | "professional_default";

export type CoverLetterRequirements = {
  source: CoverLetterRequirementSource;
  explicit: boolean;
  minWords: number | null;
  maxWords: number | null;
  minCharacters: number | null;
  maxCharacters: number | null;
  /** Explicit maximum rendered pages, if the recruiter stated one. */
  maxPages: number | null;
  /** Explicit file formats, normalised to pdf/docx. */
  formats: string[];
  /** Explicitly requested supporting documents that this package does not create. */
  supportingDocuments: string[];
  /** Ambiguous extractions that require human verification before submission. */
  uncertain: string[];
  /** Exact excerpts from the vacancy that produced the constraint. */
  evidence: string[];
  /** Contradictory recruiter instructions that must block generation. */
  conflicts: string[];
  sourceUrl?: string | null;
  retrievedAt?: string | null;
};

export type CoverLetterLike = {
  salutation: string;
  paragraphs: string[];
  closing: string;
};

export type CoverLetterMeasurement = {
  body: string;
  words: number;
  characters: number;
};

export type CoverLetterLengthIssue = {
  code: "too_short" | "too_long" | "characters_below_minimum" | "characters_above_maximum" | "conflicting_limits";
  message: string;
};

export const PROFESSIONAL_MIN_COVER_LETTER_WORDS = 180;
export const PROFESSIONAL_MAX_COVER_LETTER_WORDS = 320;

const KEYWORD =
  /\b(?:cover(?:ing)?\s+letter|application\s+letter|letter\s+of\s+motivation|motivation\s+letter|anschreiben|begleitschreiben|motivationsschreiben)\b/gi;
const WORD_UNIT = "(?:words?|w[oö]rter|worten)";
const CHARACTER_UNIT = "(?:characters?|chars?|zeichen)";
const NUMBER = "([0-9][0-9.,'’\\u202f\\s]{0,8})";
const MAX_CUE =
  "(?:maximum(?:\\s+of)?|max\\.?|up\\s+to|no\\s+more\\s+than|not\\s+(?:to\\s+)?exceed|at\\s+most|limited\\s+to|limit(?:ed)?\\s+to|within|under|below|less\\s+than)";
const MIN_CUE =
  "(?:minimum(?:\\s+of)?|min\\.?|at\\s+least|no\\s+(?:fewer|less)\\s+than|not\\s+(?:fewer|less)\\s+than)";

function normaliseSpace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function toCount(raw: string): number | null {
  let value = raw.replace(/[\s\u202f'’]/g, "");
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(value)) value = value.replace(/[.,]/g, "");
  else value = value.replace(",", ".");
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.round(parsed);
  return rounded > 0 ? rounded : null;
}

function evidenceAt(text: string, index: number, length: number): string {
  const start = Math.max(0, text.lastIndexOf("\n", index) + 1, text.lastIndexOf(". ", index) + 2);
  const newlineEnd = text.indexOf("\n", index + length);
  const sentenceEnd = text.indexOf(". ", index + length);
  const candidates = [newlineEnd, sentenceEnd].filter((value) => value >= 0);
  const end = candidates.length > 0 ? Math.min(...candidates) + 1 : Math.min(text.length, index + length + 160);
  return normaliseSpace(text.slice(start, end)).slice(0, 400);
}

function validWords(value: number): boolean {
  return value >= 20 && value <= 5_000;
}

function validCharacters(value: number): boolean {
  return value >= 80 && value <= 50_000;
}

type Candidate = {
  minWords?: number;
  maxWords?: number;
  minCharacters?: number;
  maxCharacters?: number;
  maxPages?: number;
  evidence: string;
  start?: number;
  length?: number;
};

function matchesFor(text: string): Candidate[] {
  const candidates: Candidate[] = [];
  const add = (candidate: Candidate) => {
    if (candidate.evidence) candidates.push(candidate);
  };

  const rangePatterns: Array<{ unit: string; kind: "words" | "characters" }> = [
    { unit: WORD_UNIT, kind: "words" },
    { unit: CHARACTER_UNIT, kind: "characters" },
  ];
  for (const { unit, kind } of rangePatterns) {
    const pattern = new RegExp(`${NUMBER}\\s*(?:-|–|—|to|and)\\s*${NUMBER}\\s*${unit}`, "gi");
    for (const match of text.matchAll(pattern)) {
      const first = toCount(match[1]);
      const second = toCount(match[2]);
      if (first === null || second === null) continue;
      const min = Math.min(first, second);
      const max = Math.max(first, second);
      if (kind === "words" && (!validWords(min) || !validWords(max))) continue;
      if (kind === "characters" && (!validCharacters(min) || !validCharacters(max))) continue;
      add({
        ...(kind === "words" ? { minWords: min, maxWords: max } : { minCharacters: min, maxCharacters: max }),
        evidence: evidenceAt(text, match.index ?? 0, match[0].length),
        start: match.index ?? 0,
        length: match[0].length,
      });
    }
  }

  const pageNumber = "(one|two|three|four|five|1|2|3|4|5)";
  const pageWord: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
  const pagePatterns = [
    new RegExp(`${MAX_CUE}\\s*${pageNumber}\\s*(?:pages?|seiten)`, "gi"),
    new RegExp(`${pageNumber}\\s*(?:pages?|seiten)\\s*(?:max(?:imum)?|or\\s+(?:fewer|less)|limit)`, "gi"),
  ];
  for (const pattern of pagePatterns) {
    for (const match of text.matchAll(pattern)) {
      const value = pageWord[match[1].toLowerCase()] ?? toCount(match[1]);
      if (value === null || value < 1 || value > 10) continue;
      add({ maxPages: value, evidence: evidenceAt(text, match.index ?? 0, match[0].length) });
    }
  }

  for (const { unit, kind } of rangePatterns) {
    const maxBefore = new RegExp(`${MAX_CUE}\\s*${NUMBER}\\s*${unit}`, "gi");
    for (const match of text.matchAll(maxBefore)) {
      const value = toCount(match[1]);
      if (value === null) continue;
      if (kind === "words" && !validWords(value)) continue;
      if (kind === "characters" && !validCharacters(value)) continue;
      add({
        ...(kind === "words" ? { maxWords: value } : { maxCharacters: value }),
        evidence: evidenceAt(text, match.index ?? 0, match[0].length),
        start: match.index ?? 0,
        length: match[0].length,
      });
    }

    const maxAfter = new RegExp(`${NUMBER}\\s*${unit}\\s*(?:max(?:imum)?|or\\s+(?:fewer|less)|or\\s+under|limit)`, "gi");
    for (const match of text.matchAll(maxAfter)) {
      const value = toCount(match[1]);
      if (value === null) continue;
      if (kind === "words" && !validWords(value)) continue;
      if (kind === "characters" && !validCharacters(value)) continue;
      add({
        ...(kind === "words" ? { maxWords: value } : { maxCharacters: value }),
        evidence: evidenceAt(text, match.index ?? 0, match[0].length),
        start: match.index ?? 0,
        length: match[0].length,
      });
    }

    const minBefore = new RegExp(`${MIN_CUE}\\s*${NUMBER}\\s*${unit}`, "gi");
    for (const match of text.matchAll(minBefore)) {
      const value = toCount(match[1]);
      if (value === null) continue;
      if (kind === "words" && !validWords(value)) continue;
      if (kind === "characters" && !validCharacters(value)) continue;
      add({
        ...(kind === "words" ? { minWords: value } : { minCharacters: value }),
        evidence: evidenceAt(text, match.index ?? 0, match[0].length),
        start: match.index ?? 0,
        length: match[0].length,
      });
    }
  }

  return candidates;
}

export function professionalCoverLetterRequirements(): CoverLetterRequirements {
  return {
    source: "professional_default",
    explicit: false,
    minWords: PROFESSIONAL_MIN_COVER_LETTER_WORDS,
    maxWords: PROFESSIONAL_MAX_COVER_LETTER_WORDS,
    minCharacters: null,
    maxCharacters: null,
    maxPages: null,
    formats: [],
    supportingDocuments: [],
    uncertain: [],
    evidence: [],
    conflicts: [],
  };
}

/**
 * Extracts explicit limits only from the neighbourhood of a cover-letter
 * instruction. A generic "five years" or unrelated page limit is not a letter
 * length requirement and is deliberately ignored.
 */
export function extractCoverLetterRequirements(
  description: string | null | undefined,
  meta: { sourceUrl?: string | null; retrievedAt?: string | null } = {},
): CoverLetterRequirements {
  const text = String(description ?? "");
  if (!text.trim()) return professionalCoverLetterRequirements();
  const candidates: Candidate[] = [];
  const formatSet = new Set<string>();
  const supporting = new Set<string>();
  const uncertain: string[] = [];
  const seenWindows = new Set<string>();
  for (const keyword of text.matchAll(KEYWORD)) {
    const index = keyword.index ?? 0;
    const start = Math.max(0, index - 300);
    const end = Math.min(text.length, index + 800);
    const window = text.slice(start, end);
    const key = `${Math.floor(start / 300)}:${window.slice(0, 80)}`;
    if (seenWindows.has(key)) continue;
    seenWindows.add(key);
    for (const format of window.matchAll(/\b(?:file\s+format|format|submit(?:ted)?|upload(?:ed)?|send|attach(?:ed)?|only|must\s+be)\s*[:\-]?\s*(?:as\s+)?(?:an?\s+)?(?:in\s+)?(PDF|DOCX?|Microsoft\s+Word|Word)\b/gi)) {
      const value = format[1].toLowerCase();
      formatSet.add(value.includes("word") || value.startsWith("doc") ? "docx" : "pdf");
    }
    for (const format of window.matchAll(/\b(PDF|DOCX?)\s+(?:format|file)\b/gi)) {
      formatSet.add(format[1].toLowerCase().startsWith("doc") ? "docx" : "pdf");
    }
    for (const required of window.matchAll(/\b(?:must|required|please|should)\s+(?:also\s+)?(?:provide|include|submit|attach|send)\s+(?:a\s+|your\s+)?(?:\d+\s+)?(reference(?:s|\s+letters?)?|certificates?|portfolio|work\s+permit|diploma|degree\s+certificate)\b/gi)) {
      supporting.add(normaliseSpace(required[1]).toLowerCase());
    }
    for (const required of window.matchAll(/\b(references?|portfolio)\s+(?:are\s+|is\s+)?(?:required|mandatory)\b/gi)) {
      supporting.add(required[1].toLowerCase());
    }
    for (const candidate of matchesFor(window)) {
      // Preserve the exact match position. Re-searching for the normalised
      // evidence would lose the location when the source uses line breaks or
      // multiple spaces, leaving provenance attached to the wrong sentence.
      const localStart = candidate.start ?? 0;
      candidates.push({
        ...candidate,
        evidence: evidenceAt(text, start + localStart, candidate.length ?? candidate.evidence.length),
      });
    }
  }

  if (candidates.length === 0 && formatSet.size === 0 && supporting.size === 0) {
    return {
      ...professionalCoverLetterRequirements(),
      ...(meta.sourceUrl !== undefined ? { sourceUrl: meta.sourceUrl } : {}),
      ...(meta.retrievedAt !== undefined ? { retrievedAt: meta.retrievedAt } : {}),
    };
  }

  const maxWords = candidates.map((item) => item.maxWords).filter((value): value is number => value !== undefined);
  const minWords = candidates.map((item) => item.minWords).filter((value): value is number => value !== undefined);
  const maxCharacters = candidates
    .map((item) => item.maxCharacters)
    .filter((value): value is number => value !== undefined);
  const minCharacters = candidates
    .map((item) => item.minCharacters)
    .filter((value): value is number => value !== undefined);
  const pageLimits = candidates
    .map((item) => item.maxPages)
    .filter((value): value is number => value !== undefined);
  const chosenMaxWords = maxWords.length > 0 ? Math.min(...maxWords) : null;
  const chosenMinWords = minWords.length > 0 ? Math.max(...minWords) : null;
  const chosenMaxCharacters = maxCharacters.length > 0 ? Math.min(...maxCharacters) : null;
  const chosenMinCharacters = minCharacters.length > 0 ? Math.max(...minCharacters) : null;
  const chosenMaxPages = pageLimits.length > 0 ? Math.min(...pageLimits) : null;
  if (new Set(pageLimits).size > 1) {
    uncertain.push(`The vacancy states more than one cover-letter page limit (${[...new Set(pageLimits)].join(", ")}); the strictest was retained.`);
  }
  const conflicts: string[] = [];
  if (chosenMinWords !== null && chosenMaxWords !== null && chosenMinWords > chosenMaxWords) {
    conflicts.push(`The vacancy states a minimum of ${chosenMinWords} words and a maximum of ${chosenMaxWords}.`);
  }
  if (chosenMinCharacters !== null && chosenMaxCharacters !== null && chosenMinCharacters > chosenMaxCharacters) {
    conflicts.push(
      `The vacancy states a minimum of ${chosenMinCharacters} characters and a maximum of ${chosenMaxCharacters}.`,
    );
  }
  return {
    source: "recruiter",
    explicit: true,
    minWords: chosenMinWords,
    maxWords: chosenMaxWords,
    minCharacters: chosenMinCharacters,
    maxCharacters: chosenMaxCharacters,
    maxPages: chosenMaxPages,
    formats: [...formatSet],
    supportingDocuments: [...supporting],
    uncertain,
    evidence: [...new Set(candidates.map((item) => item.evidence))].slice(0, 6),
    conflicts,
    ...(meta.sourceUrl !== undefined ? { sourceUrl: meta.sourceUrl } : {}),
    ...(meta.retrievedAt !== undefined ? { retrievedAt: meta.retrievedAt } : {}),
  };
}

function parsePersisted(value: unknown): CoverLetterRequirements | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const source = record.source === "recruiter" || record.source === "professional_default" ? record.source : null;
  if (!source) return null;
  const numberOrNull = (input: unknown) =>
    typeof input === "number" && Number.isFinite(input) && input > 0 ? Math.round(input) : null;
  return {
    source,
    explicit: source === "recruiter" || record.explicit === true,
    minWords: numberOrNull(record.minWords),
    maxWords: numberOrNull(record.maxWords),
    minCharacters: numberOrNull(record.minCharacters),
    maxCharacters: numberOrNull(record.maxCharacters),
    maxPages: numberOrNull(record.maxPages),
    formats: Array.isArray(record.formats)
      ? record.formats.filter((item): item is string => item === "pdf" || item === "docx").slice(0, 4)
      : [],
    supportingDocuments: Array.isArray(record.supportingDocuments)
      ? record.supportingDocuments.filter((item): item is string => typeof item === "string").slice(0, 6)
      : [],
    uncertain: Array.isArray(record.uncertain)
      ? record.uncertain.filter((item): item is string => typeof item === "string").slice(0, 4)
      : [],
    evidence: Array.isArray(record.evidence)
      ? record.evidence.filter((item): item is string => typeof item === "string").slice(0, 6)
      : [],
    conflicts: Array.isArray(record.conflicts)
      ? record.conflicts.filter((item): item is string => typeof item === "string").slice(0, 4)
      : [],
    sourceUrl: typeof record.sourceUrl === "string" ? record.sourceUrl : null,
    retrievedAt: typeof record.retrievedAt === "string" ? record.retrievedAt : null,
  };
}

/**
 * Prefers the constraint stored at discovery time. If an older vacancy has no
 * persisted constraint, the original description is parsed instead. A newly
 * discovered explicit recruiter limit wins over a stale persisted default.
 */
export function resolveCoverLetterRequirements(input: {
  description: string | null | undefined;
  requirementsJson?: string | null;
  sourceUrl?: string | null;
  retrievedAt?: string | null;
}): CoverLetterRequirements {
  const extracted = extractCoverLetterRequirements(input.description, {
    sourceUrl: input.sourceUrl,
    retrievedAt: input.retrievedAt,
  });
  if (!input.requirementsJson) return extracted;
  try {
    const parsed = JSON.parse(input.requirementsJson) as Record<string, unknown>;
    const persisted = parsePersisted(parsed.coverLetter);
    if (!persisted) return extracted;
    if (extracted.source === "recruiter" && persisted.source !== "recruiter") return extracted;
    return persisted;
  } catch {
    return extracted;
  }
}

export function coverLetterBody(content: CoverLetterLike): string {
  return normaliseSpace(
    [content.salutation, ...content.paragraphs, content.closing].map((part) => String(part ?? "")).join(" "),
  );
}

export function measureCoverLetterText(text: string): CoverLetterMeasurement {
  const body = normaliseSpace(String(text ?? ""));
  return {
    body,
    words: body.split(/\s+/).filter(Boolean).length,
    // Count Unicode code points, not UTF-16 units; a recruiter's character
    // limit must not be silently inflated by an emoji or a decomposed accent.
    characters: Array.from(body).length,
  };
}

export function measureCoverLetter(content: CoverLetterLike): CoverLetterMeasurement {
  return measureCoverLetterText(coverLetterBody(content));
}

/**
 * Extracts the actual letter body from a rendered document. The header, date
 * and contact block are not part of the recruiter's word limit; the salutation,
 * body and closing are.
 */
export function letterBodyFromRenderedText(text: string): string {
  const normalised = normaliseSpace(String(text ?? ""));
  const startMatch = normalised.match(/\b(?:Dear\b|Sehr geehrte|Bonjour|Gentile)/i);
  if (!startMatch || startMatch.index === undefined) return normalised;
  const afterStart = normalised.slice(startMatch.index);
  const closingMatch = afterStart.match(
    /\b(?:Sincerely|Kind regards|Best regards|Yours faithfully|Yours sincerely|Mit freundlichen Grüssen|Mit freundlichen Grüßen|Cordialement)\b[^.!?]{0,80}[.!]?/i,
  );
  if (!closingMatch || closingMatch.index === undefined) return afterStart;
  return normaliseSpace(afterStart.slice(0, closingMatch.index + closingMatch[0].length));
}

export function coverLetterLengthIssues(
  measurement: CoverLetterMeasurement,
  requirements: CoverLetterRequirements,
): CoverLetterLengthIssue[] {
  const issues: CoverLetterLengthIssue[] = [];
  if (requirements.conflicts.length > 0) {
    issues.push({
      code: "conflicting_limits",
      message: `The recruiter's cover-letter instructions conflict: ${requirements.conflicts.join(" ")}`,
    });
  }
  if (requirements.minWords !== null && measurement.words < requirements.minWords) {
    issues.push({
      code: "too_short",
      message:
        requirements.source === "recruiter"
          ? `The recruiter requires at least ${requirements.minWords} words; the rendered letter has ${measurement.words}.`
          : `The rendered letter has ${measurement.words} words; the professional default is at least ${requirements.minWords} (no recruiter minimum was stated).`,
    });
  }
  if (requirements.maxWords !== null && measurement.words > requirements.maxWords) {
    issues.push({
      code: "too_long",
      message:
        requirements.source === "recruiter"
          ? `The recruiter requires at most ${requirements.maxWords} words; the rendered letter has ${measurement.words}.`
          : `The rendered letter has ${measurement.words} words; the professional default is at most ${requirements.maxWords} (no recruiter maximum was stated).`,
    });
  }
  if (requirements.minCharacters !== null && measurement.characters < requirements.minCharacters) {
    issues.push({
      code: "characters_below_minimum",
      message: `The recruiter requires at least ${requirements.minCharacters} characters; the rendered letter has ${measurement.characters}.`,
    });
  }
  if (requirements.maxCharacters !== null && measurement.characters > requirements.maxCharacters) {
    issues.push({
      code: "characters_above_maximum",
      message: `The recruiter requires at most ${requirements.maxCharacters} characters; the rendered letter has ${measurement.characters}.`,
    });
  }
  return issues;
}
