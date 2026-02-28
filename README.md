# Matridx Ting

安卓可用的 PWA 录音助手：手动录音 -> 云端转写 -> 每日工作总结与任务计划。

本版本已冻结“一次改好”主契约：
- 停止录音后自动上传并转写（上传模式）
- 按录音粒度生成会议笔记（DB + Markdown 文件）
- 按用户时区在 20:00 / 23:30 自动生成日报并覆盖同日文件
- 会议笔记与日报文件可直接被其他 Agent 读取

## 技术栈

- `apps/web`: Next.js PWA（录音、本地 AES-GCM 加密、上传、日报与任务 UI）
- `apps/api`: Fastify API（JWT 鉴权、录音/转写/日报/任务接口、预签名 URL）
- `apps/worker`: BullMQ Worker（STT 转写、LLM 日报生成、任务落库）
- `packages/shared`: zod schema 与日报 Markdown 渲染
- `infra/docker-compose.yml`: Postgres / Redis / MinIO / API / Worker / Web

## 快速开始（本地）

1. 安装依赖

```bash
pnpm install
```

2. 配置环境变量

```bash
cp .env.example .env
```

3. 启动基础依赖

```bash
docker compose -f infra/docker-compose.yml up -d postgres redis minio minio-init
```

4. 分别启动服务

```bash
pnpm --filter @matridx/api dev
pnpm --filter @matridx/worker dev
pnpm --filter @matridx/web dev
```

或一键启动（推荐）：

```bash
pnpm dev:up
```

## 一键 Docker 启动

```bash
cp .env.example .env
docker compose -f infra/docker-compose.yml up --build
```

访问：

- Web: `http://localhost:3122`
- API: `http://localhost:8081/healthz`
- MinIO Console: `http://localhost:9001` (`minio` / `minio123`)

## 默认账号

- 用户名：`admin`
- 密码：与 `ADMIN_PASSWORD_HASH` 对应，默认示例密码为 `admin123`

如果需要重新生成密码哈希：

```bash
node -e "console.log(require('bcryptjs').hashSync('your-password', 10))"
```

## 模型配置（两个独立模型）

登录后在首页可以看到“模型设置（STT / 分析）”：

- STT：`provider`、`stt_file_model`、`stt_realtime_model`、`api_key`
- 分析：`provider`、`model`、`api_key`
- 支持单独测试：`测试 STT(文件)`、`测试 STT(实时)`、`测试分析`
- API Key 默认掩码不回显，只显示“已配置/未配置”

配置优先级：

- `数据库配置 (ai_settings)` > `.env` fallback
- 当数据库没有配置时，Worker 会回退到 `.env` 的 `STT_*` / `LLM_*`
- provider 支持：`openai`、`openrouter`（模型名可自定义输入）
- 如用 OpenRouter，可在 `.env` 配置可选头：`OPENROUTER_SITE_URL`、`OPENROUTER_APP_NAME`
- STT provider 新增：`seed-asr`（豆包/火山 API）与 `qwen3-asr`（自建 OpenAI 兼容 ASR）
- `seed-asr` 需配置 `SEED_ASR_ENDPOINT`（你的网关地址）和可选 `SEED_ASR_TIMEOUT_MS`
- `qwen3-asr` 需配置 `QWEN_ASR_BASE_URL`（默认 `https://dashscope.aliyuncs.com/compatible-mode/v1`）与可选 `QWEN_ASR_API_KEY`
- STT 现已拆分为两套模型：
  - `stt_file_model`：用于“录完上传转写”
  - `stt_realtime_model`：用于“实时转写（WebSocket）”
- 长音频（>5分钟）在 `qwen3-asr` 下会自动改走 `qwen3-asr-flash-filetrans`

### Qwen Realtime 模式

- 前端“录音与本地回放”支持模式切换：`录完上传转写` / `实时转写（Qwen Realtime）`
- 实时模式要求已保存 STT 配置为：`stt_provider=qwen3-asr` 且 `stt_realtime_model` 包含 `realtime`
- 文件上传转写要求：`stt_file_model` 不包含 `realtime`
- 实时链路采用后端 WS 中转，浏览器不会暴露 STT API Key
- 停止实时后会自动落库为 `recordings + transcripts`，当天转写与日报可直接使用
- 实时链路异常会自动回退到本地录音上传转写，并在状态栏提示
- 若 `stt_file_model` 错填为 realtime：不会自动回退上传，会提示“先改文件模型再手动上传”

### Qwen 双模型推荐模板

- `stt_provider=qwen3-asr`
- `stt_file_model=qwen3-asr-flash`
- `stt_realtime_model=qwen3-asr-flash-realtime`

### 长音频 filetrans 默认配置

- `LONG_AUDIO_THRESHOLD_MS=300000`
- `QWEN_FILETRANS_MODEL=qwen3-asr-flash-filetrans`
- `QWEN_FILETRANS_API_BASE=https://dashscope.aliyuncs.com/api/v1`
- `QWEN_FILETRANS_POLL_INTERVAL_MS=3000`
- `QWEN_FILETRANS_TIMEOUT_MS=1800000`

注意：
- filetrans 使用 `file_url` 异步转写，要求该 URL 对 DashScope 可访问（生产建议使用公网可访问 OSS/S3）
- 本地 `localhost` MinIO 在无公网映射时可能无法被 DashScope 拉取

### 常见错误与修复动作

| 报错/现象 | 修复动作 |
| --- | --- |
| `STT 文件模型不能是 realtime` | 把 `stt_file_model` 改为非 realtime（如 `qwen3-asr-flash`）并保存 |
| `STT 实时模型必须包含 realtime` | 把 `stt_realtime_model` 改为 realtime 模型（如 `qwen3-asr-flash-realtime`）并保存 |
| 上传按钮灰色 | 检查 `stt_file_model` 是否包含 `realtime`；改正后重试 |
| 实时模式无法开始 | 检查 `stt_provider=qwen3-asr` 且 `stt_realtime_model` 包含 `realtime` |

## MVP 约束

- 仅支持安卓 Chrome 前台录音，不支持锁屏持续录音
- 默认中文转写并自动标点
- 云端仅持久化文本；音频仅临时存储于 S3/MinIO，转写后删除

## 会议笔记（双端留存）

- 每条成功转写的录音会自动生成一条会议笔记（按录音粒度）
- 会议笔记字段包含：时间、贡献者（当前登录用户）、摘要、全文、来源（upload/realtime）
- 服务端会同时写入 DB 表 `meeting_notes` 和 Markdown 文件（YAML frontmatter）
- 文件目录：`NOTES_STORAGE_ROOT/YYYY/MM/DD/*.md`
- 默认本地开发路径：`./infra/data/notes`，Docker 内路径：`/data/notes`

新增 API：

- `GET /meeting-notes?date=YYYY-MM-DD`
- `GET /meeting-notes/:id`
- `POST /meeting-notes/:recordingId/regenerate`
- `PUT /users/me/timezone`
- `POST /daily-summaries`（支持 `trigger=manual|auto_20|auto_2330`）
- `POST /daily-summaries/:date/regenerate`

运维建议：

- 备份时同时备份 Postgres 和 `infra/data/notes` 目录

## 自动化行为（冻结）

- 上传模式：停止录音后自动执行“上传 -> 转写 -> 会议笔记生成”
- 实时模式：结束后自动落库 transcript + meeting note
- 自动日报调度：Worker 每分钟检查一次，根据 `users.tz` 命中 20:00 与 23:30 触发
- 同日日报文件路径固定，后一次生成会覆盖前一次

## 日报与笔记文件路径

- 会议笔记：`NOTES_STORAGE_ROOT/YYYY/MM/DD/YYYYMMDD-HHMMSS-{contributor}-{recording8}.md`
- 每日日报：`NOTES_STORAGE_ROOT/daily-summaries/YYYY/MM/DD/YYYYMMDD-{username}.md`

## 严格验收与失败演练

执行：

```bash
pnpm qa:smoke
pnpm qa:drill
```

验收清单：

- `docs/acceptance-checklist.md`

说明：
- `qa:smoke` 覆盖 API 基础可用性与关键契约接口
- `qa:drill` 执行落盘失败注入与补偿恢复演练（需要本地 `infra/data/notes` 可修改权限）
