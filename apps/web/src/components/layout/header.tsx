import { signOutAction } from "@/lib/actions/auth";
import type { AuthUser } from "@/lib/auth/get-user";
import { resolveCompanyBranding } from "@/lib/branding/service";

interface HeaderProps {
  title?: string;
  user: AuthUser;
}

function greetingFor(roles: string[]): string {
  if (roles.includes("owner")) return "Selamat Datang, Owner";
  if (roles.includes("sales")) return "Selamat Datang di AI Operating Distributor Platform (AODP)";
  return "";
}

const ROLE_LABEL: Record<string, string> = {
  super_admin: "Super Admin",
  owner: "Owner",
  manager: "Manager",
  sales: "Sales",
  admin: "Admin",
  warehouse: "Warehouse",
  finance: "Finance",
  driver: "Driver",
};

export function Header({ title, user }: HeaderProps) {
  const primaryRole = user.roles[0] ?? "user";
  const roleLabel = ROLE_LABEL[primaryRole] ?? primaryRole;
  const branding = resolveCompanyBranding(user.company);
  const greeting = greetingFor(user.roles);

  return (
    <header className="flex h-14 items-center justify-between border-b border-gray-200 bg-white px-6">
      {title && (
        <h1 className="text-sm font-semibold text-gray-900">{title}</h1>
      )}
      {!title && greeting && (
        <div className="leading-tight">
          <p className="text-sm font-semibold text-gray-900">{greeting}</p>
          <p className="text-xs text-gray-500">{branding.name}</p>
        </div>
      )}
      {!title && !greeting && <div />}

      <div className="flex items-center gap-4">
        {branding.isDemoEnvironment && (
          <span
            title="Tenant ini ditandai environment DEMO (companies.settings.environment)"
            className="inline-flex items-center gap-1 rounded-full border border-purple-200
              bg-purple-100 px-2 py-0.5 text-xs font-semibold text-purple-700"
          >
            DEMO ENVIRONMENT
          </span>
        )}
        {user.isDemo && (
          <span
            title="Sesi ini adalah bypass login untuk demo lokal — tidak melalui Supabase Auth"
            className="inline-flex items-center gap-1 rounded-full border border-amber-200
              bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700"
          >
            🧪 Demo Mode
          </span>
        )}
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-100 text-xs font-semibold text-blue-700">
            {user.email.charAt(0).toUpperCase()}
          </div>
          <div className="hidden sm:block">
            <p className="text-xs font-medium text-gray-900 leading-tight">
              {user.email}
            </p>
            <p className="text-xs text-gray-500">{roleLabel}</p>
          </div>
        </div>

        <form action={signOutAction}>
          <button
            type="submit"
            className="rounded-md px-3 py-1.5 text-xs font-medium text-gray-600
              border border-gray-200 hover:bg-gray-50 hover:text-gray-900
              focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1
              transition-colors"
          >
            Keluar
          </button>
        </form>
      </div>
    </header>
  );
}
