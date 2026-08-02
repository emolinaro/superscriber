import { notFound, redirect } from "next/navigation";
import {
  saveDraftAction,
  submitRevisionAction,
} from "@/server/actions/casefile-actions";
import { CasefileCommandError } from "@/server/casefile/errors";
import { getCasefile } from "@/server/casefile/read-model";
import { requireActivePrincipal } from "@/server/session";
import { CasefileWorkspace } from "@/components/casefile/casefile-workspace";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type Params = Promise<{ recordingId: string }>;

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function safeQueryValue(value: string | string[] | undefined) {
  return firstValue(value)?.trim() || null;
}

function buildReturnTo(
  recordingId: string,
  params: Record<string, string | string[] | undefined>,
) {
  const search = new URLSearchParams();
  const revisionId = safeQueryValue(params.revision);
  const actionModeId = safeQueryValue(params.actionMode);

  if (revisionId) {
    search.set("revision", revisionId);
  }
  if (actionModeId) {
    search.set("actionMode", actionModeId);
  }

  const query = search.toString();
  return query
    ? `/recordings/${encodeURIComponent(recordingId)}?${query}`
    : `/recordings/${encodeURIComponent(recordingId)}`;
}

export default async function RecordingPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const resolvedParams = await params;
  const resolvedSearch = await searchParams;
  const principal = await requireActivePrincipal(
    buildReturnTo(resolvedParams.recordingId, resolvedSearch),
  );

  let casefile;
  try {
    casefile = getCasefile(principal, resolvedParams.recordingId, {
      revisionId: safeQueryValue(resolvedSearch.revision),
      actionModeId: safeQueryValue(resolvedSearch.actionMode),
    });
  } catch (error) {
    if (error instanceof CasefileCommandError && error.code === "ACCESS_DENIED") {
      redirect(
        `/workspace?error=${encodeURIComponent("This casefile is not available to your account.")}`,
      );
    }

    throw error;
  }

  if (!casefile) {
    notFound();
  }

  return (
    <CasefileWorkspace
      initialCasefile={casefile}
      saveAction={saveDraftAction}
      submitAction={submitRevisionAction}
    />
  );
}
