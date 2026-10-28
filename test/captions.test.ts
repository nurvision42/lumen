import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { overlayGraph } from "../src/captions/burn.js";
import {
  alignUntimed,
  applyTimedScript,
  clampCues,
  fitRatio,
  reconcileCaptions,
  SCRIPT_FIT_MIN,
} from "../src/captions/cues.js";
import { composePill, encodePng, roundedCoverage } from "../src/captions/png.js";
import { discoverScript } from "../src/captions/script.js";
import { wrapSubtitle } from "../src/captions/render.js";
import {
  BACKGROUND_COLOR,
  LANDSCAPE_BOTTOM_MARGIN,
  PORTRAIT_TOP_MARGIN,
  defaultPosition,
  edgeMarginPx,
  fontSizeFor,
  pillTop,
} from "../src/captions/style.js";
import { run } from "../src/run.js";
import { capture, withDir } from "./helpers.js";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const FONT = "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc";

test("default caption layout follows the short side and the safe-area ratios", () => {
  assert.equal(fontSizeFor(1440, 2560), 56);
  assert.equal(defaultPosition(1440, 2560), "top_center");
  assert.equal(edgeMarginPx(2560, "top_center"), 317);
  assert.equal(PORTRAIT_TOP_MARGIN, 317 / 2560);
  assert.equal(fontSizeFor(2560, 1440), 56);
  assert.equal(defaultPosition(2560, 1440), "bottom_center");
  assert.equal(edgeMarginPx(1440, "bottom_center"), 225);
  assert.equal(LANDSCAPE_BOTTOM_MARGIN, 225 / 1440);
  assert.equal(defaultPosition(1080, 1080), "bottom_center");
  assert.equal(edgeMarginPx(1000, "top_center"), Math.round(1000 * 317 / 2560));
  assert.equal(fontSizeFor(720, 1280), 28);
  assert.equal(BACKGROUND_COLOR.a, 0.51);
  const top = pillTop(2560, 80, "top_center");
  assert.equal(top, 317);
  const bottom = pillTop(1440, 80, "bottom_center");
  assert.equal(bottom, 1440 - 225 - 80);
});

test("clamp keeps cue ends inside the picture", () => {
  const kept = clampCues([
    { start: 0.2, end: 1.2, text: "留着" },
    { start: 1.5, end: 5, text: "裁尾" },
    { start: 4.2, end: 6, text: "丢掉" },
  ], 3);
  assert.equal(kept.clamped, true);
  assert.equal(kept.cues.length, 2);
  assert.equal(kept.cues[1]?.end, 3);
  assert.equal(kept.cues[1]?.text, "裁尾");
  const clean = clampCues([{ start: 0, end: 1, text: "刚好" }], 1);
  assert.equal(clean.clamped, false);
  assert.equal(clean.cues[0]?.end, 1);
});

test("a known script replaces recognition errors and fills a long gap", () => {
  assert.equal(fitRatio("这不就瓶普通矿泉水吗", "这不就瓶普通矿泉水吗"), 1);
  assert.ok(fitRatio("这不就瓶普通矿泉谁吗", "这不就瓶普通矿泉水吗") >= SCRIPT_FIT_MIN);
  assert.ok(fitRatio("hello world", "这不就瓶普通矿泉水吗") < SCRIPT_FIT_MIN);

  const fixed = alignUntimed(
    [
      { start: 0.2, end: 1.4, text: "这不就瓶普通矿泉" },
      { start: 1.4, end: 2.6, text: "水吗今天天气" },
    ],
    "这不就瓶普通矿泉水吗",
    4,
  );
  assert.equal(fixed.map((cue) => cue.text).join(""), "这不就瓶普通矿泉水吗");
  assert.equal(fixed.some((cue) => cue.text.includes("今天")), false);

  const comma = alignUntimed(
    [
      { start: 0, end: 1, text: "你好" },
      { start: 1, end: 2, text: "世界" },
    ],
    "你好，世界",
    2,
  );
  assert.equal(comma.map((cue) => cue.text).join(""), "你好，世界");

  const filled = alignUntimed([{ start: 0, end: 1, text: "你好" }], "你好世界", 3);
  assert.equal(filled.map((cue) => cue.text).join(""), "你好世界");
  assert.equal(filled.length, 2);
  assert.ok((filled[1]?.start ?? 0) >= 1);

  const timed = applyTimedScript(
    [
      { start: 0.4, end: 1.8, text: "这不就瓶普通矿泉谁" },
      { start: 2.2, end: 3.6, text: "哎这水喝着挺顺啊" },
    ],
    [
      { start: 0, end: 2, text: "这不就瓶普通矿泉水吗" },
      { start: 2, end: 4, text: "哎这水喝着挺顺" },
    ],
  );
  assert.deepEqual(timed.map((cue) => cue.text), ["这不就瓶普通矿泉水吗", "哎这水喝着挺顺"]);
  assert.equal(timed[0]?.start, 0.4);
  assert.equal(timed[0]?.end, 1.8);
  assert.equal(timed[1]?.start, 2.2);
  assert.equal(timed[1]?.end, 3.6);
});

test("a poor script match is not confirmed and is not applied", () => {
  const result = reconcileCaptions({
    asr: [{ start: 0.2, end: 1.2, text: "hello there" }],
    script: { source: "file", file: "script.txt", timed: false, lines: [{ text: "这不就瓶普通矿泉水吗" }], text: "这不就瓶普通矿泉水吗" },
    duration: 2,
  });
  assert.equal(result.confirmed, false);
  assert.equal(result.script?.applied, false);
  assert.equal(result.cues[0]?.text, "hello there");

  const matched = reconcileCaptions({
    asr: [{ start: 0.2, end: 1.5, text: "这不就瓶普通矿泉谁吗" }],
    script: { source: "shotlist", file: "shotlist.md", timed: true, lines: [{ start: 0, end: 2, text: "这不就瓶普通矿泉水吗" }], text: "这不就瓶普通矿泉水吗" },
    duration: 2,
  });
  assert.equal(matched.confirmed, true);
  assert.equal(matched.script?.applied, true);
  assert.equal(matched.cues[0]?.text, "这不就瓶普通矿泉水吗");
});

test("ink sits in the optical center of a rounded translucent pill", () => {
  const textWidth = 20;
  const textHeight = 20;
  const text = Buffer.alloc(textWidth * textHeight * 4);
  for (let y = 2; y < 8; y += 1) {
    for (let x = 5; x < 13; x += 1) {
      const index = (y * textWidth + x) * 4;
      text[index] = 255;
      text[index + 1] = 255;
      text[index + 2] = 255;
      text[index + 3] = 255;
    }
  }
  const pill = composePill({
    text,
    textWidth,
    textHeight,
    ink: { x: 5, y: 2, w: 8, h: 6 },
    fontSize: 20,
    background: BACKGROUND_COLOR,
    radiusFactor: 0.45,
    padXFactor: 0.25,
    padYFactor: 0.25,
  });
  let minX = pill.width;
  let minY = pill.height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < pill.height; y += 1) {
    for (let x = 0; x < pill.width; x += 1) {
      const index = (y * pill.width + x) * 4;
      if ((pill.rgba[index] ?? 0) > 200 && (pill.rgba[index + 3] ?? 0) > 200) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  assert.equal(minX, pill.width - 1 - maxX);
  assert.equal(minY, pill.height - 1 - maxY);
  const center = pill.rgba[((Math.floor(pill.height / 2) * pill.width) + Math.floor(pill.width / 2)) * 4 + 3] ?? 0;
  const corner = pill.rgba[3] ?? 0;
  assert.ok(center > 100, `center alpha ${center}`);
  assert.ok(corner < 20, `corner alpha ${corner}`);
  assert.ok(roundedCoverage(0, 0, pill.width, pill.height, 8) < roundedCoverage(pill.width / 2, pill.height / 2, pill.width, pill.height, 8));
  const png = encodePng(pill.rgba, pill.width, pill.height);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
});

test("subtitle wrap uses em width and the overlay graph escapes commas", () => {
  assert.equal(wrapSubtitle("你好世界啊", 10, 40), "你好世界\n啊");
  assert.equal(wrapSubtitle("hello", 10, 40), "hello");
  const graph = overlayGraph([{ x: 10, y: 20, start: 0.2, end: 1.5 }]);
  assert.match(graph, /between\(t\\,0\.200\\,1\.500\)/);
  assert.match(graph, /\[vout\]/);
  assert.match(overlayGraph([{ x: 1, y: 2, start: 0, end: 1 }], { even: true }), /scale=trunc\(iw\/2\)\*2:trunc\(ih\/2\)\*2/);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function asrFetch(subtitles: { start_time: number; end_time: number; subtitle_text: string }[], duration = 4): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (url.includes("request-media-upload-url")) {
      return jsonResponse({ success: true, result: { file_id: "file-1", upload_url: "https://upload.example/put" } });
    }
    if (init?.method === "PUT") return jsonResponse({ ok: true });
    if (url.includes("asr-subtitles")) {
      return jsonResponse({
        success: true,
        status: "completed",
        task_id: "task-asr",
        result: { duration, subtitles },
      });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
}

test("transcribe dry-run plans asr-subtitles and writes no caption file", async () => {
  await withDir(async (dir) => {
    const bind = capture();
    assert.equal(
      await run(
        ["providers", "set", "asr-subtitles", "--provider", "mediakit", "--base-url", "https://mediakit.example", "--api-key-env", "MEDIAKIT_ASR_KEY", "--group", "queue-1", "--project", dir],
        bind.io,
      ),
      0,
      bind.err(),
    );
    let called = false;
    const cap = capture({ MEDIAKIT_ASR_KEY: "secret-value" }, {
      fetch: async () => {
        called = true;
        throw new Error("dry-run must not fetch");
      },
    });
    assert.equal(await run(["captions", "transcribe", "--video", "refs/in.mp4", "--project", dir], cap.io), 0, cap.err());
    assert.equal(called, false);
    assert.match(cap.out(), /dry-run asr-subtitles/);
    assert.equal(cap.out().includes("secret-value"), false);
    const runName = (await readdir(path.join(dir, ".lumen", "runs")))[0] ?? "";
    const record = JSON.parse(await readFile(path.join(dir, ".lumen", "runs", runName, "record.json"), "utf8")) as {
      calls: { url: string; body: { kind: string; value?: { video_url?: string; queue_id?: string } } }[];
    };
    const body = JSON.stringify(record.calls);
    assert.match(body, /asr-subtitles/);
    assert.match(body, /request-media-upload-url/);
    assert.match(body, /mediakit:\/\/\{\{file_id\}\}/);
    assert.match(body, /queue-1/);
    assert.equal(body.includes("secret-value"), false);
    await assert.rejects(readFile(path.join(dir, "refs", "missing.captions.json"), "utf8"));
  });
});

test("execute clamps to the file duration and confirms a matching shot-list script", async () => {
  await withDir(async (dir) => {
    const bind = capture();
    assert.equal(
      await run(
        ["providers", "set", "asr-subtitles", "--provider", "mediakit", "--api-key-env", "MEDIAKIT_ASR_KEY", "--project", dir],
        bind.io,
      ),
      0,
      bind.err(),
    );
    const video = path.join(dir, "clip.mp4");
    await exec("/usr/bin/ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", video]);
    await writeFile(
      path.join(dir, "shotlist.md"),
      "| # | durationSec | frame | vo |\n| --- | --- | --- | --- |\n| 1 | 2 | a | 这不就瓶普通矿泉水吗 |\n",
    );
    const fetch = asrFetch([{ start_time: 0.2, end_time: 9, subtitle_text: "这不就瓶普通矿泉谁吗" }], 9);
    const loose = capture({ ...process.env, MEDIAKIT_ASR_KEY: "secret-value" }, { fetch });
    assert.equal(
      await run(["captions", "transcribe", "--video", "clip.mp4", "--no-script", "--execute", "--to", "refs/loose.json", "--project", dir], loose.io),
      0,
      loose.err(),
    );
    assert.match(loose.out(), /clamped: yes/);
    assert.match(loose.out(), /confirmed: no/);
    const looseDoc = JSON.parse(await readFile(path.join(dir, "refs", "loose.json"), "utf8")) as {
      duration: number;
      clamped: boolean;
      confirmed: boolean;
      cues: { end: number; text: string }[];
    };
    assert.ok(looseDoc.duration < 2.1);
    assert.equal(looseDoc.clamped, true);
    assert.equal(looseDoc.cues[0]?.text, "这不就瓶普通矿泉谁吗");
    assert.ok((looseDoc.cues[0]?.end ?? 99) <= looseDoc.duration + 0.001);
    const looseText = await readFile(path.join(dir, "refs", "loose.txt"), "utf8");
    assert.equal(looseText.includes("-->"), false);

    const matched = capture({ ...process.env, MEDIAKIT_ASR_KEY: "secret-value" }, { fetch });
    assert.equal(
      await run(["captions", "transcribe", "--video", "clip.mp4", "--execute", "--to", "refs/matched.json", "--project", dir], matched.io),
      0,
      matched.err(),
    );
    assert.match(matched.out(), /confirmed: yes/);
    assert.equal(matched.out().includes("secret-value"), false);
    const doc = JSON.parse(await readFile(path.join(dir, "refs", "matched.json"), "utf8")) as {
      confirmed: boolean;
      cues: { end: number; text: string }[];
      script: { applied: boolean; source: string };
      duration: number;
    };
    assert.equal(doc.confirmed, true);
    assert.equal(doc.script.applied, true);
    assert.equal(doc.script.source, "shotlist");
    assert.equal(doc.cues[0]?.text, "这不就瓶普通矿泉水吗");
    assert.ok((doc.cues[0]?.end ?? 99) <= doc.duration + 0.001);
  });
});

test("a loose video stays unconfirmed until burn is told to proceed", async () => {
  await withDir(async (dir) => {
    await mkdir(path.join(dir, "refs"), { recursive: true });
    const video = path.join(dir, "wide.mp4");
    await exec("/usr/bin/ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=640x360:d=1.2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", video]);
    const subs = path.join(dir, "refs", "loose.json");
    await writeFile(subs, `${JSON.stringify({
      format: "lumen.captions@1",
      confirmed: false,
      cues: [{ start: 0.2, end: 1, text: "哎这水喝着挺顺" }],
    })}\n`);
    const denied = capture();
    assert.equal(await run(["captions", "burn", "--video", "wide.mp4", "--subs", "refs/loose.json", "--to", "out.mp4", "--font", FONT, "--project", dir], denied.io), 1);
    assert.match(denied.err(), /not confirmed/);
    const planned = capture();
    assert.equal(
      await run(["captions", "burn", "--video", "wide.mp4", "--subs", "refs/loose.json", "--to", "out.mp4", "--font", FONT, "--confirm", "--dry-run", "--project", dir], planned.io),
      0,
      planned.err(),
    );
    assert.match(planned.out(), /planned: /);
    assert.match(planned.out(), /position: bottom_center/);
    assert.match(planned.out(), /fontSize: 14/);
    assert.equal(planned.out().includes("burned:"), false);
    await assert.rejects(readFile(path.join(dir, "out.mp4")));

    const portrait = path.join(dir, "tall.mp4");
    await exec("/usr/bin/ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=360x640:d=1.2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", portrait]);
    const burned = capture();
    assert.equal(
      await run(["captions", "burn", "--video", "tall.mp4", "--subs", "refs/loose.json", "--to", "tall-out.mp4", "--font", FONT, "--confirm", "--project", dir], burned.io),
      0,
      burned.err(),
    );
    assert.match(burned.out(), /position: top_center/);
    assert.match(burned.out(), /burned: /);
    const frame = path.join(dir, "frame.rgb");
    await exec("/usr/bin/ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-ss", "0.5", "-i", path.join(dir, "tall-out.mp4"), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", frame]);
    const raw = await readFile(frame);
    const width = 360;
    const height = 640;
    let topWhite = 0;
    let bottomWhite = 0;
    let minWhite = height;
    let maxWhite = 0;
    const pill: { x: number; y: number }[] = [];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 3;
        const r = raw[index] ?? 0;
        const g = raw[index + 1] ?? 0;
        const b = raw[index + 2] ?? 0;
        if (r > 220 && g > 220 && b > 220) {
          if (y < height * 0.45) topWhite += 1;
          if (y > height * 0.7) bottomWhite += 1;
          minWhite = Math.min(minWhite, y);
          maxWhite = Math.max(maxWhite, y);
        }
        if (r > 20 && r < 90 && Math.abs(r - g) < 20 && b > 120 && b < 220) pill.push({ x, y });
      }
    }
    assert.ok(topWhite > 10, `top white ${topWhite}`);
    assert.equal(bottomWhite, 0);
    assert.ok(minWhite > 40, `subtitle starts at ${minWhite}`);
    const pillYs = pill.map((pixel) => pixel.y);
    const pillTopY = Math.min(...pillYs);
    const pillBottom = Math.max(...pillYs);
    const inkMid = (minWhite + maxWhite) / 2;
    const boxMid = (pillTopY + pillBottom) / 2;
    assert.ok(Math.abs(inkMid - boxMid) <= 2, `ink ${inkMid} box ${boxMid}`);
    const corner = pill.find((pixel) => pixel.x === Math.min(...pill.map((item) => item.x)) && pixel.y === pillTopY);
    const inset = pill.find((pixel) => Math.abs(pixel.x - width / 2) < 4 && Math.abs(pixel.y - boxMid) < 4);
    assert.ok(corner === undefined || inset !== undefined);
  });
});

test("voice-synthesis text is the script when the shot list line is empty", async () => {
  await withDir(async (dir) => {
    await mkdir(path.join(dir, ".lumen", "runs", "run-voice"), { recursive: true });
    await writeFile(path.join(dir, "shotlist.md"), "| # | durationSec | frame | vo |\n| --- | --- | --- | --- |\n| 1 | 2 | a |  |\n");
    await writeFile(path.join(dir, ".lumen", "runs", "run-voice", "record.json"), `${JSON.stringify({
      time: "2026-01-01T00:00:00.000Z",
      command: ["fish", "synth", "--shot", "1"],
      modelId: "voice-synthesis",
      status: "ok",
      params: { text: "哎这水喝着挺顺" },
    })}\n`);
    const found = await discoverScript(dir);
    assert.equal(found?.source, "voice");
    assert.equal(found?.timed, true);
    assert.equal(found?.lines[0]?.text, "哎这水喝着挺顺");
    assert.equal(found?.lines[0]?.end, 2);
  });
});

test("captions are named in help and the skill points at both references", async () => {
  const help = capture();
  assert.equal(await run(["--help"], help.io), 0);
  assert.match(help.out(), /lumen captions transcribe/);
  assert.match(help.out(), /lumen captions burn/);
  assert.match(help.out(), /Runs immediately/);
  const skill = await readFile(path.join(root, "skills", "lumen", "SKILL.md"), "utf8");
  assert.match(skill, /references\/转字幕\/SKILL\.md/);
  assert.match(skill, /references\/加字幕\/SKILL\.md/);
  assert.match(skill, /lumen captions transcribe --video <file>/);
  assert.match(skill, /lumen captions burn --video <file> --subs <file> --to <mp4>/);
  assert.equal(skill.trim().split("\n").length <= 80, true);
  const transcribe = await readFile(path.join(root, "skills", "lumen", "references", "转字幕", "SKILL.md"), "utf8");
  const burn = await readFile(path.join(root, "skills", "lumen", "references", "加字幕", "SKILL.md"), "utf8");
  assert.match(transcribe, /--execute/);
  assert.match(transcribe, /confirmed/);
  assert.match(transcribe, /0\.55/);
  assert.match(burn, /立刻压制/);
  assert.match(burn, /top_center/);
  assert.match(burn, /317 \/ 2560/);
  assert.match(burn, /225 \/ 1440/);
  assert.match(burn, /0\.039/);
  assert.equal(/https?:\/\/|\/v1\//.test(transcribe + burn), false);
});
