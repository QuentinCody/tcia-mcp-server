/**
 * The commercial license profile for TCIA (NBIA) and the NCI Imaging Data
 * Commons (IDC).
 *
 * License audit 2026-11-10: "Check each collection's license and exclude the
 * non-commercial collections."
 *
 * Terms, read on 2026-11-10:
 * - TCIA (https://www.cancerimagingarchive.net/data-usage-policies-and-restrictions/):
 *   "Most data are freely available to browse, download, and use for
 *   commercial, scientific and educational purposes as outlined in the Creative
 *   Commons Attribution 3.0 Unported License or the Creative Commons
 *   Attribution 4.0 International License. A small number of collections impose
 *   Creative Commons licenses with commercial use restrictions".
 * - IDC (https://learn.canceridc.dev/data/licensing): commercial use is
 *   "allowed" for CC BY 4.0 and CC BY 3.0, "not allowed" for CC BY-NC 4.0 and
 *   CC BY-NC 3.0, and "see terms" for the NLM terms. "`license_short_name` is a
 *   series-level attribute". "To keep only data you can use commercially,
 *   filter on an explicit allowlist rather than excluding the restrictions you
 *   happen to know about".
 * - Neither provider states terms for the metadata records themselves, and IDC
 *   states no license for a clinical table. Thus a patient, study or series
 *   record has the license of its series, and a record with no license that
 *   the adapter can check is not served.
 *
 * The rule for a reselling caller (`licenseProfile: "commercial"`):
 * - Catalog metadata (collection names, modality and body-part values, counts,
 *   schemas, citations, the license breakdown) is not changed.
 * - NBIA /getSeries and /getSeriesMetaData carry the license in each record:
 *   the records whose license is not in the allowlist are removed, and
 *   `_license_filter` gives their number.
 * - An IDC cohort manifest carries no license (live API 3.0.0b7, and
 *   https://learn.canceridc.dev/rest-api/getting-data : "the license breakdown
 *   for exactly the manifest's contents is the `licenses` response for the
 *   same filter"). The adapter reads that breakdown, then sends the manifest
 *   request with a `license_short_name` term for the permitted licenses, and
 *   serves the page only if the provider confirms that filter.
 * - IDC series objects and viewer links: the adapter reads the license of the
 *   series (of the study, for a viewer link) from /v3/licenses first.
 * - A route whose records carry no license, and that has no low-cost lookup, is
 *   refused: NBIA patient, study and series-size routes, IDC SQL, IDC text
 *   manifests, IDC clinical rows, IDC values of identifier attributes.
 * - An NBIA path that is not in the catalog is refused. The adapter sends each
 *   path to NBIA, and /getImage returns image content of every license.
 */

import { type ApiFetchFn, commercialUseRefusal } from "@bio-mcp/shared/codemode/catalog";
import { idcError, isRecord } from "./idc-http";

type TciaRequest = Parameters<ApiFetchFn>[0];
type TciaResult = Awaited<ReturnType<ApiFetchFn>>;
type Refusal = ReturnType<typeof commercialUseRefusal>;
type LicenseCount = { license: string; series: number };

export const TCIA_TERMS_URL = "https://www.cancerimagingarchive.net/data-usage-policies-and-restrictions/";
export const IDC_TERMS_URL = "https://learn.canceridc.dev/data/licensing";

/**
 * License names that permit commercial use. The comparison ignores case and
 * extra spaces, and is exact in each other respect. A name that is not in the
 * list is not permitted: CC BY-NC, the TCIA restricted license, the NLM terms
 * of the Visible Human Project (IDC: "see terms"), and each new name.
 *
 * The first four names are the names that the providers use (IDC
 * `license_short_name`, NBIA `LicenseName`; both read on 2026-11-10). The
 * other names are the Creative Commons names of the public-domain tools; no
 * record with them was seen.
 */
export const COMMERCIAL_LICENSE_NAMES: readonly string[] = [
  "CC BY 3.0",
  "CC BY 4.0",
  "Creative Commons Attribution 3.0 Unported License",
  "Creative Commons Attribution 4.0 International License",
  "CC0 1.0",
  "CC0 1.0 Universal",
  "Public Domain Mark 1.0",
  "Public Domain",
];

/** License addresses that permit commercial use, without scheme, "www." and final slash. */
export const COMMERCIAL_LICENSE_URIS: readonly string[] = [
  "creativecommons.org/licenses/by/3.0",
  "creativecommons.org/licenses/by/4.0",
  "creativecommons.org/publicdomain/zero/1.0",
  "creativecommons.org/publicdomain/mark/1.0",
];

/** The IDC names in the allowlist: the license filter of a selection that has no permitted series. */
const IDC_DEFAULT_LICENSE_FILTER = ["CC BY 3.0", "CC BY 4.0"];

const nameKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();
const uriKey = (uri: string) => uri.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
const PERMITTED_NAMES = new Set(COMMERCIAL_LICENSE_NAMES.map(nameKey));
const PERMITTED_URIS = new Set(COMMERCIAL_LICENSE_URIS);
const absent = (value: unknown) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");

/**
 * True if the license of a record permits commercial use. Each license
 * statement that the record has (name, address) must be in the allowlist, and
 * the record must have one statement or more. A record with no license, and a
 * record whose name and address disagree, are not permitted.
 */
export function permitsCommercialUse(name: unknown, uri?: unknown): boolean {
  if (absent(name) && absent(uri)) return false;
  const nameOk = absent(name) || (typeof name === "string" && PERMITTED_NAMES.has(nameKey(name)));
  const uriOk = absent(uri) || (typeof uri === "string" && PERMITTED_URIS.has(uriKey(uri)));
  return nameOk && uriOk;
}

/**
 * The rule of each NBIA route. `catalog`: no change. `filter`: each record
 * carries its license, and the adapter removes the records that are not
 * permitted. `no_license_field`: refused. A path that is not a key is refused.
 */
export const NBIA_COMMERCIAL_RULES: ReadonlyMap<string, "catalog" | "filter" | "no_license_field"> = new Map([
  ["/getCollectionValues", "catalog"],
  ["/getModalityValues", "catalog"],
  ["/getBodyPartValues", "catalog"],
  ["/getManufacturerValues", "catalog"],
  ["/getSeries", "filter"],
  ["/getSeriesMetaData", "filter"],
  ["/getSeriesSize", "no_license_field"],
  ["/getPatient", "no_license_field"],
  ["/getPatientStudy", "no_license_field"],
  ["/NewStudiesInPatientCollection", "no_license_field"],
]);

/**
 * IDC attributes whose values are catalog data (names, categories, counts).
 * Not in the list: PatientID, StudyInstanceUID and SeriesInstanceUID, whose
 * values are record identifiers of every license, and each new attribute.
 */
export const IDC_CATALOG_ATTRIBUTES: ReadonlySet<string> = new Set([
  "collection_id", "analysis_result_id", "Modality", "BodyPartExamined", "Manufacturer", "ManufacturerModelName",
  "PatientSex", "sop_class_name", "license_short_name", "source_DOI", "instanceCount", "series_size_MB",
  "series_init_idc_version", "series_revised_idc_version", "StudyDate", "SeriesDate",
]);

const SEGMENT = "[A-Za-z0-9_-][A-Za-z0-9_.-]*";
const IDC_CATALOG_ROUTES = [
  /^\/idc\/releases$/,
  /^\/idc\/v3\/(?:version|stats|collections|analysis_results|attributes|tables|clinical\/tables|cohort\/counts|citations|licenses)$/,
  new RegExp(`^/idc/v3/(?:collections|tables|clinical/tables)/${SEGMENT}$`),
];

export type CommercialRule =
  | { kind: "unchanged" }
  | { kind: "refuse"; refusal: Refusal }
  | { kind: "nbia_filter"; route: string }
  | { kind: "idc_manifest" }
  | { kind: "idc_series"; uid: string }
  | { kind: "idc_viewer" };

const refuse = (what: string, terms: string): CommercialRule => ({ kind: "refuse", refusal: commercialUseRefusal(what, terms) });

function nbiaRule(route: string): CommercialRule {
  const rule = NBIA_COMMERCIAL_RULES.get(route);
  if (rule === "catalog") return { kind: "unchanged" };
  if (rule === "filter") return { kind: "nbia_filter", route };
  if (rule === "no_license_field") {
    return refuse(
      `NBIA route ${route}`,
      "its records carry no license field, and a small number of TCIA collections restrict commercial use. Use /getSeries or /getSeriesMetaData: each record gives the patient, the study, the file size and the license of one series",
    );
  }
  return refuse(
    `NBIA route ${route.slice(0, 120)}`,
    "it is not in the catalog of this server, so the license of its content is not checked; the image routes of NBIA (for example /getImage) return content of every license. Use /getSeries, which gives the license of each series",
  );
}

function idcRule(route: string): CommercialRule {
  if (IDC_CATALOG_ROUTES.some((pattern) => pattern.test(route))) return { kind: "unchanged" };
  if (route === "/idc/v3/cohort/manifest") return { kind: "idc_manifest" };
  if (route === "/idc/v3/viewer-url") return { kind: "idc_viewer" };
  const series = /^\/idc\/series\/([^/]+)\/objects$/.exec(route);
  if (series) return { kind: "idc_series", uid: series[1] };
  const attribute = /^\/idc\/v3\/attributes\/([^/]+)\/values$/.exec(route);
  if (attribute) {
    if (IDC_CATALOG_ATTRIBUTES.has(attribute[1])) return { kind: "unchanged" };
    return refuse(
      `The IDC values of attribute ${attribute[1].slice(0, 80)}`,
      "it is not a catalog attribute; the values of PatientID, StudyInstanceUID and SeriesInstanceUID are record identifiers of every license. Use /idc/v3/cohort/manifest, which returns the series with a permitted license",
    );
  }
  if (route === "/idc/v3/sql") {
    return refuse(
      "IDC SQL (/idc/v3/sql)",
      "the adapter cannot check the license of each row of an SQL result. Use /idc/v3/cohort/manifest, /idc/v3/cohort/counts and /idc/v3/licenses",
    );
  }
  if (route === "/idc/v3/cohort/manifest.txt") {
    return refuse(
      "The IDC text manifest (/idc/v3/cohort/manifest.txt)",
      "its lines carry no license, and the response does not confirm the filter that the provider applied. Use /idc/v3/cohort/manifest: series_aws_url gives the download prefix of each series with a permitted license",
    );
  }
  if (/^\/idc\/v3\/clinical\/tables\/[^/]+\/rows$/.test(route)) {
    return refuse(
      "The rows of an IDC clinical table",
      "IDC states no license for a clinical table, and a part of the IDC collections restricts commercial use. The table list and the table schemas stay available",
    );
  }
  return refuse(`IDC route ${route.slice(0, 120)}`, "it has no rule in the commercial license profile of this server");
}

/** The rule for one request. The route is the path without its query; the comparison is exact. */
export function commercialRule(request: Pick<TciaRequest, "path">): CommercialRule {
  const normalized = request.path.startsWith("/") ? request.path : `/${request.path}`;
  const route = normalized.split("?")[0];
  if (route === "/idc" || route.startsWith("/idc/")) return idcRule(route);
  return nbiaRule(route.replace(/\/+$/, ""));
}

const NO_LICENSE = "(no license stated)";
const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);

/** How a removed NBIA record is named in `_license_filter`. */
function nbiaLabel(name: unknown, uri: unknown): string {
  const stated = text(name) ?? text(uri) ?? NO_LICENSE;
  // The name is permitted and the address is not: show the two, or the entry looks like an error.
  return text(name) && text(uri) && permitsCommercialUse(name) ? `${stated} (${text(uri)})` : stated;
}

/**
 * Remove the NBIA records whose license does not permit commercial use.
 * /getSeries gives `LicenseName` and `LicenseURI`; /getSeriesMetaData gives
 * `License Name` and `License URL`. The permitted records are not changed.
 */
export function withholdNbiaRecords(records: readonly unknown[]): { kept: unknown[]; removed: number; removed_licenses: LicenseCount[] } {
  const kept: unknown[] = [];
  const withheld = new Map<string, number>();
  for (const record of records) {
    const name = isRecord(record) ? (record.LicenseName ?? record["License Name"]) : undefined;
    const uri = isRecord(record) ? (record.LicenseURI ?? record["License URL"]) : undefined;
    if (permitsCommercialUse(name, uri)) kept.push(record);
    else withheld.set(nbiaLabel(name, uri), (withheld.get(nbiaLabel(name, uri)) ?? 0) + 1);
  }
  return {
    kept,
    removed: records.length - kept.length,
    removed_licenses: Array.from(withheld, ([license, series]) => ({ license, series })),
  };
}

/** The staged form of a result shows this text; an inline result has `_license_filter`. */
function withheldCompleteness(base: TciaResult["completeness"], removed: number): NonNullable<TciaResult["completeness"]> {
  const detail = `Series removed by the commercial license profile: ${removed}. Their license does not permit commercial use.`;
  const remedy = "No request of a commercial product returns them; _license_filter gives their licenses.";
  return {
    ...base,
    complete: false,
    truncation: {
      reason: base?.truncation?.reason ?? "unknown",
      detail: [detail, base?.truncation?.detail].filter(Boolean).join(" "),
      remedy: [remedy, base?.truncation?.remedy].filter(Boolean).join(" "),
    },
  };
}

async function filteredNbia(request: TciaRequest, route: string, unrestricted: ApiFetchFn): Promise<TciaResult> {
  const result = await unrestricted(request);
  // NBIA answers "no record" with an empty body.
  if (typeof result.data === "string" && result.data.trim() === "") return result;
  if (!Array.isArray(result.data)) {
    return commercialUseRefusal(
      `NBIA route ${route} in a form other than a JSON list`,
      "the license of each record cannot be checked. Do not set the format parameter",
    );
  }
  const { kept, removed, removed_licenses } = withholdNbiaRecords(result.data);
  if (removed === 0) return result;
  return {
    status: result.status,
    data: {
      rows: kept,
      _license_filter: {
        profile: "commercial",
        removed,
        removed_licenses,
        reason: "The license of the removed records does not permit commercial use, or the record states no license. The list is not the complete result.",
        terms: TCIA_TERMS_URL,
      },
    },
    completeness: { ...withheldCompleteness(undefined, removed), returned: kept.length, total_available: result.data.length },
  };
}

/** The license breakdown of an IDC selection, from the result of /idc/v3/licenses. */
function licenseBreakdown(data: unknown): LicenseCount[] {
  const rows = isRecord(data) ? data.licenses : undefined;
  if (!Array.isArray(rows)) idcError("the license lookup has an unexpected shape; the commercial profile returns no data", 502);
  return rows.map((row: unknown) => {
    if (!isRecord(row) || typeof row.series !== "number") idcError("the license lookup has an unexpected row; the commercial profile returns no data", 502);
    // The exact string of the provider: the license filter of IDC compares it with no change.
    return { license: typeof row.license_short_name === "string" && text(row.license_short_name) ? row.license_short_name : NO_LICENSE, series: row.series };
  });
}

/** The licenses of one IDC series or study, read with a filter that the provider must confirm. */
async function selectionLicenses(unrestricted: ApiFetchFn, attribute: "SeriesInstanceUID" | "StudyInstanceUID", value: string): Promise<LicenseCount[]> {
  const lookup = await unrestricted({ method: "POST", path: "/idc/v3/licenses", body: { filters: { terms: { [attribute]: [value] } } } });
  const applied = isRecord(lookup.data) && isRecord(lookup.data.filters_applied) ? lookup.data.filters_applied.terms : undefined;
  const values = isRecord(applied) ? applied[attribute] : undefined;
  if (!isRecord(applied) || Object.keys(applied).length !== 1 || !Array.isArray(values) || values.length !== 1 || values[0] !== value) {
    idcError("the provider did not confirm the filter of the license lookup; the commercial profile returns no data", 502);
  }
  return licenseBreakdown(lookup.data);
}

/** The refusal for a selection that has a series with no permitted license, or no license record. */
function selectionRefusal(what: string, breakdown: LicenseCount[]): Refusal | undefined {
  if (breakdown.length === 0) {
    return commercialUseRefusal(what, "IDC gives no license for it (it is not in the current IDC index), and data with an unknown license is not served");
  }
  const withheld = breakdown.filter((row) => !permitsCommercialUse(row.license));
  if (withheld.length === 0) return undefined;
  const licenses = withheld.map((row) => `${row.license}: ${row.series} series`).join("; ");
  return commercialUseRefusal(what, `the license does not permit commercial use (${licenses}). See ${IDC_TERMS_URL}`);
}

/** The refusal for a manifest filter that names a license that is not permitted. */
function namedLicenseRefusal(named: unknown[]): Refusal | undefined {
  const refused = named.filter((value) => !permitsCommercialUse(value));
  if (refused.length === 0) return undefined;
  return commercialUseRefusal(
    `IDC series with the license ${refused.map(String).join(", ").slice(0, 200)}`,
    `the license does not permit commercial use, or it is not in the allowlist. Permitted in IDC: ${IDC_DEFAULT_LICENSE_FILTER.join(", ")}. See ${IDC_TERMS_URL}`,
  );
}

/**
 * The manifest data, after a check that the provider applied a license filter
 * of permitted licenses only, and that no row carries another license. Any
 * other shape throws: the commercial profile then returns no series.
 */
function confirmedManifest(data: unknown): Record<string, unknown> {
  const counts = isRecord(data) && isRecord(data.counts) ? data.counts : undefined;
  const echoed = isRecord(counts?.filters_applied) ? counts.filters_applied : isRecord(data) ? data.filters_applied : undefined;
  const applied = isRecord(echoed) && isRecord(echoed.terms) ? echoed.terms.license_short_name : undefined;
  if (!isRecord(data) || !Array.isArray(applied) || applied.length === 0 || !applied.every((value) => permitsCommercialUse(value))) {
    idcError("the provider did not confirm the license filter; the commercial profile returns no series", 502);
  }
  // The live manifest rows carry no license. If a row does, it must agree with the filter.
  const rows: unknown[] = Array.isArray(data.series) ? data.series : [];
  if (rows.some((row) => isRecord(row) && !absent(row.license_short_name) && !permitsCommercialUse(row.license_short_name))) {
    idcError("a series of the response carries a license that is not permitted; the commercial profile returns no series", 502);
  }
  return data;
}

/**
 * An IDC cohort manifest for a reselling caller. A filter that names a license
 * that is not permitted is refused before a request: the caller asked for data
 * that this product does not serve. For each other filter the adapter adds the
 * permitted licenses of the selection as a `license_short_name` term, and
 * `_license_filter` gives the series that the term removed.
 */
async function commercialManifest(request: TciaRequest, unrestricted: ApiFetchFn): Promise<TciaResult> {
  const body = isRecord(request.body) ? request.body : {};
  const filters = isRecord(body.filters) ? body.filters : {};
  const terms = isRecord(filters.terms) ? filters.terms : {};
  const named: unknown[] = Array.isArray(terms.license_short_name) ? terms.license_short_name : [];
  const refusal = namedLicenseRefusal(named);
  if (refusal) return refusal;

  // The lookup uses the filter and the version guard of the caller. A malformed
  // filter fails here with the input error of the adapter.
  const query = request.path.includes("?") ? request.path.slice(request.path.indexOf("?")) : "";
  const lookup = await unrestricted({ method: "POST", path: `/idc/v3/licenses${query}`, params: request.params, body: { filters: body.filters } });
  const breakdown = licenseBreakdown(lookup.data);
  const permitted = breakdown.filter((row) => permitsCommercialUse(row.license)).map((row) => row.license);
  const withheld = breakdown.filter((row) => !permitsCommercialUse(row.license));
  // An empty term is no filter for IDC, so the term is never empty.
  const licenses = permitted.length > 0 ? permitted : named.length > 0 ? named : IDC_DEFAULT_LICENSE_FILTER;

  const result = await unrestricted({ ...request, body: { ...body, filters: { ...filters, terms: { ...terms, license_short_name: licenses } } } });
  const data = confirmedManifest(result.data);
  const removed = withheld.reduce((sum, row) => sum + row.series, 0);
  return {
    ...result,
    data: {
      ...data,
      _license_filter: {
        profile: "commercial",
        removed,
        removed_licenses: withheld,
        permitted_licenses: licenses,
        scope: "selection",
        reason: "The series under a license that does not permit commercial use are not in this result. The counts and the pages give the permitted series only.",
        terms: IDC_TERMS_URL,
      },
    },
    ...(removed > 0 ? { completeness: withheldCompleteness(result.completeness, removed) } : {}),
  };
}

/**
 * The TCIA adapter for a reselling caller. `unrestricted` is the adapter of
 * each other caller; this function can only refuse a request, narrow it, or
 * remove records from its result.
 */
export async function commercialTciaFetch(request: TciaRequest, unrestricted: ApiFetchFn): Promise<TciaResult> {
  const rule = commercialRule(request);
  switch (rule.kind) {
    case "unchanged":
      return unrestricted(request);
    case "refuse":
      return rule.refusal;
    case "nbia_filter":
      return filteredNbia(request, rule.route, unrestricted);
    case "idc_manifest":
      return commercialManifest(request, unrestricted);
    case "idc_series": {
      const what = `IDC series ${rule.uid.slice(0, 80)}`;
      return selectionRefusal(what, await selectionLicenses(unrestricted, "SeriesInstanceUID", rule.uid)) ?? unrestricted(request);
    }
    case "idc_viewer": {
      // The link opens the full study, so each series of the study must be permitted.
      const result = await unrestricted(request);
      const study = isRecord(result.data) ? text(result.data.study_instance_uid) : undefined;
      if (!study) {
        return commercialUseRefusal("This IDC viewer link", "the response names no study, so the license of the series that the link opens cannot be checked");
      }
      const what = `The IDC viewer link of study ${study.slice(0, 80)}`;
      return selectionRefusal(what, await selectionLicenses(unrestricted, "StudyInstanceUID", study)) ?? result;
    }
  }
}
