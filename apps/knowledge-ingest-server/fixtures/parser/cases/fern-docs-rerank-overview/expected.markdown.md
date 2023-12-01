---
title: "Rerank Overview"
page_title: "Rerank Overview - Cohere Docs"
url: "https://docs.cohere.com/docs/rerank-overview"
ingested_at: "2026-05-21T00:00:00.000Z"
language: "en"
---

# Rerank Overview

<!-- section_id:fern-docs-rerank-overview-section-1 -->
Use Rerank to sort search results by relevance. Rerank accepts a query and a list of documents, then returns an ordered list with relevance scores.

<!-- section_id:fern-docs-rerank-overview-section-2 -->
## How reranking works

<!-- section_id:fern-docs-rerank-overview-section-3 -->
The endpoint compares each document to the query and assigns a relevance score. Applications can use the score to reorder search results, recommendations, and retrieved context.

<!-- section_id:fern-docs-rerank-overview-section-4 -->
## When to use Rerank

<!-- section_id:fern-docs-rerank-overview-section-5 -->
Use reranking after lexical search, vector search, or hybrid retrieval. It is especially useful when the first retrieval pass returns candidates that are related but not equally helpful.

<!-- section_id:fern-docs-rerank-overview-section-6 -->
```
const results = await cohere.rerank({ query, documents });
```
