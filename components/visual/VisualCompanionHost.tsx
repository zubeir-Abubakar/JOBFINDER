"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  clearVisualHighlight,
  exitVisualMode,
  markVisualReady,
  markVisualUnavailable,
  useVisualSession,
  visualDiagnostic,
} from "@/lib/visual-session";
import { ProviderStatusPill } from "./ProviderStatusPill";
import { ScreenShareControl } from "./ScreenShareControl";

type Rect = { top: number; left: number; width: number; height: number; bottom: number };

declare global {
  interface Window {
    __atwVisualCompanion?: () => Record<string, unknown>;
  }
}

/**
 * Visual Companion host.
 *
 * Mounted in the authenticated shell, so the voice component above it is never
 * remounted by an in-app navigation. Navigation comes from the server registry;
 * highlighting resolves a real `data-visual-id` element and draws nothing when
 * that element is absent.
 */
export function VisualCompanionHost() {
  const router = useRouter();
  const pathname = usePathname();
  const visual = useVisualSession();
  const [rect, setRect] = useState<Rect | null>(null);
  const [missing, setMissing] = useState(false);
  const [card, setCard] = useState<{ top: number; left: number } | null>(null);
  const lastNavigated = useRef("");

  useEffect(() => {
    window.__atwVisualCompanion = visualDiagnostic;
    return () => {
      delete window.__atwVisualCompanion;
    };
  }, []);

  // Route the browser to the approved destination once per command.
  useEffect(() => {
    if (!visual.active || !visual.href || visual.command?.type !== "navigate") return;
    const key = `${visual.commandId}:${visual.href}`;
    if (lastNavigated.current === key) return;
    lastNavigated.current = key;
    const currentPath = pathname ?? "";
    const targetPath = visual.href.split("#")[0];
    if (currentPath === targetPath) {
      markVisualReady();
      return;
    }
    router.push(visual.href);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visual.commandId, visual.href, visual.active]);

  // A navigation triggered here resolves when the real route is rendered.
  useEffect(() => {
    if (!visual.active || visual.status !== "opening" || !visual.href) return;
    if (pathname === visual.href.split("#")[0]) markVisualReady();
  }, [pathname, visual.active, visual.status, visual.href]);

  // Resolve and measure the real element; never paint for a missing target.
  useEffect(() => {
    const highlight = visual.highlight;
    if (!visual.active || !highlight) {
      setRect(null);
      setMissing(false);
      setCard(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let frame = 0;
    let disposed = false;

    const measure = () => {
      if (disposed) return;
      const element = document.querySelector<HTMLElement>(`[data-visual-id="${highlight.target}"]`);
      if (!element) {
        timer = setTimeout(() => find(1), 120);
        return;
      }
      const box = element.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) {
        setMissing(true);
        setRect(null);
        return;
      }
      setMissing(false);
      setRect({ top: box.top, left: box.left, width: box.width, height: box.height, bottom: box.bottom });
      const spaceRight = window.innerWidth - box.right;
      const cardWidth = Math.min(320, window.innerWidth - 32);
      const left = spaceRight > cardWidth + 24
        ? box.right + 16
        : Math.min(Math.max(16, box.left), window.innerWidth - cardWidth - 16);
      const top = Math.min(
        Math.max(72, box.bottom + 12),
        Math.max(72, window.innerHeight - 210),
      );
      setCard({ top, left });
    };

    const find = (attempt: number) => {
      if (disposed) return;
      const element = document.querySelector<HTMLElement>(`[data-visual-id="${highlight.target}"]`);
      if (!element) {
        if (attempt >= 14) {
          setMissing(true);
          setRect(null);
          return;
        }
        timer = setTimeout(() => find(attempt + 1), 120);
        return;
      }
      element.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      timer = setTimeout(measure, 340);
    };

    find(0);
    const onViewport = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    window.addEventListener("scroll", onViewport, true);
    window.addEventListener("resize", onViewport);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onViewport, true);
      window.removeEventListener("resize", onViewport);
    };
  }, [visual.active, visual.highlight?.target, visual.highlight?.explanation, pathname]);

  if (!visual.active) return null;

  return (
    <>
      <div className="vc-banner" role="region" aria-label="Visual companion" data-testid="visual-companion-banner">
        <div className="vc-banner-main">
          <span className="vc-banner-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M3 5.5h18v11H3zM8 20h8M12 16.5V20" />
              <path d="M7 11.5l2.4 2.2L14 9.2" />
            </svg>
          </span>
          <div className="vc-banner-copy">
            <strong>Visual companion · {visual.label || "Workspace walkthrough"}</strong>
            <span>
              {visual.sharing ? `Screen sharing: ${visual.sharing}` : "In-app guidance only · nothing is recorded"}
            </span>
          </div>
          <ProviderStatusPill compact />
        </div>
        <div className="vc-banner-actions">
          <ScreenShareControl />
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              clearVisualHighlight();
              exitVisualMode();
            }}
            data-testid="visual-companion-exit"
          >
            Exit
          </button>
        </div>
      </div>

      {rect ? (
        <div
          className="vc-spotlight"
          style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }}
          aria-hidden="true"
        />
      ) : null}

      {visual.highlight && rect && card ? (
        <div
          className="vc-highlight-card"
          role="dialog"
          aria-label={`Explanation of ${visual.highlight.label}`}
          style={{ top: card.top, left: card.left }}
          data-testid="visual-highlight"
          data-highlight-target={visual.highlight.target}
        >
          <div className="vc-highlight-kicker">Visual companion</div>
          <strong>{visual.highlight.label}</strong>
          <p>{visual.highlight.explanation}</p>
          <div className="vc-highlight-actions">
            <span className="vc-highlight-source">Real interface element</span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => clearVisualHighlight()}
              data-testid="visual-highlight-dismiss"
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {visual.highlight && missing ? (
        <div className="vc-highlight-card is-missing" role="alert" data-testid="visual-highlight-missing">
          <div className="vc-highlight-kicker">Not highlighted</div>
          <strong>{visual.highlight.label}</strong>
          <p>
            That element is not on this page, so nothing was highlighted. No placeholder or invented element was shown.
          </p>
          <div className="vc-highlight-actions">
            <span className="vc-highlight-source">Grounded in the page</span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                markVisualUnavailable("The requested element is not present on this page.");
                clearVisualHighlight();
              }}
              data-testid="visual-highlight-dismiss"
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
