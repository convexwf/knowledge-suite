// server.ts — MCP server definition and tool registration
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  addKnowledgeHighlights,
  addKnowledgeNotes,
  getKnowledgeAnnotations,
  getKnowledgeDocument,
  getKnowledgeItem,
  getKnowledgeOutline,
  getKnowledgeReadingProgress,
  listKnowledgeCollections,
  listKnowledgeItems,
  listKnowledgeTags,
  searchKnowledge,
  getKnowledgeContext,
  listKnowledgeCategories,
  setKnowledgeReadingProgress,
} from "./ingest-client.js";

export function createServer(): Server {
  const server = new Server(
    { name: "knowledge-suite", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_knowledge_categories",
        description: "List the registered categories available for Knowledge Suite filtering.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "list_knowledge_items",
        description: "List captured Knowledge Suite items, optionally filtered by source type, category, or tag.",
        inputSchema: {
          type: "object",
          properties: {
            sourceType: { type: "string", description: "Optional source type filter, such as epub or url" },
            category: { type: "string", description: "Optional registered category filter" },
            tag: { type: "string", description: "Optional tag filter" },
            limit: { type: "number", description: "Maximum number of items to return" },
          },
        },
      },
      {
        name: "get_knowledge_item",
        description: "Get item metadata and its active document identifiers by item ID.",
        inputSchema: {
          type: "object",
          properties: { itemId: { type: "string", description: "Knowledge item ID" } },
          required: ["itemId"],
        },
      },
      {
        name: "get_knowledge_document",
        description: "Get a parsed Knowledge Suite document, including its sections and metadata, by document ID.",
        inputSchema: {
          type: "object",
          properties: { docId: { type: "string", description: "Parsed document ID" } },
          required: ["docId"],
        },
      },
      {
        name: "get_knowledge_outline",
        description: "Get the section outline for a parsed document by document ID.",
        inputSchema: {
          type: "object",
          properties: { docId: { type: "string", description: "Parsed document ID" } },
          required: ["docId"],
        },
      },
      {
        name: "get_knowledge_annotations",
        description: "List highlights and note annotations for a Knowledge Suite item.",
        inputSchema: {
          type: "object",
          properties: { itemId: { type: "string", description: "Knowledge item ID" } },
          required: ["itemId"],
        },
      },
      {
        name: "get_knowledge_reading_progress",
        description: "Get the current section and revision of an item's reading progress.",
        inputSchema: {
          type: "object",
          properties: { itemId: { type: "string", description: "Knowledge item ID" } },
          required: ["itemId"],
        },
      },
      {
        name: "set_knowledge_reading_progress",
        description: "Set or clear an item's reading section using its current expected revision.",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "Knowledge item ID" },
            sectionId: { type: ["string", "null"], description: "Section ID to mark as current, or null to clear progress" },
            expectedRevision: { type: "integer", minimum: 0, description: "Current progress revision returned by get_knowledge_reading_progress" },
          },
          required: ["itemId", "sectionId", "expectedRevision"],
        },
      },
      {
        name: "list_knowledge_tags",
        description: "List tags used in Knowledge Suite, optionally scoped to a category.",
        inputSchema: {
          type: "object",
          properties: { category: { type: "string", description: "Optional registered category" } },
        },
      },
      {
        name: "list_knowledge_collections",
        description: "List Knowledge Suite collections, optionally limited to the first N results.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number", description: "Maximum number of collections to return" } },
        },
      },
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
            category: {
              type: "string",
              description: "Filter by a registered knowledge category",
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
            category: {
              type: "string",
              description: "Filter by a registered knowledge category",
            },
            trace: {
              type: "boolean",
              description: "Include ranking trace in citations",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "add_knowledge_highlights",
        description:
          "Add persistent text highlights to a parsed Knowledge Suite document. " +
          "Pass exact excerpts from the document; each excerpt is anchored to its matching section. " +
          "Use search_knowledge first to find the document ID. Ambiguous or unmatched excerpts are skipped and reported.",
        inputSchema: {
          type: "object",
          properties: {
            docId: {
              type: "string",
              description: "Document ID returned by search_knowledge",
            },
            dryRun: {
              type: "boolean",
              description: "Preview matches and existing highlights without writing them",
            },
            highlights: {
              type: "array",
              description: "Exact document excerpts to highlight, with optional section and display metadata",
              items: {
                type: "object",
                properties: {
                  text: {
                    type: "string",
                    description: "Exact text excerpt from the document",
                  },
                  sectionId: {
                    type: "string",
                    description: "Optional section ID to disambiguate repeated excerpts",
                  },
                  note: {
                    type: "string",
                    description: "Optional note attached to the highlight",
                  },
                  color: {
                    type: "string",
                    description: "Optional CSS color for the highlight",
                  },
                },
                required: ["text"],
              },
            },
          },
          required: ["docId", "highlights"],
        },
      },
      {
        name: "add_knowledge_annotations",
        description:
          "Add persistent note annotations to a parsed Knowledge Suite document. " +
          "Provide note text and either an exact selected-text excerpt or a sectionId for a section-level note. " +
          "Selected-text notes must resolve to one location within a single section; ambiguous or unsupported excerpts are skipped and reported.",
        inputSchema: {
          type: "object",
          properties: {
            docId: {
              type: "string",
              description: "Document ID returned by search_knowledge",
            },
            dryRun: {
              type: "boolean",
              description: "Preview matches and existing notes without writing them",
            },
            annotations: {
              type: "array",
              description: "Note annotations anchored to exact excerpts or document sections",
              items: {
                type: "object",
                properties: {
                  note: {
                    type: "string",
                    description: "Annotation text",
                  },
                  text: {
                    type: "string",
                    description: "Optional exact selected-text excerpt to anchor the annotation",
                  },
                  sectionId: {
                    type: "string",
                    description: "Section ID; required when no text excerpt is supplied, or to disambiguate repeated text",
                  },
                },
                required: ["note"],
              },
            },
          },
          required: ["docId", "annotations"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "list_knowledge_categories": {
        const result = await listKnowledgeCategories();
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      case "list_knowledge_items": {
        const result = await listKnowledgeItems(
          args as Record<string, unknown> as {
            sourceType?: string;
            category?: string;
            tag?: string;
            limit?: number;
          },
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "get_knowledge_item": {
        const result = await getKnowledgeItem((args as { itemId: string }).itemId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "get_knowledge_document": {
        const result = await getKnowledgeDocument((args as { docId: string }).docId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "get_knowledge_outline": {
        const result = await getKnowledgeOutline((args as { docId: string }).docId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "get_knowledge_annotations": {
        const result = await getKnowledgeAnnotations((args as { itemId: string }).itemId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "get_knowledge_reading_progress": {
        const result = await getKnowledgeReadingProgress((args as { itemId: string }).itemId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "set_knowledge_reading_progress": {
        const result = await setKnowledgeReadingProgress(
          args as Record<string, unknown> as {
            itemId: string;
            sectionId: string | null;
            expectedRevision: number;
          },
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "list_knowledge_tags": {
        const result = await listKnowledgeTags((args as { category?: string }).category);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "list_knowledge_collections": {
        const result = await listKnowledgeCollections((args as { limit?: number }).limit);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "search_knowledge": {
        const result = await searchKnowledge(
          args as Record<string, unknown> as {
            query: string;
            limit?: number;
            docId?: string;
            url?: string;
            parserMethod?: string;
            category?: string;
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
            category?: string;
            trace?: boolean;
          },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      case "add_knowledge_highlights": {
        const result = await addKnowledgeHighlights(
          args as Record<string, unknown> as {
            docId: string;
            dryRun?: boolean;
            highlights: Array<{
              text: string;
              sectionId?: string;
              note?: string;
              color?: string;
            }>;
          },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      case "add_knowledge_annotations": {
        const result = await addKnowledgeNotes(
          args as Record<string, unknown> as {
            docId: string;
            dryRun?: boolean;
            annotations: Array<{
              note: string;
              text?: string;
              sectionId?: string;
            }>;
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
