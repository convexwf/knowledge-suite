import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ClipStatus,
  ClipSaveResponse,
  KnowledgeDocument,
  RawDoc,
  slugifyTitle,
  urlHash
} from "@uknowledge/knowledge-schema";

interface StoredIndex {
  clips: Record<string, ClipStatus>;
}

export class KnowledgeStore {
  constructor(private readonly root: string) {}

  async ensure(): Promise<void> {
    await Promise.all([
      mkdir(join(this.root, "rawdocs"), { recursive: true }),
      mkdir(join(this.root, "docs"), { recursive: true }),
      mkdir(join(this.root, "index"), { recursive: true })
    ]);
  }

  async status(normalizedUrl: string): Promise<ClipStatus> {
    const index = await this.readIndex();
    const hash = urlHash(normalizedUrl);
    return index.clips[hash] ?? {
      normalizedUrl,
      urlHash: hash,
      saved: false
    };
  }

  async save(params: {
    normalizedUrl: string;
    html: string;
    rawdoc: RawDoc;
    document: KnowledgeDocument;
    markdown: string;
  }): Promise<ClipSaveResponse["paths"]> {
    await this.ensure();

    const slug = `${slugifyTitle(params.document.meta.title)}-${params.document.doc_id.slice(0, 8)}`;
    const rawHtmlPath = `rawdocs/${params.rawdoc.rawdoc_id}.html`;
    const rawdocPath = `rawdocs/${params.rawdoc.rawdoc_id}.meta.json`;
    const documentPath = `docs/${slug}.json`;
    const markdownPath = `docs/${slug}.md`;

    await Promise.all([
      this.writeText(rawHtmlPath, params.html),
      this.writeJson(rawdocPath, params.rawdoc),
      this.writeJson(documentPath, params.document),
      this.writeText(markdownPath, params.markdown)
    ]);

    const index = await this.readIndex();
    const hash = urlHash(params.normalizedUrl);
    index.clips[hash] = {
      normalizedUrl: params.normalizedUrl,
      urlHash: hash,
      saved: true,
      savedAt: new Date().toISOString(),
      title: params.document.meta.title,
      docId: params.document.doc_id,
      markdownPath,
      documentPath
    };
    await this.writeIndex(index);

    return { rawHtmlPath, rawdocPath, documentPath, markdownPath };
  }

  private async writeText(relativePath: string, content: string): Promise<void> {
    const path = join(this.root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }

  private async writeJson(relativePath: string, content: unknown): Promise<void> {
    await this.writeText(relativePath, JSON.stringify(content, null, 2) + "\n");
  }

  private async readIndex(): Promise<StoredIndex> {
    await this.ensure();
    try {
      return JSON.parse(await readFile(this.indexPath, "utf8")) as StoredIndex;
    } catch {
      return { clips: {} };
    }
  }

  private async writeIndex(index: StoredIndex): Promise<void> {
    await this.writeText("index/clips.json", JSON.stringify(index, null, 2) + "\n");
  }

  private get indexPath(): string {
    return join(this.root, "index", "clips.json");
  }
}
