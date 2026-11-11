/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { McpServer } from "@bio-mcp/shared/mcp";
import { hashCanonicalJson, verifyCitationEnvelope } from "@bio-mcp/shared";
import { DynamicWorkerExecutor } from "@bio-mcp/shared/codemode/execute-tool";
vi.mock("cloudflare:workers", () => ({ RpcTarget: class {}, DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} } }));
import { TciaDataDO } from "../do";
import { registerCodeMode } from "./code-mode";
import { registerQueryData } from "./query-data";
import { registerGetSchema } from "./get-schema";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function createStore() {
  const database = new DatabaseSync(":memory:");
  let ready = Promise.resolve();
  const exec = (query: string, ...values: any[]) => {
    const rows = database.prepare(query).all(...values);
    const iterator = rows[Symbol.iterator]();
    return { toArray: () => rows, one: () => rows[0], next: () => iterator.next(), [Symbol.iterator]: () => iterator };
  };
  const transactionSync = <T>(run: () => T): T => {
    database.exec("BEGIN");
    try { const result = run(); database.exec("COMMIT"); return result; }
    catch (error) { database.exec("ROLLBACK"); throw error; }
  };
  const ctx = { blockConcurrencyWhile: (run: () => Promise<void>) => { ready = run(); return ready; }, storage: { sql: { exec }, transactionSync } };
  const instance = new TciaDataDO(ctx as unknown as DurableObjectState, {} as Cloudflare.Env);
  return { database, instance, ready };
}

function fixture() {
  // Run the generated API helpers and user program, replacing only the Cloudflare isolate.
  vi.spyOn(DynamicWorkerExecutor.prototype, "execute").mockImplementation(async (code, functions) => {
    const staged: Array<Record<string, unknown>> = [];
    try {
      const run = new Function("codemode", "__stagedResults", "console", `return (${code})();`);
      const result = await run(functions, staged, { warn() {}, log() {} });
      return { result: JSON.parse(JSON.stringify(result)), __stagedResults: staged };
    } catch (error) { return { error: String((error as Error).message), __stagedResults: staged }; }
  });
  const stores = new Map<string, ReturnType<typeof createStore>>();
  const namespace = { idFromName: (name: string) => name, get: (id: string) => ({ fetch: async (request: Request) => {
    let store = stores.get(id);
    if (!store) { store = createStore(); stores.set(id, store); }
    await store.ready;
    return store.instance.fetch(request);
  } }) };
  const env = { TCIA_DATA_DO: namespace, CODE_MODE_LOADER: { get: () => ({}) } } as unknown as Parameters<typeof registerCodeMode>[1];
  const server = new McpServer({ name: "fixture", version: "1" });
  registerCodeMode(server, env); registerQueryData(server, env); registerGetSchema(server, env);
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<any> }> })._registeredTools;
  return { tools, close: () => { for (const store of stores.values()) store.database.close(); } };
}

async function recover(f: ReturnType<typeof fixture>, id: string, prefix: string) {
  const rows = async (sql: string) => {
    const output = await f.tools[`${prefix}tcia_query_data`].handler({ data_access_id: id, sql }, {});
    expect(output.isError, JSON.stringify(output)).not.toBe(true);
    expect(output.structuredContent.staged).not.toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(output)).byteLength).toBeLessThan(30720);
    return output.structuredContent.data.rows;
  };
  const text = async (table: string, column: string, where: string) => {
    const [{ n }] = await rows(`SELECT length(${column}) AS n FROM ${table} WHERE ${where}`);
    let result = "";
    for (let start = 1; start <= n; start += 1000) {
      const [row] = await rows(`SELECT substr(${column}, ${start}, 1000) AS part FROM ${table} WHERE ${where}`);
      result += row.part;
    }
    return result;
  };
  let raw = await text("payloads", "root_json", "id = 1");
  if (raw.startsWith("__CHUNKED__:")) {
    const chunk = raw.slice("__CHUNKED__:".length);
    expect(chunk).toMatch(/^chunk_[a-f0-9]{32}$/);
    const parts = await rows(`SELECT chunk_index FROM content_chunks WHERE content_id = '${chunk}' ORDER BY chunk_index`);
    raw = "";
    for (const part of parts) raw += await text("content_chunks", "chunk_data", `content_id = '${chunk}' AND chunk_index = ${part.chunk_index}`);
  }
  const decoded = JSON.parse(raw);
  return typeof decoded === "string" ? JSON.parse(decoded) : decoded;
}

const uuid = "11111111-2222-3333-4444-555555555555";
const version = { idc_version: "v24", idc_index_data_version: "24.2.2", api_version: "3.0.0b4", build: null };
const manifest = { counts: { series: 1, instances: 500, filters_applied: { terms: { SeriesInstanceUID: ["1.2.3"] } }, warnings: ["native warning"] },
  page: 0, page_size: 1, returned: 1, total_series: 1,
  series: [{ SeriesInstanceUID: "1.2.3", aws_bucket: "idc-open-data", crdc_series_uuid: uuid, series_aws_url: `s3://idc-open-data/${uuid}/*` }] };
const code = " \nreturn await api.get('/idc/series/{series_instance_uid}/objects', {series_instance_uid:'1.2.3'});\r\n";
const json = (data: unknown) => new Response(JSON.stringify(data));
function upstream(text: string, status = 200) {
  return vi.fn(async (url: string) => url.endsWith("/version") ? json(version) : url.endsWith("/manifest") ? json(manifest) : new Response(text, { status, headers: { "retry-after": "60" } }));
}

it("discovers the object inventory through both search aliases", async () => {
  const f = fixture();
  try {
    for (const prefix of ["", "mcp_"]) {
      const result = await f.tools[`${prefix}tcia_search`].handler({ query: "IDC object inventory", max_results: 5 }, {});
      expect(result).toMatchObject({ content: expect.any(Array), structuredContent: { success: true } });
      expect(JSON.stringify(result)).toContain("/idc/series/{series_instance_uid}/objects");
    }
  } finally { f.close(); }
});

it("keeps wide clinical cells queryable, with native evidence and verified helper citations", async () => {
  const f = fixture();
  const row = { dicom_patient_id: "001", ...Object.fromEntries(Array.from({ length: 155 }, (_, i) => [`c${i}`, i % 2 ? null : `α🧬 ${i}`])) };
  const rows = Array.from({ length: 20 }, () => row);
  const native = { columns: Object.keys(row), rows, row_count: 20, truncated: true, max_rows: 20 };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => json(url.endsWith("/version") ? version : native)));
  try {
    for (const prefix of ["", "mcp_"]) {
      const result = await f.tools[`${prefix}tcia_execute`].handler({ code: "return await api.get('/idc/v3/clinical/tables/fixture/rows', {max_rows:20});" }, {});
      expect(result.isError).not.toBe(true);
      const id = result.structuredContent.data.data_access_id;
      expect(result.structuredContent.data.tables_created).toContain("idc_records");
      expect(result.structuredContent._meta.completeness).toMatchObject({ complete: false, returned: 20, truncation: { reason: "upstream_cap" } });
      expect(await recover(f, id, prefix)).toMatchObject(native);
      for (const [name, args] of [
        ["query_data", { data_access_id: id, sql: "SELECT patient_id, record_json FROM idc_records WHERE record_index=0" }],
        ["get_schema", { data_access_id: id }],
      ] as const) {
        const response = await f.tools[`${prefix}tcia_${name}`].handler(args, {});
        expect(response.isError).not.toBe(true);
        expect(response.structuredContent.staged).not.toBe(true);
        const verified = await verifyCitationEnvelope({ citation: response.structuredContent._meta.citation,
          structuredContent: response.structuredContent, toolArguments: args });
        expect(verified.verification).toMatchObject({ query: "verified", result: "verified", quarantined: false });
        if (name === "query_data") {
          expect(response.structuredContent.data.rows[0].patient_id).toBe("001");
          expect(JSON.parse(response.structuredContent.data.rows[0].record_json)).toEqual(row);
        }
      }
    }
  } finally { f.close(); }
});

it.each([false, true])("preserves native pages, precise object identities and citation hashes (large=%s)", async large => {
  const f = fixture();
  const listing = { kind: "storage#objects", nextPageToken: "next+/==", items: [{ kind: "storage#object", bucket: "idc-open-data",
    name: `${uuid}/file.dcm`, generation: "9007199254740993", size: "9007199254740995", crc32c: "advertised", metadata: { unicode: 'α 🧬 \\"'.repeat(large ? 12000 : 1) } }] };
  const fetch = upstream(JSON.stringify(listing));
  vi.stubGlobal("fetch", fetch);
  try {
    for (const prefix of ["", "mcp_"]) {
      const result = await f.tools[`${prefix}tcia_execute`].handler({ code }, {});
      expect(result).toMatchObject({ content: expect.any(Array), structuredContent: { success: true, _meta: { citation: { result_hash: expect.any(String) } } } });
      expect(result.isError).not.toBe(true);
      expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(30720);
      let recovered = result.structuredContent.data;
      if (large) {
        expect(result.structuredContent._staging).toBeDefined();
        const id = result.structuredContent.data_access_id ?? result.structuredContent.data?.data_access_id;
        recovered = await recover(f, id, prefix);
        const schema = await f.tools[`${prefix}tcia_get_schema`].handler({ data_access_id: id }, {});
        expect(schema.isError).not.toBe(true); expect(schema.content).toBeDefined(); expect(schema.structuredContent).toBeDefined();
        const rows = await f.tools[`${prefix}tcia_query_data`].handler({ data_access_id: id, sql: "SELECT name, generation, size FROM files" }, {});
        expect(rows).toMatchObject({ structuredContent: { data: { rows: [{ name: `${uuid}/file.dcm`, generation: "9007199254740993", size: "9007199254740995" }] } } });
      }
      expect(recovered).toMatchObject({ manifest, listing, pagination: { has_more: true, next: { params: { expected_index_version: "24.2.2", expected_series_uuid: uuid } } } });
      expect(result.structuredContent._meta.citation.result_hash).toBe(await hashCanonicalJson(recovered));
      expect(result.structuredContent._meta.citation.query_scope).toBe("tool_argument:code");
      expect(result.structuredContent._meta.citation.query_hash).toBe(await hashCanonicalJson(code));
      const verified = await verifyCitationEnvelope({ citation: result.structuredContent._meta.citation,
        structuredContent: result.structuredContent, toolArguments: { code }, materialized: { value: recovered } });
      expect(verified.verification).toMatchObject({ query: "verified", result: "verified", quarantined: false });
    }
    expect(fetch).toHaveBeenCalledTimes(8);
  } finally { f.close(); }
});

it.each([false, true])("preserves native provider failures with both fields and isError (large=%s)", async large => {
  const f = fixture();
  const text = JSON.stringify({ error: { code: 429, message: 'α 🧬 \\"'.repeat(large ? 12000 : 1) } });
  vi.stubGlobal("fetch", upstream(text, 429));
  try {
    for (const prefix of ["", "mcp_"]) {
      const result = await f.tools[`${prefix}tcia_execute`].handler({ code }, {});
      expect(result).toMatchObject({ isError: true, content: expect.any(Array), structuredContent: { success: false } });
      expect(result.structuredContent._meta.citation.query_hash).toBe(await hashCanonicalJson(code));
      expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(30720);
      const marker = result.structuredContent.error?.details?.data ?? result.structuredContent.data?.data;
      const recovered = large ? await recover(f, marker.data_access_id, prefix) : marker;
      if (large) expect(marker).toMatchObject({ __staged: true, _staging: expect.any(Object) });
      expect(recovered).toMatchObject({ manifest, inventory_complete: false, upstream: { response: text, http_status: 429, retry_after: "60", response_sha256: expect.any(String) } });
    }
  } finally { f.close(); }
});
