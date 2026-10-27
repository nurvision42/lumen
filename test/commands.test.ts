import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BREAKDOWN_DEFAULT_PROMPT } from "../src/catalog.js";
import { run } from "../src/run.js";
import { capture, withDir } from "./helpers.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(root, "dist", "cli.js");

test("help and version name lumen and the planned backends", async () => {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version: string };
  const help = capture();
  assert.equal(await run(["--help"], help.io), 0);
  for (const word of ["lumen", "init", "validate", "breakdown", "download", "setup", "tikhub", "TIKHUB_API_KEY", "sprite", "cuts", "concat", "doctor", "yunqiao", "grsai", "haomao", "kitta", "fishaudio.org", "MediaKit", "models", "providers", "runs", "enhance"]) {
    assert.match(help.out(), new RegExp(word.replace(".", "\\.")));
  }

  const version = capture();
  assert.equal(await run(["--version"], version.io), 0);
  assert.equal(version.out().trim(), pkg.version);

  const unknown = capture();
  assert.equal(await run(["nope"], unknown.io), 2);
});

test("seedance prompt skill is one file and old paths redirect", async () => {
  const skill = await readFile(path.join(root, "skills", "lumen", "SKILL.md"), "utf8");
  assert.match(skill, /references\/seedance-2\/SKILL\.md/);
  assert.match(skill, /references\/seedance-2\.5\/SKILL\.md/);
  assert.match(skill, /references\/seedance-提示词写法\/SKILL\.md/);
  assert.match(skill, /图像和视频都读 `skills\/lumen\/references\/拍摄设定\/SKILL\.md`/);
  assert.match(skill, /先读 `skills\/lumen\/references\/seedance-2\/SKILL\.md`/);
  assert.match(skill, /先读 `skills\/lumen\/references\/seedance-2\.5\/SKILL\.md`/);
  assert.match(skill, /提示词写法只优化提示词/);
  assert.match(skill, /lumen fish design/);
  assert.match(skill, /lumen 是本地视频工具集/);
  assert.match(skill, /单独用/);
  assert.match(skill, /doubao-seed-2-1-lite-260915/);
  assert.match(skill, /不要问用户选模型/);
  assert.match(skill, /Quality/);
  assert.match(skill, /breakdown\.preferModels/);
  assert.match(skill, /breakdown\.level/);
  assert.match(skill, /breakdown\.needAudio/);
  assert.match(skill, /references\/视频拆解\/SKILL\.md/);
  assert.match(skill, /不要传 prompt/);
  assert.match(skill, /不要因为出现了视频就自动拆解/);
  assert.match(skill, /references\/视频下载\/SKILL\.md/);
  assert.match(skill, /lumen download "<链接>" --to refs\/source\.mp4/);
  assert.match(skill, /lumen setup --key tikhub/);
  assert.match(skill, /TIKHUB_API_KEY/);
  assert.match(skill, /不要在对话里向用户要密钥/);
  assert.match(skill, /不要因为出现了链接就自动下载/);
  assert.match(skill, /references\/雪碧图\/SKILL\.md/);
  assert.match(skill, /lumen sprite --video <file> --to refs\/sheet\.png/);
  assert.match(skill, /lumen cuts --video <file>/);
  assert.match(skill, /lumen setup ffmpeg/);
  assert.match(skill, /不要因为出现了视频就自动出雪碧图/);
  const spriteSkill = await readFile(path.join(root, "skills", "lumen", "references", "雪碧图", "SKILL.md"), "utf8");
  assert.match(spriteSkill, /每镜抽头、中、尾/);
  assert.match(spriteSkill, /切点/);
  assert.match(spriteSkill, /--columns/);
  assert.match(spriteSkill, /--rows/);
  assert.match(spriteSkill, /--cell/);
  assert.match(spriteSkill, /--transcript/);
  assert.match(spriteSkill, /不覆盖/);
  assert.match(spriteSkill, /--json/);
  assert.match(spriteSkill, /lumen setup ffmpeg/);
  assert.equal(/https?:\/\/|\/v1\//.test(spriteSkill), false);
  assert.match(skill, /bash scripts\/install\.sh/);
  assert.match(skill, /~\/\.local\/share\/lumen/);
  assert.match(skill, /~\/\.local\/bin\/lumen/);
  assert.match(skill, /bash scripts\/install\.sh --uninstall/);
  assert.match(skill, /npm install -g --prefix ~\/\.local/);
  assert.match(skill, /~\/\.config\/lumen/);
  assert.match(skill, /~\/\.cache\/lumen/);
  assert.match(skill, /--path/);
  assert.match(skill, /--no-path/);
  assert.equal(skill.includes("sudo npm"), false);
  assert.match(skill, /lumen skill install/);
  assert.match(skill, /\/home\/box\/agent-data\/workflows/);
  assert.match(skill, /~\/\.agents\/skills\/lumen/);
  assert.match(skill, /LUMEN_SKILL_DIR/);
  assert.match(skill, /--clean/);
  assert.match(skill, /LUMEN_NO_SKILL_AUTOINSTALL=1/);
  assert.match(skill, /postinstall 也按这个规则/);
  assert.match(skill, /\.lumen-version/);
  const downloadSkill = await readFile(path.join(root, "skills", "lumen", "references", "视频下载", "SKILL.md"), "utf8");
  assert.match(downloadSkill, /不要在对话里向用户要密钥/);
  assert.match(downloadSkill, /lumen setup --key tikhub/);
  assert.match(downloadSkill, /TIKHUB_API_KEY/);
  assert.match(downloadSkill, /lumen download "<链接>" --to refs\/source\.mp4/);
  assert.match(downloadSkill, /lumen breakdown --video refs\/source\.mp4/);
  assert.match(downloadSkill, /不要传 prompt/);
  assert.match(downloadSkill, /不要自己拼 HTTP/);
  assert.equal(/https?:\/\/|\/v1\//.test(downloadSkill), false);
  const breakdownSkill = await readFile(path.join(root, "skills", "lumen", "references", "视频拆解", "SKILL.md"), "utf8");
  assert.match(breakdownSkill, /不要传 prompt/);
  assert.match(breakdownSkill, /不要自己写拆解提示词/);
  assert.match(breakdownSkill, /不要因为对话里出现了视频就自动拆解/);
  assert.match(breakdownSkill, /每个镜头单独一节/);
  assert.match(breakdownSkill, /字幕\/台词放在这一节最上面/);
  assert.match(breakdownSkill, /不要用 14 列宽表/);
  assert.equal(/请对这个视频做逐镜头拉片分析/.test(breakdownSkill), false);
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  assert.equal(readme.includes(BREAKDOWN_DEFAULT_PROMPT), true);
  assert.equal(skill.trim().split("\n").length <= 80, true);
  assert.equal(/给代理用的|for agents/i.test(skill), false);
  assert.equal(/nurvision|\.nurvision|\bnv\b/i.test(skill.replaceAll("@nurvision/lumen", "")), false);
  assert.equal(/cinematic|电影感|seedance-pe\/SKILL\.md/.test(skill), false);
  assert.equal(/https?:\/\/|contents\/generations|\/v1\/|SEEDANCE_POLL|MEDIAKIT_POLL|还没做的|X-Group|voice-designs|api\/open|shotlist\.md/.test(skill), false);

  const usage20 = await readFile(path.join(root, "skills", "lumen", "references", "seedance-2", "SKILL.md"), "utf8");
  const usage25 = await readFile(path.join(root, "skills", "lumen", "references", "seedance-2.5", "SKILL.md"), "utf8");
  for (const word of ["text", "frame", "reference", "generate_audio", "adaptive"]) {
    assert.match(usage20, new RegExp(word));
    assert.match(usage25, new RegExp(word));
  }
  assert.match(usage20, /\[4, 15\]/);
  assert.match(usage20, /提示词写法/);
  assert.match(usage20, /seedance-提示词写法\/SKILL\.md/);
  assert.match(usage25, /omni_reference_task_type/);
  assert.match(usage25, /edit/);
  assert.match(usage25, /extend/);
  assert.match(usage25, /提示词写法/);
  assert.match(usage25, /seedance-提示词写法\/SKILL\.md/);
  assert.match(usage20, /正文没写的图、视频、音频不要放进/);
  assert.match(usage25, /正文没写的图、视频、音频不要放进/);
  assert.equal(/seedance-pe\/SKILL\.md/.test(usage20 + usage25), false);
  assert.equal(/contents\/generations|八大核心要素|精准主体 \+ 动作细节/.test(usage20 + usage25), false);

  const pe = await readFile(path.join(root, "skills", "lumen", "references", "seedance-提示词写法", "SKILL.md"), "utf8");
  assert.match(pe, /name:\s*"Seedance 提示词写法"/);
  assert.ok(Buffer.byteLength(pe, "utf8") >= 20000);
  assert.match(pe, /提示词正文只用英文/);
  assert.match(pe, /no subtitles, no music/);
  assert.match(pe, /精准主体、动作细节、场景环境、机身\/色调、焦段\/镜别\/运镜、约束/);
  assert.match(pe, /机身\/色调/);
  assert.match(pe, /焦段\/镜别\/运镜/);
  assert.match(pe, /全片只写一次/);
  assert.match(pe, /每一种运镜|一种运镜/);
  assert.match(pe, /机身是 iPhone 原相机时/);
  assert.match(pe, /不写视场角，不写光圈或焦段编号/);
  assert.match(pe, /路径 B 每一镜仍可写景别和一种运镜/);
  assert.match(pe, /iPhone native-camera look, computational HDR/);
  assert.equal(/镜头运镜|光影色调/.test(pe), false);
  assert.match(pe, /拍摄设定/);
  assert.match(pe, /拍摄设定\/SKILL\.md/);
  assert.match(pe, /写看得见、量得着的画面/);
  assert.match(pe, /写目标，不堆禁令/);
  assert.match(pe, /优先可度量的说法/);
  assert.match(pe, /路径 A/);
  assert.match(pe, /路径 B/);
  assert.match(pe, /Shot 1/);
  assert.match(pe, /0–3s/);
  const fences = [...pe.matchAll(/```text\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
  assert.ok(fences.length >= 10);
  for (const block of fences) {
    assert.equal(/[\u4e00-\u9fff]/.test(block), false);
  }
  assert.match(pe, /Seedance 2\.5/);
  assert.match(pe, /可选：关键帧/);
  assert.match(pe, /可选：宫格分镜/);
  assert.match(pe, /本仓库不写白模/);
  assert.match(pe, /不要写「参考 @视频N」/);
  assert.match(pe, /严格编辑/);
  assert.match(pe, /向后延长/);
  assert.match(pe, /seedance-2\/SKILL\.md/);
  assert.match(pe, /seedance-2\.5\/SKILL\.md/);
  assert.equal(/未采用|\[Unused\]|未采用素材/.test(pe), false);
  assert.equal(/白模参考|粗粒度白模|默认挂载画质包|nurvision|cinematic/.test(pe), false);
  assert.equal(/lumen gen|--duration|--task-type|contents\/generations|https?:\/\//.test(pe), false);

  const look = await readFile(path.join(root, "skills", "lumen", "references", "拍摄设定", "SKILL.md"), "utf8");
  assert.match(look, /name:\s*拍摄设定/);
  assert.match(look, /图像和视频都用本文件/);
  assert.match(look, /大画幅数字/);
  assert.match(look, /180°/);
  assert.match(look, /f\/1\.4/);
  assert.match(look, /ultra-sharp clinical rendering/);
  assert.match(look, /84° field of view/);
  assert.match(look, /运镜/);
  assert.match(look, /MV01/);
  assert.match(look, /locked-off stable framing throughout this time range/);
  assert.match(look, /MS01/);
  assert.match(look, /经典静止/);
  assert.match(look, /SR01/);
  assert.match(look, /constant real-time playback/);
  assert.match(look, /CB10/);
  assert.match(look, /iPhone 原相机/);
  assert.match(look, /iPhone native-camera look, computational HDR, clean digital sharpness, colour and contrast as the built-in camera app recorded them/);
  assert.match(look, /选了 iPhone 原相机，机身只写那一句英文/);
  assert.equal(/这里不规定这些句子放在整段还是分镜/.test(look), true);
  assert.equal(/全片|每一镜|路径 A|路径 B|presets\.yaml|锐利干净的成像/.test(look), false);
  assert.equal(/higgsfield|电影感|cinematic/i.test(look), false);
  assert.equal(/写看得见、量得着的画面/.test(look), false);
  await assert.rejects(access(path.join(root, "skills", "lumen", "references", "cinematic", "SKILL.md")));
  await assert.rejects(access(path.join(root, "skills", "lumen", "references", "拍摄设定", "presets.yaml")));

  const imagePe = await readFile(path.join(root, "skills", "lumen", "references", "gpt-image-提示词写法", "SKILL.md"), "utf8");
  assert.match(skill, /出图先读 `skills\/lumen\/references\/gpt-image\/SKILL\.md`/);
  assert.match(skill, /再读 `skills\/lumen\/references\/gpt-image-提示词写法\/SKILL\.md`/);
  const imageUsage = await readFile(path.join(root, "skills", "lumen", "references", "gpt-image", "SKILL.md"), "utf8");
  assert.match(imageUsage, /name:\s*gpt-image/);
  assert.match(imageUsage, /gpt-image-2\.5-flare/);
  assert.match(imageUsage, /gpt-image-2\.5-sunburst/);
  assert.match(imageUsage, /更快的日常出图/);
  assert.match(imageUsage, /质量优先/);
  assert.match(imageUsage, /基线/);
  assert.match(imageUsage, /gpt-image-提示词写法\/SKILL\.md/);
  assert.match(imageUsage, /--aspect-ratio/);
  assert.match(imageUsage, /--resolution/);
  assert.match(imageUsage, /--background/);
  assert.match(imageUsage, /--ref/);
  assert.match(imageUsage, /--dry-run/);
  assert.match(imageUsage, /--execute/);
  assert.match(imageUsage, /固定发出 `high`/);
  assert.match(imageUsage, /固定发出 `max`/);
  assert.match(imageUsage, /执行前先问用户确认/);
  assert.match(imageUsage, /不要替用户选 `1K`/);
  assert.match(imageUsage, /provider yunqiao does not support resolution 4K/);
  assert.match(imageUsage, /实验/);
  assert.equal(/--quality|1536x1024|1088x608|3840x2160|像素不看|先试 `low`/.test(imageUsage), false);
  assert.match(imageUsage, /不发送 `output_format`/);
  assert.match(imageUsage, /yunqiao image edits need a local file/);
  assert.match(imageUsage, /providers set/);
  assert.match(imageUsage, /最多 16/);
  assert.equal(/\/v1\/|images\/generations|images\/edits/.test(imageUsage), false);
  assert.match(imagePe, /name:\s*"GPT Image 提示词写法"/);
  assert.ok(Buffer.byteLength(imagePe, "utf8") >= 12000);
  assert.match(imagePe, /提示词正文只用英文/);
  assert.match(imagePe, /场景、主体、细节、约束/);
  assert.match(imagePe, /用途/);
  assert.match(imagePe, /photorealistic/);
  assert.match(imagePe, /Change only/);
  assert.match(imagePe, /Preserve/);
  assert.match(imagePe, /image 1/);
  assert.match(imagePe, /the second image/);
  assert.match(imagePe, /拍摄设定\/SKILL\.md/);
  assert.match(imagePe, /机身是 iPhone 原相机时/);
  assert.match(imagePe, /iPhone native-camera look, computational HDR, clean digital sharpness, colour and contrast as the built-in camera app recorded them/);
  assert.match(imagePe, /不写视场角，不写光圈/);
  assert.match(imagePe, /fully transparent background/);
  assert.match(imagePe, /棋盘格/);
  assert.match(imagePe, /preserve the transparent background/);
  assert.match(imagePe, /exactly once/);
  assert.match(imagePe, /Do not redesign the character/);
  assert.match(imagePe, /full body visible, feet included/);
  assert.equal(/CB01|LN01|MV01|presets\.yaml/.test(imagePe), false);
  assert.equal(/lumen gen|--duration|--task-type|https?:\/\//.test(imagePe), false);
  const imageFences = [...imagePe.matchAll(/```text\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
  assert.ok(imageFences.length >= 12);
  for (const block of imageFences) {
    assert.equal(/[\u4e00-\u9fff]/.test(block), false);
  }

  for (const [dir, name] of [
    ["seedance-2-pe", "sd2-pe"],
    ["seedance-2.5-pe", "sd25-pe"],
    ["seedance-pe", "seedance-pe"],
  ] as const) {
    const text = await readFile(path.join(root, "skills", "lumen", "references", dir, "SKILL.md"), "utf8");
    assert.match(text, new RegExp(`name:\\s*${name}`));
    assert.match(text, /seedance-提示词写法\/SKILL\.md/);
    assert.ok(Buffer.byteLength(text, "utf8") < 1000);
  }
});

test("init creates the folder layout and does not overwrite a shot list", async () => {
  await withDir(async (dir) => {
    const first = capture();
    assert.equal(await run(["init", dir], first.io), 0);
    assert.match(first.out(), /created shotlist\.md/);
    for (const rel of ["shotlist.md", "refs/.gitkeep", "shots/.gitkeep", "out/.gitkeep", "lumen.config.json"]) {
      await access(path.join(dir, rel));
    }
    assert.match(first.out(), /created lumen\.config\.json/);
    const before = await readFile(path.join(dir, "shotlist.md"), "utf8");
    assert.match(before, /\| # \| durationSec \| frame \| vo \|/);

    const second = capture();
    assert.equal(await run(["init", dir], second.io), 0);
    assert.match(second.out(), /kept shotlist\.md/);
    assert.match(second.out(), /kept lumen\.config\.json/);
    assert.equal(await readFile(path.join(dir, "shotlist.md"), "utf8"), before);
  });
});

test("concat stays an ffmpeg stub and writes nothing", async () => {
  await withDir(async (dir) => {
    const concat = capture();
    assert.equal(await run(["concat", "--project", dir], concat.io), 0);
    assert.match(concat.out(), /ffmpeg is not invoked in v0/);
    assert.match(concat.out(), /out\/film\.mp4/);
    await assert.rejects(access(path.join(dir, "out", "film.mp4")));
  });
});

test("gen without --model is usage and writes no run", async () => {
  await withDir(async (dir) => {
    const image = capture();
    assert.equal(await run(["gen", "image", "--project", dir], image.io), 2);
    assert.match(image.err(), /needs --model/);
    await assert.rejects(access(path.join(dir, ".lumen")));
  });
});

test("providers set without --base-url uses the provider default, and --base-url overrides it", async () => {
  await withDir(async (dir) => {
    const set = capture();
    assert.equal(await run(["providers", "set", "seedance-2", "--provider", "haomao", "--api-key-env", "HAOMAO_KEY", "--project", dir], set.io), 0);
    assert.match(set.out(), /https:\/\/haomaotoken\.com\/api\/v3 \(default\)/);
    const stored = JSON.parse(await readFile(path.join(dir, "lumen.config.json"), "utf8")) as { models: Record<string, { baseUrl?: string }> };
    assert.equal(stored.models["seedance-2"]?.baseUrl, undefined);
    const list = capture();
    assert.equal(await run(["providers", "list", "--project", dir], list.io), 0);
    assert.match(list.out(), /seedance-2  haomao  https:\/\/haomaotoken\.com\/api\/v3 \(default\)/);
    const custom = capture();
    assert.equal(await run(["providers", "set", "seedance-2", "--provider", "haomao", "--base-url", "https://mirror.example/api/v3", "--api-key-env", "HAOMAO_KEY", "--project", dir], custom.io), 0);
    const again = capture();
    assert.equal(await run(["providers", "list", "--project", dir], again.io), 0);
    assert.match(again.out(), /seedance-2  haomao  https:\/\/mirror\.example\/api\/v3  HAOMAO_KEY/);
  });
});

test("doctor lists unbound models and does not print secret values", async () => {
  await withDir(async (dir) => {
    const set = capture();
    assert.equal(
      await run(
        ["providers", "set", "gpt-image-2", "--provider", "yunqiao", "--base-url", "https://yunqiao.example/v1", "--api-key-env", "YUNQIAO_API_KEY", "--project", dir],
        set.io,
      ),
      0,
    );
    const cap = capture({ PATH: process.env.PATH ?? "", YUNQIAO_API_KEY: "secret-value" });
    assert.equal(await run(["doctor", "--project", dir], cap.io), 0);
    const text = cap.out();
    assert.match(text, /gpt-image-2: yunqiao https:\/\/yunqiao\.example\/v1 YUNQIAO_API_KEY present/);
    assert.match(text, /seedance-2: unbound/);
    assert.match(text, /voice-synthesis: unbound/);
    assert.match(text, /enhance-video: unbound/);
    assert.match(text, /breakdown prompt: default/);
    assert.match(text, /breakdown models: doubao-seed-2-1-lite-260915/);
    assert.match(text, /breakdown level: Quality/);
    assert.match(text, /breakdown needAudio: true/);
    assert.match(text, /tikhub key: missing/);
    assert.match(text, /^ffmpeg: (missing|.+ source=(?:config|path|cache))$/m);
    assert.match(text, /^ffprobe: (missing|.+ source=(?:config|path|cache))$/m);
    assert.match(text, /^sharp: (missing|.+ source=(?:module|cache|download))$/m);
    assert.match(text, /^lumen: \S+$/m);
    assert.match(text, /^lumen on PATH: (missing|\S+ \((?:this|other)\))$/m);
    assert.match(text, /^user bin: unavailable$/m);
    assert.match(text, /^config dir: unavailable$/m);
    assert.match(text, /^cache dir: unavailable$/m);
    assert.match(text, /no network/);
    assert.equal(text.includes("secret-value"), false);
  });
});

test("the built binary rejects an empty project", async () => {
  await withDir(async (dir) => {
    const result = spawnSync(process.execPath, [cli, "validate", "--project", dir], {
      encoding: "utf8",
      env: { ...process.env, LUMEN_NO_SKILL_AUTOINSTALL: "1" },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no shotlist/);
  });
});
