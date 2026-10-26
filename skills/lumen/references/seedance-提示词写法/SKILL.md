---
name: "Seedance 提示词写法"
description: "Seedance 2 与 2.5 的提示词写法。只写正文，不提交。"
---

# Seedance 提示词写法

本文件的说明用中文。交给模型的提示词正文只用英文：模板、样例、默认约束都是英文。不要把中文写进模型收到的正文。

本文件只写提示词，不提交任务。`seedance-2`、`seedance-2-fast` 的形态、时长、比例、素材和提交见 `seedance-2/SKILL.md`。`seedance-2.5` 见 `seedance-2.5/SKILL.md`。那些数字不写进提示词，也不在这里再列一张表。

机身、镜头、视场、光圈或景深、光、色、类型、调色、运镜、运镜风格和可选变速，都从 `skills/lumen/references/拍摄设定/SKILL.md` 的「写入」列取英文句子。图像也用那一份。这里不列预设，也不把中文名称或编号写进正文。

这些句子分两处放，不要混：

- **机身/色调**：机身或胶片感、色板、类型里的光和色、调色。全片只写一次，放在设定段或全程保持。
- **焦段/镜别/运镜**：景别、视场角或焦段、一种运镜。路径 A 整段一套。路径 B 每一镜一套。机身和色调不要抄进每一镜。

机身是 iPhone 原相机时：机身/色调只写拍摄设定里那一句英文，跳过色板、胶片感、类型的光和色、调色。焦段、视场角、光圈、景深和镜头角色不从词库写入。路径 A 要写镜头时只留景别和一种运镜。路径 B 每一镜仍可写景别和一种运镜，用明文英文，不写视场角，不写光圈或焦段编号。

本仓库不写白模、灰模或线框参考。

角色必须念出的原文若用户给的是别的语言，只把那一句放进 `{}`。除此之外，标签、叙述、约束都是英文。

## 原则

1. **意图优先**。不改人物身份与数量、关键道具、场景、因果、空间关系、编辑对象、延长方向和故事结果。
2. **先定一种主任务**。生成、编辑、延长只能有一个。又要改原片、又要在片外续写时，拆成两步，每步一条提示词，不要合成一个备选版本。
3. **用模板重写，不要同义润色**。简单的收成一段；复杂的多模态参考走路径 B。编辑和延长用各自的闭环，不套成重新生成。
4. **一份素材一件事**。写进正文的每一份都有明确职责。正文没写到的图、视频、音频不要上传，也不要传去生成。不要在正文里列未使用的编号。
5. **用户指定的映射优先**。已经覆盖的槽位，不要再塞一张未点名的图去「增强」。
6. **少问**。能从文字和可见素材判断的直接写。只有身份、数量、左右、编辑对象、延长方向或关键帧职责有多个等价答案时，合成一个问题，停下来等。不要同时交出可能被提交的临时正文。
7. **正文只留可提交的英文句子**。不写分析、评测、密钥、修改理由。`[Goal]` 这类英文标签属于正文，不是讲解包装。
8. **参数留在使用说明**。画幅、总时长、分辨率不写进提示词。用户要改画幅或改总时长、而不是改画面里的对象时，不要写成编辑；目标句后加 `This is not a video edit.` 原片只作内容参考。
9. **不滥加约束**。不要自动加画质包、稳定包、水印、Logo 或分身禁令。用户没要字幕、也没要音乐时，只写 `no subtitles, no music`。
10. **默认一条**。用户没要对比版时只出一条。
11. **事实和观察分开**。名字、年龄、关系、结局以用户文字为准。素材只补直接看见或听见的东西。单人图不要同时定义两个会同时出场的人；多个候选人先一人一图、一组一图。

用户只给了很高的想法、没有主体也没有事件时，问一次：谁、在做什么、有没有参考。不要先编一张脸。已经有泛指主体和清楚动作时，保留泛指，不要为了显得具体停下来。

## 引用、主体、防歧义

按实际上传或用户给出的顺序编号，从 1 开始。写进正文的标记是 `@ImageN`、`@VideoN`、`@AudioN`。用户原稿里的 `@图片N`、`@视频N`、`@音频N` 按同一序号改成这三枚英文标记，不要把中文标记留在正文里。编号原样保留，不因读不到文件就删掉、改号或改成无参考。读不到就不要声称看过，也不要补只有看过才能确定的五官、音色、动作或布景。

两种主体写法，选一种用到底：

- 短句：`<Subject1> in @Image1`，或 `the short-haired girl in @Image1`。`@ImageN` 后面先接名词再接动词。
- 要反复用：`Define the bobbed hair and dark brown apron in @Image1 as <Subject1>.` 之后只写 `<Subject1>`。

一行只定义一个主体、一件道具或一处场景。不要写「人物 A 和人物 B 参考两张图」这种范围句。拆成两行英文。

错误：`@Image1 runs to the door`。数字会粘到动词上。

正确：`<Subject1> in @Image1 runs to the door.` `The woman in @Image2 stands outside the counter.`

不要在动作里裸写 `[asset-xxx]`。输入是 JSON 或带素材 ID 的长文时，按媒体出现顺序换成 `@ImageN` / `@VideoN` / `@AudioN`，再替换正文里的 ID。

`Shot 45` 默认是镜头编号，不是 45 度机位。只有用户写了 45 度才当角度。

同一主体多张图：分开写每张补什么，并写明它们是同一个人，成片里只有一个。两个已命名的人不要并成一个主体，也不要拿一张单人图同时定义两个会同时出场的人。

参考视频没说职责时，只继承和任务有关的动作、机位运动、节奏或声音。生成任务不要默认继承参考视频里的人脸、服装和整场布景。视频已经把动作和顺序给准了，就写继承哪些维，不要把每个动作再改写一遍。

台词以用户文字为准。音频默认只给音色、口音、语速和情绪；用户明确要求沿用音频里的原句时例外。

映射顺序：用户点名 > 提示词里的描述 > 素材上看得见的内容 > 文件名 > 上传顺序。上传顺序只在用户要求直接出、而且槽位和候选数量一致时，用来打破平局，不证明身份。

只在这些情况停下来问一次：左右或首尾帧对不上；编辑或延长里出现「参考 @视频N」或 `reference @VideoN`；同一镜头同时要两种机位运动；同一个主体被写成两套互相打架的静态特征；延长方向无法判断。风格、光线、普通机位运动没写，不要为此打断。

长图或宫格如果是一张图里的很多格，按「可选：宫格分镜」写，不要当成多张独立参考，除非用户已经拆开。人物三视图容易漂，建议用户改成一张无表情大头照加一张全身照；这是建议，不是另一条提示词。超过四人的群像，先在文字里分组，每组写清谁是谁，不要用一张图糊过去。越要锁脸的图，在提示词里越靠前。

## 先定任务，再定路径

| 任务 | 什么时候 | 写进正文的骨架 |
| --- | --- | --- |
| 参考生成 | 新片子，素材提供人、物、场景、动作或声音 | `Using the short-haired girl in @ImageN, generate ...` |
| 编辑 | 只改一条原片里的对象、区域或声音 | `Strictly edit @VideoN: ...`，再写保留范围 |
| 延长 | 在原片之前或之后接新片段 | `Extend @VideoN forward in time` 或 `Extend @VideoN backward in time` |
| 组合 | 借一张图改另一段视频 | `Using the object in @ImageN, strictly edit @VideoX: ...` |

不要写「参考 @视频N」来表示编辑或延长。英文正文里也不要写 `reference @VideoN`。有多段视频时点名 `@VideoN`，不要写 `these videos`。

编辑、延长、组合走**路径 A**：一件事，一段或一组闭环，不拆成影视三段论。

多模态参考再看复杂度，看的是事件，不是素材张数：

- **路径 A**：同一时空里一件连续的事。博主站着介绍产品、窗边吃蛋糕、产品转一圈，都是路径 A。台词长、动作细，只要不换地方、不另起事件，仍是路径 A。
- **路径 B**：时间或空间有一边是「多」。先 A 再 B 再 C、街上进店再出店、用户已经写出镜头 1 / 镜头 2、跨场景短剧。素材达到四份、或参考视频本身有很多分镜，只是倾向于复杂，仍回到时间 / 空间判断。

路径 A 可以把四段并成一段。路径 B 必须有总体设定、分镜或阶段、全程保持。任务分类表里的句式是零件，不是顶层结构。

## 正文四段

能短则短。四段可以并成一段，但这四件事要在：

1. **素材**。一行一个 `@ImageN`、`@VideoN`、`@AudioN`，用英文写它负责人、声音、动作、场景还是风格，以及不采用什么。
2. **一句**。主体 + 地点 + 事件。路径 A 若写镜头，把一套景别、视场角和一种运镜放在这里或全程保持，不要拆开。
3. **时间**。按下一节的时间轴写。简单的一件事可以不拆。
4. **全程保持**。机位、光线、色彩、环境、声音里需要一直不变的部分，加上约束。

没有素材的纯文字，不要虚构 `@Image1`。用户没写引用，就不要凭空加编号。

## 内容核对

写完用这张清单看有没有漏。缺的补进四段，不要在文末再挂一套包。

精准主体、动作细节、场景环境、机身/色调、焦段/镜别/运镜、约束。

| 项 | 何时必写 | 缺了怎么办 |
| --- | --- | --- |
| 精准主体 | 必写 | 有图就绑到图上的可见特征，用英文写。只有「一个女孩」就保留泛指，不要发明五官 |
| 动作细节 | 必写 | 写成看得到的肢体和幅度。没有指定时用低、连续的小动作，不要替用户加上奔跑或跳跃 |
| 场景环境 | 按需 | 路径 A 可以一句。有场景图就写采用布局、不采用图中人 |
| 机身/色调 | 按需 | 全片一次。机身或胶片感、色板、类型里的光和色、调色。用户点了风格、点了光，或非写实必须锚定时才写；没指定就省略，不要另起一条光影，也不要补空泛氛围词。句子只从拍摄设定的「写入」列取，不抄整表，不写编号。机身是 iPhone 原相机时，这一项只留那一句，跳过色板、胶片感、类型色光和调色。动漫或非写实用英文可见结果锚定，例如 `flat cel shading, clean lines, only two shadow steps`，否则容易漂成实拍 |
| 焦段/镜别/运镜 | 路径 B 必写；路径 A 有镜头意图时写 | 景别一句、视场角或焦段一句、一种运镜。都从拍摄设定取英文句子。路径 A 整段只写一套。路径 B 写进每一个 `Shot N` 或阶段，三样都要有，运镜只一种。不要同一镜又推又摇。推近或拉远要写起幅和落幅，并且不要再锁死一个固定视场角。运镜风格和变速可选，不代替这一镜的那一种运镜。机身是 iPhone 原相机时，不写焦段、视场角、光圈和景深；路径 B 仍可写景别和一种运镜 |
| 约束 | 按需 | 用户没提字幕和音乐时，只写 `no subtitles, no music`。不要自动加画质包、水印或 Logo |

## 画面写法

1. **写看得见、量得着的画面**。情绪、类型、风格标签改成能拍到的主体、服饰、距离、光线和动作，用英文写进正文。身份和关系仍以用户文字为准。不写空标签，写 `wet asphalt in a narrow alley reflecting magenta and cyan neon, the two people about a palm apart, a low warm lamp on the wooden table`。
2. **写目标，不堆禁令**。用要出现的状态代替一串禁止。下表左列是用户的限制，右列是写进正文的英文。

| 堆叠的限制 | 写进正文 |
| --- | --- |
| 不要跑、动作别太大 | `walks the corridor at a walking pace, stride about one shoulder wide` |
| 不要晃 | `the camera is locked, the horizon stays level` |
| 不要多余的人 | `only these two people are in the frame` |
| 不要暗、不要冷 | `warm window daylight, a soft highlight on the face` |

3. **优先可度量的说法**。速度（步行、约两秒一次转身）、尺度（约占画面高度三分之一、肩距约一掌）、光线（低处暖钨丝、侧逆光）、镜头内的相对节奏。不要为了显得精确，按总时长新造 `0–3s`。

用户明确不要字幕时写 `no subtitles`。只去掉背景音乐时写 `Remove the background music. Keep the dialogue, lip sync, ambience, action sound, and the entire picture.` 不要把反向说法扩到其他东西上。

内心活动改成表情、动作或台词，不新增事件。先让观众看清原因，再给反应；原因和反应能同框就同框，不要在原因出现之前切成纯脸特写。假装受伤就写皮肤、衣服和道具保持完整，不要写成真的伤口。

## 时间轴

- **Seedance 2 / fast**：用 `Shot 1`、`Shot 2`、`Shot 3`。不要写 `0–3s`，也不要把顺序写成中文镜头编号。路径 B 的每一镜写景别、视场角和一种运镜。机身是 iPhone 原相机时不写视场角，只写景别和一种运镜。
- **Seedance 2.5**：秒数或镜头顺序都可以。秒数必须连续、不重叠，并且来自用户已经给出的事件时间。不要为了凑总时长新造 `0–3s`。用户没给数字时用 `Phase 1`，每个阶段一件主要的状态变化，并写结束时看得见什么。

`Shot 1:` 这种编号是顺序，不是秒。Seedance 2.5 上如果用户已经给了时间段，保留他的数字，写成 `0-5s` 这种英文，不要改成别的编号，也不要加密。

总时长比用户的事件更长时，只把已有动作、反应、停顿和过渡拉开。不要新增人物、主线和结局，也不要用空镜填满。交接要写清唯一物件换到谁手里，交出的人不再拿着。

## 路径 A 怎么组装

单镜、编辑、延长、组合，直接写成一段或下面的短标签，不要强行安上三个中文标题。要写镜头时，整段只给一套景别、一套视场角、一种运镜。机身/色调有则全片一次，放在这一段里，不要拆镜头。机身是 iPhone 原相机时，视场角、光圈和镜头角色都不写，镜头只留景别和一种运镜。

```text
[task sentence], [subject and assets], [place and action], [what stays], no subtitles, no music
```

参考：

```text
Using the short-haired girl in @Image1, generate her eating cake by the window in @Image2. Warm daylight falls on the table. no subtitles, no music.
```

编辑：

```text
Strictly edit @Video1: replace the perfume with the face cream in @Image1. The other people, props, and background stay as in @Video1. no subtitles, no music.
```

延长：

```text
Extend @Video1 forward in time. The new picture continues from the last frame: the two people walk on to the corner and stop, facing each other. Do not change anything already visible in @Video1. no subtitles, no music.
```

用户没要音乐、也没要字幕，末尾就这一句 `no subtitles, no music`。不要再接画质、水印或 Logo。

## 路径 B 怎么组装

多事件或多空间的参考生成用三段。编辑和延长不要走这三段。

**第一段，设定和主体。** 用英文一句定场所。一次性绑完主体。脸和服装分开时写 `Face from @Image1. Costume from @Image2.` 机身/色调若要写，只在这一段或第三段写一次。运镜参考、环境声参考也在这里声明。首帧尾帧不写在这一段的同一句里，改到「可选：关键帧」。

**第二段，时间。** Seedance 2 / fast 用 `Shot 1`、`Shot 2`。Seedance 2.5 用 `Phase 1`，或用用户给过的秒数。每一镜必须有景别、视场角或焦段、一种运镜，英文句子从拍摄设定的「写入」列取，镜与镜可以不同。机身是 iPhone 原相机时，每一镜只写景别和一种运镜，不写视场角、焦段、光圈或景深。另外写主体动作与表情、位置变化、这一镜的声音。不要把机身、色板、类型或调色抄进每一镜。动作写肢体和幅度，优先低而连续，写过渡，情绪写成身体，不要只写 `sad`。

**第三段，全程保持。** 身份、服装、道具归属、空间方向、声音关系。机身/色调若没写在第一段，可以写在这里，仍然只一次。用户没指定字幕和音乐时写 `no subtitles, no music`。多人写清谁穿什么、相对哪个稳定物体站在哪一侧，用 `only these people are in the frame` 代替一长串分身禁令。

```text
A modern women's dorm at dusk. film texture without heavy grain, gentle highlight roll-off, natural skin rendering. neutral realistic colour from the scene materials, white balance matched to the intended light.
Face of <Subject1> from @Image1. Costume from @Image2. The wooden bed and desk in @Image3 are <Place1>. Camera movement follows the travelling shot in @Video1. Ambience from @Audio1.

Shot 1: a medium shot, about to the waist. 47° field-of-view anchor, natural-looking subject proportions and a balanced view of the space. the camera travelling with the subject at their pace. <Subject1> walks to the door at a walking pace, stride about one shoulder wide, stops, and takes a breath. Soft footsteps in the corridor.
Shot 2: a medium close-up, head and shoulders. 63° field of view, close to how a person takes in a room, the environment readable around the subject. locked-off stable framing throughout this time range. <Subject1> pushes the door open. Roommates sit on the bed and look up. One says {How did the exam go?}
Shot 3: a close-up, the face or one object filling most of the frame. 29° field of view, the background pulling up behind the face, the subject isolated from the room. the camera physically moving away from the subject. <Subject1> looks down, then up, and says {I was kidding}. End with the four of them between the bed and the desk. No fifth person.

Keep the face and costume of <Subject1>, the dorm layout, and the film texture and neutral colour above. no subtitles, no music.
```

Seedance 2.5 且用户没给秒数时，把 `Shot 1` 换成 `Phase 1`，仍然不要写 `0–3s`。用户已经给了时间段时才用秒，并且连续、不重叠。

## 参考

带素材、事件不止一句时，用这些英文标签。简单任务可以合并相邻段，但不能漏掉实际用到的素材。

```text
[Goal]
Generate <event>. The core subject is <who>. This is not a video edit.

[References]
@Image1 supplies the face, hair, and costume of <who>. Do not use the picture's background.
@Video1 supplies <action or camera move>. Do not use the people, costume, or place in the video.
@Audio1 supplies the voice of <who>.

[Subjects]
<Subject1> is @Image1 and keeps <fixed traits>.

[Events]
Start: <state>.
Main event: <continuous action>.
End: <who is where, and who holds the object>.

[Keep]
Keep <identity, count, costume, prop ownership, and spatial direction>. no subtitles, no music.
```

`This is not a video edit.` 只在用户要的是改构图或改总时长、原片只作内容参考时加。真的编辑、延长、首尾帧，不要加这句。

多素材按这个顺序组织，不要用一句总括让模型自己分配：

```text
[People]
<PersonA> is @Image1. Use only the face, hair, and costume.
<PersonB> is @Image2. Use only the face, hair, and costume.
Do not swap their faces, costumes, actions, positions, or lines.

[Props]
<PropA> is @Image3. It belongs only to <PersonA>. There is one of them.

[Places]
<PlaceA> is @Image4. Use only the space, materials, and light. Do not use the people in the picture.

[Action and sound]
@Video1 supplies the action of <PersonA>. Do not use the people or place in the video.
@Audio1 supplies the voice and the specified line of <PersonA>.
```

同一主体的正面、侧面、背面写成逐张职责，并写明成片里这个人只有一个。

站位围绕门、桌子、柜台、车这些稳定物体写内外和朝向，不要只写屏幕左侧：

```text
The clerk stays inside the glass counter, facing out. Two customers stand side by side outside the counter and speak to the clerk across it.
```

站位图上的箭头、框和说明文字不是画面内容。

分场景时每一场只激活这一场用到的人和物，并写结束时的可见状态。下一场承接这个状态。

```text
Phase 1: The inspector stands alone at the equipment bay, the recorder on their belt. They open the bay and take out the only memory card. End with the card only in their right hand.
Phase 2: In the same room they insert the card into the recorder. End with the screen lit and the card still in the device.
Phase 3: The archive room. The archivist is inside the wooden desk, the inspector outside it. The inspector sets the recorder in the center of the desk and says {This week's data is exported}. End with the recorder only on the desk.
```

长视频的阶段骨架：

```text
[Phase 1]
Start: <initial state>.
Main event: <one event>.
End: <visible state>.

[Phase 2]
Carry over: <state that must remain>.
Main event: <one event>.
End: <visible state>.
```

阶段数量跟事件走，不必凑成三段。提示词长了，先留主体、职责、事件和结束状态，压缩重复的风格词。

只有用户已经给了数字，或明确要求按秒控制交接、进出场或节拍时，才写：

```text
0-5s: <start state>; <one event>; end on <state>.
5-10s: carry over the previous state; <one event>; end on <state>.
```

不要写到 0.5 秒，也不要声称能卡在某一帧。

## 严格编辑

编辑必须有一条唯一母版。只描写目标画面、不提母版，会退化成重新生成。

先把原片里看得到的人、动物、道具和背景分成：替换、删除、保持。用户没点名的，默认保持。看不全原片时，不要假装数完了所有人；写完指定修改后，必须加上范围闭环的其中一句：

- 局部修改：`Apart from the objects named above, every other visible person, prop, and background element in @Video1 stays as it is and is not replaced or removed.`
- 用户明确只要留下某些对象：`Apart from the objects named to keep, remove every other visible subject in @Video1. Do not add anything that was not named.`

```text
[Edit]
Strictly edit @Video1. Change only <original object> into <target>.

[Source]
@Video1 is the only edit master. It supplies the original place, camera, camera move, action path, occlusion, and event order.

[Target]
@Image1 supplies the look or material of <target>. Do not use the picture's background or unrelated people.

[Scope]
Change only <object and region>. The count of the target in the whole piece is <count>.
Apart from the objects named above, every other visible person, prop, and background element in @Video1 stays as it is and is not replaced or removed.

[Timeline]
<Target> replaces <original> at the same entrance, path, speed, and occlusion. Other people's actions, camera moves, and event order stay as in @Video1.
no subtitles, no music.
```

动态主体换成另一类时，写运动槽位，不要写一长串无关的保持清单：

```text
Remove the red bicycle and its rider passing in front of the bench in @Video1. Replace them with the dark gray patrol cart in @Image1 at the same entrance, path, speed, and occlusion. The red bicycle and the rider do not appear in the result. The two people on the bench, the trees, and the road stay as in @Video1.
```

能看清抓取、交接、进出场时，可以加少量条件：`Only after the chair joint is closed do the hands let go.` 看不清就不要按抽帧编时间段。编辑不能承诺逐帧重合。

用户点名 `@Image3` 做外观时，不要把另一张更清晰的图写进正文，也不要把它传去生成。

只改声音时，画面、口型时点、镜头和剪辑节奏仍属于母版。不要为了改一句台词重排动作。

```text
[Edit]
Strictly edit @Video1. Remove only the background music from the whole piece.

[Source]
@Video1 is the only edit master. It supplies the picture, actions, lip-sync timing, camera, the other sounds, and the event order.

[Scope]
Remove only the background music.

[Keep]
Keep the dialogue, lip sync, ambience, action sound, and the entire picture. no subtitles.
```

换音色或语言时，默认不改台词内容和张嘴的时点，除非用户明确要改词。

## 延长

只说「延长」、看不出方向时，问一次方向，不要猜。

新片段里同一个人始终是一个连续的身体，不复制、不分裂。转身、被挡住、出画再入画，仍是同一个。这条要写进正文，不能只在分析里检查。

延长只写原片边界之外的新画面。不要同时改 `@VideoN` 里已经出现的内容。边界要接上姿态、道具、背景、机位、光线、声音和运动趋势。不承诺像素级相同。额外参考不能覆盖边界那一帧。

向后，新片段的第一幅接尾帧：

```text
@Video1 is the video to extend forward in time.
@Image1 supplies the gardener's face, short hair, and pale green apron. Do not use the picture's background.
@Image2 supplies the structure and material of the wicker basket. Do not use the garden or the people in the picture.

Extend @Video1 forward in time. The first frame of the extension continues the last frame of @Video1: the greenhouse bench, the gardener's position and facing, the locked medium camera, and the afternoon side light all continue. Other references do not replace that boundary frame.

Then the gardener lifts the wicker basket defined by @Image2 from under the bench and sets it on the middle shelf behind them with both hands. End with the basket only on that shelf, the gardener's hands off it, one half-step back.

Through the extension the gardener and the basket each stay one continuous object. They are not duplicated or split. no subtitles, no music.
```

向前，先写原片开始之前发生的事，再把原片首帧写成延长段的结束状态。只写「随后承接原视频」，容易把后面的人或道具提前放进来。

```text
@Video1 is the video to extend backward in time.

Extend @Video1 backward in time. Before the original video starts, <one earlier event>.

The last frame of the extension meets the first frame of @Video1: <pose, props, background, camera, light, sound, and motion trend> match.

People, props, or effects that belong only later in @Video1 do not appear early.
Each subject stays one continuous object. It is not duplicated or split.
no subtitles, no music.
```

## 可选：关键帧

`@Image1 is the first frame.` 单独成句。`@Image2 is the last frame.` 也单独成句。不要写成 `opening reference` 或 `first-frame reference only`。角色句之外，另起一句写这一帧锁定的构图、位置、姿态、道具、场景和镜头方向。别的图再另起一句，不要和首帧句粘在一起。

首尾帧的画幅要一致。比例和时长本身不写进提示词，冲突交给使用说明。

```text
@Image1 is the first frame.
That first frame sets the baking bench, the decorator's position, the undecorated cake, and a frontal medium camera.
@Image2 is the last frame.
That last frame sets the finished cake in the center of the turntable, the decorator's hands off the cake, and the same frontal medium camera.
@Image3 supplies the decorator's face, pinned hair, and white coat. It does not change the first-frame composition of @Image1 or the last-frame composition of @Image2.
@Image4 supplies the cake's two tiers, white frosting, and blueberries. It does not change the first or last frame.

The picture starts from the first frame in @Image1. The decorator turns the turntable, pipes a continuous cream ridge on both tiers, sets the blueberries one by one, and takes their hands away, arriving at the last frame in @Image2.
Between the frames the cake stays the same object and the tools stay put. no subtitles, no music.
```

多张过程图：第一句先声明顺序，再逐张写关键状态。这是语义锚点，不是要求在某一张上停住，也不承诺逐帧复刻。

```text
Use @Image1 through @Image4, in that order, as keyframes.
@Image1 is the first frame.
That first frame sets <the opening composition and props>.
@Image2 is the second key state: <what is visible when this step ends>.
@Image4 is the last frame.
That last frame sets <the ending composition and props>.
The picture passes through these states in order, with continuous action between them. no subtitles, no music.
```

## 可选：宫格分镜

宫格只提供故事顺序和大致构图，不要求每格细节复刻。写明读取顺序，以及不采用的线、标注、占位人和格子的画法。

```text
@Image1 is a nine-panel storyboard. Read it left to right, top to bottom, for shot order and rough composition. Do not use the lines, the text inside the panels, or the placeholder people.
@Image2 defines the face and costume of <Subject>.

Shot 1: <shot size, action, place>.
Shot 2: <shot size, action, one camera move>.
Shot 9: <ending action and what is visible at the end>.

no subtitles, no music.
```

Seedance 2 / fast 保持 `Shot 1` 这种顺序。Seedance 2.5 在用户没给秒数时也可以用同样的镜头顺序；不要把格子编号改成 `0–3s`。

## 情绪、镜头、声音、产品

用户只给了情绪方向时，允许表演自己长出来。用户要控演技时用：情绪从哪到哪、触发事件、一两处看得到的反应、光或声音怎么跟着变。不要把眉、嘴、呼吸、手全部写满。

```text
After the returned letter is set on the table, the hand tracing the cup rim stops, and her eyes land on the return mark.
The brow tightens, the smile leaves, she inhales, and she turns the letter face down.
She looks at the empty chair opposite, shoulders still level, and says {I understand}.
```

用户只给了带引号的半句，就只说这半句。可以补表情和动作，不能把半句补成一段新台词。只描述说话意图、没有原文时，不编对白，改写口型、停顿和对方的反应。

景别、视场角和运镜从拍摄设定各选一句英文。每一镜只一种运镜：固定、手持、推近、拉远、摇、移、跟、环绕，选一个。不要同一镜又推又摇。机身/色调不要写进这一镜。

有多个人时写镜头跟着谁、从哪到哪：

```text
a medium shot, about to the waist. 47° field-of-view anchor, natural-looking subject proportions and a balanced view of the space. the camera travelling with the subject at their pace, from the door to the edge of the bed, ending above the waist. The horizon stays level.
```

一镜到底要写连续经过哪些人和空间，句子用拍摄设定里「一镜到底」的英文，再补经过的人和地方。手持要写跟着谁、晃动有多大（例如步行中上下约一掌），英文用拍摄设定里的手持句。变焦要写从哪一格视场到哪一格、在什么事件上完成；固定视场和变焦不能管同一段时间。浅景深、移焦、暗角写可见结果：谁清楚、背景如何化开、焦点从哪件物到哪件物、四角暗而中心仍正常。焦距和光圈的数字不能代替这句可见结果；设备、光、色和运镜都去拍摄设定取「写入」列。

声音用一种括号，不要混用。括号里的词用英文，除非 `{}` 里是用户指定要念的原文：

| 内容 | 符号 | 写进正文的例子 |
| --- | --- | --- |
| 音乐 | `()` | `(soft piano)` |
| 音效 | `<>` | `<a distant bell>` |
| 台词 | `{}` | `{Hello}` |
| 要出现的字幕 | `[]` | `[Chapter One]` |

音效占用了 `<>` 时，主体名不要再用尖括号，改用普通名字。

台词写：语言（仅当用户指定）+ 说话人 + `{原文}`。用户没指定口音或语种时，不要自行加上地区口音。多人对话逐段写谁在说，其他人闭口听。没给原文就不要编。

无对白：`Mouths stay closed. There is no narration. Only the named ambience remains. no subtitles.`

要出现的字，用英文说明位置和时机，文字本身若必须是别的语言，只保留那一串字符：

- 广告语：文字、何时出现、在画面哪一块、怎么出现、颜色。
- 字幕：底部字幕的原文，并写它跟着哪一句声音。
- 气泡：谁说 `{line}`，说话时旁边出现气泡，气泡里是同一句。

精确公式、小字标牌和产品参数不能靠提示词保证。正文仍按最好的写法给出；必要时在正文外加一行，说明要靠已经做好的画面或后期，不要把这句写进提示词。

产品不写「展示安装、运行和完成」。写成初始状态、一次操作、看得见的结果。每一阶段只一件事。

```text
Phase 1: The humidifier is off, the tank is empty, and the lid sits to the right of the body. The operator lifts the tank off and fills it with water. End with the water below the max line.
Phase 2: The tank goes back on, the lid closes, and the power key is pressed once. End with the hand off the key and the body unmoved.
Phase 3: A fine white mist rises from the nozzle. The desktop stays dry. End with the same body, tank, and lid as at the start.
no subtitles, no music.
```

## 样例

路径 A，吃蛋糕：

```text
Using the short-haired girl in @Image1, she sits by the window and eats cake. Warm daylight falls on the table. Her hands move only a little. no subtitles, no music.
```

路径 A，编辑：

```text
Strictly edit @Video1: replace the passers-by with an empty street. The rest of the street and the light stay as in @Video1. Apart from the objects named above, every other visible person, prop, and background element in @Video1 stays as it is and is not replaced or removed. no subtitles, no music.
```

路径 A，向后延长：

```text
Extend @Video1 forward in time. The new picture continues from the last frame. She is the same person. She sets the cup on the counter and lets go. Do not change anything already visible in @Video1. no subtitles, no music.
```

路径 A，一套景别、视场和运镜，机身/色调只写一次：

```text
Using the short-haired girl in @Image1, she sits by the window and eats cake. a medium shot, about to the waist. 47° field-of-view anchor, natural-looking subject proportions and a balanced view of the space. locked-off stable framing throughout this time range. film texture without heavy grain, gentle highlight roll-off, natural skin rendering. neutral realistic colour from the scene materials, white balance matched to the intended light. Her hands move only a little. no subtitles, no music.
```

机身是 iPhone 原相机。全片只有那一句观感。分镜写景别和一种运镜，不写视场角、光圈或焦段：

```text
iPhone native-camera look, computational HDR, clean digital sharpness, colour and contrast as the built-in camera app recorded them.
Shot 1: a medium shot, about to the waist. the camera travelling with the subject at their pace. She walks to the door and stops.
Shot 2: a close-up, the face or one object filling most of the frame. locked-off stable framing throughout this time range. She looks up.
no subtitles, no music.
```

Seedance 2 / fast 的分镜。机身/色调在分镜外一次。每一镜的视场和运镜不同：

```text
film texture without heavy grain, gentle highlight roll-off, natural skin rendering. neutral realistic colour from the scene materials, white balance matched to the intended light.
Shot 1: a medium shot, about to the waist. 47° field-of-view anchor, natural-looking subject proportions and a balanced view of the space. the camera travelling with the subject at their pace. She walks to the door at a walking pace and stops.
Shot 2: a close-up, the face or one object filling most of the frame. 29° field of view, the background pulling up behind the face, the subject isolated from the room. locked-off stable framing throughout this time range. She looks up.
no subtitles, no music.
```

Seedance 2.5，且用户已经给了时间段：

```text
0-5s: she pushes the door and enters. End standing at the counter.
5-10s: she sets the cup down. End with both hands off the cup.
no subtitles, no music.
```

手冲，三份素材都有职责：

```text
[Goal]
Generate a continuous picture of the barista finishing a pour-over and handing the coffee to the customer.

[References]
@Image1 supplies the barista's face, short hair, and brown apron. Do not use the picture's background.
@Image2 supplies the cafe's wooden bar, glass window, and afternoon warm light. Do not use the people in the picture.
@Video1 supplies the wrist rhythm of the pour. Do not use the people, costume, or place in the video.

[Events]
Start with the barista inside the bar and the customer outside it, the dripper between them. The barista pours at the rhythm of @Video1, returns the dripper to the stand, and hands over the only cup with both hands. End with the coffee only in the customer's hands.

[Keep]
Keep the barista's apron, who stands inside or outside the bar, and the cup count. no subtitles, no music.
```

## 交付

默认只交英文提示词正文。不要加讲解标题、代码围栏或「优化说明」。正文内部的 `[Goal]`、`[References]`、`[Events]`、`[Keep]` 可以留。

推断出来的映射写进职责段，不另附推理表。正文只出现真正使用的编号。没写进去的素材不要传去生成。

和时长、比例、分辨率或素材上限冲突时，正文照写，正文外最多一句冲突说明，不把这些数字写回提示词。没有冲突就不要这句。两步任务在正文外标明第一步和第二步，并写明第二步用第一步的成片做新母版。两段正文各自仍是英文。

写完再看一遍：

- 主任务只有生成、编辑或延长里的一种；混合任务已经拆成两步。
- 身份、数量、道具归属、结局没有被素材带跑。
- 每个用到的素材只有一件事。正文没有未使用清单。提交只带正文里点到的素材。
- 用户原来的序号还在，中文 `@图片` 已改成 `@Image`，没有新造用户没写过的编号，也没有假装看过读不到的文件。
- `@ImageN` 后面是名词，没有裸的素材 ID。
- 编辑有唯一母版、范围闭环和时间线继承；没有写成「参考 @视频N」，也没有写成 `reference @VideoN`。
- 延长方向和边界帧正确，同一个人没有变成两个，原片里的内容没有被改写。
- 首帧、尾帧各自单独成句。
- 宫格写了读取顺序，线、标注和占位不当成画面。
- Seedance 2 / fast 用 `Shot 1`，没有 `0–3s`。Seedance 2.5 的秒数都是用户给的，连续且不重叠。
- 路径 A 的景别、视场角、运镜如果写了，整段只有一套。机身/色调如果写了，全片只有一次。
- 路径 B 的每一镜都有景别、视场角和一种运镜，句子来自拍摄设定，镜与镜可以不同。机身/色调不在每一镜重复。机身是 iPhone 原相机时，不写视场角、光圈、景深、镜头、色板、类型或调色；每一镜仍可写景别和一种运镜。
- 拍摄设定只放了选中的英文句子；没选的维度没有写成 `Auto`。
- 用户没要字幕和音乐时，有 `no subtitles, no music`，且没有自动加画质包、水印或 Logo。
- 正文里没有中文句子。占位符都换成了具体的英文。
