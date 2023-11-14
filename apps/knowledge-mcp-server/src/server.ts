// server.ts — MCP server definition and tool registration
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { searchKnowledge, getKnowledgeContext } from "./ingest-client.js";

export function createServer(): Server {
  const server = new Server(
    { name: "knowledge-suite", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_knowledge",
        description:
          "Search the local knowledge base and return ranked chunks with snippets. " +
          "Use this to discover what documents exist for a topic, or to check whether " +
          "relevant context is available before calling get_knowledge_context.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Natural language search query",
            },
            limit: {
              type: "number",
              description: "Max results (1-50, default 10)",
            },
            docId: {
              type: "string",
              description: "Limit to a single document ID",
            },
            url: {
              type: "string",
              description: "Limit to a single URL",
            },
            parserMethod: {
              type: "string",
              description: "Filter by parser method (e.g. defuddle, selection)",
            },
            trace: {
              type: "boolean",
              description: "Include ranking trace in results",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "get_knowledge_context",
        description:
          "Retrieve full-text context from the local knowledge base for answer " +
          "generation. Returns citation-ready chunks with source URLs and heading " +
          "paths. Use this when you need authoritative context about a specific " +
          "topic — it returns complete chunk content ready to use as LLM input, " +
          "not just search snippets.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Natural language search query",
            },
            limit: {
              type: "number",
              description: "Max citations (1-20, default 5)",
            },
            maxChars: {
              type: "number",
              description:
                "Character budget for contextText (500-20000, default 6000)",
            },
            docId: {
              type: "string",
              description: "Limit to a single document ID",
            },
            url: {
              type: "string",
              description: "Limit to a single URL",
            },
            parserMethod: {
              type: "string",
              description: "Filter by parser method",
            },
            trace: {
              type: "boolean",
              description: "Include ranking trace in citations",
            },
          },
          required: ["query"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "search_knowledge": {
        const result = await searchKnowledge(
          args as Record<string, unknown> as {
            query: string;
            limit?: number;
            docId?: string;
            url?: string;
            parserMethod?: string;
            trace?: boolean;
          },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      case "get_knowledge_context": {
        const result = await getKnowledgeContext(
          args as Record<string, unknown> as {
            query: string;
            limit?: number;
            maxChars?: number;
            docId?: string;
            url?: string;
            parserMethod?: string;
            trace?: boolean;
          },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  return server;
}
