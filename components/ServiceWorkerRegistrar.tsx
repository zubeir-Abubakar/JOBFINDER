"use client";

import { useEffect, useState } from "react";

/**
 * Registers the shell-only service worker. A new worker is never allowed to
 * take control mid-session without asking, so an active voice call or form is
 * not reloaded unexpectedly.
 */
export function ServiceWorkerRegistrar() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;

    let registration: ServiceWorkerRegistration | null = null;
    let disposed = false;
    const hadController = Boolean(navigator.serviceWorker.controller);

    const watchWorker = (worker: ServiceWorker | null) => {
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (disposed || worker.state !== "installed" || !navigator.serviceWorker.controller) return;
        setWaiting(worker);
      });
    };

    const register = async () => {
      try {
        registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        if (disposed) return;
        watchWorker(registration.installing);
        registration.addEventListener("updatefound", () => watchWorker(registration?.installing ?? null));
        if (registration.waiting && navigator.serviceWorker.controller) setWaiting(registration.waiting);
        await registration.update().catch(() => undefined);
      } catch {
        // PWA support is an enhancement; failure never blocks the workspace.
      }
    };

    const onLoad = () => void register();
    const onVisible = () => {
      if (document.visibilityState === "visible") void registration?.update().catch(() => undefined);
    };
    const onControllerChange = () => {
      // The first install claims the page; only reload for an actual update.
      if (hadController) window.location.reload();
    };

    if (document.readyState === "complete") void register();
    else window.addEventListener("load", onLoad, { once: true });
    document.addEventListener("visibilitychange", onVisible);
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    return () => {
      disposed = true;
      window.removeEventListener("load", onLoad);
      document.removeEventListener("visibilitychange", onVisible);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
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
