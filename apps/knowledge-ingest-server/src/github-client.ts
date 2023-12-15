export interface GitHubClientOptions {
  apiUrl: string;
  token?: string;
  timeoutMs: number;
}

export interface GitHubRepositoryInfo {
  private: boolean;
  defaultBranch?: string;
}

export interface GitHubTreeEntry {
  path: string;
  mode?: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}

export interface GitHubTreeResult {
  entries: GitHubTreeEntry[];
  truncated: boolean;
}

export interface GitHubBlobResult {
  sha: string;
  size: number;
  bytes: Buffer;
}

export class GitHubClientError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string = code
  ) {
    super(message);
    this.name = "GitHubClientError";
  }
}

export class GitHubClient {
  private readonly apiUrl: string;
  private readonly fetchTimeoutMs: number;

  constructor(private readonly options: GitHubClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.fetchTimeoutMs = options.timeoutMs;
  }

  async repository(owner: string, repo: string): Promise<GitHubRepositoryInfo> {
    const result = await this.requestJson<{ private?: boolean; default_branch?: string }>(
      `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}`
    );
    return {
      private: result.private === true,
      defaultBranch: result.default_branch
    };
  }

  async resolveRef(owner: string, repo: string, ref: string): Promise<string> {
    const result = await this.requestJson<{ sha?: string }>(
      `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/commits/${encodeSegment(ref)}`
    );
    if (!result.sha) {
      throw new GitHubClientError("github_invalid_ref", 400);
    }
    return result.sha;
  }

  async tree(owner: string, repo: string, ref: string): Promise<GitHubTreeResult> {
    const result = await this.requestJson<{
      tree?: Array<{ path?: string; mode?: string; type?: string; sha?: string; size?: number }>;
      truncated?: boolean;
    }>(
      `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/git/trees/${encodeSegment(ref)}?recursive=1`
    );
    const entries = (result.tree ?? []).flatMap((entry): GitHubTreeEntry[] => {
      if ((entry.type !== "blob" && entry.type !== "tree") || !entry.path || !entry.sha) return [];
      return [{
        path: entry.path,
        mode: entry.mode,
        type: entry.type,
        sha: entry.sha,
        size: entry.size
      }];
    });
    return { entries, truncated: result.truncated === true };
  }

  async contents(owner: string, repo: string, path: string, ref: string): Promise<GitHubTreeEntry[]> {
    const result = await this.requestJson<
      | { path?: string; type?: string; sha?: string; size?: number }
      | Array<{ path?: string; type?: string; sha?: string; size?: number }>
    >(
      `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`
    );

    if (Array.isArray(result)) {
      const entries: GitHubTreeEntry[] = [];
      for (const entry of result) {
        if (!entry.path || !entry.sha) continue;
        if (entry.type === "file") {
          entries.push({ path: entry.path, type: "blob", sha: entry.sha, size: entry.size });
        } else if (entry.type === "dir") {
          entries.push(...await this.contents(owner, repo, entry.path, ref));
        }
      }
      return entries;
    }

    if (result.path && result.sha && result.type === "file") {
      return [{ path: result.path, type: "blob", sha: result.sha, size: result.size }];
    }
    return [];
  }

  async contentFile(
    owner: string,
    repo: string,
    path: string,
    ref: string,
    maxBytes?: number
  ): Promise<GitHubBlobResult | undefined> {
    let result: {
      path?: string;
      type?: string;
      sha?: string;
      size?: number;
      encoding?: string;
      content?: string;
    } | Array<unknown>;
    try {
      result = await this.requestJson<{
        path?: string;
        type?: string;
        sha?: string;
        size?: number;
        encoding?: string;
        content?: string;
      } | Array<unknown>>(
        `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`
      );
    } catch (error) {
      // Let the tree lookup produce the normal "no Markdown files" result
      // when an exact path was removed, while preserving rate-limit errors.
      if (error instanceof GitHubClientError && error.code === "github_access_denied") return undefined;
      throw error;
    }
    if (Array.isArray(result)) return undefined;
    if (result.type !== "file" || !result.sha) return undefined;

    const declaredSize = Number(result.size ?? 0);
    if (maxBytes != null && declaredSize > maxBytes) {
      throw new GitHubClientError("github_content_too_large", 413);
    }
    if (result.content && result.encoding === "base64") {
      const bytes = Buffer.from(result.content.replaceAll("\n", ""), "base64");
      if (maxBytes != null && bytes.length > maxBytes) {
        throw new GitHubClientError("github_content_too_large", 413);
      }
      return {
        sha: result.sha,
        size: declaredSize || bytes.length,
        bytes
      };
    }

    // Contents API omits inline content for larger files. Reuse the returned
    // SHA instead of making another metadata request before reading the blob.
    return this.blob(owner, repo, result.sha, maxBytes);
  }

  async blob(owner: string, repo: string, sha: string, maxBytes?: number): Promise<GitHubBlobResult> {
    const result = await this.requestJson<{ sha?: string; size?: number; encoding?: string; content?: string }>(
      `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/git/blobs/${encodeSegment(sha)}`
    );
    const declaredSize = Number(result.size ?? 0);
    if (maxBytes != null && declaredSize > maxBytes) {
      throw new GitHubClientError("github_content_too_large", 413);
    }
    if (!result.content || result.encoding !== "base64") {
      throw new GitHubClientError("github_blob_invalid", 502);
    }
    const bytes = Buffer.from(result.content.replaceAll("\n", ""), "base64");
    if (maxBytes != null && bytes.length > maxBytes) {
      throw new GitHubClientError("github_content_too_large", 413);
    }
    return {
      sha: result.sha ?? sha,
      size: declaredSize || bytes.length,
      bytes
    };
  }

  private async requestJson<T>(path: string): Promise<T> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.fetchTimeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28"
      };
      if (this.options.token) {
        headers.authorization = `Bearer ${this.options.token}`;
      }
      const response = await globalThis.fetch(`${this.apiUrl}${path}`, {
        headers,
        signal: abortController.signal
      });
      if (!response.ok) {
        throw githubErrorForResponse(response);
      }
      return await response.json() as T;
    } catch (error) {
      if (error instanceof GitHubClientError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new GitHubClientError("github_timeout", 504);
      }
      throw new GitHubClientError("github_unavailable", 502);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function githubErrorForResponse(response: Response): GitHubClientError {
  const remaining = response.headers.get("x-ratelimit-remaining");
  if (response.status === 429 || remaining === "0") {
    return new GitHubClientError("github_rate_limited", 429);
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return new GitHubClientError("github_access_denied", 403);
  }
  if (response.status >= 500) {
    return new GitHubClientError("github_unavailable", 502);
  }
  return new GitHubClientError("github_api_error", 502);
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

function encodePath(value: string): string {
  return value.split("/").map(encodeSegment).join("/");
}
