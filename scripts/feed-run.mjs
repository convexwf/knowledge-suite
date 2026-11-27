#!/usr/bin/env node
// Trigger the feed prepare stage and wait for it to finish.
// Knowledge Suite has no scheduler of its own: run this from cron, launchd or
// any other external scheduler, or let the composing agent trigger the run.
//
//   node scripts/feed-run.mjs [--no-wait] [--by <name>]
//
// Environment: KNOWLEDGE_BASE_URL (default http://127.0.0.1:18765),
//              KNOWLEDGE_TOKEN (default dev-token).
// Exit code:   0 completed, 2 partial, 1 failed or unreachable.

const baseUrl = (process.env.KNOWLEDGE_BASE_URL ?? "http://127.0.0.1:18765").replace(/\/+$/, "");
const token = process.env.KNOWLEDGE_TOKEN ?? "dev-token";
const args = process.argv.slice(2);
const wait = !args.includes("--no-wait");
const byIndex = args.indexOf("--by");
const triggeredBy = byIndex >= 0 && args[byIndex + 1] ? args[byIndex + 1] : "feed-run-script";
const POLL_MS = 3000;
const MAX_WAIT_MS = 60 * 60 * 1000;

async function api(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { message: text };
  }
  return { status: response.status, body: parsed };
}

async function main() {
  const started = await api("POST", "/api/feed/run", { triggeredBy });
  let runId = started.body.runId;
  if (started.status === 409 && started.body.error === "feed_run_in_progress") {
    console.log(`A feed run is already in progress (${runId}); following it.`);
  } else if (started.status === 404 && started.body.error === "feed_disabled") {
    console.error("Feed is disabled. Start the server with KNOWLEDGE_FEED_ENABLED=true.");
    return 1;
  } else if (started.status !== 202) {
    console.error(`Could not start a feed run: ${started.status} ${JSON.stringify(started.body)}`);
    return 1;
  } else {
    console.log(`Feed run started: ${runId}`);
  }
  if (!wait) return 0;

  const deadline = Date.now() + MAX_WAIT_MS;
  let lastStage = "";
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const status = await api("GET", "/api/feed/status");
    const run = status.body.run;
    if (status.status !== 200 || !run) {
      console.error(`Could not read feed status: ${status.status} ${JSON.stringify(status.body)}`);
      return 1;
    }
    if (status.body.running) {
      if (run.stats?.stage && run.stats.stage !== lastStage) {
        lastStage = run.stats.stage;
        console.log(`  stage: ${lastStage}`);
      }
      continue;
    }
    if (runId && run.runId !== runId) continue;
    const stats = run.stats ?? {};
    console.log(
      `Feed run ${run.state}: ${stats.discovered ?? 0} new, ${stats.selected ?? 0} selected, ` +
      `${stats.fetched ?? 0} fetched, ${stats.points ?? 0} points, ${stats.sourcesFailed ?? 0} sources failed`
    );
    if (run.error) console.log(`  ${run.error}`);
    console.log(`Briefings awaiting the composing agent: ${status.body.pendingBriefings}`);
    return run.state === "completed" ? 0 : run.state === "partial" ? 2 : 1;
  }
  console.error("Timed out waiting for the feed run to finish.");
  return 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`Feed run failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
);
