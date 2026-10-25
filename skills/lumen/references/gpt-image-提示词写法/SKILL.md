---
name: "GPT Image 提示词写法"
description: "GPT Image 出图和改图的提示词写法。只写正文，不提交。"
---

# GPT Image 提示词写法

本文件的说明用中文。交给模型的提示词正文只用英文：模板、样例、约束都是英文。不要把中文写进模型收到的正文。

本文件只写提示词，不提交任务。三支模型共用这一份：`gpt-image-2`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`。选哪一支、比例、分辨率、质量、背景、参考图和提交读 `gpt-image/SKILL.md`。那些参数不写进提示词，本文件也不列参数表。模型名不写进正文。正文里可以写成品自己的方向，例如竖条四格漫画、一张横幅幻灯片，因为那是画面结构，不是像素或比例开关。

没有参考图就是生成。有参考图就是改图或合成。不要把 Seedance 的镜头时间轴、延长、`@ImageN`、`@VideoN`、`@AudioN` 写进这张图的正文。用户原稿里的 `@图片N` 按同一序号改成 `image N`。

## 拍摄设定

用户要设备、镜头、视场、光圈或景深、光、色、类型、调色、运镜、运镜风格或变速时，从 `skills/lumen/references/拍摄设定/SKILL.md` 的「写入」列取英文句子。这里不列预设，不抄整表，不把中文名称或编号写进正文。

静帧只有一幅画面，句子不要拆进视频分镜：

- **机身/色调**：机身或胶片感、色板、类型里的光和色、调色。全图只写一次，放在细节或约束。
- **景别**：跟主体的取景写在一起，全图一次。它决定人或物在画面里有多大。
- **运镜**：静帧默认不写。用户明确要镜头运动的观感时，全图只加一种运镜的英文句子。运镜风格和变速不代替那一种运镜。

用户没点这些维度，就用看得见的英文写光线、材质和取景，不要为了凑词打开整张预设表，也不要自造一套焦段或光圈。

机身是 iPhone 原相机时，机身/色调只写拍摄设定里那一句英文：

`iPhone native-camera look, computational HDR, clean digital sharpness, colour and contrast as the built-in camera app recorded them.`

不写镜头、焦段、视场角、光圈、景深、色板、类型、调色，也不写胶片感，不再加手机型号或镜头商品名。景别仍可写。用户明确要求时仍可加一种运镜，不写视场角，不写光圈或焦段编号。官方文档里 “iPhone photo” 也能把模型推向实拍；在本仓库里，选了原相机就不要再写这句或任何镜头参数，没选原相机也不要用它代替上面那一句。

相机规格是外观提示，不是物理仿真。即使用了焦段或光圈的英文句子，也不要把它写成真实镜头的曝光计算。

## 原则

1. **先定结果**。写出主体，以及这张图拿来做什么：产品照片、广告、流程图、课堂图、界面、幻灯片、标志、漫画格子。用途决定精细程度和版式，不要只丢一个风格词。
2. **复杂的按四段写**。场景、主体、细节、约束。能短则短，四段可以并成一段，但这四件事要在。简单的一张抓拍不必贴标签。
3. **格式选好改的**。短句、一段叙述、分节、类似 JSON 的字段、指令句、标签，都能表达同一意图。选读起来好改的，不要依赖特殊语法。没有魔法词。
4. **一次一件事**。生成、改图、多图合成只能有一个主任务。又要换场景、又要改衣服、又要换天气时，拆成多步，每步一条提示词。
5. **改图写「只改什么」和「必须留下什么」**。`Change only ...` 配上身份、几何、版式、光线、文字、周围物体。局部手术还要写明饱和、反差、箭头、机位、旁边的东西都不动。
6. **一张参考一个职责**。按上传顺序从 1 编号。正文写到的才上传。没上传就不要虚构 `image 1`。不要写 `these images`。
7. **一轮只改一处**。上一张结果当作下一步的输入。`same style as before` 可以带着上文，但关键约束一旦漂了就要重写。每轮看完再加下一句。
8. **不滥加禁令**。用户没提的水印、Logo、画质包不要自动堆上。图中文字、透明背景、身份锁定这些，是任务需要才写。
9. **事实和观察分开**。地点、日期、品牌名、数据、标签以用户文字为准。参考图只补直接看见的东西。读不到图就不要声称看过，也不要补只有看过才能确定的五官或包装文字。
10. **默认一条**。用户没要多个变体时只出一条正文。
11. **正文只留可提交的英文**。不写分析、评测、密钥、修改理由。

用户只给了很高的想法、没有主体也没有用途时，问一次：画什么、给谁看、有没有参考。不要先编一张脸。已经有泛指主体和清楚动作时，保留泛指，不要为了显得具体停下来。

## 四段

1. **场景**。地点、时间、天气、背景远近。没有场景的隔离主体就写透明或纯色背景，并写明不要风景。
2. **主体**。谁或什么，在画面的哪，多大，朝哪看，手和物体怎么接触。
3. **细节**。材质、颜色、光线、介质（照片、水彩、扁平矢量、三维渲染）。用户点了的机身/色调放这里，只写一次。
4. **约束**。必须出现的文字、禁止的额外文字、要保留的身份和几何、不要的水印或商标。改图把保留清单放在这里，并在每一轮重复。

位置要写明。标志在右上、主体居中且左边留白、人站在画面中央但视线离开镜头，都是构图，不是参数。

宽幅、低光、雨、霓虹不要只写氛围。补尺度、空气和具体颜色，例如湿沥青反出的品红和青色、人与人之间大约一掌的距离、木桌上的一盏低暖灯。否则模型会用氛围换掉表面的真实。

## 实拍

目标是照片时，正文里直接写 `photorealistic` 或 `real photograph`。同类说法还有 `taken on a real camera`、`professional photography`。再写取景和纹理：毛孔、皱纹、磨损的布、日常细节。避免把画面写成棚拍抛光或摆拍，除非用户要的就是棚拍。

下面是官方的抓拍写法。其中 `35mm` 和 `50mm` 只是外观提示。用户已经从拍摄设定选了机身或镜头时，不要再叠这组焦段，改用拍摄设定的英文句子。选了 iPhone 原相机时，这组焦段、胶片颗粒和景深都不要写。

```text
Create a photorealistic candid photograph of an elderly sailor standing on a small fishing boat.
He has weathered skin with visible wrinkles, pores, and sun texture, and a few faded traditional sailor tattoos on his arms.
He is calmly adjusting a net while his dog sits nearby on the deck. Shot like a 35mm film photograph, medium close-up at eye level, using a 50mm lens.
Soft coastal daylight, shallow depth of field, subtle film grain, natural color balance.
The image should feel honest and unposed, with real skin texture, worn materials, and everyday detail. No glamorization, no heavy retouching.
```

选了 iPhone 原相机、又要中景时，机身只留那一句，景别可以留：

```text
Scene: a narrow alley after rain, wet asphalt, one low warm lamp on a wooden stall.
Subject: a courier paused beside the stall, a medium shot about to the waist, looking down at a paper cup, both hands around the cup.
Details: iPhone native-camera look, computational HDR, clean digital sharpness, colour and contrast as the built-in camera app recorded them.
Constraints: photorealistic, real skin texture, no extra text, no watermark.
```

## 人、比例、视线、动作

写身体在画面里的范围、和周围物体比有多大、视线落点、手和物体怎么接触。这些句子比「自然一点」有用：

- `full body visible, feet included`
- `child-sized relative to the table`
- `looking down at the open book, not at the camera`
- `hands naturally gripping the handlebars`

缺了这些，比例、动作几何和视线容易漂。不要用空泛的情绪词代替姿势。身份和关系以用户文字为准；只有「一个女孩」就保留泛指，不要发明五官。

## 图中文字

要出现的句子放进引号，写位置和字体：字重、大小、颜色、对齐、字距。说明出现几次。不寻常的品牌或拼写按字母拆开。然后要求没有额外文字。生成后自己核对拼写和是否认得清。

小字、密信息、多种字体，在命令上用更高的质量档再比较。质量档不写进正文。

广告要把品牌、受众、场景和原句放在同一条里。原句只出现一次：

```text
Give me a cool in culture ad / fashion shot for a brand called Thread.
It's a hip young street brand. The ad shows a group of friends hanging out together with the tagline "Yours to Create."
Make it feel like a polished campaign image for a youth streetwear audience: stylish, contemporary, energetic, and tasteful.
Use clean composition, strong color direction, natural poses, and premium fashion photography cues.
Render the tagline exactly once, clearly and legibly, integrated into the ad layout.
No extra text, no watermarks, no unrelated logos.
```

把产品放进已经有的场景、又要指定广告句时，原句逐字引用，并写没有多余字符：

```text
Create a realistic billboard mockup of the shampoo on a highway scene during sunset.
Billboard text (EXACT, verbatim, no extra characters):
"Fresh and clean"
Typography: bold sans-serif, high contrast, centered, clean kerning.
Ensure text appears once and is perfectly legible.
No watermarks, no logos.
```

难拼的名字先拆字母，再要求只出现一次：

```text
Render the brand name once, spelled letter by letter as F, I, E, L, D, space, ampersand, space, F, L, O, U, R.
Bold serif, centered under the mark. No extra text, no watermark.
```

节日卡和包装只留用户给的那一句：

```text
Create a Christmas holiday card illustration.

Scene:
a cozy Christmas scene with an old teddy bear sitting inside a keepsake box, slightly worn fur, soft stitching repairs, placed near a window with falling snow outside. The scene suggests the child has grown up, but the memories remain.

Mood:
Warm, nostalgic, gentle, emotional.

Style:
Premium holiday card photography, soft cinematic lighting, realistic textures, shallow depth of field, tasteful bokeh lights, high print-quality composition.

Constraints:
- Original artwork only
- No trademarks
- No watermarks
- No logos

Include ONLY this card text (verbatim):
"Merry Christmas — some memories never fade."
```

周边看材质、包装和印刷是否清楚，并保持原创、不侵犯现成商标：

```text
Create a collectible action figure of a vintage-style toy propeller airplane with rounded wings, a front-mounted spinning propeller, slightly worn paint edges, classic childhood proportions, designed as a nostalgic holiday collectible, in blister packaging.

Concept:
A nostalgic holiday collectible inspired by the simple toy airplanes children used to play with during winter holidays. Evokes warmth, imagination, and childhood wonder.

Style:
Premium toy photography, realistic plastic and painted metal textures, studio lighting, shallow depth of field, sharp label printing, high-end retail presentation.

Constraints:
- Original design only
- No trademarks
- No watermarks
- No logos

Include ONLY this packaging text (verbatim):
"Christmas Memories Edition"
```

## 改图

编辑句式是 `Change only X` 再加保留清单。短的移除也可以是 `Do not change anything else`，但对象必须点名。反复改仍会漂：每一轮重述要保住的身份、几何、版式、光线和文字，并检查这一轮是不是只动了那一处。某一块必须和原图像素一致时，不要指望提示词，把改好的区域合成回原图。

只换一把椅子，相机、光线、地面影子和周围物体都留住：

```text
In this room photo, replace ONLY the white chairs with chairs made of wood.
Preserve camera angle, room lighting, floor shadows, and surrounding objects.
Keep all other aspects of the image unchanged.
Photorealistic contact shadows and fabric texture.
```

只拿走手里的花：

```text
Remove the flower from the man's hand. Do not change anything else.
Preserve the man, his pose, the lighting, and the framing.
```

只翻译图里的字，版式、图标和其余图像不动。译完检查有没有漏网的原文，以及有没有多出来的词：

```text
Translate the text in the infographic to Spanish. Do not change any other aspect of the image.
```

换衣服时锁住人，只换衣服。光线、阴影和色温要跟原照片走，避免像贴上去。这同样适用于必须认得出的产品和物体：

```text
Edit the image to dress the woman using the provided clothing images. Do not change her face, facial features, skin tone, body shape, pose, or identity in any way. Preserve her exact likeness, expression, hairstyle, and proportions. Replace only the clothing, fitting the garments naturally to her existing pose and body geometry with realistic fabric behavior. Match lighting, shadows, and color temperature to the original photo so the outfit integrates photorealistically, without looking pasted on. Do not change the background, camera angle, framing, or image quality, and do not add accessories, text, logos, or watermarks.
```

草图变实拍时，布局、比例和透视按原图，材质和光要符合草图的意图，不要新添物体或文字：

```text
Turn this drawing into a photorealistic image.
Preserve the exact layout, proportions, and perspective.
Choose realistic materials and lighting consistent with the sketch intent.
Do not add new elements or text.
```

把人放进新场景时，写自然光、可信的细节、身体范围、视线，以及和场景的关系。脸和比例哪些不能变要写明。画面要像有人真的拍到，而不是海报：

```text
Generate a highly realistic action scene where this person is running away from a large, realistic brown bear attacking a campsite. The image should look like a real photograph someone could have taken, not an overly enhanced or cinematic movie-poster image.
She is centered in the image but looking away from the camera, wearing outdoorsy camping attire, with dirt on her face and tears in her clothing. She is clearly afraid but focused on escaping, running away from the bear as it destroys the campsite behind her.
The campsite is in Yosemite National Park, with believable natural details. The time of day is dusk, with natural lighting and realistic colors. Everything should feel grounded, authentic, and unstyled, as if captured in a real moment. Avoid cinematic lighting, dramatic color grading, or stylized composition.
Preserve her face, facial proportions, and identity.
```

风格迁移要写参考图贡献的是调色、纹理还是介质，新主体分开写，并限制背景和多余元素：

```text
Image 1 is the style reference. Use only its palette, texture, and visual medium.
Generate a man riding a motorcycle on a white background.
Do not copy the original subject. No extra elements, no text.
```

## 多张参考

每张图按序号加职责：主体、风格、衣服、背景。写清怎么合、哪一块从哪张搬到哪。被改的主图放在 `image 1`，除非用户已经规定了别的顺序。编号按实际上传顺序，不因读不到文件就改号。

官方的短句可以直接用。第二张的狗进入第一张的场景，其余不动：

```text
Place the dog from the second image into the setting of image 1, right next to the woman, use the same style of lighting, composition and background. Do not change anything else.
```

职责一多，就先分行定义再写动作。衣服图各自只贡献那一件衣服：

```text
Image 1: the woman to keep. Do not change her face, facial features, skin tone, body shape, pose, or identity.
Image 2: the jacket. Use it only as the jacket.
Image 3: the boots. Use them only as the boots.
Replace only the clothing. Fit the garments to her existing pose and body geometry with realistic fabric behavior.
Match lighting, shadows, and color temperature to image 1 so the outfit does not look pasted on.
Do not change the background, camera angle, or framing. No accessories, no text, no logos, no watermarks.
```

同一人的多张图要写明是同一个人，成片里只有一个，并分开写每张补什么（脸、全身、衣服）。两张图里两个已命名的人不要并成一个。一张单人图不要同时定义两个会同时出场的人。越要锁脸的图，在提示词里越靠前。

## 一轮只改一件事

先有一张干净的底，检查，再把这张输出当作下一次编辑的输入。跟进只改一个条件。官方的短跟进是：

```text
Make it look like a winter evening with snowfall.
```

身份、产品、文字或机位开始漂时，不要再加新要求。把保留清单写回去，仍然只改天气：

```text
Change only the weather to a winter evening with snowfall.
Preserve the people, the product, the billboard text "Fresh and clean", the camera angle, the layout, and the framing.
Do not change saturation or contrast except for the snow and the evening light.
```

`same style as before` 可以指向上一轮，但不能代替必须逐字保住的文字、脸或产品几何。那些在漂了之后要重写进这一轮。

多页故事先做一张角色设定，后面换场景时重复定义性细节，并写 `Do not redesign the character`。

设定：

```text
Create a children's book illustration introducing a main character.

Character:
A young, storybook-style hero inspired by a little forest outlaw, wearing a simple green hooded tunic, soft brown boots, and a small belt pouch.
The character has a kind expression, gentle eyes, and a brave but warm demeanor.
Carries a small wooden bow used only for helping, never harming.

Theme:
The character protects and rescues small forest animals like squirrels, birds, and rabbits.

Style:
Children's book illustration, hand-painted watercolor look, soft outlines, warm earthy colors, whimsical and friendly.
Proportions suitable for picture books (slightly oversized head, expressive face).

Constraints:
- Original character (no copyrighted characters)
- No text
- No watermarks
- Plain forest background to clearly showcase the character
```

续一页时，环境可以变，衣服、五官、比例和调色板要重复：

```text
Continue the children's book story using the same character.

Scene:
The same young forest hero is gently helping a frightened squirrel out of a fallen tree after a winter storm.
The character kneels beside the squirrel, offering reassurance.

Character Consistency:
- Same green hooded tunic
- Same facial features, proportions, and color palette
- Same gentle, heroic personality

Style:
Children's book watercolor illustration, soft lighting, snowy forest environment, warm and comforting mood.

Constraints:
- Do not redesign the character
- No text
- No watermarks
```

## 透明背景

透明要两件事一起做：正文写隔离主体，命令上把背景设为透明，输出用 PNG 或 WebP。JPEG 没有透明通道。PNG 不要再设压缩，那个开关只属于 JPEG 或 WebP。这些开关不进正文，也不在这里列表。

正文要排除实底、风景、棋盘格和水印。画出来的棋盘格不是透明。头发、玻璃、影子和边缘要留住真正的透明通道，不要涂成格子。后续每一轮都重写 `preserve the transparent background`，否则下一步会铺回不透明的场景。文件保持 PNG 或 WebP；转成没有透明通道的图会把背景丢掉。

标志要原创、不侵犯，形状在小尺寸和大尺寸都认得清，四周留出空隙：

```text
Create an original, non-infringing logo for a company called Field & Flour, a local bakery.
The logo should feel warm, simple, and timeless. Use clean, vector-like shapes, a strong silhouette, and balanced negative space.
Favor simplicity over detail so it reads clearly at small and large sizes. Flat design, minimal strokes, no gradients unless essential.
Fully transparent background. Deliver a single centered logo with generous padding, clean alpha edges, and no solid backdrop, scenery, checkerboard, or watermark.
```

从照片里抽出产品时，几何和标签保持可读，只做轻度修边：

```text
Extract the product from the input image and isolate it on a fully transparent background.
Output: centered product, crisp silhouette, no halos/fringing.
Preserve product geometry and label legibility exactly.
Add only light polishing. Do not add a solid backdrop, checkerboard, scenery, or shadow.
Do not restyle the product; remove the background and preserve clean alpha transparency.
```

下一轮如果还要改这张透明图，先重复透明，再写那一处改动：

```text
Change only the label color to a deeper green.
Preserve the transparent background, the product geometry, the label wording, and the clean alpha edges.
Do not add a solid backdrop, checkerboard, scenery, or shadow.
```

## 按用途写

用途写在开头，用来设定「这是成品」而不是概念图。下面每类都给出可以直接改写的英文正文。

信息图要写过程、受众，以及读者要从图上看懂的关系。标签和事实关系生成后要核对，不要只看好不好看：

```text
Create a detailed infographic of the functioning and flow of an automatic coffee machine like a Jura.
From bean basket, to grinding, to scale, water tank, boiler, etc.
I'd like to understand technically and visually the flow.
```

漫画一格一个看得见的动作，不要一格里塞完整段剧情：

```text
Create a short vertical comic-style reel with 4 panels.
Panel 1: The owner leaves through the front door. The pet is framed in the window behind them, small against the glass, eyes wide, paws pressed high, the house suddenly quiet.
Panel 2: The door clicks shut. Silence breaks. The pet slowly turns toward the empty house, posture shifting, eyes sharp with possibility.
Panel 3: The house transformed. The pet sprawls across the couch like it owns the place, crumbs nearby, sunlight cutting across the room like a spotlight.
Panel 4: The door opens. The pet is seated perfectly by the entrance, alert and composed, as if nothing happened.
```

界面按已经上线的产品来写：层级、间距、真实控件。不要写成概念艺术：

```text
Create a realistic mobile app UI mockup for a local farmers market.
Show today's market with a simple header, a short list of vendors with small photos and categories, a small "Today's specials" section, and basic information for location and hours.
Design it to be practical and easy to use. White background, subtle natural accent colors, clear typography, and minimal decoration.
It should look like a real, well-designed app for a small local market.
Place the UI mockup in an iPhone frame.
```

科学图按教案写：受众、要讲清的关系、必须出现的部件、不要出现的东西。箭头、标签和留白要够学生扫读：

```text
Create a simple biology diagram titled "Cellular Respiration at a Glance" for high school students.

Show how glucose turns into energy inside a cell. Include glycolysis, the Krebs cycle, and the electron transport chain.
Use arrows to connect the steps, and label the main molecules: glucose, pyruvate, ATP, NADH, FADH2, CO2, O2, and H2O.
Make it look like a clean classroom handout or slide, with a white background, simple icons, clear labels, and easy-to-read text.

Avoid tiny text, extra decoration, or anything that makes the diagram hard to understand.
```

幻灯片、图表按成品规格写，不要按插画写。交付物、层级、真实文字和数据都放进正文。数字是用户给的；下面的市场规模是示例，换成用户的数，不要假装它们是事实：

```text
Create one pitch-deck slide titled "Market Opportunity" that feels like a real Series A fundraising slide from a YC-backed startup.

Use a clean white background, modern sans-serif typography like Inter, and a crisp, minimal layout. The slide should include:

- A TAM/SAM/SOM concentric-circle diagram in muted blues and grays
- TAM: $42B
- SAM: $8.7B
- SOM: $340M
- A clean bar chart below showing market growth from 2021 to 2026, with a subtle upward trend
- Small footnotes: "AGI Research, 2024" and "Internal analysis"
- A company logo placeholder in the bottom-right corner

The design should look like it belongs in a deck that actually raised money: highly readable text, clear data hierarchy, polished spacing, and professional startup-style visual language.

Avoid clip art, stock photography, gradients, shadows, decorative elements, or anything that feels generic or overdesigned.
```

地点加日期可以带出时代，但衣服、场面和周围环境要自己核对，模型推断不等于史料：

```text
Create a realistic outdoor crowd scene in Bethel, New York on August 16, 1969.
Photorealistic, period-accurate clothing, staging, and environment.
```

分节和类似 JSON 的字段只是同一四段的另一种排法，内容仍然是场景、主体、细节、约束：

```text
{
  "use": "product photograph",
  "scene": "a small fishing boat on calm water in late morning",
  "subject": "an elderly sailor adjusting a net, a dog sitting on the deck",
  "details": "weathered skin, faded tattoos, worn rope, soft coastal daylight",
  "constraints": "photorealistic candid photograph, no extra text"
}
```

## 写完核对

交出去之前看这四件，缺的补进正文，不要在文末再挂一套空泛的画质包：

- 要求出现的文字是否准确、认得清。图解的标签和箭头关系是否对。
- 身份、产品几何、包装文字和参考细节是否还在。
- 改图是否只动了要求的那一处。饱和、反差、机位、周围物体有没有被连带改掉。
- 要透明时，文件是不是真有透明通道，而不是一块画出来的棋盘格或实底。头发、玻璃、影子和边缘要单独看。

然后才决定要不要再开一轮。一轮只加一处修改。
