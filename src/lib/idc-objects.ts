import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { idcFetch } from "./idc";
import { idcDeadline, idcError, idcJson, indexVersion, integer, isRecord } from "./idc-http";

// IDC's manifest service maps the AWS series prefix onto these GCS mirrors.
const BUCKETS = new Map([
  ["idc-open-data", "idc-open-data"],
  ["idc-open-data-two", "idc-open-idc1"],
  ["idc-open-data-cr", "idc-open-cr"],
]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const OPTIONS = new Set(["max_results", "page_token", "expected_index_version", "expected_series_uuid", "expected_bucket"]);
function fail(message: string, data: unknown, status = 502): never {
  throw Object.assign(new Error(`IDC objects: ${message}`), { status, data });
}

function prepare(request: Parameters<ApiFetchFn>[0]) {
  const [path, queryString, extra] = request.path.split("?");
  const match = /^\/idc\/series\/([0-9.]{1,64})\/objects$/.exec(path);
  if (!match || !/^(0|[1-9]\d*)(\.(0|[1-9]\d*))+$/.test(match[1])) idcError("objects requires an exact DICOM SeriesInstanceUID", 400);
  if (request.method.toUpperCase() !== "GET" || request.body !== undefined) idcError("object inventory accepts GET without a body");
  if (extra !== undefined) idcError("invalid query string");
  const params = { ...request.params };
  for (const [key, value] of new URLSearchParams(queryString)) {
    if (params[key] !== undefined) idcError(`duplicate query parameter ${key}`);
    params[key] = value;
  }
  for (const key of Object.keys(params)) if (!OPTIONS.has(key)) idcError(`unsupported object inventory parameter ${key}`);
  const maxResults = integer(params.max_results ?? 100, "max_results", 1, 1000);
  const expected = params.expected_index_version === undefined ? undefined : indexVersion(params.expected_index_version);
  const seriesUuid = params.expected_series_uuid;
  if (seriesUuid !== undefined && (typeof seriesUuid !== "string" || !UUID.test(seriesUuid))) idcError("expected_series_uuid must be a CRDC UUID");
  const bucket = params.expected_bucket;
  if (bucket !== undefined && (typeof bucket !== "string" || ![...BUCKETS.values()].includes(bucket))) idcError("unsupported expected_bucket");
  const token = params.page_token;
  if (token !== undefined && (typeof token !== "string" || token.length === 0 || token.length > 8192)) idcError("page_token must be a nonempty provider token (at most 8192 characters)");
  if (token !== undefined && (!expected || !seriesUuid || !bucket)) idcError("continuation requires expected_index_version, expected_series_uuid and expected_bucket from pagination.next.params");
  return { path, uid: match[1], maxResults, expected, seriesUuid, bucket, token };
}

function resolveSeries(manifest: Record<string, unknown>, uid: string) {
  const evidence = { manifest };
  const counts = manifest.counts;
  const filters = isRecord(counts) ? counts.filters_applied : undefined;
  const terms = isRecord(filters) ? filters.terms : undefined;
  const values = isRecord(terms) ? terms.SeriesInstanceUID : undefined;
  if (!isRecord(counts) || !isRecord(filters) || !isRecord(terms) || Object.keys(terms).length !== 1 ||
      !Array.isArray(values) || values.length !== 1 || values[0] !== uid ||
      (filters.ranges !== undefined && (!isRecord(filters.ranges) || Object.keys(filters.ranges).length !== 0))) {
    fail("provider did not confirm the exact series filter", evidence);
  }
  if (!Array.isArray(manifest.series) || manifest.page !== 0 || manifest.page_size !== 1 || manifest.returned !== manifest.series.length) fail("invalid manifest page", evidence);
  if (manifest.total_series === 0 && counts.series === 0 && manifest.series.length === 0) fail("series is not in the observed IDC index", evidence, 404);
  if (manifest.total_series !== 1 || counts.series !== 1 || manifest.series.length !== 1) fail("series lookup is ambiguous or incomplete", evidence, 409);
  const row = manifest.series[0];
  if (!isRecord(row) || row.SeriesInstanceUID !== uid || typeof row.aws_bucket !== "string" ||
      typeof row.crdc_series_uuid !== "string" || !UUID.test(row.crdc_series_uuid)) fail("invalid series cloud identity", evidence);
  const bucket = BUCKETS.get(row.aws_bucket);
  if (!bucket) fail("series uses an unsupported cloud bucket", evidence);
  if (row.series_aws_url !== `s3://${row.aws_bucket}/${row.crdc_series_uuid}/*`) fail("series URL and cloud identity disagree", evidence);
  return { bucket, uuid: row.crdc_series_uuid, prefix: `${row.crdc_series_uuid}/` };
}

function listObjects(raw: unknown, bucket: string, prefix: string, maxResults: number, previousToken: unknown, evidence: unknown) {
  if (!isRecord(raw) || raw.kind !== "storage#objects" ||
      (raw.items !== undefined && !Array.isArray(raw.items)) ||
      (raw.prefixes !== undefined && (!Array.isArray(raw.prefixes) || raw.prefixes.length > 0))) fail("invalid full-object listing", evidence);
  const token = raw.nextPageToken;
  if (token !== undefined && (typeof token !== "string" || !token || token.length > 8192 || token === previousToken)) fail("invalid or repeated continuation token", evidence);
  const items = raw.items ?? [];
  if (items.length > maxResults) fail("provider exceeded the requested page size", evidence);
  const seen = new Set<string>();
  const files = items.map((item: unknown) => {
    if (!isRecord(item) || item.kind !== "storage#object" || item.bucket !== bucket ||
        typeof item.name !== "string" || !item.name.startsWith(prefix) || item.name.length === prefix.length ||
        typeof item.generation !== "string" || !/^[1-9]\d*$/.test(item.generation) ||
        typeof item.size !== "string" || !/^(0|[1-9]\d*)$/.test(item.size)) fail("invalid object identity, generation or size", evidence);
    if (seen.has(item.name)) fail("duplicate live object name in page", evidence);
    seen.add(item.name);
    let name: string;
    try { name = encodeURIComponent(item.name); }
    catch { return fail("invalid object name encoding", evidence); }
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${name}`);
    url.searchParams.set("alt", "media");
    url.searchParams.set("generation", item.generation);
    return { bucket, name: item.name, generation: item.generation, size: item.size,
      md5Hash: item.md5Hash ?? null, crc32c: item.crc32c ?? null, download_url: url.href };
  });
  return { files, token };
}

/** One exact-series metadata page; never follows a continuation or downloads image bytes. */
export async function idcObjects(request: Parameters<ApiFetchFn>[0]) {
  const options = prepare(request);
  return idcDeadline(async signal => {
    const { url, scope, manifest, version } = await prepareObjectListing(options, signal);
    try {
      const { data: listing, ...observation } = await idcJson(url.href, { signal, headers: { Accept: "application/json" } });
      const { files, token } = listObjects(listing, scope.bucket, scope.prefix, options.maxResults, options.token, { listing, observation });
      return { manifest, listing, files,
        pagination: { returned: files.length, max_results: options.maxResults, page_token: options.token ?? null,
          has_more: token !== undefined, next: token === undefined ? null : { path: options.path, params: {
            max_results: options.maxResults, page_token: token, expected_index_version: version,
            expected_series_uuid: scope.uuid, expected_bucket: scope.bucket } } },
        _idc_objects: { ...observation, series_instance_uid: options.uid, crdc_series_uuid: scope.uuid,
          bucket: scope.bucket, prefix: scope.prefix, granularity: "cloud_object", checksum_status: "advertised_unverified",
          scope: "one page of current GCS objects; not an atomic or historical snapshot, DICOM instance validation, or a count reconciliation",
          image_bytes_downloaded: false } };
    } catch (error) {
      const upstream = error as Error & { status?: number; data?: unknown };
      throw Object.assign(new Error(upstream.message), { status: upstream.status ?? 502,
        data: { manifest, source_url: url.href, upstream: upstream.data ?? null, inventory_complete: false } });
    }
  });
}

async function prepareObjectListing(options: { path: string; uid: string; maxResults: number; expected: string | undefined; seriesUuid: string | undefined; bucket: string | undefined; token: string | undefined; }, signal: AbortSignal) {
  const manifest: Record<string, unknown> = await idcFetch({
    method: "POST", path: "/idc/v3/cohort/manifest",
    params: options.expected ? { expected_index_version: options.expected } : {},
    body: { filters: { terms: { SeriesInstanceUID: [options.uid] } }, page: 0, page_size: 1, include_rows: true }
  }, signal);
  const scope = resolveSeries(manifest, options.uid);
  if ((options.seriesUuid && options.seriesUuid !== scope.uuid) || (options.bucket && options.bucket !== scope.bucket)) fail("series cloud identity changed; restart the listing", { manifest }, 409);
  const provenance = manifest._idc;
  const version = isRecord(provenance) && isRecord(provenance.version) ? provenance.version.idc_index_data_version : undefined;
  if (typeof version !== "string") fail("missing manifest index observation", { manifest });
  const url = new URL(`https://storage.googleapis.com/storage/v1/b/${scope.bucket}/o`);
  url.searchParams.set("prefix", scope.prefix);
  url.searchParams.set("maxResults", String(options.maxResults));
  url.searchParams.set("projection", "noAcl");
  url.searchParams.set("versions", "false");
  if (typeof options.token === "string") url.searchParams.set("pageToken", options.token);
  return { url, scope, manifest, version };
}
