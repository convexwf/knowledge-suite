import { DocumentSection, KnowledgeDocument } from "@uknowledge/knowledge-schema";

export function documentToMarkdown(document: KnowledgeDocument): string {
  const lines: string[] = [
    "---",
    `title: ${yamlString(document.meta.title)}`,
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
  switch (section.type) {
    case "heading":
      return [`${"#".repeat(section.level ?? 2)} ${section.content ?? ""}`, ""];
    case "paragraph":
      return [section.content ?? "", ""];
    case "list":
      return [...(section.items ?? []).map((item) => `- ${typeof item === "string" ? item : item.text}`), ""];
    case "code":
      return ["```", section.content ?? "", "```", ""];
    case "figure":
      return [section.content ?? "", ""];
    case "table":
      return [section.content ?? "", ""];
    default:
      return [];
  }
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
