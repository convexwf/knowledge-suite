import { loadConfig } from "../apps/knowledge-ingest-server/dist/config.js";
import { createEmbedder } from "../apps/knowledge-ingest-server/dist/embeddings/index.js";
import { KnowledgeStore } from "../apps/knowledge-ingest-server/dist/store.js";

const config = loadConfig();
const embedder = createEmbedder(config.embeddings);
if (config.search === "hybrid" && !embedder) {
  console.warn("KNOWLEDGE_SEARCH=hybrid requires KNOWLEDGE_EMBEDDINGS=ollama; falling back to fts");
}
const store = new KnowledgeStore(config.storeRoot, { search: config.search, embedder });

try {
  const result = await store.reindexSearch();
  console.log(`reindexed documents=${result.documents} chunks=${result.chunks} embeddings=${result.embeddings}`);
} finally {
  await store.close();
}
