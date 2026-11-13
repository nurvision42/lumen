import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { BREAKDOWN_DEFAULT_PROMPT } from "../src/catalog.js";
import { run } from "../src/run.js";
import { capture, withDir } from "./helpers.js";

function envFor(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    XDG_CONFIG_HOME: path.join(dir, "xdg"),
    HOME: path.join(dir, "home"),
    PATH: process.env.PATH ?? "",
    ...extra,
  };
}

function ioFor(dir: string, extra: NodeJS.ProcessEnv = {}) {
  return capture(envFor(dir, extra), { cwd: dir });
}

function globalFile(dir: string): string {
  return path.join(dir, "xdg", "lumen", "providers.json");
}

async function bind(dir: string): Promise<void> {
  const cap = ioFor(dir);
  assert.equal(
    await run(
      ["providers", "set", "video-understand-router", "--provider", "mediakit", "--base-url", "https://mediakit.example", "--api-key-env", "MEDIAKIT_UNDERSTAND_KEY", "--project", dir],
      cap.io,
    ),
    0,
    cap.err(),
  );
}

async function readJson(file: string): Promise<{
  models?: Record<string, { provider?: string }>;
  breakdown?: { prompt?: string; promptFile?: string; preferModels?: string[] };
}> {
  return JSON.parse(await readFile(file, "utf8")) as {
    models?: Record<string, { provider?: string }>;
    breakdown?: { prompt?: string; promptFile?: string; preferModels?: string[] };
  };
}

async function recordOf(dir: string, output: string): Promise<{ params: { prompt: string; promptSource: string }; calls: unknown }> {
  const id = /run: (\S+)/.exec(output)?.[1];
  assert.ok(id, output);
  return JSON.parse(await readFile(path.join(dir, ".lumen", "runs", id, "record.json"), "utf8")) as {
    params: { prompt: string; promptSource: string };
    calls: unknown;
  };
}

test("breakdown prompt set --text stores a global binding and show reports it", async () => {
  await withDir(async (dir) => {
    const set = ioFor(dir);
    assert.equal(await run(["breakdown", "prompt", "set", "--text", "只看转场"], set.io), 0, set.err());
    assert.match(set.out(), /set breakdown prompt \(global\)/);
    const stored = await readJson(globalFile(dir));
    assert.equal(stored.breakdown?.prompt, "只看转场");
    assert.equal(stored.breakdown?.promptFile, undefined);
    await assert.rejects(access(path.join(dir, "lumen.config.json")));

    const show = ioFor(dir);
    assert.equal(await run(["breakdown", "prompt", "show"], show.io), 0, show.err());
    assert.equal(show.out(), "source: global\n只看转场\n");

    const again = ioFor(dir);
    assert.equal(await run(["breakdown", "prompt", "set", "--text", "改成看声音"], again.io), 0, again.err());
    const replaced = await readJson(globalFile(dir));
    assert.equal(replaced.breakdown?.prompt, "改成看声音");

    const doctor = ioFor(dir);
    assert.equal(await run(["doctor", "--project", dir], doctor.io), 0, doctor.err());
    assert.match(doctor.out(), /breakdown prompt: set/);
    assert.equal(doctor.out().includes("改成看声音"), false);

    const cleared = ioFor(dir);
    assert.equal(await run(["breakdown", "prompt", "clear"], cleared.io), 0, cleared.err());
    assert.match(cleared.out(), /cleared breakdown prompt \(global\)/);
    const after = await readJson(globalFile(dir));
    assert.equal(after.breakdown?.prompt, undefined);
    const shown = ioFor(dir);
    assert.equal(await run(["breakdown", "prompt", "show"], shown.io), 0, shown.err());
    assert.equal(shown.out(), `source: built-in\n${BREAKDOWN_DEFAULT_PROMPT}\n`);
    const reset = ioFor(dir);
    assert.equal(await run(["doctor", "--project", dir], reset.io), 0, reset.err());
    assert.match(reset.out(), /breakdown prompt: default/);
  });
});

test("breakdown prompt set --file copies the text and ignores a later move of the source", async () => {
  await withDir(async (dir) => {
    await mkdir(path.join(dir, "xdg", "lumen"), { recursive: true });
    await writeFile(
      globalFile(dir),
      `${JSON.stringify({
        models: {
          "video-understand-router": {
            provider: "mediakit",
            baseUrl: "https://mediakit.example",
            apiKeyEnv: "MEDIAKIT_UNDERSTAND_KEY",
          },
        },
        breakdown: { promptFile: "gone.txt", preferModels: ["doubao-seed-2-0-lite-260428"] },
      }, null, 2)}\n`,
    );
    const source = path.join(dir, "notes.txt");
    await writeFile(source, "第一行\n第二行\n");
    const set = ioFor(dir);
    assert.equal(await run(["breakdown", "prompt", "set", "--file", "notes.txt"], set.io), 0, set.err());
    await rm(source);
    const stored = await readJson(globalFile(dir));
    assert.equal(stored.breakdown?.prompt, "第一行\n第二行");
    assert.equal(stored.breakdown?.promptFile, undefined);
    assert.deepEqual(stored.breakdown?.preferModels, ["doubao-seed-2-0-lite-260428"]);
    assert.equal(stored.models?.["video-understand-router"]?.provider, "mediakit");
    assert.equal(JSON.stringify(stored).includes("notes.txt"), false);

    const show = ioFor(dir);
    assert.equal(await run(["breakdown", "prompt", "show"], show.io), 0, show.err());
    assert.equal(show.out(), "source: global\n第一行\n第二行\n");

    const cap = ioFor(dir);
    assert.equal(await run(["breakdown", "--video", "refs/in.mp4", "--project", dir], cap.io), 0, cap.err());
    const record = await recordOf(dir, cap.out());
    assert.equal(record.params.prompt, "第一行\n第二行");
    assert.equal(record.params.promptSource, "global");
    assert.equal(JSON.stringify(record.calls).includes("第一行\\n第二行"), true);
  });
});

test("project binding beats global, and clear removes only the chosen scope", async () => {
  await withDir(async (dir) => {
    await bind(dir);
    const globalSet = ioFor(dir);
    assert.equal(await run(["breakdown", "prompt", "set", "--text", "全局拉片"], globalSet.io), 0, globalSet.err());
    const projectSet = ioFor(dir);
    assert.equal(await run(["breakdown", "prompt", "set", "--text", "项目拉片", "--project"], projectSet.io), 0, projectSet.err());
    assert.match(projectSet.out(), /set breakdown prompt \(project\)/);
    const projectFile = await readJson(path.join(dir, "lumen.config.json"));
    assert.equal(projectFile.breakdown?.prompt, "项目拉片");
    assert.equal(projectFile.models?.["video-understand-router"]?.provider, "mediakit");
    assert.equal((await readJson(globalFile(dir))).breakdown?.prompt, "全局拉片");

    const shown = ioFor(dir);
    assert.equal(await run(["breakdown", "prompt", "show", "--project", dir], shown.io), 0, shown.err());
    assert.equal(shown.out(), "source: project\n项目拉片\n");
    const runProject = ioFor(dir);
    assert.equal(await run(["breakdown", "--video", "refs/in.mp4", "--project", dir], runProject.io), 0, runProject.err());
    const projectRecord = await recordOf(dir, runProject.out());
    assert.equal(projectRecord.params.promptSource, "project");
    assert.equal(projectRecord.params.prompt, "项目拉片");

    const clearProject = ioFor(dir);
    assert.equal(await run(["breakdown", "prompt", "clear", "--project", dir], clearProject.io), 0, clearProject.err());
    assert.match(clearProject.out(), /cleared breakdown prompt \(project\)/);
    const afterProject = ioFor(dir);
    assert.equal(await run(["breakdown", "prompt", "show"], afterProject.io), 0, afterProject.err());
    assert.equal(afterProject.out(), "source: global\n全局拉片\n");
    const runGlobal = ioFor(dir);
    assert.equal(await run(["breakdown", "--video", "refs/in.mp4", "--project", dir], runGlobal.io), 0, runGlobal.err());
    assert.equal((await recordOf(dir, runGlobal.out())).params.promptSource, "global");

    const other = path.join(dir, "other");
    await mkdir(other);
    const elsewhere = ioFor(dir);
    assert.equal(await run(["breakdown", "prompt", "show", "--project", other], elsewhere.io), 0, elsewhere.err());
    assert.equal(elsewhere.out(), "source: global\n全局拉片\n");

    const clearGlobal = ioFor(dir);
    assert.equal(await run(["breakdown", "prompt", "clear"], clearGlobal.io), 0, clearGlobal.err());
    const builtin = ioFor(dir);
    assert.equal(await run(["breakdown", "--video", "refs/in.mp4", "--project", dir], builtin.io), 0, builtin.err());
    const builtinRecord = await recordOf(dir, builtin.out());
    assert.equal(builtinRecord.params.promptSource, "built-in");
    assert.equal(builtinRecord.params.prompt, BREAKDOWN_DEFAULT_PROMPT);
    assert.equal((await readJson(globalFile(dir))).breakdown?.prompt, undefined);
  });
});

test("prompt precedence is flag, prompt-file, project config, global binding, then built-in", async () => {
  await withDir(async (dir) => {
    await bind(dir);
    const projectPromptFile = path.join(dir, "project-prompt.txt");
    const flagFile = path.join(dir, "flag-prompt.txt");
    const globalPromptFile = path.join(dir, "global-prompt.txt");
    await writeFile(projectPromptFile, "project file\n");
    await writeFile(flagFile, "flag file\n");
    await writeFile(globalPromptFile, "global file\n");
    const configPath = path.join(dir, "lumen.config.json");
    const config = await readJson(configPath);
    config.breakdown = { prompt: "project text", promptFile: projectPromptFile };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await mkdir(path.join(dir, "xdg", "lumen"), { recursive: true });
    await writeFile(globalFile(dir), `${JSON.stringify({ breakdown: { prompt: "global text", promptFile: globalPromptFile } }, null, 2)}\n`);

    const fromFile = ioFor(dir);
    assert.equal(await run(["breakdown", "--video", "refs/in.mp4", "--project", dir], fromFile.io), 0, fromFile.err());
    const fileRecord = await recordOf(dir, fromFile.out());
    assert.equal(fileRecord.params.prompt, "project file");
    assert.equal(fileRecord.params.promptSource, "project");

    config.breakdown = { prompt: "project text" };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const fromText = ioFor(dir);
    assert.equal(await run(["breakdown", "--video", "refs/in.mp4", "--project", dir], fromText.io), 0, fromText.err());
    const textRecord = await recordOf(dir, fromText.out());
    assert.equal(textRecord.params.prompt, "project text");
    assert.equal(textRecord.params.promptSource, "project");

    const flaggedFile = ioFor(dir);
    assert.equal(
      await run(["breakdown", "--video", "refs/in.mp4", "--prompt-file", flagFile, "--project", dir], flaggedFile.io),
      0,
      flaggedFile.err(),
    );
    const flagFileRecord = await recordOf(dir, flaggedFile.out());
    assert.equal(flagFileRecord.params.prompt, "flag file");
    assert.equal(flagFileRecord.params.promptSource, "flag");

    const flagged = ioFor(dir);
    assert.equal(
      await run(["breakdown", "--video", "refs/in.mp4", "--prompt", "flag text", "--prompt-file", flagFile, "--project", dir], flagged.io),
      0,
      flagged.err(),
    );
    const flagRecord = await recordOf(dir, flagged.out());
    assert.equal(flagRecord.params.prompt, "flag text");
    assert.equal(flagRecord.params.promptSource, "flag");

    const shown = ioFor(dir);
    assert.equal(await run(["breakdown", "prompt", "show", "--prompt", "临时", "--project", dir], shown.io), 0, shown.err());
    assert.equal(shown.out(), "source: flag\n临时\n");

    config.breakdown = { prompt: "" };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const emptyProject = ioFor(dir);
    assert.equal(await run(["breakdown", "--video", "refs/in.mp4", "--project", dir], emptyProject.io), 0, emptyProject.err());
    const emptyRecord = await recordOf(dir, emptyProject.out());
    assert.equal(emptyRecord.params.prompt, "global file");
    assert.equal(emptyRecord.params.promptSource, "global");

    await writeFile(globalFile(dir), `${JSON.stringify({ breakdown: { prompt: "global text" } }, null, 2)}\n`);
    const globalText = ioFor(dir);
    assert.equal(await run(["breakdown", "--video", "refs/in.mp4", "--project", dir], globalText.io), 0, globalText.err());
    const globalRecord = await recordOf(dir, globalText.out());
    assert.equal(globalRecord.params.prompt, "global text");
    assert.equal(globalRecord.params.promptSource, "global");

    config.breakdown = { prompt: "project text" };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(globalFile(dir), `${JSON.stringify({ breakdown: { promptFile: globalPromptFile } }, null, 2)}\n`);
    const projectBeatsGlobalFile = ioFor(dir);
    assert.equal(await run(["breakdown", "--video", "refs/in.mp4", "--project", dir], projectBeatsGlobalFile.io), 0, projectBeatsGlobalFile.err());
    const beat = await recordOf(dir, projectBeatsGlobalFile.out());
    assert.equal(beat.params.prompt, "project text");
    assert.equal(beat.params.promptSource, "project");
  });
});

test("breakdown prompt set and clear reject bad usage and a bare --project stays local to that command", async () => {
  await withDir(async (dir) => {
    const neither = ioFor(dir);
    assert.equal(await run(["breakdown", "prompt", "set"], neither.io), 2);
    assert.match(neither.err(), /needs --file or --text/);
    const both = ioFor(dir);
    assert.equal(await run(["breakdown", "prompt", "set", "--file", "a.txt", "--text", "同时"], both.io), 2);
    assert.match(both.err(), /not both/);
    const missing = ioFor(dir);
    assert.equal(await run(["breakdown", "prompt", "set", "--file", "missing.txt"], missing.io), 1);
    assert.match(missing.err(), /prompt file not found/);
    const blank = ioFor(dir);
    assert.equal(await run(["breakdown", "prompt", "set", "--text", "   "], blank.io), 1);
    assert.match(blank.err(), /prompt text is empty/);
    const emptyFile = path.join(dir, "empty.txt");
    await writeFile(emptyFile, " \n");
    const blankFile = ioFor(dir);
    assert.equal(await run(["breakdown", "prompt", "set", "--file", emptyFile], blankFile.io), 1);
    assert.match(blankFile.err(), /prompt text is empty/);
    const noSub = ioFor(dir);
    assert.equal(await run(["breakdown", "prompt"], noSub.io), 2);
    assert.match(noSub.err(), /needs set, show, or clear/);
    const unknown = ioFor(dir);
    assert.equal(await run(["breakdown", "prompt", "nope"], unknown.io), 2);
    const bareDoctor = ioFor(dir);
    assert.equal(await run(["doctor", "--project"], bareDoctor.io), 2);
    assert.match(bareDoctor.err(), /--project needs a directory/);

    const bare = ioFor(dir);
    assert.equal(await run(["breakdown", "prompt", "set", "--text", "当前项目", "--project"], bare.io), 0, bare.err());
    assert.match(bare.out(), /set breakdown prompt \(project\)/);
    assert.equal((await readJson(path.join(dir, "lumen.config.json"))).breakdown?.prompt, "当前项目");
    await assert.rejects(access(globalFile(dir)));

    const clearMissing = ioFor(dir);
    const absent = path.join(dir, "absent");
    assert.equal(await run(["breakdown", "prompt", "clear", "--project", absent], clearMissing.io), 1);
    assert.match(clearMissing.err(), /project folder does not exist/);

    const already = ioFor(dir);
    assert.equal(await run(["breakdown", "prompt", "clear"], already.io), 0, already.err());
    assert.match(already.out(), /cleared breakdown prompt \(global\)/);
    await assert.rejects(access(globalFile(dir)));
  });
});
