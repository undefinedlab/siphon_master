// node test/call.mjs <tool> '<json args>' — one MCP tool call against the built server.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [name, args = "{}"] = process.argv.slice(2);
const client = new Client({ name: "call", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: [new URL("../dist/mcp/index.js", import.meta.url).pathname], env: { ...process.env }, stderr: "inherit" }));
const t0 = Date.now();
const r = await client.callTool({ name, arguments: JSON.parse(args) }, undefined, { timeout: 600_000 });
console.log(`== ${name} ${r.isError ? "ERROR " : ""}(${((Date.now() - t0) / 1000).toFixed(1)}s)\n${r.content[0].text}`);
await client.close();
process.exit(r.isError ? 1 : 0);
