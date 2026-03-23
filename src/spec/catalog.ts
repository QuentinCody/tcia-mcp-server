import type { ApiCatalog } from "@bio-mcp/shared/codemode/catalog";

export const tciaCatalog: ApiCatalog = {
    name: "The Cancer Imaging Archive (TCIA)",
    baseUrl: "https://services.cancerimagingarchive.net/nbia-api/services/v1",
    version: "1.0",
    auth: "none (public API; restricted collections require API key)",
    endpointCount: 10,
    notes:
        "- 152+ imaging collections covering cancer types (TCGA, ACRIN, clinical trials)\n" +
        "- 99 body part categories, multiple imaging modalities (CT, MR, PT, DX, etc.)\n" +
        "- No authentication required for public collections\n" +
        "- All responses are JSON arrays\n" +
        "- Use format=json query param if responses come back non-JSON\n" +
        "- For large collections (TCGA-GBM, TCGA-BRCA), patient/study/series data can be very large and will auto-stage\n" +
        "- Date format for NewStudiesInPatientCollection: YYYY/MM/DD\n" +
        "- Common collections: TCGA-GBM, TCGA-BRCA, TCGA-LUAD, LIDC-IDRI, NSCLC-Radiomics",
    endpoints: [
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
};
