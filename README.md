# TCIA MCP Server

This is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server. It lets MCP clients (Claude Desktop, Claude Code, Continue, etc.) query the upstream TCIA API in natural language. It is one of 100+ servers in the [Bio MCP](../../README.md) monorepo.

## Connect

The configured production endpoint is below. The IDC additions passed local live acceptance on October 3, 2026; deployment remains pending:

```
https://tcia-mcp-server.quentincody.workers.dev/mcp
```

Add it to your MCP client (Claude Desktop → Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "tcia": {
      "command": "npx",
      "args": ["mcp-remote", "https://tcia-mcp-server.quentincody.workers.dev/mcp"]
    }
  }
}
```

For local development the server runs at `http://localhost:8857/mcp` (start it with `./scripts/dev-servers.sh tcia`):

```json
{
  "mcpServers": {
    "tcia-local": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:8857/mcp"]
    }
  }
}
```

## Tools

- `tcia_search` — discover available API operations (Code Mode catalog search over NBIA and IDC)
- `tcia_execute` — **Code Mode**: write JavaScript in a V8 isolate (`api.get()` / `api.post()` / `searchSpec()`) instead of issuing tool calls one by one
- `tcia_query_data` — run SQL over large responses auto-staged into a per-session SQLite database
- `tcia_get_schema` — inspect the inferred schema of a staged dataset

Large responses (>30KB) are auto-staged into a queryable SQLite database; the tools return a `data_access_id` you can query with SQL.

Every tool is registered under both `tcia_<tool>` and `mcp_tcia_<tool>`. Every tool returns both a human-readable `content` summary and a structured `structuredContent` payload.

## IDC v3 and bulk indexes

`/idc/v3/*` maps to the [official public IDC v3 REST API](https://github.com/ImagingDataCommons/IDC-REST-MCP). It requires no credentials or separately provisioned query backend. The provider also publishes a hosted MCP interface; this adapter keeps our Code Mode and staging workflow. Existing NBIA metadata routes remain available. [TCIA's notice](https://wiki.cancerimagingarchive.net/display/Public/TCIA+Application+Programming+Interface+%28API%29+Guides) ends legacy API helpdesk support in October 2026, without a confirmed full shutdown date.

Start with `/idc/v3/version`, attribute/value discovery and cohort counts; then request a small manifest page. The catalog also exposes analysis results, SQL schemas, clinical tables, viewer links, citations and licenses. Follow the [provider user guide](https://github.com/ImagingDataCommons/IDC-REST-MCP/blob/main/docs/user-guide.md) when choosing join keys: collection and analysis-result identities are independent; clinical patient joins require collection scope, and segmentation anatomy differs from acquisition body part.

```javascript
const observed = await api.get("/idc/v3/version");
if (!observed?.idc_index_data_version) return observed;
return await api.post("/idc/v3/cohort/manifest", {
  filters: { terms: { Modality: ["CT"] } },
  page: 0,
  page_size: 10
}, { expected_index_version: observed.idc_index_data_version });
```

The hosted API is beta and serves current data. Optional `expected_index_version` rejects a mismatched exact index build; it does **not** request historical data. Each query compares version/build observations before and after retrieval; matching observations do not prove an atomic snapshot. `_idc` retains these observations, source URL, retrieval time and response hash. Native response fields, `filters_applied`, warnings, counts and pagination survive; top-level arrays are wrapped in `rows`. Inspect the original staged envelope for metadata when SQL tables contain only rows.

Requests are capped at 64 KiB and responses at 2 MiB; reads time out after 35 seconds per request and 45 seconds across version observations plus query. SQL defaults to 100 rows (maximum 10,000); manifest pages default to 100 (maximum 5,000). Responses over 30 KiB stage through the shared Durable Object. A byte-cap failure is an error, not a partial success: narrow the request. Preserve failed/staged handles when composing workflows. SQL execution is guarded by the provider's read-only SQL service.

Clinical/SQL responses with at least 100 native columns use `idc_records(record_index, patient_id, record_json)` in staging to fit Worker SQLite's column limit. `record_index` is zero-based within the returned page; `patient_id` is a string join key scoped to the source clinical collection. `record_json` retains every native cell, including nulls and coded values. Query individual fields with `json_extract(record_json, '$.age')`; the complete original envelope remains in `payloads.root_json` (or its referenced `content_chunks`). Staging completeness retains provider truncation and pagination; storing a page does not make it a complete cohort.

Text manifests name **series prefixes**, not complete individual DICOM object inventories. Select `source: "aws"` or `"gcs"` on `/cohort/manifest.txt` only; the JSON `/cohort/manifest` endpoint rejects this option. Both AWS and GCS text manifests can use `s3://`; follow the returned transfer instructions. This Worker does not download image bytes. Obtain citations and licenses for the selected cohort before external reuse.

`GET /idc/releases` discovers stable [bulk index releases](https://github.com/ImagingDataCommons/idc-index-data/releases); `index_version` selects an exact tag. It returns asset URLs, sizes and available SHA-256 digests without downloading files. Package build `24.2.2` and data release `v24` are distinct. Verify downloaded bytes externally against the asset's checksum; the digest of a checksum sidecar describes that sidecar, not its target file. Bulk ingestion remains external.

October 3 acceptance verified all 19 Parquet asset sizes and SHA-256 digests for `24.2.2` (167,176,174 bytes), and compared the 17 REST-exposed tables' row counts with their Parquet footers. The main index has 1,032,911 series. The initial decoding failure came from PyArrow 19.0.0's [known histogram reader bug](https://github.com/apache/arrow/issues/45283). October 5 decoding with the already cached PyArrow 25.0.1 succeeds; the new local importer reads all 3,630,527 rows across the 19 assets. This is metadata-file ingestion; image objects and patient clinical tables remain separate resources.

### Local pinned-index import

[`scripts/import_idc_index.py`](scripts/import_idc_index.py) reads a saved native GitHub release response and every Parquet asset it declares. Use an environment with a compatible PyArrow reader; 25.0.1 was tested, and 19.0.0 is explicitly rejected. The script does not install packages or fetch files. Save the original release JSON, independently retain its SHA-256, and download the exact asset URLs from that manifest before running:

```bash
python3 scripts/import_idc_index.py \
  --release-manifest release-24.2.2.json \
  --expected-manifest-sha256 YOUR_SAVED_MANIFEST_SHA256 \
  --index-version 24.2.2 \
  --directory downloaded-index-24.2.2 \
  --output idc-24.2.2.sqlite
```

The importer requires a stable matching release, exact asset URL/size/SHA-256 and matching native `idc_index_data_version` metadata. It hashes each open source descriptor before and after decoding, retains every row in file order, and rejects missing assets, unsupported cell types, non-finite numbers, duplicate column names, changed sources and exceeded bounds. It publishes a new SQLite file only after every declared Parquet asset decodes and integrity checks pass; an existing or concurrently created output is never replaced. The manifest pin verifies the supplied bytes, not the authenticity of their earlier download.

SQL views use each artifact's basename, except `idc_index.parquet` becomes `"index"` to match the REST table name. `_idc_rows_<table>` stores zero-based `row_index` and complete ordered `native_json` arrays. `_idc_artifacts` retains native column order, serialized Arrow schemas/metadata, source assets and ordered-row hashes; `_idc_provenance` retains the complete release JSON and import receipt. These native arrays are authoritative: SQL views expose nested objects/arrays as JSON text and booleans as SQLite integers, and SQLite numeric projections can lose precision for integers outside its signed 64-bit range. No duplicate records or independently aggregated arrays are merged or paired.

```sql
SELECT s.SeriesInstanceUID, s.SegmentedPropertyType_CodeMeanings,
       i.collection_id, i.analysis_result_id
FROM seg_index s JOIN "index" i USING (SeriesInstanceUID)
ORDER BY s.SeriesInstanceUID LIMIT 5;
```

`clinical_index` is a dictionary of clinical fields/value mappings, not the per-patient clinical tables served by the REST API. A pinned index import does not pin mutable cloud objects or establish clinical/causal equivalence. Defaults bound source files to 1 GiB total, decoded JSON to 16 GiB, rows to ten million and execution to 20 minutes. Row/Arrow-batch checks occur after decoding and are not a hard process memory ceiling. Override bounds explicitly for a reviewed larger release. Run the offline fixture contracts with `python3 test/bulk_import_test.py` in the compatible reader environment. See the [bulk validation report](../../docs/audits/2026-10-05-idc-bulk-review.md) for complete-file and captured-API comparisons.

## Individual IDC object inventories

`GET /idc/series/{series_instance_uid}/objects` resolves one exact DICOM series in the current IDC v3 index, then lists one page of metadata under its GCS mirror prefix. It uses the provider's [series manifest contract and bucket mapping](https://github.com/ImagingDataCommons/IDC-REST-MCP/blob/ce893b26b7cbfde0bb8cd7cdb584f90cab811ac2/src/idc_api/core/services/manifest.py) and Google's [objects.list API](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/list). The existing Worker performs anonymous metadata reads; this adds no service, credential or image download. October 3 live acceptance covered all three bucket mappings, guarded continuation and a staged 70-object page through both aliases.

```javascript
// Substitute an exact SeriesInstanceUID returned by cohort discovery.
return await api.get("/idc/series/{series_instance_uid}/objects", {
  series_instance_uid: "1.2.3",
  max_results: 100
});
```

The response preserves `manifest` (including counts, applied filters, warnings and index provenance) and the unmodified GCS `listing`. `files` provides queryable object names, decimal-string sizes and generations, advertised checksums, and generation-pinned download URLs. The Worker does not follow these URLs or verify object bytes/checksums. Cloud objects are not validated DICOM instances; object counts are not reconciled with `instanceCount`.

Inspect `pagination.has_more`. Continue explicitly with `api.get(page.pagination.next.path, page.pagination.next.params)`, after resolving any staging handle and checking errors. The returned parameters include the opaque page token, exact index version, CRDC series UUID and GCS bucket; continuation requires all three identity guards. Empty intermediate pages may still have a next token. Matching guards and reaching the final page do not establish an atomic or historical cloud snapshot.

Pages default to 100 objects, with a maximum of 1,000 and a 2 MiB response cap. A 45-second deadline covers index resolution plus listing. Oversized, malformed, mismatched or unavailable responses are errors; they are never presented as complete inventories. Large native pages and error evidence use the same lossless staging, SQL/schema tools and dual aliases as other TCIA operations. Entire tool envelopes are also size-checked before transport.

Code Mode citations bind to the exact submitted JavaScript, including surrounding whitespace. API error capture runs inside the generated isolate program, preserving native error evidence and the original query identity without rewriting signed citations.

Local acceptance includes 402 MCP calls against the actual Worker, native discovery/cohort/clinical/SQL comparisons, collection-scoped clinical and segmentation joins, complete staged payload recovery, helper citation verification, upstream/local errors and the legacy NBIA collection list. All 3,120 cells of the 20-row, 156-column clinical sample matched the native response through each alias. The live contract harness passes 9 checks; its generic staging probe skips, while dedicated tests exercise actual staging. See the [dated implementation tracker](../../docs/plans/2026-09-26-upstream-api-implementation.md) for evidence and remaining scope.

## Development

```bash
./scripts/dev-servers.sh tcia            # run locally (port 8857)
pnpm --filter tcia-mcp-server run deploy   # deploy to Cloudflare Workers
```

See [`docs/adding-mcp-servers.md`](../../docs/adding-mcp-servers.md) and the root [README](../../README.md) for the full architecture (Code Mode, staging, portals).

<!-- license-and-data-terms:start -->
## License and data terms

The code in this repository is licensed under the Apache License 2.0 (see `LICENSE`).
If you use it in your work, please cite it (see `CITATION.cff`). Citation is requested, not required.

The license covers the code only. Data that this server returns comes from TCIA / IDC and stays under the terms of that source: Mostly CC BY 3.0 or 4.0; a small number of collections restrict commercial use.
You are responsible for your use of the data under those terms.
<!-- license-and-data-terms:end -->
