import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { findCjkFont } from "../sprite/layout.js";
import { execText } from "../tools/run.js";

const BOLD_FILES = [
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Bold.otf",
  "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
  "/System/Library/Fonts/PingFang.ttc",
  "C:\\Windows\\Fonts\\msyhbd.ttc",
  "C:\\Windows\\Fonts\\msyhbd.ttf",
];

async function readable(file: string): Promise<boolean> {
  try {
    await access(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Prefer a bold CJK face. The preset names Noto Sans CJK SC Bold; a regular face is the fallback. */
export async function findSubtitleFont(): Promise<string | undefined> {
  for (const file of BOLD_FILES) {
    if (await readable(file)) return file;
  }
  try {
    const { stdout } = await execText("fc-list", [":lang=zh", "file", "family", "style"], { timeout: 5000 });
    const rows = stdout.split(/\r?\n/).map((line) => {
      const file = line.split(":")[0]?.trim() ?? "";
      return { file, line };
    }).filter((row) => row.file.length > 0);
    const bold = rows.find((row) => /bold|black|heavy|粗/i.test(row.line) && /noto sans cjk sc|source han sans sc|noto sans sc/i.test(row.line));
    if (bold !== undefined) return bold.file;
    const anyBold = rows.find((row) => /bold|black|heavy|粗/i.test(row.line));
    if (anyBold !== undefined) return anyBold.file;
    const noto = rows.find((row) => /noto sans cjk sc|source han sans sc|wqy|micro hei|droid sans fallback/i.test(row.line));
    if (noto !== undefined) return noto.file;
  } catch {
    // fc-list is optional
  }
  return findCjkFont();
}
