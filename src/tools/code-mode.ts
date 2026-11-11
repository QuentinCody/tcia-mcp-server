import type { McpServer } from "@bio-mcp/shared/mcp";
import { createSearchTool } from "@bio-mcp/shared/codemode/search-tool";
import { createExecuteTool } from "@bio-mcp/shared/codemode/execute-tool";
import { tciaCatalog } from "../spec/catalog";
import { createTciaApiFetch } from "../lib/api-adapter";
import { tciaResponse } from "../lib/tool-result";

interface CodeModeEnv {
    TCIA_DATA_DO: DurableObjectNamespace;
    CODE_MODE_LOADER: WorkerLoader;
}

export function registerCodeMode(
    server: McpServer,
    env: CodeModeEnv,
): void {
    const apiFetch = createTciaApiFetch();
    const registrar = { tool: (...args: unknown[]) => {
        const [name, ...rest] = args;
        const handler = rest.pop() as (input: unknown, extra: unknown) => ReturnType<typeof tciaResponse>;
        const respond = (input: unknown, extra: unknown) => tciaResponse(
            () => handler(input, extra), env, String(name), extra, input);
        const register = server.tool.bind(server) as (...values: unknown[]) => void;
        register(name, ...rest, respond);
        register(`mcp_${String(name)}`, ...rest, respond);
    } };

    const searchTool = createSearchTool({
        prefix: "tcia",
        catalog: tciaCatalog,
    });
    searchTool.register(registrar);

    const executeTool = createExecuteTool({
        prefix: "tcia",
        // Verifiable provenance: tcia_execute results carry a _meta.citation.
        source: { id: "tcia", name: "TCIA / Imaging Data Commons", url: "https://www.cancerimagingarchive.net/tcia-api-guides/" },
        catalog: tciaCatalog,
        apiFetch,
        preserveApiErrors: true,
        maxInlineBytes: 30 * 1024,
        stagingThreshold: 30 * 1024,
        timeout: 60_000,
        doNamespace: env.TCIA_DATA_DO,
        loader: env.CODE_MODE_LOADER,
    });
    executeTool.register(registrar);
}
