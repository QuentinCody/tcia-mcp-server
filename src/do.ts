import { RestStagingDO } from "@bio-mcp/shared/staging/rest-staging-do";
import type { SchemaHints } from "@bio-mcp/shared/staging/schema-inference";

export class TciaDataDO extends RestStagingDO {
    protected getSchemaHints(data: unknown): SchemaHints | undefined {
        if (!data || typeof data !== "object") return undefined;

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
