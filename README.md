# Matridx Ting

安卓可用的 PWA 录音助手：手动录音 -> 云端转写 -> 每日工作总结与任务计划。

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

- Web: `http://localhost:3000`
- API: `http://localhost:8080/healthz`
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

- STT：`provider`、`model`、`api_key`
- 分析：`provider`、`model`、`api_key`
- 支持单独测试：`测试 STT`、`测试分析`
- API Key 默认掩码不回显，只显示“已配置/未配置”

配置优先级：

- `数据库配置 (ai_settings)` > `.env` fallback
- 当数据库没有配置时，Worker 会回退到 `.env` 的 `STT_*` / `LLM_*`
- provider 支持：`openai`、`openrouter`（模型名可自定义输入）
- 如用 OpenRouter，可在 `.env` 配置可选头：`OPENROUTER_SITE_URL`、`OPENROUTER_APP_NAME`
- STT provider 新增：`seed-asr`（豆包/火山 API）与 `qwen3-asr`（自建 OpenAI 兼容 ASR）
- `seed-asr` 需配置 `SEED_ASR_ENDPOINT`（你的网关地址）和可选 `SEED_ASR_TIMEOUT_MS`
- `qwen3-asr` 需配置 `QWEN_ASR_BASE_URL`（默认 `https://dashscope.aliyuncs.com/compatible-mode/v1`）与可选 `QWEN_ASR_API_KEY`
- 注意：`*-realtime` 模型走 WebSocket 实时流，不适用于当前“文件上传后转写”的链路

## MVP 约束

- 仅支持安卓 Chrome 前台录音，不支持锁屏持续录音
- 默认中文转写并自动标点
- 云端仅持久化文本；音频仅临时存储于 S3/MinIO，转写后删除
