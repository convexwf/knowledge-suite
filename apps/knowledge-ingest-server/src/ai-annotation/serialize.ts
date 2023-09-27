import type { DocumentSection } from "@uknowledge/knowledge-schema";

export function serializeSection(section: DocumentSection): string {
  switch (section.type) {
    case "heading":
      return `${"#".repeat(section.level ?? 1)} ${section.content ?? ""}`;

    case "paragraph":
      return section.content ?? "";

    case "blockquote":
      return `> ${section.content ?? ""}`;

    case "list": {
      const items = section.items ?? [];
      return items
        .map((item) => {
          if (typeof item === "string") return `- ${item}`;
          return `- ${item.text}`;
        })
        .join("\n");
    }

    case "code":
      return [
        "```",
        (section.content ?? "").slice(0, 300),
        (section.content ?? "").length > 300 ? "..." : "",
        "```",
      ].join("\n");

    case "table": {
      const rows = (section.rows ?? []) as unknown[][];
      if (!rows.length) return "";
      const colCount = Math.max(...rows.map((r) => r.length));
      const lines: string[] = [];
      const header = rows[0];
      const paddedHeader = [...header];
      while (paddedHeader.length < colCount) paddedHeader.push("");
      lines.push("| " + paddedHeader.join(" | ") + " |");
      lines.push("| " + Array(colCount).fill("---").join(" | ") + " |");
      const maxLines = 20;
      const dataRows = rows.slice(1, maxLines);
      for (const row of dataRows) {
        const padded = [...row];
        while (padded.length < colCount) padded.push("");
        lines.push("| " + padded.join(" | ") + " |");
      }
      if (rows.length > maxLines) {
        lines.push(`(表格共 ${rows.length} 行，仅展示前 ${maxLines - 1} 行)`);
      }
      return lines.join("\n");
    }

    case "figure": {
      const assets = section.assets ?? [];
      const caption = assets[0]?.caption;
      const alt = assets[0]?.alt;
      return [
        `[图片]`,
        caption ? `标题: ${caption}` : "",
        alt ? `说明: ${alt}` : "",
      ].filter(Boolean).join(" ");
    }

    default:
      return "";
  }
}
