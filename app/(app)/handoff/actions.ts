"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { markEmailHandoffSent } from "@/lib/email-handoff";

export async function markEmailHandoffSentAction(formData: FormData): Promise<void> {
  await requireUser();
  const applicationId = String(formData.get("applicationId") ?? "");
  const note = String(formData.get("note") ?? "");
  const result = markEmailHandoffSent({ applicationId, note });
  revalidatePath("/handoff");
  revalidatePath("/recruitment");
  if (!result.ok) redirect(`/handoff?error=${encodeURIComponent(result.error)}`);
  redirect(
    `/handoff?ok=${encodeURIComponent(
      result.alreadySent ? "This application was already marked as sent." : "Marked as sent. Employer confirmation is still pending.",
    )}`,
  );
}
