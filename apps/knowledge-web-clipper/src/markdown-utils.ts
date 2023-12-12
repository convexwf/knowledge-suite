export function stripSectionAnchors(markdown: string): string {
  return markdown.replace(/^[ \t]*<!--\s*section_id:\S+\s*-->\r?\n?/gm, "");
}
