import { RestStagingDO } from "@bio-mcp/shared/staging/rest-staging-do";
import type { SchemaHints } from "@bio-mcp/shared/staging/schema-inference";

export class TciaDataDO extends RestStagingDO {
    async fetch(request: Request): Promise<Response> {
        if (request.method !== "POST" || new URL(request.url).pathname !== "/process") return super.fetch(request);
        const body = await request.clone().json() as { data?: { _idc?: unknown; rows?: unknown; columns?: unknown } };
        const data = body.data;
        if (!data?._idc || !Array.isArray(data.rows) || !data.rows.length || !Array.isArray(data.columns) || data.columns.length < 100) return super.fetch(request);
        // Some native clinical tables exceed Worker SQLite's 100-column limit.
        // Keep the full envelope and expose lossless row JSON with a patient join key.
        const retained = await super.fetch(new Request("https://do/process", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, data: JSON.stringify(data) }) }));
        if (!retained.ok) return retained;
        const rows = data.rows.map((row: Record<string, unknown>, index: number) => ({ record_index: index,
            patient_id: row.dicom_patient_id ?? row.PatientID ?? null, record_json: JSON.stringify(row) }));
        return super.fetch(new Request("https://do/process", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, data: { idc_records: rows } }) }));
    }

    protected getSchemaHints(data: unknown): SchemaHints | undefined {
        if (!data || typeof data !== "object") return undefined;

        const envelope = data as Record<string, unknown>;
        if (Array.isArray(envelope.idc_records)) return { tableName: "idc_records", indexes: ["patient_id"],
            columnTypes: { patient_id: "TEXT", record_json: "TEXT" } };
        if (envelope._idc) {
            if (Array.isArray(envelope.series)) return { indexes: ["collection_id", "SeriesInstanceUID", "StudyInstanceUID", "PatientID", "Modality"] };
            // SQL/clinical rows can have arbitrary columns. Let native array keys
            // select table names; metadata such as warnings must remain separate.
            return undefined;
        }

        if (Array.isArray(data)) {
            const sample = data[0];
            if (!sample || typeof sample !== "object") return undefined;

            // Collections list: [{Collection: string}]
            if ("Collection" in sample && Object.keys(sample).length <= 2) {
                return {
                    tableName: "collections",
                    indexes: ["Collection"],
                };
            }

            // Patient data: has PatientId and Collection
            if ("PatientId" in sample || "PatientID" in sample) {
                // Patient-study data includes StudyInstanceUID
                if ("StudyInstanceUID" in sample) {
                    return {
                        tableName: "studies",
                        indexes: ["PatientID", "StudyInstanceUID", "StudyDescription", "Collection"],
                    };
                }
                return {
                    tableName: "patients",
                    indexes: ["PatientId", "PatientName", "Collection"],
                };
            }

            // Series data: has SeriesInstanceUID
            if ("SeriesInstanceUID" in sample) {
                return {
                    tableName: "series",
                    indexes: ["SeriesInstanceUID", "StudyInstanceUID", "Modality", "BodyPartExamined"],
                };
            }

            // Modality values: [{Modality: string}]
            if ("Modality" in sample && Object.keys(sample).length <= 2) {
                return {
                    tableName: "modalities",
                    indexes: ["Modality"],
                };
            }

            // Body part values: [{BodyPartExamined: string}]
            if ("BodyPartExamined" in sample && Object.keys(sample).length <= 2) {
                return {
                    tableName: "body_parts",
                    indexes: ["BodyPartExamined"],
                };
            }

            // Manufacturer values: [{Manufacturer: string}]
            if ("Manufacturer" in sample && Object.keys(sample).length <= 2) {
                return {
                    tableName: "manufacturers",
                    indexes: ["Manufacturer"],
                };
            }
        }

        return undefined;
    }
}
