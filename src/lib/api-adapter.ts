import type { ApiFetchFn } from "@bio-mcp/shared/codemode/catalog";
import { commercialTciaFetch } from "./commercial-profile";
import { tciaFetch } from "./http";
import { idcFetch } from "./idc";
import { idcError } from "./idc-http";
import { idcObjects } from "./idc-objects";
import { idcCompleteness } from "./idc-completeness";

export function createTciaApiFetch(): ApiFetchFn {
    const unrestricted: ApiFetchFn = async (request) => {
        const normalized = request.path.startsWith("/") ? request.path : `/${request.path}`;
        if (normalized === "/idc" || normalized.startsWith("/idc/")) {
            const data = await (normalized.startsWith("/idc/series/") ? idcObjects : idcFetch)({ ...request, path: normalized });
            return { status: 200, data, completeness: idcCompleteness(data) };
        }
        if (request.method.toUpperCase() !== "GET" || request.body !== undefined) idcError("legacy NBIA routes accept GET without a body only");
        const response = await tciaFetch(request.path, request.params);

        if (!response.ok) {
            let errorBody: string;
            try {
                errorBody = await response.text();
            } catch {
                errorBody = response.statusText;
            }
            const error = new Error(`HTTP ${response.status}: ${errorBody.slice(0, 200)}`) as Error & {
                status: number;
                data: unknown;
            };
            error.status = response.status;
            error.data = errorBody;
            throw error;
        }

        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("json")) {
            const text = await response.text();
            return { status: response.status, data: text };
        }

        const data = await response.json();
        return { status: response.status, data };
    };
    // A reselling caller gets the license rules of commercial-profile.ts.
    // The request of each other caller goes to the adapter with no change.
    return (request) => (request.licenseProfile === "commercial" ? commercialTciaFetch(request, unrestricted) : unrestricted(request));
}
