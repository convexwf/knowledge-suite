import { parseCli } from "./cli.js";
import { runImport } from "./runner.js";

try {
  const { options } = parseCli(process.argv.slice(2));
  await runImport(options);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
