import { allThingsDistributedAdapter } from "./allthings-distributed.js";
import { arxivHtmlAdapter } from "./arxiv.js";
import { blogGoogleAdapter } from "./blog-google.js";
import { brendanGreggBlogAdapter } from "./brendan-gregg-blog.js";
import { engineeringFbAdapter } from "./engineering-fb.js";
import { fernDocsAdapter } from "./fern-docs.js";
import { freediumAdapter } from "./freedium.js";
import { juejinAdapter } from "./juejin.js";
import { mediumAdapter } from "./medium.js";
import { meituanTechAdapter } from "./meituan-tech.js";
import { smashingMagazineAdapter } from "./smashing-magazine.js";
import type { SiteAdapter } from "../types.js";

export const configAdapters: SiteAdapter[] = [
  allThingsDistributedAdapter,
  arxivHtmlAdapter,
  blogGoogleAdapter,
  brendanGreggBlogAdapter,
  engineeringFbAdapter,
  fernDocsAdapter,
  freediumAdapter,
  juejinAdapter,
  mediumAdapter,
  meituanTechAdapter,
  smashingMagazineAdapter
];
