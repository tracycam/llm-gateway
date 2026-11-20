# LLM Gateway

把多家大模型服务统一成一个 API 的本地网关，类似自托管的 OpenRouter。一个程序、一个 SQLite 文件，Windows、macOS、Linux 都能直接运行。

- **一个入口，三种接口**：OpenAI Chat Completions、Anthropic Messages、OpenAI Responses。客户端用哪种都行；上游只说另一种时自动翻译（流式也一样）。
- **多家上游**：OpenAI 兼容、Anthropic 兼容、OpenRouter、OpenCode Zen / Go、GitHub Copilot（登录）、Grok（登录），以及 AI-Hub 本地推理服务。
- **自己的 API key**：每把 key 可限定可用模型、费用上限（按天 / 周 / 月重置）、并发数、过期时间。
- **用量与费用**：按模型、提供商、key 统计 token 与费用，Web 控制台查看。
- **路由**：同名模型可以有多个来源，按权重和负载分配，失败自动换下一个。

## 安装

### 方式一：下载单文件程序（推荐）

在 [Releases](https://github.com/tracycam/llm-gateway/releases/latest) 下载对应平台的文件，不需要安装任何依赖：

| 系统 | 文件 |
|---|---|
| Windows x64 | `llm-gateway-<版本>-windows-x64.exe` |
| macOS Apple Silicon（M 系列） | `llm-gateway-<版本>-darwin-arm64` |
| macOS Intel | `llm-gateway-<版本>-darwin-x64` |
| Linux x64 | `llm-gateway-<版本>-linux-x64` |
| Linux ARM64 | `llm-gateway-<版本>-linux-arm64` |

每个版本附带 `SHA256SUMS`，可用 `sha256sum -c SHA256SUMS`（macOS 用 `shasum -a 256 -c SHA256SUMS`）校验。

**Windows**（PowerShell）：

```powershell
Invoke-WebRequest -Uri https://github.com/tracycam/llm-gateway/releases/download/v0.1.0/llm-gateway-0.1.0-windows-x64.exe -OutFile llm-gateway.exe
.\llm-gateway.exe
```

首次运行若出现 SmartScreen 提示（程序未签名），点“更多信息 → 仍要运行”。

**macOS**：

```bash
curl -L -o llm-gateway https://github.com/tracycam/llm-gateway/releases/download/v0.1.0/llm-gateway-0.1.0-darwin-arm64
chmod +x llm-gateway
xattr -d com.apple.quarantine llm-gateway   # 程序未签名，去掉下载隔离标记
./llm-gateway
```

**Linux**：

```bash
curl -L -o llm-gateway https://github.com/tracycam/llm-gateway/releases/download/v0.1.0/llm-gateway-0.1.0-linux-x64
chmod +x llm-gateway
./llm-gateway
```

启动后输出：

```
[LLM API Gateway] Listening on http://127.0.0.1:8000
[LLM API Gateway] Data directory: /home/you/.local/share/llm-gateway
```

### 方式二：Docker（amd64 / arm64）

```bash
export ADMIN_TOKEN=$(openssl rand -hex 24)   # 记下它，控制台用它登录
echo "$ADMIN_TOKEN"
docker run -d --name llm-gateway \
  -p 127.0.0.1:8000:8000 \
  -v llm-gateway-data:/data \
  -e ADMIN_TOKEN \
  ghcr.io/tracycam/llm-gateway:latest
```

容器内监听所有地址，因此必须设置 `ADMIN_TOKEN`（至少 16 个字符），控制台用它登录。数据在 `/data` 卷里。

### 方式三：从源码运行（需要 [Bun](https://bun.sh) 1.4）

```bash
git clone https://github.com/tracycam/llm-gateway.git && cd llm-gateway
bun install && (cd web && bun install) && bun run build
bun run start
```

## 第一次使用

1. 浏览器打开 **http://127.0.0.1:8000**。只监听本机且没设 `ADMIN_TOKEN` 时不需要登录；设了令牌就用它登录。
2. **提供商 → 添加**：选连接器，填 API key（或在详情页“登录”GitHub Copilot / Grok）。保存后网关自动拉取该提供商的模型列表并发布。
3. **模型**：确认要用的模型已启用；可以填单价（美元 / 百万 token）以便统计费用和设置费用上限。
4. **密钥 → 创建**：得到一把 `sk-gw-…` 开头的 key。**明文只显示这一次**，请立刻保存。
5. 用这把 key 调用 `http://127.0.0.1:8000/v1`。控制台左侧栏底部的“接入”里有可直接复制的示例。

## 接入客户端

下面的 `$GATEWAY_KEY` 是第 4 步创建的 key，`<模型名>` 是 `/v1/models` 里列出的名字。

**curl**

```bash
curl http://127.0.0.1:8000/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_KEY" -H "Content-Type: application/json" \
  -d '{"model": "<模型名>", "messages": [{"role": "user", "content": "你好"}]}'
```

**OpenAI SDK**（Python / Node 同理）

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8000/v1", api_key="sk-gw-...")
print(client.chat.completions.create(model="<模型名>", messages=[{"role": "user", "content": "你好"}]).choices[0].message.content)
```

**Anthropic SDK / Claude Code**

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8000
export ANTHROPIC_AUTH_TOKEN=sk-gw-...
claude --model <模型名>
```

**Codex CLI**（`~/.codex/config.toml`）

```toml
model = "<模型名>"
model_provider = "gateway"

[model_providers.gateway]
name = "LLM Gateway"
base_url = "http://127.0.0.1:8000/v1"
env_key = "GATEWAY_KEY"
wire_api = "responses"
```

模型背后的上游即使不说客户端用的那种接口（例如 Claude Code 调一个只支持 Chat Completions 的模型），网关也会自动翻译。

## 让其他机器访问

```bash
ADMIN_TOKEN=<至少 16 个字符> ./llm-gateway --listen 0.0.0.0
```

Windows PowerShell：`$env:ADMIN_TOKEN="<令牌>"; .\llm-gateway.exe --listen 0.0.0.0`。

监听非本机地址时必须设 `ADMIN_TOKEN`，否则拒绝启动。网关本身不做 HTTPS；跨公网使用请在前面放 Caddy、Nginx 等反向代理。

## 配置

命令行参数优先于环境变量。

| 参数 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `--port` | `PORT` | `8000` | 端口 |
| `--listen` | `LISTEN` | `127.0.0.1` | 监听地址；非本机地址必须设 `ADMIN_TOKEN` |
| `--data-dir` | `DATA_DIR` | 见下 | 数据库目录 |
| — | `ADMIN_TOKEN` | 无 | 管理员令牌（控制台登录、`/api/gateway/*`），只能用环境变量传 |
| `--version` / `--help` | | | |

默认数据目录（存放 `gateway.sqlite`，含 API key 哈希与上游凭证，权限 `0700` / `0600`）：

| 运行方式 | 位置 |
|---|---|
| Windows 程序 | `%LOCALAPPDATA%\llm-gateway` |
| macOS 程序 | `~/Library/Application Support/llm-gateway` |
| Linux 程序 | `$XDG_DATA_HOME/llm-gateway`，未设时 `~/.local/share/llm-gateway` |
| 源码运行 | 仓库下的 `data/` |
| Docker | `/data` |

备份：停止网关后复制整个数据目录。升级：替换程序文件（或拉新镜像）后用同一个数据目录启动，数据库会自动升级。

## API

| 路由 | 说明 |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/messages` | Anthropic Messages |
| `POST /v1/responses` | OpenAI Responses |
| `GET /v1/models`、`/v1/models/{id}` | 带 `context_length`、`pricing`（美元 / token）、`top_provider`、`supported_protocols`；请求带 `anthropic-version` 头时返回 Anthropic 的形状 |
| `GET /v1/key`（别名 `/v1/auth/key`） | 当前 key 的限额、剩余、重置周期、本周期与累计费用 |
| `GET /v1/generation?id=gen-…` | 某次请求的模型、提供商、token、费用、耗时；只能查本 key 最近 200 条以内的请求 |

key 可放在 `Authorization: Bearer <key>` 或 `x-api-key: <key>`。

三种接口互通：同一种接口逐字节透传；两条线路都能用时优先不需要翻译的那条；翻译不了的字段（如发往 Chat 上游的 `previous_response_id`、服务端内置工具）返回 400 并指出字段。

每个回答带 `x-request-id`（`gen-…`）；由某个上游回答时还带 `x-gateway-provider`、`x-gateway-model`。

请求体里可加以下字段（不会发给上游）：

```jsonc
{
  "model": "claude-sonnet-4",
  "models": ["claude-sonnet-4", "gpt-5"],   // 前一个在出内容前失败（无线路、5xx、429、连不上）时换下一个，最多 5 个
  "provider": {
    "only": ["anthropic"], "ignore": ["openrouter"],
    "order": ["local", "anthropic"],         // 按此顺序尝试
    "sort": "price",                         // 按单价从低到高，单价未知的排最后
    "allow_fallbacks": false                 // 只试一条线路
  },
  "usage": { "include": true }               // Chat：回答的 usage 带 cost（美元，单价未知为 null）
}
```

管理接口与完整操作步骤见 [`docs/image.md`](./docs/image.md)；各家上游的接口细节与出处见 [`docs/connectors.md`](./docs/connectors.md)。

## 现状

- 版本 0.x，接口可能调整。
- 真实上游只实测过 OpenCode Zen / Go 与 AI-Hub；OpenAI、Anthropic、OpenRouter 只对模拟上游测过；GitHub Copilot 与 Grok 的登录只对模拟授权服务器测过。
- 跨协议翻译已有完整的自动化测试，但还没用 Claude Code、Codex、opencode 实际跑过。
- macOS 程序由 CI 在 Apple Silicon 上运行验证；Intel Mac 版本未在真机上运行过。
- 程序未做代码签名。

## 开发

```bash
bun run dev          # 后端，改动自动重启
bun run dev:web      # 控制台开发服务器，代理到 127.0.0.1:8000
bun run verify       # 类型检查 + 测试 + 控制台构建
bun run build:bin    # 编译五个平台的单文件程序到 release/
```

本仓库不依赖目录外的任何文件。

## 许可证

[MIT](./LICENSE)
