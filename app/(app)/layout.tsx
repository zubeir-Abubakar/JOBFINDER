import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { unreadNotificationCount } from "@/lib/notify";
import { avatarUrlFor } from "@/lib/account";
import { chatHistory } from "@/lib/chat";

export const dynamic = "force-dynamic";

export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  if (user.must_change_password) redirect("/change-password");
  return (
    <AppShell
      user={{ name: user.name, email: user.email, role: user.role, avatarUrl: avatarUrlFor(user) }}
      variant="app"
      unreadCount={unreadNotificationCount()}
      assistantMessages={chatHistory(user.id, 30).map((message) => ({ id: message.id, role: message.role, content: message.content, created_at: message.created_at }))}
    >
      {children}
    </AppShell>
  );
}
