import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { skillHelp } from "../src/commands/skill.js";
import { helpText } from "../src/help.js";
import { run } from "../src/run.js";
import { postinstallSkill, SKILL_VERSION_FILE, versionRelation } from "../src/skill/place.js";
import { readVersion } from "../src/version.js";
import { capture, withDir } from "./helpers.js";

const exec = promisify(execFile);

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

test("postinstall is wired and documented next to runtime autoinstall", async () => {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  assert.equal(pkg.scripts?.postinstall, "node scripts/postinstall-skill.mjs");
  assert.equal(pkg.scripts?.preinstall, undefined);
  assert.equal(pkg.scripts?.prepare, undefined);
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  assert.equal(readme.includes("没有 postinstall"), false);
  assert.equal(/there is no postinstall/i.test(readme), false);
  assert.match(readme, /npm install` 和 `npm install -g` 的 postinstall/);
  assert.match(readme, /Every lumen run updates the detected directory/);
  assert.match(readme, /LUMEN_NO_SKILL_AUTOINSTALL=1/);
  const skill = await readFile(path.join(root, "skills", "lumen", "SKILL.md"), "utf8");
  assert.match(skill, /postinstall 也按这个规则/);
  assert.match(skill, /LUMEN_NO_SKILL_AUTOINSTALL=1/);
  assert.match(helpText(version), /npm postinstall installs that directory/);
  assert.match(helpText(version), /LUMEN_NO_SKILL_AUTOINSTALL=1 skips the postinstall and that check/);
  assert.match(skillHelp(), /npm postinstall uses the same detection/);
  assert.match(skillHelp(), /LUMEN_NO_SKILL_AUTOINSTALL=1/);
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

test("postinstall installs into workflows when that directory is writable", async () => {
  await withDir(async (home) => {
    const workflows = path.join(home, "workflows");
    const grokbot = path.join(workflows, "lumen");
    const agents = path.join(home, ".agents", "skills", "lumen");
    await mkdir(path.join(workflows, "other-skill"), { recursive: true });
    await writeFile(path.join(workflows, "other-skill", "SKILL.md"), "keep-workflow\n");
    const env = skillEnv(home, { LUMEN_WORKFLOWS_DIR: workflows });
    const cap = capture(env, { cwd: home });
    await postinstallSkill(cap.io, root, version);
    assert.equal(cap.err(), `skill installed: ${grokbot} (${version})\n`);
    assert.equal(await readFile(path.join(grokbot, "SKILL.md"), "utf8"), await readFile(path.join(root, "skills", "lumen", "SKILL.md"), "utf8"));
    assert.equal((await readFile(path.join(grokbot, SKILL_VERSION_FILE), "utf8")).trim(), version);
    assert.equal(await readFile(path.join(grokbot, "references", "雪碧图", "SKILL.md"), "utf8"), await readFile(path.join(root, "skills", "lumen", "references", "雪碧图", "SKILL.md"), "utf8"));
    assert.equal(await readFile(path.join(workflows, "other-skill", "SKILL.md"), "utf8"), "keep-workflow\n");
    await assert.rejects(access(agents));

    await writeFile(path.join(grokbot, "SKILL.md"), "canary\n");
    await writeFile(path.join(grokbot, SKILL_VERSION_FILE), "9.0.0\n");
    await writeFile(path.join(grokbot, "notes.txt"), "keep\n");
    const again = capture(env, { cwd: home });
    await postinstallSkill(again.io, root, version);
    assert.equal(again.err(), `skill updated: ${grokbot} (${version})\n`);
    assert.equal(await readFile(path.join(grokbot, "SKILL.md"), "utf8"), await readFile(path.join(root, "skills", "lumen", "SKILL.md"), "utf8"));
    assert.equal((await readFile(path.join(grokbot, SKILL_VERSION_FILE), "utf8")).trim(), version);
    assert.equal(await readFile(path.join(grokbot, "notes.txt"), "utf8"), "keep\n");
    await assert.rejects(access(agents));
  });
});

test("postinstall uses ~/.agents/skills/lumen when workflows is missing or unwritable", async () => {
  await withDir(async (home) => {
    const agents = path.join(home, ".agents", "skills", "lumen");
    const missing = path.join(home, "no-such-workflows");
    const env = skillEnv(home);
    const cap = capture(env, { cwd: home });
    await postinstallSkill(cap.io, root, version);
    assert.equal(cap.err(), `skill installed: ${agents} (${version})\n`);
    assert.equal((await readFile(path.join(agents, SKILL_VERSION_FILE), "utf8")).trim(), version);
    await assert.rejects(access(missing));
    await assert.rejects(access(path.join(home, "workflows")));
  });

  await withDir(async (home) => {
    const workflows = path.join(home, "workflows");
    const agents = path.join(home, ".agents", "skills", "lumen");
    await mkdir(workflows);
    await writeFile(path.join(workflows, "keep.txt"), "keep\n");
    await chmod(workflows, 0o555);
    try {
      const env = skillEnv(home, { LUMEN_WORKFLOWS_DIR: workflows });
      const cap = capture(env, { cwd: home });
      await postinstallSkill(cap.io, root, version);
      assert.equal(cap.err(), `skill installed: ${agents} (${version})\n`);
      await assert.rejects(access(path.join(workflows, "lumen")));
      assert.equal(await readFile(path.join(workflows, "keep.txt"), "utf8"), "keep\n");
      assert.equal((await readFile(path.join(agents, SKILL_VERSION_FILE), "utf8")).trim(), version);
    } finally {
      await chmod(workflows, 0o755);
    }
  });
});

test("postinstall honors LUMEN_SKILL_DIR and LUMEN_NO_SKILL_AUTOINSTALL", async () => {
  await withDir(async (home) => {
    const workflows = path.join(home, "workflows");
    const custom = path.join(home, "custom", "lumen");
    await mkdir(workflows);
    const env = skillEnv(home, { LUMEN_WORKFLOWS_DIR: workflows, LUMEN_SKILL_DIR: custom });
    const cap = capture(env, { cwd: home });
    await postinstallSkill(cap.io, root, version);
    assert.equal(cap.err(), `skill installed: ${custom} (${version})\n`);
    await access(path.join(custom, "SKILL.md"));
    assert.equal((await readFile(path.join(custom, SKILL_VERSION_FILE), "utf8")).trim(), version);
    await assert.rejects(access(path.join(workflows, "lumen")));
    await assert.rejects(access(path.join(home, ".agents")));

    const skipped = capture({ ...env, LUMEN_NO_SKILL_AUTOINSTALL: "1" }, { cwd: home });
    await writeFile(path.join(custom, "SKILL.md"), "leave\n");
    await postinstallSkill(skipped.io, root, version);
    assert.equal(skipped.err(), "");
    assert.equal(await readFile(path.join(custom, "SKILL.md"), "utf8"), "leave\n");
  });
});

test("postinstall failure is one stderr line and does not throw", async () => {
  await withDir(async (home) => {
    const env = skillEnv(home);
    const missing = capture(env, { cwd: home });
    await postinstallSkill(missing.io, path.join(home, "missing-package"), version);
    assert.match(missing.err(), /^skill postinstall failed: lumen skill is missing from the package: /);
    assert.equal(missing.err().trim().split("\n").length, 1);
    await assert.rejects(access(path.join(home, ".agents")));
    await assert.rejects(access(path.join(home, "workflows")));

    const blocker = path.join(home, "not-a-directory");
    await writeFile(blocker, "x\n");
    const denied = capture(skillEnv(home, { LUMEN_SKILL_DIR: blocker }), { cwd: home });
    await postinstallSkill(denied.io, root, version);
    assert.match(denied.err(), /^skill postinstall failed: skill directory is not a directory: /);
    assert.equal(denied.err().trim().split("\n").length, 1);
    await assert.rejects(access(path.join(home, ".agents")));
  });
});

test("the postinstall script installs one directory and exits 0 on failure", async () => {
  await withDir(async (home) => {
    const workflows = path.join(home, "workflows");
    const grokbot = path.join(workflows, "lumen");
    const agents = path.join(home, ".agents", "skills", "lumen");
    await mkdir(workflows);
    const installed = await runPostinstall(skillEnv(home, { LUMEN_WORKFLOWS_DIR: workflows }));
    assert.equal(installed.code, 0);
    assert.equal(installed.stderr, `skill installed: ${grokbot} (${version})\n`);
    assert.equal((await readFile(path.join(grokbot, SKILL_VERSION_FILE), "utf8")).trim(), version);
    await assert.rejects(access(agents));

    const fallback = await runPostinstall(skillEnv(home));
    assert.equal(fallback.code, 0);
    assert.equal(fallback.stderr, `skill installed: ${agents} (${version})\n`);
    assert.equal((await readFile(path.join(agents, SKILL_VERSION_FILE), "utf8")).trim(), version);
    await assert.rejects(access(path.join(home, "no-such-workflows", "lumen")));

    const skipped = await runPostinstall(skillEnv(home, { LUMEN_NO_SKILL_AUTOINSTALL: "1", LUMEN_WORKFLOWS_DIR: workflows }));
    assert.equal(skipped.code, 0);
    assert.equal(skipped.stderr, "");
    await writeFile(path.join(grokbot, "SKILL.md"), "leave\n");
    const still = await runPostinstall(skillEnv(home, { LUMEN_NO_SKILL_AUTOINSTALL: "true", LUMEN_WORKFLOWS_DIR: workflows }));
    assert.equal(still.code, 0);
    assert.equal(still.stderr, "");
    assert.equal(await readFile(path.join(grokbot, "SKILL.md"), "utf8"), "leave\n");

    const blocker = path.join(home, "not-a-directory");
    await writeFile(blocker, "x\n");
    const failed = await runPostinstall(skillEnv(home, { LUMEN_SKILL_DIR: blocker, LUMEN_WORKFLOWS_DIR: workflows }));
    assert.equal(failed.code, 0);
    assert.match(failed.stderr, /^skill postinstall failed: skill directory is not a directory: /);
    assert.equal(failed.stderr.trim().split("\n").length, 1);
    assert.equal(await readFile(path.join(grokbot, "SKILL.md"), "utf8"), "leave\n");
  });
});

test("npm pack postinstall installs one skill directory", { timeout: 180_000 }, async () => {
  await withDir(async (home) => {
    const workflows = path.join(home, "workflows");
    const grokbot = path.join(workflows, "lumen");
    const agents = path.join(home, ".agents", "skills", "lumen");
    const prefix = path.join(home, "prefix");
    await mkdir(workflows);
    const packed = await exec("npm", ["pack", "--pack-destination", home, "--json", "--ignore-scripts"], {
      cwd: root,
      env: npmEnv(home),
      timeout: 60_000,
    });
    const listed = JSON.parse(packed.stdout) as { filename?: string }[];
    const filename = listed[0]?.filename;
    assert.equal(typeof filename, "string");
    const tarball = path.isAbsolute(filename ?? "") ? filename ?? "" : path.join(home, filename ?? "");
    const installed = await exec(
      "npm",
      ["install", "-g", "--prefix", prefix, "--foreground-scripts", "--omit=dev", "--no-audit", "--no-fund", tarball],
      { cwd: home, env: npmEnv(home, { LUMEN_WORKFLOWS_DIR: workflows }), timeout: 180_000 },
    );
    assert.match(`${installed.stdout}\n${installed.stderr}`, new RegExp(`skill installed: ${escapeRegExp(grokbot)} \\(${escapeRegExp(version)}\\)`));
    assert.equal(await readFile(path.join(grokbot, "SKILL.md"), "utf8"), await readFile(path.join(root, "skills", "lumen", "SKILL.md"), "utf8"));
    assert.equal((await readFile(path.join(grokbot, SKILL_VERSION_FILE), "utf8")).trim(), version);
    await assert.rejects(access(agents));
    await access(path.join(prefix, "lib", "node_modules", "@nurvision", "lumen", "scripts", "postinstall-skill.mjs"));

    const blocker = path.join(home, "not-a-directory");
    await writeFile(blocker, "x\n");
    const failed = await runPackedPostinstall(prefix, npmEnv(home, { LUMEN_SKILL_DIR: blocker, LUMEN_WORKFLOWS_DIR: workflows }));
    assert.equal(failed.code, 0);
    assert.match(failed.stderr, /^skill postinstall failed: /);
    assert.equal(failed.stderr.trim().split("\n").length, 1);
    assert.equal(await readFile(path.join(grokbot, "SKILL.md"), "utf8"), await readFile(path.join(root, "skills", "lumen", "SKILL.md"), "utf8"));
    await assert.rejects(access(agents));
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runPostinstall(env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return runNode([path.join(root, "scripts", "postinstall-skill.mjs")], env, root);
}

async function runPackedPostinstall(
  prefix: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const script = path.join(prefix, "lib", "node_modules", "@nurvision", "lumen", "scripts", "postinstall-skill.mjs");
  return runNode([script], env, path.dirname(path.dirname(script)));
}

function runNode(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { cwd, env, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        const failed = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
        if (typeof failed.code === "number") {
          resolve({ code: failed.code, stdout: failed.stdout ?? stdout, stderr: failed.stderr ?? stderr });
          return;
        }
        reject(err);
        return;
      }
      resolve({ code: 0, stdout, stderr });
    });
  });
}

function npmEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    npm_config_cache: process.env.npm_config_cache ?? path.join(homedir(), ".npm"),
    npm_config_update_notifier: "false",
    LUMEN_NO_SKILL_AUTOINSTALL: "0",
    ...extra,
  };
  for (const key of [
    "npm_config_prefix",
    "NPM_CONFIG_PREFIX",
    "npm_config_global",
    "NPM_CONFIG_GLOBAL",
    "npm_config_ignore_scripts",
    "NPM_CONFIG_IGNORE_SCRIPTS",
  ]) {
    if (extra[key] === undefined) delete env[key];
  }
  if (extra.LUMEN_SKILL_DIR === undefined) delete env.LUMEN_SKILL_DIR;
  if (extra.LUMEN_WORKFLOWS_DIR === undefined) delete env.LUMEN_WORKFLOWS_DIR;
  if (extra.XDG_DATA_HOME === undefined) delete env.XDG_DATA_HOME;
  if (extra.XDG_CONFIG_HOME === undefined) delete env.XDG_CONFIG_HOME;
  if (extra.XDG_CACHE_HOME === undefined) delete env.XDG_CACHE_HOME;
  return env;
}
