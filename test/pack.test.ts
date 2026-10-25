import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(full));
    else if (entry.isFile()) found.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return found;
}

test("npm pack includes the lumen skill and every reference", async () => {
  const { stdout } = await exec("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root });
  const packed = JSON.parse(stdout) as { files?: { path: string }[] }[];
  const names = new Set((packed[0]?.files ?? []).map((file) => file.path));
  const skills = (await filesUnder(path.join(root, "skills"))).sort();
  assert.equal(skills.length > 0, true);
  for (const file of skills) assert.equal(names.has(file), true, file);
  assert.equal(names.has("skills/lumen/SKILL.md"), true);
  assert.equal(names.has("scripts/install.sh"), true);
  assert.equal([...names].some((file) => file.startsWith("skills/lumen/references/") && file.endsWith("/SKILL.md")), true);
});
