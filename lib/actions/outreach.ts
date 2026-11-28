"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { reconcileOutreachFromGmail } from "@/lib/outreach";

/**
 * Refresh one draft's state from Gmail. This only observes: it never creates a
 * draft, never sends, and leaves the stored state untouched when Gmail cannot
 * prove a sent copy exists.
 */
export async function reconcileOutreachAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  const returnTo = String(formData.get("return_to") ?? "/recruitment");
  const base = returnTo.startsWith("/outreach/") || returnTo === "/recruitment" ? returnTo : "/recruitment";
  let outcome: { ok: boolean; message: string };
  try {
    const status = await reconcileOutreachFromGmail(id);
    audit({
      action: "outreach.reconciled",
      entity: "outreach_draft",
      entityId: id,
      detail: status,
      userId: user.id,
    });
    outcome = {
      ok: true,
      message:
        status === "sent"
          ? "A sent copy was observed in Gmail. The draft is recorded as sent by you."
          : status === "draft_missing"
            ? "The draft is no longer present in Gmail."
            : "No sent copy was found. The draft remains a draft; nothing was sent.",
    };
  } catch (error) {
    outcome = {
      ok: false,
      message: error instanceof Error ? error.message.slice(0, 400) : "Gmail reconciliation failed.",
    };
  }
  revalidatePath("/recruitment");
  revalidatePath(`/outreach/${id}`);
  redirect(`${base}?${outcome.ok ? "ok" : "error"}=${encodeURIComponent(outcome.message)}`);
}
