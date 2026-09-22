# AI 音乐导师

[English](README.md) | [中文](README-zh.md)

面向初中级钢琴学习者的中文钢琴练习应用。导入乐谱或 MIDI，用 MIDI 键盘或麦克风弹一遍，得到诊断、针对性微练习、伴奏重弹和前后对比。

## 打开网页版

**<https://ai-music-mentor.onrender.com/>**

不用装任何东西。三件要知道的事：

- **用 Chrome 或 Edge。** MIDI 键盘走 Web MIDI，Safari 和 Firefox 没有这个接口。麦克风哪个浏览器都行。
- **闲置 15 分钟会休眠。** 之后第一次打开要等约 40 秒。演示前先打开一次，它就是热的。
- **练习历史不跨重启。** 重新部署就清空，曲库和诊断照常，只是上一轮的记录不留。

## 本地运行

macOS / Linux：

```bash
bash launch.sh
```

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\launch.ps1
```

脚本会在首次启动时安装依赖、创建或更新数据库、构建网页、启动服务，并打开 <http://127.0.0.1:8000>。不用全局安装 pnpm，也不用手动创建 Python `.venv`。

停止：

```bash
bash quit.sh
```

```powershell
powershell -ExecutionPolicy Bypass -File .\quit.ps1
```

只停从当前目录启动的服务。

两点提醒：

- 改完代码要先 `quit` 再 `launch`，否则打开的还是上一次的构建。
- 别直接双击 `apps/web/index.html`，它需要后端服务才能工作。

## 自己部署

用在服务器上，或者任何想把每一步记下来而不是塞进脚本的地方。需要 Python 3.12+ 和带 pnpm 11 的 Node.js（`corepack enable` 即可）。

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt                        # API 导入的全部 Python 包
(cd apps/web && pnpm install --frozen-lockfile && pnpm build)    # API 一并提供的页面
(cd apps/api && ../../.venv/bin/python -m alembic upgrade head)  # 创建或更新数据库
(cd apps/api && ../../.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000)
```

一个进程就是整个应用：API 在同一个端口把构建好的页面一起发出去，地址是 <http://你的主机:8000>。Windows 上的解释器是 `.venv\Scripts\python`。容器跑的是同样的步骤，`compose.yaml` 和 `render.yaml` 只是把它们包起来。

## 设置

右上角的齿轮里有四项，都是立刻生效的：

- **明暗** —— 浅色 / 深色 / 跟随系统。
- **琴身** —— 乌木、红木、胡桃木、象牙。只改琴身和背景：谱面永远是纸，错音永远是红色，换主题不用重新认识报告。
- **语言** —— 简体中文 / English / 跟随系统。首次打开按浏览器语言判断，繁体也归到简体。录音过程中切换不会中断这一遍。
- **详细程度** —— 标准只说该练什么；专业再加上逐条证据、每个音的把握、双手分开的统计，以及这次录音本身的质量（房间底噪、采用与丢弃的音数）。

## 支持的输入

- **`.musicxml` / `.xml` / `.mxl`** —— 保留原始精确记谱。
- **`.mid` / `.midi`** —— 原始 MIDI 作为播放时间线，界面显示标注清楚的量化简化谱。导入后复核速度、拍号和左右手映射。
- **`.pdf` 和照片**（`.png` / `.jpg` / `.webp` / `.heic`）—— 交给视觉模型识谱，一次最多 2 页。识谱结果要复核，调号、连音和左右手最容易读错。

## 配置模型（可选）

不配也能用：应用会退回确定性的中文规则导师，完整练习闭环照常工作。要接 OpenAI 兼容的 provider：

```bash
cp .env.example .env      # 然后填 MENTOR_API_KEY
```

主要几项，`.env.example` 里每个值都写了为什么是这个数：

```bash
MENTOR_API_BASE=https://openrouter.ai/api/v1
MENTOR_API_KEY=你的-key
MENTOR_MODEL=openai/gpt-oss-120b     # 实测选出：三类调用最坏 2.1s
MENTOR_MAX_OUTPUT_TOKENS=4000        # 1600 会把练习计划截断，白费一次调用
MENTOR_PROVIDER_ORDER=cerebras,groq  # 一个值，逗号是它的一部分，别拆成两条
VISION_MODEL=xiaomi/mimo-v2.5        # 识谱；不填就沿用上面的 base/key
```

凭据只留在服务端。`.env` 不在 Git 里，网页版的 key 存在 Render 那边。

改模型或超时之前先量一下：

```bash
.venv/bin/python scripts/bench_mentor_models.py
```

## 测试

```bash
python -m pytest tests -q          # 后端、导入器、算法回归
cd apps/web && pnpm test           # 前端状态机
pnpm build                         # 类型与生产构建
pnpm test:e2e                      # mocked Web MIDI 流程；首次先运行：
                                   # pnpm exec playwright install chromium
```

## 更多

- API 文档在服务自己身上：<https://ai-music-mentor.onrender.com/docs>（本地是 <http://127.0.0.1:8000/docs>）。
- 设计取舍见 [v2 架构](docs/architecture-v2.md)，硬件验收见 [USB MIDI 清单](docs/hardware-acceptance.md)。

## 许可证

[MIT](LICENSE)
