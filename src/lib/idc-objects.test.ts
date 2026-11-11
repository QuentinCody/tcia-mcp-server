/// <reference types="node" />
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTciaApiFetch } from "./api-adapter";
import { idcJson } from "./idc-http";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
const uuid = "11111111-2222-3333-4444-555555555555";
const path = "/idc/series/1.2.3/objects";
const version = { idc_version: "v24", idc_index_data_version: "24.2.2", api_version: "3.0.0b4", build: null };
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json", etag: '"fixture"' } });
const manifest = (aws = "idc-open-data") => ({ counts: { series: 1, instances: 200, filters_applied: { terms: { SeriesInstanceUID: ["1.2.3"] }, ranges: {} }, warnings: ["provider warning"] },
  page: 0, page_size: 1, returned: 1, total_series: 1,
  series: [{ SeriesInstanceUID: "1.2.3", aws_bucket: aws, crdc_series_uuid: uuid, series_aws_url: `s3://${aws}/${uuid}/*`, instanceCount: 200 }], future: { kept: true } });
const object = (bucket = "idc-open-data") => ({ kind: "storage#object", bucket, name: `${uuid}/α #?.dcm`, generation: "17480000000000001", size: "9007199254740993", md5Hash: "advertised", crc32c: "advertised", metadata: { future: "kept" } });
const listing = () => ({ kind: "storage#objects", items: [object()], nextPageToken: "opaque+/==", future: "retained" });
function upstream(page: unknown = listing(), cohort: unknown = manifest(), versions: unknown[] = [version, version]) {
  const fetch = vi.fn().mockResolvedValueOnce(json(versions[0])).mockResolvedValueOnce(json(cohort)).mockResolvedValueOnce(json(versions[1])).mockResolvedValueOnce(json(page));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
async function read(params: Record<string, unknown> = {}) {
  return createTciaApiFetch()({ method: "GET", path, params });
}

describe("IDC individual cloud object inventory", () => {
  it.each([["idc-open-data", "idc-open-data"], ["idc-open-data-two", "idc-open-idc1"], ["idc-open-data-cr", "idc-open-cr"]])("maps %s using the provider's GCS mirror %s", async (aws, gcs) => {
    const native = { ...listing(), items: [object(gcs)] };
    const fetch = upstream(native, manifest(aws));
    const result = await read({ max_results: 1 });
    expect(result).toMatchObject({ status: 200, data: { manifest: { ...manifest(aws), _idc: { version } }, listing: native,
      files: [{ bucket: gcs, generation: "17480000000000001", size: "9007199254740993", download_url: `https://storage.googleapis.com/storage/v1/b/${gcs}/o/${uuid}%2F%CE%B1%20%23%3F.dcm?alt=media&generation=17480000000000001` }],
      pagination: { returned: 1, has_more: true, next: { path, params: { page_token: "opaque+/==", expected_bucket: gcs, expected_series_uuid: uuid, expected_index_version: "24.2.2", max_results: 1 } } },
      _idc_objects: { checksum_status: "advertised_unverified", image_bytes_downloaded: false, response_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } } });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ filters: { terms: { SeriesInstanceUID: ["1.2.3"] } }, page: 0, page_size: 1, include_rows: true });
    const url = new URL(fetch.mock.calls[3][0]);
    expect(url.origin + url.pathname).toBe(`https://storage.googleapis.com/storage/v1/b/${gcs}/o`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ prefix: `${uuid}/`, maxResults: "1", projection: "noAcl", versions: "false" });
    expect(fetch.mock.calls[3][1]).toMatchObject({ redirect: "manual", headers: { Accept: "application/json" } });
  });

  it("continues an opaque page token with the returned identity guards", async () => {
    upstream();
    const first = await read();
    const next = (first.data as any).pagination.next;
    const fetch = upstream({ kind: "storage#objects" });
    const last = await createTciaApiFetch()({ method: "GET", ...next });
    expect(last).toMatchObject({ data: { listing: { kind: "storage#objects" }, files: [], pagination: { returned: 0, has_more: false, next: null, page_token: "opaque+/==" } } });
    expect(new URL(fetch.mock.calls[3][0]).searchParams.get("pageToken")).toBe("opaque+/==");
    expect((last.data as any)._idc_objects.scope).toContain("not an atomic");
  });

  it("retains an empty intermediate page with a continuation", async () => {
    upstream({ kind: "storage#objects", nextPageToken: "next" });
    expect(await read()).toMatchObject({ data: { files: [], pagination: { returned: 0, has_more: true } } });
  });

  it.each([
    { total_series: 0, returned: 0, series: [], counts: { ...manifest().counts, series: 0 } },
    { total_series: 2 }, { returned: 0 }, { page: 1 }, { page_size: 2 },
    { counts: { series: 1, filters_applied: {} } },
    { counts: { series: 1, filters_applied: { terms: { SeriesInstanceUID: ["1.2.4"] } } } },
    { series: [{ ...manifest().series[0], aws_bucket: "unrecognized" }] },
    { series: [{ ...manifest().series[0], SeriesInstanceUID: "1.2.4" }] },
    { series: [{ ...manifest().series[0], series_aws_url: "s3://other/something/*" }] },
    { series: [{ ...manifest().series[0], crdc_series_uuid: "../" }] },
  ])("rejects absent/ambiguous/malformed series scope without listing a bucket %#", async change => {
    const native = { ...manifest(), ...change };
    const fetch = upstream(listing(), native);
    await expect(read()).rejects.toMatchObject({ status: expect.any(Number), data: { manifest: native } });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    { expected_index_version: "24.2.1" },
    { expected_series_uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    { expected_bucket: "idc-open-cr" },
  ])("rejects changed continuation identities %#", async guard => {
    const fetch = upstream();
    await expect(read({ page_token: "old", expected_index_version: "24.2.2", expected_series_uuid: uuid, expected_bucket: "idc-open-data", ...guard })).rejects.toMatchObject({ status: 409 });
    expect(fetch.mock.calls.some(call => String(call[0]).includes("storage.googleapis.com"))).toBe(false);
  });

  it.each([
    {}, { kind: "storage#objects", items: {} }, { kind: "storage#objects", prefixes: ["other/"] },
    { kind: "storage#objects", items: [{ ...object(), bucket: "other" }] },
    { kind: "storage#objects", items: [{ ...object(), name: "other/file.dcm" }] },
    { kind: "storage#objects", items: [{ ...object(), generation: 9007199254740992 }] },
    { kind: "storage#objects", items: [{ ...object(), size: -1 }] },
    { kind: "storage#objects", items: [object(), object()] },
    { kind: "storage#objects", nextPageToken: "" },
  ])("preserves failed listing evidence without claiming a complete inventory %#", async native => {
    upstream(native);
    await expect(read()).rejects.toMatchObject({ status: 502, data: { inventory_complete: false, manifest: manifest(), upstream: { listing: native, observation: { response_sha256: expect.any(String) } } } });
  });

  it("rejects a repeated continuation token", async () => {
    upstream();
    await expect(read({ page_token: "opaque+/==", expected_index_version: "24.2.2", expected_series_uuid: uuid, expected_bucket: "idc-open-data" })).rejects.toThrow("repeated");
  });

  it.each([{ page_token: "x" }, { max_results: 1001 }, { max_results: 0 }, { expected_bucket: "other" }, { expected_series_uuid: "not-uuid" }, { expected_index_version: "latest" }, { url: "https://other.test" }])("rejects invalid requests before fetch %#", async params => {
    const fetch = upstream();
    await expect(read(params)).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { method: "POST", path }, { method: "GET", path, body: {} },
    { method: "GET", path: "/idc/series/01.2/objects" },
    { method: "GET", path: `${path}?max_results=1&max_results=2` },
    { method: "GET", path: `${path}?max_results=1`, params: { max_results: 2 } },
  ])("rejects malformed route/method/query %#", async request => {
    const fetch = upstream();
    await expect(createTciaApiFetch()(request)).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains native GCS permission errors and the resolved manifest", async () => {
    const fetch = upstream();
    fetch.mockReset().mockResolvedValueOnce(json(version)).mockResolvedValueOnce(json(manifest())).mockResolvedValueOnce(json(version)).mockResolvedValueOnce(new Response('{"error":{"code":403,"message":"denied"}}', { status: 403 }));
    await expect(read()).rejects.toMatchObject({ status: 403, data: { manifest: manifest(), inventory_complete: false, upstream: { http_status: 403, response: '{"error":{"code":403,"message":"denied"}}' } } });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

describe("bounded IDC provider reads", () => {
  it("accepts nullable builds but rejects a changed null build", async () => {
    upstream(listing(), manifest(), [version, { ...version, build: "new" }]);
    await expect(read()).rejects.toMatchObject({ status: 409 });
  });

  it.each([206, 302, 200])("rejects partial or redirect representations with evidence: %i", async status => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"partial":true}', { status, headers: { "content-range": "bytes 0-15/200" } })));
    await expect(idcJson("https://fixture.test")).rejects.toMatchObject({ data: { http_status: status, response: '{"partial":true}' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("hashes original BOM-prefixed text while parsing its JSON", async () => {
    const text = '\uFEFF{"value":"α"}';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(text)));
    const result = await idcJson("https://fixture.test");
    expect(result.data).toEqual({ value: "α" });
    const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).toString("hex");
    expect(result.response_sha256).toBe(hash);
  });

  it("retains non-JSON success bodies as error evidence", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>maintenance</html>")));
    await expect(idcJson("https://fixture.test")).rejects.toMatchObject({ status: 502, data: { response: "<html>maintenance</html>", http_status: 200 } });
  });

  it("bounds ignored fetch cancellation and cancels late response bodies", async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    const pending = expect(idcJson("https://fixture.test")).rejects.toMatchObject({ status: 502 });
    await vi.advanceTimersByTimeAsync(35_000);
    await pending;
    resolve(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds stalled bodies even if cancellation never settles", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }))));
    const pending = expect(idcJson("https://fixture.test")).rejects.toMatchObject({ status: 502 });
    await vi.advanceTimersByTimeAsync(35_000);
    await pending;
    expect(cancel).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it("shares a 45-second deadline across index lookup and cloud listing", async () => {
    vi.useFakeTimers();
    // Hash correctness is covered separately; keep native crypto scheduling out of this clock test.
    vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));
    const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(json(version)), 20_000)))
      .mockResolvedValueOnce(json(manifest())).mockResolvedValueOnce(json(version)).mockImplementationOnce(() => new Promise(() => undefined));
    vi.stubGlobal("fetch", fetch);
    const pending = expect(read()).rejects.toMatchObject({ status: 502 });
    await vi.advanceTimersByTimeAsync(45_000);
    await pending;
    expect(fetch).toHaveBeenCalledTimes(4); expect(vi.getTimerCount()).toBe(0);
  });
});
