#!/usr/bin/env node
// npm postinstall. Detection and copying live in dist/skill/place.js. Always exits 0.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(root, "dist", "skill", "place.js");

function explain(err) {
  if (typeof err === "object" && err !== null && "code" in err && err.code === "ERR_MODULE_NOT_FOUND") {
    return "built skill installer is missing";
  }
  const message = err instanceof Error ? err.message : String(err);
  const line = message.split("\n")[0] ?? "";
  return line.length > 0 ? line : "unknown error";
}

try {
  const loaded = await import(pathToFileURL(installer).href);
  if (typeof loaded.runSkillPostinstall !== "function") {
    throw new Error("built skill installer is missing");
  }
  await loaded.runSkillPostinstall();
} catch (err) {
  process.stderr.write(`skill postinstall failed: ${explain(err)}\n`);
}
