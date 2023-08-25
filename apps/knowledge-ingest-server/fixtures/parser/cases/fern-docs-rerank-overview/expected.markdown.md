---
title: "Rerank Overview"
page_title: "Rerank Overview - Cohere Docs"
url: "https://docs.cohere.com/docs/rerank-overview"
ingested_at: "2026-05-21T00:00:00.000Z"
language: "en"
---

# Rerank Overview

Use Rerank to sort search results by relevance. Rerank accepts a query and a list of documents, then returns an ordered list with relevance scores.

## How reranking works

The endpoint compares each document to the query and assigns a relevance score. Applications can use the score to reorder search results, recommendations, and retrieved context.

## When to use Rerank

Use reranking after lexical search, vector search, or hybrid retrieval. It is especially useful when the first retrieval pass returns candidates that are related but not equally helpful.

```
const results = await cohere.rerank({ query, documents });
```
