---
name: gpt-image
description: 用 gpt-image-2、gpt-image-2.5-flare 或 gpt-image-2.5-sunburst 调用 lumen 之前先读。只管选模型、比例、质量、背景、参考图和提交。
---

# GPT Image 使用说明

本文件只管怎么用 `lumen` 调用 `gpt-image-2`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`。三支参数相同，差别只在下面这一节。提示词写法读 `gpt-image-提示词写法/SKILL.md`，那份只写正文，不提交，三支共用。要写设备、镜头、视场、光圈、光、色或运镜时，再读 `skills/lumen/references/拍摄设定/SKILL.md`。

比例、分辨率、质量、背景和参考图用旗标。不要写进提示词，也不要自己拼请求。接口路径不在这里写。

## 选哪一支

| 模型 | 什么时候用 |
| --- | --- |
| `gpt-image-2` | 基线。已有结果已经够用，或要拿它和 2.5 对比时用。不传质量时发出 `high`。分辨率和比例与另外两支相同 |
| `gpt-image-2.5-flare` | 更快的日常出图。小模型，速度优先，画质大约对齐 GPT Image 2。新流程先要速度时从这里开始。已经验证够用的 `gpt-image-2`，想缩短等待时，用同一条提示词试这支 |
| `gpt-image-2.5-sunburst` | 质量优先的大模型，画质高于 GPT Image 2。复杂改图要锁身份、产品几何或小字，而 2 或 Flare 不够时用它。两支 2.5 都加强了精确编辑和主体保持；要先把质量立住时选 Sunburst |

没有 `flare`、`sunburst` 这种短别名。`--model` 必须写上表的完整 id。

Sunburst 已经够用之后，再用同一条提示词、同一组参考、同一个比例试 Flare。质量还过得去并且更快，就换 Flare；否则留 Sunburst。同名的质量档在不同模型上不是同一张画，也不是同一段等待。一次只换模型，或只换质量档，不要连提示词一起改。

## 绑定

供应商只有 `yunqiao` 或 `grsai`。每支模型一条绑定，没有绑定就停，不换模型，不换密钥。

```bash
lumen providers set gpt-image-2.5-flare --provider yunqiao --base-url <url> --api-key-env YUNQIAO_API_KEY
```

可加 `--group <id>`、`--model-alias <id>`、`--global`。`yunqiao` 的 group 会带上。`grsai` 不发送 group。`model-alias` 只替换上游模型字符串，不换 lumen 的模型 id。`haomao`、`kitta`、`mediakit` 不能绑这三支。

## 生成还是改图

不传 `--ref` 就是生成。传了 `--ref` 就是改图，按书写顺序对应提示词里的 `image 1`、`image 2`。最多 16 张。正文没点到的图不要传。

`--ref` 的值就是路径或 URL 本身，可以重复。不要写成视频那套 `image|路径|true`。

```bash
lumen gen image --model gpt-image-2.5-flare --prompt "…" --ref refs/person.png --ref refs/jacket.png
```

执行时两家供应商要的参考不一样：

- `yunqiao` 要本地文件。`http://` 或 `https://` 会失败，错误是 `yunqiao image edits need a local file`。
- `grsai` 要 `https://` URL，不上传本地文件。不是 https 会失败。

`--dry-run` 只把参考记进审计，不检查是文件还是 URL，也不发网络。

## 旗标

| 旗标 | 不传时 | 取值 |
| --- | --- | --- |
| `--model` | 不能省 | 上表三个 id |
| `--prompt` | 可改用文件或镜头 | 去掉空白后不能空。长于 20000 字符失败 |
| `--prompt-file` | | 相对项目目录的文本文件。和 `--prompt` 同时有时，用 `--prompt` |
| `--shot` | | 正整数。提示词空着时用该镜头的 `frame` |
| `--aspect-ratio` | 省略时是 `auto`。不要把省略当成用户的选择 | `auto`、`1:1`、`3:2`、`2:3`、`4:3`、`3:4`、`16:9`、`9:16`、`2:1`、`1:2`、`3:1`、`1:3`、`21:9`、`9:21`、`5:4`、`4:5` |
| `--resolution` | 省略时是 `1K`。不要把省略当成用户的选择 | `1K`、`2K`、`4K`。三支模型都映射成请求里的 `size` |
| `--background` | 请求里不带这个字段 | `transparent`、`opaque`、`auto` |
| `--ref` | 没有参考，走生成 | 重复多次，最多 16 |
| `--out` | 见下节 | 相对项目目录的保存路径 |
| `--project` | 当前目录 | 项目文件夹 |
| `--dry-run` | 这是默认 | 只记请求，不发网络，不写媒体 |
| `--execute` | | 提交并保存返回的图。没有密钥就失败，不造图 |
| `--mock` | | 内置假传输，不写媒体 |

三个模式只能选一个。没有 `--output-format`，没有张数旗标，也没有 `input_fidelity`。一次一张。

质量不交给用户选。不传时 `gpt-image-2` 固定发出 `high`，`gpt-image-2.5-flare` 和 `gpt-image-2.5-sunburst` 固定发出 `max`。不要改成更低档来换速度。供应商若拒绝 Flare 的 `max`，命令失败，说明是供应商拒绝；不要改成 `high` 再提交。

## 比例和分辨率

三支模型共用同一套映射。`--resolution` 只取 `1K`、`2K`、`4K`。`--aspect-ratio` 用上面的列表。命令把这两项收成请求里的 `size`。这里不列像素宽高。

`auto` 只能配 `1K`。`2K` 或 `4K` 必须是一个具体比例，否则失败：`aspect-ratio auto cannot be combined with resolution 2K or 4K`。

执行前先问用户确认 `--resolution`（`1K`、`2K` 或 `4K`）和 `--aspect-ratio`。得到回答再 `--execute`。不要替用户选 `1K`，也不要按用途自动挑一档。命令省略时的 `1K` 和 `auto` 不是用户的选择。

总像素大约超过 2K（约 2560×1440）时，官方把结果标为实验。把这一点告诉用户，由用户定档。

分辨率限制在供应商上，不在模型上。模型映射仍会算出 `4K` 的尺寸。`yunqiao` 不接受 `4K`，失败原文是 `provider yunqiao does not support resolution 4K`，它接受 `1K`、`2K`。`grsai` 接受 `1K`、`2K`、`4K`。

## 背景和保存

透明用 `--background transparent`。实底用 `--background opaque`。`--background auto` 是把选择交给上游。不传则请求里没有背景字段。

提示词里仍要写隔离主体、不要实底、不要棋盘格。画出来的棋盘格不是透明。后续改图要在正文里保留透明。这些句子见 `gpt-image-提示词写法/SKILL.md`。

lumen 不发送 `output_format`，也没有这个旗标，也不转码。返回的字节原样写入文件；返回 URL 就下载后再存；两者都没有就在旁边写一份 `.json` 回执，不造假图。

默认路径是 `out/<run-id>.png`。带了 `--shot N` 则是 `shots/NN/frame/<run-id>.png`。`--out` 覆盖这两者。文件名是 `.png` 只表示路径，不是向上游声明的格式。要透明时不要把 `--out` 写成 `.jpg`：JPEG 没有透明通道。lumen 也不会主动改成 WebP。

## 提交

用户已经确认比例和分辨率之后：

```bash
lumen gen image --model gpt-image-2.5-flare --prompt "…" --aspect-ratio 16:9 --resolution 2K --project <dir>
```

改一张本地图。`4K` 只在绑定的供应商接受时使用：

```bash
lumen gen image --model gpt-image-2.5-sunburst \
  --prompt "…" --aspect-ratio 1:1 --resolution 4K --background transparent \
  --ref refs/product.png --project <dir>
```

`grsai` 的改图用 https URL：

```bash
lumen gen image --model gpt-image-2 --prompt "…" \
  --ref "https://cdn.example/a.png" --aspect-ratio 16:9 --resolution 2K --project <dir>
```

默认 `--dry-run`。用户明确要成图、并且已经确认比例和分辨率时才加 `--execute`。比例、分辨率、背景和参考图用旗标，不要只写进提示词。不要自己拼请求。
