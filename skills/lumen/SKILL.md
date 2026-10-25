# lumen

lumen 是本地视频工具集。二进制是 `lumen`。多镜头作品可以放在一个项目文件夹里。每一项也能单独用：一张图、一条视频、一段 fish 语音、一次下载、一次拆解、一张雪碧图、一次增强、一次查素材库，都不必先跑完整条流水线。

## 安装

默认进用户目录，不需要 sudo。`bash scripts/install.sh` 把程序放到 `~/.local/share/lumen`，命令放到 `~/.local/bin/lumen`；已装则覆盖升级。`~/.local/bin` 不在 PATH 时只提示，`--path` 或在终端里回答 yes 才写 shell rc，`--no-path` 不改。卸掉用 `bash scripts/install.sh --uninstall`，配置和缓存留下。npm 用 `npm install -g --prefix ~/.local --install-links .`，包装进 `~/.local/lib/node_modules/@nurvision/lumen`，命令仍是 `~/.local/bin/lumen`；nvm 里用 `npm install -g --install-links .`。不加 `--install-links` 时，从目录安装只会链到源码。配置在 `~/.config/lumen`（或 `$XDG_CONFIG_HOME/lumen`），ffmpeg、ffprobe、sharp 的缓存在 `~/.cache/lumen`（或 `$XDG_CACHE_HOME/lumen`）。`lumen doctor` 写出安装位置和 PATH。

## 技能

`lumen skill install` 把本包的 SKILL.md 和 references 复制到一个目录。`LUMEN_SKILL_DIR` 优先于 `--target`，再自动检测：`/home/box/agent-data/workflows` 存在且可写就装到 `workflows/lumen/`，否则装到 `~/.agents/skills/lumen/`。只装一处。重复安装覆盖同一份，版本记在 `.lumen-version`。另一处已有 lumen 时会提示；`--clean` 只删除那一处的 lumen 目录。`npm install` 和 `npm install -g` 的 postinstall 也按这个规则装到这一处；失败只打一行，不让 npm 失败。每次运行 lumen，技能缺失或版本低于 CLI 时自动更新，只打一行。`LUMEN_NO_SKILL_AUTOINSTALL=1` 关闭 postinstall 和运行时自动安装。`lumen doctor` 显示技能位置、版本、是否和 CLI 一致、有没有重复。

## 硬规则

- 先查库。用户提到音色、人物（谁谁谁）、听起来像可复用名字的场景，或别的已命名身份时，先读 `skills/lumen/references/素材库/SKILL.md`，再跑 `lumen library find "<名称>"` 或 `lumen library list`。库里没有，或用户明确要新的，才设计、克隆或 `library add`。不要先生成再对名字。
- 默认 `--dry-run`：只记请求，不发网络，不写媒体。用户明确要生成时才加 `--execute`。`--mock` 不写媒体。
- 每个模型一条绑定。没有绑定就停，不换模型，不换密钥。
- 不发明密钥，不造假 mp4。缺密钥就让命令失败。
- 只跑 `lumen` 命令，不要自己拼 HTTP。
- 没选素材库时，出图、出视频和语音照常进行。

## 工具

需要指定项目时加 `--project <dir>`。`--shot N` 且省略提示词时，图像和视频用该镜头的 `frame`，语音用 `vo`。绑定只写供应商、地址和环境变量名。

**目录、检查、模型、绑定。** 建多镜头文件夹、检查镜头表、看缺绑定或密钥、列出模型、查看或写入供应商。只出一张图或一条视频时不必先 init。`lumen init <dir>` · `lumen validate` · `lumen doctor` · `lumen models` · `lumen providers list`。写入：`lumen providers set <model> --provider <id> --api-key-env <NAME> [--base-url <url>] [--group <id>] [--model-alias <id>]`。每个内置供应商都有官方默认地址，`--base-url` 只在换线路时用。

**出图。** 按提示词生成一张图，或按参考图改图。单张即可。`lumen gen image --model <id>`。模型 `gpt-image-2`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`，供应商 `yunqiao` 或 `grsai`。出图先读 `skills/lumen/references/gpt-image/SKILL.md`，再读 `skills/lumen/references/gpt-image-提示词写法/SKILL.md`。提示词写法只写正文，不提交。要写设备、镜头、视场、光圈、光、色或运镜时，图像和视频都读 `skills/lumen/references/拍摄设定/SKILL.md`。

**出视频。** 用 Seedance 出一条视频。单条即可。`lumen gen video --model <id>`。供应商只有 `haomao`。出视频先读对应的使用说明（形态、时长、比例、素材、提交），再读 `skills/lumen/references/seedance-提示词写法/SKILL.md`。提示词写法只优化提示词，不代替 lumen 提交任务。

- `seedance-2`、`seedance-2-fast`、`seedance-2-mini`（别名 `standard`、`fast`、`mini`）先读 `skills/lumen/references/seedance-2/SKILL.md`，然后读上面的提示词写法。
- `seedance-2.5`（别名 `2.5`）先读 `skills/lumen/references/seedance-2.5/SKILL.md`，然后读同一份提示词写法。`--task-type` 只在这份使用说明里。

**语音。** 设计音色、用参考录音克隆，或用已有音色念稿。单句即可。先按上面的规则查库。`lumen fish design` · `lumen fish clone` · `lumen fish synth`。模型 `voice-design-1`、`voice-clone`、`voice-synthesis`，供应商只有 `kitta`。接口不写在这里。

**下载。** 用户给出 `douyin.com` 链接并要本地文件时才下载，不要因为出现了链接就自动下载。`lumen download "<链接>" --to refs/source.mp4`。这条命令会立刻下载。细则读 `skills/lumen/references/视频下载/SKILL.md`。保存后若要拆解，`lumen breakdown --video` 指向该文件，只传视频，不要传 prompt。密钥用 `lumen setup --key tikhub` 写入本机凭据库，或由用户自己设置 `TIKHUB_API_KEY`。不要把密钥放进命令、项目或输出。不要在对话里向用户要密钥。

**雪碧图。** 把一条本地视频抽成多宫格。用户要看镜头格子或时间轴缩略图时才用，不要因为出现了视频就自动出雪碧图。`lumen sprite --video <file> --to refs/sheet.png`。切点候选用 `lumen cuts --video <file>`。细则读 `skills/lumen/references/雪碧图/SKILL.md`。这条命令会立刻抽帧出图。电脑上有 ffmpeg、ffprobe、sharp 就用电脑的；没有再下载到本机缓存。可以先跑 `lumen setup ffmpeg`。

**拆解、增强。** 把一条成片拆成镜头，或增强一条已有视频。可以对单个文件做。用户要拆镜头时才跑，不要因为出现了视频就自动拆解。`lumen breakdown` · `lumen enhance`。模型 `video-understand-router`、`enhance-video-generative`，供应商只有 `mediakit`。拆解先读 `skills/lumen/references/视频拆解/SKILL.md`。只传视频，不要传 prompt。拆解默认用 `doubao-seed-2-1-lite-260915`，`level` 为 `Quality`，需要音频，不要问用户选模型。要换时改项目 `lumen.config.json` 或 `~/.config/lumen/providers.json` 里的 `breakdown.preferModels`、`breakdown.level`、`breakdown.needAudio`。

**记录。** 查看已经记下的请求和结果，不重新生成。`lumen runs list` · `lumen runs show <id>`。

**素材库。** 按名字复用人物、音色、场景和供应商编号，存在用户的飞书多维表格里。查：`lumen library find "<名称>"` · `lumen library list`。状态：`lumen library status`。未连接时 `lumen library connect feishu` 写出二维码图片并打印 `qr:` 路径，把图片发到对话里，用户用飞书手机扫。手机上可选新建应用或绑定已有应用，不必填写 App ID 或 App Secret。新素材用 `lumen library add`。细则读 `skills/lumen/references/素材库/SKILL.md`。

**拼接。** `lumen concat` 把镜头接成一条成片。它仍是占位，不调用外部程序。
