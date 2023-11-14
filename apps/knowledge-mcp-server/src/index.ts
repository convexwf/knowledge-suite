// index.ts — entry point: start the MCP server over stdio
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // server stays alive until stdin closes
}

main().catch((err) => {
  console.error("knowledge-suite MCP server fatal error:", err);
  process.exit(1);
});
