# LUMEN / lumen

lumen 是一个面向对话的本地视频助手。一个项目就是一个文件夹。命令行名是 `lumen`。

它把镜头表、参考片、生成请求和审计记在项目里。每个模型单独绑定供应商、地址和密钥环境变量，没有“按厂商家族回退”。

## 项目布局

```
shotlist.md 或 shotlist.json     只有四列：# | durationSec | frame | vo
lumen.config.json            本项目的模型绑定（可缺）
refs/                            参考片、拆解结果
shots/NN/frame|clip|vo/          按镜头号存放生成物
out/                             不指定镜头时的输出
.lumen/runs/<id>/            每次生成的完整审计
```

镜头号至少两位：`1` → `shots/01`，`100` → `shots/100`。

## 安装

默认装进用户目录，不写系统目录，不需要 sudo。需要 Node.js 20 或更新。macOS 和 Linux：

```bash
bash scripts/install.sh
```

程序在 `~/.local/share/lumen`（`$XDG_DATA_HOME` 在用户目录里时用 `$XDG_DATA_HOME/lumen`）。命令在 `~/.local/bin/lumen`。已经装过就覆盖升级。配置仍在 `~/.config/lumen`（或 `$XDG_CONFIG_HOME/lumen`）。按需下载的 ffmpeg、ffprobe、sharp 在 `~/.cache/lumen`（或 `$XDG_CACHE_HOME/lumen`）。

`~/.local/bin` 不在 PATH 时，脚本打印要加的一行。交互终端会先问；`--path` 才写入 shell rc（zsh 写 `~/.zshrc`，bash 写 `~/.bashrc`，也可以 `--rc <file>`）；`--no-path` 不改。没有终端时不改 rc。

```bash
bash scripts/install.sh --path
bash scripts/install.sh --uninstall
```

卸载只删除程序目录和指向它的 `~/.local/bin/lumen`，配置和缓存留下。

用 npm 时也放在用户目录，不要用 sudo：

```bash
npm install -g --prefix "$HOME/.local" --install-links .
```

这一步把包装进 `~/.local/lib/node_modules/@nurvision/lumen`，命令在 `~/.local/bin/lumen`。`--install-links` 复制一份，而不是链回源码目录。nvm 的全局目录已经在用户目录下，用 `npm install -g --install-links .`。

技能说明随包发布，运行时再复制到一个目录。`LUMEN_SKILL_DIR` 优先于 `--target`，否则自动检测：`/home/box/agent-data/workflows` 存在且可写时用 `workflows/lumen/`（Grok Bot 读该目录下每个子目录的 `SKILL.md`），否则用 `~/.agents/skills/lumen/`。只写这一处。`LUMEN_WORKFLOWS_DIR` 可改检测用的 workflows 目录。

```bash
lumen skill install
lumen skill install --target grokbot
lumen skill install --target agents
lumen skill install --target /path/to/lumen --clean
```

重复安装覆盖同一份，并把 CLI 版本写入该目录的 `.lumen-version`。另一个候选目录里已有 lumen 时会提示；`--clean` 只删那个 lumen 目录，其他 skill 不动。`npm install` 和 `npm install -g` 的 postinstall 用同一套检测，装到这一处（覆盖并写 `.lumen-version`）。技能装不上时只在 stderr 打一行，npm 安装仍然成功。这一行在本仓库的 `npm install` 里能看到；`npm install -g` 默认不回显成功脚本的输出，加上 `--foreground-scripts` 才能看到。每次运行 lumen 还会做一次轻量检查：技能缺失或版本低于 CLI 时自动安装或更新到检测到的那一处，并打一行提示。`LUMEN_NO_SKILL_AUTOINSTALL=1` 同时关掉 postinstall 和这次运行时检查。

## 本地运行

需要 Node.js 20 或更新。

```bash
npm install
npm test
npm run build
node dist/cli.js --help
node dist/cli.js init ./demo
```

开发时也可以不打包：

```bash
npx tsx src/cli.ts doctor --project ./demo
```

发布包带上技能说明：`package.json` 的 `files` 包含 `skills`，所以 `skills/lumen/SKILL.md` 和 `skills/lumen/references/` 会进 tarball。`npm pack --dry-run` 可以核对这份清单。

默认是 `--dry-run`：把将要发出的请求写入审计，不访问网络，也不写媒体文件。`--execute` 才真正调用。`--mock` 使用内置假传输，只留审计，不写 mp4。

退出码：`0` 成功或 dry-run，`1` 项目、校验、缺密钥或上游失败，`2` 用法错误。用法错误（例如缺少 `--model`、未知参数）不写审计。

## 命令

```text
lumen init [dir]
lumen validate
lumen models [id]
lumen providers list|set|doctor
lumen gen image|video|voice --model <id>
lumen fish design|clone|synth
lumen breakdown [--video file]
lumen download <douyin-url> --to <path> [--region <code>] [--json]
lumen setup --key tikhub
lumen setup ffmpeg
lumen sprite --video <file> --to <image>
lumen cuts --video <file>
lumen enhance [--video file] [--shot N] [--out file]
lumen runs list|show <id>
lumen concat
lumen library status|list|find|add|connect feishu
lumen skill install [--target grokbot|agents|<path>] [--clean]
lumen doctor
```

`lumen sprite` 用 ffmpeg 按真实时间戳抽帧，再用 sharp 排成多宫格。`--every`、`--frames`、`--every-frame`、`--at`、`--ranges` 选帧；不选时优先用拆解结果（每镜抽头、中、尾，超过 3 秒再按每秒 1 张补），没有拆解就做场景切点，再没有就按 1 秒间隔。`--rows` 默认 3，用来分页。`--transcript <file>` 在格子下加台词。只写 `--to`，不覆盖已有文件。`lumen cuts` 只输出切点时间和分数。ffmpeg / ffprobe 的查找顺序是显式路径（`LUMEN_FFMPEG`、`LUMEN_FFPROBE` 或配置里的 `tools.ffmpeg` / `tools.ffprobe`）、PATH、缓存、按平台下载并校验哈希。sharp 先加载本机已经装好的模块，没有再装进缓存。这些都不进 `dependencies`，`npm install` 不会下载它们。`lumen setup ffmpeg` 可以提前准备二进制。`lumen doctor` 打印三者的路径、版本和来源（`config`、`path`、`cache`、`download`；sharp 的本机模块来源是 `module`），找不到就是 `missing`，doctor 本身不下载。细则见 `skills/lumen/references/雪碧图/SKILL.md`。

`lumen download` 只保存 `douyin.com` 链接（含短链）到 `--to` 指定的新文件，不覆盖已有文件。它立刻下载，不走 dry-run，也不把密钥或视频直链写进审计。密钥不能写在命令行上。安装后由用户自己运行 `lumen setup --key tikhub`：终端不回显，写入本机凭据库（`~/.config/lumen/credentials/` 或 `$XDG_CONFIG_HOME/lumen/credentials/`），不进项目、不打印。也可以由用户自己设置 `TIKHUB_API_KEY`。缺密钥时，错误信息会写出要运行的 `lumen setup --key tikhub`。不要在对话里向用户要密钥。保存后的文件可以交给 `lumen breakdown --video <该文件>`，拆解不要再传 prompt。细则见 `skills/lumen/references/视频下载/SKILL.md`。

`lumen library` 把可复用的人物、音色和供应商编号放在用户自己的飞书多维表格里。默认 `lumen library connect feishu` 把飞书授权二维码写成 PNG，并打印 `qr:` 路径。把图片发到对话里，用户用飞书手机扫。手机上可以新建应用或绑定已有应用，不必填写 App ID 或 App Secret。然后再登录，并选择或新建 Base。不打开浏览器。没选素材库时，生成命令照常。密钥不打印。用法见 `skills/lumen/references/素材库/SKILL.md`。

`fish design|clone|synth` 分别等价于 `gen voice --model voice-design-1|voice-clone|voice-synthesis`。

`--shot N` 时，图像和视频在省略提示词时使用该镜头的 `frame`，语音在省略 `--text` 时使用 `vo`（音色设计除外）。输出落在 `shots/NN/` 下对应目录；不指定镜头则落在 `out/`。

## 模型与供应商

内置供应商：图像 `yunqiao`（云桥）和 `grsai`，Seedance `haomao`（好猫），语音 `kitta`（fishaudio.org），拆解和增强 `mediakit`。同一个供应商可以给不同模型配不同的密钥。没有绑定就是错误 `no provider binding for <id>`，不会改用另一个模型。

| 模型 | 可用供应商 |
| --- | --- |
| `gpt-image-2`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst` | yunqiao、grsai |
| `seedance-2`、`seedance-2-fast`、`seedance-2-mini`、`seedance-2.5` | haomao |
| `voice-design-1`、`voice-clone`、`voice-synthesis` | kitta |
| `video-understand-router`、`enhance-video-generative` | mediakit |

`baseUrl` 必须写进绑定，没有静默默认地址。yunqiao 含 `/v1`。grsai 是源站（路径 `/v1/images/generations`）。haomao 含版本前缀，lumen 再接 `/contents/generations/tasks`。kitta 是源站，例如 `https://fishaudio.org`。mediakit 是源站。

分组：

- yunqiao：`group` 只放在 `X-Group` 头，不写进 JSON。
- mediakit：`group` 是请求体里的 `queue_id`。
- grsai、haomao、kitta：不发送 `group`。

`modelAlias` 替换上游模型字符串。缺省就是 lumen 的模型 id。kitta 的语音合成把 `modelAlias` 放进 JSON 的 `modelId`；不设就不传。

### 图像

出图先读 `skills/lumen/references/gpt-image/SKILL.md`（模型、比例、质量、背景、参考图和提交），再读 `skills/lumen/references/gpt-image-提示词写法/SKILL.md`。本节的比例、分辨率、背景和质量是命令参数，不写进提示词。要写设备、镜头、光、色或运镜时再读 `skills/lumen/references/拍摄设定/SKILL.md`。

`gpt-image-2` 提示词最长 20000。比例：`auto`、`1:1`、`3:2`、`2:3`、`4:3`、`3:4`、`16:9`、`9:16`、`2:1`、`1:2`、`3:1`、`1:3`、`21:9`、`9:21`、`5:4`、`4:5`。分辨率 `1K`、`2K`、`4K`，三支模型同一套映射。背景 `transparent|opaque|auto` 可选。参考图最多 16 张。不传质量时 `gpt-image-2` 发出 `high`，两支 2.5 发出 `max`。lumen 不发送 `output_format`，也没有这个旗标。返回的字节原样写到默认的 `.png` 路径，不转码。

没有参考图时，yunqiao 是 `POST {base}/images/generations`，grsai 是 `POST {base}/v1/images/generations`。尺寸由比例和分辨率映射，边长对齐 16，并落在官方像素和比例限制内。`yunqiao` 不接受 `4K`（接受 `1K`、`2K`）；`grsai` 接受三档。这是供应商限制，模型映射仍会算出 `4K`。

有参考图时走编辑。yunqiao 是 OpenAI 式 multipart `images/edits`，执行时要本地文件。grsai 仍是 JSON `images/generations`，参考图放在 `image` 数组里，执行时要 `https://` URL。两者都是同步的：返回图片字节或 URL 就保存。`flare` 和 `sunburst` 是模型 id `gpt-image-2.5-flare` 与 `gpt-image-2.5-sunburst`。

### Seedance

形态是 `text`、`frame`、`reference`。提示词上限 20000，`seedance-2.5` 是 30000。生成前先读使用说明：`seedance-2`、`seedance-2-fast`、`seedance-2-mini` 读 `skills/lumen/references/seedance-2/SKILL.md`，`seedance-2.5` 读 `skills/lumen/references/seedance-2.5/SKILL.md`。写提示词再读 `skills/lumen/references/seedance-提示词写法/SKILL.md`。图像和视频要写设备、镜头、光、色或运镜时读 `skills/lumen/references/拍摄设定/SKILL.md`。提交只带提示词正文里点到的素材。

参考上限：图像 9/30、视频 3/10、音频 3/10（斜线后是 2.5）。每张图和每段视频都要 `person-reference`（`image|url|true`），音频不写。拒绝 `.m4a` 和音频 `.mp4`。非 2.5 的音频必须同时有图像或视频，并且参考总数不超过 12。不能混用首尾帧和参考。尾帧必须有首帧。`web-search` 只在 `text`，而且 haomao 不接受它。时长 4–15；2.5 是 `-1` 或 4–30。分辨率：`seedance-2` 为 480p/720p/1080p/4k，2.5 为 480p/720p/1080p，fast/mini 为 480p/720p。比例 `1:1`、`4:3`、`3:4`、`16:9`、`9:16`、`21:9`、`adaptive`。默认 720p、`9:16`、`generateAudio false`。haomao 上的 `seedance-2.5` 帧模式只能用 `adaptive`。

haomao：`POST {base}/contents/generations/tasks`。`content` 是 text、image_url（first_frame / last_frame / reference_image）、video_url、audio_url，再加上 `resolution`、`ratio`、`duration`、`generate_audio`。`seedance-2.5` 的参考形态再带官方字段 `omni_reference_task_type`。person-reference 只留在审计参数里，不进正文。执行时不上传本地素材，请传 `https://` URL。

#### Seedance 2.5 全模态子任务

文生、首帧、首尾帧仍是 `text` 和 `frame`。全模态的三类子任务都落在参考形态 `reference`（`ReferenceVideo`）上，用 `--task-type` 指定，不另起第四种形态。

官方字段是 `omni_reference_task_type`，取值 `auto`、`reference`、`edit`、`extend`。不传时审计参数记 `auto`，并且 `omniTaskTypeSpecified` 为 false。haomao 的任务正文会把这个值写进去，包括默认的 `auto`。

| `--task-type` | 本地立即校验 | 提示词（方舟仍可能异步核对） |
| --- | --- | --- |
| `reference` | 无额外的比例或时长限制 | 普通参考生 |
| `edit` | 至少一段 `video` 参考、`aspect-ratio adaptive`、`duration -1` | 至少一个：编辑视频、增加/加上、删除/去掉、修改/替换/改成。参考视频时长须为 4–30 秒，lumen 不在本地量这段时长 |
| `extend` | 至少一段 `video` 参考、`aspect-ratio adaptive`。时长仍是 2.5 的 `-1` 或 4–30，不强制 `-1` | 向前/向后延长、延续、续写 |
| 省略，即 `auto` | 不按 edit/extend 的限制拦截 | 模型可能事后判成 edit 或 extend，参数不合会异步失败 |

只写 `duration -1` 和 `aspect-ratio adaptive` 不能区分 edit 和 extend。要显式传 `--task-type`，校验才会在提交前完成。

```bash
lumen gen video --model seedance-2.5 --shape reference \
  --task-type edit \
  --prompt "删除视频里的路人，改成空镜" \
  --duration -1 --aspect-ratio adaptive \
  --ref "video|https://cdn.example/src.mp4|false"

lumen gen video --model 2.5 --shape ReferenceVideo \
  --task-type extend \
  --prompt "向后延长，角色继续往前走" \
  --duration 6 --aspect-ratio adaptive \
  --ref "video|https://cdn.example/src.mp4|true"
```

模型别名：`standard` → `seedance-2`，`fast` → `seedance-2-fast`，`mini` → `seedance-2-mini`，`2.5` → `seedance-2.5`。形态别名：`TextVideo` / `text-video`、`FrameVideo` / `frame-video`、`ReferenceVideo` / `reference-video`，都会收成 `text`、`frame`、`reference`。

dry-run 可以记下本地路径，并在计划里留下占位轮询：`GET /contents/generations/tasks/{{task_id}}` 和视频 URL。`--execute` 和 `--mock` 只走真实状态机，不请求这些占位符。

执行会轮询到结束，而不是只提交。提交后 `GET {base}/contents/generations/tasks/{id}`，直到 `succeeded`。任务 id 读 `id` 或 `task_id`。排队态是 `queued`、`running`、`pending`。`failed`、`canceled`、`cancelled`、`expired` 以及不认识的状态都算失败。视频 URL 来自 `content.video_url`。提交响应已经是终态时不再多打一次状态。然后不带 Authorization 下载 https 视频，写成 mp4，旁边写一份查询串已打码的 `.seedance.json`。没有 https 视频 URL 就失败，审计里保留已经发出的调用。`--mock` 和 dry-run 不写媒体文件。

间隔默认 10000 毫秒（`SEEDANCE_POLL_MS`），次数默认 180（`SEEDANCE_MAX_POLLS`）。只在两次轮询之间等待。

### Kitta

官方站点 `https://fishaudio.org`。

- 设计：`POST /api/open/v1/voice-designs`，头 `Idempotency-Key`，正文 `prompt`（来自 `--instruction`，1–2000）、`providers: ["fishaudio"]`，以及可选 `previewText`（≤150，来自 `--text`）。执行时再 `GET /api/open/v1/voice-designs/{designId}/candidates/{candidateId}/audio`，这步带 Bearer。
- 克隆：声音像文件时先 `POST /api/open/v1/voices` multipart：`name`、`audioFiles`、`referenceText`。`referenceText` 用同一句 `--text`。再用返回的 `voiceId` 做 `POST /api/open/v3/speech/tts`。声音已是 id 时只做 TTS。执行时样本必须是本地文件。
- 合成：`POST /api/open/v3/speech/tts`，正文 `text`、`voiceId`、`format: mp3`。设置了 `modelAlias` 才加 `modelId`。

### MediaKit 拆解与增强

拆解和增强共用一套上传、提交、轮询，但密钥按模型分开绑。

1. `POST /api/v1/tools-sync/request-media-upload-url`，空正文。
2. 按返回的 `upload_url` 和 `upload_headers` 用 PUT 上传原始字节，不是 multipart。
3. `file_id` 已带 `mediakit://` 就原样使用，否则补上这个前缀。`http`、`https`、`mediakit`、`vod`、`tos` 输入跳过上传。
4. 提交工具，然后 `GET /api/v1/tasks/{task_id}`，直到 `completed|succeeded|success`，或 `failed|error|canceled`。
5. 鉴权是 `Bearer`。`client_token` 是本次 run id。

轮询次数默认 90（`MEDIAKIT_MAX_POLLS`），间隔默认 2000 毫秒（`MEDIAKIT_POLL_MS`）。

`lumen breakdown` 调用 `video-understand-router`，`scene` 固定为 `editing`，不能改。正文默认是 `level: "Quality"`（最高）、`prefer_models: ["doubao-seed-2-1-lite-260915"]`、`manual_option: { "need_audio": true }`，不带 `prefer_endpoints`。调用方不要再选模型、档位或是否要音频。要换时写 `breakdown.preferModels`（非空数组，整表替换）、`breakdown.level`、`breakdown.needAudio`：项目 `lumen.config.json` 盖过全局 `~/.config/lumen/providers.json`。`needAudio: false` 会关掉音频。只含 lite 的自定义 endpoint 会失败，所以这里不发 `prefer_endpoints`。

不传 `--prompt` 时，拆解发送内置拉片表提示词。调用时不要再传这段，也不要另写提示词。显式 `--prompt`、`--prompt-file`，或配置里非空的 `breakdown.prompt` / `breakdown.promptFile`，才替换它。视频来自 `--video`，或 `refs/` 里恰好一个 `mp4|mov|mkv|webm|avi|m4v`。

```text
请对这个视频做逐镜头拉片分析，不要生成任何创作/生成用提示词。
按镜头输出表格，字段：
镜头序号｜起止时间码｜时长(秒)｜概述｜叙事作用｜景别｜画面元素｜镜头运动｜转场/剪辑｜字幕/台词｜声音/音乐｜情绪/节奏｜视觉风格｜备注/置信度
口径：
- 概述：只写画面事实和主要动作，不写长篇评论。
- 叙事作用：说明该镜头在注意力、信息推进、情绪、信任、卖点展示、转场中的作用。
- 景别：远景/全景/中景/中近景/近景/特写/大特写/屏幕录制/混合 选一。
- 镜头运动：固定、推近、拉远、横移、跟拍、环绕、摇镜、快速切换、屏幕滚动等。
- 转场/剪辑：硬切、跳切、闪白、叠化、缩放转场、字幕承接、动作承接、音频承接。
- 声音/音乐：口播、BGM、环境音、音效、停顿、重音；听不清标“未识别”。
短视频逐镜头完整分析。
```

成功后把任务结果写到 `refs/<runId>.video-understand.json`。只有 `result.shots` 能通过四列镜头表校验时，才在没有 `shotlist.md` 的情况下写入 `shotlist.json`；已有 markdown 时改写 `refs/<runId>.shotlist.json`，不覆盖手写镜头表。对不上就保持镜头表不动。

`lumen enhance` 调用 `enhance-video-generative`（公开文档里的工具名是 `enhance-video`，这里按指定的 generative 名字）。正文必有 `video_url`；`tool_version`、`scene`、`resolution`、`enhance_style` 只有你传入才发送，不发明默认值。输出：`--out`，否则有 `--shot` 时是 `shots/NN/clip/enhance-<id>.mp4`，否则 `out/enhance-<id>.mp4`。结果是 https 就下载（审计里查询串会被打码）。结果是 `vod`、`tos` 或 `mediakit` 时把 URL 记到 `refs/<id>.enhance.json` 和审计里，不伪造 mp4。

## 配置

项目文件 `lumen.config.json` 盖过全局 `~/.config/lumen/providers.json`（或 `$XDG_CONFIG_HOME/lumen/providers.json`）。某个模型在项目里出现，就整条替换全局那条，不按字段合并。`init` 会在没有配置时写一份空的，且不覆盖已有文件。项目里空的 `breakdown.prompt` 不会挡住全局提示词。未写的 `breakdown.preferModels` 也不会挡住全局列表；两边都没有时，拆解发送 `doubao-seed-2-1-lite-260915`。未写的 `breakdown.level` 用 `Quality`，未写的 `breakdown.needAudio` 为 `true`。项目里写了就盖过全局，包括 `needAudio: false`。

```bash
lumen providers set seedance-2 \
  --provider haomao \
  --base-url https://haomao.example/api/v3 \
  --api-key-env HAOMAO_SEEDANCE_KEY
```

加 `--global` 写到用户目录。只保存环境变量名，不保存密钥值。示例（假主机）见 `lumen.config.example.json`。结构见 `schemas/config.schema.json`。

`lumen doctor` 先写出 lumen 自己的安装目录、PATH 上的 `lumen` 是不是这一份、`~/.local/bin` 在不在 PATH，以及配置目录和缓存目录。接着写出技能目录、版本、是否和 CLI 一致、有没有另一份 lumen。然后报告 ffmpeg、ffprobe、sharp 各自的路径、版本和来源（没有则是 missing）、每个模型未绑定 / 已绑定 / 供应商不对、对应环境变量是否有值、拆解提示词是 default（内置拉片表）还是 set、TikHub 密钥是 present 还是 missing。不下载二进制，不打印提示词正文，也不打印密钥。

## 审计

每次生成（dry-run、mock、执行成功，以及已经有模型和参数时的校验、绑定、缺密钥、上游失败）都在 `.lumen/runs/<id>/` 写下 `record.json` 和 `record.md`。id 形如 `YYYYMMDDTHHMMSSZ-xxxx`。

记录里有时间、命令、模型、绑定（供应商、baseUrl、group、modelAlias、环境变量名、`keyPresent`）、参数（含提示词和 person-reference）、线路调用、响应元数据、本地输出路径和错误。

不会记录原始密钥。`Authorization` 和 `x-api-key` 打成 `[redacted]`。长度至少 8 的密钥字符串会被替换。URL 的用户信息和查询串（含预签名的 `auth_key`）变成 `?[redacted]`。`audio_base64` 和 `b64_json` 只留长度。

```bash
lumen runs list
lumen runs show 20261024T164700Z-ab12
```

结构见 `schemas/run.schema.json`。

---

# LUMEN / lumen

lumen is a chat-oriented video assistant. A project is a local folder. The binary is `lumen`.

## Layout

`shotlist.md` or `shotlist.json` with only `# | durationSec | frame | vo`, plus `refs/`, `shots/NN/frame|clip|vo/`, `out/`, `lumen.config.json`, and `.lumen/runs/<id>/`.

## Run locally

Node.js 20+. The install stays in the user directory and does not use sudo.

```bash
bash scripts/install.sh
bash scripts/install.sh --uninstall
npm install -g --prefix "$HOME/.local" --install-links .
```

The script puts the program in `~/.local/share/lumen` and the command in `~/.local/bin/lumen`. The npm command copies the package to `~/.local/lib/node_modules/@nurvision/lumen` and the command to `~/.local/bin/lumen`. `--install-links` copies the checkout; without it, npm only links that directory. With nvm, `npm install -g --install-links .` is already under the user directory. `--path` writes the shell rc; a non-interactive run does not. Config is `~/.config/lumen` or `$XDG_CONFIG_HOME/lumen`. Downloaded ffmpeg, ffprobe, and sharp go to `~/.cache/lumen` or `$XDG_CACHE_HOME/lumen`. Uninstall removes the program and the command, and leaves config and cache.

`lumen skill install` copies `SKILL.md` and `references` to one directory. `LUMEN_SKILL_DIR` wins over `--target`. Auto-detect uses `/home/box/agent-data/workflows/lumen` when that workflows directory exists and is writable, and otherwise `~/.agents/skills/lumen`. `LUMEN_WORKFLOWS_DIR` changes the workflows directory that auto-detect checks. A repeat install overwrites that same directory and writes `.lumen-version`. When the other candidate already has a lumen skill, the command says so; `--clean` removes that lumen directory and leaves other skills. `npm install` and `npm install -g` run a postinstall hook that uses the same detection, overwrites that one directory, and writes `.lumen-version`. If the skill install fails, the hook prints one stderr line and the npm install still succeeds. `npm install` in this package shows that line. `npm install -g` hides successful script output unless `--foreground-scripts` is set. Every lumen run updates the detected directory when the skill is missing or older than the CLI, and prints one line. `LUMEN_NO_SKILL_AUTOINSTALL=1` turns both off.

For a checkout: `npm install`, `npm test`, `npm run build`, then `node dist/cli.js --help`. `npx tsx src/cli.ts` works without a build.

The default is `--dry-run` (audit only, no network, no media). `--execute` calls the provider. `--mock` uses a built-in fake transport and writes no media. Exit `0` on success, `1` on a bad request or missing key, `2` on usage. Usage errors do not create a run.

## Routing

Each model id has its own binding: `provider`, `baseUrl`, `apiKeyEnv`, optional `group` and `modelAlias`. A project binding replaces the global one for that id. A missing mapping is `no provider binding for <id>` and never falls back to another model. Key values are not stored.

yunqiao base URLs include `/v1`. grsai, haomao, kitta, and mediakit base URLs are the origins or version roots their docs name. There is no silent default host.

Groups: `X-Group` for yunqiao. On MediaKit, `group` is `queue_id`. grsai, haomao, and kitta do not send `group`.

`lumen providers set <model> --provider --base-url --api-key-env [--group] [--model-alias] [--global]` checks that the provider can serve that model. See `lumen.config.example.json`.

## Generation

Image models `gpt-image-2`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` generate, and edit when references are attached. Before `gen image`, read `skills/lumen/references/gpt-image/SKILL.md` for the command, then `skills/lumen/references/gpt-image-提示词写法/SKILL.md` for the prompt. Size, quality, background, and provider stay on the command. All three image models map 1K, 2K, and 4K; yunqiao rejects 4K. Omitted quality sends high for gpt-image-2 and max for the 2.5 models. lumen does not send `output_format`. Yunqiao uses synchronous OpenAI `images/generations` and `images/edits`. grsai uses synchronous JSON `POST /v1/images/generations` with an `image` array. Seedance models `seedance-2`, `seedance-2-fast`, `seedance-2-mini`, `seedance-2.5` are haomao only. They accept `text` / `TextVideo`, `frame` / `FrameVideo`, and `reference` / `ReferenceVideo`, plus the aliases `standard`, `fast`, `mini`, and `2.5`. Before `gen video`, read `skills/lumen/references/seedance-2/SKILL.md` for the 2.0 models and `skills/lumen/references/seedance-2.5/SKILL.md` for `seedance-2.5`. Then read `skills/lumen/references/seedance-提示词写法/SKILL.md` for the prompt. For camera, lens, light, grade, or camera movement on an image or a video, read `skills/lumen/references/拍摄设定/SKILL.md`. Pass only materials the prompt names. On `seedance-2.5` reference, `--task-type auto|reference|edit|extend` is `omni_reference_task_type` on the haomao content task. Omitting it records `auto` and still sends `auto`. `edit` fails locally without a reference video, `aspect-ratio adaptive`, and `duration -1`. `extend` fails locally without a reference video and adaptive ratio. Duration `-1` plus adaptive ratio does not select the subtask. `--execute` polls `GET /contents/generations/tasks/{id}` and writes the mp4 beside a redacted `.seedance.json`. `SEEDANCE_POLL_MS` defaults to 10000 and `SEEDANCE_MAX_POLLS` to 180. Kitta at fishaudio.org supports design, clone, and synthesis. MediaKit `video-understand-router` (breakdown, `scene=editing` fixed) and `enhance-video-generative` share the upload, submit, and poll flow, with separate keys.

Omitting `--prompt` sends the built-in 拉片 prompt printed in the Chinese section. Do not pass that text again. An explicit `--prompt`, `--prompt-file`, or non-empty `breakdown.prompt` / `breakdown.promptFile` replaces it. Breakdown sends `level` `"Quality"`, `prefer_models` `["doubao-seed-2-1-lite-260915"]`, and `manual_option.need_audio` `true`. It does not send `prefer_endpoints`. `scene` stays `editing`. A non-empty `breakdown.preferModels` list, `breakdown.level`, or `breakdown.needAudio` in the project config or `~/.config/lumen/providers.json` replaces that default; the project value replaces the global value. `needAudio: false` turns audio off.

Enhance writes `--out`, or `shots/NN/clip/enhance-<id>.mp4`, or `out/enhance-<id>.mp4`. An https result is downloaded. A `vod` / `tos` / `mediakit` result is stored as a URL, not a fake file.

Every generation writes `.lumen/runs/<id>/record.json` and `record.md` with the prompt, binding, and wire calls. Authorization headers, long secrets, URL userinfo and query strings (including presigned `auth_key`), and base64 payloads are redacted. `lumen runs list` and `runs show <id>` read them.

`lumen download "<douyin-url>" --to <path>` saves a douyin.com video to a new file. It does not take a key argument. `lumen setup --key tikhub` prompts without echo and writes the lookup key into the machine credential store (`~/.config/lumen/credentials/`). `TIKHUB_API_KEY` is the fallback when that store is empty. The key is not written into the project and is not printed. A missing key names `lumen setup --key tikhub`. Do not ask for the key in conversation. The saved file is a `lumen breakdown --video` input; do not pass a prompt. See `skills/lumen/references/视频下载/SKILL.md`.

`lumen sprite` builds a contact sheet. ffmpeg keeps real frame timestamps and sharp lays out the grid. With no selector it reads a breakdown, then scene cuts, then a 1 second interval. `lumen cuts` prints cut times and scores. ffmpeg and ffprobe resolve from `LUMEN_FFMPEG` / `LUMEN_FFPROBE` or `tools.ffmpeg` / `tools.ffprobe`, then PATH, then the cache, then a hashed download. sharp loads an already installed module, then the cache, then an on-demand install. None of those packages are npm dependencies. `lumen setup ffmpeg` can download the binaries first.

`lumen doctor` reports where this lumen is installed, whether the `lumen` command on PATH is this copy, whether `~/.local/bin` is on PATH, and the config and cache directories. It also reports the skill directory, its version, whether that version matches the CLI, and whether another lumen skill is present. It also reports the path, version, and source of ffmpeg, ffprobe, and sharp (or `missing`), each model's binding, whether the named env var is set, whether the breakdown prompt is `default` or `set`, and whether the TikHub key is `present` or `missing`. It does not download binaries, and it never prints the prompt or a key.

`lumen library` stores reusable people, voices, and provider asset ids in a Feishu base. The default command is `lumen library connect feishu`: it writes the Feishu app-authorization QR to a PNG and prints `qr: <path>`. Attach that image in chat. The user scans it with the Feishu phone app, which offers 新建应用 or 绑定已有应用. That path does not ask for an App ID or App Secret. A second `qr:` line is the sign-in image. Then pick or create a base. No browser page is opened. Generation does not require a library. App secrets and user tokens stay under `~/.config/lumen/` and are not printed. See `skills/lumen/references/素材库/SKILL.md`.
