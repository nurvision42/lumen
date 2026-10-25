import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { CliError } from "../errors.js";

const require = createRequire(import.meta.url);

/** PNG of a Feishu QR, under the lumen config directory. The path is what gets printed. */
export async function writeFeishuQr(home: string, kind: "app" | "user", text: string): Promise<string> {
  const qr = require("qrcode") as {
    toBuffer: (value: string, options: { type: "png"; errorCorrectionLevel: "M"; margin: number; width: number }) => Promise<Buffer>;
  };
  const dir = path.join(home, "library");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, kind === "app" ? "feishu-app-qr.png" : "feishu-user-qr.png");
  let png: Buffer;
  try {
    png = await qr.toBuffer(text, { type: "png", errorCorrectionLevel: "M", margin: 2, width: 560 });
  } catch {
    throw new CliError("Could not write the Feishu QR image");
  }
  await writeFile(file, png, { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}
