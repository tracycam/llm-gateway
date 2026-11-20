# LLM Gateway

一个进程、一个 SQLite 文件。把多家上游统一成一份模型清单，用自己签发的 API key 调用，按模型 / provider / key 记用量和费用。对外接口与 OpenAI、Anthropic、OpenRouter 的客户端兼容。

## 运行

从源码（需要 Bun 1.4）：

```
bun install && (cd web && bun install) && bun run build
ADMIN_TOKEN=<至少 16 个字符> bun run start      # http://127.0.0.1:8000
```

Docker（构建上下文就是本目录）：

```
docker build -t llm-gateway .
docker run -d -p 127.0.0.1:8000:8000 -v llm-gateway-data:/data -e ADMIN_TOKEN llm-gateway
```

镜像细节、从加 provider 到发出第一个请求的完整步骤：[`docs/image.md`](./docs/image.md)。

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8000` | |
| `LISTEN` | `127.0.0.1` | 非回环地址必须设 `ADMIN_TOKEN` |
| `DATA_DIR` | 本目录下的 `data/` | `gateway.sqlite` 所在目录（`0700`，文件 `0600`） |
| `WEB_DIST_DIR` | 本目录下的 `web/dist/` | 构建好的控制台 |

旧名 `AIHUB_GATEWAY_PORT`、`AIHUB_GATEWAY_LISTEN`、`AIHUB_ADMIN_TOKEN`、`AIHUB_GATEWAY_DATA_DIR`、`AIHUB_WEB_DIST_DIR` 仍然有效，新名优先。

## Provider

`openai-compatible`、`anthropic-compatible`、`openrouter`、`opencode`、`opencode-go` 填 key；`grok`、`copilot` 在控制台登录；`aihub` 连一台 AI-Hub daemon（地址 + 它的管理令牌），daemon 上就绪的服务自动成为模型，同一模型的多个副本合成一个。各家接口的事实与出处：[`docs/connectors.md`](./docs/connectors.md)。

## API

| 路由 | 说明 |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/messages` | Anthropic Messages |
| `POST /v1/responses` | OpenAI Responses |
| `GET /v1/models`、`/v1/models/{id}` | 带 `context_length`、`pricing`（美元 / token）、`top_provider`、`supported_protocols`；带 `anthropic-version` 头时返回 Anthropic 的形状 |
| `GET /v1/key`（别名 `/v1/auth/key`） | 当前 key 的限额、剩余、重置周期、本周期与累计费用 |
| `GET /v1/generation?id=gen-…` | 某次请求的模型、provider、token、费用、耗时；只能查本 key 的、最近 200 条以内的请求 |

三种接口互通：客户端用哪种都行，上游说别的接口时自动翻译（请求、非流式、流式，用量照记）。同一种接口逐字节透传；两条 route 都能用时优先不用翻译的那条。翻译不了的字段（如发往 Chat 上游的 `previous_response_id`、服务端内置工具）返回 400 并指出字段。

每个回答带 `x-request-id`（`gen-…`），由某个上游回答时还带 `x-gateway-provider`、`x-gateway-model`。

请求体里可加（不会发给上游）：

```jsonc
{
  "model": "claude-sonnet-4",
  "models": ["claude-sonnet-4", "gpt-5"],          // 前一个在出内容之前失败（无 route、5xx、429、连不上）时换下一个，最多 5 个
  "provider": {
    "only": ["anthropic"], "ignore": ["openrouter"],
    "order": ["local", "anthropic"],                // 按此顺序尝试
    "sort": "price",                                // 按单价从低到高，单价未知的排最后
    "allow_fallbacks": false                        // 只试一条 route
  },
  "usage": { "include": true }                      // Chat：回答的 usage 带 cost（美元，单价未知为 null）
}
```

## 开发

```
bun run dev          # 后端，改动自动重启
bun run dev:web      # 控制台，代理到 127.0.0.1:8000
bun run verify       # 类型检查 + 测试 + 控制台构建
```

本目录不依赖目录外的任何文件，拷出去即可单独构建、测试和打包。
