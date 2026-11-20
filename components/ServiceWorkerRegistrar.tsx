"use client";

import { useEffect, useState } from "react";

type PwaDetail = {
  type?: string;
  registration?: ServiceWorkerRegistration;
  worker?: ServiceWorker;
};

/**
 * The actual registration lives in public/pwa-bootstrap.js so it still runs
 * when React hydration fails. This component only exposes the update prompt
 * and marks the document as hydrated for diagnostics.
 */
export function ServiceWorkerRegistrar() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    // This marker means React effects ran. It is deliberately separate from
    // service-worker registration, which is handled by the static bootstrap.
    document.documentElement.dataset.atwHydrated = "true";

    let disposed = false;
    let registration: ServiceWorkerRegistration | null = null;

    const syncWaiting = () => {
      if (!disposed && registration?.waiting) setWaiting(registration.waiting);
    };

    const onPwa = (event: Event) => {
      const detail = (event as CustomEvent<PwaDetail>).detail;
      if (detail?.registration) {
        registration = detail.registration;
        syncWaiting();
      }
    };

    const onControllerChange = () => {
      try {
        if (window.sessionStorage.getItem("atw.sw.reload") === "1") {
          window.sessionStorage.removeItem("atw.sw.reload");
          window.location.reload();
        }
      } catch {
        // Private mode: the update still activates on the next navigation.
      }
    };

    window.addEventListener("atw:pwa", onPwa);
    navigator.serviceWorker?.addEventListener("controllerchange", onControllerChange);
    navigator.serviceWorker?.getRegistration("/").then((value) => {
      if (disposed || !value) return;
      registration = value;
      syncWaiting();
    }).catch(() => undefined);

    return () => {
      disposed = true;
      window.removeEventListener("atw:pwa", onPwa);
      navigator.serviceWorker?.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  if (!waiting) return null;

  return (
    <div className="pwa-update" role="status" aria-live="polite">
      <span>A new version of the workspace is ready.</span>
      <button
        type="button"
        className="btn btn-sm btn-primary"
        onClick={() => {
          try {
            window.sessionStorage.setItem("atw.sw.reload", "1");
          } catch {
            // The new worker still activates; the user can refresh once.
          }
          waiting.postMessage({ type: "SKIP_WAITING" });
          setWaiting(null);
        }}
      >
        Reload
      </button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setWaiting(null)}>
        Later
      </button>
    </div>
  );
}
