import { requireUser } from "@/lib/auth";
import { PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function DiagnosticsPage() {
  await requireUser();

  return (
    <>
      <PageHead
        title="Mobile diagnostics"
        sub="Use this page on the Samsung to capture the exact tap, JavaScript error, CSP violation, failed API request and PWA state. Nothing is uploaded."
        actions={<a href="/dashboard" className="btn">Back to dashboard</a>}
      />

      <section className="card mb-4">
        <div className="card-head">
          <div>
            <h2>Capture a failing tap</h2>
            <p className="card-sub">Turn capture on, reproduce the failure, then return here and copy the report.</p>
          </div>
          <span id="diag-capture-state" className="hint" suppressHydrationWarning>Checking capture state…</span>
        </div>
        <div className="card-body">
          <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
            <button type="button" className="btn btn-primary" id="diag-start">Enable capture &amp; reload</button>
            <button type="button" className="btn" id="diag-stop">Stop capture</button>
            <button type="button" className="btn" id="diag-copy">Copy report</button>
            <button type="button" className="btn" id="diag-install-button" disabled>Install app</button>
            <button type="button" className="btn btn-danger" id="diag-clear">Clear log</button>
          </div>
          <p className="hint" id="diag-action" role="status" aria-live="polite" suppressHydrationWarning />
          <p className="hint">
            Capture records the element, event type, resulting navigation/drawer/dialog state, JavaScript errors,
            Content-Security-Policy violations, failed same-origin requests and service-worker registration events.
            It never records input values, passwords, tokens, CV contents or message bodies.
          </p>
        </div>
      </section>

      <div className="grid g2">
        <section className="card">
          <div className="card-head"><h2>Secure context</h2></div>
          <div className="card-body"><pre className="diag-pre" id="diag-env" suppressHydrationWarning>Checking…</pre></div>
        </section>
        <section className="card">
          <div className="card-head"><h2>Install state</h2></div>
          <div className="card-body"><pre className="diag-pre" id="diag-install" suppressHydrationWarning>Checking…</pre></div>
        </section>
      </div>

      <section className="card mt-4">
        <div className="card-head"><h2>React hydration</h2></div>
        <div className="card-body"><pre className="diag-pre" id="diag-hydration" suppressHydrationWarning>Checking…</pre></div>
      </section>

      <section className="card mt-4">
        <div className="card-head"><h2>Manifest and icons</h2></div>
        <div className="card-body"><pre className="diag-pre" id="diag-manifest" suppressHydrationWarning>Checking…</pre></div>
      </section>

      <section className="card mt-4">
        <div className="card-head"><h2>Service worker</h2></div>
        <div className="card-body"><pre className="diag-pre" id="diag-worker" suppressHydrationWarning>Checking…</pre></div>
      </section>

      <section className="card mt-4">
        <div className="card-head"><h2>Captured report</h2></div>
        <div className="card-body"><pre className="diag-pre" id="diag-report" suppressHydrationWarning>Checking…</pre></div>
      </section>
    </>
  );
}
