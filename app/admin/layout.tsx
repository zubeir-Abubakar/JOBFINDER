import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { avatarUrlFor } from "@/lib/account";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireAdmin();
  if (user.must_change_password) redirect("/change-password");
  return (
    <AppShell user={{ name: user.name, email: user.email, role: user.role, avatarUrl: avatarUrlFor(user) }} variant="admin">
      {children}
    </AppShell>
  );
}
