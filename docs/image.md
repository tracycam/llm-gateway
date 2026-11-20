# gateway 镜像

镜像里只有 gateway：打包成一个文件的服务端，加上构建好的控制台。不含 daemon——daemon 要加速卡和驱动，装在有卡的机器上。gateway 不需要 daemon 就能启动：provider、模型与密钥、`/v1` 都由它自己持有。

`gateway/` 是自足的一层：它自己 `bun install`、`bun run check`、`bun test`、`bun run build`，镜像也从这一层构建，不读仓库里别的东西。

## 构建

```
docker build -t llm-gateway gateway    # 构建上下文就是 gateway/
scripts/build-gateway-image.sh         # 同上，另按提交号打标签
scripts/verify-gateway-image.sh        # 15 项检查，任何一项没跑到或没通过即失败
```

基础镜像按版本和摘要固定在 `gateway/Dockerfile` 里。拉不到它的机器上，先用别的办法把同一个镜像放进本地，再用 `AIHUB_BUN_IMAGE=oven/bun:1.4.2-slim` 指向本地那份。

`verify-gateway-image.sh` 不连任何 daemon，也不连外网：它自己在一个空闲端口上起一个桩上游（`scripts/stub-upstream.ts`，OpenAI 兼容，`/v1/models` 与 `/v1/chat/completions`），绑在 docker 桥地址上，用一次性令牌、卷和目录跑完 15 项检查，结束时只删自己建的东西。

## 运行

```
export ADMIN_TOKEN=<至少 16 个字符>
docker run -d --name llm-gateway \
  -p 127.0.0.1:8000:8000 \
  -v llm-gateway-data:/data \
  -e ADMIN_TOKEN \
  llm-gateway
```

| 配置 | 含义 |
|---|---|
| `ADMIN_TOKEN` | 必填。管理接口的 Bearer 令牌，控制台登录也用它。容器内监听 `0.0.0.0`，不给令牌就拒绝启动并说明原因。原来的 `AIHUB_ADMIN_TOKEN` 仍被接受。 |
| `PORT` / `LISTEN` | 监听端口与地址，镜像里是 `8000` / `0.0.0.0`。原来的 `AIHUB_GATEWAY_PORT` / `AIHUB_GATEWAY_LISTEN` 仍被接受。 |
| `DATA_DIR` | `/data`：provider、模型、route、密钥、用量都在这里的 `gateway.sqlite`。原来的 `AIHUB_GATEWAY_DATA_DIR` 仍被接受。 |
| `WEB_DIST_DIR` | `/app/web`：构建好的控制台。原来的 `AIHUB_WEB_DIST_DIR` 仍被接受。 |
| `-p <地址>:<端口>:8000` | 对外开在哪。`127.0.0.1:8000:8000` 只有本机能访问；要让别的机器访问就写 `8000:8000`。 |
| `-v <卷>:/data` | 换容器、换镜像版本时挂同一个卷，数据还在。 |

- 令牌用 `-e ADMIN_TOKEN`（不写 `=值`）从环境里带进去，这样它不出现在 `docker` 的命令行里。
- `/healthz` 不需要令牌；`/api/gateway/*` 和 `/v1/*` 需要（`/v1/*` 用 API key，不用管理员令牌）。
- 容器内以 uid 1000 运行，`/data` 是 0700、`gateway.sqlite` 是 0600。`/data` 用宿主机目录而不是卷时，那个目录要对 uid 1000 可写。
- 换一台机器：`docker save llm-gateway | gzip > llm-gateway.tar.gz`，拷过去 `docker load`。没有推送到任何仓库。

## 启动之后

```
G=http://127.0.0.1:8000
T=$ADMIN_TOKEN
```

除 `/v1/*` 外，下面的请求都带 `Authorization: Bearer $T`。

### 1. 看有哪些 connector

```
curl -s $G/api/gateway/connectors -H "Authorization: Bearer $T"
```

| `id` | 名称 | 凭证 |
|---|---|---|
| `openai-compatible` | OpenAI-compatible | `apiKey` 可选，`baseUrl` 可选（默认 `https://api.openai.com/v1`） |
| `anthropic-compatible` | Anthropic-compatible | `apiKey` 可选，`baseUrl` 可选（默认 `https://api.anthropic.com`） |
| `grok` | Grok | 登录 |
| `opencode` | OpenCode Zen | `apiKey` 必填 |
| `opencode-go` | OpenCode Go | `apiKey` 必填 |
| `copilot` | GitHub Copilot | 登录 |
| `openrouter` | OpenRouter | `apiKey` 必填 |

两个登录型（`grok`、`copilot`）不用 key：先建 provider，再 `POST /api/gateway/providers/<provider id>/login`
拿到 `userCode` 与 `verificationUri`，在浏览器打开该地址确认这个码，然后 `GET` 同一个地址直到 `state` 是 `done`。
`grok` 要 SuperGrok / X Premium Plus 订阅，`copilot` 要 GitHub Copilot 订阅。
`DELETE` 同一个 `/login` 只取消还没完成的登录，已存凭证（含被上游拒绝的标记）不动；退出登录用
`DELETE /api/gateway/providers/<provider id>/credential`，它取消登录并删掉凭证。

### 2. 加一个 provider

```
curl -s $G/api/gateway/providers -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"name": "official", "connector": "openai-compatible", "apiKey": "sk-..."}'
```

不给 `baseUrl` 就用 connector 的默认地址；七个 connector 都带一个，所以官方 API 只给 key 就行，别的只换
`connector`。自建兼容服务要写 `baseUrl`，指向它的 OpenAI 兼容根；不需要 key 的服务连 `apiKey` 也不给，
请求就不带 `Authorization`：

```
curl -s $G/api/gateway/providers -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"name": "local", "connector": "openai-compatible", "baseUrl": "http://<地址>:<端口>/v1"}'
```

返回的 `provider.id` 后面用得到。凭证只写不读：任何接口都不回显 `apiKey`。新建的 provider 默认打开
`autoPublish`；已有 provider 保持原值，PATCH 里显式给 `"autoPublish": false` 可关。

### 3. 拉模型列表并发布

gateway 自己同步模型列表，不用打开控制台：启动时、每 6 小时、以及新建 provider 之后、PATCH 改了密钥或
地址或重新启用之后、登录成功之后各同步一次。手动 refresh 走同一个函数：

```
curl -s -X POST $G/api/gateway/providers/<provider id>/refresh -H "Authorization: Bearer $T"
curl -s -X POST $G/api/gateway/providers/<provider id>/publish -H "Authorization: Bearer $T" \
  -H 'Content-Type: application/json' -d '{"upstreamId": "<上游模型 id>"}'
```

refresh 只读上游的模型列表（`models[].upstreamId`）；打开 `autoPublish` 的 provider 在同步后把列表里
还没有 route 的模型直接发布。`protocols` 为空的模型（不说自己支持哪一种接口）不自动发布；publish 仍可
手动发布任意一个上游模型。公开的模型名就是上游模型 id。

同步失败记在 provider 的 `modelsError`（最近一次成功的时间在 `modelsRefreshedAt`）；失败不清空已有
模型列表，也不删已发布的 route。上游后来不再列出的模型，route 也保留：请求仍会发往该上游，由上游自己
回答（通常是 404 或模型不存在），gateway 不会自动取消发布。

### 4. 定价

价格是美元 / 百万 token：

```
curl -s -X PATCH $G/api/gateway/models/<modelId> -H "Authorization: Bearer $T" \
  -H 'Content-Type: application/json' \
  -d '{"price": {"input": 1.25, "output": 10, "cacheRead": null}}'
```

上游的模型列表自带单价的（OpenRouter、OpenCode），发布时单价已经带上，不用再填。没定价的模型也能调用，
但费用记为空，不按 0 算；带 `costLimit` 的 key 不能调没定价的模型（403）。xAI 的 API key 走
`openai-compatible`（地址 `https://api.x.ai/v1`），它的列表不带价格，模型要在这里补。

### 5. 建 API key

```
curl -s $G/api/gateway/keys -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"name": "client"}'
```

响应里的 `token`（`sk-gw-...`）只出现这一次：之后任何接口都不回显，库里只有哈希。可另带 `modelIds`、`restricted`、`costLimit`、`resetPeriod`、`maxConcurrency`、`expiresAt`。

### 6. 调模型

```
curl -s $G/v1/chat/completions -H "Authorization: Bearer sk-gw-..." -H 'Content-Type: application/json' \
  -d '{"model": "<模型 id>", "messages": [{"role": "user", "content": "hi"}]}'

curl -s $G/v1/messages -H "Authorization: Bearer sk-gw-..." -H 'Content-Type: application/json' \
  -d '{"model": "<模型 id>", "max_tokens": 64, "messages": [{"role": "user", "content": "hi"}]}'

curl -s $G/v1/responses -H "Authorization: Bearer sk-gw-..." -H 'Content-Type: application/json' \
  -d '{"model": "<模型 id>", "input": "hi"}'
```

Chat 与 Messages 两个入口都能用于任一 provider：请求协议与上游协议不同时由 gateway 转换，相同时原样
转发。Responses 只做同协议透传，与 Chat、Messages 之间都不转换：上游也讲 Responses 的模型才能用
`/v1/responses`，否则该路由被跳过；模型一个可用路由都没有时返回 400 并指明它可用的入口。流式请求加
`"stream": true`。

### 7. 用量

```
curl -s "$G/api/gateway/usage?by=model" -H "Authorization: Bearer $T"
curl -s "$G/api/gateway/usage?by=provider&model=<modelId>" -H "Authorization: Bearer $T"
```

`by` 可以是 `model`、`provider`、`key`、`day`；`provider` 必须给 `model`。另有 `/api/gateway/usage/totals` 与 `/api/gateway/logs`。

## 现在的限制

- 管理界面还不能用：控制台的网关页仍在调已删掉的 `/api/gateway/state`、`/api/gateway/config`（代码：`web/src/gateway/GatewayApp.tsx`），配置只能走上面的接口，直到 `TODO.md` `S7.9`。
- 连 daemon 只通过 `aihub` provider：`baseUrl` 是 daemon 地址，`apiKey` 是它的管理令牌，worker 令牌由服务端自己算。原来的机器管理接口（`/api/gateway/nodes*`、`/api/gateway/events`）已移除；一条 daemon 连线离线时，原因记在它 provider 的 `modelsError` 里。
- 真实上游只测过 OpenCode Zen 与 Go（实测记录在 `docs/connectors.md` 第 9 节）；OpenAI、Anthropic、OpenRouter、xAI 没连过。按登录流程取凭证的 connector（GitHub Copilot、ChatGPT 订阅）还没有。
- 不做 TLS。要加密就在前面放反向代理。

## 实测（2026-11-18，开发机，x86-64，Docker 27.3.1）

- 镜像 171 MB，其中基础镜像 170 MB，自己的内容约 1.0 MB（服务端 155 kB，控制台 817 kB）。
- `scripts/verify-gateway-image.sh` 15/15 通过、退出码 0，连续两遍。桩上游在 docker 桥地址上，容器外。
- 把镜像或脚本改坏 6 种，每种都被对应的检查拦下：不给令牌也启动（检查 2）、数据库 0644（3）、匿名 `/v1/models` 回 200（6）、用量不记账（10）、镜像里多一个 `.ts`（13）、桩上游的模型名对不上（5）。
- connector 列表与上面的接口形状取自这次运行；`docker stop` 后退出码 0，`/data` 与 `gateway.sqlite` 的权限实测 0700 / 0600。
- OpenCode connector 的 user agent 带版本：镜像的 bundle 里内联了 `gateway/package.json` 的版本（`1.0.0`）。

待测：arm64；镜像对真实 OpenAI / Anthropic / OpenRouter / xAI 的请求；不设 `AIHUB_BUN_IMAGE`、由 `docker` 自己拉取固定摘要的基础镜像来构建。
