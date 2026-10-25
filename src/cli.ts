#!/usr/bin/env node
import { run } from "./run.js";

try {
  const code = await run(process.argv.slice(2));
  process.exit(code);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
