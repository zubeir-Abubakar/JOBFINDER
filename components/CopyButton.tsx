"use client";

import { useState } from "react";

/**
 * Copies text the owner can see on screen. It reports failure instead of
 * silently pretending the clipboard call worked.
 */
export function CopyButton({
  text,
  label = "Copy email text",
  className = "btn btn-sm",
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2500);
  }

  return (
    <button type="button" className={className} onClick={copy}>
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed — select the text" : label}
    </button>
  );
}
