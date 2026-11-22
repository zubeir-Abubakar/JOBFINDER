import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { unreadNotificationCount } from "@/lib/notify";
import { avatarUrlFor } from "@/lib/account";
import { chatHistory } from "@/lib/chat";
import { AGENT_VOICE_PROFILES } from "@/lib/agent-voices";
import { effectiveVoiceProfileForAgent } from "@/lib/agent-voice-settings";

export const dynamic = "force-dynamic";

export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  if (user.must_change_password) redirect("/change-password");
  const voiceProfiles = Object.fromEntries(
    Object.keys(AGENT_VOICE_PROFILES).map((key) => {
      const profile = effectiveVoiceProfileForAgent(key);
      return [key, { voiceId: profile.voiceId, voiceName: profile.voiceName }];
    }),
  );
  return (
    <AppShell
      user={{ name: user.name, email: user.email, role: user.role, avatarUrl: avatarUrlFor(user) }}
      variant="app"
      unreadCount={unreadNotificationCount()}
      assistantMessages={chatHistory(user.id, 30).map((message) => ({ id: message.id, role: message.role, content: message.content, created_at: message.created_at }))}
      voiceProfiles={voiceProfiles}
    >
      {children}
    </AppShell>
  );
}
