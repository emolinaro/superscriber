import { redirect } from "next/navigation";
import { AdministrationShell } from "@/components/admin/administration-shell";
import { type AdministrationSection, listAdministration } from "@/server/administration/service";
import { requireActivePrincipal } from "@/server/session";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function parseAdministrationSection(value: string | string[] | undefined): AdministrationSection {
  const section = firstValue(value);
  if (section === "assignments" || section === "policy" || section === "discipline") {
    return section;
  }

  return "accounts";
}

function parseAdministrationFilters(
  section: AdministrationSection,
  values: Record<string, string | string[] | undefined>,
): Record<string, string> {
  if (section === "accounts") {
    const query = firstValue(values.query)?.trim() ?? "";
    return query ? { query } : {};
  }

  if (section === "assignments") {
    const filters: Record<string, string> = {};
    const status = firstValue(values.status);
    const recordingId = firstValue(values.recordingId)?.trim() ?? "";
    const userId = firstValue(values.userId)?.trim() ?? "";
    const role = firstValue(values.role)?.trim() ?? "";
    const from = firstValue(values.from)?.trim() ?? "";
    const to = firstValue(values.to)?.trim() ?? "";

    if (status === "history") {
      filters.status = status;
    }
    if (recordingId) {
      filters.recordingId = recordingId;
    }
    if (userId) {
      filters.userId = userId;
    }
    if (role === "reviewer" || role === "approver") {
      filters.role = role;
    }
    if (from) {
      filters.from = from;
    }
    if (to) {
      filters.to = to;
    }

    return filters;
  }

  return {};
}

export default async function AdministrationPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const principal = await requireActivePrincipal("/administration");

  if (principal.role !== "admin") {
    redirect(
      `/workspace?error=${encodeURIComponent("Only admin accounts can open administration.")}`,
    );
  }

  const section = parseAdministrationSection(params.section);
  const model = listAdministration(principal, {
    section,
    ...parseAdministrationFilters(section, params),
  });

  const notice = firstValue(params.notice);
  const pageError = firstValue(params.error);

  return <AdministrationShell error={pageError ?? null} model={model} notice={notice ?? null} section={section} />;
}
