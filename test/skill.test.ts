import assert from "node:assert/strict";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../src/run.js";
import { SKILL_VERSION_FILE, versionRelation } from "../src/skill/place.js";
import { readVersion } from "../src/version.js";
import { capture, withDir } from "./helpers.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const version = readVersion();

function skillEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    LUMEN_NO_SKILL_AUTOINSTALL: "0",
    LUMEN_WORKFLOWS_DIR: path.join(home, "no-such-workflows"),
    ...extra,
  };
}

test("version relation treats missing and unparsable text as older", () => {
  assert.equal(versionRelation(undefined, "0.1.0"), "older");
  assert.equal(versionRelation("abc", "0.1.0"), "older");
  assert.equal(versionRelation("0.0.9", "0.1.0"), "older");
  assert.equal(versionRelation("0.1.0", "0.1.0"), "match");
  assert.equal(versionRelation("0.1", "0.1.0"), "match");
  assert.equal(versionRelation("9.0.0", "0.1.0"), "newer");
});

test("package scripts do not install the skill", async () => {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  assert.equal(pkg.scripts?.postinstall, undefined);
  assert.equal(pkg.scripts?.preinstall, undefined);
  assert.equal(pkg.scripts?.prepare, undefined);
});

test("without a workflows directory the skill lands in ~/.agents/skills/lumen", async () => {
  await withDir(async (home) => {
    const absent = path.join(home, "no-such-workflows");
    const agents = path.join(home, ".agents", "skills", "lumen");
    const env = skillEnv(home);
    const cap = capture(env, { cwd: home });
    assert.equal(await run(["skill", "install"], cap.io), 0, cap.err());
    assert.match(cap.out(), new RegExp(`^skill installed: ${escapeRegExp(agents)} \\(${escapeRegExp(version)}\\)$`, "m"));
    assert.equal(cap.out().includes("other lumen skill"), false);
    await assert.rejects(access(absent));
    await assert.rejects(access(path.join(home, ".agents", "skills", "lumen-2")));
    const installed = await readFile(path.join(agents, "SKILL.md"), "utf8");
    assert.equal(installed, await readFile(path.join(root, "skills", "lumen", "SKILL.md"), "utf8"));
    assert.equal(await readFile(path.join(agents, "references", "雪碧图", "SKILL.md"), "utf8"), await readFile(path.join(root, "skills", "lumen", "references", "雪碧图", "SKILL.md"), "utf8"));
    assert.equal((await readFile(path.join(agents, SKILL_VERSION_FILE), "utf8")).trim(), version);
    await writeFile(path.join(agents, "notes.txt"), "keep\n");
    await mkdir(path.join(agents, "references", "obsolete"), { recursive: true });
    await writeFile(path.join(agents, "references", "obsolete", "SKILL.md"), "old\n");
    const again = capture(env, { cwd: home });
    assert.equal(await run(["skill", "install"], again.io), 0, again.err());
    assert.equal(await readFile(path.join(agents, "notes.txt"), "utf8"), "keep\n");
    await assert.rejects(access(path.join(agents, "references", "obsolete", "SKILL.md")));
    const doctor = capture({ ...env, LUMEN_NO_SKILL_AUTOINSTALL: "1" }, { cwd: home });
    assert.equal(await run(["doctor", "--project", home], doctor.io), 0, doctor.err());
    assert.match(doctor.out(), new RegExp(`^skill: ${escapeRegExp(agents)} version=${escapeRegExp(version)} cli=${escapeRegExp(version)} match$`, "m"));
    assert.match(doctor.out(), /^skill duplicate: none$/m);
  });
});

test("a writable workflows directory is the only install target", async () => {
  await withDir(async (home) => {
    const workflows = path.join(home, "workflows");
    const grokbot = path.join(workflows, "lumen");
    const agents = path.join(home, ".agents", "skills", "lumen");
    await mkdir(path.join(workflows, "other-skill"), { recursive: true });
    await writeFile(path.join(workflows, "other-skill", "SKILL.md"), "keep-workflow\n");
    await writeFile(path.join(workflows, "keep.txt"), "keep\n");
    const env = skillEnv(home, { LUMEN_WORKFLOWS_DIR: workflows });
    const first = capture(env, { cwd: home });
    assert.equal(await run(["--version"], first.io), 0, first.err());
    assert.equal(first.out().trim(), version);
    assert.equal(first.err(), `skill installed: ${grokbot} (${version})\n`);
    await assert.rejects(access(agents));
    assert.equal(await readFile(path.join(workflows, "other-skill", "SKILL.md"), "utf8"), "keep-workflow\n");
    assert.equal(await readFile(path.join(workflows, "keep.txt"), "utf8"), "keep\n");
    const quiet = capture(env, { cwd: home });
    assert.equal(await run(["--version"], quiet.io), 0);
    assert.equal(quiet.err(), "");
    assert.equal(quiet.out().trim(), version);

    await mkdir(path.join(home, ".agents", "skills", "other-skill"), { recursive: true });
    await writeFile(path.join(home, ".agents", "skills", "other-skill", "SKILL.md"), "keep-agent\n");
    await mkdir(agents, { recursive: true });
    await writeFile(path.join(agents, "SKILL.md"), "old skill\n");
    await writeFile(path.join(agents, SKILL_VERSION_FILE), "0.0.1\n");
    await writeFile(path.join(grokbot, SKILL_VERSION_FILE), "0.0.1\n");
    const nudged = capture(env, { cwd: home });
    assert.equal(await run(["--version"], nudged.io), 0);
    assert.equal(nudged.out().trim(), version);
    assert.equal(nudged.err(), `skill updated: ${grokbot} (${version}); other copy: ${agents}\n`);
    assert.equal(await readFile(path.join(agents, "SKILL.md"), "utf8"), "old skill\n");
    const warned = capture(env, { cwd: home });
    assert.equal(await run(["skill", "install"], warned.io), 0, warned.err());
    assert.match(warned.out(), new RegExp(`^other lumen skill: ${escapeRegExp(agents)}$`, "m"));
    assert.match(warned.out(), /re-run with --clean to remove the other lumen skill/);
    assert.equal(await readFile(path.join(agents, "SKILL.md"), "utf8"), "old skill\n");
    const doctor = capture(env, { cwd: home });
    assert.equal(await run(["doctor", "--project", home], doctor.io), 0, doctor.err());
    assert.equal(doctor.err(), "");
    assert.match(doctor.out(), new RegExp(`^skill: ${escapeRegExp(grokbot)} version=${escapeRegExp(version)} cli=${escapeRegExp(version)} match$`, "m"));
    assert.match(doctor.out(), new RegExp(`^skill duplicate: ${escapeRegExp(agents)} version=0\\.0\\.1$`, "m"));
    assert.equal(await readFile(path.join(agents, "SKILL.md"), "utf8"), "old skill\n");

    const cleaned = capture(env, { cwd: home });
    assert.equal(await run(["skill", "install", "--clean"], cleaned.io), 0, cleaned.err());
    assert.match(cleaned.out(), new RegExp(`^removed ${escapeRegExp(agents)}$`, "m"));
    assert.match(cleaned.out(), new RegExp(`^skill installed: ${escapeRegExp(grokbot)} \\(${escapeRegExp(version)}\\)$`, "m"));
    assert.equal(cleaned.out().includes("other lumen skill"), false);
    await assert.rejects(access(agents));
    assert.equal(await readFile(path.join(home, ".agents", "skills", "other-skill", "SKILL.md"), "utf8"), "keep-agent\n");
    assert.equal(await readFile(path.join(workflows, "other-skill", "SKILL.md"), "utf8"), "keep-workflow\n");
  });
});

test("an unwritable workflows directory falls through to the agents directory", async () => {
  await withDir(async (home) => {
    const workflows = path.join(home, "workflows");
    await mkdir(workflows);
    await writeFile(path.join(workflows, "keep.txt"), "keep\n");
    await chmod(workflows, 0o555);
    try {
      const env = skillEnv(home, { LUMEN_WORKFLOWS_DIR: workflows });
      const cap = capture(env, { cwd: home });
      assert.equal(await run(["skill", "install", "--target", "grokbot"], cap.io), 1);
      assert.match(cap.err(), /grokbot workflows directory is not writable/);
      await assert.rejects(access(path.join(workflows, "lumen")));
      const agents = capture(env, { cwd: home });
      assert.equal(await run(["skill", "install"], agents.io), 0, agents.err());
      assert.match(agents.out(), new RegExp(escapeRegExp(path.join(home, ".agents", "skills", "lumen"))));
      await assert.rejects(access(path.join(workflows, "lumen")));
      assert.equal(await readFile(path.join(workflows, "keep.txt"), "utf8"), "keep\n");
    } finally {
      await chmod(workflows, 0o755);
    }
  });
});

test("auto-install updates an older skill once and stays quiet", async () => {
  await withDir(async (home) => {
    const agents = path.join(home, ".agents", "skills", "lumen");
    const env = skillEnv(home);
    await mkdir(agents, { recursive: true });
    await writeFile(path.join(agents, "SKILL.md"), "stale\n");
    await writeFile(path.join(agents, SKILL_VERSION_FILE), "0.0.1\n");
    const updated = capture(env, { cwd: home });
    assert.equal(await run(["--version"], updated.io), 0);
    assert.equal(updated.out().trim(), version);
    assert.equal(updated.err(), `skill updated: ${agents} (${version})\n`);
    assert.equal((await readFile(path.join(agents, SKILL_VERSION_FILE), "utf8")).trim(), version);
    assert.equal(await readFile(path.join(agents, "SKILL.md"), "utf8"), await readFile(path.join(root, "skills", "lumen", "SKILL.md"), "utf8"));
    const held = capture({ ...env, LUMEN_NO_SKILL_AUTOINSTALL: "1" }, { cwd: home });
    await writeFile(path.join(agents, SKILL_VERSION_FILE), "0.0.1\n");
    await writeFile(path.join(agents, "SKILL.md"), "leave\n");
    assert.equal(await run(["doctor", "--project", home], held.io), 0, held.err());
    assert.equal(held.err(), "");
    assert.equal(await readFile(path.join(agents, "SKILL.md"), "utf8"), "leave\n");
    assert.match(held.out(), new RegExp(`^skill: ${escapeRegExp(agents)} version=0\\.0\\.1 cli=${escapeRegExp(version)} older$`, "m"));
  });
});

test("LUMEN_SKILL_DIR wins over --target and auto-detect", async () => {
  await withDir(async (home) => {
    const workflows = path.join(home, "workflows");
    const custom = path.join(home, "custom", "lumen");
    await mkdir(workflows);
    const env = skillEnv(home, { LUMEN_WORKFLOWS_DIR: workflows, LUMEN_SKILL_DIR: custom });
    const cap = capture(env, { cwd: home });
    assert.equal(await run(["skill", "install", "--target", "agents"], cap.io), 0, cap.err());
    assert.match(cap.out(), /LUMEN_SKILL_DIR takes precedence over --target/);
    assert.match(cap.out(), new RegExp(`^skill installed: ${escapeRegExp(custom)} \\(${escapeRegExp(version)}\\)$`, "m"));
    await assert.rejects(access(path.join(workflows, "lumen")));
    await assert.rejects(access(path.join(home, ".agents")));
    await access(path.join(custom, "SKILL.md"));
  });
});

test("a current install is left in place until skill install overwrites it", async () => {
  await withDir(async (home) => {
    const agents = path.join(home, ".agents", "skills", "lumen");
    const env = skillEnv(home);
    assert.equal(await run(["skill", "install"], capture(env, { cwd: home }).io), 0);
    await writeFile(path.join(agents, "SKILL.md"), "canary\n");
    const quiet = capture(env, { cwd: home });
    assert.equal(await run(["--version"], quiet.io), 0);
    assert.equal(quiet.err(), "");
    assert.equal(await readFile(path.join(agents, "SKILL.md"), "utf8"), "canary\n");
    const replaced = capture(env, { cwd: home });
    assert.equal(await run(["skill", "install"], replaced.io), 0, replaced.err());
    assert.equal(await readFile(path.join(agents, "SKILL.md"), "utf8"), await readFile(path.join(root, "skills", "lumen", "SKILL.md"), "utf8"));
  });
});

test("skill usage and a missing grokbot directory fail cleanly", async () => {
  await withDir(async (home) => {
    const missing = path.join(home, "missing-workflows");
    const env = skillEnv(home, { LUMEN_WORKFLOWS_DIR: missing, HOME: "" });
    const help = capture(skillEnv(home), { cwd: home });
    assert.equal(await run(["--help"], help.io), 0);
    assert.match(help.out(), /lumen skill install \[--target grokbot\|agents\|<path>\] \[--clean\]/);
    const unknown = capture(skillEnv(home), { cwd: home });
    assert.equal(await run(["skill", "nope"], unknown.io), 2);
    const grokbot = capture(env, { cwd: home });
    assert.equal(await run(["skill", "install", "--target", "grokbot"], grokbot.io), 1);
    assert.match(grokbot.err(), new RegExp(escapeRegExp(missing)));
    await assert.rejects(access(missing));
    const none = capture({ PATH: process.env.PATH ?? "", LUMEN_NO_SKILL_AUTOINSTALL: "1", LUMEN_WORKFLOWS_DIR: missing }, { cwd: home });
    assert.equal(await run(["doctor", "--project", home], none.io), 0, none.err());
    assert.match(none.out(), /^skill: unavailable$/m);
    assert.match(none.out(), /^skill duplicate: none$/m);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
