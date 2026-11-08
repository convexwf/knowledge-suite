import type { PageSnapshot } from "@uknowledge/knowledge-schema";
import { WebSocket } from "ws";

export interface CaptureAgentResult {
  blocked: boolean;
  blockReasons?: string[];
  textSample?: string;
  snapshot?: PageSnapshot;
  links?: {
    pageUrl: string;
    title?: string;
    candidates: Array<{ url: string; text?: string }>;
  };
}

interface PendingCapture {
  resolve: (result: CaptureAgentResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class CaptureAgentHub {
  private socket: WebSocket | null = null;
  private pending = new Map<string, PendingCapture>();
  private sequence = 0;

  get connected(): boolean {
    return Boolean(this.socket && this.socket.readyState === WebSocket.OPEN);
  }

  attach(socket: WebSocket): void {
    this.socket = socket;
    socket.on("message", (raw) => this.handleMessage(raw.toString()));
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
    });
    socket.on("error", () => {
      // The close handler performs cleanup; ignore transport errors here.
    });
  }

  async capture(url: string, options: { waitMs?: number; timeoutMs?: number } = {}): Promise<CaptureAgentResult> {
    return this.dispatch(url, options, "document");
  }

  async discover(url: string, options: { waitMs?: number; timeoutMs?: number } = {}): Promise<CaptureAgentResult> {
    return this.dispatch(url, options, "links");
  }

  private async dispatch(
    url: string,
    options: { waitMs?: number; timeoutMs?: number },
    mode: "document" | "links"
  ): Promise<CaptureAgentResult> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("capture agent is not connected; load the Knowledge Capture Relay extension and keep Chrome running");
    }

    const taskId = `task-${Date.now().toString(36)}-${(this.sequence += 1)}`;
    const timeoutMs = options.timeoutMs ?? 60000;
    const payload = JSON.stringify({
      type: "capture",
      taskId,
      url,
      mode,
      waitMs: options.waitMs ?? 8000
    });

    return new Promise<CaptureAgentResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(taskId);
        reject(new Error("capture agent timed out"));
      }, timeoutMs);
      this.pending.set(taskId, { resolve, reject, timer });
      try {
        socket.send(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(taskId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleMessage(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (record.type !== "result" || typeof record.taskId !== "string") return;
    const pending = this.pending.get(record.taskId);
    if (!pending) return;
    this.pending.delete(record.taskId);
    clearTimeout(pending.timer);

    if (record.ok === true) {
      pending.resolve({
        blocked: record.blocked === true,
        blockReasons: Array.isArray(record.blockReasons)
          ? record.blockReasons.filter((reason): reason is string => typeof reason === "string")
          : undefined,
        textSample: typeof record.textSample === "string" ? record.textSample : undefined,
        snapshot: record.snapshot as PageSnapshot | undefined,
        links: record.links as CaptureAgentResult["links"]
      });
      return;
    }

    const errorText = typeof record.error === "string" ? record.error : "capture failed";
    pending.reject(new Error(errorText));
  }
}
