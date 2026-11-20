/*
 * Service-worker registration must not depend on React hydration.
 *
 * The app previously registered /sw.js from a useEffect. A blocked dev HMR
 * channel, a failed client chunk or an exception in any client component could
 * therefore leave a page completely uncontrolled even though the HTML loaded.
 * This script is served as a normal deferred asset and owns registration.
 */
(function () {
  "use strict";

  var started = false;
  var registration = null;

  function diagnostic(type, data) {
    try {
      window.dispatchEvent(new CustomEvent("atw:diagnostic", {
        detail: { type: type, data: data || {} },
      }));
    } catch (error) {
      // Diagnostics must never interfere with the app.
    }
  }

  function pwa(detail) {
    try {
      window.dispatchEvent(new CustomEvent("atw:pwa", { detail: detail }));
    } catch (error) {
      // The React update banner is optional.
    }
  }

  function messageOf(cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }

  function announceWaiting(worker) {
    if (!worker) return;
    diagnostic("sw-waiting", { state: worker.state, scriptURL: worker.scriptURL });
    pwa({ type: "waiting", registration: registration, worker: worker });
  }

  function watchWorker(worker) {
    if (!worker) return;
    worker.addEventListener("statechange", function () {
      diagnostic("sw-state", { state: worker.state, scriptURL: worker.scriptURL });
      if (worker.state === "redundant") {
        diagnostic("sw-error", { message: "The service worker became redundant before activating." });
        return;
      }
      if (worker.state === "installed" && navigator.serviceWorker.controller) {
        announceWaiting(worker);
      }
    });
  }

  function register() {
    if (started) return;
    started = true;

    if (!window.isSecureContext || window.location.protocol !== "https:") {
      diagnostic("sw-disabled", {
        secureContext: window.isSecureContext,
        protocol: window.location.protocol,
        supported: "serviceWorker" in navigator,
      });
      return;
    }

    if (!("serviceWorker" in navigator)) {
      diagnostic("sw-disabled", { secureContext: true, supported: false });
      return;
    }

    navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    }).then(function (value) {
      registration = value;
      diagnostic("sw-registered", { scope: value.scope, scriptURL: "/sw.js" });
      pwa({ type: "registered", registration: value });

      watchWorker(value.installing);
      value.addEventListener("updatefound", function () {
        watchWorker(value.installing);
      });
      if (value.waiting) announceWaiting(value.waiting);

      navigator.serviceWorker.ready.then(function (ready) {
        diagnostic("sw-ready", {
          scope: ready.scope,
          active: ready.active ? ready.active.scriptURL : null,
        });
        pwa({ type: "ready", registration: ready });
      }).catch(function (cause) {
        diagnostic("sw-error", { message: messageOf(cause) });
      });

      value.update().catch(function (cause) {
        diagnostic("sw-update-error", { message: messageOf(cause) });
      });
    }).catch(function (cause) {
      diagnostic("sw-register-error", {
        name: cause instanceof Error ? cause.name : "Error",
        message: messageOf(cause),
      });
      console.error("[PWA] Service worker registration failed", cause);
      pwa({ type: "error", message: messageOf(cause) });
    });
  }

  // Expose registration for the React update banner and for the diagnostics
  // page. Calling register twice is safe and idempotent.
  window.__ATW_PWA__ = {
    register: register,
    supported: function () {
      return "serviceWorker" in navigator;
    },
    registration: function () {
      return registration;
    },
  };

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      diagnostic("sw-controller-change", {
        controlled: Boolean(navigator.serviceWorker.controller),
        scriptURL: navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null,
      });
      pwa({ type: "controllerchange", registration: registration });
    });
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible" || !registration) return;
    registration.update().catch(function (cause) {
      diagnostic("sw-update-error", { message: messageOf(cause) });
    });
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", register, { once: true });
  } else {
    register();
  }
})();
