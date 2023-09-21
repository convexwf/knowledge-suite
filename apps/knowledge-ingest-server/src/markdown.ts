import { DocumentSection, KnowledgeDocument } from "@uknowledge/knowledge-schema";

export function documentToMarkdown(document: KnowledgeDocument): string {
  const lines: string[] = [
    "---",
    `title: ${yamlString(document.meta.title)}`,
    document.meta.page_title ? `page_title: ${yamlString(document.meta.page_title)}` : undefined,
    document.meta.source.url ? `url: ${yamlString(document.meta.source.url)}` : undefined,
    `ingested_at: ${yamlString(document.meta.ingested_at)}`,
    document.meta.language ? `language: ${yamlString(document.meta.language)}` : undefined,
    "---",
    "",
    `# ${document.meta.title}`,
    ""
  ].filter((line): line is string => line !== undefined);

  for (const section of document.sections) {
    lines.push(...sectionToMarkdown(section));
  }

  return lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trimEnd() + "\n";
}

function sectionToMarkdown(section: DocumentSection): string[] {
  const anchor = section.section_id ? [`<!-- section_id:${section.section_id} -->`] : [];
  switch (section.type) {
    case "heading":
      return [...anchor, `${"#".repeat(section.level ?? 2)} ${section.content ?? ""}`, ""];
    case "paragraph":
      return [...anchor, section.content ?? "", ""];
    case "blockquote":
      return [...anchor, ...blockquoteToMarkdown(section)];
    case "list":
      return [...anchor, ...(section.items ?? []).map((item) => `- ${typeof item === "string" ? item : item.text}`), ""];
    case "code":
      return [...anchor, "```", section.content ?? "", "```", ""];
    case "figure":
      return [...anchor, ...figureToMarkdown(section)];
    case "table":
      return [...anchor, ...tableToMarkdown(section)];
    default:
      return [];
  }
}

function blockquoteToMarkdown(section: DocumentSection): string[] {
  const content = section.content ?? "";
  if (!content) {
    return [];
  }
  return [...content.split(/\r?\n/).map((line) => `> ${line}`), ""];
}

function figureToMarkdown(section: DocumentSection): string[] {
  const lines: string[] = [];
  for (const asset of section.assets ?? []) {
    const src = asset.path || asset.source_url;
    if (src) {
      lines.push(`![${escapeMarkdownLinkText(asset.alt || asset.caption || "")}](${src})`);
    }
  }
  if (section.content) {
    lines.push(section.content);
  }
  return [...lines, ""];
}

function tableToMarkdown(section: DocumentSection): string[] {
  const rows = normalizeTableRows(section.rows);
  if (rows.length === 0) {
    return [section.content ?? "", ""].filter(Boolean);
  }

  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => padRow(row, width));
  const [header, ...body] = normalized;
  const separator = Array.from({ length: width }, () => "---");
  return [
    markdownTableRow(header),
    markdownTableRow(separator),
    ...body.map(markdownTableRow),
    ""
  ];
}

function normalizeTableRows(rows: unknown[] | undefined): string[][] {
  if (!rows) {
    return [];
  }
  return rows
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => row.map((cell) => String(cell ?? "")));
}

function padRow(row: string[], width: number): string[] {
  return [...row, ...Array.from({ length: width - row.length }, () => "")];
}

function markdownTableRow(row: string[]): string {
  return `| ${row.map(escapeMarkdownTableCell).join(" | ")} |`;
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/[[\]]/g, "\\$&");
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
