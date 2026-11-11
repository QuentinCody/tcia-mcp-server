import type { ApiEndpoint, ParamDef } from "@bio-mcp/shared/codemode/catalog";

const guard: ParamDef = { name: "expected_index_version", type: "string", required: false, description: "Optional exact index build, e.g. 24.2.2. Rejects drift; does not retrieve historical data. Passed as api.post's third argument for POST." };
const parameter = (name: string, description: string, type: "string" | "number" = "string"): ParamDef => ({ name, description, type, required: false });
const get = (path: string, summary: string, queryParams: ParamDef[] = [], pathName?: string): ApiEndpoint => ({
  method: "GET", path: `/idc/v3${path}`, summary, category: "IDC discovery", queryParams: [...queryParams, guard],
  ...(pathName ? { pathParams: [{ name: pathName, type: "string" as const, required: true, description: "Use the exact identifier returned by discovery." }] } : {}),
  usageHint: "Public beta API. Keep _idc version/source metadata and any truncation, warnings or staging/error handles. Provider arrays are wrapped in rows.",
});
const filters = 'filters: { terms?: { [attribute]: string[] }, ranges?: { [attribute]: { gte?: number|string, lte?: number|string } } }';
const post = (path: string, summary: string, body: string, response: string): ApiEndpoint => ({
  method: "POST", path: `/idc/v3${path}`, summary, category: "IDC queries", queryParams: [guard],
  body: { contentType: "application/json", description: body }, responseShape: response,
  usageHint: "Discover attributes/values first. Terms OR within one attribute, AND across attributes; values are case-sensitive. Preserve filters_applied and warnings (empty predicates may be ignored). api.post(path, body, {expected_index_version}) supports a version guard. Never strip staging/error handles.",
});

export const idcEndpoints: ApiEndpoint[] = [
  { method: "GET", path: "/idc/series/{series_instance_uid}/objects", category: "IDC object inventory",
    summary: "Page individual GCS object metadata for one exact IDC series, with generation-pinned download URLs",
    pathParams: [{ name: "series_instance_uid", type: "string", required: true, description: "Exact DICOM SeriesInstanceUID from a cohort manifest; not a CRDC UUID." }],
    queryParams: [guard, parameter("max_results", "1..1000; default 100. One page per call.", "number"),
      parameter("page_token", "Opaque GCS token. Continue with the complete pagination.next.params object."),
      parameter("expected_series_uuid", "CRDC series UUID from the first page; required with page_token."),
      parameter("expected_bucket", "GCS bucket from the first page; required with page_token.")],
    responseShape: "{ manifest, listing (unmodified GCS page), files: [{bucket,name,generation,size,md5Hash,crc32c,download_url}], pagination: {returned,has_more,next}, _idc_objects }",
    usageHint: "Resolves current v3 series metadata, then lists one GCS prefix. Follow pagination.next explicitly, including all guards. Retain native manifest/listing and staged/error handles. Sizes/generations remain decimal strings; checksums are advertised, not verified. Cloud objects are not validated DICOM instances. No image bytes, historical snapshot or bulk ingestion.",
  },
  { method: "GET", path: "/idc/releases", summary: "Discover versioned IDC bulk index assets and available SHA-256 digests", category: "IDC bulk", queryParams: [parameter("index_version", "Exact stable index build; omit to discover latest. This downloads metadata only.")], responseShape: "{ source, index_version, idc_release, release_url, published_at, assets: [{name, size, browser_download_url, digest, file_sha256}], source_url, retrieved_at }", usageHint: "Keep package build separate from the IDC data release. Verify file bytes against file_sha256 when downloading externally; a .sha256 sidecar's digest identifies the sidecar itself." },
  get("/version", "Observe current IDC release, exact index build and beta API build"),
  get("/stats", "Get current IDC collection/patient/study/series/instance totals"),
  get("/collections", "Discover IDC collections and cancer types"),
  get("/collections/{id}", "Inspect collection metadata, modalities and licenses", [], "id"),
  get("/analysis_results", "Discover derived analysis datasets; analysis_result_id is separate from collection_id"),
  get("/attributes", "Discover filter attributes and term/range types"),
  get("/attributes/{attr}/values", "Discover actual case-sensitive filter values and counts", [parameter("limit", "1..10000; inspect truncated and note", "number")], "attr"),
  get("/tables", "Discover SQL tables, including specialized modality and annotation indexes"),
  get("/tables/{table}", "Inspect columns and types before writing SQL", [], "table"),
  get("/clinical/tables", "Discover clinical tables and their SQL paths", [parameter("collection_id", "Exact IDC collection identifier")]),
  get("/clinical/tables/{table}", "Inspect clinical column labels and schema", [], "table"),
  get("/clinical/tables/{table}/rows", "Retrieve capped clinical table rows", [parameter("max_rows", "1..100000; response also bounded to 2 MiB; inspect truncated", "number")], "table"),
  get("/viewer-url", "Resolve OHIF or Slim viewer links for study/series identifiers", [parameter("series_instance_uid", "Exact SeriesInstanceUID"), parameter("study_instance_uid", "Exact StudyInstanceUID"), parameter("viewer", "Provider-supported viewer selection")]),
  post("/cohort/counts", "Count a filtered IDC imaging cohort", `{ ${filters} }`, "{ patients, studies, series, instances, size_TB, filters_applied, warnings, _idc }"),
  post("/cohort/manifest", "Page series metadata and cloud download manifests (cloud selection is on manifest.txt only)", `{ ${filters}, page?: number (zero-based, default 0), page_size?: number (1..5000, default 100), include_rows?: boolean }`, "{ counts, page, page_size, returned, total_series, series: object[], download, filters_applied, warnings, _idc }"),
  post("/cohort/manifest.txt", "Get a capped text manifest of series prefixes (not individual objects)", `{ ${filters}, limit?: number (1..100000, default 100000), source?: 'aws'|'gcs' }`, "{ manifest_text, manifest_granularity: 'series_prefix', scope, _idc }"),
  post("/sql", "Query current IDC metadata using provider-guarded read-only DuckDB SQL", "{ sql: string (single SELECT/WITH statement), max_rows?: number (1..10000, adapter default 100) }", "{ columns, rows, row_count, truncated, max_rows, _idc }"),
  post("/citations", "Get dataset citations and required IDC acknowledgment", `{ ${filters}, citation_format?: 'apa'|'bibtex'|'csl-json'|'turtle' }`, "{ format, citations, idc_acknowledgment, recommendation, _idc }"),
  post("/licenses", "Inspect the license breakdown for a selected cohort", `{ ${filters} }`, "{ licenses: [{license_short_name, series, size_TB}], _idc }"),
];
