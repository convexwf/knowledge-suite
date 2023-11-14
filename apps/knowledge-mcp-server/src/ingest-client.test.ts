// ingest-client.test.ts — unit tests for HTTP client
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We test the searchKnowledge and getKnowledgeContext functions by mocking
// the global fetch, since the client is a thin HTTP wrapper.

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Re-import after stubbing so module-level constants (BASE_URL, TOKEN)
// are evaluated in the test environment.
const client = await vi.importActual<typeof import("./ingest-client.js")>(
  "./ingest-client.js",
);

function mockResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("searchKnowledge", () => {
  it("calls /api/search with query parameter", async () => {
    const body = { query: "test", retriever: "sqlite_fts", results: [] };
    mockFetch.mockResolvedValueOnce(mockResponse(200, body));

    const result = await client.searchKnowledge({ query: "test" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = mockFetch.mock.calls[0][0] as URL;
    expect(calledUrl.pathname).toBe("/api/search");
    expect(calledUrl.searchParams.get("q")).toBe("test");
    expect(result).toEqual(body);
  });

  it("passes optional query parameters", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, { query: "test", retriever: "sqlite_fts", results: [] }),
    );

    await client.searchKnowledge({
      query: "test",
      limit: 5,
      docId: "doc-1",
      url: "https://example.com",
      parserMethod: "defuddle",
      trace: true,
    });

    const calledUrl = mockFetch.mock.calls[0][0] as URL;
    expect(calledUrl.searchParams.get("limit")).toBe("5");
    expect(calledUrl.searchParams.get("docId")).toBe("doc-1");
    expect(calledUrl.searchParams.get("url")).toBe("https://example.com");
    expect(calledUrl.searchParams.get("parserMethod")).toBe("defuddle");
    expect(calledUrl.searchParams.get("trace")).toBe("true");
  });

  it("sends Authorization header with Bearer token", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, { query: "test", retriever: "sqlite_fts", results: [] }),
    );

    await client.searchKnowledge({ query: "test" });

    const headers = mockFetch.mock.calls[0][1]?.headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe("Bearer dev-token");
  });

  it("throws on non-200 response", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(401, { error: "unauthorized", message: "bad token" }),
    );

    await expect(
      client.searchKnowledge({ query: "test" }),
    ).rejects.toThrow("ingest server returned 401");
  });
});

describe("getKnowledgeContext", () => {
  it("calls /api/context with query parameter", async () => {
    const body = {
      query: "test",
      retriever: "sqlite_fts",
      packer: "section_chunk_v1",
      budget: { maxChars: 6000, usedChars: 100 },
      contextText: "[1] test",
      citations: [],
    };
    mockFetch.mockResolvedValueOnce(mockResponse(200, body));

    const result = await client.getKnowledgeContext({ query: "test" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = mockFetch.mock.calls[0][0] as URL;
    expect(calledUrl.pathname).toBe("/api/context");
    expect(calledUrl.searchParams.get("q")).toBe("test");
    expect(result).toEqual(body);
  });

  it("passes optional query parameters", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, {
        query: "test",
        retriever: "sqlite_fts",
        packer: "section_chunk_v1",
        budget: { maxChars: 6000, usedChars: 0 },
        contextText: "",
        citations: [],
      }),
    );

    await client.getKnowledgeContext({
      query: "test",
      limit: 3,
      maxChars: 2000,
      docId: "doc-2",
      trace: false,
    });

    const calledUrl = mockFetch.mock.calls[0][0] as URL;
    expect(calledUrl.searchParams.get("limit")).toBe("3");
    expect(calledUrl.searchParams.get("maxChars")).toBe("2000");
    expect(calledUrl.searchParams.get("docId")).toBe("doc-2");
    expect(calledUrl.searchParams.get("trace")).toBeNull();
  });
});
