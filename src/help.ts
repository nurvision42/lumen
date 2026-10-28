export function helpText(version: string): string {
  return `lumen ${version}
Thin chat-oriented video assistant. A project is a local folder.

Usage:
  lumen init [dir]
  lumen validate [--project dir]
  lumen models [model]
  lumen providers list|set|doctor
  lumen gen <image|video|voice> --model <id> [--shot N] [--dry-run|--execute|--mock]
  lumen fish <design|clone|synth> [--shot N]
  lumen breakdown [--video file]
  lumen download <douyin-url> --to <path> [--region <code>] [--json]
  lumen setup --key tikhub
  lumen setup ffmpeg
  lumen sprite --video <file> --to <image> [--every s|--frames n|--every-frame|--at t|--ranges json] [--columns n] [--rows n] [--cell px] [--transcript file] [--json]
  lumen cuts --video <file> [--sample-rate fps] [--threshold n] [--json]
  lumen captions transcribe --video <file> [--script <file>|--no-script] [--to <json>] [--srt <file>] [--ass <file>] [--language <code>] [--speaker] [--dry-run|--execute|--mock]
  lumen captions burn --video <file> --subs <file> --to <mp4> [--position top_center|bottom_center|center] [--font-size n] [--margin ratio] [--font <file>] [--confirm] [--dry-run] [--json]
  lumen enhance [--model enhance-video|enhance-video-generative] [--video file] [--shot N] [--out file] [--tool-version standard] [--scene aigc] [--resolution 1080p|2k|4k] [--fps 30] [--bitrate-level medium] [--enhance-style natural]
  lumen runs list|show <id>|resume <id>
  lumen concat [--project dir]
  lumen skill install [--target grokbot|agents|<path>] [--clean]
  lumen feishu setup|app|login|status|logout|scopes
  lumen feishu search <keyword>
  lumen feishu ls [folder]
  lumen feishu upload|download|mkdir|move|rm
  lumen feishu bitable|doc|sheet|wiki|comment|perm|board
  lumen doctor

Default mode is --dry-run: the audit records the request and nothing is sent.
--execute calls the bound provider. --mock uses a built-in fake transport and writes no media.

Backends, one binding per model (no family fallback):
  image    yunqiao (OpenAI-compatible) or grsai
  video    haomao, beeftv (seedance-2-fast) — Seedance. Polls the task, then saves the mp4. Not MediaKit.
           seedance-2.5 reference: --task-type auto|reference|edit|extend (omni_reference_task_type).
  voice    kitta at fishaudio.org
  download    douyin.com only. Saves a file for breakdown. No key on the command line.
              lumen setup --key tikhub stores it in the machine credential store, or set TIKHUB_API_KEY.
              Do not ask for the key in conversation. A missing key names the setup command.
  breakdown / enhance    MediaKit video-understand-router and enhance-video
                         breakdown sends prefer_models doubao-seed-2-1-lite-260915, level Quality, need_audio true
                         omitted --prompt sends the built-in 拉片 prompt; do not pass one
                         override with breakdown.preferModels, breakdown.level, or breakdown.needAudio
                         enhance defaults: tool_version standard, scene aigc, resolution 4k, fps 30, bitrate_level medium, enhance_style natural
                         enhance-video standard and professional accept resolution 1080p, 2k, 4k (default 4k)
                         enhance-video-generative accepts resolution 1080p, 2k (default 1080p), not 4k
                         scene is sent for standard only, unless --scene is set
                         local upload POST /api/v1/tools-sync/request-media-upload-url sends JSON {}
                         still running when polling ends stays running (exit 0); lumen runs resume <id> continues and saves the result
  captions transcribe   MediaKit asr-subtitles. Default --dry-run; --execute recognizes speech.
            Each cue end is clamped to the probed file duration. A shot-list voice-over or a
            finished voice run is aligned automatically when it matches; otherwise the JSON
            stays unconfirmed until burn --confirm. Bind asr-subtitles to mediakit.
  captions burn         Burns a confirmed JSON, or an SRT/ASS file, with ffmpeg. Runs immediately.
            --dry-run prints position, font size, and margin and does not write. Rounded
            translucent boxes are overlays, not ASS BorderStyle. Default: white on
            rgba(70,70,70,0.51); portrait top, landscape bottom; font size is the short side × 0.039.
  sprite    Contact sheet. ffmpeg extracts real frame times; sharp lays them out.
            Resolution is config (LUMEN_FFMPEG / LUMEN_FFPROBE or tools.ffmpeg / tools.ffprobe), then PATH, then the cache, then a hashed download.
            sharp loads a local install, then the cache, then an on-demand install. Neither is an npm dependency of lumen.
            lumen setup ffmpeg downloads the binaries ahead of time. Default rows are 3. Existing --to files are not overwritten.
  cuts      Scene-change candidates and scores. --sample-rate and --threshold adjust the scan.
  concat   ffmpeg → out/film.mp4 (stub; ffmpeg is not invoked yet)
  feishu   User-identity Feishu (Lark) drive, docs, sheets, bitable, and wiki.
           lumen feishu setup scans a page where the user creates an app or picks an existing one.
           That page is prefilled with the user scopes. Manual fallback: set FEISHU_APP_ID and
           FEISHU_APP_SECRET, then lumen feishu app. lumen feishu login stores a user access token
           (not a tenant token) in ~/.config/lumen/feishu with mode 600 and refreshes it.
           Data commands print JSON. Delete and link sharing require --yes.
           Callback login redirect: http://127.0.0.1:9753/callback
           Does not call lark-cli. Read skills/lumen/references/飞书/SKILL.md.

Install (user directory, no sudo):
  bash scripts/install.sh
  bash scripts/install.sh --uninstall
  npm install -g --prefix ~/.local --install-links .
  With nvm: npm install -g --install-links .
  Script: program ~/.local/share/lumen, command ~/.local/bin/lumen.
  npm prefix: package ~/.local/lib/node_modules/@nurvision/lumen, command ~/.local/bin/lumen.
  Without --install-links, installing a folder only links that checkout.
  Config ~/.config/lumen (or $XDG_CONFIG_HOME/lumen). Cache ~/.cache/lumen (or $XDG_CACHE_HOME/lumen).
  --path writes the shell rc. Otherwise a terminal asks first. A non-interactive run leaves the rc unchanged.

Skill (one directory):
  lumen skill install [--target grokbot|agents|<path>] [--clean]
  LUMEN_SKILL_DIR, then --target, then auto-detect.
  Auto-detect writes /home/box/agent-data/workflows/lumen when that workflows directory exists and is writable.
  Otherwise it writes ~/.agents/skills/lumen. One directory receives the skill.
  npm postinstall installs that directory after npm install or npm install -g, and writes .lumen-version.
  A failed skill install prints one stderr line and does not fail npm.
  Each run installs or updates when the skill is missing or older than this CLI, and prints one line.
  LUMEN_NO_SKILL_AUTOINSTALL=1 skips the postinstall and that check. --clean removes only the other lumen directory.
  .lumen-version in that directory records the CLI version.

Config:
  lumen.config.json in the project, merged over ~/.config/lumen/providers.json
  models.<id>.{ provider, apiKeyEnv, baseUrl?, group?, modelAlias? }  (baseUrl defaults to the provider's official API)

Exit 0 on success, 1 on a bad project or request, 2 on usage.`;
}
