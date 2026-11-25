import type { GermanRequirementAssessment, GermanRequirementStatus } from "@/lib/language-requirements";

type Evidence = {
  status?: GermanRequirementStatus;
  level?: string | null;
  evidence?: string[];
  detail?: string;
  reasonCode?: string | null;
};

function parseEvidence(raw: string | null | undefined): Evidence | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Evidence;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

const COPY: Record<GermanRequirementStatus, { label: string; tone: string; detail: string }> = {
  required: {
    label: "German required — ineligible",
    tone: "badge-bad",
    detail: "German is mandatory at this vacancy. Any level, including A1, is a hard exclusion and this vacancy is never submitted.",
  },
  ambiguous: {
    label: "German wording unresolved",
    tone: "badge-warn",
    detail: "German is mentioned but the requirement could not be resolved from the stored description. Automatic submission is blocked for review.",
  },
  unknown: {
    label: "German requirement unknown",
    tone: "badge-warn",
    detail: "No usable description is stored, so a German requirement cannot be excluded. Automatic submission is blocked for review.",
  },
  optional: {
    label: "German optional only",
    tone: "badge-info",
    detail: "German is mentioned only as an optional advantage, so it is not a hard exclusion.",
  },
  absent: {
    label: "No German requirement detected",
    tone: "badge-good",
    detail: "The stored posting does not require German.",
  },
};

/**
 * Shared, read-only evidence panel for job and application detail pages. It
 * shows the persisted assessment rather than re-running a language model or
 * inventing a second interpretation.
 */
export function GermanRequirementCard({
  status,
  evidence,
  eligibility,
  compact = false,
}: {
  status?: string | null;
  evidence?: string | null;
  eligibility?: string | null;
  compact?: boolean;
}) {
  const parsed = parseEvidence(evidence);
  const resolvedStatus =
    (status as GermanRequirementStatus | null | undefined) ??
    parsed?.status ??
    "unknown";
  const copy = COPY[resolvedStatus] ?? COPY.unknown;
  const quotes = (parsed?.evidence ?? []).filter(Boolean).slice(0, 5);
  const level = parsed?.level ? ` · ${parsed.level}` : "";
  const reasonCode = parsed?.reasonCode ?? (resolvedStatus === "required" ? "MANDATORY_GERMAN_REQUIREMENT" : resolvedStatus === "ambiguous" || resolvedStatus === "unknown" ? "GERMAN_REQUIREMENT_UNRESOLVED" : null);

  return (
    <section className="card" data-visual-id="german-requirement">
      <div className="card-head">
        <div>
          <h2>Language eligibility</h2>
          <p className="card-sub">Deterministic German-requirement evidence stored with this vacancy.</p>
        </div>
        <span className={`badge ${copy.tone}`}>{copy.label}{level}</span>
      </div>
      <div className="card-body stack" style={{ gap: 9 }}>
        <p className="text-[12.5px] leading-relaxed" style={{ margin: 0 }}>{parsed?.detail ?? copy.detail}</p>
        {quotes.length > 0 ? (
          <div>
            <div className="label">{resolvedStatus === "required" ? "Mandatory wording" : "Language evidence"}</div>
            <ul className="stack text-[12px]" style={{ gap: 5, paddingLeft: 17, listStyle: "disc" }}>
              {quotes.map((quote) => <li key={quote}>{quote}</li>)}
            </ul>
          </div>
        ) : resolvedStatus === "required" ? (
          <p className="text-[11.5px]" style={{ color: "var(--muted)" }}>The persisted record marks German as mandatory; the original quote was not retained.</p>
        ) : null}
        {!compact ? (
          <div className="between text-[11.5px]" style={{ color: "var(--muted)", borderTop: "1px solid var(--line)", paddingTop: 8 }}>
            <span>Eligibility: <strong>{eligibility ?? "not recorded"}</strong></span>
            <span className="num">{reasonCode ?? "no reason code"}</span>
          </div>
        ) : null}
        <p className="text-[11px] leading-relaxed" style={{ color: "var(--muted)", margin: 0 }}>
          Policy: any German requirement at any level makes the vacancy ineligible. Optional German is not disqualifying; ambiguous or missing wording is never submitted automatically.
        </p>
      </div>
    </section>
  );
}

export type { GermanRequirementAssessment };
