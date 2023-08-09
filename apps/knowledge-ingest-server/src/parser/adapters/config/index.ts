import { arxivHtmlAdapter } from "./arxiv.js";
import { freediumAdapter } from "./freedium.js";
import { mediumAdapter } from "./medium.js";
import type { SiteAdapter } from "../types.js";

export const configAdapters: SiteAdapter[] = [
  arxivHtmlAdapter,
  freediumAdapter,
  mediumAdapter
];
