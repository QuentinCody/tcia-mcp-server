import { createApiProxyTool } from "@bio-mcp/shared/tools/api-proxy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tciaCatalog } from "../spec/catalog";
import { createTciaApiFetch } from "./api-adapter";
import {
  COMMERCIAL_LICENSE_NAMES, COMMERCIAL_LICENSE_URIS, commercialRule, IDC_CATALOG_ATTRIBUTES, NBIA_COMMERCIAL_RULES,
  permitsCommercialUse, withholdNbiaRecords,
} from "./commercial-profile";

// License audit 2026-11-10: "Check each collection's license and exclude the
// non-commercial collections." Most TCIA and IDC data is CC BY 3.0 or CC BY 4.0;
// a small part is CC BY-NC, and one IDC collection has the NLM terms. A reselling
// caller gets the records whose license is in the allowlist, and no record whose
// license the adapter cannot check.

afterEach(() => vi.unstubAllGlobals());

const commercial = { licenseProfile: "commercial" as const };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const refused = (result: { status: number; data: unknown }) => {
  expect(result.status).toBe(451);
  expect(result.data).toMatchObject({ error: "NOT_LICENSED_FOR_COMMERCIAL_USE" });
};

// Field names and license strings as the live NBIA API gave them on 2026-11-10.
const BY3 = { LicenseName: "Creative Commons Attribution 3.0 Unported License", LicenseURI: "http://creativecommons.org/licenses/by/3.0/" };
const BY4 = { LicenseName: "Creative Commons Attribution 4.0 International License", LicenseURI: "https://creativecommons.org/licenses/by/4.0/" };
const NC3 = { LicenseName: "Creative Commons Attribution-NonCommercial 3.0 Unported License", LicenseURI: "https://creativecommons.org/licenses/by-nc/3.0/" };
const NC4 = { LicenseName: "Creative Commons Attribution-NonCommercial 4.0 International License", LicenseURI: "https://creativecommons.org/licenses/by-nc/4.0/" };
const series = (uid: string, license: Record<string, unknown>) => ({ SeriesInstanceUID: uid, Collection: "Fixture", PatientID: "P1", Modality: "CT", ImageCount: 2, FileSize: 100, ...license });

function nbia(body: unknown) {
  const fetch = vi.fn(async (_url: unknown) => (typeof body === "string" ? new Response(body, { headers: body ? { "content-type": "text/csv" } : {} }) : json(body)));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("license allowlist", () => {
  it("permits the CC BY and public-domain names and addresses", () => {
    for (const name of COMMERCIAL_LICENSE_NAMES) expect(permitsCommercialUse(name), name).toBe(true);
    for (const uri of COMMERCIAL_LICENSE_URIS) expect(permitsCommercialUse(undefined, `https://${uri}/`), uri).toBe(true);
    expect(permitsCommercialUse("CC BY 4.0")).toBe(true);
    expect(permitsCommercialUse("  cc  by 3.0 ")).toBe(true);
    expect(permitsCommercialUse(BY3.LicenseName, BY3.LicenseURI)).toBe(true);
    expect(permitsCommercialUse(BY4.LicenseName, BY4.LicenseURI)).toBe(true);
  });

  it("does not permit a non-commercial, restricted, unknown or absent license", () => {
    const names = [
      "CC BY-NC 4.0", "CC BY-NC 3.0", NC3.LicenseName, NC4.LicenseName, "CC BY-NC-ND 4.0", "CC BY 2.0",
      "National Library of Medicine Terms and Conditions; May 21, 2019", "TCIA Restricted License", "A new license",
      "", "   ", undefined, null, 4, {}, ["CC BY 4.0"],
    ];
    for (const name of names) expect(permitsCommercialUse(name), String(name)).toBe(false);
    expect(permitsCommercialUse(undefined, NC3.LicenseURI)).toBe(false);
    expect(permitsCommercialUse(undefined, "https://example.org/license")).toBe(false);
  });

  it("does not permit a record whose name and address disagree", () => {
    expect(permitsCommercialUse(BY4.LicenseName, NC4.LicenseURI)).toBe(false);
    expect(permitsCommercialUse(NC4.LicenseName, BY4.LicenseURI)).toBe(false);
    expect(permitsCommercialUse(BY4.LicenseName, 7)).toBe(false);
  });
});

describe("rule of each route under the commercial profile", () => {
  const sample = (path: string) => path.replace("{series_instance_uid}", "1.2.3").replace("{id}", "nsclc_radiomics").replace("{attr}", "Modality").replace("{table}", "index");
  const expected: Record<string, string> = {
    "/idc/series/{series_instance_uid}/objects": "idc_series",
    "/idc/releases": "unchanged",
    "/idc/v3/version": "unchanged",
    "/idc/v3/stats": "unchanged",
    "/idc/v3/collections": "unchanged",
    "/idc/v3/collections/{id}": "unchanged",
    "/idc/v3/analysis_results": "unchanged",
    "/idc/v3/attributes": "unchanged",
    "/idc/v3/attributes/{attr}/values": "unchanged",
    "/idc/v3/tables": "unchanged",
    "/idc/v3/tables/{table}": "unchanged",
    "/idc/v3/clinical/tables": "unchanged",
    "/idc/v3/clinical/tables/{table}": "unchanged",
    "/idc/v3/clinical/tables/{table}/rows": "refuse",
    "/idc/v3/viewer-url": "idc_viewer",
    "/idc/v3/cohort/counts": "unchanged",
    "/idc/v3/cohort/manifest": "idc_manifest",
    "/idc/v3/cohort/manifest.txt": "refuse",
    "/idc/v3/sql": "refuse",
    "/idc/v3/citations": "unchanged",
    "/idc/v3/licenses": "unchanged",
    "/getCollectionValues": "unchanged",
    "/getModalityValues": "unchanged",
    "/getBodyPartValues": "unchanged",
    "/getManufacturerValues": "unchanged",
    "/getPatient": "refuse",
    "/getPatientStudy": "refuse",
    "/getSeries": "nbia_filter",
    "/getSeriesSize": "refuse",
    "/getSeriesMetaData": "nbia_filter",
    "/NewStudiesInPatientCollection": "refuse",
  };

  it("gives a rule to each catalog route, and the catalog has no route without one", () => {
    expect(tciaCatalog.endpoints.map((endpoint) => endpoint.path).sort()).toEqual(Object.keys(expected).sort());
    for (const endpoint of tciaCatalog.endpoints) {
      expect(commercialRule({ path: sample(endpoint.path) }).kind, endpoint.path).toBe(expected[endpoint.path]);
    }
    const legacy = tciaCatalog.endpoints.map((endpoint) => endpoint.path).filter((path) => !path.startsWith("/idc"));
    expect([...NBIA_COMMERCIAL_RULES.keys()].sort()).toEqual(legacy.sort());
  });

  it("reads the route without its query, and with or without the first slash", () => {
    expect(commercialRule({ path: "/getSeries?Collection=Fixture" })).toEqual({ kind: "nbia_filter", route: "/getSeries" });
    expect(commercialRule({ path: "getSeries/" })).toEqual({ kind: "nbia_filter", route: "/getSeries" });
    expect(commercialRule({ path: "idc/v3/cohort/manifest?expected_index_version=25.0.5" }).kind).toBe("idc_manifest");
    expect(commercialRule({ path: "/idc/series/1.2.3/objects?max_results=5" })).toEqual({ kind: "idc_series", uid: "1.2.3" });
  });

  it("refuses the values of identifier attributes and of an attribute that is not in the list", () => {
    for (const attribute of IDC_CATALOG_ATTRIBUTES) expect(commercialRule({ path: `/idc/v3/attributes/${attribute}/values` }).kind, attribute).toBe("unchanged");
    for (const attribute of ["PatientID", "StudyInstanceUID", "SeriesInstanceUID", "crdc_series_uuid", "modality"]) {
      expect(commercialRule({ path: `/idc/v3/attributes/${attribute}/values` }).kind, attribute).toBe("refuse");
    }
  });
});

describe("NBIA routes under the commercial profile", () => {
  const permitted = [series("1.1", BY3), series("1.2", BY4)];
  const notPermitted = [
    series("2.1", NC3), series("2.2", NC3), series("2.3", NC4),
    series("2.4", {}), // no license field
    series("2.5", { LicenseName: "A new license", LicenseURI: "https://example.org/license" }),
    series("2.6", { LicenseName: BY4.LicenseName, LicenseURI: NC4.LicenseURI }), // name and address disagree
  ];
  const mixed = [permitted[0], ...notPermitted.slice(0, 3), permitted[1], ...notPermitted.slice(3)];

  it("removes the series with a non-commercial, unknown or absent license, and reports their number", async () => {
    const fetch = nbia(mixed);
    const result = await createTciaApiFetch()({ method: "GET", path: "/getSeries", params: { Collection: "Fixture" }, ...commercial });
    expect(result.status).toBe(200);
    expect(result.data).toEqual({
      rows: permitted,
      _license_filter: {
        profile: "commercial",
        removed: 6,
        removed_licenses: [
          { license: NC3.LicenseName, series: 2 },
          { license: NC4.LicenseName, series: 1 },
          { license: "(no license stated)", series: 1 },
          { license: "A new license", series: 1 },
          { license: `${BY4.LicenseName} (${NC4.LicenseURI})`, series: 1 },
        ],
        reason: expect.stringContaining("not the complete result"),
        terms: "https://www.cancerimagingarchive.net/data-usage-policies-and-restrictions/",
      },
    });
    // A staged result shows this text, so a smaller table is not read as the full result.
    expect(result.completeness).toMatchObject({ complete: false, returned: 2, total_available: 8, truncation: { detail: expect.stringContaining("profile: 6.") } });
    expect(JSON.stringify(result)).not.toContain("2.1");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stages a filtered list without the removed records, and the staged result says that it is not complete", async () => {
    const long = (letter: string) => ({ SeriesDescription: letter.repeat(20_000) });
    nbia([series("1.1", { ...BY3, ...long("a") }), series("9.9.9.NC", NC3), series("1.2", { ...BY4, ...long("b") })]);
    const stored: unknown[] = [];
    const namespace = { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
      if (new URL(request.url).pathname === "/process") {
        stored.push((await request.json() as { data: unknown }).data);
        return json({ success: true, tables_created: ["rows"], total_rows: 2, input_rows: 2, table_row_counts: { rows: 2 } });
      }
      return json({ success: true, schema: { tables: { rows: { columns: [{ name: "SeriesInstanceUID" }] } } } });
    } }) };
    const proxy = createApiProxyTool({ apiFetch: createTciaApiFetch(), catalog: tciaCatalog, doNamespace: namespace, stagingPrefix: "tcia", maxInlineBytes: 30 * 1024 });
    const result = await proxy.handler({ method: "GET", path: "/getSeries", params: { Collection: "Fixture" } }, { sql: () => [], requestContext: { licenseProfile: "commercial" } });
    expect(result).toMatchObject({ __staged: true, message: expect.stringContaining("INCOMPLETE: Series removed by the commercial license profile: 1.") });
    expect(stored.length).toBeGreaterThan(0);
    expect(JSON.stringify(stored)).toContain("1.2");
    expect(JSON.stringify(stored)).not.toContain("9.9.9.NC");
  });

  it("does not change a list in which each series has a permitted license", async () => {
    nbia(permitted);
    const result = await createTciaApiFetch()({ method: "GET", path: "/getSeries", params: { Collection: "Fixture" }, ...commercial });
    expect(result).toEqual({ status: 200, data: permitted });
  });

  it("reads the license fields of /getSeriesMetaData", async () => {
    const open = { "Series UID": "1.1", Collection: "Fixture", "License Name": BY3.LicenseName, "License URL": BY3.LicenseURI };
    const closed = { "Series UID": "2.1", Collection: "Fixture", "License Name": NC3.LicenseName, "License URL": NC3.LicenseURI };
    nbia([open]);
    expect(await createTciaApiFetch()({ method: "GET", path: "/getSeriesMetaData", params: { SeriesInstanceUID: "1.1" }, ...commercial })).toEqual({ status: 200, data: [open] });
    nbia([closed]);
    const result = await createTciaApiFetch()({ method: "GET", path: "/getSeriesMetaData", params: { SeriesInstanceUID: "2.1" }, ...commercial });
    expect(result.data).toMatchObject({ rows: [], _license_filter: { removed: 1, removed_licenses: [{ license: NC3.LicenseName, series: 1 }] } });
  });

  it("keeps the empty body that NBIA gives for no record", async () => {
    nbia("");
    expect(await createTciaApiFetch()({ method: "GET", path: "/getSeries", params: { PatientID: "none" }, ...commercial })).toEqual({ status: 200, data: "" });
  });

  it("returns no content when the response is not a JSON list", async () => {
    const csv = `"SeriesInstanceUID","LicenseName"\n"2.1","${NC3.LicenseName}"\n`;
    nbia(csv);
    const result = await createTciaApiFetch()({ method: "GET", path: "/getSeries", params: { Collection: "Fixture", format: "csv" }, ...commercial });
    refused(result);
    expect(JSON.stringify(result)).not.toContain("2.1");
    nbia({ unexpected: mixed });
    refused(await createTciaApiFetch()({ method: "GET", path: "/getSeries", ...commercial }));
  });

  it("refuses the routes whose records carry no license field, with no upstream request", async () => {
    const fetch = nbia([{ PatientId: "P1", Collection: "Fixture" }]);
    for (const path of ["/getPatient", "/getPatientStudy", "/NewStudiesInPatientCollection", "/getSeriesSize", "/getPatient?Collection=Fixture"]) {
      const result = await createTciaApiFetch()({ method: "GET", path, params: { Collection: "Fixture" }, ...commercial });
      refused(result);
      expect(JSON.stringify(result.data), path).toContain("/getSeries");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses an NBIA path that is not in the catalog, with no upstream request", async () => {
    const fetch = nbia([{ any: "content" }]);
    const paths = [
      "/getImage", "/getSingleImage", "/getSOPInstanceUIDs", "/getImage?SeriesInstanceUID=1.2.3", "getImage",
      "/getseries", "/getSeries;format=csv", "/getSeries/../getImage", "/getCollectionValues/../getImage", "/v2/getSeries", "/",
    ];
    for (const path of paths) {
      const result = await createTciaApiFetch()({ method: "GET", path, params: { SeriesInstanceUID: "1.2.3" }, ...commercial });
      expect(result.status, path).toBe(451);
      expect(result.data, path).toMatchObject({ error: "NOT_LICENSED_FOR_COMMERCIAL_USE" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports the refusal through the API proxy as a failed call with the reason", async () => {
    const fetch = nbia([{ any: "content" }]);
    const proxy = createApiProxyTool({ apiFetch: createTciaApiFetch(), catalog: tciaCatalog, stagingPrefix: "tcia" });
    const request = { method: "GET", path: "/getImage", params: { SeriesInstanceUID: "1.2.3" } };
    const result = await proxy.handler(request, { sql: () => [], requestContext: { licenseProfile: "commercial" } });
    expect(result).toMatchObject({ __api_error: true, status: 451, message: expect.stringContaining("NOT_LICENSED_FOR_COMMERCIAL_USE") });
    expect(fetch).not.toHaveBeenCalled();
    // The same call with no profile goes to NBIA.
    expect(await proxy.handler(request, { sql: () => [] })).toEqual([{ any: "content" }]);
    expect(String(fetch.mock.calls[0][0])).toContain("/nbia-api/services/v1/getImage?SeriesInstanceUID=1.2.3");
  });

  it("does not change the catalog routes", async () => {
    const collections = [{ Collection: "Fixture" }, { Collection: "NSCLC-Radiomics" }];
    for (const path of ["/getCollectionValues", "/getModalityValues", "/getBodyPartValues", "/getManufacturerValues"]) {
      const fetch = nbia(collections);
      expect(await createTciaApiFetch()({ method: "GET", path, ...commercial })).toEqual({ status: 200, data: collections });
      expect(String(fetch.mock.calls[0][0])).toContain(`/nbia-api/services/v1${path}`);
    }
  });

  it("does not change a caller without the profile", async () => {
    for (const path of ["/getSeries", "/getPatient", "/getSeriesSize", "/getImage"]) {
      const fetch = nbia(mixed);
      expect(await createTciaApiFetch()({ method: "GET", path, params: { Collection: "Fixture" } })).toEqual({ status: 200, data: mixed });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    nbia("csv,of,every,license\n");
    expect(await createTciaApiFetch()({ method: "GET", path: "/getSeries", params: { format: "csv" } })).toEqual({ status: 200, data: "csv,of,every,license\n" });
  });

  it("counts each removed record once and keeps the permitted records as they are", () => {
    const result = withholdNbiaRecords([...mixed, "not a record", null]);
    expect(result.kept).toEqual(permitted);
    expect(result.kept[0]).toBe(permitted[0]);
    expect(result.removed).toBe(8);
    expect(result.removed_licenses.reduce((sum, row) => sum + row.series, 0)).toBe(8);
  });
});

describe("IDC routes under the commercial profile", () => {
  const version = { idc_version: "v25", idc_index_data_version: "25.0.5", api_version: "3.0.0b7", build: "fixture" };
  const uuid = "11111111-2222-3333-4444-555555555555";
  const NLM = "National Library of Medicine Terms and Conditions; May 21, 2019";
  const count = (license_short_name: string, total: number) => ({ license_short_name, series: total, size_TB: 0.001 });
  // A manifest row of the live API (3.0.0b7): it carries no license.
  const row = (uid: string) => ({ collection_id: "fixture", PatientID: "P1", SeriesInstanceUID: uid, Modality: "CT", aws_bucket: "idc-open-data", crdc_series_uuid: uuid, series_aws_url: `s3://idc-open-data/${uuid}/*` });
  type Body = { filters: { terms: Record<string, string[]> }; page_size?: number; sql?: string };
  type Upstream = {
    licenses?: (body: Body) => unknown;
    manifest?: (body: Body) => unknown;
    other?: unknown;
  };

  /** The IDC API, GCS and no other host. `filters_applied` repeats the request filter, as the live API does. */
  function idc(upstream: Upstream) {
    const calls: Array<{ url: string; body?: Body }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const body: Body | undefined = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, body });
      if (url.endsWith("/v3/version")) return json(version);
      if (url.endsWith("/v3/licenses") && body && upstream.licenses) return json(upstream.licenses(body));
      if (url.endsWith("/v3/cohort/manifest") && body && upstream.manifest) return json(upstream.manifest(body));
      if (url.startsWith("https://storage.googleapis.com/")) {
        return json({ kind: "storage#objects", items: [{ kind: "storage#object", bucket: "idc-open-data", name: `${uuid}/a.dcm`, generation: "17480000000000001", size: "100" }] });
      }
      return upstream.other === undefined ? new Response("not in the fixture", { status: 500 }) : json(upstream.other);
    }));
    return calls;
  }
  const routes = (calls: Array<{ url: string }>) => calls.map((call) => new URL(call.url).pathname.replace(/^\/v3/, ""));
  const breakdown = (rows: unknown[]) => (body: Body) => ({ licenses: rows, filters_applied: { terms: body.filters.terms ?? {}, ranges: {} }, warnings: [] });
  const page = (rows: unknown[], total = rows.length) => (body: Body) => ({
    counts: { series: total, filters_applied: { terms: body.filters.terms, ranges: {} }, warnings: [] },
    page: 0, page_size: body.page_size, returned: rows.length, total_series: total, series: rows,
    download: { manifest_preview: [`s3://idc-open-data/${uuid}/*`] },
  });

  describe("cohort manifest", () => {
    const filters = { terms: { collection_id: ["fixture"], PatientID: ["P1"] } };
    const request = { method: "POST", path: "/idc/v3/cohort/manifest", body: { filters, page_size: 2 } };
    const selection = [count("CC BY 4.0", 8), count("CC BY-NC 3.0", 3), count(NLM, 1)];

    it("narrows the request to the permitted licenses of the selection and reports the removed series", async () => {
      const calls = idc({ licenses: breakdown(selection), manifest: page([row("1.1"), row("1.2")], 8) });
      const result = await createTciaApiFetch()({ ...request, ...commercial });
      expect(routes(calls)).toEqual(["/version", "/licenses", "/version", "/version", "/cohort/manifest", "/version"]);
      // The lookup uses the filter of the caller; the manifest request adds the license term.
      expect(calls[1].body).toEqual({ filters });
      expect(calls[4].body).toEqual({ filters: { terms: { ...filters.terms, license_short_name: ["CC BY 4.0"] } }, page: 0, page_size: 2 });
      expect(result.status).toBe(200);
      expect(result.data).toMatchObject({
        series: [row("1.1"), row("1.2")], returned: 2, total_series: 8,
        _idc: { version },
        _license_filter: {
          profile: "commercial",
          removed: 4,
          removed_licenses: [{ license: "CC BY-NC 3.0", series: 3 }, { license: NLM, series: 1 }],
          permitted_licenses: ["CC BY 4.0"],
          scope: "selection",
          terms: "https://learn.canceridc.dev/data/licensing",
        },
      });
      expect(result.completeness).toMatchObject({ complete: false, returned: 2, total_available: 8, truncation: { detail: expect.stringContaining("profile: 4.") } });
    });

    it("reports zero removed series for a selection in which each license is permitted", async () => {
      const calls = idc({ licenses: breakdown([count("CC BY 4.0", 1), count("CC BY 3.0", 1)]), manifest: page([row("1.1"), row("1.2")]) });
      const result = await createTciaApiFetch()({ ...request, ...commercial });
      expect(calls[4].body?.filters.terms.license_short_name).toEqual(["CC BY 4.0", "CC BY 3.0"]);
      expect(result.data).toMatchObject({ series: [row("1.1"), row("1.2")], _license_filter: { removed: 0, removed_licenses: [] } });
      expect(result.completeness).toMatchObject({ complete: true });
    });

    it("returns the empty page of the provider when no series of the selection is permitted", async () => {
      const calls = idc({ licenses: breakdown([count("CC BY-NC 4.0", 5), count("", 2)]), manifest: page([]) });
      const result = await createTciaApiFetch()({ ...request, ...commercial });
      // An empty term is no filter for IDC, so the request names the permitted IDC licenses.
      expect(calls[4].body?.filters.terms.license_short_name).toEqual(["CC BY 3.0", "CC BY 4.0"]);
      expect(result.data).toMatchObject({
        series: [], total_series: 0,
        _license_filter: { removed: 7, removed_licenses: [{ license: "CC BY-NC 4.0", series: 5 }, { license: "(no license stated)", series: 2 }] },
      });
    });

    it("refuses a filter that names a license that is not permitted, with no upstream request", async () => {
      const calls = idc({ licenses: breakdown(selection), manifest: page([row("2.1")]) });
      for (const licenses of [["CC BY-NC 3.0"], ["CC BY 4.0", "CC BY-NC 4.0"], [NLM], ["A new license"]]) {
        const body = { filters: { terms: { ...filters.terms, license_short_name: licenses } } };
        refused(await createTciaApiFetch()({ ...request, body, ...commercial }));
      }
      expect(calls).toEqual([]);
    });

    it("returns no series when the provider does not confirm the license filter", async () => {
      const unconfirmed = (body: Body) => ({ ...page([row("2.1")])(body), counts: { series: 1, filters_applied: { terms: filters.terms, ranges: {} }, warnings: ["filter ignored"] } });
      idc({ licenses: breakdown(selection), manifest: unconfirmed });
      await expect(createTciaApiFetch()({ ...request, ...commercial })).rejects.toMatchObject({ status: 502, message: expect.stringContaining("did not confirm the license filter") });
    });

    it("returns no series when a row carries a license that is not permitted", async () => {
      idc({ licenses: breakdown(selection), manifest: page([row("1.1"), { ...row("2.1"), license_short_name: "CC BY-NC 3.0" }]) });
      await expect(createTciaApiFetch()({ ...request, ...commercial })).rejects.toMatchObject({ status: 502 });
      // A row that states a permitted license is in agreement with the filter.
      idc({ licenses: breakdown(selection), manifest: page([{ ...row("1.1"), license_short_name: "CC BY 4.0" }]) });
      expect((await createTciaApiFetch()({ ...request, ...commercial })).status).toBe(200);
    });

    it("returns no series when the license lookup has an unexpected shape", async () => {
      const calls = idc({ licenses: () => ({ rows: [] }), manifest: page([row("2.1")]) });
      await expect(createTciaApiFetch()({ ...request, ...commercial })).rejects.toMatchObject({ status: 502 });
      expect(routes(calls)).not.toContain("/cohort/manifest");
    });

    it("does not change a caller without the profile", async () => {
      const calls = idc({ licenses: breakdown(selection), manifest: page([row("1.1"), row("2.1")], 12) });
      const result = await createTciaApiFetch()(request);
      expect(routes(calls)).toEqual(["/version", "/cohort/manifest", "/version"]);
      expect(calls[1].body).toEqual({ filters, page: 0, page_size: 2 });
      expect(result.data).toMatchObject({ series: [row("1.1"), row("2.1")], total_series: 12 });
      expect(result.data).not.toHaveProperty("_license_filter");
    });
  });

  describe("series objects and viewer links", () => {
    const objects = { method: "GET", path: "/idc/series/1.2.3/objects" };
    const resolved = page([{ ...row("1.2.3"), instanceCount: 1 }]);
    const viewer = { viewer_url: "https://viewer.imaging.datacommons.cancer.gov/v3/viewer/?StudyInstanceUIDs=9.9&initialSeriesInstanceUID=1.2.3", viewer: "ohif_v3", study_instance_uid: "9.9", series_instance_uid: "1.2.3" };
    const link = { method: "GET", path: "/idc/v3/viewer-url", params: { series_instance_uid: "1.2.3" } };

    it("lists the objects of a series with a permitted license, as for each other caller", async () => {
      const calls = idc({ licenses: breakdown([count("CC BY 4.0", 1)]), manifest: resolved });
      const result = await createTciaApiFetch()({ ...objects, ...commercial });
      expect(calls[1].body).toEqual({ filters: { terms: { SeriesInstanceUID: ["1.2.3"] } } });
      expect(routes(calls).slice(0, 3)).toEqual(["/version", "/licenses", "/version"]);
      const open = await createTciaApiFetch()(objects);
      const files = [{ bucket: "idc-open-data", name: `${uuid}/a.dcm`, download_url: expect.stringContaining("storage.googleapis.com") }];
      expect(result.data).toMatchObject({ files });
      expect((result.data as { files: unknown }).files).toEqual((open.data as { files: unknown }).files);
      expect(result.data).not.toHaveProperty("_license_filter");
    });

    it("refuses the objects of a series whose license is not permitted, and lists no bucket", async () => {
      for (const licenses of [[count("CC BY-NC 3.0", 1)], [count(NLM, 1)], [count("CC BY 4.0", 1), count("CC BY-NC 4.0", 1)], []]) {
        const calls = idc({ licenses: breakdown(licenses), manifest: resolved });
        const result = await createTciaApiFetch()({ ...objects, ...commercial });
        refused(result);
        expect(JSON.stringify(result)).not.toContain("storage.googleapis.com");
        expect(routes(calls)).toEqual(["/version", "/licenses", "/version"]);
      }
    });

    it("returns no object when the provider does not confirm the filter of the license lookup", async () => {
      // An ignored filter gives the breakdown of the full archive; it is not the license of this series.
      const ignored = () => ({ licenses: [count("CC BY 4.0", 877215)], filters_applied: { terms: {}, ranges: {} }, warnings: ["No filter predicates were applied"] });
      const calls = idc({ licenses: ignored, manifest: resolved });
      await expect(createTciaApiFetch()({ ...objects, ...commercial })).rejects.toMatchObject({ status: 502 });
      expect(calls.some((call) => call.url.includes("storage.googleapis.com"))).toBe(false);
    });

    it("gives a viewer link only when each series of the study has a permitted license", async () => {
      let calls = idc({ licenses: breakdown([count("CC BY 4.0", 8), count("CC BY-NC 3.0", 3)]), other: viewer });
      const result = await createTciaApiFetch()({ ...link, ...commercial });
      refused(result);
      expect(JSON.stringify(result)).not.toContain("viewer.imaging");
      expect(calls.find((call) => call.url.endsWith("/v3/licenses"))?.body).toEqual({ filters: { terms: { StudyInstanceUID: ["9.9"] } } });

      calls = idc({ licenses: breakdown([count("CC BY 4.0", 8), count("CC BY 3.0", 3)]), other: viewer });
      expect((await createTciaApiFetch()({ ...link, ...commercial })).data).toMatchObject(viewer);

      idc({ licenses: breakdown([count("CC BY 4.0", 8)]), other: { viewer_url: viewer.viewer_url } });
      refused(await createTciaApiFetch()({ ...link, ...commercial }));

      calls = idc({ licenses: breakdown([count("CC BY-NC 3.0", 3)]), other: viewer });
      expect((await createTciaApiFetch()(link)).data).toMatchObject(viewer);
      expect(routes(calls)).toEqual(["/version", "/viewer-url", "/version"]);
    });
  });

  it("refuses SQL, text manifests, clinical rows, identifier values and unknown routes, with no upstream request", async () => {
    const calls = idc({ other: { rows: [{ SeriesInstanceUID: "2.1" }] } });
    const filters = { terms: { collection_id: ["fixture"] } };
    const requests = [
      { method: "POST", path: "/idc/v3/sql", body: { sql: "SELECT SeriesInstanceUID, series_aws_url FROM index" } },
      { method: "POST", path: "/idc/v3/cohort/manifest.txt", body: { filters, limit: 5 } },
      { method: "GET", path: "/idc/v3/clinical/tables/nsclc_radiomics_clinical/rows", params: { max_rows: 5 } },
      { method: "GET", path: "/idc/v3/attributes/PatientID/values" },
      { method: "GET", path: "/idc/v3/attributes/SeriesInstanceUID/values?limit=5" },
      { method: "GET", path: "/idc/v3/future-route" },
      { method: "GET", path: "/idc/v3/collections/../sql" },
      { method: "GET", path: "/idc/series" },
      { method: "GET", path: "/idc/series/1.2.3/instances" },
      { method: "GET", path: "/idc" },
    ];
    for (const request of requests) {
      const result = await createTciaApiFetch()({ ...request, ...commercial });
      expect(result.status, request.path).toBe(451);
      expect(result.data, request.path).toMatchObject({ error: "NOT_LICENSED_FOR_COMMERCIAL_USE" });
    }
    expect(calls).toEqual([]);
  });

  it("serves the routes that the profile refuses to a caller without the profile", async () => {
    const calls = idc({ other: { columns: ["SeriesInstanceUID"], rows: [{ SeriesInstanceUID: "2.1" }], row_count: 1, truncated: false } });
    const result = await createTciaApiFetch()({ method: "POST", path: "/idc/v3/sql", body: { sql: "SELECT SeriesInstanceUID FROM index" } });
    expect(result.data).toMatchObject({ rows: [{ SeriesInstanceUID: "2.1" }] });
    await createTciaApiFetch()({ method: "GET", path: "/idc/v3/attributes/PatientID/values" });
    await createTciaApiFetch()({ method: "GET", path: "/idc/v3/clinical/tables/fixture/rows" });
    expect(routes(calls).filter((route) => route !== "/version")).toEqual(["/sql", "/attributes/PatientID/values", "/clinical/tables/fixture/rows"]);
  });

  it("does not change the catalog routes, also the license breakdown of a non-commercial selection", async () => {
    const collections = [{ collection_id: "nsclc_radiomics", collection_name: "NSCLC-Radiomics", licenses: [count("CC BY-NC 3.0", 1265)] }];
    for (const path of ["/idc/v3/collections", "/idc/v3/collections/nsclc_radiomics", "/idc/v3/attributes/Modality/values", "/idc/v3/stats", "/idc/v3/clinical/tables"]) {
      const calls = idc({ other: { fixture: collections } });
      const result = await createTciaApiFetch()({ method: "GET", path, ...commercial });
      expect(result.data, path).toMatchObject({ fixture: collections });
      expect(routes(calls)).toEqual(["/version", path.replace("/idc/v3", ""), "/version"]);
    }
    const selection = [count("CC BY 4.0", 3661), count("CC BY-NC 3.0", 1265)];
    idc({ licenses: breakdown(selection) });
    const request = { method: "POST", path: "/idc/v3/licenses", body: { filters: { terms: { collection_id: ["nsclc_radiomics"] } } } };
    expect((await createTciaApiFetch()({ ...request, ...commercial })).data).toMatchObject({ licenses: selection });
  });
});
