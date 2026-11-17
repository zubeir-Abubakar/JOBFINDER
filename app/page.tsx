import { redirect } from "next/navigation";
import { currentUser, hasAnyUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!hasAnyUser()) redirect("/setup");
  const user = await currentUser();
  if (!user) redirect("/login");
  redirect(user.role === "admin" ? "/admin" : "/dashboard");
}
