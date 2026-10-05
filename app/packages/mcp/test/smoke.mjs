// Drive the built server as an MCP client would: list, then call read-only tools.
//   SIPHON_HOME=/tmp/x node test/smoke.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert";

const transport = new StdioClientTransport({
  command: "node",
  args: [new URL("../dist/mcp/index.js", import.meta.url).pathname],
  env: { ...process.env },
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);
const tools = (await client.listTools()).tools.map((t) => t.name);
assert.deepEqual(tools.sort(), ["siphon_cancel_order", "siphon_deposit", "siphon_market", "siphon_orders", "siphon_place_order", "siphon_private_balance", "siphon_send", "siphon_swap", "siphon_wallet"]);
const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
assert.deepEqual(prompts.sort(), ["encrypted-limit-order", "first-private-payment", "start"]);
console.log("tools:", tools.length, "prompts:", prompts.join(", "));
for (const name of (process.env.CALL || "siphon_wallet").split(",")) {
  const r = await client.callTool({ name, arguments: {} });
  console.log(`\n== ${name}${r.isError ? " (ERROR)" : ""}\n${r.content[0].text}`);
}
await client.close();
