import type { ProfileData } from "./profile";
import {
  analyseVacancyGermanRequirement,
  MANDATORY_GERMAN_REQUIREMENT,
  type GermanRequirementAssessment,
  type GermanRequirementStatus,
} from "./language-requirements";

/**
 * Deterministic eligibility rules for a vacancy.
 *
 * The owner holds a Swiss Permit B (valid to Feb 2028) and needs no employer
 * sponsorship. Eligibility therefore asks a different question from match
 * scoring: may this person lawfully apply for this vacancy at all? The answers
 * are evidence-based and never inferred from a model's opinion.
 */

export type EligibilityStatus = "eligible" | "ineligible" | "needs_review";

export type EligibilityAssessment = {
  status: EligibilityStatus;
  swissResidency: "yes" | "no" | "unclear";
  sponsorshipRequired: "no" | "yes" | "unclear";
  germanRequired: boolean;
  /** resolved German requirement, including its evidence */
  germanStatus: GermanRequirementStatus;
  germanEvidence: string[];
  germanLevel: string | null;
  germanReasonCode: string | null;
  frenchRequired: boolean;
  applicationOpen: boolean;
  reasons: string[];
  blockers: string[];
  workAuthorisationNote: string;
  languagesNote: string;
  checkedAt: string;
  engine: string;
};

export type EligibilityJob = {
  title: string;
  company: string;
  location: string | null;
  description: string | null;
  remote: number | boolean;
  application_url?: string | null;
  url?: string | null;
  published_at?: string | null;
  employment_type?: string | null;
  /** Persisted discovery evidence, including structured source languages. */
  german_requirement?: string | null;
  language_evidence?: string | null;
};

const SWISS =
  /(switzerland|schweiz|suisse|svizzera|swiss|zurich|zürich|geneva|genève|geneve|lausanne|bern|basel|zug|luzern|lucerne|winterthur|st\.?\s*gallen|lugano|fribourg|vaud|ticino|neuch|bienne|biel|thun|olten|aarau|schaffhausen|sion|chur|emmen|bonaduz|altdorf|nidau|sarnen|bellach|puidoux|burgdorf|d[üu]bendorf|manno|reinach|d[äa]llikon|kreuzlingen|moosseedorf|zollikofen|wohlen|\bch\b)/i;
// "Remote" on its own is not residency eligibility: a posting must explicitly
// accept Europe/EEA/global applicants, which is the distinction the brief calls out.
const EUROPE_OPEN = /\b(eu\/efta|european union|europe|eea|emea|dach|worldwide|anywhere|global(?:ly)?|international)\b/i;
const REGION_SCOPE = /\b(switzerland|swiss|europe|european union|eu|eea|emea|dach|worldwide|anywhere|global(?:ly)?)\b/i;
// Only an explicit remote/work-from statement tied to a region proves that a
// vacancy is open to Swiss-based applicants. A marketing line such as "100
// million downloads worldwide" is not residency evidence.
const REMOTE_SCOPE =
  /\b(?:remote|work from home|home[- ]office|telecommut\w*|distributed)\b[^.\n]{0,90}\b(?:switzerland|swiss|europe|european union|eu|eea|emea|dach|worldwide|anywhere|global(?:ly)?)\b|\b(?:open|available|eligible|accepts?)\b[^.\n]{0,80}\b(?:candidates?|applicants?|residents?)?\b[^.\n]{0,40}\b(?:switzerland|swiss|europe|european union|eu|eea|emea|dach)\b/i;
const FOREIGN_ONSITE =
  /\b(?:fully onsite|fully on-site|fully office|office[- ]based|based at our office|work from (?:our|the) office)\b/i;
const FOREIGN_ONSITE_CITY =
  /\b(?:fully onsite|fully on-site|fully office|office[- ]based|based at our office|work from (?:our|the) office)\b[^.\n]{0,100}\b(?:in|at)\s+(?:our\s+)?(?:office\s+in\s+)?(?:lisbon|berlin|london|paris|madrid|rome|dublin|barcelona|amsterdam|copenhagen|stockholm|munich|san francisco|new york|boston|austin|toronto|warsaw|krakow|prague|budapest|bucharest|sofia|athens|milan|brussels|vienna)\b/i;
const SWISS_RESIDENTS = /\b(swiss (?:residents?|based|candidates?)|residents? of switzerland|based in switzerland|switzerland[- ]based|eligible to work in switzerland)\b/i;
const CITIZENSHIP_ONLY = /\b(swiss (?:or eu|or eea) (?:citizens?|nationals?)|eu\/efta (?:citizens?|nationals?)|citizenship (?:is )?required|passport (?:is )?required|only (?:swiss|eu) (?:citizens?|nationals?))\b/i;
const NO_SPONSORSHIP = /\b(no (?:visa )?sponsorship|without (?:visa )?sponsorship|sponsorship (?:is )?not (?:available|offered)|cannot sponsor|unable to sponsor)\b/i;
const RESTRICTED_COUNTRY =
  /\b(?:(?:must|need to|required to) (?:be )?(?:based|reside|live|located) in|(?:restricted|limited|open only) to (?:candidates|applicants|residents)?\s*(?:based |residing |living )?in) ([a-z ,/&-]{3,60})\b/i;
const FRENCH_LANGUAGE = /\b(french|français|francais)\b/i;
const REQUIRED_SIGNAL =
  /\b(fluent|fluency|fließend|fliessend|native|mother tongue|muttersprache|required|mandatory|must|zwingend|minimum|ideally|[abc][12])\b/i;
const PREFERRED_SIGNAL = /\b(a plus|plus|advantage|advantageous|nice to have|desirable|optional|useful|von vorteil|wünschenswert|beneficial)\b/i;

function normalise(value: string): string {
  // Newlines are structural: collapsing them merges separate bullets into one
  // "sentence", which lets a distant "a plus" bullet cancel a mandatory
  // language requirement stated in another bullet.
  return value.replace(/\r\n?/g, "\n").replace(/[ \t\f\v]+/g, " ").toLowerCase();
}

/** True when one sentence makes the language mandatory (not "a plus"). */
function languageMandatory(text: string, language: RegExp): { required: boolean; level: string | null } {
  for (const sentence of text.split(/\n|•|(?<=[.!?;])\s+/)) {
    if (!language.test(sentence)) continue;
    if (/\b(no|not|without|keine[n]?|nicht)\b[^.]{0,40}\b(required|needed|necessary|erforderlich)\b/i.test(sentence)) continue;
    if (PREFERRED_SIGNAL.test(sentence) && !/\b(required|mandatory|zwingend|must)\b/i.test(sentence)) continue;
    if (!REQUIRED_SIGNAL.test(sentence)) continue;
    const level = sentence.match(/\b(c1|c2|b2|b1)\b/i)?.[1]?.toUpperCase() ?? null;
    return { required: true, level };
  }
  return { required: false, level: null };
}

function applicationDeadlinePassed(text: string, now: Date): boolean {
  const match = text.match(/(?:apply (?:before|by)|application deadline|closing date|deadline)[^.\n]{0,40}?(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/i);
  if (!match) return false;
  const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
  const deadline = new Date(Date.UTC(year, Number(match[2]) - 1, Number(match[1]), 23, 59, 59));
  return Number.isFinite(deadline.getTime()) && deadline.getTime() < now.getTime();
}

export function assessEligibility(job: EligibilityJob, profile: ProfileData, now: Date = new Date()): EligibilityAssessment {
  const description = normalise(job.description ?? "");
  const combined = normalise(
    [job.title, job.company, job.location ?? "", job.description ?? "", job.employment_type ?? ""].join("\n"),
  );
  const locationText = normalise(job.location ?? "");
  const remote = Boolean(job.remote);
  const reasons: string[] = [];
  const blockers: string[] = [];

  const permit = profile.profile.work_authorisation ?? "";
  const permitEvidenced = /permit\s*b|swiss permit|authoris(?:ed|ation) to work|authoriz(?:ed|ation) to work/i.test(permit);
  const permitValidUntil = profile.profile.permit_valid_until ?? null;

  // 1. Swiss residency / remote country restrictions.
  let swissResidency: EligibilityAssessment["swissResidency"] = "unclear";
  const swissInDescription = SWISS.test(combined);
  const explicitlySwissResidents = SWISS_RESIDENTS.test(combined);
  // A stated foreign location must not be overridden by a Swiss mention in the
  // employer's marketing copy (e.g. "live in 38 markets including Switzerland").
  // The description is only used when the posting states no usable location.
  const locationStated = Boolean(job.location && !/^\s*(not specified|unknown|n\/a)\s*$/i.test(job.location));
  // A source's location label can be wrong: "Zurich" listings from one board
  // state "fully onsite, based at our office in Lisbon" in the body. Explicit
  // foreign on-site evidence therefore wins over the label, which is why the
  // Swiss-label shortcut is deliberately not applied here.
  const explicitForeignOnsite =
    FOREIGN_ONSITE.test(description) &&
    (FOREIGN_ONSITE_CITY.test(description) || (locationStated && !SWISS.test(locationText)));
  if (explicitForeignOnsite) {
    swissResidency = "no";
    reasons.push(
      "The description says the work is onsite outside Switzerland; a remote flag or a different location label does not override that evidence.",
    );
    blockers.push("The posting describes an on-site role outside Switzerland.");
  } else if (SWISS.test(locationText) || (!remote && !locationStated && swissInDescription)) {
    swissResidency = "yes";
    reasons.push(`Location evidence: ${job.location || "Swiss posting"}.`);
  } else if (remote && explicitlySwissResidents) {
    swissResidency = "yes";
    reasons.push("Remote posting explicitly accepts Swiss residents.");
  } else if (remote && (REGION_SCOPE.test(locationText) || REMOTE_SCOPE.test(description))) {
    swissResidency = "yes";
    reasons.push("Remote posting explicitly includes Switzerland, Europe, EMEA/DACH or a global work scope.");
  } else if (remote) {
    const restriction = combined.match(RESTRICTED_COUNTRY);
    if (restriction) {
      const allowed = normalise(restriction[1]);
      const includesSwitzerland = SWISS.test(allowed) || EUROPE_OPEN.test(allowed);
      swissResidency = includesSwitzerland ? "yes" : "no";
      reasons.push(
        includesSwitzerland
          ? `Remote restriction "${restriction[1].trim()}" includes Switzerland.`
          : `Remote restriction "${restriction[1].trim()}" excludes Switzerland.`,
      );
      if (!includesSwitzerland) blockers.push(`Remote role is restricted to ${restriction[1].trim()}, which excludes Switzerland.`);
    } else {
      swissResidency = "unclear";
      reasons.push("Remote posting does not state which countries it accepts; residency needs confirmation.");
    }
  } else {
    reasons.push("Posting location is outside Switzerland and the role is not marked remote.");
    blockers.push("Location is outside Switzerland and no remote option is offered.");
  }

  // 2. Citizenship-only postings cannot be satisfied by a work permit.
  if (CITIZENSHIP_ONLY.test(combined)) {
    blockers.push("Posting restricts applicants to Swiss/EU citizens or nationals, which a Permit B does not satisfy.");
  }

  // 3. Sponsorship: a truthful "no sponsorship required" answer is correct here.
  const noSponsorship = NO_SPONSORSHIP.test(combined);
  const sponsorshipRequired: EligibilityAssessment["sponsorshipRequired"] = permitEvidenced ? "no" : "unclear";
  if (noSponsorship) {
    reasons.push("The posting does not offer sponsorship; the verified profile already holds Swiss work authorisation, so none is required.");
  }
  if (!permitEvidenced) {
    blockers.push("The professional profile does not record Swiss work authorisation.");
  }

  // 4. Languages. There is no acceptable German level: any mandatory German
  //    mention disqualifies the vacancy, independent of the profile. A bare or
  //    soft German mention is unresolved, so it is never auto-submitted.
  const detected = analyseVacancyGermanRequirement(job.title, job.description);
  const storedGerman = job.german_requirement === "required";
  const german: GermanRequirementAssessment =
    storedGerman && detected.status !== "required"
      ? {
          ...detected,
          status: "required",
          detail: "A persisted discovery record marks German as mandatory.",
          evidence: detected.evidence.length > 0 ? detected.evidence : ["Persisted discovery language evidence: German required."],
          reasonCode: MANDATORY_GERMAN_REQUIREMENT,
        }
      : detected;
  const french = languageMandatory(combined, FRENCH_LANGUAGE);
  const frenchLevel = profile.languageEntries.find((entry) => /french|français|francais/i.test(entry.name))?.level ?? null;
  const frenchOk = frenchLevel ? /^(b2|c1|c2|native|fluent)$/i.test(frenchLevel) : false;
  if (german.status === "required") {
    blockers.push(`${MANDATORY_GERMAN_REQUIREMENT}: ${german.detail}`);
  } else if (german.status === "ambiguous" || german.status === "unknown") {
    reasons.push(german.detail);
  } else if (german.status === "optional") {
    reasons.push(german.detail);
  }
  if (french.required && !frenchOk) {
    blockers.push(`French${french.level ? ` ${french.level}` : ""} is required but the profile does not evidence B2 or higher.`);
  } else if (french.required) {
    reasons.push(`French${french.level ? ` ${french.level}` : ""} is required and the profile records ${frenchLevel}.`);
  }

  // 5. Application channel and deadline.
  const applicationUrl = job.application_url ?? job.url ?? null;
  let applicationOpen = true;
  if (applicationDeadlinePassed(combined, now)) {
    applicationOpen = false;
    blockers.push("The published application deadline has passed.");
  }
  if (!applicationUrl) {
    reasons.push("No direct application URL was found, so autonomous submission cannot be attempted.");
  }
  if (/\b(applications? (?:are )?closed|position (?:has been )?filled|no longer accepting applications)\b/i.test(combined)) {
    applicationOpen = false;
    blockers.push("The posting states that it is no longer accepting applications.");
  }

  if (permitValidUntil && /^\d{4}-\d{2}$/.test(permitValidUntil)) {
    reasons.push(`Swiss Permit B recorded, valid until ${permitValidUntil}.`);
  }

  const hardBlockers = blockers.filter((blocker) => !/^The professional profile does not record Swiss work authorisation/.test(blocker));
  let status: EligibilityStatus;
  if (hardBlockers.length > 0) status = "ineligible";
  else if (
    german.status === "ambiguous" ||
    german.status === "unknown" ||
    swissResidency === "unclear" ||
    !applicationUrl ||
    !applicationOpen
  ) {
    status = "needs_review";
  } else status = "eligible";

  return {
    status,
    swissResidency,
    sponsorshipRequired,
    germanRequired: german.status === "required",
    germanStatus: german.status,
    germanEvidence: german.evidence,
    germanLevel: german.level,
    germanReasonCode: german.reasonCode,
    frenchRequired: french.required,
    applicationOpen,
    reasons,
    blockers,
    workAuthorisationNote: permitEvidenced
      ? `Swiss Permit B${permitValidUntil ? ` (valid until ${permitValidUntil})` : ""}; no employer sponsorship required.`
      : "Work authorisation is not recorded in the verified profile.",
    languagesNote:
      german.status === "required"
        ? "German is mandatory; the vacancy is ineligible."
        : german.status === "ambiguous" || german.status === "unknown"
          ? "The German requirement is unresolved; automatic submission is blocked."
          : french.required
            ? `French is required${frenchLevel ? `; profile level ${frenchLevel}` : ""}.`
            : "No mandatory German or French requirement detected.",
    checkedAt: now.toISOString(),
    engine: "eligibility-rules-v2",
  };
}

export function eligibilityLabel(status: string | null | undefined): string {
  switch (status) {
    case "eligible":
      return "Eligible";
    case "ineligible":
      return "Ineligible";
    case "needs_review":
      return "Needs review";
    default:
      return "Not checked";
  }
}
