"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

type State = { failed: boolean };

/**
 * The orb is a visual enhancement. If a device cannot create a WebGL context,
 * keep the live-voice controls usable and report the failure to diagnostics
 * instead of letting the React error unmount the whole shell.
 */
export class CosmicOrbBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    try {
      window.dispatchEvent(new CustomEvent("atw:diagnostic", {
        detail: {
          type: "orb-error",
          data: {
            message: error.message,
            componentStack: info.componentStack?.slice(0, 500) ?? "",
          },
        },
      }));
    } catch {
      // Diagnostics must never interfere with the voice panel.
    }
  }

  render() {
    if (this.state.failed) return <div className="lv-orb-fallback" aria-hidden="true"><span /></div>;
    return this.props.children;
  }
}
