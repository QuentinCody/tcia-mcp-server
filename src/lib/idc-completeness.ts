import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { isRecord } from "./idc-http";

/** Successful storage does not make a capped provider response complete. */
export function idcCompleteness(data: unknown): Awaited<ReturnType<ApiFetchFn>>["completeness"] {
  if (!isRecord(data)) return undefined;
  if (isRecord(data._idc_objects) && isRecord(data.pagination)) {
    return { complete: !data.pagination.has_more && data.pagination.page_token === null,
      returned: Array.isArray(data.files) ? data.files.length : 0,
      ...(data.pagination.has_more || data.pagination.page_token !== null ? { truncation: {
        reason: "page_limit" as const, detail: "This response contains one GCS object page.",
        remedy: "Follow pagination.next with its identity guards; retain and combine every page." } } : {}) };
  }
  if (!data._idc) return undefined;
  if (typeof data.truncated === "boolean") {
    return { complete: !data.truncated,
      ...(typeof data.row_count === "number" ? { returned: data.row_count } : {}),
      ...(data.truncated ? { truncation: { reason: "upstream_cap" as const,
        detail: "IDC reports truncated=true; the stored page is not the full query result.",
        remedy: "Narrow the query or request ordered disjoint subsets and verify coverage." } } : {}) };
  }
  if (typeof data.total_series === "number" && typeof data.returned === "number") {
    const complete = data.returned === data.total_series && data.page === 0;
    return { complete, returned: data.returned, total_available: data.total_series,
      ...(!complete ? { truncation: { reason: "page_limit" as const,
        detail: "Only this series manifest page is stored.", remedy: "Request remaining pages against the same observed index and combine them." } } : {}) };
  }
  if (typeof data.manifest_text === "string") return { complete: false, truncation: { reason: "unknown",
    detail: "Text manifests are provider-capped series prefixes without a completeness verdict.",
    remedy: "Compare with cohort counts before claiming a complete series manifest." } };
  return undefined;
}
