import { getAuthUser } from "@/lib/auth/get-user";
import { getDashboardHref } from "@/lib/auth/permissions";
import { redirect } from "next/navigation";

export default async function DashboardRootPage() {
  const user = await getAuthUser();
  redirect(getDashboardHref(user.roles));
}
