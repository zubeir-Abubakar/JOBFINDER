import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { PageHead, Stat, Flash } from "@/components/ui";
import { param, formatDateTime } from "@/lib/format";
import { capabilityRegistry, type Capability } from "@/lib/capabilities";

export const dynamic = "force-dynamic";

function liveBadge(live: Capability["live"]): { className: string; label: string } {
  if (live === "Live-verified") return { className: "badge badge-good", label: "Live-verified" };
  if (live === "Blocked") return { className: "badge badge-bad", label: "Blocked" };
  if (live === "Failed") return { className: "badge badge-bad", label: "Failed" };
  return { className: "badge badge-warn", label: "Awaiting live verification" };
}

function dependencyBadge(dependency: Capability["dependency"]): { className: string; label: string } {
  if (dependency === "Configured") return { className: "badge badge-good", label: "Dependencies configured" };
  if (dependency === "Not configured") return { className: "badge badge-warn", label: "Not configured" };
  return { className: "badge badge-neutral", label: "No dependency" };
}

export default async function CapabilitiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const sp = await searchParams;
  const { capabilities, summary } = capabilityRegistry();

  const grouped: Array<{ category: string; items: Capability[] }> = [];
  for (const capability of capabilities) {
    const group = grouped.find((entry) => entry.category === capability.category);
    if (group) group.items.push(capability);
    else grouped.push({ category: capability.category, items: [capability] });
  }

  return (
    <>
      <Flash ok={param(sp.ok)} error={param(sp.error)} />
      <PageHead
        title="Capability centre"
        sub="Every capability that is actually implemented in this deployment, with its configuration, automated test coverage and live evidence. Implemented does not mean enabled, and enabled does not mean proven."
      />

      <section className="stats mb-4" aria-label="Capability summary" data-testid="capability-summary">
        <Stat label="Catalogued capabilities" value={summary.total} />
        <Stat label="Live-verified" value={summary.liveVerified} tone={summary.liveVerified ? "good" : undefined} />
        <Stat label="Awaiting live verification" value={summary.awaitingVerification} tone={summary.awaitingVerification ? "warn" : undefined} />
        <Stat label="Blocked" value={summary.blocked} tone={summary.blocked ? "warn" : undefined} />
        <Stat label="Not configured" value={summary.notConfigured} tone={summary.notConfigured ? "warn" : undefined} />
        <Stat label="Disabled" value={summary.disabled} />
      </section>

      <div className="alert alert-info mb-4">
        Statuses come from real evidence: stored rows, applied migrations, worker heartbeats, connected scopes and persisted outcomes. A missing
        measurement is shown as unverified rather than assumed healthy. No credential, token or environment value is displayed.
      </div>

      <div className="stack" style={{ gap: 16 }}>
        {grouped.map((group) => (
          <section className="card" key={group.category} data-testid={`capability-group-${group.category.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>
            <div className="card-head">
              <div>
                <h2>{group.category}</h2>
                <p className="card-sub">{group.items.length} capability item(s) in this category.</p>
              </div>
            </div>
            <div className="card-body stack" style={{ gap: 12 }}>
              {group.items.map((capability) => {
                const live = liveBadge(capability.live);
                const dependency = dependencyBadge(capability.dependency);
                return (
                  <article key={capability.id} className="card-quiet p-3 stack" style={{ gap: 6 }} data-testid={`capability-${capability.id}`}>
                    <div className="between flex-wrap gap-2">
                      <div>
                        <h3 className="text-[13.5px] font-semibold">{capability.name}</h3>
                        <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                          {capability.implementation} · {capability.enabled ? "Enabled" : "Disabled"}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={live.className}>{live.label}</span>
                        <span className={dependency.className}>{dependency.label}</span>
                        <span className={`badge ${capability.enabled ? "badge-good" : "badge-neutral"}`}>
                          {capability.enabled ? "Enabled" : "Disabled"}
                        </span>
                      </div>
                    </div>
                    <p className="text-[12px]" style={{ color: "var(--ink-soft)" }}>{capability.description}</p>
                    <div className="text-[11.5px]" style={{ color: "var(--muted)" }}>
                      <strong>Live evidence:</strong> {capability.liveDetail}
                    </div>
                    <div className="text-[11.5px]" style={{ color: "var(--muted)" }}>
                      <strong>Dependencies:</strong> {capability.dependencyDetail}
                    </div>
                    <div className="text-[11.5px]" style={{ color: "var(--muted)" }}>
                      <strong>Automated tests:</strong>{" "}
                      {capability.tests.length > 0 ? capability.tests.join(", ") : "No dedicated automated test identified."}
                    </div>
                    <div className="text-[11.5px]" style={{ color: "var(--muted)" }}>
                      <strong>Limitation:</strong> {capability.limitations}
                    </div>
                    <div className="between flex-wrap gap-2">
                      <span className="text-[11px]" style={{ color: "var(--muted)" }}>
                        Last successful execution: {capability.lastSuccess ? formatDateTime(capability.lastSuccess) : "none recorded"}
                      </span>
                      {capability.href ? (
                        <Link href={capability.href} className="btn btn-sm" data-testid={`capability-link-${capability.id}`}>
                          Open in the app
                        </Link>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
