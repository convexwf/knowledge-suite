import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildServer } from "../apps/knowledge-ingest-server/dist/server.js";

const token = "corpus-token";
const defaultStoreRoot = resolve("knowledge-store");
const startedAt = new Date();

const corpus = [
  {
    id: "anthropic-contextual-retrieval",
    priority: "P0",
    title: "Anthropic: Contextual Retrieval",
    url: "https://www.anthropic.com/research/contextual-retrieval"
  },
  {
    id: "anthropic-contextual-retrieval-appendix-2",
    priority: "P0",
    title: "Anthropic: Contextual Retrieval Appendix II",
    url: "https://assets.anthropic.com/m/1632cded0a125333/original/Contextual-Retrieval-Appendix-2.pdf"
  },
  {
    id: "openai-retrieval-guide",
    priority: "P0",
    title: "OpenAI Retrieval Guide",
    url: "https://developers.openai.com/api/docs/guides/retrieval"
  },
  {
    id: "openai-optimizing-llm-accuracy",
    priority: "P0",
    title: "OpenAI Optimizing LLM Accuracy",
    url: "https://developers.openai.com/api/docs/guides/optimizing-llm-accuracy"
  },
  {
    id: "cohere-rerank-overview",
    priority: "P0",
    title: "Cohere Rerank Overview",
    url: "https://docs.cohere.com/docs/reranking"
  },
  {
    id: "ragas-available-metrics",
    priority: "P0",
    title: "Ragas Available Metrics",
    url: "https://docs.ragas.io/en/latest/concepts/metrics/available_metrics/"
  },
  {
    id: "ragas-paper",
    priority: "P0",
    title: "RAGAS paper",
    url: "https://arxiv.org/abs/2309.15217"
  },
  {
    id: "llamaindex-rag",
    priority: "P0",
    title: "LlamaIndex Introduction to RAG",
    url: "https://docs.llamaindex.ai/en/stable/understanding/rag/"
  },
  {
    id: "llamaindex-routing",
    priority: "P0",
    title: "LlamaIndex Routing",
    url: "https://docs.llamaindex.ai/en/stable/module_guides/querying/router/"
  },
  {
    id: "llamaindex-query-engine-modules",
    priority: "P1",
    title: "LlamaIndex Query Engine Modules",
    url: "https://docs.llamaindex.ai/en/stable/module_guides/deploying/query_engine/modules/"
  },
  {
    id: "langgraph-examples-overview",
    priority: "P1",
    title: "LangGraph Examples Overview",
    url: "https://langchain-ai.github.io/langgraph/tutorials/overview/"
  },
  {
    id: "langgraph-js-api-reference",
    priority: "P1",
    title: "LangGraph.js API Reference",
    url: "https://langchain-ai.github.io/langgraphjs/reference/modules/langgraph.html"
  },
  {
    id: "langchain-benchmarks-retrieval",
    priority: "P1",
    title: "LangChain Benchmarks Retrieval Intro",
    url: "https://langchain-ai.github.io/langchain-benchmarks/notebooks/retrieval/intro.html"
  },
  {
    id: "microsoft-graphrag-overview",
    priority: "P1",
    title: "Microsoft GraphRAG Overview",
    url: "https://microsoft.github.io/graphrag/index/overview/"
  },
  {
    id: "microsoft-graphrag-inputs",
    priority: "P1",
    title: "Microsoft GraphRAG Inputs",
    url: "https://microsoft.github.io/graphrag/index/inputs/"
  },
  {
    id: "microsoft-graphrag-query-engine",
    priority: "P1",
    title: "Microsoft GraphRAG Query Engine",
    url: "https://microsoft.github.io/graphrag/query/overview/"
  },
  {
    id: "microsoft-graphrag-methods",
    priority: "P1",
    title: "Microsoft GraphRAG Methods",
    url: "https://microsoft.github.io/graphrag/index/methods/"
  },
  {
    id: "microsoft-research-project-graphrag",
    priority: "P1",
    title: "Microsoft Research: Project GraphRAG",
    url: "https://www.microsoft.com/en-us/research/project/graphrag/"
  },
  {
    id: "agentic-rag-survey",
    priority: "P1",
    title: "Agentic RAG Survey",
    url: "https://arxiv.org/abs/2501.09136"
  },
  {
    id: "graph-rag-survey",
    priority: "P1",
    title: "Graph Retrieval-Augmented Generation Survey",
    url: "https://arxiv.org/abs/2408.08921"
  }
];

const evalCases = [
  {
    id: "eval-001",
    query: "contextual retrieval traditional RAG",
    expected: ["anthropic-contextual-retrieval"]
  },
  {
    id: "eval-002",
    query: "contextual BM25 embeddings",
    expected: ["anthropic-contextual-retrieval"]
  },
  {
    id: "eval-003",
    query: "contextual retrieval eval questions",
    expected: ["anthropic-contextual-retrieval", "anthropic-contextual-retrieval-appendix-2"]
  },
  {
    id: "eval-004",
    query: "BM25 keyword search",
    expected: ["anthropic-contextual-retrieval"]
  },
  {
    id: "eval-005",
    query: "semantic search keyword search",
    expected: ["openai-retrieval-guide", "anthropic-contextual-retrieval"]
  },
  {
    id: "eval-006",
    query: "vector store search result file citation",
    expected: ["openai-retrieval-guide"]
  },
  {
    id: "eval-007",
    query: "context precision RAG evaluation",
    expected: ["ragas-available-metrics", "ragas-paper"]
  },
  {
    id: "eval-008",
    query: "faithfulness context precision",
    expected: ["ragas-available-metrics", "ragas-paper"]
  },
  {
    id: "eval-009",
    query: "LlamaIndex RAG ingestion indexing querying response synthesis",
    expected: ["llamaindex-rag"]
  },
  {
    id: "eval-010",
    query: "LlamaIndex router query engine selector",
    expected: ["llamaindex-routing"]
  },
  {
    id: "eval-011",
    query: "query engine modules citation recursive retriever",
    expected: ["llamaindex-query-engine-modules"]
  },
  {
    id: "eval-012",
    query: "LangGraph agentic RAG tutorial",
    expected: ["langgraph-examples-overview"]
  },
  {
    id: "eval-013",
    query: "LangGraph.js StateGraph API reference",
    expected: ["langgraph-js-api-reference"]
  },
  {
    id: "eval-014",
    query: "GraphRAG indexing pipeline text units entities relationships communities",
    expected: ["microsoft-graphrag-overview", "microsoft-graphrag-methods"]
  },
  {
    id: "eval-015",
    query: "input documents text units",
    expected: ["microsoft-graphrag-inputs"]
  },
  {
    id: "eval-016",
    query: "GraphRAG Local Search Global Search DRIFT Search Basic Search",
    expected: ["microsoft-graphrag-query-engine"]
  },
  {
    id: "eval-017",
    query: "retrieval benchmark question answer dataset",
    expected: ["langchain-benchmarks-retrieval"]
  },
  {
    id: "eval-018",
    query: "agentic RAG components planning tool use memory retrieval",
    expected: ["agentic-rag-survey"]
  },
  {
    id: "eval-019",
    query: "graph retrieval augmented generation survey graph index query",
    expected: ["graph-rag-survey"]
  },
  {
    id: "eval-020",
    query: "chunk boundaries retrieval performance",
    expected: ["anthropic-contextual-retrieval"]
  }
];

const options = parseArgs(process.argv.slice(2));
const storeRoot = resolve(options.store ?? process.env.KNOWLEDGE_STORE ?? defaultStoreRoot);
const app = await buildServer({
  host: "127.0.0.1",
  port: 0,
  token,
  storeRoot,
  fetchTimeoutMs: Number(options.timeoutMs ?? process.env.KNOWLEDGE_FETCH_TIMEOUT_MS ?? 30000),
  maxHtmlBytes: Number(options.maxHtmlBytes ?? process.env.KNOWLEDGE_MAX_HTML_BYTES ?? 15 * 1024 * 1024)
});

try {
  const ingestResults = [];
  const limit = options.limit ? Number(options.limit) : corpus.length;
  const selectedCorpus = corpus.slice(0, limit);

  for (const item of selectedCorpus) {
    if (isPdfUrl(item.url)) {
      const result = {
        ...baseIngestResult(item),
        status: "skipped_pdf",
        reason: "PDF URL skipped because the current pipeline only supports server_fetch HTML."
      };
      ingestResults.push(result);
      printIngest(result);
      continue;
    }

    const result = await ingestOne(item);
    ingestResults.push(result);
    printIngest(result);
  }

  const ingestedById = new Map(
    ingestResults
      .filter((result) => result.status === "saved")
      .map((result) => [result.id, result])
  );
  const evalResults = [];

  for (const evalCase of evalCases) {
    const expectedReady = evalCase.expected.filter((id) => ingestedById.has(id));
    if (expectedReady.length === 0) {
      const result = {
        id: evalCase.id,
        query: evalCase.query,
        status: "blocked",
        expected: evalCase.expected,
        reason: "No expected document was successfully ingested.",
        resultCount: 0,
        topResults: []
      };
      evalResults.push(result);
      printEval(result);
      continue;
    }

    const result = await evaluateOne(evalCase, expectedReady, ingestedById);
    evalResults.push(result);
    printEval(result);
  }

  const report = buildReport({ ingestResults, evalResults, storeRoot });
  await writeReports(report, options.reportDir ?? "knowledge-store/reports");
  printSummary(report);
} finally {
  await app.close();
}

async function ingestOne(item) {
  const result = baseIngestResult(item);
  const started = Date.now();

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/clip/save",
      headers: headers(),
      payload: {
        inputMode: "server_fetch",
        url: item.url
      }
    });
    result.durationMs = Date.now() - started;

    if (response.statusCode !== 200) {
      result.status = "error";
      result.error = response.body;
      return result;
    }

    const body = response.json();
    const parserWarnings = asArray(body.rawdoc?.metadata?.parserWarnings);
    const parserCandidates = asArray(body.rawdoc?.metadata?.parserCandidates);
    const bestCandidate = parserCandidates[0] ?? {};
    const textLength = Number(bestCandidate.metrics?.textLength ?? markdownTextLength(body.markdown));
    const sectionCount = Array.isArray(body.document?.sections) ? body.document.sections.length : 0;
    const markdownLength = typeof body.markdown === "string" ? body.markdown.length : 0;

    return {
      ...result,
      status: "saved",
      normalizedUrl: body.status?.normalizedUrl,
      docId: body.document?.doc_id,
      rawdocId: body.rawdoc?.rawdoc_id,
      outputTitle: body.document?.title,
      parserMethod: body.rawdoc?.metadata?.parserMethod,
      parserProfile: body.rawdoc?.metadata?.parserProfile,
      parserWarnings,
      parserCandidateCount: parserCandidates.length,
      bestParserScore: typeof bestCandidate.score === "number" ? bestCandidate.score : undefined,
      textLength,
      sectionCount,
      markdownLength,
      qualityScore: scoreIngestQuality({
        textLength,
        sectionCount,
        markdownLength,
        parserWarnings,
        parserMethod: body.rawdoc?.metadata?.parserMethod
      }),
      durationMs: result.durationMs
    };
  } catch (error) {
    return {
      ...result,
      status: "error",
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function evaluateOne(evalCase, expectedReady, ingestedById) {
  const response = await app.inject({
    method: "GET",
    url: `/api/search?q=${encodeURIComponent(evalCase.query)}&limit=10`,
    headers: authHeaders()
  });

  if (response.statusCode !== 200) {
    return {
      id: evalCase.id,
      query: evalCase.query,
      status: "error",
      expected: evalCase.expected,
      expectedReady,
      error: response.body,
      resultCount: 0,
      topResults: []
    };
  }

  const body = response.json();
  const topResults = asArray(body.results).map((item, index) => ({
    rank: index + 1,
    title: item.title,
    sourceUrl: item.sourceUrl,
    normalizedUrl: item.normalizedUrl,
    score: item.score,
    snippet: item.snippet
  }));
  const ranks = expectedReady
    .map((expectedId) => {
      const expected = ingestedById.get(expectedId);
      const rank = topResults.findIndex((item) => sameSource(item, expected));
      return rank >= 0 ? rank + 1 : undefined;
    })
    .filter((rank) => typeof rank === "number");
  const bestRank = ranks.length ? Math.min(...ranks) : undefined;

  return {
    id: evalCase.id,
    query: evalCase.query,
    status: "evaluated",
    expected: evalCase.expected,
    expectedReady,
    resultCount: topResults.length,
    bestRank,
    hitAt1: bestRank !== undefined && bestRank <= 1,
    hitAt3: bestRank !== undefined && bestRank <= 3,
    hitAt5: bestRank !== undefined && bestRank <= 5,
    topResults: topResults.slice(0, 5)
  };
}

function baseIngestResult(item) {
  return {
    id: item.id,
    priority: item.priority,
    title: item.title,
    url: item.url
  };
}

function scoreIngestQuality({ textLength, sectionCount, markdownLength, parserWarnings, parserMethod }) {
  let score = 0;
  if (markdownLength >= 1000) {
    score += 30;
  } else if (markdownLength >= 300) {
    score += 15;
  }
  if (textLength >= 2500) {
    score += 30;
  } else if (textLength >= 1000) {
    score += 20;
  } else if (textLength >= 300) {
    score += 10;
  }
  if (sectionCount >= 8) {
    score += 20;
  } else if (sectionCount >= 3) {
    score += 12;
  } else if (sectionCount >= 1) {
    score += 4;
  }
  if (parserMethod && parserMethod !== "dom_fallback") {
    score += 10;
  }
  score -= Math.min(parserWarnings.length * 5, 20);
  return Math.max(0, Math.min(100, score));
}

function buildReport({ ingestResults, evalResults, storeRoot }) {
  const successful = ingestResults.filter((item) => item.status === "saved");
  const skippedPdf = ingestResults.filter((item) => item.status === "skipped_pdf");
  const failed = ingestResults.filter((item) => item.status === "error");
  const evaluated = evalResults.filter((item) => item.status === "evaluated");
  const blocked = evalResults.filter((item) => item.status === "blocked");
  const hitAt1 = ratio(evaluated.filter((item) => item.hitAt1).length, evaluated.length);
  const hitAt3 = ratio(evaluated.filter((item) => item.hitAt3).length, evaluated.length);
  const hitAt5 = ratio(evaluated.filter((item) => item.hitAt5).length, evaluated.length);

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    storeRoot,
    mode: "server_fetch",
    pdfPolicy: "skip_pdf_urls",
    summary: {
      corpusCount: ingestResults.length,
      savedCount: successful.length,
      skippedPdfCount: skippedPdf.length,
      failedCount: failed.length,
      ingestSuccessRate: ratio(successful.length, ingestResults.length - skippedPdf.length),
      averageQualityScore: average(successful.map((item) => item.qualityScore)),
      evalCount: evalResults.length,
      evaluatedCount: evaluated.length,
      blockedCount: blocked.length,
      hitAt1,
      hitAt3,
      hitAt5
    },
    ingestResults,
    evalResults,
    missedEvalCases: evaluated.filter((item) => !item.hitAt5),
    failedIngestItems: failed,
    skippedPdfItems: skippedPdf
  };
}

async function writeReports(report, reportDir) {
  const absoluteReportDir = resolve(reportDir);
  await mkdir(absoluteReportDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const jsonPath = resolve(absoluteReportDir, `retrieval-corpus-${stamp}.json`);
  const mdPath = resolve(absoluteReportDir, `retrieval-corpus-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(mdPath, renderMarkdownReport(report), "utf8");
  report.reportPaths = { jsonPath, mdPath };
}

function renderMarkdownReport(report) {
  const lines = [
    "# Retrieval Corpus Run",
    "",
    `- Started: ${report.startedAt}`,
    `- Mode: ${report.mode}`,
    `- Store: ${report.storeRoot}`,
    `- PDF policy: ${report.pdfPolicy}`,
    "",
    "## Summary",
    "",
    `- Saved: ${report.summary.savedCount}`,
    `- Skipped PDF: ${report.summary.skippedPdfCount}`,
    `- Failed ingest: ${report.summary.failedCount}`,
    `- Ingest success rate: ${formatPercent(report.summary.ingestSuccessRate)}`,
    `- Average ingest quality: ${formatNumber(report.summary.averageQualityScore)}`,
    `- Evaluated cases: ${report.summary.evaluatedCount}`,
    `- Blocked cases: ${report.summary.blockedCount}`,
    `- Hit@1: ${formatPercent(report.summary.hitAt1)}`,
    `- Hit@3: ${formatPercent(report.summary.hitAt3)}`,
    `- Hit@5: ${formatPercent(report.summary.hitAt5)}`,
    "",
    "## Failed Ingest",
    "",
    ...table(
      ["ID", "Title", "Reason"],
      report.failedIngestItems.map((item) => [item.id, item.title, truncate(item.error ?? "", 100)])
    ),
    "",
    "## Skipped PDF",
    "",
    ...table(["ID", "Title", "URL"], report.skippedPdfItems.map((item) => [item.id, item.title, item.url])),
    "",
    "## Missed Eval Cases",
    "",
    ...table(
      ["ID", "Query", "Expected", "Top Result"],
      report.missedEvalCases.map((item) => [
        item.id,
        item.query,
        item.expectedReady.join(", "),
        item.topResults[0]?.title ?? ""
      ])
    ),
    "",
    "## Ingest Results",
    "",
    ...table(
      ["ID", "Status", "Parser", "Quality", "Text", "Sections", "Warnings"],
      report.ingestResults.map((item) => [
        item.id,
        item.status,
        item.parserMethod ?? "",
        item.qualityScore ?? "",
        item.textLength ?? "",
        item.sectionCount ?? "",
        asArray(item.parserWarnings).join("; ")
      ])
    )
  ];
  return `${lines.join("\n")}\n`;
}

function printIngest(result) {
  const label = result.status === "saved"
    ? `${result.status} quality=${result.qualityScore} parser=${result.parserMethod} text=${result.textLength}`
    : `${result.status} ${result.reason ?? truncate(result.error ?? "", 120)}`;
  console.log(`[ingest] ${result.id}: ${label}`);
}

function printEval(result) {
  if (result.status === "blocked") {
    console.log(`[eval] ${result.id}: blocked (${result.reason})`);
    return;
  }
  if (result.status === "error") {
    console.log(`[eval] ${result.id}: error ${truncate(result.error ?? "", 120)}`);
    return;
  }
  const hit = result.hitAt1 ? "hit@1" : result.hitAt3 ? "hit@3" : result.hitAt5 ? "hit@5" : "miss";
  console.log(`[eval] ${result.id}: ${hit} bestRank=${result.bestRank ?? "-"} results=${result.resultCount}`);
}

function printSummary(report) {
  console.log("\nRetrieval corpus run complete");
  console.log(`saved=${report.summary.savedCount} skipped_pdf=${report.summary.skippedPdfCount} failed=${report.summary.failedCount}`);
  console.log(`ingest_success=${formatPercent(report.summary.ingestSuccessRate)} avg_quality=${formatNumber(report.summary.averageQualityScore)}`);
  console.log(`eval=${report.summary.evaluatedCount} blocked=${report.summary.blockedCount} hit@1=${formatPercent(report.summary.hitAt1)} hit@3=${formatPercent(report.summary.hitAt3)} hit@5=${formatPercent(report.summary.hitAt5)}`);
  console.log(`json=${report.reportPaths.jsonPath}`);
  console.log(`markdown=${report.reportPaths.mdPath}`);
}

function headers() {
  return {
    "content-type": "application/json",
    ...authHeaders()
  };
}

function authHeaders() {
  return {
    authorization: `Bearer ${token}`
  };
}

function sameSource(result, expected) {
  const expectedUrl = normalizeForCompare(expected.normalizedUrl ?? expected.url);
  const candidates = [result.normalizedUrl, result.sourceUrl].filter(Boolean).map(normalizeForCompare);
  return candidates.some((candidate) => candidate === expectedUrl || candidate.startsWith(`${expectedUrl}/`));
}

function normalizeForCompare(value) {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$)/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.hostname.toLowerCase()}${path}${url.search}`;
}

function isPdfUrl(value) {
  const url = new URL(value);
  return url.pathname.toLowerCase().endsWith(".pdf");
}

function markdownTextLength(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().length : 0;
}

function ratio(numerator, denominator) {
  if (!denominator) {
    return 0;
  }
  return numerator / denominator;
}

function average(values) {
  const clean = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (!clean.length) {
    return 0;
  }
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function table(headers, rows) {
  if (!rows.length) {
    return ["_None_"];
  }
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map((item) => escapeTableCell(String(item))).join(" | ")} |`)
  ];
}

function escapeTableCell(value) {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function truncate(value, length) {
  return value.length > length ? `${value.slice(0, length - 3)}...` : value;
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value) {
  return Number(value).toFixed(1);
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}
