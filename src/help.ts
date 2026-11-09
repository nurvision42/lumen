export function helpText(version: string): string {
  return `lumen ${version}
Thin chat-oriented video assistant. A project is a local folder.

Usage:
  lumen init [dir]
  lumen validate [--project dir]
  lumen models [model]
  lumen providers list|set|doctor
  lumen gen <image|video|voice> --model <id> [--shot N] [--dry-run|--execute|--mock] [--detach]
  lumen fish <design|clone|synth> [--shot N]
  lumen breakdown [--video file] [--prefer-endpoint <id>]
  lumen download <douyin-url> --to <path> [--region <code>] [--json]
  lumen setup --key tikhub
  lumen setup ffmpeg
  lumen sprite --video <file> --to <image> [--every s|--frames n|--every-frame|--at t|--ranges json] [--columns n] [--rows n] [--cell px] [--transcript file] [--json]
  lumen cuts --video <file> [--sample-rate fps] [--threshold n] [--json]
  lumen captions transcribe --video <file> [--engine seed|mediakit] [--to <json>] [--srt <file>] [--ass <file>] [--language <code>] [--speaker] [--dry-run|--execute|--mock]
  lumen captions burn --video <file> --subs <file> --to <mp4> [--position top_center|bottom_center|center] [--font-size n] [--margin ratio] [--font <file>] [--confirm] [--dry-run] [--json]
  lumen enhance [--video file] [--shot N] [--out file] [--dry-run|--execute|--mock] [--detach]
  lumen runs list [--pending]|show <id>|wait <id> [--timeout 秒]|resume <id> [--task <id>] [--out file] [--execute --detach]
  lumen concat [--project dir]
  lumen skill install [--target grokbot|agents|<path>] [--clean]
  lumen doctor

Default mode is --dry-run: the audit records the request and nothing is sent.
--execute calls the bound provider. --mock uses a built-in fake transport and writes no media.
Image and video prompts: 提示词用中文写. Do not translate a prompt into English.

Backends, one binding per model (no family fallback):
  image    yunqiao (OpenAI-compatible), grsai, volcark (火山方舟 Ark), or beeftv
           Seedream 5.0 Pro doubao-seedream-5-0-pro-260628 (alias seedream-5-pro)
           and Flash doubao-seedream-5-0-flash-260915 (alias seedream-5-flash).
           Default provider beeftv, also volcark. Default resolution 2K.
           beeftv: POST /v1/images/generations. Wire ids dola-seedream-5-0-pro-260628
           and dola-seedream-5-0-flash-260915 unless --model-alias is set.
           Reference field is images (https or data URI). Local files use the BeefTV upload.
           Estimate: Flash 0.04 yuan/image, refs free. Pro ≤2.61M px 0.09, above (2K) 0.18.
           Pro refs: first free, each later one under 0.01 yuan. No layer estimate.
           volcark: POST /images/generations, Authorization: Bearer ARK_API_KEY.
           A missing key fails in Chinese and names ARK_API_KEY.
           Local files are read and sent as data:image/...;base64,... . Volcark does not upload them.
           volcark estimate: Pro ≤1.5K 0.30 yuan/image, Pro 2K 0.60, Flash 0.12.
           Sizes 1K, 1.5K, 2K. watermark is sent false. response_format url, output_format png.
           One image. No sequential_image_generation (Pro and Flash do not support group images).
  video    haomao; beeftv (seedance-2-fast); ycyapi (seedance-2.5) — Seedance. Polls the task, then saves the mp4. Not MediaKit.
           seedance-2.5 on haomao: --task-type auto|reference|edit|extend (omni_reference_task_type).
           ycyapi: HTTPS or local refs (local files require a tos block and VOLC_ACCESSKEY / VOLC_SECRETKEY); no first/last frame, Auto/task-type, adaptive, or 4K.
  voice    kitta at fishaudio.org
  download    douyin.com only. Saves a file for breakdown. No key on the command line.
              lumen setup --key tikhub stores it in the machine credential store, or set TIKHUB_API_KEY.
              Do not ask for the key in conversation. A missing key names the setup command.
              --region <code> is sent only when that flag is passed.
  breakdown / enhance    MediaKit video-understand-router and enhance-video-generative
                         breakdown sends prefer_models doubao-seed-2-1-pro-260915, doubao-seed-2-0-lite-260428, level Quality, need_audio true
                         omitted --prompt sends the built-in 拉片 prompt; do not pass one
                         prefer_endpoints: repeatable --prefer-endpoint, else LUMEN_MEDIAKIT_ENDPOINTS, else breakdown.preferEndpoints
                         omit prefer_endpoints when that list is empty. doubao-seed-2-1-lite-260915 cannot do audio
                         status_code 11100 with need_audio asks for an Ark endpoint for doubao-seed-2-0-lite or mini
                         override with breakdown.preferModels, breakdown.level, breakdown.needAudio, or breakdown.preferEndpoints
                         enhance is only enhance-video-generative at 2k and 30 fps. No model, resolution,
                         fps, tool-version, scene, bitrate, or style flag.
                         Before submit, prints a cost estimate at 10 yuan/min (large-model 2K ≤30fps).
                         After an https mp4 downloads, lumen adds monochrome film grain at strength 0.4
                         (half-resolution grain, output bitrate matched to that file, audio copied).
                         There is no separate grain command. Do not add grain again.
                         local upload POST /api/v1/tools-sync/request-media-upload-url sends JSON {}
                         still running when polling ends stays running (exit 0); lumen runs resume <id> continues and saves the result
  captions transcribe   Default engine is seed-asr (Doubao Seed ASR 2.0, volc.seedasr.auc,
            model_name bigmodel) on openspeech. Bind seed-asr with DOUBAO_SPEECH_API_KEY.
            Local video audio is extracted and uploaded through the configured TOS bucket.
            Word timings are the only clock. A gap over 0.2s starts a new cue; 40ms gaps
            stay together. Cue text is the words, without commas or periods. Raw words
            are kept. --engine mediakit uses asr-subtitles and does not run unless asked.
            There is no silent fallback. --script is rejected. --no-script is unnecessary.
            Project shot lists and voice runs are not read. Ends are clamped to the file.
  captions burn         Burns the supplied JSON, SRT, or ASS with ffmpeg. Runs immediately.
            Uses that file's text and times and does not compare or rewrite them.
            --speech and --speech-file are rejected. An unconfirmed lumen.captions JSON
            needs --confirm. SRT and ASS are treated as already confirmed.
            --dry-run prints position, font size, and margin and does not write. Rounded
            translucent boxes are overlays, not ASS BorderStyle. Default: white on
            rgba(70,70,70,0.51); portrait top, landscape bottom; font size is the short side × 0.039.
  sprite    Contact sheet. ffmpeg extracts real frame times; sharp lays them out.
            Resolution is config (LUMEN_FFMPEG / LUMEN_FFPROBE or tools.ffmpeg / tools.ffprobe), then PATH, then the cache, then a hashed download.
            sharp loads a local install, then the cache, then an on-demand install. Neither is an npm dependency of lumen.
            lumen setup ffmpeg downloads the binaries ahead of time. Default rows are 3. Existing --to files are not overwritten.
  cuts      Scene-change candidates and scores. --sample-rate and --threshold adjust the scan.
  concat   ffmpeg → out/film.mp4 (stub; ffmpeg is not invoked yet)

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

Exit 0 on success, 1 on a bad project or request, 2 on usage, 3 when \`lumen runs wait\` times out and the run is still going.

后台生成（助手照这个跑，不要前台死等 --execute）:
  出图、出视频、增强，以及续跑，一律加 --detach --execute。
  例如 lumen gen image --model <id> --prompt <中文> --execute --detach
       lumen gen video --model <id> ... --execute --detach
       lumen enhance --video <file> --execute --detach
       lumen runs resume <id> --execute --detach
  --detach 先做本地校验、打印预估、写好 run，再派生脱离终端的子进程去提交、轮询、下载、后处理（增强会加颗粒）。
  父进程马上打印 run id 和「下一步: lumen runs wait <id>」，退出码 0。子进程不跟父进程一起退出，终端关掉也不停。
  日志在 run 目录的 worker.log。pid 写在 run 记录里。
  接着在同一轮里循环 lumen runs wait <id> --timeout 60。两次之间可以先回用户一句进度。
  wait 只读记录，不提交、不扣费。杀掉 wait 不影响生成。
  wait 退出码：0 完成，打印 wrote: 路径（和前台一样）；3 仍在生成；1 失败，stderr 是原因。
  用户发来新消息把这一轮打断后：先回用户，再 lumen runs list --pending。
  有未取走的就继续 wait，把结果发给用户。不要重新提交。
  不要用 nohup、& 或 pkill -f 自己管后台。要停任务，用记录里的 pid。
  list --pending 列出未完成，或已完成但还没被 wait/show 取走的 run（状态、模型、开始时间、id）。取走后标「已取走」。
  pid 已不在、状态仍是 pending 或 running：已中断。runs show 会说明有没有出图。
  有服务端任务 id 就 lumen runs resume <id>（同一个任务，不重新提交）。
  出图若只拿到结果 URL，resume 只下载该 URL。没有任务 id 也没有结果 URL，就不能 resume，不要重提。
  --mock --detach 只走内置假传输，给本地测试用，不访问供应商。`;
}
