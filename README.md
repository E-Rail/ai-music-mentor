# AI 音乐导师 · 技术 Demo

MIDI 实时跟谱 → 错误诊断 → 微练习生成 → 自适应伴奏再次验证的完整闭环。

## 快速启动

### 1. 后端（FastAPI + music21）

```bash
cd apps/api
pip install -r requirements.txt

# 生成受控测试样本（3 首内置曲 + 注入错误 MIDI + ground_truth）
python ../../packages/score-fixtures/generate_fixtures.py

# 启动
uvicorn app.main:app --reload --port 8000
```

启动后访问 http://localhost:8000/api/health 应返回 `{"status":"ok"}`。
内置 3 首曲目会自动注册。

### 2. 前端（React + Vite）

```bash
cd apps/web
pnpm install    # 或 npm install
pnpm dev        # 或 npm run dev
```

访问 http://localhost:5173

> Web MIDI 需要安全上下文：localhost 或 HTTPS。建议使用 Chromium 系浏览器。

### 3. 降级模式（无 MIDI 设备）

在「设备校准」页勾选「使用上传 MIDI 降级」，即可上传 `.mid` 文件作为演奏记录。
`packages/score-fixtures/midi/` 下有预置的注入错误样本可供测试。

## 测试

```bash
# 后端受控样本回归（事件级 F1 ≥ 0.90）
cd apps/api && python -m pytest ../../tests/alignment -v

# 端到端 API 流程（需先启动后端）
python ../../tests/api/test_e2e_flow.py
```

## 项目结构

```
ai-music-mentor/
├─ apps/
│  ├─ web/                 # React + TypeScript 前端
│  │  ├─ src/App.tsx       # 6 页面主控
│  │  ├─ src/features/midi/        # Web MIDI 采集与校准
│  │  ├─ src/features/score/       # OSMD 谱面渲染 + 错误高亮
│  │  ├─ src/features/follower/    # 跟谱 Worker 客户端
│  │  ├─ src/features/audio/       # Tone.js 播放
│  │  ├─ src/workers/              # beam-search 在线跟谱
│  │  └─ src/api/                  # 后端接口客户端
│  └─ api/                 # FastAPI 后端
│     ├─ app/routes/api.py         # 11 个 REST/WS 接口
│     ├─ app/services/alignment/   # 和弦分组 / 速度估计 / onset聚类 / DP全局对齐
│     ├─ app/services/diagnosis/   # 错误检测 / 评分 / 置信度 / 模式归因
│     ├─ app/services/generation/  # 微练习生成 / 伴奏生成
│     ├─ app/services/mentor/      # AI 导师（规则模板 + LLM Adapter）
│     └─ app/schemas/models.py     # 核心数据模型
├─ packages/
│  ├─ score-fixtures/      # 3 首内置曲 + 受控 MIDI 样本生成器
│  └─ shared-schema/
├─ tests/
│  ├─ alignment/           # 受控样本算法回归
│  └─ api/                 # 端到端接口测试
└─ data/                   # 运行时数据（SQLite + 乐谱/MIDI 文件）
```

## 核心算法

| 模块 | 实现 | 方案章节 |
|---|---|---|
| 和弦分组 | 70ms 窗口聚合，慢速曲上调到 100ms | 5.3 |
| 在线跟谱 | beam search（宽度 8），窗口 [k−2,k+6]，Web Worker | 5.4 |
| 全局对齐 | 两遍 DP：初始线性速度 → 锚点分段鲁棒速度拟合 → 精对齐 | 5.5 |
| 错误检测 | 6+1 类：错音/漏音/多音/提前延后/时值异常/速度不稳/力度异常 | 5.6 |
| 置信度 | 0.45×证据 + 0.35×一致性 + 0.20×特异性 | 5.7 |
| 微练习 | 6 种确定性策略 + 降级兜底 | 5.8 |
| 自适应伴奏 | 按小节 ±5% 限速 + 指数平滑 | 5.9 |
| AI 导师 | 规则模板（默认）/ LLM Adapter（JSON Schema 约束 + Pydantic 校验 + 模板兜底） | 5.10 |

## 环境变量

```bash
APP_ENV=development
DATABASE_URL=sqlite:///./data/app.db
MENTOR_PROVIDER=rules          # rules | llm
MENTOR_API_KEY=                # 仅服务器端
MENTOR_TIMEOUT_SECONDS=8
```

## 当前进度

- ✅ 后端完整闭环，受控样本事件级 F1 = 1.000，端到端 API 测试全绿
- ✅ 前端 6 页面 + MIDI 采集 + 跟谱 Worker + OSMD 谱面 + Tone.js 播放，TypeScript 类型检查通过，Vite 构建通过
- ⬜ 真实 MIDI 键盘联调（需本地设备）
- ⬜ 接入真实 LLM（设置 `MENTOR_PROVIDER=llm` + `MENTOR_API_KEY`）
