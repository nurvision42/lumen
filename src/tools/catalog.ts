import { CliError } from "../errors.js";

/** Release shipped by the ffmpeg-static project. The npm package is not a dependency. */
export const FFMPEG_RELEASE = "b6.1.1";

export const FFMPEG_BASE = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_RELEASE}`;

/**
 * SHA-256 of the uncompressed executable.
 * The gzip payload from the release is inflated, then this hash is checked.
 */
export const FFMPEG_SHA256: Record<string, string> = {
  "ffmpeg-darwin-arm64": "a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584",
  "ffmpeg-darwin-x64": "ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894",
  "ffmpeg-linux-arm": "0afba4a11110e6e402053e0fc14c33a7eb207d7a588688ae87dba471a0f06c71",
  "ffmpeg-linux-arm64": "6bb182d0d75d23028db82e9e4f723ca69b853d055698486e6984ddb2c06fb8ce",
  "ffmpeg-linux-ia32": "c6472eb993612db72ca50893a34137ba11173e60a1a4c028d4660a3f755d2490",
  "ffmpeg-linux-x64": "e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99",
  "ffmpeg-win32-x64": "04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00",
  "ffprobe-darwin-arm64": "bb2db6f5d8cef919da12fbf592119a987202a8c060a886f3cab091f9cab90b64",
  "ffprobe-darwin-x64": "fa3add0ce901f7241abe0dfc0155d958fc834aca3f8ce61f87cc712ae669c1e0",
  "ffprobe-linux-arm": "e61ef24870ddc3b80aa8b435512a545bd889e4ed4c2fc7c885f7d3dabad2a53f",
  "ffprobe-linux-arm64": "d17ae9b4c297d48e2521ba14e417bb0537c6ff77c584cdbcd6bb0d8d0307a2e8",
  "ffprobe-linux-ia32": "a13b4cce0a4b9bd6714672e4df81076ec06f4c295d798162d48e3de68c781d6d",
  "ffprobe-linux-x64": "4f231a1960d83e403d08f7971e271707bec278a9ae18e21b8b5b03186668450d",
  "ffprobe-win32-x64": "3a7e2dc003dc2cd1472827e4c7c4f056ae1ae0ae7c5bbc580c99b49827351ba4",
};

/** Pinned addon. Installed into the cache on demand, never as an install dependency. */
export const SHARP_VERSION = "0.35.5";

/** Registry dist.integrity for the sharp tarball. Native builds are checked by sharp itself. */
export const SHARP_INTEGRITY = "sha512-Ywn4OnzGukp7CDMrp08RQ50YKmuwG47brZgIVPTvBaaAfQlRlygrRqSrxdCiL9M+LlzLBiJ68IR1QqvzHyjC7g==";

export function platformId(platform = process.platform, arch = process.arch): string {
  return `${platform}-${arch}`;
}

export function binaryAsset(
  tool: "ffmpeg" | "ffprobe",
  platform = platformId(),
): { url: string; sha256: string; filename: string } {
  const key = `${tool}-${platform}`;
  const sha256 = FFMPEG_SHA256[key];
  if (sha256 === undefined) {
    const envName = tool === "ffmpeg" ? "LUMEN_FFMPEG" : "LUMEN_FFPROBE";
    throw new CliError(`no ${tool} binary for ${platform}; set ${envName} or install ${tool} on PATH`);
  }
  return {
    url: `${FFMPEG_BASE}/${key}.gz`,
    sha256,
    filename: platform.startsWith("win32") ? `${tool}.exe` : tool,
  };
}
