import type { ApiCatalog } from "@bio-mcp/shared/codemode/catalog";
import { idcEndpoints } from "./idc";

export const tciaCatalog: ApiCatalog = {
    name: "TCIA NBIA + Imaging Data Commons",
    baseUrl: "https://services.cancerimagingarchive.net/nbia-api/services/v1",
    version: "1.0",
    auth: "Public NBIA metadata and public IDC v3 beta REST API; no IDC credentials or custom backend required. Restricted NBIA access is not configured here.",
    endpointCount: 10 + idcEndpoints.length,
    notes:
        "- Public cancer imaging metadata across collections, patients, studies and series. Discover current coverage rather than assuming fixed counts.\n" +
        "- TCIA ends helpdesk support for older NBIA APIs in October 2026; no full decommissioning date has been specified. Existing NBIA v1 paths remain available here.\n" +
        "- /idc/v3/* maps to the official public IDC v3 beta REST API. /idc/releases discovers versioned bulk index assets. The hosted API serves current data; expected_index_version rejects drift, not historical retrieval. Matching before/after version observations are not an atomic snapshot.\n" +
        "- /idc/series/{series_instance_uid}/objects resolves one exact series and pages its current GCS object metadata. Keep manifest/listing evidence and pagination.next identity guards. File sizes and generations remain strings; checksums are advertised, not verified. No image bytes are downloaded.\n" +
        "- No authentication required for public collections\n" +
        "- NBIA commonly returns JSON arrays. IDC keeps native fields, filters_applied, warnings and pagination plus _idc source/version metadata; top-level arrays are wrapped in rows. Requests are bounded to 64 KiB, responses to 2 MiB and 45 seconds total. Narrow queries if capped. Keep staging and error handles intact.\n" +
        "- Use format=json query param if responses come back non-JSON\n" +
        "- For large collections (TCGA-GBM, TCGA-BRCA), patient/study/series data can be very large and will auto-stage\n" +
        "- Date format for NewStudiesInPatientCollection: YYYY/MM/DD\n" +
        "- Common collections: TCGA-GBM, TCGA-BRCA, TCGA-LUAD, LIDC-IDRI, NSCLC-Radiomics",
    endpoints: [
        ...idcEndpoints,
        {
            method: "GET",
            path: "/getCollectionValues",
            summary: "List all available imaging collections (e.g., TCGA-GBM, TCGA-BRCA, LIDC-IDRI)",
            category: "collections",
        },
        {
            method: "GET",
            path: "/getModalityValues",
            summary: "List imaging modalities (CT, MR, PT, DX, etc.), optionally filtered by collection or body part",
            category: "metadata",
            queryParams: [
                { name: "Collection", type: "string", required: false, description: "Filter by collection name (e.g., TCGA-GBM)" },
                { name: "BodyPartExamined", type: "string", required: false, description: "Filter by body part (e.g., CHEST, BRAIN)" },
            ],
        },
        {
            method: "GET",
            path: "/getBodyPartValues",
            summary: "List body parts with imaging data, optionally filtered by collection or modality",
            category: "metadata",
            queryParams: [
                { name: "Collection", type: "string", required: false, description: "Filter by collection name" },
                { name: "Modality", type: "string", required: false, description: "Filter by modality (e.g., CT, MR)" },
            ],
        },
        {
            method: "GET",
            path: "/getManufacturerValues",
            summary: "List imaging equipment manufacturers, optionally filtered by collection, modality, or body part",
            category: "metadata",
            queryParams: [
                { name: "Collection", type: "string", required: false, description: "Filter by collection name" },
                { name: "Modality", type: "string", required: false, description: "Filter by modality" },
                { name: "BodyPartExamined", type: "string", required: false, description: "Filter by body part" },
            ],
        },
        {
            method: "GET",
            path: "/getPatient",
            summary: "Get patient data for a collection — returns PatientId, PatientName, PatientSex, Collection, etc.",
            category: "patients",
            queryParams: [
                { name: "Collection", type: "string", required: true, description: "Collection name (e.g., TCGA-GBM)" },
            ],
        },
        {
            method: "GET",
            path: "/getPatientStudy",
            summary: "Get studies for patients in a collection — returns StudyInstanceUID, StudyDescription, StudyDate, diagnoses",
            category: "studies",
            queryParams: [
                { name: "Collection", type: "string", required: true, description: "Collection name (e.g., TCGA-GBM)" },
                { name: "PatientID", type: "string", required: false, description: "Filter by patient ID" },
            ],
        },
        {
            method: "GET",
            path: "/getSeries",
            summary: "Get imaging series data — returns SeriesInstanceUID, Modality, BodyPartExamined, ImageCount, etc.",
            category: "series",
            queryParams: [
                { name: "Collection", type: "string", required: false, description: "Filter by collection name" },
                { name: "PatientID", type: "string", required: false, description: "Filter by patient ID" },
                { name: "StudyInstanceUID", type: "string", required: false, description: "Filter by study instance UID" },
                { name: "Modality", type: "string", required: false, description: "Filter by modality (e.g., CT, MR, PT)" },
                { name: "BodyPartExamined", type: "string", required: false, description: "Filter by body part" },
                { name: "Manufacturer", type: "string", required: false, description: "Filter by manufacturer" },
            ],
        },
        {
            method: "GET",
            path: "/getSeriesSize",
            summary: "Get size information for a specific imaging series (total bytes, object count)",
            category: "series",
            queryParams: [
                { name: "SeriesInstanceUID", type: "string", required: true, description: "Series instance UID" },
            ],
        },
        {
            method: "GET",
            path: "/getSeriesMetaData",
            summary: "Get detailed DICOM metadata for a specific imaging series",
            category: "series",
            queryParams: [
                { name: "SeriesInstanceUID", type: "string", required: true, description: "Series instance UID" },
            ],
        },
        {
            method: "GET",
            path: "/NewStudiesInPatientCollection",
            summary: "Get newly added studies since a given date — useful for tracking collection updates",
            category: "updates",
            queryParams: [
                { name: "Collection", type: "string", required: true, description: "Collection name (e.g., TCGA-GBM)" },
                { name: "Date", type: "string", required: true, description: "Date in YYYY/MM/DD format (e.g., 2024/01/01)" },
            ],
        },
    ],
    workflows: [
        {
            title: "Discover a version-guarded IDC imaging cohort",
            description: "Discover filter values, then query a current-release page. Preserve provider warnings, source context and explicit pagination.",
            keywords: ["IDC", "cohort", "manifest", "release", "DICOM"],
            code: `// Discover /idc/v3/attributes and /attributes/Modality/values before selecting values.
const version = await api.get("/idc/v3/version");
if (!version || version.__staged || version._staging || version.__api_error || version.__stage_error || version.error || version.isError || !version.idc_index_data_version) return version;
const guard = { expected_index_version: version.idc_index_data_version };
const filters = { terms: { Modality: ["CT"] } };
const counts = await api.post("/idc/v3/cohort/counts", { filters }, guard);
if (!counts || counts.__staged || counts._staging || counts.__api_error || counts.__stage_error || counts.error || counts.isError || counts.series === undefined) return counts;
const page = await api.post("/idc/v3/cohort/manifest", { filters, page: 0, page_size: 10 }, guard);
// Retain both envelopes and inspect warnings/filters_applied before using the page.
// returned/total_series describe completeness. Download links are series prefixes.
return { counts, page };`,
        },
    ],
};
