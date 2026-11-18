"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Props = { id: string; name: string; mime: string };

/**
 * In-app preview. PDF.js and docx-preview are loaded lazily the first time a
 * document is opened, so the dashboard never pays for viewer code up front.
 */
export function DocumentPreview({ id, name, mime }: Props) {
  const isPdf = mime.includes("pdf");
  const url = `/api/documents/${id}?inline=1`;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const docRef = useRef<any>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(true);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Array<{ page: number; snippet: string }>>([]);
  const [searching, setSearching] = useState(false);
  const [source, setSource] = useState("");
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!fullscreen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [fullscreen]);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setError("");
    setPage(1);
    setPageCount(0);
    setMatches([]);
    setSource("");
    (async () => {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(response.status === 401 ? "Your session expired. Sign in again." : "This document could not be loaded.");
        }
        const blob = await response.blob();
        if (isPdf) {
          const pdfjs: any = await import("pdfjs-dist");
          pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
          const doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
          if (cancelled) {
            void doc.destroy?.();
            return;
          }
          docRef.current = doc;
          setPageCount(doc.numPages);
          setState("ready");
          setSource("PDF.js");
        } else {
          const { renderAsync } = await import("docx-preview");
          const host = hostRef.current;
          if (!host) throw new Error("The preview area is not available.");
          host.innerHTML = "";
          await renderAsync(blob, host, undefined, { className: "docx", inWrapper: true, ignoreWidth: false, ignoreHeight: false });
          if (!cancelled) {
            setState("ready");
            setSource("docx-preview");
          }
        }
      } catch (caught) {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : "Preview failed.");
        setState("error");
      }
    })();
    return () => {
      cancelled = true;
      try {
        void docRef.current?.destroy?.();
      } catch {
        // Already destroyed.
      }
      docRef.current = null;
    };
  }, [id, isPdf, url]);

  useEffect(() => {
    if (state !== "ready" || !isPdf || !docRef.current) return;
    let cancelled = false;
    (async () => {
      const doc = docRef.current;
      const pdfPage = await doc.getPage(page);
      if (cancelled) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const width = hostRef.current?.clientWidth ?? 820;
      const scale = fit ? Math.min(1.8, Math.max(0.5, (width - 8) / base.width)) : zoom;
      const viewport = pdfPage.getViewport({ scale });
      const canvas = canvasRef.current;
      if (!canvas) return;
      const context = canvas.getContext("2d");
      if (!context) return;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      await pdfPage.render({
        canvasContext: context,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      } as any).promise;
    })().catch(() => {
      if (!cancelled) setError("This page could not be rendered.");
    });
    return () => {
      cancelled = true;
    };
  }, [state, isPdf, page, zoom, fit, fullscreen]);

  const search = useCallback(async () => {
    const needle = query.trim().toLowerCase();
    if (!needle || !docRef.current) return;
    setSearching(true);
    const found: Array<{ page: number; snippet: string }> = [];
    try {
      const total = docRef.current.numPages as number;
      for (let index = 1; index <= total; index += 1) {
        const pdfPage = await docRef.current.getPage(index);
        const content = await pdfPage.getTextContent();
        const text = (content.items as Array<{ str?: string }>).map((item) => item.str ?? "").join(" ").replace(/\s+/g, " ");
        const at = text.toLowerCase().indexOf(needle);
        if (at >= 0) found.push({ page: index, snippet: text.slice(Math.max(0, at - 70), Math.min(text.length, at + 150)) });
        if (found.length >= 30) break;
      }
      setMatches(found);
      if (found[0]) {
        setPage(found[0].page);
        setFit(true);
      }
    } finally {
      setSearching(false);
    }
  }, [query]);

  const print = useCallback(() => {
    const frame = document.createElement("iframe");
    frame.style.position = "fixed";
    frame.style.right = "0";
    frame.style.bottom = "0";
    frame.style.width = "0";
    frame.style.height = "0";
    frame.style.border = "0";
    frame.src = url;
    frame.onload = () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      } catch {
        setError("Your browser blocked printing this preview. Use Download instead.");
      }
      setTimeout(() => frame.remove(), 60_000);
    };
    document.body.appendChild(frame);
  }, [url]);

  return (
    <div className={`doc-preview ${fullscreen ? "is-fullscreen" : ""}`} role={fullscreen ? "dialog" : undefined} aria-modal={fullscreen || undefined} aria-label={fullscreen ? `${name} full screen preview` : undefined}>
      <div className="doc-toolbar">
        {fullscreen ? (
          <button type="button" className="doc-close" onClick={() => setFullscreen(false)} aria-label="Exit full screen">×</button>
        ) : null}
        {isPdf ? (
          <>
            <button type="button" className="btn btn-sm" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1} aria-label="Previous page">‹</button>
            <span className="doc-page num">{page} / {pageCount || "…"}</span>
            <button type="button" className="btn btn-sm" onClick={() => setPage((value) => Math.min(pageCount || value, value + 1))} disabled={!pageCount || page >= pageCount} aria-label="Next page">›</button>
            <span className="doc-sep" />
            <button type="button" className="btn btn-sm" onClick={() => { setFit(false); setZoom((value) => Math.max(0.5, value - 0.15)); }} aria-label="Zoom out">−</button>
            <span className="doc-zoom num">{fit ? "fit" : `${Math.round(zoom * 100)}%`}</span>
            <button type="button" className="btn btn-sm" onClick={() => { setFit(false); setZoom((value) => Math.min(2.5, value + 0.15)); }} aria-label="Zoom in">+</button>
            <button type="button" className="btn btn-sm" onClick={() => setFit(true)}>Fit</button>
          </>
        ) : (
          <span className="doc-page">Formatted Word preview</span>
        )}
        <span className="doc-sep" />
        <button type="button" className="btn btn-sm" onClick={() => void search()} disabled={!isPdf || searching || !query.trim()}>
          {searching ? "Searching…" : "Search"}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setFullscreen((value) => !value)}
          aria-pressed={fullscreen}
        >
          {fullscreen ? "Exit full screen" : "Full screen"}
        </button>
        <button type="button" className="btn btn-sm" onClick={print}>Print</button>
        <a href={url} download={name} className="btn btn-sm">Download</a>
        <span className="doc-source">{source}</span>
      </div>

      {isPdf ? (
        <div className="doc-searchbar">
          <input
            className="input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void search();
            }}
            placeholder="Search this document…"
            aria-label="Search document text"
          />
          {matches.length > 0 ? <span className="text-[11px]" style={{ color: "var(--muted)" }}>{matches.length} page(s) matched</span> : null}
        </div>
      ) : null}

      {matches.length > 0 ? (
        <div className="doc-matches">
          {matches.map((match) => (
            <button key={match.page} type="button" className="doc-match" onClick={() => setPage(match.page)}>
              <strong>p.{match.page}</strong> {match.snippet}
            </button>
          ))}
        </div>
      ) : null}

      {state === "loading" ? <div className="doc-loading">Loading preview…</div> : null}
      {state === "error" ? (
        <div className="doc-loading doc-error">
          <p>{error}</p>
          <a href={url} className="btn btn-sm">Download instead</a>
        </div>
      ) : null}

      <div className={`doc-stage ${state === "ready" ? "ready" : ""}`} ref={hostRef}>
        {isPdf ? <canvas ref={canvasRef} className="doc-canvas" aria-label={`${name} preview`} /> : null}
      </div>
      <p className="doc-hint">
        Served through your authenticated session. {isPdf ? "PDF pages preserve the generated layout." : "Word preview approximates pagination in the browser; download the DOCX for the exact file."}
      </p>
    </div>
  );
}
