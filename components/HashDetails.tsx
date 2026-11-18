"use client";

import { useEffect } from "react";

/**
 * Opens a native <details> accordion when the user arrives through an anchor
 * link (for example /profile#experience). No data or form state is involved.
 */
export function HashDetails({ ids }: { ids: string[] }) {
  useEffect(() => {
    const open = () => {
      const id = window.location.hash.slice(1);
      if (!id || !ids.includes(id)) return;
      const node = document.getElementById(id);
      if (node instanceof HTMLDetailsElement) node.open = true;
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, [ids]);

  return null;
}
