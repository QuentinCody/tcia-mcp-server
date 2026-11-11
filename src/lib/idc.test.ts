import { afterEach, describe, expect, it, vi } from "vitest";
import { createTciaApiFetch } from "./api-adapter";
import { idcRequest } from "./idc";
import { idcJson } from "./idc-http";
import { releaseManifest } from "./idc-releases";

const version = { idc_version: "v24", idc_index_data_version: "24.2.2", api_version: "3.0.0b3", build: "fixture" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const filters = { terms: { PatientID: ["001"], Modality: ["CT", "MR"] }, ranges: { instanceCount: { gte: 100 }, StudyDate: { lte: "20260101" } } };
function upstream(data: unknown, after = version) {
  return vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(version)).mockResolvedValueOnce(json(data)).mockResolvedValueOnce(json(after)));
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("official IDC v3 adapter", () => {
  it("preserves native pagination, IDs, warnings, license/DOI and response evidence", async () => {
    const native = { series: [{ PatientID: "001", SeriesInstanceUID: "1.2.3", source_DOI: "10.fixture/x", license_short_name: "CC BY 4.0" }], counts: { series: 3 }, page: 0, page_size: 1, returned: 1, total_series: 3, download: { manifest: ["s3://idc-open-data/uuid/*"] }, filters_applied: filters, warnings: ["fixture warning"], future_field: { keep: true } };
    upstream(native);
    const response = await createTciaApiFetch()({ method: "POST", path: "/idc/v3/cohort/manifest", params: { expected_index_version: "24.2.2" }, body: { filters, page_size: 1 } });
    expect(response).toMatchObject({ status: 200, data: { ...native, _idc: { version, response_sha256: expect.stringMatching(/^[a-f0-9]{64}$/), expected_index_version: "24.2.2", api_status: "beta" } } });
    const call = vi.mocked(fetch).mock.calls[1];
    expect(call[0]).toBe("https://api.imaging.datacommons.cancer.gov/v3/cohort/manifest");
    expect(call[1]).toMatchObject({ method: "POST", redirect: "manual", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(call[1]?.body as string)).toEqual({ filters, page_size: 1, page: 0 });
    expect(vi.mocked(fetch).mock.calls[0][0]).toMatch(/\/v3\/version$/);
    expect(vi.mocked(fetch).mock.calls[2][0]).toMatch(/\/v3\/version$/);
  });

  it("wraps provider arrays without rewriting collection metadata", async () => {
    upstream([{ collection_id: "fixture", species: ["Human"], subjects: 3 }]);
    expect(await createTciaApiFetch()({ method: "GET", path: "idc/v3/collections" })).toMatchObject({ data: { rows: [{ collection_id: "fixture", species: ["Human"], subjects: 3 }], _idc: { version } } });
  });

  it("returns one version observation and does not invent a historical snapshot", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(version)));
    expect(await createTciaApiFetch()({ method: "GET", path: "/idc/v3/version" })).toMatchObject({ data: { ...version, _idc: { api_status: "beta" } } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["/collections/fixture", "/analysis_results", "/attributes", "/tables", "/tables/seg_index", "/clinical/tables", "/clinical/tables/nlst_canc", "/viewer-url?series_instance_uid=1.2.3"])("routes documented discovery %s", async path => {
    upstream({ fixture: "retained" });
    expect(await createTciaApiFetch()({ method: "GET", path: `/idc/v3${path}` })).toMatchObject({ data: { fixture: "retained" } });
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe(`https://api.imaging.datacommons.cancer.gov/v3${path}`);
  });

  it("rejects provenance collisions instead of discarding provider fields", async () => {
    upstream({ _idc: { future_native: true } });
    await expect(createTciaApiFetch()({ method: "GET", path: "/idc/v3/stats" })).rejects.toThrow("collides");
  });

  it.each(["idc_version", "idc_index_data_version", "api_version", "build"])("rejects %s changes across a query", async key => {
    upstream({ series: 1 }, { ...version, [key]: "changed" });
    await expect(createTciaApiFetch()({ method: "POST", path: "/idc/v3/cohort/counts", body: { filters } })).rejects.toMatchObject({ status: 409 });
  });

  it("rejects a requested historical build before querying", async () => {
    upstream({ series: 1 });
    await expect(createTciaApiFetch()({ method: "GET", path: "/idc/v3/stats", params: { expected_index_version: "23.0.0" } })).rejects.toThrow("not historical retrieval");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("identifies text manifests as capped series prefixes, retaining exact text", async () => {
    const text = "s3://idc-open-data/uuid/*\n";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(version)).mockResolvedValueOnce(new Response(text)).mockResolvedValueOnce(json(version)));
    expect(await createTciaApiFetch()({ method: "POST", path: "/idc/v3/cohort/manifest.txt", body: { filters, limit: 1 } })).toMatchObject({ data: { manifest_text: text, manifest_granularity: "series_prefix", scope: expect.stringContaining("capped"), _idc: { version } } });
  });

  it("encodes bounded clinical rows query and retains truncation/schema", async () => {
    upstream({ columns: ["dicom_patient_id"], rows: [{ dicom_patient_id: "001" }], truncated: true, row_count: 1, max_rows: 1 });
    expect(await createTciaApiFetch()({ method: "GET", path: "/idc/v3/clinical/tables/fixture/rows?max_rows=1" })).toMatchObject({ data: { rows: [{ dicom_patient_id: "001" }], truncated: true } });
    expect(vi.mocked(fetch).mock.calls[1][0]).toMatch(/\/clinical\/tables\/fixture\/rows\?max_rows=1$/);
  });

  it("preserves empty predicates so the provider can report ignored filters", () => {
    expect(JSON.parse(idcRequest("POST", "/cohort/counts", {}, { filters: { terms: { Modality: [] }, ranges: {} } }).body!)).toEqual({ filters: { terms: { Modality: [] }, ranges: {} } });
  });

  it.each(["apa", "bibtex", "csl-json", "turtle"])("passes %s citation format", citation_format => {
    expect(JSON.parse(idcRequest("POST", "/citations", {}, { filters, citation_format }).body!)).toEqual({ filters, citation_format });
  });

  it("bounds SQL output without rewriting the query", () => {
    const sql = "WITH x AS (SELECT * FROM seg_index) SELECT * FROM x";
    expect(JSON.parse(idcRequest("POST", "/sql", {}, { sql }).body!)).toEqual({ sql, max_rows: 100 });
  });

  it.each([
    ["POST", "/cohort/counts", {}, { terms: {} }],
    ["POST", "/cohort/counts", {}, { filters: { terms: { PatientID: [1] } } }],
    ["POST", "/cohort/counts", {}, { filters: { ranges: { x: { gt: 3 } } } }],
    ["POST", "/cohort/manifest", {}, { filters, page_size: 5001 }],
    ["POST", "/cohort/manifest", {}, { filters, include_rows: "true" }],
    ["POST", "/cohort/manifest", {}, { filters, source: "azure" }],
    ["POST", "/cohort/manifest", {}, { filters, source: "gcs" }],
    ["POST", "/cohort/manifest.txt", {}, { filters, source: "azure" }],
    ["POST", "/sql", {}, { sql: "DELETE FROM index" }],
    ["POST", "/sql", {}, { sql: "SELECT 1", max_rows: 10001 }],
    ["POST", "/licenses", { filters: "bad" }, { filters }],
    ["POST", "/citations", {}, { filters, citation_format: "unsupported" }],
    ["GET", "/stats", { expected_index_version: "latest" }, undefined],
    ["GET", "/stats", { url: "https://other.test" }, undefined],
    ["GET", "/stats", {}, {}],
    ["GET", "/attributes/Modality/values", { limit: 10001 }, undefined],
    ["GET", "/collections/../version", {}, undefined],
    ["DELETE", "/collections", {}, undefined],
  ])("rejects malformed/unsupported request %#", (method, path, params, body) => {
    expect(() => idcRequest(method as string, path as string, params as Record<string, unknown>, body)).toThrow();
  });

  it("rejects duplicate query options and retired adapter paths", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(createTciaApiFetch()({ method: "GET", path: "/idc/v3/attributes/Modality/values?limit=2", params: { limit: 1 } })).rejects.toThrow("duplicate");
    await expect(createTciaApiFetch()({ method: "GET", path: "/idc/series" })).rejects.toMatchObject({ status: 404 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds UTF-8 request and response bytes", async () => {
    expect(() => idcRequest("POST", "/sql", {}, { sql: `SELECT '${"α".repeat(33000)}'` })).toThrow("64 KiB");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("α".repeat(1024 * 1024 + 1))));
    await expect(idcJson("https://fixture.test")).rejects.toThrow("exceeds");
  });

  it("preserves provider status, error body and retry delay", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"detail":"rate limited"}', { status: 429, headers: { "retry-after": "60" } })));
    await expect(idcJson("https://fixture.test")).rejects.toMatchObject({ status: 429, data: { response: '{"detail":"rate limited"}', retry_after: "60" } });
  });

  it("aborts slow provider requests and clears its deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))));
    const pending = expect(idcJson("https://fixture.test")).rejects.toMatchObject({ status: 502 });
    await vi.advanceTimersByTimeAsync(35000);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains legacy NBIA GET behavior", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json([{ Collection: "Fixture" }])));
    expect(await createTciaApiFetch()({ method: "GET", path: "/getCollectionValues" })).toMatchObject({ data: [{ Collection: "Fixture" }] });
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("services.cancerimagingarchive.net/nbia-api/services/v1/getCollectionValues");
    await expect(createTciaApiFetch()({ method: "POST", path: "/getCollectionValues", body: {} })).rejects.toThrow("GET");
  });
});

describe("bulk release discovery", () => {
  const asset = { name: "idc_index.parquet", size: 70000, browser_download_url: "https://github.com/ImagingDataCommons/idc-index-data/releases/download/24.2.2/idc_index.parquet", digest: `sha256:${"a".repeat(64)}` };
  const release = { tag_name: "24.2.2", assets: [asset], body: "release notes", published_at: "2026-07-11", id: 123 };
  it("separates package/data release and keeps original asset metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(release)));
    expect(await createTciaApiFetch()({ method: "GET", path: "/idc/releases", params: { index_version: "24.2.2" } })).toMatchObject({ data: { idc_release: "v24", index_version: "24.2.2", assets: [{ ...asset, file_sha256: "a".repeat(64) }] } });
    expect(vi.mocked(fetch).mock.calls[0][0]).toMatch(/releases\/tags\/24\.2\.2$/);
  });
  it("does not invent absent checksums", () => {
    expect(releaseManifest({ ...release, assets: [{ ...asset, digest: null }] }).assets[0].file_sha256).toBeNull();
  });
  it("rejects mismatched, prerelease and off-source assets", () => {
    expect(() => releaseManifest(release, "24.2.1")).toThrow("different");
    expect(() => releaseManifest({ ...release, prerelease: true })).toThrow("pre-release");
    expect(() => releaseManifest({ ...release, assets: [{ ...asset, browser_download_url: "https://other.test/file" }] })).toThrow("does not match");
  });
});
