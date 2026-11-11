---
name: seedream
description: 用 Seedream 5.0 Pro、Flash 或 5.5 调用 lumen 之前先读。5.0 默认 beeftv，5.5 只绑 yir。只管选模型、比例、分辨率、参考图、估价和提交。
---

# Seedream 使用说明

本文件只管怎么用 `lumen` 调用 Seedream 5.0 Pro、Flash 和 5.5。5.0 默认供应商是 `beeftv`，也可以绑 `volcark`。5.5 只绑 `yir`。提示词用中文写。提示词写法读 `生图-提示词写法/SKILL.md`，那份只写正文，不提交，所有出图模型共用。不要把提示词翻译成英文。要写设备、镜头、视场、光圈、光、色或运镜时，再读 `skills/lumen/references/拍摄设定/SKILL.md`。

比例、分辨率、背景和参考图用旗标。不要写进提示词，也不要自己拼请求。接口路径不在这里写。

## 选哪一支

| 模型 | 别名 | 什么时候用 |
| --- | --- | --- |
| `doubao-seedream-5-0-pro-260628` | `seedream-5-pro` | Seedream 5.0 Pro。质量优先。默认 `beeftv`：≤261 万像素 0.09 元/张，更大（含默认 2K）0.18 元/张。`volcark`：≤1.5K 0.30 元/张，2K 0.60 元/张 |
| `doubao-seedream-5-0-flash-260915` | `seedream-5-flash` | Seedream 5.0 Flash。速度优先。默认 `beeftv` 0.04 元/张。`volcark` 0.12 元/张 |
| `seedream-5.5` | `seedream-5-5`、`bytedance/seedream-5.5` | Seedream 5.5。只绑 `yir`。多轮编辑更稳，写实和小字更好。Yir APIMart（2026-11-10）：1K 0.0182 美元/张，2K 0.0280 美元/张。参考图另收费，单价未公布 |

`--model` 写上表的完整 id 或别名。别名只在 lumen 里展开成完整 id。

这三支都只出一张图。不要要求一次出多张。5.0 不支持组图，没有 `sequential_image_generation`。普通出图不拆图层，估价也不含图层。5.5 在 Yir 上也尚未开放透明背景和图层拆分。

## 绑定

5.0 的默认供应商是 `beeftv`。`volcark` 也能绑这两支。5.5 只绑 `yir`。每支模型一条绑定，没有绑定就停，不换模型，不换密钥。火山方舟和 beeftv 尚未公布 5.5 的模型 id，不要把 5.5 绑到那两家。

```bash
lumen providers set doubao-seedream-5-0-pro-260628 --provider beeftv --api-key-env BEEFAPI_KEY
```

Flash 同样写，把模型 id 换成 `doubao-seedream-5-0-flash-260915`。`beeftv` 上游默认是 `dola-seedream-5-0-pro-260628` 和 `dola-seedream-5-0-flash-260915`。`--model-alias` 可覆盖。不发送 `group`。

要改走火山方舟时才绑 `volcark`，密钥环境变量用 `ARK_API_KEY`。执行时没有这个变量，错误是中文，并写出要设置的变量名。不要把密钥写进命令、项目或对话。

5.5 这样绑：

```bash
lumen providers set seedream-5.5 --provider yir --api-key-env YIR_API_KEY
```

`yir` 上游默认是 `bytedance/seedream-5.5`。`--model-alias` 可覆盖。不发送 `group`。密钥环境变量用 `YIR_API_KEY`。

`yunqiao`、`grsai`、`haomao`、`kitta`、`mediakit` 不能绑这三支。`beeftv` 和 `volcark` 不能绑 5.5。`yir` 不能绑 5.0。

## 生成还是改图

不传 `--ref` 就是文生图。传了 `--ref` 就是带参考图的生成，按书写顺序对应提示词里的图 1、图 2。最多 10 张。正文没点到的图不要传。

`--ref` 的值就是路径或 https URL。5.0 还可以是 `data:image/...;base64,...`。5.5 在 `yir` 上不接受 data URI。可以重复。不要写成视频那套 `image|路径|true`。

```bash
lumen gen image --model doubao-seedream-5-0-pro-260628 --prompt "…" --ref refs/person.png --ref refs/jacket.png
```

参考图按绑定的供应商处理：

- `beeftv`：公网 `https://` 和 `data:image/<小写格式>;base64,...` 原样传入。本地文件用 beeftv 已有的上传，换成 https 再提交。不走对象存储。
- `volcark`：公网 `https://` 和 data URI 原样传入。本地文件读入后变成 `data:image/<格式>;base64,...`。`.jpg` 写成 `jpeg`。不上传。
- `yir`：公网 `https://` 原样传入。本地 jpeg/png/webp 用 Yir Files API 上传，换成 `file_id` 再提交。不接受 data URI。

`http://` 和其他协议会失败。文件不存在也会失败。

## 旗标

| 旗标 | 不传时 | 取值 |
| --- | --- | --- |
| `--model` | 不能省 | 上表三个 id，或别名 `seedream-5-pro`、`seedream-5-flash`、`seedream-5-5`、`bytedance/seedream-5.5` |
| `--prompt` | 可改用文件或镜头 | 去掉空白后不能空。用中文写。长于 20000 字符失败 |
| `--prompt-file` | | 相对项目目录的文本文件。和 `--prompt` 同时有时，用 `--prompt` |
| `--shot` | | 正整数。提示词空着时用该镜头的 `frame` |
| `--aspect-ratio` | 5.0 省略时是 `auto`。不要把省略当成用户的选择。5.5 省略或 `auto` 会变成 `1:1` | 5.0：`auto`、`1:1`、`3:2`、`2:3`、`4:3`、`3:4`、`16:9`、`9:16`、`2:1`、`1:2`、`3:1`、`1:3`、`21:9`、`9:21`、`5:4`、`4:5`。5.5：`1:1`、`4:3`、`3:4`、`16:9`、`9:16`、`3:2`、`2:3`、`2:1`、`1:2`、`21:9` |
| `--resolution` | 省略时是 `2K` | 5.0：`1K`、`1.5K`、`2K`。5.5：`1K`、`2K`（没有 `1.5K`）。都没有 `4K` |
| `--background` | 请求里不带这个字段 | 仅 5.0：`transparent`、`opaque`。不接受 `auto`。5.5 写了会失败，Yir 尚未开放透明背景 |
| `--ref` | 没有参考 | 重复多次，最多 10 |
| `--out` | 见下节 | 相对项目目录的保存路径 |
| `--project` | 当前目录 | 项目文件夹 |
| `--dry-run` | 这是默认 | 只记请求，不发网络，不写媒体。仍会打印估价 |
| `--execute` | | 提交并保存返回的图。没有密钥就失败，不造图 |
| `--mock` | | 内置假传输，不写媒体 |

没有 `--quality`。写了会失败：`seedream does not take --quality`。没有张数旗标。一次一张。

水印由 lumen 关闭。不要再加旗标去打开它。

5.0 透明背景用 `--background transparent`，并且恰好一张参考图。零张或多张会失败。参考图本身要带透明通道。实底用 `--background opaque`。5.5 不要传 `--background`。

## 比例和分辨率

5.0 的 `--resolution` 只取 `1K`、`1.5K`、`2K`。5.5 只取 `1K`、`2K`。省略时发出 `2K`。`4K` 会失败。

5.0 的 `auto` 把档位交给上游，由模型按提示词里的形状或用途决定宽高。选了 `auto` 时，提示词里要用中文写明画幅或用途，例如竖屏海报、横幅。5.5 没有 `auto`，省略或写 `auto` 都会变成 `1:1`。用 5.5 时要明确传比例。

具体比例会收成官方像素。用户没另选分辨率时用 `2K`，不要改成 `1K`。

执行前先问用户确认 `--aspect-ratio`。得到回答再 `--execute`。命令省略时的 `auto` 不是用户的选择。

## 估价

提交前自动打印一行估价，dry-run 也会打。按当前绑定的供应商计价。这是估算，不是账单。普通出图只估图像生成；有参考图时把参考图费用一并打进这一行。不请求图层时不含图层。

`beeftv`（默认）：

| 模型 | 图像生成 | 参考图 |
| --- | --- | --- |
| Flash | `1K`、`1.5K`、`2K` 都是 0.04 元/张 | 免费 |
| Pro | ≤261 万像素 0.09 元/张；超过（含默认 `2K`）0.18 元/张 | 第 1 张免费，从第 2 张起每张不到 0.01 元 |

`volcark`：Pro 的 `1K` 或 `1.5K` 是 0.30 元/张，`2K` 是 0.60 元/张；Flash 是 0.12 元/张。

`yir`（仅 5.5，APIMart 渠道公开价，2026-11-10）：`1K` 是 0.0182 美元/张，`2K` 是 0.0280 美元/张。参考图另收费，单价未公布，估价不含这项。

## 保存

返回的图会下载到本地。默认路径是 `out/<run-id>.png`。带了 `--shot N` 则是 `shots/NN/frame/<run-id>.png`。`--out` 覆盖这两者。要透明时不要把 `--out` 写成 `.jpg`。

## 提交

用户已经确认比例之后。分辨率没另说就用 `2K`：

```bash
lumen gen image --model doubao-seedream-5-0-pro-260628 --prompt "…" --aspect-ratio 9:16 --resolution 2K --project <dir>
```

改一张本地图（默认 `beeftv`，本地文件会上传）：

```bash
lumen gen image --model seedream-5-flash \
  --prompt "…" --aspect-ratio 1:1 --resolution 2K \
  --ref refs/product.png --project <dir>
```

Seedream 5.5（`yir`，异步任务，用 `runs resume` 续跑，不要重新提交）：

```bash
lumen gen image --model seedream-5.5 --prompt "…" --aspect-ratio 1:1 --resolution 2K --project <dir>
```

默认 `--dry-run`。用户明确要成图、并且已经确认比例时才加 `--execute --detach`，然后用 `lumen runs wait <id> --timeout 60` 取结果。不要前台一直等到命令结束，也不要重新提交。比例、分辨率、背景和参考图用旗标，不要只写进提示词。不要自己拼请求。
