# lumen

lumen 是本地视频工具集。二进制是 `lumen`。多镜头作品可以放在一个项目文件夹里。每一项也能单独用：一张图、一条视频、一段 fish 语音、一次下载、一次拆解、一张雪碧图、一次增强、一次转字幕、一次加字幕，都不必先跑完整条流水线。

## 安装

默认进用户目录，不需要 sudo。`bash scripts/install.sh` 把程序放到 `~/.local/share/lumen`，命令放到 `~/.local/bin/lumen`；已装则覆盖升级。`~/.local/bin` 不在 PATH 时只提示，`--path` 或在终端里回答 yes 才写 shell rc，`--no-path` 不改。卸掉用 `bash scripts/install.sh --uninstall`，配置和缓存留下。npm 用 `npm install -g --prefix ~/.local --install-links .`，包装进 `~/.local/lib/node_modules/@nurvision/lumen`，命令仍是 `~/.local/bin/lumen`；nvm 里用 `npm install -g --install-links .`。不加 `--install-links` 时，从目录安装只会链到源码。配置在 `~/.config/lumen`（或 `$XDG_CONFIG_HOME/lumen`），ffmpeg、ffprobe、sharp 的缓存在 `~/.cache/lumen`（或 `$XDG_CACHE_HOME/lumen`）。`lumen doctor` 写出安装位置和 PATH。

## 技能

`lumen skill install` 把本包的 SKILL.md 和 references 复制到一个目录。`LUMEN_SKILL_DIR` 优先于 `--target`，再自动检测：`/home/box/agent-data/workflows` 存在且可写就装到 `workflows/lumen/`，否则装到 `~/.agents/skills/lumen/`。只装一处。重复安装覆盖同一份，版本记在 `.lumen-version`。另一处已有 lumen 时会提示；`--clean` 只删除那一处的 lumen 目录。`npm install` 和 `npm install -g` 的 postinstall 也按这个规则装到这一处；失败只打一行，不让 npm 失败。每次运行 lumen，技能缺失或版本低于 CLI 时自动更新，只打一行。`LUMEN_NO_SKILL_AUTOINSTALL=1` 关闭 postinstall 和运行时自动安装。`lumen doctor` 显示技能位置、版本、是否和 CLI 一致、有没有重复。

## 硬规则

- 默认 `--dry-run`：只记请求，不发网络，不写媒体。用户明确要生成时才加 `--execute`。`--mock` 不写媒体。
- 每个模型一条绑定。没有绑定就停，不换模型，不换密钥。
- 不发明密钥，不造假 mp4。缺密钥就让命令失败。
- 只跑 `lumen` 命令，不要自己拼 HTTP。
- 出图和出视频的提示词用中文写。不要把提示词翻译成英文。

## 助手怎么跑生成

出图、出视频、增强不要在前台一直占着 `--execute`。用户一发新消息，这一轮会被打断，前台进程被杀掉，生成中断；再提交一次会重新扣费。不要依赖子任务，也不要用 `nohup`、`&` 或 `pkill -f` 自己管后台。

1. 生成一律加上 `--detach --execute`：`lumen gen image`、`lumen gen video`、`lumen enhance`。续跑是 `lumen runs resume <id> --execute --detach`。命令做完本地校验、打出预估、写好 run 后，把提交、轮询、下载和后处理（增强的颗粒）交给脱离终端的子进程，自己打印 run id，退出码 0。
2. 同一轮里接着循环 `lumen runs wait <id> --timeout 60`。退出码 0：把 `wrote:` 路径发给用户。退出码 3：仍在生成，可以先回一句进度再 wait。退出码 1：把失败原因告诉用户。`wait` 只读记录，不提交。杀掉 `wait` 不影响生成。
3. 用户中途发消息后，先回用户，再 `lumen runs list --pending`。有未取走的就继续 wait，把结果发回去。不要重新提交。
4. 要停任务只用 run 记录里的 pid。`runs show <id>` 能看状态。生图若已中断：有结果 URL 就 `runs resume`（只下载，不重提）；有服务端任务就 resume 同一个任务；什么都没有就说明不能 resume，不要重提。

## 工具

需要指定项目时加 `--project <dir>`。`--shot N` 且省略提示词时，图像和视频用该镜头的 `frame`，语音用 `vo`。绑定只写供应商、地址和环境变量名。

**目录、检查、模型、绑定。** 建多镜头文件夹、检查镜头表、看缺绑定或密钥、列出模型、查看或写入供应商。只出一张图或一条视频时不必先 init。`lumen init <dir>` · `lumen validate` · `lumen doctor` · `lumen models` · `lumen providers list`。写入：`lumen providers set <model> --provider <id> --api-key-env <NAME> [--base-url <url>] [--group <id>] [--model-alias <id>]`。每个内置供应商都有官方默认地址，`--base-url` 只在换线路时用。

**出图。** 按提示词生成一张图，或按参考图改图。单张即可。`lumen gen image --model <id>`。GPT Image 模型 `gpt-image-2`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`，供应商 `yunqiao` 或 `grsai`。出图先读 `skills/lumen/references/gpt-image/SKILL.md`。Seedream 5.0 是 `doubao-seedream-5-0-pro-260628`（别名 `seedream-5-pro`）和 `doubao-seedream-5-0-flash-260915`（别名 `seedream-5-flash`）。默认供应商是 `beeftv`，也可以绑 `volcark`。省略分辨率时是 `2K`。这两支先读 `skills/lumen/references/seedream/SKILL.md`。所有出图再读 `skills/lumen/references/生图-提示词写法/SKILL.md`。提示词用中文写。提示词写法只写正文，不提交。要写设备、镜头、视场、光圈、光、色或运镜时，图像和视频都读 `skills/lumen/references/拍摄设定/SKILL.md`。

**出视频。** 用 Seedance 出一条视频。单条即可。`lumen gen video --model <id>`。供应商是 `haomao`；`seedance-2-fast` 还可以绑 `beeftv`；`seedance-2.5` 还可以绑 `ycyapi`。出视频先读对应的使用说明（形态、时长、比例、素材、提交），再读 `skills/lumen/references/seedance-提示词写法/SKILL.md`。提示词写法只优化提示词，不代替 lumen 提交任务。复杂商业片或信息流，写提示词前先读 `skills/lumen/references/开场钩子/SKILL.md`。要脚本、分镜或多镜时，先读 `skills/lumen/references/分镜脚本/SKILL.md`：先写创意说明和成片镜头表，再按提示词写法的路径 B 写正文。片种可选读 `skills/lumen/references/视频类型/SKILL.md`。

- `seedance-2`、`seedance-2-fast`（别名 `standard`、`fast`）先读 `skills/lumen/references/seedance-2/SKILL.md`，然后读上面的提示词写法。
- `seedance-2.5`（别名 `2.5`）先读 `skills/lumen/references/seedance-2.5/SKILL.md`，然后读同一份提示词写法。`--task-type` 只在这份使用说明里。

**语音。** 设计音色、用参考录音克隆，或用已有音色念稿。单句即可。`lumen fish design` · `lumen fish clone` · `lumen fish synth`。模型 `voice-design-1`、`voice-clone`、`voice-synthesis`，供应商只有 `kitta`。接口不写在这里。

**下载。** 用户给出 `douyin.com` 链接并要本地文件时才下载，不要因为出现了链接就自动下载。`lumen download "<链接>" --to refs/source.mp4`。这条命令会立刻下载。细则读 `skills/lumen/references/视频下载/SKILL.md`。保存后若要拆解，`lumen breakdown --video` 指向该文件，只传视频，不要传 prompt。密钥用 `lumen setup --key tikhub` 写入本机凭据库，或由用户自己设置 `TIKHUB_API_KEY`。不要把密钥放进命令、项目或输出。不要在对话里向用户要密钥。

**雪碧图。** 把一条本地视频抽成多宫格。用户要看镜头格子或时间轴缩略图时才用，不要因为出现了视频就自动出雪碧图。`lumen sprite --video <file> --to refs/sheet.png`。切点候选用 `lumen cuts --video <file>`。细则读 `skills/lumen/references/雪碧图/SKILL.md`。这条命令会立刻抽帧出图。电脑上有 ffmpeg、ffprobe、sharp 就用电脑的；没有再下载到本机缓存。可以先跑 `lumen setup ffmpeg`。

**拆解、增强。** 把一条成片拆成镜头，或增强一条已有视频。可以对单个文件做。用户要拆镜头时才跑，不要因为出现了视频就自动拆解。`lumen breakdown` · `lumen enhance`。模型 `video-understand-router`、`enhance-video-generative`，供应商只有 `mediakit`。拆解先读 `skills/lumen/references/视频拆解/SKILL.md`。只传视频，不要传 prompt。拆解默认用 `doubao-seed-2-1-lite-260915`，`level` 为 `Quality`，需要音频，不要问用户选模型。要换时改项目 `lumen.config.json` 或 `~/.config/lumen/providers.json` 里的 `breakdown.preferModels`、`breakdown.level`、`breakdown.needAudio`。`lumen enhance` 固定大模型版 `enhance-video-generative`、2K、30fps，没有分辨率或风格可选。提交前按 10 元/分钟打印费用估算。下载完成后自动加上固定 0.55 的黑白胶片颗粒。不要在增强之后再加颗粒，也不要自己调用 ffmpeg。细则读 `skills/lumen/references/增强/SKILL.md`。

**转字幕。** 把一条视频里的话认成带时间的字幕，并把每条结束时间裁到片长以内。项目里镜头表已有口播，或前面做过语音合成、声音克隆时，自动对照文案；对得上就改错漏，不必再确认。单独丢来一条视频、没有文案时，只写出识别结果，确认后再加字幕。`lumen captions transcribe --video <file>`。默认 `--dry-run`，真正识别加 `--execute`。模型 `asr-subtitles`，供应商只有 `mediakit`。先读 `skills/lumen/references/转字幕/SKILL.md`。

**加字幕。** 只把已经确认的字幕压进画面，不负责识别。用本机 ffmpeg 硬压，不调用云端加字幕。默认白字、半透明灰圆角底；竖屏在顶部居中，横屏在底部居中。`lumen captions burn --video <file> --subs <file> --to <mp4>`。这条命令会立刻压制。先读 `skills/lumen/references/加字幕/SKILL.md`。

**记录。** 查看已经记下的请求和结果，不重新生成。`lumen runs list` · `lumen runs list --pending` · `lumen runs show <id>` · `lumen runs wait <id>`。视频生成、增强或拆解等满仍未完成时，run 状态是 `running` 而不是失败，用 `lumen runs resume <id> --execute --detach` 接着等并取回结果，不要重新提交。助手跑生成的标准步骤见上面「助手怎么跑生成」。

**拼接。** `lumen concat` 把镜头接成一条成片。它仍是占位，不调用外部程序。


## haomao 模型名

haomao 的 seedance 上游模型名带 `.0`：`seedance-2.0`、`seedance-2.0-fast`（2.5 仍是 `seedance-2.5`），lumen 自动换。若好猫报 `model_not_found`，用好猫的模型列表接口查实际 id，再 `lumen providers set <模型> --provider haomao --model-alias <id>` 覆盖；它同时作用于提交和上传。

## beeftv

`beeftv` 提供 `seedance-2-fast`（上游 `seedance-2.0-fast`），也是 Seedream 5.0 Pro / Flash 的默认出图供应商。视频绑定：`lumen providers set seedance-2-fast --provider beeftv --api-key-env <你的变量名>`。出图绑定：`lumen providers set doubao-seedream-5-0-pro-260628 --provider beeftv --api-key-env BEEFAPI_KEY`。上游默认是 `dola-seedream-5-0-pro-260628` 和 `dola-seedream-5-0-flash-260915`，`--model-alias` 可覆盖。本地参考图走 beeftv 上传。省略分辨率时是 `2K`。细则见 `skills/lumen/references/seedream/SKILL.md`。视频的本地首帧、尾帧、参考图、视频、音频也会自动上传。

## volcark

`volcark` 是火山方舟官方图片接口，也能绑这两支 Seedream，但不是默认。绑定：`lumen providers set doubao-seedream-5-0-pro-260628 --provider volcark --api-key-env ARK_API_KEY`。估价：Pro ≤1.5K 0.30 元/张，2K 0.60 元/张，Flash 0.12 元/张。水印关闭。一次一张，不组图。本地参考图读成 data URI 放进请求。公网 HTTPS 或已经是 base64 的原样传入，不上传。缺 `ARK_API_KEY` 时错误是中文。提示词用中文写。

## ycyapi

`ycyapi` 只提供 `seedance-2.5`，上游模型名 `seedance2.5-A`，默认用官方域名，不用配。绑定：`lumen providers set seedance-2.5 --provider ycyapi --api-key-env YCYAPI_API_KEY`（`--model-alias` 可覆盖上游 id）。分辨率 `480p` / `720p` / `1080p`（lumen 默认 `720p`），时长 4–30 秒，比例不含 `adaptive`。参考素材接受公网 HTTPS，或本地文件。本地文件只上传到火山引擎 TOS（私有桶，预签名 GET，约 3 天）。在配置里加上 `"tos": {}`，并设置 `VOLC_ACCESSKEY` / `VOLC_SECRETKEY`。没配 `tos` 或没设密钥会直接失败，不会改走 beeftv。上限图 30 / 视频 10 / 音频 10。不支持首尾帧、`--task-type`（Auto / edit / extend）、remix、4K。配好之后 `--dry-run` 列出计划中的 TOS 上传且不发送。

估价依据是 2026-11-01 的 ycyapi 公开价表，来源 URL 写在 `references/seedance-2.5/SKILL.md`。缺省上游 `seedance2.5-A` 只按输出秒数，分组 `22-SD-2.5视频`：480p 0.36 元/秒，720p 0.62 元/秒，1080p 0.95 元/秒。参考视频不另收费。`--model-alias ya-sd25-30s` 是 2.00 元/次。`gpt-image-2.5-flare` 和 `gpt-image-2.5-sunburst` 在 `20-GPT-特价生图` 为 0.01 元/张，`gpt-image-4K` 为 0.03 元/张。
