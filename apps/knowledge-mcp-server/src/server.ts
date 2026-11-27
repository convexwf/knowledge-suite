// server.ts — MCP server definition and tool registration
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  addKnowledgeHighlights,
  addKnowledgeNotes,
  cancelKnowledgeBatchJob,
  captureKnowledgePage,
  checkGitHubMarkdownUpdate,
  createKnowledgeBatchJob,
  discoverKnowledgeBatch,
  discoverKnowledgeLinks,
  deleteKnowledgeItem,
  getKnowledgeAnnotations,
  getKnowledgeBatchJob,
  getKnowledgeCaptureStatus,
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
  reparseKnowledgeFileItem,
  reparseKnowledgePage,
  refreshGitHubMarkdownItem,
  retryKnowledgeBatchJob,
  importEpubFile,
  importGitHubMarkdown,
  importMarkdownFile,
  importStructuredContent,
  previewKnowledgePage,
  saveKnowledgePage,
  saveKnowledgePageToCollection,
  scanGitHubMarkdown,
  setKnowledgeReadingProgress,
  type CaptureKnowledgePageParams,
  type BatchDiscoverParams,
  type BatchJobCreateParams,
  type DiscoverKnowledgeLinksParams,
  type EpubImportParams,
  type GitHubMarkdownParams,
  type KnowledgePageInput,
  type KnowledgeCollectionTarget,
  type MarkdownImportParams,
  type StructuredImportParams,
} from "./ingest-client.js";
import { callFeedTool, feedTools, isFeedTool } from "./feed-tools.js";

const pageSnapshotInputSchema = {
  type: "object",
  properties: {
    pageUrl: { type: "string", format: "uri" },
    canonicalUrl: { type: "string", format: "uri" },
    pageTitle: { type: "string" },
    title: { type: "string" },
    html: { type: "string" },
    text: { type: "string" },
    diagnostics: {
      type: "object",
      properties: {
        htmlLength: { type: "number" },
        textLength: { type: "number" },
        shadowRootCount: { type: "number" },
      },
      required: ["htmlLength", "textLength", "shadowRootCount"],
    },
    capturedAt: { type: "string", format: "date-time" },
    meta: { type: "object", additionalProperties: { type: "string" } },
    selectionHtml: { type: "string" },
  },
  required: ["pageUrl", "html", "capturedAt"],
};

const knowledgePageInputSchema = {
  type: "object",
  properties: {
    inputMode: { type: "string", enum: ["server_fetch", "browser_html"] },
    url: { type: "string", format: "uri", description: "Required for server_fetch" },
    snapshot: { ...pageSnapshotInputSchema, description: "Required for browser_html" },
    candidateId: { type: "string" },
    overwrite: { type: "boolean" },
    category: { type: "string" },
    collection: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 500 },
        rootUrl: { type: "string", format: "uri" },
        strategy: { type: "string", enum: ["create", "update"] },
        collectionId: { type: "string" },
        orderIndex: { type: "integer", minimum: 0 },
        depth: { type: "integer", minimum: 0 },
        source: { type: "string", maxLength: 500 },
      },
      required: ["title", "rootUrl"],
    },
  },
  required: ["inputMode"],
};

const batchScopeInputSchema = {
  type: "object",
  properties: {
    sameOrigin: { type: "boolean" },
    pathPrefix: { type: "string" },
    maxItems: { type: "integer", minimum: 1, maximum: 200 },
  },
};

const batchCandidateInputSchema = {
  type: "object",
  properties: {
    url: { type: "string", format: "uri" },
    text: { type: "string" },
    titleHint: { type: "string" },
    source: { type: "string" },
    order: { type: "integer", minimum: 0 },
    depth: { type: "integer", minimum: 0 },
  },
  required: ["url"],
};

const batchJobItemInputSchema = {
  type: "object",
  properties: {
    url: { type: "string", format: "uri" },
    titleHint: { type: "string" },
    source: { type: "string" },
    order: { type: "integer", minimum: 0 },
    depth: { type: "integer", minimum: 0 },
  },
  required: ["url"],
};

export function createServer(): Server {
  const server = new Server(
    { name: "knowledge-suite", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "get_knowledge_capture_status",
        description: "Check whether the Knowledge Capture Relay extension is connected.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "preview_knowledge_page",
        description: "Preview a URL fetched by Knowledge Suite or a supplied browser HTML snapshot without saving it.",
        inputSchema: knowledgePageInputSchema,
      },
      {
        name: "save_knowledge_page",
        description: "Save a webpage into Knowledge Suite from a URL fetched by the server or from a supplied browser HTML snapshot.",
        inputSchema: knowledgePageInputSchema,
      },
      {
        name: "save_knowledge_page_to_collection",
        description: "Save or link a webpage directly into a Knowledge Suite collection. The page is attached to the collection as part of the save operation.",
        inputSchema: {
          ...knowledgePageInputSchema,
          anyOf: [{ required: ["url"] }, { required: ["snapshot"] }],
          required: ["inputMode", "collection"],
        },
      },
      {
        name: "capture_knowledge_page",
        description: "Capture a URL through the connected Knowledge Capture Relay extension and save it to Knowledge Suite, optionally linking it directly into a collection.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", format: "uri" },
            waitMs: { type: "integer", minimum: 500, maximum: 60000 },
            candidateId: { type: "string" },
            category: { type: "string" },
            collection: knowledgePageInputSchema.properties.collection,
            tabId: { type: "integer", minimum: 1 },
            keepOpen: { type: "boolean" },
          },
          required: ["url"],
        },
      },
      {
        name: "discover_knowledge_page_links",
        description: "Use the connected Capture Relay to discover links on a webpage before selecting items for batch import.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", format: "uri" },
            waitMs: { type: "integer", minimum: 500, maximum: 60000 },
            keepOpen: { type: "boolean" },
            scope: batchScopeInputSchema,
          },
          required: ["url"],
        },
      },
      {
        name: "reparse_knowledge_page",
        description: "Reparse a previously captured webpage using its stored source HTML, optionally within a category.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", format: "uri" },
            category: { type: "string", description: "Registered category containing the saved page; defaults to default" },
          },
          required: ["url"],
        },
      },
      {
        name: "import_markdown_file",
        description: "Import one Markdown file. Pass UTF-8 file bytes as base64; optional assets use paths relative to the Markdown resource root.",
        inputSchema: {
          type: "object",
          properties: {
            fileName: { type: "string" },
            fileBase64: { type: "string" },
            sourceUri: { type: "string" },
            relativePath: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            category: { type: "string" },
            assets: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  relativePath: { type: "string" },
                  fileBase64: { type: "string" },
                  mediaType: { type: "string" },
                },
                required: ["relativePath", "fileBase64"],
              },
            },
          },
          required: ["fileName", "fileBase64"],
        },
      },
      {
        name: "import_epub_file",
        description: "Import one EPUB book. Pass the EPUB and optional OPF metadata or cover as base64 file bytes.",
        inputSchema: {
          type: "object",
          properties: {
            fileName: { type: "string" },
            fileBase64: { type: "string" },
            sourceUri: { type: "string" },
            titleHint: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            category: { type: "string" },
            metadataOpfBase64: { type: "string" },
            coverBase64: { type: "string" },
            coverFileName: { type: "string" },
            coverMediaType: { type: "string" },
          },
          required: ["fileName", "fileBase64"],
        },
      },
      {
        name: "scan_github_markdown",
        description: "Scan a GitHub Markdown file or directory before importing. Returns the resolved commit, files, assets, and warnings.",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
            ref: { type: "string" },
            path: { type: "string", description: "Repository-relative Markdown file or directory" },
            tags: { type: "array", items: { type: "string" } },
            category: { type: "string" },
          },
          required: ["owner", "repo", "ref", "path"],
        },
      },
      {
        name: "import_github_markdown",
        description: "Import a GitHub Markdown file or nested directory into Knowledge Suite. Use a file path for one-file-at-a-time imports.",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
            ref: { type: "string" },
            path: { type: "string", description: "Repository-relative Markdown file or directory" },
            tags: { type: "array", items: { type: "string" } },
            category: { type: "string" },
          },
          required: ["owner", "repo", "ref", "path"],
        },
      },
      {
        name: "import_structured_content",
        description: "Import structured external content with Markdown, metadata, comments, and media into Knowledge Suite.",
        inputSchema: {
          type: "object",
          properties: {
            provider: { type: "string" },
            platform: { type: "string" },
            itemId: { type: "string" },
            url: { type: "string", format: "uri" },
            canonicalUrl: { type: "string", format: "uri" },
            title: { type: "string" },
            authors: { type: "array", items: { type: "string" } },
            publishedAt: { type: "string" },
            language: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            category: { type: "string" },
            markdown: { type: "string" },
            comments: { type: "array", items: { type: "object" } },
            media: { type: "array", items: { type: "object" } },
            metadata: { type: "object" },
            commentsMode: { type: "string", enum: ["append", "none"] },
            overwrite: { type: "boolean" },
          },
          required: ["provider", "platform", "itemId", "url", "title", "markdown"],
        },
      },
      {
        name: "discover_knowledge_batch_imports",
        description: "Filter and deduplicate webpage links before starting a batch import.",
        inputSchema: {
          type: "object",
          properties: {
            pageUrl: { type: "string", format: "uri" },
            candidates: { type: "array", items: batchCandidateInputSchema, maxItems: 500 },
            scope: batchScopeInputSchema,
          },
          required: ["pageUrl", "candidates"],
        },
      },
      {
        name: "start_knowledge_batch_import",
        description: "Start importing a set of webpage URLs into a Knowledge Suite collection. Supply urls or items.",
        inputSchema: {
          type: "object",
          anyOf: [{ required: ["urls"] }, { required: ["items"] }],
          properties: {
            sourcePageUrl: { type: "string", format: "uri" },
            category: { type: "string", description: "Registered category in which to store this collection and import job; defaults to default" },
            mode: { type: "string", enum: ["server_fetch"] },
            collection: {
              type: "object",
              properties: {
                title: { type: "string", minLength: 1 },
                rootUrl: { type: "string", format: "uri" },
                strategy: { type: "string", enum: ["create", "update"] },
                collectionId: { type: "string" },
              },
              required: ["title", "rootUrl"],
            },
            urls: { type: "array", items: { type: "string", format: "uri" } },
            items: { type: "array", items: batchJobItemInputSchema },
            options: {
              type: "object",
              properties: {
                skipExisting: { type: "boolean" },
                maxConcurrency: { type: "integer", minimum: 1, maximum: 10 },
              },
            },
          },
          required: ["sourcePageUrl", "collection"],
        },
      },
      {
        name: "get_knowledge_batch_import",
        description: "Read the status and per-URL results of a batch import job.",
        inputSchema: { type: "object", properties: {
          jobId: { type: "string" },
          category: { type: "string", description: "Registered category containing the job; defaults to default" },
        }, required: ["jobId"] },
      },
      {
        name: "cancel_knowledge_batch_import",
        description: "Cancel a running Knowledge Suite batch import job.",
        inputSchema: { type: "object", properties: {
          jobId: { type: "string" },
          category: { type: "string", description: "Registered category containing the job; defaults to default" },
        }, required: ["jobId"] },
      },
      {
        name: "retry_knowledge_batch_import",
        description: "Retry failed items in a Knowledge Suite batch import job.",
        inputSchema: { type: "object", properties: {
          jobId: { type: "string" },
          category: { type: "string", description: "Registered category containing the job; defaults to default" },
        }, required: ["jobId"] },
      },
      {
        name: "reparse_knowledge_file_item",
        description: "Reparse a previously imported Markdown or EPUB item from its stored source file.",
        inputSchema: { type: "object", properties: {
          itemId: { type: "string" },
          category: { type: "string", description: "Registered category containing the item; defaults to default" },
        }, required: ["itemId"] },
      },
      {
        name: "check_github_markdown_update",
        description: "Check whether an imported GitHub Markdown item has changed upstream.",
        inputSchema: { type: "object", properties: {
          itemId: { type: "string" },
          category: { type: "string", description: "Registered category containing the item; defaults to default" },
        }, required: ["itemId"] },
      },
      {
        name: "refresh_github_markdown_item",
        description: "Refresh an imported GitHub Markdown item from its repository source.",
        inputSchema: { type: "object", properties: {
          itemId: { type: "string" },
          category: { type: "string", description: "Registered category containing the item; defaults to default" },
        }, required: ["itemId"] },
      },
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
        description: "Get item metadata and its active document identifiers by item ID. Pass category for non-default items.",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "Knowledge item ID" },
            category: { type: "string", description: "Registered category containing the item; defaults to default" },
          },
          required: ["itemId"],
        },
      },
      {
        name: "delete_knowledge_item",
        description: "Remove an item from Knowledge Suite. Use purge to permanently delete the item and its stored source and parsed document data.",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "Knowledge item ID" },
            mode: { type: "string", enum: ["remove", "purge"], description: "remove detaches the item; purge permanently deletes its stored data" },
            category: { type: "string", description: "Registered category containing the item; defaults to default" },
          },
          required: ["itemId"],
        },
      },
      {
        name: "get_knowledge_document",
        description: "Get a parsed Knowledge Suite document, including its sections and metadata, by document ID. Pass category for non-default documents.",
        inputSchema: {
          type: "object",
          properties: {
            docId: { type: "string", description: "Parsed document ID" },
            category: { type: "string", description: "Registered category containing the document; defaults to default" },
          },
          required: ["docId"],
        },
      },
      {
        name: "get_knowledge_outline",
        description: "Get the section outline for a parsed document by document ID. Pass category for non-default documents.",
        inputSchema: {
          type: "object",
          properties: {
            docId: { type: "string", description: "Parsed document ID" },
            category: { type: "string", description: "Registered category containing the document; defaults to default" },
          },
          required: ["docId"],
        },
      },
      {
        name: "get_knowledge_annotations",
        description: "List highlights and note annotations for a Knowledge Suite item. Pass category for items outside the default database.",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "Knowledge item ID" },
            category: { type: "string", description: "Registered category containing the item; defaults to default" },
          },
          required: ["itemId"],
        },
      },
      {
        name: "get_knowledge_reading_progress",
        description: "Get the current section and revision of an item's reading progress. Pass category for non-default items.",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "Knowledge item ID" },
            category: { type: "string", description: "Registered category containing the item; defaults to default" },
          },
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
            category: { type: "string", description: "Registered category containing the item; defaults to default" },
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
        description: "List Knowledge Suite collections, optionally scoped to a category and limited to the first N results.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Maximum number of collections to return" },
            category: { type: "string", description: "Registered category to list; defaults to default" },
          },
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
          "Pass the annotator's name, the document category when it is not default, and exact excerpts from the document; each excerpt is anchored to its matching section. " +
          "Highlights are unique per text location, regardless of annotator. " +
          "Use search_knowledge first to find the document ID. Ambiguous or unmatched excerpts are skipped and reported.",
        inputSchema: {
          type: "object",
          properties: {
            docId: {
              type: "string",
              description: "Document ID returned by search_knowledge",
            },
            category: {
              type: "string",
              description: "Registered category containing the document; defaults to default",
            },
            authorName: {
              type: "string",
              minLength: 1,
              maxLength: 80,
              description: "Required annotator name stored with each highlight",
            },
            authorColor: {
              type: "string",
              pattern: "^#[0-9A-Fa-f]{6}$",
              description: "Optional annotator color in six-digit hex; otherwise a stable color is chosen from the annotator name",
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
          required: ["docId", "authorName", "highlights"],
        },
      },
      {
        name: "add_knowledge_annotations",
        description:
          "Add persistent note annotations to a parsed Knowledge Suite document. " +
          "Provide the annotator's name, the document category when it is not default, note text and either an exact selected-text excerpt or a sectionId for a section-level note. " +
          "The same passage may have separate notes from different annotators. " +
          "Selected-text notes must resolve to one location within a single section; ambiguous or unsupported excerpts are skipped and reported.",
        inputSchema: {
          type: "object",
          properties: {
            docId: {
              type: "string",
              description: "Document ID returned by search_knowledge",
            },
            category: {
              type: "string",
              description: "Registered category containing the document; defaults to default",
            },
            authorName: {
              type: "string",
              minLength: 1,
              maxLength: 80,
              description: "Required annotator name stored with each note",
            },
            authorColor: {
              type: "string",
              pattern: "^#[0-9A-Fa-f]{6}$",
              description: "Optional annotator color in six-digit hex; otherwise a stable color is chosen from the annotator name",
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
          required: ["docId", "authorName", "annotations"],
        },
      },
      ...feedTools,
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "get_knowledge_capture_status": {
        const result = await getKnowledgeCaptureStatus();
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "preview_knowledge_page": {
        const result = await previewKnowledgePage(args as unknown as KnowledgePageInput);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "save_knowledge_page": {
        const result = await saveKnowledgePage(args as unknown as KnowledgePageInput);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "save_knowledge_page_to_collection": {
        const result = await saveKnowledgePageToCollection(
          args as unknown as KnowledgePageInput & { collection: KnowledgeCollectionTarget }
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "capture_knowledge_page": {
        const result = await captureKnowledgePage(args as unknown as CaptureKnowledgePageParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "discover_knowledge_page_links": {
        const result = await discoverKnowledgeLinks(args as unknown as DiscoverKnowledgeLinksParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "reparse_knowledge_page": {
        const input = args as { url: string; category?: string };
        const result = await reparseKnowledgePage(String(input.url ?? ""), input.category);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "import_markdown_file": {
        const result = await importMarkdownFile(args as unknown as MarkdownImportParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "import_epub_file": {
        const result = await importEpubFile(args as unknown as EpubImportParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "scan_github_markdown": {
        const result = await scanGitHubMarkdown(args as unknown as GitHubMarkdownParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "import_github_markdown": {
        const result = await importGitHubMarkdown(args as unknown as GitHubMarkdownParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "import_structured_content": {
        const result = await importStructuredContent(args as unknown as StructuredImportParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "discover_knowledge_batch_imports": {
        const result = await discoverKnowledgeBatch(args as unknown as BatchDiscoverParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "start_knowledge_batch_import": {
        const result = await createKnowledgeBatchJob(args as unknown as BatchJobCreateParams);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "get_knowledge_batch_import": {
        const input = args as { jobId: string; category?: string };
        const result = await getKnowledgeBatchJob(String(input.jobId ?? ""), input.category);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "cancel_knowledge_batch_import": {
        const input = args as { jobId: string; category?: string };
        const result = await cancelKnowledgeBatchJob(String(input.jobId ?? ""), input.category);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "retry_knowledge_batch_import": {
        const input = args as { jobId: string; category?: string };
        const result = await retryKnowledgeBatchJob(String(input.jobId ?? ""), input.category);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "reparse_knowledge_file_item": {
        const input = args as { itemId: string; category?: string };
        const result = await reparseKnowledgeFileItem(String(input.itemId ?? ""), input.category);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "check_github_markdown_update": {
        const input = args as { itemId: string; category?: string };
        const result = await checkGitHubMarkdownUpdate(String(input.itemId ?? ""), input.category);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "refresh_github_markdown_item": {
        const input = args as { itemId: string; category?: string };
        const result = await refreshGitHubMarkdownItem(String(input.itemId ?? ""), input.category);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
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
        const input = args as { itemId: string; category?: string };
        const result = await getKnowledgeItem(input.itemId, input.category);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "delete_knowledge_item": {
        const input = args as { itemId: string; mode?: "remove" | "purge"; category?: string };
        const result = await deleteKnowledgeItem(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "get_knowledge_document": {
        const input = args as { docId: string; category?: string };
        const result = await getKnowledgeDocument(input.docId, input.category);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "get_knowledge_outline": {
        const input = args as { docId: string; category?: string };
        const result = await getKnowledgeOutline(input.docId, input.category);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "get_knowledge_annotations": {
        const input = args as { itemId: string; category?: string };
        const result = await getKnowledgeAnnotations(input.itemId, input.category);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "get_knowledge_reading_progress": {
        const input = args as { itemId: string; category?: string };
        const result = await getKnowledgeReadingProgress(input.itemId, input.category);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "set_knowledge_reading_progress": {
        const result = await setKnowledgeReadingProgress(
          args as Record<string, unknown> as {
            itemId: string;
            sectionId: string | null;
            expectedRevision: number;
            category?: string;
          },
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "list_knowledge_tags": {
        const result = await listKnowledgeTags((args as { category?: string }).category);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "list_knowledge_collections": {
        const input = args as { limit?: number; category?: string };
        const result = await listKnowledgeCollections(input.limit, input.category);
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
            category?: string;
            authorName: string;
            authorColor?: string;
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
            category?: string;
            authorName: string;
            authorColor?: string;
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
      default: {
        if (isFeedTool(name)) {
          const result = await callFeedTool(name, args);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        throw new Error(`Unknown tool: ${name}`);
      }
    }
  });

  return server;
}
