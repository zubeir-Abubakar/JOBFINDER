(function () {
  "use strict";

  var captureKey = "atw.diag";
  var logKey = "atw.diag.log";
  var MAX_EVENTS = 80;
  var MAX_ERRORS = 24;
  var MAX_REQUESTS = 24;

  function trim(value, max) {
    var text = value == null ? "" : String(value);
    return text.length > max ? text.slice(0, max) + "..." : text;
  }

  function readJson(value) {
    try {
      return JSON.parse(value);
    } catch (error) {
      return null;
    }
  }

  function captureEnabled() {
    try {
      return window.sessionStorage.getItem(captureKey) === "1";
    } catch (error) {
      return false;
    }
  }

  function storedLog() {
    try {
      return readJson(window.sessionStorage.getItem(logKey) || "null");
    } catch (error) {
      return null;
    }
  }

  function describe(element) {
    if (!element || !element.tagName) return "unknown";
    var tag = element.tagName.toLowerCase();
    var id = element.id ? "#" + element.id : "";
    var classes = "";
    if (typeof element.className === "string" && element.className.trim()) {
      classes = "." + element.className.trim().split(/\s+/).slice(0, 3).join(".");
    }
    var label = "";
    try {
      label = element.getAttribute("aria-label") || element.getAttribute("title") || "";
    } catch (error) {}
    var text = "";
    if (tag === "button" || tag === "a" || tag === "summary" || tag === "label") {
      text = (element.textContent || "").replace(/\s+/g, " ").trim();
    }
    return tag + id + classes +
      (label ? ' aria="' + trim(label, 70) + '"' : "") +
      (text ? ' text="' + trim(text, 80) + '"' : "");
  }

  function safeUrl(input) {
    try {
      var raw = typeof input === "string" ? input : (input && input.url) || "";
      var url = new URL(raw, window.location.href);
      return url.origin === window.location.origin ? url.pathname : url.origin;
    } catch (error) {
      return "unknown";
    }
  }

  function errorText(value) {
    if (value instanceof Error) return trim(value.stack || value.message, 600);
    if (value && typeof value === "object") {
      try {
        return trim(JSON.stringify(value), 600);
      } catch (error) {
        return trim(String(value), 600);
      }
    }
    return trim(value, 600);
  }

  var enabled = captureEnabled();
  var diag = {
    startedAt: new Date().toISOString(),
    events: [],
    errors: [],
    requests: [],
    cspViolations: [],
    consoleErrors: [],
    installPrompt: null,
  };
  window.__ATW_DIAG__ = diag;

  function loadPrior() {
    try {
      var prior = readJson(window.sessionStorage.getItem(logKey) || "null");
      if (!prior || !prior.startedAt) return;
      diag.startedAt = prior.startedAt;
      if (Array.isArray(prior.events)) diag.events = prior.events.slice(-MAX_EVENTS);
      if (Array.isArray(prior.errors)) diag.errors = prior.errors.slice(-MAX_ERRORS);
      if (Array.isArray(prior.requests)) diag.requests = prior.requests.slice(-MAX_REQUESTS);
      if (Array.isArray(prior.cspViolations)) diag.cspViolations = prior.cspViolations.slice(-MAX_ERRORS);
      if (Array.isArray(prior.consoleErrors)) diag.consoleErrors = prior.consoleErrors.slice(-MAX_ERRORS);
    } catch (error) {}
  }

  function persist() {
    if (!enabled) return;
    try {
      window.sessionStorage.setItem(logKey, JSON.stringify({
        startedAt: diag.startedAt,
        events: diag.events.slice(-MAX_EVENTS),
        errors: diag.errors.slice(-MAX_ERRORS),
        requests: diag.requests.slice(-MAX_REQUESTS),
        cspViolations: diag.cspViolations.slice(-MAX_ERRORS),
        consoleErrors: diag.consoleErrors.slice(-MAX_ERRORS),
        installPrompt: Boolean(diag.installPrompt),
      }));
    } catch (error) {}
  }

  function record(type, data) {
    if (!enabled) return;
    var item = {
      at: new Date().toISOString(),
      type: trim(type, 40),
      data: data || {},
    };
    diag.events.push(item);
    if (diag.events.length > MAX_EVENTS) diag.events.shift();
    if (
      type === "error" ||
      type === "rejection" ||
      type === "csp" ||
      type === "sw-error" ||
      type === "sw-register-error" ||
      type === "sw-update-error" ||
      type === "chunk-error" ||
      type === "hydration-timeout"
    ) {
      diag.errors.push(item);
      if (diag.errors.length > MAX_ERRORS) diag.errors.shift();
    }
    if (type === "fetch" || type === "fetch-failed") {
      diag.requests.push(item);
      if (diag.requests.length > MAX_REQUESTS) diag.requests.shift();
    }
    if (type === "csp") {
      diag.cspViolations.push(item);
      if (diag.cspViolations.length > MAX_ERRORS) diag.cspViolations.shift();
    }
    if (type === "console") {
      diag.consoleErrors.push(item);
      if (diag.consoleErrors.length > MAX_ERRORS) diag.consoleErrors.shift();
    }
    persist();
  }

  diag.record = record;
  diag.describe = describe;

  if (enabled) {
    loadPrior();

    // Capture phase is required: resource errors on <script>/<link> do not
    // bubble, so a missing client chunk was previously invisible here.
    window.addEventListener("error", function (event) {
      var target = event.target;
      var resource = null;
      if (target && target !== window && (target.src || target.href)) {
        resource = {
          tag: String(target.tagName || "resource").toLowerCase(),
          url: safeUrl(target.src || target.href),
        };
      }
      record("error", {
        message: trim(event.message || (resource ? "Resource failed to load" : "Unknown error"), 400),
        source: trim(event.filename || (resource ? resource.url : ""), 240),
        line: event.lineno,
        column: event.colno,
        resource: resource,
      });
      if (resource) record("chunk-error", resource);
    }, true);

    window.addEventListener("unhandledrejection", function (event) {
      record("rejection", { reason: errorText(event.reason) });
    });

    document.addEventListener("securitypolicyviolation", function (event) {
      record("csp", {
        directive: event.violatedDirective,
        blockedURI: event.blockedURI,
        sample: trim(event.sample, 240),
      });
    });

    window.addEventListener("atw:diagnostic", function (event) {
      if (!event.detail) return;
      record(event.detail.type || "event", event.detail.data || {});
    });

    var originalConsoleError = console.error;
    console.error = function () {
      var args = Array.prototype.slice.call(arguments).map(function (value) {
        return errorText(value);
      });
      record("console", { args: args.slice(0, 5) });
      return originalConsoleError.apply(console, arguments);
    };

    if (window.fetch) {
      var originalFetch = window.fetch;
      window.fetch = function (input) {
        var url = safeUrl(input);
        return originalFetch.apply(this, arguments).then(
          function (response) {
            if (!response.ok) record("fetch", { url: url, status: response.status });
            return response;
          },
          function (error) {
            record("fetch-failed", { url: url, message: errorText(error) });
            throw error;
          },
        );
      };
    }

    document.addEventListener("pointerdown", function (event) {
      record("pointerdown", {
        target: describe(event.target),
        x: Math.round(event.clientX),
        y: Math.round(event.clientY),
        pointerType: event.pointerType || "unknown",
        trusted: event.isTrusted,
      });
    }, true);

    document.addEventListener("click", function (event) {
      var target = describe(event.target);
      record("click", {
        target: target,
        defaultPrevented: event.defaultPrevented,
        trusted: event.isTrusted,
      });
      window.setTimeout(function () {
        record("result", {
          target: target,
          url: window.location.pathname,
          drawerOpen: Boolean(document.querySelector(".sidebar.open")),
          voicePanelOpen: Boolean(document.querySelector(".lv-panel")),
          dialogs: document.querySelectorAll('[role="dialog"]').length,
          bodyClasses: trim(document.body.className, 100),
          controlledByServiceWorker: Boolean(navigator.serviceWorker && navigator.serviceWorker.controller),
        });
      }, 350);
    });

    window.addEventListener("beforeinstallprompt", function (event) {
      event.preventDefault();
      diag.installPrompt = event;
      record("install-prompt", { platforms: event.platforms || [] });
    });

    window.addEventListener("appinstalled", function () {
      diag.installPrompt = null;
      record("app-installed", {});
    });

    record("boot", {
      url: window.location.pathname,
      secureContext: window.isSecureContext,
      protocol: window.location.protocol,
      displayMode: window.matchMedia("(display-mode: standalone)").matches ? "standalone" : "browser",
      serviceWorkerSupported: "serviceWorker" in navigator,
      serviceWorkerControlled: Boolean(navigator.serviceWorker && navigator.serviceWorker.controller),
      userAgent: trim(navigator.userAgent, 240),
    });
  }

  var page = {
    start: null,
    manifest: null,
    worker: null,
    install: null,
    timer: null,
    ready: false,
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    var element = byId(id);
    if (element) element.textContent = value;
  }

  function displayMode() {
    return window.matchMedia("(display-mode: standalone)").matches ? "standalone" : "browser";
  }

  function hydrationState() {
    var shell = document.querySelector(".shell") || document.body;
    var reactKeys = [];
    try {
      reactKeys = Object.keys(shell).filter(function (key) {
        return key.indexOf("__reactFiber$") === 0 || key.indexOf("__reactContainer$") === 0;
      });
    } catch (error) {}
    return {
      marker: document.documentElement.dataset.atwHydrated === "true",
      reactRootAttached: reactKeys.length > 0,
      nextFlightQueueLength: Array.isArray(window.__next_f) ? window.__next_f.length : null,
      readyState: document.readyState,
      externalScripts: document.querySelectorAll("script[src]").length,
      serviceWorkerControlled: Boolean(navigator.serviceWorker && navigator.serviceWorker.controller),
    };
  }

  function environment() {
    return {
      url: window.location.href,
      protocol: window.location.protocol,
      secureContext: window.isSecureContext,
      displayMode: displayMode(),
      hydration: hydrationState(),
      serviceWorkerSupported: "serviceWorker" in navigator,
      serviceWorkerControlled: Boolean(navigator.serviceWorker && navigator.serviceWorker.controller),
      microphoneApi: Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      audioWorklet: typeof AudioWorkletNode !== "undefined",
      userAgent: navigator.userAgent,
      captureEnabled: captureEnabled(),
    };
  }

  function iconStatus(icon) {
    return new Promise(function (resolve) {
      if (!icon || !icon.src) {
        resolve({ declared: icon, error: "missing src" });
        return;
      }
      var image = new Image();
      var timer = window.setTimeout(function () {
        resolve({ declared: icon, error: "timed out" });
      }, 5000);
      image.onload = function () {
        window.clearTimeout(timer);
        resolve({
          src: icon.src,
          declaredSizes: icon.sizes,
          purpose: icon.purpose || "any",
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          valid: Boolean(image.naturalWidth && image.naturalHeight),
        });
      };
      image.onerror = function () {
        window.clearTimeout(timer);
        resolve({ src: icon.src, declared: icon, error: "failed to load" });
      };
      image.src = icon.src + (icon.src.indexOf("?") === -1 ? "?" : "&") + "diag=" + Date.now();
    });
  }

  async function checkManifest() {
    try {
      var response = await fetch("/manifest.webmanifest?diag=" + Date.now(), { cache: "no-store" });
      var payload = await response.json();
      var icons = [];
      for (var index = 0; index < (payload.icons || []).length; index += 1) {
        icons.push(await iconStatus(payload.icons[index]));
      }
      page.manifest = {
        httpStatus: response.status,
        contentType: response.headers.get("content-type"),
        name: payload.name,
        shortName: payload.short_name,
        id: payload.id,
        startUrl: payload.start_url,
        scope: payload.scope,
        display: payload.display,
        orientation: payload.orientation,
        themeColor: payload.theme_color,
        backgroundColor: payload.background_color,
        icons: icons,
      };
    } catch (error) {
      page.manifest = { error: error instanceof Error ? error.message : String(error) };
    }
    setText("diag-manifest", JSON.stringify(page.manifest, null, 2));
    refreshReport();
  }

  async function checkWorker() {
    if (!("serviceWorker" in navigator)) {
      page.worker = { supported: false };
      setText("diag-worker", JSON.stringify(page.worker, null, 2));
      refreshReport();
      return;
    }
    try {
      var registrations = await navigator.serviceWorker.getRegistrations();
      var ready = null;
      if (registrations.length > 0) {
        ready = await Promise.race([
          navigator.serviceWorker.ready.then(function (value) {
            return { scope: value.scope, active: value.active ? value.active.scriptURL : null };
          }),
          new Promise(function (resolve) {
            window.setTimeout(function () { resolve(null); }, 3000);
          }),
        ]);
      }
      page.worker = {
        supported: true,
        controlled: Boolean(navigator.serviceWorker.controller),
        controller: navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null,
        ready: ready,
        registrations: registrations.map(function (registration) {
          return {
            scope: registration.scope,
            active: registration.active ? registration.active.scriptURL : null,
            waiting: registration.waiting ? registration.waiting.scriptURL : null,
            installing: registration.installing ? registration.installing.scriptURL : null,
          };
        }),
      };
    } catch (error) {
      page.worker = { supported: true, error: error instanceof Error ? error.message : String(error) };
    }
    setText("diag-worker", JSON.stringify(page.worker, null, 2));
    refreshReport();
  }

  function checkInstall() {
    var prompt = window.__ATW_DIAG__ && window.__ATW_DIAG__.installPrompt;
    page.install = {
      standalone: displayMode() === "standalone",
      beforeInstallPromptCaptured: Boolean(prompt),
      message: prompt
        ? "Chrome captured an install prompt. You can use the Install button below."
        : "No install prompt was captured. This event is optional. In Chrome, open the three-dot menu and choose Install app or Add to Home screen after confirming an active service worker. If that option is absent, check HTTPS, the trusted certificate and the service-worker registrations below.",
    };
    setText("diag-install", JSON.stringify(page.install, null, 2));
    var button = byId("diag-install-button");
    if (button) button.disabled = !prompt;
    return prompt;
  }

  function report() {
    return {
      environment: environment(),
      hydration: hydrationState(),
      manifest: page.manifest,
      serviceWorker: page.worker,
      install: page.install,
      storedCapture: storedLog(),
      liveCapture: {
        startedAt: diag.startedAt,
        events: diag.events,
        errors: diag.errors,
        requests: diag.requests,
        cspViolations: diag.cspViolations,
        consoleErrors: diag.consoleErrors,
        installPrompt: Boolean(diag.installPrompt),
      },
    };
  }

  function refreshReport() {
    if (!byId("diag-report")) return;
    var output = byId("diag-report");
    if (output) output.textContent = JSON.stringify(report(), null, 2);
    var state = byId("diag-capture-state");
    if (state) {
      state.textContent = captureEnabled()
        ? "Capture is on. Return to the dashboard, tap the failing controls, then come back here. Tap results are recorded locally in this browser tab."
        : "Capture is off. Turn it on, then reload and reproduce the failure. No data leaves this browser.";
    }
    setText("diag-hydration", JSON.stringify(hydrationState(), null, 2));
    var prompt = checkInstall();
    var installButton = byId("diag-install-button");
    if (installButton) installButton.disabled = !prompt;
  }

  function installApp() {
    var prompt = window.__ATW_DIAG__ && window.__ATW_DIAG__.installPrompt;
    if (!prompt) {
      refreshReport();
      return;
    }
    prompt.prompt().then(function () {
      return prompt.userChoice;
    }).then(function (choice) {
      setText("diag-action", "Install choice: " + (choice && choice.outcome ? choice.outcome : "unknown"));
      if (window.__ATW_DIAG__) window.__ATW_DIAG__.installPrompt = null;
      refreshReport();
    }).catch(function (error) {
      setText("diag-action", "Install prompt failed: " + (error && error.message ? error.message : String(error)));
    });
  }

  function copyReport() {
    var value = JSON.stringify(report(), null, 2);
    var done = function () { setText("diag-action", "Report copied. Paste it into the chat."); };
    var failed = function () { setText("diag-action", "Clipboard is unavailable. Select the report text and copy it manually."); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(value).then(done).catch(failed);
    } else {
      failed();
    }
  }

  function wirePage(start) {
    var stop = byId("diag-stop");
    var clear = byId("diag-clear");
    var copy = byId("diag-copy");
    var install = byId("diag-install-button");

    start.addEventListener("click", function () {
      try {
        window.sessionStorage.setItem(captureKey, "1");
        window.sessionStorage.removeItem(logKey);
        window.location.reload();
      } catch (error) {
        setText("diag-action", "Session storage is unavailable, so capture cannot be enabled in this browser.");
      }
    });
    if (stop) stop.addEventListener("click", function () {
      try {
        window.sessionStorage.setItem(captureKey, "0");
        window.location.reload();
      } catch (error) {}
    });
    if (clear) clear.addEventListener("click", function () {
      try {
        window.sessionStorage.removeItem(logKey);
        window.location.reload();
      } catch (error) {}
    });
    if (copy) copy.addEventListener("click", copyReport);
    if (install) install.addEventListener("click", installApp);
  }

  function initPage() {
    if (!page.ready) return;
    if (window.location.pathname !== "/diagnostics" && window.location.pathname !== "/diagnostics/") return;
    var start = byId("diag-start");
    if (!start || start === page.start) return;
    page.start = start;
    page.manifest = null;
    page.worker = null;
    page.install = null;
    wirePage(start);
    setText("diag-env", JSON.stringify(environment(), null, 2));
    void checkManifest();
    void checkWorker();
    refreshReport();
    if (page.timer) window.clearInterval(page.timer);
    page.timer = window.setInterval(refreshReport, 1200);
  }

  // Do not replace server-rendered text until React has hydrated. If the app
  // did not hydrate, fall back after five seconds so diagnostics still work.
  var hydrationPoll = window.setInterval(function () {
    if (document.documentElement.dataset.atwHydrated !== "true") return;
    window.clearInterval(hydrationPoll);
    page.ready = true;
    initPage();
  }, 100);
  window.setTimeout(function () {
    window.clearInterval(hydrationPoll);
    if (page.ready) return;
    page.ready = true;
    initPage();
  }, 5000);

  // A failed client bundle is otherwise silent. Record it separately from the
  // worker state so the report can say whether React ran at all.
  window.setTimeout(function () {
    if (document.documentElement.dataset.atwHydrated === "true") return;
    record("hydration-timeout", hydrationState());
    setText("diag-hydration", JSON.stringify(hydrationState(), null, 2));
    setText(
      "diag-action",
      "React did not hydrate this page. The HTML is visible, but controls that depend on React cannot work. Copy this report before reloading.",
    );
  }, 12000);

  window.setInterval(initPage, 700);
})();
