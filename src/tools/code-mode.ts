import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSearchTool } from "@bio-mcp/shared/codemode/search-tool";
import { createExecuteTool } from "@bio-mcp/shared/codemode/execute-tool";
import { tciaCatalog } from "../spec/catalog";
import { createTciaApiFetch } from "../lib/api-adapter";

interface CodeModeEnv {
    TCIA_DATA_DO: DurableObjectNamespace;
    CODE_MODE_LOADER: WorkerLoader;
}

export function registerCodeMode(
    server: McpServer,
    env: CodeModeEnv,
) {
    const apiFetch = createTciaApiFetch();

    const searchTool = createSearchTool({
        prefix: "tcia",
        catalog: tciaCatalog,
    });
    searchTool.register(server as unknown as { tool: (...args: unknown[]) => void });

    const executeTool = createExecuteTool({
        prefix: "tcia",
        catalog: tciaCatalog,
        apiFetch,
        doNamespace: env.TCIA_DATA_DO,
        loader: env.CODE_MODE_LOADER,
    });
    executeTool.register(server as unknown as { tool: (...args: unknown[]) => void });
}
