"use client";

import { useEffect, useRef, useState } from "react";
import { setScreenShare, useVisualSession } from "@/lib/visual-session";

type ShareState = "idle" | "requesting" | "sharing" | "denied" | "unsupported" | "ended" | "error";

const STATE_LABEL: Record<ShareState, string> = {
  idle: "Screen not shared",
  requesting: "Waiting for your browser permission…",
  sharing: "Sharing the selected tab or window",
  denied: "Screen sharing was declined",
  unsupported: "This browser does not support screen sharing",
  ended: "Screen sharing stopped",
  error: "Screen sharing could not start",
};

/**
 * Explicit, user-initiated screen sharing.
 *
 * Only getDisplayMedia is used, only after a click, and the browser picker
 * decides what is shared. Nothing is recorded. A frame is transmitted only when
 * the owner presses “Ask about this screen”.
 */
export function ScreenShareControl() {
  const visual = useVisualSession();
  const [state, setState] = useState<ShareState>("idle");
  const [error, setError] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [asking, setAsking] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  function stopTracks(): void {
    const stream = streamRef.current;
    streamRef.current = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
    if (videoRef.current) videoRef.current.srcObject = null;
  }

  function stop(): void {
    stopTracks();
    setState((previous) => (previous === "sharing" || previous === "requesting" ? "ended" : previous));
    setScreenShare(null);
    setAnswer("");
  }

  async function start(): Promise<void> {
    setError("");
    setAnswer("");
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {
      setState("unsupported");
      return;
    }
    setState("requesting");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      track?.addEventListener("ended", () => {
        stopTracks();
        setState("ended");
        setScreenShare(null);
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        // A hidden preview can keep play() pending; sharing must not depend on it.
        void videoRef.current.play().catch(() => undefined);
      }
      setState("sharing");
      setScreenShare(track?.label || "a browser tab or window");
    } catch (cause) {
      stopTracks();
      setScreenShare(null);
      const name = cause instanceof DOMException ? cause.name : "";
      if (name === "NotAllowedError" || name === "AbortError") {
        setState("denied");
        setError("The browser permission was declined, so no screen content was accessed or sent.");
      } else {
        setState("error");
        setError(cause instanceof Error ? cause.message : "Screen sharing could not start.");
      }
    }
  }

  async function ask(): Promise<void> {
    const video = videoRef.current;
    if (!video || !streamRef.current) return;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) {
      setError("The shared screen has no readable frame yet.");
      return;
    }
    const scale = Math.min(1, 1280 / width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext("2d");
    if (!context) {
      setError("This browser could not capture a frame.");
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageDataUrl = canvas.toDataURL("image/jpeg", 0.72);
    setAsking(true);
    setError("");
    setAnswer("");
    try {
      const response = await fetch("/api/vision/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: imageDataUrl, question }),
      });
      const payload = (await response.json().catch(() => ({}))) as { text?: string; error?: string; model?: string };
      if (!response.ok) throw new Error(payload.error ?? `Visual understanding returned HTTP ${response.status}.`);
      setAnswer(`${payload.text ?? ""}${payload.model ? `\n\nProvider: Gemini ${payload.model}. One frame was sent because you asked.` : ""}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Visual understanding failed.");
    } finally {
      setAsking(false);
    }
  }

  // Leaving Visual Companion Mode, or disconnecting the voice session, always
  // stops capture. There is no hidden or background capture.
  useEffect(() => {
    if (!visual.active && streamRef.current) stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visual.active]);

  useEffect(() => () => stopTracks(), []);

  const sharing = state === "sharing";

  return (
    <div className="vc-share" data-testid="screen-share">
      <video ref={videoRef} muted playsInline className="vc-share-video" aria-hidden="true" />
      <div className="vc-share-row">
        <span
          className={`vc-share-state ${sharing ? "is-live" : ""}`}
          data-testid="screen-share-status"
          aria-live="polite"
        >
          <i aria-hidden="true" /> {STATE_LABEL[state]}
        </span>
        {sharing ? (
          <>
            <button type="button" className="btn btn-sm" onClick={stop} data-testid="screen-share-stop">
              Stop sharing
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => void ask()}
              disabled={asking}
              data-testid="visual-ask-screen"
            >
              {asking ? "Looking…" : "Ask about this screen"}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void start()}
            disabled={state === "requesting"}
            data-testid="screen-share-start"
          >
            Share screen
          </button>
        )}
      </div>
      {sharing ? (
        <p className="vc-share-note">
          You chose this tab or window. Nothing is recorded, and no frame is sent unless you ask about it.
        </p>
      ) : null}
      {state === "denied" || state === "unsupported" || state === "error" ? (
        <p className="vc-share-error" role="alert" data-testid="screen-share-error">
          {error || STATE_LABEL[state]}
        </p>
      ) : null}
      {sharing ? (
        <div className="vc-vision">
          <input
            className="input"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="What should I explain about this screen?"
            aria-label="Question about the shared screen"
          />
          {answer ? (
            <p className="vc-vision-answer" data-testid="visual-vision-result">
              {answer}
            </p>
          ) : null}
          {error && sharing ? (
            <p className="vc-share-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
