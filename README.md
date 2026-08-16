# AI Music Mentor

面向初中级钢琴学习者的中文优先桌面 Chromium 应用：导入乐谱或 MIDI，用 USB MIDI 键盘演奏，获得可核验证据、确定性诊断、微练习、伴奏重试和前后对比。

这仍是单用户 Demo，但核心边界已经按真实产品设计：版本化 API、统一导入契约、SQLAlchemy/Alembic、文件存储接口、持久化分析任务、录音双重恢复、受约束的模型解释和同源发布。

## 快速开始

打开 [ai-music-mentor.onrender.com](https://ai-music-mentor.onrender.com/)，不用装任何东西。

- **用 Chrome 或 Edge。** MIDI 键盘走 Web MIDI，Safari 和 Firefox 没有这个接口；麦克风路径各家浏览器都行。
- **闲置 15 分钟会休眠。** 之后第一次打开要等约 40 秒冷启动（实测）。演示前先打开一次，它就是热的。
- **练习历史不跨重启。** 数据库在容器里，重新部署即清空；曲库、诊断、练习生成都照常，只是上一轮的记录不留。

## 本地运行

macOS 或 Linux：

```bash
bash launch.sh
```

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\launch.ps1
```

两个启动器都会构建应用、执行数据库迁移、启动服务并打开正确的网址。首次启动若缺少项目依赖，会通过 pnpm/Corepack 和本地 Python `.venv` 自动安装；之后不要求系统全局安装 pnpm。

不要直接双击 `apps/web/index.html` 或 `apps/web/dist/index.html`：这个产品需要 FastAPI 分析服务，并且浏览器会阻止 `file://` 页面加载 Vite 模块。现在即使误开 index，也会显示正确的启动说明，不再是一片空白。

启动后会自动打开 [http://127.0.0.1:8000](http://127.0.0.1:8000)。脚本构建前端、执行 Alembic 迁移，并由 FastAPI 同源提供页面与 `/api/v1`。

## 停止

关闭启动脚本所在的终端即可停止服务。如果终端已经关掉，或者服务在后台还占着端口：

```bash
bash quit.sh
```

```powershell
powershell -ExecutionPolicy Bypass -File .\quit.ps1
```

只会停掉从当前目录启动的服务；别人占用同一个端口的进程会被指出来，但不会被结束。

## 支持的输入

- `.musicxml` / `.xml` / `.mxl`：保留原始精确记谱。MXL 在读取前检查文件签名、解压大小、路径穿越、链接与加密条目。
- `.mid` / `.midi`：原始 MIDI 保留为权威播放时间线；界面显示明确标注的量化简化谱。缺失速度默认 Standard MIDI 的 120 BPM，缺失拍号默认 4/4。
- `.pdf` 和照片（`.png` / `.jpg` / `.webp` / `.heic`）：交给 Xiaomi-MiMo-V2.5 识谱，一次最多 2 页，长边压到 1600 像素再上传。识谱结果和其他导入走同一套校验，但仍要复核——调号、连音和左右手归属是最容易读错的地方。

MIDI 导入后必须复核速度、拍号、量化网格和轨道/左右手映射。简化谱不会声称拥有原始指法或声部。

## 模型导师配置

不配置 provider 时，应用使用确定性的中文规则导师，完整练习闭环仍可工作。接入 OpenAI-compatible provider 时，把凭据留在服务端：

```bash
MENTOR_API_BASE=https://openrouter.ai/api/v1
MENTOR_API_KEY=replace-with-your-server-side-api-key
MENTOR_MODEL=openai/gpt-oss-120b     # 实测选出：三类调用最坏 2.1s
MENTOR_RESPONSE_MODE=json_schema     # json_schema | json_object | prompt_json
MENTOR_REASONING_EFFORT=low          # gpt-oss 关不掉推理并拒绝 none，给它最便宜的一档
MENTOR_CONNECT_TIMEOUT_SECONDS=8
MENTOR_READ_TIMEOUT_SECONDS=25       # 实测最坏值的十倍
MENTOR_TIMEOUT_SECONDS=25            # 旧的合并超时，以上面的读超时为准
MENTOR_MAX_OUTPUT_TOKENS=4000        # 1600 会把练习计划截断，白费一次调用
MENTOR_PROVIDER_ORDER=cerebras,groq  # 一个值，逗号是它的一部分，别拆成两条

# 识谱。不填就沿用上面的 base/key/model，所以通常配好 MENTOR_API_KEY 就够。
VISION_MODEL=xiaomi/mimo-v2.5
VISION_TIMEOUT_SECONDS=180
VISION_MAX_PAGES=2
VISION_PAGE_PIXELS=1600
```

模型和超时都是量出来的，不是挑名气：改之前先跑 `.venv/bin/python scripts/bench_mentor_models.py`。每个值背后的实测数字写在 `.env.example` 的注释里。

根目录的 `.env` 会被本地启动脚本间接加载；操作系统或容器中已设置的环境变量优先。

模型只接收有限的诊断、所选错误、问题、证据和确定性练习候选。聊天请求最多携带最近 10 条、总计 6000 字符的对话上下文，浏览器把消息保存在当前设备；后端日志不保存问题正文。输出经过严格 Pydantic 校验；畸形响应重试一次，之后自动回退本地导师。日志只记录 provider、model、prompt version、response mode、耗时和回退原因，不记录凭据或原始演奏。

练习生成支持 `aiAssist: true` 与最长 1000 字符的 `generationNote`。AI 只规划已验证的错误 ID、策略、速度比例、循环和声部；服务端再次校验这些选择，MusicXML/MIDI 仍由确定性生成器构建。模型不可用时会返回可解释的本地安全方案，而不会让训练流程中断。

每份生成结果都会重新进入与上传文件相同的 `ScoreImporter` 校验流程，获得独立 `practiceScoreId`、规范化事件、永久乐谱/MIDI 文件和父子谱系。它不是一次性预览：可以作为下一轮会话的正式曲目继续跟谱、伴奏、诊断、导师对话和再次生成。若本轮仍有问题，新的 AI 建议只使用本轮报告证据，形成 `诊断 → 生成曲 → 再诊断 → 新建议 → 下一首生成曲` 的循环。

## 网址

线上这份跑在 Render 免费实例上，用的就是仓库里的 `Dockerfile`。`render.yaml` 已经把 Docker、免费套餐、新加坡区、健康检查和 15 项配置写好了，所以部署你自己的一份只剩点几下：

1. 用 GitHub 账号登录 [render.com](https://render.com)，免费套餐不要信用卡。
2. **New → Blueprint**，选中这个仓库——它会读到 `render.yaml`。走 **New → Web Service** 读不到这个文件，16 项配置得手填。
3. 它只问一个值：`MENTOR_API_KEY`。粘贴你的 OpenRouter key，它存在 Render 那边，不进仓库。
4. **Apply**。首次构建约 10 分钟：装后端依赖，并把 60 MB 的听音模型烘进镜像，学生那边不用再下载。

之后 `git push` 到 `main` 就重新部署，地址不变，已经发出去的链接照常可用。

HTTPS 不是锦上添花：麦克风和 Web MIDI 都要求安全上下文，`http://` 页面永远拿不到这两个权限。

免费实例只有 0.1 CPU，诊断、练习生成和识谱都比本机慢几倍；内存不是瓶颈（实测峰值 102 MB，额度 512 MB）。网址是公开的，导师调用花的是你的额度，建议在 OpenRouter 给这把 key 设支出上限。`.env` 不在 Git 里，也不在镜像里——它是部署时下发的配置。

要更快、且愿意开通结算，同一个 Dockerfile 也能上 Cloud Run：

```bash
scripts/deploy-cloudrun.sh          # 需要先 gcloud auth login
```

本地跑同一个镜像：

```bash
cp .env.example .env
docker compose up --build           # http://localhost:8000
```

## 测试

```bash
# 全部后端、导入器、模型适配器和算法回归
python -m pytest tests -q

# 前端状态机
cd apps/web && pnpm test

# 类型与生产构建
pnpm build

# 安装一次 Chromium 后，运行 mocked Web MIDI 流程
pnpm exec playwright install chromium
pnpm test:e2e
```

受控算法门槛为事件定位 F1 ≥ 0.90；当前 fixture 回归为 1.00。CI 同时运行迁移、Python 测试、Vitest、生产构建和 Playwright。

## 关键 API

所有正式路由位于 `/api/v1`；`/api` 仅作为 Demo v1 临时兼容别名。

- `POST /scores/import`, `PATCH /scores/{id}/normalization`
- `GET /scores/{id}`, `GET /scores/{id}/render.musicxml`, `GET /scores/{id}/timeline.midi`
- `POST /sessions`, `POST /sessions/{id}/event-batches`, `POST /sessions/{id}/finish`
- `GET /analysis/{jobId}`, `GET /reports/{reportId}`
- `POST /exercises`, `POST /accompaniments`, `POST /mentor/responses`
- `GET /comparisons`
- `GET /health`, `GET /readiness`

`finish` 返回 HTTP 202 和持久化任务 ID。相同会话重复提交会得到同一任务/报告。

## 可靠性设计

- 浏览器每两秒把录音写入 IndexedDB，并用稳定批次 ID 幂等镜像到后端。
- 音频上下文由用户点击同步激活；网络请求不会抢在它前面。
- 在线跟谱只在 Web Worker 中驱动光标与伴奏；最终评分始终离线重算。
- USB 断开时冻结光标并保留事件，提供重新连接、提交现有录音或明确丢弃。
- 柔性伴奏只在小节边界更新速度，跟谱置信度低于 0.60 时冻结。
- SQLite 通过明确实体表持久化；本地 Profile 为未来所有权预留外键。上传源永久保留，废弃会话和生成物按策略清理。

详见 [v2 架构](docs/architecture-v2.md) 与 [USB MIDI 硬件验收清单](docs/hardware-acceptance.md)。最终硬件验收仍需要真实 USB MIDI 乐器和三份代表性练习文件。
