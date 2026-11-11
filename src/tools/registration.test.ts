import { expect, it, vi } from "vitest";
import { McpServer } from "@bio-mcp/shared/mcp";
import { createApiProxyTool } from "@bio-mcp/shared/tools/api-proxy";
import { registerCodeMode } from "./code-mode";
import { registerQueryData } from "./query-data";
import { registerGetSchema } from "./get-schema";
import { createTciaApiFetch } from "../lib/api-adapter";
import { tciaCatalog } from "../spec/catalog";

it("registers both tool aliases and discovers IDC series manifests", async () => {
  const server = new McpServer({ name: "fixture", version: "1" });
  registerCodeMode(server, { CODE_MODE_LOADER: { get: () => ({}) } } as unknown as Parameters<typeof registerCodeMode>[1]);
  registerQueryData(server, {}); registerGetSchema(server, {});
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }> })._registeredTools;
  for (const name of ["tcia_search", "tcia_execute", "tcia_query_data", "tcia_get_schema"]) {
    expect(tools[name]).toBeDefined(); expect(tools[`mcp_${name}`]).toBeDefined();
  }
  const result = await tools.mcp_tcia_search.handler({ query: "/idc/v3/cohort/manifest", max_results: 5 }, {});
  expect(result).toMatchObject({ content: expect.any(Array), structuredContent: { success: true } });
  expect(JSON.stringify(result)).toContain("total_series");
  expect(await tools.mcp_tcia_query_data.handler({ data_access_id: "tcia_fixture", sql: "SELECT 1" }, {})).toMatchObject({ isError: true, content: expect.any(Array), structuredContent: expect.any(Object) });
  expect(tciaCatalog.endpointCount).toBe(tciaCatalog.endpoints.length);
});

it("preserves IDC license, object identity, page incompleteness and provenance in canonical staging", async () => {
  const version = { idc_version: "v24", idc_index_data_version: "24.2.2", api_version: "3.0.0b3", build: "fixture" };
  const raw = { series: [{ SeriesInstanceUID: "1.2.3", PatientID: "001", license_short_name: "CC BY 4.0", source_DOI: "10.fixture/source", description: "α".repeat(17_000) }], returned: 1, total_series: 3, page: 0, page_size: 1, filters_applied: { terms: { PatientID: ["001"] } }, warnings: ["fixture warning"] };
  const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(version)).mockResolvedValueOnce(json(raw)).mockResolvedValueOnce(json(version)));
  const stored: unknown[] = [];
  const namespace = { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
    if (new URL(request.url).pathname === "/process") {
      stored.push((await request.json() as { data: unknown }).data);
      return json({ success: true, tables_created: ["series"], total_rows: 1, input_rows: 1, table_row_counts: { series: 1 } });
    }
    return json({ success: true, schema: { tables: { series: { columns: [{ name: "SeriesInstanceUID" }] } } } });
  } }) } as unknown as DurableObjectNamespace;
  try {
    const proxy = createApiProxyTool({ apiFetch: createTciaApiFetch(), catalog: tciaCatalog, doNamespace: namespace, stagingPrefix: "tcia", maxInlineBytes: 30 * 1024 });
    const result = await proxy.handler({ method: "POST", path: "/idc/v3/cohort/manifest", body: { filters: { terms: { PatientID: ["001"] } }, page_size: 1 } }, { sql: () => [] });
    expect(result).toMatchObject({ __staged: true, data_access_id: expect.any(String) });
    expect(JSON.parse(stored[0] as string)).toMatchObject({ ...raw, _idc: { version } });
    expect(stored[1]).toMatchObject({ ...raw, _idc: { version } });
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(30_000);
  } finally { vi.unstubAllGlobals(); }
});

it.each([
  { __api_error: true, status: 409, message: "version drift" },
  { __staged: true, data_access_id: "tcia_fixture" },
  { __stage_error: true, message: "staging unavailable" },
])("recipe retains failed/staged version discovery %#", async handle => {
  const run = new Function("api", `return (async () => { ${tciaCatalog.workflows![0].code} })()`);
  const api = { get: vi.fn().mockResolvedValue(handle), post: vi.fn() };
  expect(await run(api)).toEqual(handle);
  expect(api.post).not.toHaveBeenCalled();
});

it("recipe retains counts warnings and a failed page instead of claiming completeness", async () => {
  const run = new Function("api", `return (async () => { ${tciaCatalog.workflows![0].code} })()`);
  const counts = { series: 20, warnings: ["inspect filters"], filters_applied: {} };
  const page = { __api_error: true, status: 409, message: "drift" };
  const api = { get: vi.fn().mockResolvedValue({ idc_index_data_version: "24.2.2" }), post: vi.fn().mockResolvedValueOnce(counts).mockResolvedValueOnce(page) };
  expect(await run(api)).toEqual({ counts, page });
  expect(api.post.mock.calls[0][2]).toEqual({ expected_index_version: "24.2.2" });
});

it("canonical proxy retains upstream validation errors", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"detail":"invalid filter"}', { status: 422 })));
  try {
    const proxy = createApiProxyTool({ apiFetch: createTciaApiFetch(), catalog: tciaCatalog, stagingPrefix: "tcia", maxInlineBytes: 30 * 1024 });
    expect(await proxy.handler({ method: "GET", path: "/idc/v3/stats" }, { sql: () => [] })).toMatchObject({ __api_error: true, incomplete: true, status: 422, data: { response: '{"detail":"invalid filter"}' } });
  } finally { vi.unstubAllGlobals(); }
});
