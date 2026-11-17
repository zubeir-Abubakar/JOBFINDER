"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createDraft, disconnectGmail, gmailMissing, sendApprovedDraft, syncInbox } from "@/lib/gmail";
import { audit } from "@/lib/audit";

export async function connectGmailAction(): Promise<void> {
  await requireUser();
  const missing = gmailMissing();
  if (missing.length > 0) redirect(`/inbox?error=${encodeURIComponent(missing.join(" "))}`);
  redirect("/api/gmail/oauth/start");
}

export async function disconnectGmailAction(): Promise<void> {
  const user = await requireUser();
  disconnectGmail();
  audit({ action: "gmail.disconnected", entity: "email", userId: user.id });
  revalidatePath("/inbox");
  redirect("/inbox?ok=Gmail+disconnected");
}

export async function syncGmailAction(): Promise<void> {
  const user = await requireUser();
  try {
    const result = await syncInbox(20);
    audit({ action: "gmail.synced", entity: "email", detail: `${result.scanned} scanned, ${result.inserted} new`, userId: user.id });
    revalidatePath("/inbox");
    redirect(`/inbox?ok=${encodeURIComponent(`Scanned ${result.scanned} message(s), ${result.inserted} new, ${result.matched} matched.`)}`);
  } catch (error) {
    redirect(`/inbox?error=${encodeURIComponent(error instanceof Error ? error.message : "Gmail sync failed")}`);
  }
}

export async function createGmailDraftAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const emailId = String(formData.get("email_id") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  if (!body) redirect("/inbox?error=" + encodeURIComponent("Write the reply before creating a draft."));
  try {
    await createDraft(emailId, body);
    audit({ action: "gmail.draft_created", entity: "email", entityId: emailId, userId: user.id });
    revalidatePath("/inbox");
    redirect("/inbox?ok=" + encodeURIComponent("Draft created in Gmail. It has not been sent."));
  } catch (error) {
    redirect("/inbox?error=" + encodeURIComponent(error instanceof Error ? error.message : "Draft creation failed"));
  }
}

/** Sending only happens from this explicit approval action. */
export async function sendApprovedDraftAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const emailId = String(formData.get("email_id") ?? "");
  try {
    await sendApprovedDraft(emailId);
    audit({ action: "gmail.draft_sent", entity: "email", entityId: emailId, detail: "Explicit user approval", userId: user.id });
    revalidatePath("/inbox");
    redirect("/inbox?ok=" + encodeURIComponent("Approved draft sent."));
  } catch (error) {
    redirect("/inbox?error=" + encodeURIComponent(error instanceof Error ? error.message : "Sending failed"));
  }
}
