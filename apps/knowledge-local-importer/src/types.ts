export type SourceType = "calibre" | "html" | "urls";
export type CandidateType = "calibre_book" | "html_file" | "url";
export type ReportState = "candidate" | "imported" | "skipped" | "failed";

export interface ImportOptions {
  sourceType: SourceType;
  root?: string;
  file?: string;
  storeRoot: string;
  reportDir: string;
  dryRun: boolean;
  skipExisting: boolean;
  concurrency: number;
  tags: string[];
}

export interface CalibreBookCandidate {
  type: "calibre_book";
  directoryPath: string;
  epubPaths: string[];
  opfPath: string;
  coverPath?: string;
  tocPath?: string;
}

export interface HtmlFileCandidate {
  type: "html_file";
  filePath: string;
}

export interface UrlCandidate {
  type: "url";
  url: string;
}

export type ImportCandidate = CalibreBookCandidate | HtmlFileCandidate | UrlCandidate;

export interface ScanSkippedItem {
  type: CandidateType;
  inputPath?: string;
  url?: string;
  state: "skipped";
  errorCode: string;
  errorMessage: string;
}

export interface SourceScan {
  scanned: number;
  candidates: ImportCandidate[];
  skipped: ScanSkippedItem[];
}

export interface ReportItem {
  type: CandidateType;
  inputPath?: string;
  url?: string;
  state: ReportState;
  itemId?: string;
  identityHash?: string;
  rawdocId?: string;
  docId?: string;
  errorCode?: string;
  errorMessage?: string;
  paths?: object;
}

export interface ImportReport {
  source: {
    type: SourceType;
    root?: string;
    file?: string;
  };
  options: {
    dryRun: boolean;
    skipExisting: boolean;
    concurrency: number;
    tags: string[];
  };
  startedAt: string;
  finishedAt?: string;
  summary: {
    scanned: number;
    candidates: number;
    imported: number;
    skipped: number;
    failed: number;
  };
  items: ReportItem[];
}
