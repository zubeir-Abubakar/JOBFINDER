import type { ProfileData } from "./profile";

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
};

const SWISS = /(switzerland|schweiz|suisse|svizzera|swiss|zurich|zürich|geneva|genève|geneve|lausanne|bern|basel|zug|luzern|lucerne|winterthur|st\.?\s*gallen|lugano|fribourg|vaud|ticino|neuch|bienne|olten|aarau|schaffhausen|sion|chur)/i;
// "Remote" on its own is not residency eligibility: a posting must explicitly
// accept Europe/EEA/global applicants, which is the distinction the brief calls out.
const EUROPE_OPEN = /\b(eu\/efta|european union|europe|eea|emea|dach|worldwide|anywhere|global(?:ly)?|international)\b/i;
const SWISS_RESIDENTS = /\b(swiss (?:residents?|based|candidates?)|residents? of switzerland|based in switzerland|switzerland[- ]based|eligible to work in switzerland)\b/i;
const CITIZENSHIP_ONLY = /\b(swiss (?:or eu|or eea) (?:citizens?|nationals?)|eu\/efta (?:citizens?|nationals?)|citizenship (?:is )?required|passport (?:is )?required|only (?:swiss|eu) (?:citizens?|nationals?))\b/i;
const NO_SPONSORSHIP = /\b(no (?:visa )?sponsorship|without (?:visa )?sponsorship|sponsorship (?:is )?not (?:available|offered)|cannot sponsor|unable to sponsor)\b/i;
const RESTRICTED_COUNTRY =
  /\b(?:(?:must|need to|required to) (?:be )?(?:based|reside|live|located) in|(?:restricted|limited|open only) to (?:candidates|applicants|residents)?\s*(?:based |residing |living )?in) ([a-z ,/&-]{3,60})\b/i;
const GERMAN_LANGUAGE = /\b(german|deutsch)\b/i;
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
  if (SWISS.test(locationText) || (!remote && !locationStated && swissInDescription)) {
    swissResidency = "yes";
    reasons.push(`Location evidence: ${job.location || "Swiss posting"}.`);
  } else if (remote && explicitlySwissResidents) {
    swissResidency = "yes";
    reasons.push("Remote posting explicitly accepts Swiss residents.");
  } else if (remote && EUROPE_OPEN.test(combined)) {
    swissResidency = "yes";
    reasons.push("Remote posting is open to Europe/EEA/global applicants, which includes Switzerland.");
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

  // 4. Languages. German is excluded unless the employer marks it optional;
  //    French at B2 and above is acceptable.
  const german = languageMandatory(combined, GERMAN_LANGUAGE);
  const french = languageMandatory(combined, FRENCH_LANGUAGE);
  const frenchLevel = profile.languageEntries.find((entry) => /french|français|francais/i.test(entry.name))?.level ?? null;
  const frenchOk = frenchLevel ? /^(b2|c1|c2|native|fluent)$/i.test(frenchLevel) : false;
  if (german.required) {
    blockers.push(`German${german.level ? ` ${german.level}` : ""} is mandatory and is not among the verified languages.`);
  } else if (GERMAN_LANGUAGE.test(combined)) {
    reasons.push("German is mentioned but not as a mandatory requirement.");
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
  else if (swissResidency === "unclear" || !applicationUrl || !applicationOpen) status = "needs_review";
  else status = "eligible";

  return {
    status,
    swissResidency,
    sponsorshipRequired,
    germanRequired: german.required,
    frenchRequired: french.required,
    applicationOpen,
    reasons,
    blockers,
    workAuthorisationNote: permitEvidenced
      ? `Swiss Permit B${permitValidUntil ? ` (valid until ${permitValidUntil})` : ""}; no employer sponsorship required.`
      : "Work authorisation is not recorded in the verified profile.",
    languagesNote: german.required
      ? "German is mandatory."
      : french.required
        ? `French is required${frenchLevel ? `; profile level ${frenchLevel}` : ""}.`
        : "No mandatory German or French requirement detected.",
    checkedAt: now.toISOString(),
    engine: "eligibility-rules-v1",
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
