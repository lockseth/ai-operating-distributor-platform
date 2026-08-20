// =============================================================================
// Fondasi chatbot bisnis Owner -- Milestone 2 (Chat UI). Akses dibatasi
// owner/manager/super_admin, sama seperti Risk Alert & Executive
// Intelligence. Jawaban AI baru aktif setelah Milestone 4 (API key
// provider dikonfigurasi) -- lihat lib/owner-chat/chatbot.ts.
// =============================================================================

import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { PageHeader } from "@/components/ui/page-header";
import { OwnerChatPanel } from "@/components/owner-chat/owner-chat-panel";

export const metadata = { title: "Tanya AODP — AODP" };

export default async function OwnerChatPage() {
  const user = await getAuthUser();

  const hasAccess =
    user.roles.includes("super_admin") || user.roles.includes("owner") || user.roles.includes("manager");
  if (!hasAccess) redirect("/dashboard");

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="Tanya AODP"
        subtitle="Tanya apa saja soal bisnis kamu -- dijawab dari data governed yang sama dengan dashboard."
      />
      <OwnerChatPanel />
    </div>
  );
}
