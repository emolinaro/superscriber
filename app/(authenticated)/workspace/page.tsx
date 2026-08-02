import { InlineNotice } from "@/components/ui/inline-notice";
import { WorkInbox } from "@/components/work/work-inbox";
import { listWorkInbox, parseWorkInboxFilters } from "@/server/work-inbox/service";
import { requireActivePrincipal } from "@/server/session";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function WorkspacePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const principal = await requireActivePrincipal("/workspace");
  const filters = parseWorkInboxFilters(params, principal.role);
  const model = listWorkInbox(principal, {
    tab: filters.tab,
    query: filters.query,
    stage: filters.stage ?? undefined,
    source: filters.source ?? undefined,
    assignmentUserId: filters.assignmentUserId ?? undefined,
    sort: filters.sort === "default" ? undefined : filters.sort,
  });
  const notice = firstValue(params.notice);
  const error = firstValue(params.error);

  return (
    <div className="shell shell-wide workspace-shell">
      <div className="work-page-shell">
        {notice ? <InlineNotice tone="success">{notice}</InlineNotice> : null}
        {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
        <WorkInbox model={model} />
      </div>
    </div>
  );
}
