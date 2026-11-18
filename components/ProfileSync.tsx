"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { syncProfileAction } from "@/lib/actions/profile";

/**
 * The first open of the profile imports the active CV once. This lives in a
 * client effect rather than the server render so a build or preview can never
 * mutate profile data, and the source marker prevents repeated imports.
 */
export function ProfileSync() {
  const router = useRouter();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let active = true;
    syncProfileAction()
      .then((result) => {
        if (active && (result.experiences > 0 || result.skills > 0 || result.languages > 0)) router.refresh();
      })
      .catch(() => {
        // Import is best-effort; the existing verified profile remains usable.
      });
    return () => {
      active = false;
    };
  }, [router]);

  return null;
}
