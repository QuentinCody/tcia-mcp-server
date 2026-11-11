import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { idcDeadline, idcError, idcJson, indexVersion, integer, isRecord } from "./idc-http";
import { idcRelease } from "./idc-releases";

const BASE = "https://api.imaging.datacommons.cancer.gov/v3";
const GET = new Map<string, string[]>([
  ["/version", []], ["/stats", []], ["/collections", []], ["/analysis_results", []], ["/attributes", []], ["/tables", []],
  ["/clinical/tables", ["collection_id"]], ["/viewer-url", ["series_instance_uid", "study_instance_uid", "viewer"]],
]);
const POST = new Map<string, string[]>([
  ["/cohort/counts", ["filters"]], ["/cohort/manifest", ["filters", "page", "page_size", "include_rows"]],
  ["/cohort/manifest.txt", ["filters", "limit", "source"]], ["/sql", ["sql", "max_rows"]],
  ["/citations", ["filters", "citation_format"]], ["/licenses", ["filters"]],
]);

function getParameters(path: string): string[] | undefined {
  if (GET.has(path)) return GET.get(path);
  if (/^\/(collections|tables)\/[A-Za-z0-9_.-]+$/.test(path) || /^\/clinical\/tables\/[A-Za-z0-9_]+$/.test(path)) return [];
  if (/^\/attributes\/[A-Za-z0-9_]+\/values$/.test(path)) return ["limit"];
  if (/^\/clinical\/tables\/[A-Za-z0-9_]+\/rows$/.test(path)) return ["max_rows"];
  return undefined;
}

function validateFilters(body: Record<string, unknown>, path: string) {
  if (!isRecord(body.filters)) idcError(`${path} requires a filters object; discover /attributes and values first`);
  for (const key of Object.keys(body.filters)) if (key !== "terms" && key !== "ranges") idcError(`unknown filter key ${key}`);
  if (body.filters.terms !== undefined) {
    if (!isRecord(body.filters.terms)) idcError("filters.terms must be an object");
    for (const [name, values] of Object.entries(body.filters.terms)) {
      if (!Array.isArray(values) || values.some(value => typeof value !== "string")) idcError(`term ${name} must be an array of strings`);
    }
  }
  if (body.filters.ranges !== undefined) {
    if (!isRecord(body.filters.ranges)) idcError("filters.ranges must be an object");
    for (const [name, range] of Object.entries(body.filters.ranges)) {
      if (!isRecord(range) || Object.keys(range).some(key => key !== "gte" && key !== "lte")) idcError(`range ${name} uses gte/lte bounds`);
      for (const value of Object.values(range)) if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "number" && !Number.isFinite(value))) idcError(`invalid range ${name}`);
    }
  }
  // Keep empty predicates intact: upstream explicitly reports ignored filters in warnings.
}

export function idcRequest(method: string, path: string, params: Record<string, unknown>, body?: unknown) {
  const allowed = getParameters(path);
  const bodyKeys = POST.get(path);
  if ((method !== "GET" || !allowed) && (method !== "POST" || !bodyKeys)) idcError("unknown v3 route or unsupported method", 404);
  const query = { ...params };
  const expected = query.expected_index_version === undefined ? undefined : indexVersion(query.expected_index_version);
  delete query.expected_index_version;
  for (const key of Object.keys(query)) if (method === "POST" || !allowed?.includes(key)) idcError(`unsupported query parameter ${key}`);
  const url = new URL(`${BASE}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (key === "limit" || key === "max_rows") {
      url.searchParams.set(key, String(integer(value, key, 1, key === "limit" ? 10000 : 100000)));
    } else {
      if (typeof value !== "string" || !value.trim() || value.length > 512) idcError(`${key} must be a nonempty string`);
      url.searchParams.set(key, value);
    }
  }
  if (method === "GET") {
    if (body !== undefined) idcError("GET bodies are not supported");
    return { url: url.href, expected, body: undefined };
  }
  return prepareIdcPost(body, bodyKeys, path, url, expected);
}

function prepareIdcPost(body: unknown, bodyKeys: string[] | undefined, path: string, url: URL, expected: string | undefined) {
  if (!isRecord(body)) idcError("POST requires a JSON object");
  for (const key of Object.keys(body)) if (!bodyKeys?.includes(key)) idcError(`unsupported request body field ${key}`);
  const validated = { ...body };
  if (path === "/sql") {
    if (typeof body.sql !== "string" || !/^\s*(SELECT|WITH)\b/i.test(body.sql)) idcError("SQL must start with SELECT or WITH; the provider enforces its read-only SQL contract");
    validated.max_rows = integer(body.max_rows ?? 100, "max_rows", 1, 10000);
  } else {
    validateFilters(body, path);
    if (path === "/cohort/manifest") {
      validated.page = integer(body.page ?? 0, "page", 0, 1000000);
      validated.page_size = integer(body.page_size ?? 100, "page_size", 1, 5000);
      if (body.include_rows !== undefined && typeof body.include_rows !== "boolean") idcError("include_rows must be boolean");
    }
    if (path === "/cohort/manifest.txt") validated.limit = integer(body.limit ?? 100000, "limit", 1, 100000);
    if (body.source !== undefined && body.source !== "aws" && body.source !== "gcs") idcError("source must be aws or gcs");
    if (body.citation_format !== undefined && !["apa", "bibtex", "csl-json", "turtle"].includes(String(body.citation_format))) idcError("unsupported citation_format");
  }
  const encoded = JSON.stringify(validated);
  if (new TextEncoder().encode(encoded).byteLength > 64 * 1024) idcError("request exceeds 64 KiB; narrow the selection", 413);
  return { url: url.href, expected, body: encoded };
}

async function observedVersion(signal: AbortSignal) {
  const response = await idcJson(`${BASE}/version`, { signal });
  const data = response.data;
  if (!isRecord(data) || typeof data.idc_version !== "string" || typeof data.idc_index_data_version !== "string" || typeof data.api_version !== "string" || (data.build !== null && typeof data.build !== "string")) idcError("provider version response changed", 502);
  return data;
}

export async function idcFetch(request: Parameters<ApiFetchFn>[0], signal?: AbortSignal) {
  const [path, queryString] = request.path.split("?");
  const params = { ...request.params };
  if (queryString) for (const [name, value] of new URLSearchParams(queryString)) {
    if (params[name] !== undefined) idcError(`duplicate query parameter ${name}`);
    params[name] = value;
  }
  const method = request.method.toUpperCase();
  if (path === "/idc/releases") {
    if (method !== "GET" || request.body !== undefined) idcError("release discovery accepts GET without a body");
    return idcRelease(params);
  }
  if (!path.startsWith("/idc/v3/")) idcError("use /idc/v3/* for the official beta API or /idc/releases for bulk artifacts", 404);
  const upstreamPath = path.slice("/idc/v3".length);
  return readVersionedIdc(method, upstreamPath, params, request, signal);
}

function readVersionedIdc(method: string, upstreamPath: string, params: { [x: string]: unknown; }, request: { method: string; path: string; params?: Record<string, unknown>; body?: unknown; }, signal: AbortSignal | undefined) {
  const prepared = idcRequest(method, upstreamPath, params, request.body);
  return idcDeadline(async (signal) => {
    const before = await observedVersion(signal);
    if (prepared.expected && prepared.expected !== before.idc_index_data_version) idcError(`requested index ${prepared.expected}, provider currently serves ${String(before.idc_index_data_version)}; this guard is not historical retrieval`, 409);
    if (upstreamPath === "/version") return { ...before, _idc: { source_url: `${BASE}/version`, retrieved_at: new Date().toISOString(), api_status: "beta" } };
    const response = await idcJson(prepared.url, { method, body: prepared.body, signal, headers: { Accept: upstreamPath.endsWith(".txt") ? "text/plain" : "application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) } }, upstreamPath.endsWith(".txt"));
    const after = await observedVersion(signal);
    for (const name of ["idc_version", "idc_index_data_version", "api_version", "build"]) if (before[name] !== after[name]) idcError("provider version/build changed during the request; repeat against one version", 409);
    const raw = response.data;
    if (isRecord(raw) && "_idc" in raw) idcError("provider response collides with adapter provenance field", 502);
    const data = typeof raw === "string" ? { manifest_text: raw, manifest_granularity: "series_prefix", scope: "provider-capped text manifest; use cohort counts to assess completeness" } : Array.isArray(raw) ? { rows: raw } : isRecord(raw) ? raw : idcError("unexpected provider response shape", 502);
    return {
      ...data, _idc: {
        source_url: prepared.url, method, retrieved_at: response.retrieved_at, response_sha256: response.response_sha256,
        version: before, api_status: "beta", version_observation: "matching before/after observations; not an atomic or historical snapshot", expected_index_version: prepared.expected ?? null
      }
    };
  }, 45000, signal);
}
