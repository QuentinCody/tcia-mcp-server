import { restFetch } from "@bio-mcp/shared/http/rest-fetch";
import type { RestFetchOptions } from "@bio-mcp/shared/http/rest-fetch";

const TCIA_BASE = "https://services.cancerimagingarchive.net/nbia-api/services/v1";

export interface TciaFetchOptions extends Omit<RestFetchOptions, "retryOn"> {
    baseUrl?: string;
}

/**
 * Fetch from The Cancer Imaging Archive (TCIA) NBIA REST API.
 */
export async function tciaFetch(
    path: string,
    params?: Record<string, unknown>,
    opts?: TciaFetchOptions,
): Promise<Response> {
    const baseUrl = opts?.baseUrl ?? TCIA_BASE;
    const headers: Record<string, string> = {
        Accept: "application/json",
        ...(opts?.headers ?? {}),
    };

    return restFetch(baseUrl, path, params, {
        ...opts,
        headers,
        retryOn: [429, 500, 502, 503],
        retries: opts?.retries ?? 3,
        timeout: opts?.timeout ?? 30_000,
        userAgent: "tcia-mcp-server/1.0 (bio-mcp)",
    });
}
