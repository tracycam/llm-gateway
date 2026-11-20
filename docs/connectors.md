# Gateway connectors: upstream wire facts

Research record for `TODO.md` 阶段 7, collected 2026-11-18. It is the reference for the protocol
modules and for each connector. Every fact carries its evidence: **文档** = official documentation
or spec, **代码** = read in the named repository and file, **实测** = fetched live, **未证实** =
could not be verified. Nothing here has been measured against a real account by us yet; where a
connector step later measures something, it is recorded in `TODO.md`.

Sources read: `openai/codex@main`, `microsoft/vscode@main`, `anomalyco/opencode@dev` (was
`sst/opencode`), `BerriAI/litellm@main`, `can1357/oh-my-pi`, `openai/openai-openapi@master`
(`openapi.yaml`, info.version 2.3.0), `docs.x.ai/openapi.json`, platform.claude.com,
openrouter.ai docs and live `/api/v1/models`, docs.github.com, learn.chatgpt.com.

---

## 1. Usage semantics across protocols (the biggest trap)

| Protocol | Input count | Cache read | Cache write | Output | When it arrives |
|---|---|---|---|---|---|
| Chat Completions (OpenAI) | `prompt_tokens` **includes** cached | `prompt_tokens_details.cached_tokens` (subset) | `prompt_tokens_details.cache_write_tokens` (new in the 2026 spec) | `completion_tokens` | streaming: only with `stream_options.include_usage`, in one extra chunk before `[DONE]` whose `choices` is `[]`; lost if the stream is interrupted |
| Messages (Anthropic) | `input_tokens` **excludes** cache read and write | `cache_read_input_tokens` | `cache_creation_input_tokens` | `output_tokens` | always: `message_start` (input side), `message_delta` (output; counters are **cumulative**) |
| Responses (OpenAI) | `input_tokens` includes cached | `input_tokens_details.cached_tokens` | `input_tokens_details.cache_write_tokens` | `output_tokens` | on `response.completed.response.usage` |

The gateway bills three kinds: input, output, cache read. Its normalized usage holds two disjoint
input counts — plain input and cache read — and output. A cache write is input: Anthropic's
`input_tokens` plus `cache_creation_input_tokens`, and for Chat and Responses the uncached
remainder of `prompt_tokens` / `input_tokens` (any cache-write detail stays inside that remainder).
Cache reads are billed at the cache-read price, or the input price when the model prices none.
Summing Anthropic's `input_tokens` as if it were `prompt_tokens` undercounts; adding its cache
fields into input and also charging them separately double-counts. — **文档** (Anthropic streaming
page; OpenAI spec "Cached tokens present in the prompt"; OpenRouter usage page).

---

## 2. Anthropic Messages API

- Base `https://api.anthropic.com`; `POST /v1/messages`, `GET /v1/models`. — **文档**
- Auth: `x-api-key: <key>` or `Authorization: Bearer <key>`; both appear in current examples. — **文档**
- `anthropic-version: 2026-10-21` in every current example (whether it is the latest: **未证实**).
  Optional `anthropic-workspace-id`. — **文档**
- `GET /v1/models`: query `after_id`, `before_id`, `lifecycle[]`, `limit` (default 20, max 1000).
  Response `{data: [ModelInfo], first_id, has_more, last_id}`. `ModelInfo`: `id`, `display_name`,
  `created_at`, `lifecycle`, `line`, `max_input_tokens`, `max_tokens`, `capabilities{…}`.
  **No price.** — **文档** https://platform.claude.com/docs/en/api/models/list
- Non-streaming `usage`: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens` (+ `server_tool_use`). — **文档** (field set confirmed on the
  streaming page; the non-streaming object reference was not fetched: **未证实, likely identical**)
- SSE flow: `message_start` → (`content_block_start` → `content_block_delta`* →
  `content_block_stop`)* → `message_delta`* → `message_stop`, with `ping` interleaved. — **文档**
  https://platform.claude.com/docs/en/build-with-claude/streaming
- Delta types: `text_delta{text}`, `input_json_delta{partial_json}`, `thinking_delta{thinking}`,
  `signature_delta{signature}` (just before `content_block_stop`). — **文档**
- A mid-stream error is `event: error` with `{type: "error", error: {type, message}}`, for example
  `overloaded_error`. — **文档**
- `stop_reason`: `end_turn`, `tool_use`, `max_tokens`, `stop_sequence` (`pause_turn`, `refusal`:
  **未证实**). — **文档**
- Error body `{type: "error", error: {type, message}, request_id}`; header `request-id`.
  `400 invalid_request_error`, `401 authentication_error`, `402 billing_error`,
  `403 permission_error`, `404 not_found_error`, `409 conflict_error`, `413 request_too_large`,
  `429 rate_limit_error`, `500 api_error`, `504 timeout_error`, `529 overloaded_error`.
  Retryable: 429, 500, 504, 529, honoring `retry-after`. — **文档**
  https://platform.claude.com/docs/en/api/errors
- `thinking` blocks carry a `signature`; a modified `thinking` / `redacted_thinking` block in the
  latest assistant message is a hard 400, and blocks must be echoed back. — **文档**

## 3. OpenAI API (Chat Completions)

- Base `https://api.openai.com/v1`; `Authorization: Bearer`. — **文档**
- `stream_options.include_usage: true`: one additional chunk before `data: [DONE]`, with `usage`
  for the whole request and `choices: []`; `usage` is null on every other chunk. — **文档**
  `openapi.yaml` (`CreateChatCompletionRequest.stream_options`, `ChatCompletionChunk.usage`)
- `usage`: `prompt_tokens`, `completion_tokens`, `total_tokens`,
  `prompt_tokens_details{audio_tokens, cached_tokens, text_tokens, image_tokens, cache_write_tokens}`,
  `completion_tokens_details{reasoning_tokens, audio_tokens, accepted_prediction_tokens,
  rejected_prediction_tokens, text_tokens}`. — **文档**
- `GET /v1/models` → `{object: "list", data: [{id, created, object, owned_by, shutdown_date?}]}`.
  **No context length, no price.** — **文档**

## 4. OpenRouter

- Base `https://openrouter.ai/api/v1`. — **文档**
- `GET /api/v1/models` (auth optional). Entry: `id`, `name`, `context_length`,
  `architecture{input_modalities[], output_modalities[]}`,
  `pricing{prompt, completion, input_cache_read, input_cache_write, …}`,
  `top_provider{context_length, max_completion_tokens}`, `supported_parameters[]`, …
  — **文档 / 实测** (live fetch 2026-11-18)
- **Price units: USD per token, as strings.** `"prompt": "0.000008"` = $8 per 1M tokens.
  `-1` marks dynamic routers (no fixed price), `0` marks `:free`. — **文档 / 实测**
- Headers `HTTP-Referer`, `X-OpenRouter-Title` (`X-Title` still accepted) are attribution only; no
  header is required to make a request. — **文档** https://openrouter.ai/docs/app-attribution
- Usage is always included; `usage: {include: true}` and `stream_options.include_usage` "are
  deprecated and have no effect". Chat usage additionally carries `cost` and
  `cost_details{upstream_inference_cost}`; `prompt_tokens_details{cached_tokens,
  cache_write_tokens}`. — **文档** https://openrouter.ai/docs/use-cases/usage-accounting
- Error body shape: **未证实** (not researched). A 200 with a top-level `error` object has been
  reported by the design review as common here: **未证实**.

## 5. xAI (Grok)

- Base `https://api.x.ai`; `Authorization: Bearer`. Serves `/v1/chat/completions`, `/v1/responses`,
  `/v1/messages`. Its own docs call Chat Completions legacy and promote Responses. — **文档**
  `docs.x.ai/openapi.json`, `docs.x.ai/llms.txt`
- `GET /v1/models` entries carry price and context length: `context_length`,
  `prompt_text_token_price`, `cached_prompt_text_token_price`, `completion_text_token_price`, …
  (optional / nullable). **Units: integer USD cents per 100 million tokens**
  (USD per 1M = value ÷ 10 000). — **文档**; the multiplier was not cross-checked against the
  pricing page: **未证实 numerically**
- Usage: OpenAI-shaped (`prompt_tokens`, `completion_tokens`, `prompt_tokens_details`, …) plus
  `cost_in_usd_ticks` (10 000 000 000 ticks per dollar). — **文档**

---

## 6. Translating between protocols

1. **Tool-call streaming.** Chat: `delta.tool_calls[i]{index, id?, type?, function{name?,
   arguments}}`; `id` and `name` only in the first chunk, `arguments` is a JSON **string**
   fragment, parallel calls are told apart by `index`. Messages: `content_block_start{index,
   content_block: {type: "tool_use", id, name, input: {}}}`, then
   `content_block_delta{delta: {type: "input_json_delta", partial_json}}`, then
   `content_block_stop`; in the final message `input` is an **object** — parse only at
   `content_block_stop`. Responses: `response.output_item.added{item: {type: "function_call",
   call_id, name, arguments: ""}}` → `response.function_call_arguments.delta` → `.done`.
   — **文档** (Anthropic), **代码** `codex-rs/codex-api/src/sse/responses.rs:411-560`
2. **System prompt.** Chat: a `role: "system"` message. Messages: top-level `system`, a string or
   a block array (Copilot's `/v1/messages` requires the array). Responses: top-level
   `instructions`; the ChatGPT backend wants system input items as `developer`. — **代码**
3. **Reasoning.** Messages `thinking` blocks with `signature`; Responses `reasoning` items with
   `encrypted_content`; Chat has no field, only the non-standard `reasoning_content`. — **文档 / 代码**
4. **Stop reasons.** Messages `end_turn | tool_use | max_tokens | stop_sequence`; Chat
   `stop | tool_calls | length | content_filter`; Responses `status` +
   `incomplete_details.reason`. `tool_use` ↔ `tool_calls`, `end_turn` ↔ `stop`,
   `max_tokens` ↔ `length`. — **文档**
5. **Token limit.** Chat `max_tokens` / `max_completion_tokens`; Responses `max_output_tokens`;
   Messages requires `max_tokens`. — **文档**
6. **`tool_choice`.** Messages `{type: "auto" | "any" | "tool" | "none"}`; Chat
   `"auto" | "none" | "required" | {type: "function", function: {name}}`; `any` ↔ `required`. — **文档**
7. **Images.** Messages `{type: "image", source: {type: "base64" | "url", …}}` and
   `{type: "document"}`; Chat `{type: "image_url", image_url: {url}}`; Responses
   `{type: "input_image"}`. — **文档**
8. **Caching.** Anthropic is explicit (`cache_control` on blocks; writes are billed); OpenAI caches
   by itself and only reports counts. — **文档**

Existing translators worth reading (all MIT unless noted):
`BerriAI/litellm` `litellm/llms/anthropic/chat/transformation.py` (Chat → Messages),
`litellm/llms/openai/chat/gpt_transformation.py`, `vercel/ai`
`packages/openai/src/responses/convert-to-openai-responses-input.ts`,
`litellm/llms/github_copilot/{chat,responses,messages}/transformation.py`.

### Responses is passthrough only

Added 2026-11-18 with the third inbound entry, `POST /v1/responses`. The gateway converts nothing
between Responses and Chat or Messages in either direction: a request in Responses form goes only
to an upstream whose model speaks Responses, and the answer comes back untouched. A route whose
upstream speaks another protocol is skipped without contacting it and without counting a failure;
when no route of the model can serve the request, the client gets a 400 naming the interfaces the
model does have, for example `Model "x" is not available on /v1/responses; use
/v1/chat/completions`. A model is not required to be callable on every interface. — **代码**
`gateway/protocols/responses.ts`, `gateway/inference/{attempt,handler}.ts`

The frame kinds the gateway uses (same meaning as for Chat and Messages: preamble is held so a
failure before content can fail over, content starts the client's answer, end terminates the
stream and settles the request):

| Responses frame | Kind | Why |
|---|---|---|
| `response.created`, `response.in_progress`, a queued frame | preamble | the model has produced nothing yet |
| an output item, a content part, a text or argument delta, and later frames | content | the answer began |
| `response.completed`, `response.incomplete` | end | carries `response.usage`; the normal end |
| `response.failed`, `error` | error | carries the message |
| `[DONE]` | end | not part of the official stream; tolerated |

Event names: **代码** `codex-rs/codex-api/src/sse/responses.rs:411-560` (§8 above) and the public
Responses streaming events; the classification above is **代码** `gateway/protocols/responses.ts`.
A frame may name its kind in the `event:` line, in the data's `type` member, or both. Usage is
`input_tokens` minus `input_tokens_details.cached_tokens` as input, that cached subset as cache
reads, `output_tokens` as output (§1), read from `response.completed.response.usage` or the
non-streaming body's `usage`. A stream that ends after content without a terminal event gets one
gateway-generated `event: error` frame whose data is the OpenAI error object — **代码**.

Responses routes: `openai-compatible` and `xai` send it to `<base>/responses` (§3, §5), OpenCode
Zen and Go to `<base>/openai/v1/responses` (§9). `openrouter` and `anthropic-compatible` stay as
they are; this document records no Responses path for OpenRouter, so a Responses client on such a
model gets the 400 above. None of this has been measured against a real Responses upstream:
**未证实**.

---

## 7. GitHub Copilot

### Which implementation to follow

No permissively licensed package speaks `api.githubcopilot.com` from TypeScript:
`@vscode/copilot-api` is licensed for use "only with the Visual Studio Code or Code-OSS and
successor Microsoft products"; `@github/copilot-sdk` (MIT) is a JSON-RPC client to a `copilot`
CLI process; `copilot-api` (ericc-ch) is a year stale and declares no license;
`@oh-my-pi/pi-ai` (MIT) is 8.3 MB with one maintainer. So the connector is a port, from:

| Source | License | What to take |
|---|---|---|
| `microsoft/vscode` `src/vs/platform/agentHost/node/shared/copilotApiService.ts` (2026-11-13, `3f0859c68d`) | MIT | credential model, `/v1/messages` header set, `endpoints.api` discovery with 401/403 invalidation |
| `anomalyco/opencode` `packages/core/src/plugin/provider/github-copilot.ts`, `packages/core/src/github-copilot/models.ts` (`8de2338c48`) | MIT | device-code flow, model catalog (`supported_endpoints`, prices), headers |
| `BerriAI/litellm` `litellm/llms/github_copilot/*` (`9c5cd5a745`) | MIT (outside `enterprise/`) | transformers for the three routes, usage normalization |
| `can1357/oh-my-pi` `packages/catalog/src/wire/github-copilot.ts` | MIT | newest identity headers |

### Login (device code)

- `POST https://github.com/login/device/code`, JSON `{client_id, scope: "read:user"}` →
  `device_code`, `user_code`, `verification_uri`, `interval`. — **代码** litellm, opencode
- Poll `POST https://github.com/login/oauth/access_token`, `{client_id, device_code,
  grant_type: "urn:ietf:params:oauth:grant-type:device_code"}` → `{access_token}` or `{error}`;
  `authorization_pending` → wait `interval`; `slow_down` → wait longer. — **代码** opencode
- `client_id`: `Iv1.b507a08c87ecfe98` (the VS Code Copilot OAuth app; default in litellm and
  several others), or a client's own GitHub App (opencode: `Ov23li8tweQw6odWQebz`) — an own app
  needs the *Copilot Requests* permission and integration id `copilot-developer-cli`. — **代码**
- Scope is only `read:user`. Accepted credential kinds per GitHub: `gho_`, `ghu_`,
  `github_pat_` (fine-grained, with *Copilot Requests*); classic `ghp_` is rejected. — **文档**
  https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/github-oauth

### Credential

- **Current:** the GitHub OAuth token itself is the API credential — `Authorization: Bearer
  <github token>`; no Copilot token is minted. VS Code: "The GitHub user token IS the credential.
  There is no Copilot session-token mint". — **代码** `copilotApiService.ts:429-440`; **文档**
  (GitHub's credential table names no exchange step)
- The API base is discovered per token: `GET https://api.github.com/copilot_internal/user`
  (`X-GitHub-Api-Version: 2025-04-01`) → `endpoints.api`; cached, invalidated on 401/403. — **代码**
- Legacy, still working: `GET https://api.github.com/copilot_internal/v2/token`
  (`Authorization: token <…>`) → `{token, expires_at, refresh_in, endpoints.api, …}`. Whether it
  is deprecated: **未证实**.
- Default bases: individual `https://api.githubcopilot.com`, business
  `https://api.business.githubcopilot.com`, enterprise `https://api.enterprise.githubcopilot.com`;
  do not hardcode, read `endpoints.api`. — **代码**

### Request headers

- `Authorization: Bearer …` — mandatory.
- `Copilot-Integration-Id` — changes **authorization**, not only telemetry (the limited
  integration is refused premium models). Seen: `vscode-chat`, `copilot-developer-cli`. — **代码**
  `copilotApiService.ts:31-49`
- `Editor-Version`, `Editor-Plugin-Version`, `User-Agent`; `Openai-Intent`
  (`conversation-agent`, `conversation-panel`, `messages-proxy`, …); `X-GitHub-Api-Version`
  (`2025-04-01`, `2026-01-09`, `2026-08-01` are all in use; the date gates how rich `/models` is);
  `Copilot-Vision-Request: true` when the body has an image; optional `X-Initiator: user | agent`,
  `x-request-id`. Newest CLI identity: `Copilot-Harness-Id: copilot-sdk` with
  `Copilot-Integration-Id: copilot-developer-cli`, `Editor-Version: copilot/1.0.82`. — **代码**
- Which of the editor headers are strictly mandatory: **未证实**. None of these headers is
  documented by GitHub. — **文档** (absence)

### Models and protocol per model

- `GET {base}/models` → `{data: [...]}`; only entitled models are listed. Entry: `id`, `name`,
  `version`, `model_picker_enabled`, `policy.state` (`"disabled"` = unusable),
  `supported_endpoints: ["/chat/completions" | "/responses" | "/v1/messages"]`,
  `capabilities.limits{max_context_window_tokens, max_output_tokens, max_prompt_tokens}`,
  `capabilities.supports{tool_calls, vision, streaming, …}`,
  `billing.token_prices{batch_size, default{input_price, output_price, cache_read_price}}`
  (units: AIC per `batch_size`; opencode converts with `usdPerMillion = 10_000 / batch_size`;
  `cache_price` was renamed `cache_read_price` at API version `2026-08-01`). — **代码** opencode
  `models.ts`
- The protocol of a request is decided from `supported_endpoints`: `/v1/messages` → Messages at
  `{base}/v1/messages`; `/responses` → Responses at `{base}/responses`; `/chat/completions` → Chat
  at `{base}/chat/completions`. Fallback when the field is missing: GPT-5 and later (except
  `gpt-5-mini`) → Responses, everything else → Chat. — **代码** `models.ts`
- Copilot's `/v1/messages` requires `system` as a block array. — **代码** `copilotApiService.ts:927-935`
- Usage: OpenAI-shaped on `/chat/completions`, Anthropic-shaped on `/v1/messages`. The claim that
  only `/v1/messages` reports cached tokens for Claude is a code comment: **未证实**.

### What the connector does with this (decisions, 2026-11-18)

`gateway/connectors/copilot.ts`. Sources read at: opencode `007afb1b`, litellm `c4e70ccc`,
vscode `3f0859c6`, oh-my-pi `2421bdb9` (all MIT). No Copilot account was used: everything here is
代码 against a stub, nothing 实测 against GitHub.

- Credential `{accessToken, apiBase}`: the GitHub OAuth token, sent directly as the bearer; no
  session-token exchange; no refresh. An upstream 401 marks the provider as needing sign-in.
- The API base is read from `copilot_internal/user` at the first use and at each model refresh and
  kept with the credential. If that lookup fails, requests fail — the default host is not guessed,
  because for a business account it answers 401 and a good credential would be marked dead. An
  address set by the administrator wins. `chat_enabled: false` is reported as "no Copilot access".
- Headers: litellm's identity set (`Copilot-Integration-Id: vscode-chat`, editor and plugin
  version, user agent, `Openai-Intent`), `X-GitHub-Api-Version: 2026-08-01` on the Copilot API
  (opencode, oh-my-pi; litellm sends `2025-04-01`) and `2025-04-01` on `api.github.com`,
  `X-Initiator: user` on every route.
- Not sent, because a connector does not see the request body: `Copilot-Vision-Request` (an image
  request may be refused — 未证实) and a per-turn `X-Initiator: agent`.
- Models: an entry whose `capabilities.type` is not `chat`, or whose `policy.state` is `disabled`,
  is left out; `model_picker_enabled: false` is kept. Prices are null: the subscription has no
  per-token price and `billing.token_prices` is not converted.
- Protocols of a model are its `supported_endpoints` in the upstream's order. opencode instead
  prefers Messages over Responses over Chat regardless of order; here the client's own interface
  is used when the model speaks it, so the order only matters for a client on another interface.
- Without `supported_endpoints`: opencode's current rule — `gpt-5` and later except `gpt-5-mini`,
  `grok-*` and `mai-code-*` → Responses, everything else → Chat.

### What GitHub says about third-party use

Documented and sanctioned: Copilot "through your application" via the Copilot SDK, per user,
billed to the user's subscription. The raw inference endpoints are not documented at all — neither
allowed nor forbidden in any page found. — **文档**
https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/github-oauth ; absence verified via
`https://docs.github.com/api/search/v1?query=api.githubcopilot.com`. The owner's decision
(2026-11-18) is to build the connector.

---

## 8. ChatGPT subscription (the Codex backend)

### Which implementation to follow

`@openai/codex-sdk` (Apache-2.0) spawns the `codex` CLI; nothing official is an in-process HTTP
library. Port from:

| Source | License | What to take |
|---|---|---|
| `openai/codex` `codex-rs/login/src/{server.rs, device_code_auth.rs, auth/manager.rs}`, `codex-rs/codex-api/src/{common.rs, sse/responses.rs, endpoint/models.rs}` (repo pushed 2026-11-18) | Apache-2.0 | the reference: OAuth parameters, device-code endpoints, request struct, SSE events |
| `BerriAI/litellm` `litellm/llms/chatgpt/{common_utils, authenticator, responses/transformation}.py` (`fd4cef22ea`) | MIT | the backend's constraints in the smallest readable form |
| `can1357/oh-my-pi` `packages/ai/src/providers/openai-codex/*` | MIT | a maintained TypeScript port |

### Login

- Issuer `https://auth.openai.com`; authorize `/oauth/authorize`, token `/oauth/token`.
  `client_id = app_EMoamEEZ73f0CkXaXp7hrann`. Scopes `openid profile email offline_access
  api.connectors.read api.connectors.invoke`. PKCE S256 and `state`. — **代码** `server.rs`,
  `auth/manager.rs`
- Browser flow: the redirect URI is `http://127.0.0.1:{port}/auth/callback` with port **1455**
  (fallback 1457); other ports are not on the allow-list. Extra authorize parameters:
  `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=…`. — **代码**
  `server.rs:79-81, 182-197, 589-607`
- **Device-code flow exists** (the one a gateway in a container can use):
  `POST https://auth.openai.com/api/accounts/deviceauth/usercode` `{client_id}` →
  `{device_auth_id, user_code, interval}`; the user visits `https://auth.openai.com/codex/device`;
  poll `POST …/api/accounts/deviceauth/token` `{device_auth_id, user_code}` (403 / 404 = keep
  waiting; 15 min timeout; 5 s default) → `{authorization_code, code_challenge, code_verifier}`;
  exchange at `POST /oauth/token` (form-encoded) with `grant_type=authorization_code`,
  `redirect_uri=https://auth.openai.com/deviceauth/callback`, `client_id`, `code`,
  `code_verifier` → `access_token`, `refresh_token`, `id_token`. — **代码**
  `device_code_auth.rs:62-147`, litellm `authenticator.py`
- Refresh: `POST /oauth/token` `{client_id, grant_type: "refresh_token", refresh_token}`. The
  refresh token rotates: one refresh at a time per provider. — **代码** `auth/manager.rs:1599-1607`
- Account id: JWT claim `["https://api.openai.com/auth"].chatgpt_account_id` of the `id_token`;
  sent as header `ChatGPT-Account-Id`. — **代码** litellm `common_utils.py`

### Inference

- `POST https://chatgpt.com/backend-api/codex/responses` (Responses protocol, SSE). — **代码**
- Headers: `Authorization: Bearer <access_token>`, `ChatGPT-Account-Id`, `originator`
  (`codex_cli_rs`), `user-agent`, `accept: text/event-stream`, `session_id`; Codex adds
  `OpenAI-Beta` and several `x-codex-*`. Which are mandatory: **未证实**. — **代码**
- Body differences from the public Responses API: `stream: true` and `store: false` are forced;
  `include` must contain `"reasoning.encrypted_content"`; the official client never sends
  `max_output_tokens`, `temperature`, `top_p`; system input items become `developer`; a fixed Codex
  system prompt is prepended to `instructions` (litellm). — **代码** `common.rs`
  (`ResponsesApiRequest`), litellm `responses/transformation.py:111-154`
- SSE events the reference client handles: `response.created`, `response.output_item.added`,
  `response.output_item.done`, `response.output_text.delta`,
  `response.reasoning_summary_text.delta`, `response.reasoning_text.delta`,
  `response.function_call_arguments.delta`, `response.custom_tool_call_input.delta`,
  `response.completed`, `response.incomplete`, `response.failed`. — **代码** `sse/responses.rs:411-560`
- Usage on `response.completed.response.usage`: `{input_tokens, input_tokens_details:
  {cached_tokens, cache_write_tokens}, output_tokens, output_tokens_details: {reasoning_tokens},
  total_tokens}`. — **代码**
- Models: `GET https://chatgpt.com/backend-api/codex/models?client_version=<version>` →
  `{models: [{slug, display_name, visibility, supported_in_api, context_window, …}]}`; use those
  with `visibility === "list" && supported_in_api`. Entry schema is known only from opencode's
  decoder. — **代码** `endpoint/models.rs`, opencode `provider/chatgpt.ts`

### Open contradiction

`opencode@dev` implements a different flow in the same week: dynamic client registration, token
endpoint `https://auth.openai.com/api/accounts/oauth/token`, `resource=https://api.openai.com/v1`,
scope `chatgpt.tokens.use.direct`, and **`https://api.openai.com/v1` as the inference base**. The
two are incompatible on the wire. Which one OpenAI intends: **未证实**. The connector follows
`openai/codex`, the reference client.

### What OpenAI says about third-party use

Sign in with ChatGPT is documented for the ChatGPT desktop app, Codex CLI and IDE extension;
programmatic use is steered to API keys; no page documents `chatgpt.com/backend-api/codex` for
third parties, allowing or forbidding. — **文档** https://learn.chatgpt.com/docs/auth . The
owner's decision (2026-11-18) is to build the connector.

---

## 9. OpenCode Zen and OpenCode Go

Added 2026-11-18 for `TODO.md` `S7.11`. Sources: opencode.ai docs (`/docs/console/models`,
`/docs/console/go`, `/docs/console/api/*`, `/docs/console/harnesses`), `anomalyco/opencode@dev`
(`a61f5ea834`, MIT; the Console server code was removed from the public tree, so server-side
facts cite the last commits that had it, `1573a7b608` / `83f2b6f67a`), and live requests to
`opencode.ai`. Rows marked **实测** were re-run by us the same day: first without a key (model
lists, the Go session-header probe, the per-route model recognition probes), then with a
temporary Console key the owner supplied, directly and through a gateway process on the dev
host ("Measured with a key" below). What is still open is in §11.

Naming: the docs now call Zen "OpenCode Models" (pay-as-you-go Console credits; provider id
`opencode` in the opencode client). Go is the subscription (provider id `opencode-go`).

### Addresses

| | Zen | Go |
|---|---|---|
| Base | `https://opencode.ai/inference` | `https://opencode.ai/inference/go` |
| Chat Completions | `POST <base>/openai/v1/chat/completions` | same, under the Go base |
| Messages | `POST <base>/anthropic/v1/messages` | same |
| Responses | `POST <base>/openai/v1/responses` | same |
| Gemini | `POST <base>/google/v1beta/models/<model>:generateContent` | same |
| Model list | `GET <base>/v1/models` | `GET <base>/v1/models` |

— **文档** (harnesses page, inference page); **实测** (every `api.*.base_url` in the two live
lists is one of these roots). There is no `<base>/openai/v1/models`.

### Authentication and required headers

- `Authorization: Bearer <key>` is accepted on every route. `x-api-key` is accepted on the
  Messages route and the model list only; on the Chat route it is not seen at all
  (`401 Missing API key.`). — **实测**. A connector sends Bearer everywhere.
- One kind of key for both: a Console API key (`oc_sk_…`), scoped to one workspace when it is
  created; whether it reaches Go models depends on that workspace's subscription. — **文档 / 代码**
  (`packages/core/src/usage-limits.ts:157-176`)
- **Go requires `x-opencode-session` on every inference request.** Without it:
  `400 {"type":"error","error":{"type":"MissingSessionID","message":"Request is missing
  x-opencode-session and cannot be routed efficiently. …"}}`, before the key is even checked;
  with any value (`probe-1`) the same request proceeds to the key check. — **实测**
- The Go page states what a client must do: send typical coding-agent traffic; "identify itself
  with its own user agent, such as `my-coding-agent/1.0`, rather than a generic SDK or
  HTTP-library name"; "send a stable session ID in `x-opencode-session` for each conversation so
  we can optimize routing and prompt caching". — **文档**
  https://opencode.ai/docs/console/go#where-can-i-use-it . For Zen the session header is
  recommended, not required. Whether a generic user agent is actually refused: **未证实** (curl's
  default was not).
- `anthropic-version` on the Messages route is not required: the same request with and without
  it returned the same 200. — **实测** (with a key)

### Which protocol a model speaks

- Each entry of the model list has `api`, an object with exactly one key naming the model's
  native protocol: `chat-completions`, `messages`, `responses` or `generate-content`. Live on
  2026-11-18 — Zen, 87 models: 27 / 18 / 34 / 8; Go, 32 models: 20 / 6 / 5 / 1. — **实测**
- The same model can be native to different protocols on the two plans (`qwen3.8-max`,
  `minimax-m3` are Chat on Zen and Messages on Go). Never infer it from the model family. — **实测**
- "Each model is listed with its native API, but every text model also works through the other
  APIs, which Console translates." — **文档** (models page, harnesses page).
- What we measured about that: without a key, an unknown model is `400 … Model is unavailable`
  on both the Chat and the Messages root, while every listed model we tried — Chat-native
  (`glm-5.3`), Messages-native (`claude-haiku-5-5`), Responses-native (`gpt-6.2-sol`),
  Gemini-native (`gemini-4-argon`) — is `401 Missing API key.` on both roots. So each root
  **recognizes** models of the other protocols. That it then answers correctly in the root's
  protocol was measured with a key: see "Measured with a key".
- All 87 + 32 entries have `type: "chat"`. Image and "System One" models are not in the list.

### Model list entry

`GET <base>/v1/models` needs no key (with a valid key it narrows to what that key may use; an
invalid key turns it into a 401). OpenAI's list envelope; per entry, the fields a connector
reads — **实测**:

| Field | Meaning |
|---|---|
| `id` | the id to send, bare (`glm-5.3`); an `opencode/…` prefix is only for opencode's own config |
| `type` | `chat` for every listed model |
| `limit.context`, `limit.output` | context length, longest answer |
| `cost.text.input.price`, `cost.text.output.price` | **USD per 1M tokens** already; `0` for the free models |
| `cost.text.input.cache.read`, `.cache.write` | USD per 1M tokens |
| `cost.text.input.overrides[]`, `cost.text.output.overrides[]` | a higher price above a context threshold (`{"when":{"context":{"gt":100000}},"price":0.5,…}`) |
| `cost.multipliers[]` | a date-triggered factor (the explorer's reading; not re-checked by us) |
| `api.<protocol>.base_url` | the native root |
| `go.monthly_usage` (Go only) | allowance in USD per month per plan, e.g. `{"go":15,"go-plus":60,"go-teams":20}`; `null` for free models |

Unit statement: "`cost` | US dollars per 1M tokens" — **文档**
https://opencode.ai/docs/console/api/models#fields .

### Usage, errors, limits — as documented (what we measured is in the next section)

- Usage: the protocol's own usage object plus `cost` (USD actually charged; `0` for free models
  and for Go within its limits) and `opencode.{billing_source, list_cost, allowance, tokens}`;
  on a Chat stream via `stream_options.include_usage`. — **文档**
  https://opencode.ai/docs/console/api/inference#cost ; confirmed, see the next section
- Error bodies differ per root: the Chat root answers `{"error":{type,message}}` for an invalid
  key but `{"type":"error","error":{…}}` for a missing one; the Messages root always uses the
  latter. — **实测**. Branch on status, not on shape.
- Free models are refused to clients other than OpenCode (docs: 403; the explorer measured
  `429 FreeUsageLimitError` with `Retry-After` in the tens of thousands of seconds, unkeyed).
  — **文档 vs 实测 (explorer)**; with a key it is the same 429, see the next section.
- Go allowance: 5-hour window 20 %, week 50 %, month 100 % of the model's monthly allowance;
  exhausted → `429 GoUsageLimitError` with `retry-after` seconds, unless "Extra Usage" lets it
  fall through to the pay-as-you-go balance. — **文档** https://opencode.ai/docs/console/go#usage-limits ;
  **代码** (`packages/console/app/src/routes/zen/util/handler.ts` @`1573a7b608`); **未证实**
- `GET <go base>/v1/usage` returns the three meters (`rolling`, `weekly`, `monthly`, each
  `{status, percent, resetsAt}`). — **代码** (`usage-limits.ts:118-190`); confirmed, next section

### Measured with a key (2026-11-18)

One Console key, valid for both plans. Each request asked for the single word OK,
`max_tokens: 32`. Total spend well under one cent.

Directly against opencode.ai — **实测**:

| Request | Result |
|---|---|
| Zen Chat root: `deepseek-v4.1-flash` (Chat-native), `claude-haiku-5-5` (Messages-native), `gpt-5.4-nano` (Responses-native), `gemini-3.5-flash-lite` (Gemini-native) | 200 each, a well-formed Chat Completions answer, `finish_reason: stop` |
| Zen Messages root: `claude-haiku-5-5`, `deepseek-v4.1-flash`, `gpt-5.4-nano` | 200 each, a well-formed Messages answer, `stop_reason: end_turn`; the Chat-native model's reasoning arrives as a `thinking` block with an empty `signature` |
| Streaming, both roots, native and non-native models | well-formed streams; the Chat root ends with `[DONE]`, the Messages root with `message_stop` |
| Chat stream WITHOUT `stream_options.include_usage` | the usage-only chunk is sent anyway |
| Go Chat root, `glm-5.3-flash`, with `x-opencode-session` and our user agent | 200; `usage.cost` is `0` |
| `GET <go base>/v1/usage` with only the Bearer key | 200, the three meters (`rolling`, `weekly`, `monthly`: `status`, `percent`, `resetsAt`) |
| Zen free model (`deepseek-v4.1-flash-free`) with the key | `429 FreeUsageLimitError`, `Retry-After: 28102` |
| Unknown model with the key | `400 {"error":{"type":"server_error","message":"Upstream request failed: Model is unavailable."}}` |
| Malformed body (`messages` not an array) | `400 {"error":{"type":"invalid_request_error",…}}` |

Usage as returned — **实测**:

- Chat root: `prompt_tokens`, `completion_tokens`, `total_tokens`,
  `prompt_tokens_details.{cached_tokens, cache_write_tokens}`, plus `cost` and
  `opencode.{billing_source, list_cost, tokens}`; `billing_source` was `balance` on Zen.
- Messages root: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`, plus the same `cost` and `opencode.*`; in a stream it is on
  `message_delta`.
- The listed price reproduces the charge: `claude-haiku-5-5`, 18 in and 4 out at $0.10 / $0.50
  per 1M = $0.0000038, equal to the upstream's `cost`.

Through the gateway (commit `288efbe`, a process on the dev host, providers `opencode` and
`opencode-go` with that key) — **实测**:

- Refresh listed 87 and 32 models, all with prices; publish, key, `/v1/models` worked.
- 16 requests, all 200: Chat and Messages, streaming and not, on `claude-haiku-5-5`,
  `gpt-5.4-nano` (Zen), `glm-5.3-flash`, `qwen3.8-flash` (Go), `deepseek-v4.1-flash` (both); a
  Chat tool call on `claude-haiku-5-5` came back as `tool_calls` with `finish_reason:
  tool_calls`. Go accepted the gateway's fallback session value.
- A Chat stream whose client did not ask for usage carried no usage chunk, and its usage was
  still recorded (0 requests with unknown usage).
- The cost the gateway recorded for Zen equals the upstream's own `cost` for the same requests.
- Neither the Console key nor the client's key appeared in the gateway's output.
- Two defects of ours showed up, neither in the connector: a model published from two
  providers listed its routes in random order (route ids are random and were the sort key), and
  the second provider's route was costed at the first provider's price. Both are being fixed.

Not exercised: an exhausted Go allowance; long-context prices; prompt caching; images; any
real client (Claude Code, opencode, Codex).

### Terms

- Zen: "Have no lock-in: use Console with any coding agent"; only the free models are restricted
  to OpenCode. — **文档**
- Go: "designed for OpenCode and other coding agents that produce similar types of requests.
  Traffic is monitored for abuse that degrades the experience for other users", followed by the
  three client requirements quoted above and a table of validated clients (Claude Code, Codex,
  …) "although we do not guarantee that they will continue to work". Nothing forbids another
  client; nothing promises it either. — **文档**

### What the connector does with this (decisions, 2026-11-18)

- Two connectors from one implementation: `opencode` (Zen) and `opencode-go`.
- The target is the root of the **client's** protocol — Chat root for a Chat client, Messages
  root for a Messages client — for every listed model, so the gateway passes the request through
  untranslated and Console does any conversion. Measured with a key for all four native
  protocols on the Chat root and three on the Messages root.
- `x-opencode-session`: the client's own header is passed on when it sends one; otherwise one
  fixed value per provider. A user agent naming the gateway is always sent.
- Prices are recorded as listed. Not applied: the long-context `overrides` and `multipliers`
  (a request above the threshold is under-costed by the gateway), and the upstream's own
  `usage.cost`. Consequence on Go: the upstream charges nothing within the allowance
  (`cost: 0`), while the gateway records the request at the listed price.

## 10. Grok subscription (OAuth) and what the three OAuth providers share

Researched 2026-11-18. Labels: **代码** read in the named repository and file, **文档** official
documentation, **实测** fetched or probed that day, **未证实** not confirmed. No Grok account was
available: everything after login is 代码 / 文档, not 实测.

### What it is

xAI ships a terminal client, Grok Build (`npm i -g @xai-official/grok`, announced 2026-05-25,
文档 https://x.ai/news/grok-build-cli), for SuperGrok / X Premium Plus subscribers. Its source is
public: `xai-org/grok-build`, Apache-2.0, read at `2bdd1d6a` (2026-09-29). xAI documents a third
party using the same login — "Use Grok in OpenCode … xAI Grok OAuth (SuperGrok Subscription)" and
"xAI Grok OAuth (Headless / Remote / VPS) — prints a code and URL" (文档
https://x.ai/news/grok-opencode). This is separate from the API-key path of §5 (`api.x.ai`).

### Which implementation to follow

| Source | Licence | Use it for |
|---|---|---|
| `xai-org/grok-build` @ `2bdd1d6a`, `crates/codegen/xai-grok-login/src/{device_code.rs,config.rs,model.rs,storage.rs,oidc/*}`, `xai-grok-shell/src/agent/proxy_headers.rs`, `xai-grok-config/src/endpoints.rs` | Apache-2.0 | every wire fact and the credential life cycle |
| `anomalyco/opencode` @ `007afb1b`, `packages/core/src/plugin/provider/xai.ts` | MIT | the TypeScript shape: device code, poll, refresh, expiry (236 lines) |
| `router-for-me/CLIProxyAPI` @ `a5e8f69e`, `internal/auth/xai/`, `internal/runtime/executor/xai_executor*.go`, `helps/xai_version.go` | MIT | a headless gateway doing the same: single-flight refresh, header set, version floor |

### Login

- Issuer `https://auth.x.ai`. Discovery document 实测 (`/.well-known/openid-configuration`, 200):
  `device_authorization_endpoint` `https://auth.x.ai/oauth2/device/code`, `token_endpoint`
  `https://auth.x.ai/oauth2/token`, `revocation_endpoint` `…/oauth2/revoke`; grants
  `authorization_code`, `refresh_token`, device code; PKCE S256; public client (auth method `none`).
- Client id of the official client: `b1a00492-073a-47ea-816f-4c329264a828` (代码 `config.rs:378-384`).
- Scope used by community clients: `openid profile email offline_access grok-cli:access api:access`
  (`grok-cli:access` "authorizes the token for API proxy requests", 代码 `config.rs:10-23`).
- **Device code** (the flow the gateway uses), 实测 without completing consent:
  `POST /oauth2/device/code` form `client_id`, `scope`, optional `referrer` →
  `{device_code, user_code, verification_uri: "https://accounts.x.ai/oauth2/device",
  verification_uri_complete, expires_in: 1800, interval: 5}`. Poll `POST /oauth2/token` with
  `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `device_code`, `client_id`:
  `authorization_pending` → keep polling, `slow_down` → add 5 s, `access_denied` /
  `expired_token` → stop. `referrer` is attribution only: the request is accepted without it and
  with an arbitrary value (实测).
- The browser flow (authorization code + PKCE on a loopback port chosen at random) exists too; the
  gateway does not use it.
- Token response: `access_token` (a JWT), `refresh_token`, `id_token`, `expires_in`. Lifetimes
  are 未证实. The official client treats a token inside its last 300 s as expired.
- **Refresh**: `POST /oauth2/token`, `grant_type=refresh_token`, `refresh_token`, `client_id`.
  Refresh tokens **rotate and are single-use**: the client holds a lock across the call "because
  a refresh token can be used only once" (代码 `storage.rs:20-22`). A gateway must refresh
  single-flight per credential and store the new refresh token before releasing any waiter.
- Errors at the token endpoint are standard OAuth (`400 {"error": "invalid_grant", …}`, 实测).

### Inference

- Host: `https://cli-chat-proxy.grok.com/v1`, **not** `api.x.ai` (文档
  https://docs.x.ai/build/enterprise, network requirements; 代码 `endpoints.rs:5`).
- Paths: `POST /chat/completions`, `POST /responses`, `POST /messages`, `GET /models`,
  `GET /user?include=subscription`. Which protocol a model speaks is the `api_backend` field of its
  `/models` entry (`responses` | `chat_completions` | `messages`); the list also carries
  `context_window`. The live list for a subscription is 未证实.
- Headers on every call (代码 `grok_auth_credentials.rs:93-110`, `proxy_headers.rs:5-32`):
  `Authorization: Bearer <access token>`, `X-XAI-Token-Auth: xai-grok-cli`,
  `x-grok-client-version`, `x-grok-client-identifier`, `x-authenticateresponse:
  authenticate-response`, `x-grok-client-mode: interactive`, a `User-Agent`; on `/models` also
  `x-userid` (and `x-email`).
- **Version gate**: a client version below 1.0.13 is refused with HTTP 426 (代码 CLIProxyAPI
  `xai_version.go:19-31`); 1.0.46 was current on npm. The value must be kept plausible.
- The official client always streams (`stream: true` with `stream_options.include_usage`);
  whether `stream: false` is accepted is 未证实.
- Usage: OpenAI-shaped on Chat; Responses terminal events also carry
  `response.usage.cost_in_usd_ticks`.
- Error body is a string, not an object (实测 without credentials): `401 {"error": "Invalid or
  expired credentials (…)"}` with a `www-authenticate` header. 429 carries `Retry-After` in
  seconds (代码); no rate-limit headers are read by the client.

### What the connector does with this (decisions, 2026-11-18)

`gateway/connectors/grok.ts`. No Grok account was used: everything here is 代码 against a stub.

- Credential `{accessToken, refreshToken, expiresAt, userId, email}`. `userId` is the `id_token`'s
  `sub` (for team logins the access token's `principal_id`), as the official client reads it.
  Expiry: `expires_in`, else the access token's `exp`, else one hour (opencode's fallback; the
  official client assumes 30 days, CLIProxyAPI nothing).
- Renewal 300 s before expiry, single-flight; a refresh answer without `refresh_token` keeps the
  old one; `invalid_grant` marks the provider as needing sign-in; a 5xx fails the route only.
- An upstream 401 for the stored access token makes it count as expired (credential field
  `renewal: "refused"`), so the next request renews; the token that renewal yields carries
  `renewal: "forced"`, and a 401 for it marks the provider as needing sign-in instead of renewing
  for ever. A renewal that became due by time clears the field. A 401 for a token that is no longer
  the stored one changes nothing (a late 401 must not write a spent refresh token back).
- Headers on inference: the `proxy_headers.rs` set. On `/models`: only what
  `remote/model_source/oai.rs` sends — bearer, `X-XAI-Token-Auth`, `x-userid`,
  `x-grok-client-version`, the client-mode header, `x-email` when known.
- Client version `1.0.46` (CLIProxyAPI's pin; the checkout at `2bdd1d6a` declares 1.0.45), user
  agent `xai-grok-workspace/1.0.46` (CLIProxyAPI's; the official client sends
  `grok-shell/<version> (<os>; <arch>)`). A 426 on `/models` is reported as "client version no
  longer accepted"; on inference it reaches the client as the upstream's 426.
- Models: the id is `model`, else `modelId`, else `id` (the official client's order); context from
  `context_window`; output limit from `max_completion_tokens` when present; prices null (no
  reference reads one); protocol from `api_backend`, Chat when it is absent (the official
  client's default).
- Scope: the six-scope community set; the official client also asks for `conversations:*` and
  `workspaces:*`.

### Open contradiction

litellm, opencode's `packages/ai` and Hermes send the same OAuth token to `https://api.x.ai/v1`;
Hermes' guide reports HTTP 403 there for ordinary SuperGrok accounts. The official client and the
enterprise document use `cli-chat-proxy`. The connector uses `cli-chat-proxy` and has no silent
fallback to `api.x.ai`.

### What Copilot, ChatGPT and Grok share

| | GitHub Copilot (§7) | ChatGPT (§8) | Grok |
|---|---|---|---|
| Device code offered | yes (the only flow) | yes | yes |
| Stored | GitHub OAuth token, API base | access + refresh token, expiry, account id | access + refresh token, expiry, user id |
| Refresh | none; re-login on 401 / 403 | rotating refresh token | rotating, single-use refresh token |
| Sent besides the bearer | integration id, editor version, API version | account id, originator, session id | token-auth marker, client version, identifier |
| Upstream protocol | per model (`supported_endpoints`) | Responses only | per model (`api_backend`) |

Consequences for the gateway: one login primitive — device code — covers all three and needs no
callback to the administrator's machine, so it works in a container; refresh is single-flight per
credential with the rotated token stored first; every one of the three needs its own header set,
and two of them need a client version that upstream checks.

Re-verified the same day: Copilot — the GitHub token is sent directly to the Copilot API (代码
`microsoft/vscode` @ `cd1322c5` `copilotApiService.ts:341`; opencode @ `007afb1b`
`github-copilot.ts:250`); device-flow client id `Iv1.b507a08c87ecfe98`. ChatGPT — device flow
`POST {issuer}/api/accounts/deviceauth/usercode`, poll `…/deviceauth/token`, exchange at
`/oauth/token` (代码 `openai/codex` @ `333ea319` `codex-rs/login/src/device_code_auth.rs`); client id
`app_EMoamEEZ73f0CkXaXp7hrann`.

## 11. Not verified

1. Whether the Copilot token exchange (`copilot_internal/v2/token`) is deprecated.
2. Which Copilot editor headers are mandatory; which `X-GitHub-Api-Version` unlocks which
   `/models` fields.
3. Copilot cached-token reporting per route; whether `stream: false` is rejected on the public
   host (asserted only for the GHE proxy).
4. ChatGPT backend: mandatory headers; the stable model list; which of the two login flows is
   intended.
5. Anthropic: whether `2026-10-21` is the latest version; `pause_turn` / `refusal` stop reasons.
6. xAI price multiplier (documented, not cross-checked); structure of `Model.pricing`.
7. OpenRouter error body shape; whether a 200 with a top-level `error` occurs.
8. OpenCode Zen / Go, still open after the keyed measurements of §9: the status and body of an
   exhausted Go allowance; whether a generic user agent or an unstable session id is ever
   refused; `cost.multipliers` and the long-context `overrides` in practice; prompt-cache
   reporting; behavior with real clients.
9. GitHub Copilot (§7), all needing a real account: whether the pinned editor / plugin versions
   and API version `2026-08-01` are accepted; whether `vscode-chat` with this client id is given
   premium models; `endpoints.api` on a business account; whether an image request without
   `Copilot-Vision-Request` is refused; quota signalling.
10. Grok subscription (§10), all needing a real account: token lifetimes; the model list a
   subscription sees; whether `stream: false` is accepted; which client version the proxy accepts
   today; quota signalling; whether `api.x.ai` accepts the token.
