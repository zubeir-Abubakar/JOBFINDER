import { requireAdmin } from "@/lib/auth";
import { PageHead, Flash } from "@/components/ui";
import { formatDateTime, param } from "@/lib/format";
import { integrationInventory } from "@/lib/integrations";
import { testIntegrationAction } from "@/lib/actions/admin";
import { SubmitButton } from "@/components/SubmitButton";

export const dynamic = "force-dynamic";

function statusClass(tone: "good" | "warn" | "bad" | "neutral"): string {
  return tone === "good" ? "badge-good" : tone === "warn" ? "badge-warn" : tone === "bad" ? "badge-bad" : "badge-neutral";
}

export default async function AdminIntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const { integrations, automaticSubmissionOperational, reasons } = integrationInventory();

  return (
    <>
      <Flash ok={param(sp.ok)} error={param(sp.error)} />
      {param(sp.notice) ? <div className="alert alert-info mb-4">{param(sp.notice)}</div> : null}
      <PageHead
        title="Integrations"
        sub="Submission adapters, credential readiness and the last real connection test. Credential values are never displayed."
        actions={<a href="/admin/security" className="btn">Security settings</a>}
      />

      <section className={`card mb-4 ${automaticSubmissionOperational ? "" : "border-warn"}`}>
        <div className="card-head">
          <div>
            <h2>Automatic submission</h2>
            <p className="card-sub">A configured adapter is not an operational channel. A verified connection is required before this can be marked ready.</p>
          </div>
          <span className={`badge ${automaticSubmissionOperational ? "badge-good" : "badge-bad"}`}>
            {automaticSubmissionOperational ? "Operational connection available" : "Not operational"}
          </span>
        </div>
        <div className="card-body">
          <div className="alert alert-info mb-3">
            The 85% minimum, five-application daily cap, duplicate prevention, readiness audit and standing-authorisation gate remain enforced independently
            of these integrations.
          </div>
          <ul className="stack text-[12.5px]" style={{ gap: 6, paddingLeft: 16, listStyle: "disc" }}>
            {reasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        </div>
      </section>

      <div className="grid g2">
        {integrations.map((integration) => (
          <section className="card" key={integration.key}>
            <div className="card-head">
              <div>
                <h2>{integration.name}</h2>
                <p className="card-sub">{integration.kind}</p>
              </div>
              <span className={`badge ${statusClass(integration.connectionTone)}`}>{integration.connectionStatus}</span>
            </div>
            <div className="card-body stack" style={{ gap: 12 }}>
              <div>
                <div className="label">Required credentials</div>
                {integration.credentials.map((credential) => (
                  <div className="between card-quiet px-3 py-2 mt-1" key={credential.name}>
                    <div>
                      <div className="text-[12px] font-medium">{credential.name}</div>
                      <div className="text-[11px]" style={{ color: "var(--muted)" }}>{credential.note}</div>
                    </div>
                    <span className={`badge ${credential.present ? "badge-good" : "badge-bad"}`}>{credential.present ? "Set" : "Missing"}</span>
                  </div>
                ))}
              </div>

              <div>
                <div className="label">Supported capabilities</div>
                <ul className="stack text-[12px]" style={{ gap: 4, paddingLeft: 16, listStyle: "disc" }}>
                  {integration.capabilities.map((capability) => <li key={capability}>{capability}</li>)}
                </ul>
              </div>

              <div className="grid g2" style={{ gap: 10 }}>
                <div>
                  <div className="label">Last successful connection test</div>
                  <div className="text-[12.5px]">{integration.lastSuccessAt ? formatDateTime(integration.lastSuccessAt) : "Never"}</div>
                </div>
                <div>
                  <div className="label">Automatic submission operational</div>
                  <div className="text-[12.5px]">{integration.operational ? "Yes" : "No"}</div>
                </div>
              </div>

              <div className={`alert ${integration.operational ? "alert-ok" : "alert-warn"}`} style={{ padding: "9px 11px", fontSize: 12 }}>
                {integration.operationalDetail}
              </div>

              {integration.lastCheck ? (
                <div className="card-quiet p-3 text-[11.5px]" style={{ color: "var(--muted)" }}>
                  <strong style={{ color: "var(--ink)" }}>Last check:</strong> {integration.lastCheck.status} · {formatDateTime(integration.lastCheck.checkedAt)}
                  <div className="mt-1">{integration.lastCheck.detail}</div>
                </div>
              ) : null}

              <div className="row">
                {integration.testable ? (
                  <form action={testIntegrationAction}>
                    <input type="hidden" name="key" value={integration.key} />
                    <SubmitButton className="btn btn-sm" pendingLabel="Testing…">Test connection</SubmitButton>
                  </form>
                ) : (
                  <span className="hint">No global connection test is available for this channel.</span>
                )}
              </div>
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
