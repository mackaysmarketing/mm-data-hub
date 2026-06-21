// ─────────────────────────────────────────────────────────────────────────────
// Hub MCP — stdio server entrypoint (SPEC §5). Run:  npm run mcp:server
//
// Identity ingress: the host sets HUB_MCP_CALLER_TOKEN (a signed JWT carrying app_metadata).
// It is verified ONCE here into a fixed session CallerIdentity; no tool argument can change it.
// No token / invalid token → fail closed (every data tool returns 0 rows). The MCP holds no
// standing elevated access: metric tools sign per-caller Cube JWTs; detail tools run as the
// least-privilege hub_mcp role dropping to `authenticated` with the caller's claims.
// ─────────────────────────────────────────────────────────────────────────────
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, TOOLS_BY_NAME } from './tools.ts';
import { makeDeps } from './deps.ts';
import { resolveSessionIdentity, scopeLabel } from './identity.ts';
import { errorCode } from './errors.ts';

const identity = resolveSessionIdentity();
const { deps, close } = makeDeps();

const server = new Server(
  { name: 'hub-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS_BY_NAME.get(req.params.name);
  if (!tool) {
    return { content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }], isError: true };
  }
  try {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const result = await tool.handler(args, identity, deps);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: errorCode(e), message }, null, 2) }],
      isError: true,
    };
  }
});

async function shutdown(): Promise<void> {
  try {
    await close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
// stdout is the MCP transport — all human logging goes to stderr.
console.error(`[hub-mcp] ready · tools=${TOOLS.length} · caller=${scopeLabel(identity)} (source=${identity.source})`);
