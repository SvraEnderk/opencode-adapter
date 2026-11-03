# OpenCode 连接助手

SillyTavern 前端扩展：填写 OpenCode URL 后读取官方聊天模型目录，用酒馆原生下拉框选择模型；按聊天自动管理 OpenCode Go 的会话 ID。

当前版本 **0.2.0**。无新增依赖，无需服务端插件。已实测 Windows 上的 SillyTavern 1.18.0 和 TauriTavern 2.2.0；手机端正在开放兼容性测试。

## 用 Git URL 安装

打开酒馆的 **扩展程序 → 安装扩展**，粘贴以下仓库地址：

```text
https://github.com/SvraEnderk/opencode-adapter
```

“分支或标签名称”留空即使用 `main`；需要固定本次测试版本时填写 `v0.2.0`。点击“仅为我安装”，安装完成后完整刷新页面。电脑端可用 Ctrl+F5；手机端重新加载酒馆页面。

如果已有手动安装的 `opencode-adapter`，先在扩展管理中核对，避免同一插件安装两份。也可把仓库根目录的文件手动放入 `public/scripts/extensions/third-party/opencode-adapter/`。

## 配置连接

1. API 选择 **聊天补全**，来源选择 **自定义（兼容 OpenAI）**。
2. 在基础 URL 填写 `https://opencode.ai`，扩展默认转换为 Go 聊天地址。
3. 在“OpenCode 连接助手”面板选择 **Go 订阅**或**按量付费**，点击“刷新模型列表”。两种方式不会因请求失败自动切换。
4. 从酒馆原生“可用模型”下拉框选择模型；例如目录中提供的 `gemini-4-argon`。
5. 在酒馆原生密钥框填写对应 OpenCode 密钥，使用“发送测试消息”验证生成。

模型目录是公开信息，读取成功只证明目录可访问；密钥、订阅和额度需要通过实际生成确认。

| 方式 | 聊天基础 URL | 模型目录 URL |
| --- | --- | --- |
| Go | `https://opencode.ai/inference/go/openai/v1` | `https://opencode.ai/inference/go/v1/models` |
| 按量 | `https://opencode.ai/inference/openai/v1` | `https://opencode.ai/inference/v1/models` |

旧 `/zen/go/v1`、`/zen/v1` 地址会规范到相应新入口。只识别官方 HTTPS `opencode.ai` 地址，不作为任意中转代理的适配器。

## Go 会话管理

“按聊天管理 Go 会话 ID”默认开启：

- 同一聊天的普通生成、续写、重试和聊天内摘要共用一个 ID；刷新后重开聊天仍保留。
- 新聊天、分支、不同角色的同名聊天、不同群聊分别建立 ID；同一群聊的成员共用 ID。
- 酒馆内重命名聊天时保留 ID；外部工具重命名而未触发酒馆事件时会建立新 ID。
- 临时聊天在当前页面内复用内存 ID，刷新或新建临时聊天后重置。
- 独立扩展请求和原生连接测试每次使用临时 ID。

插件只覆盖本次 Go 生成的 `x-opencode-session`，保留其他请求头，不改写预设中的固定头。关闭该选项后使用预设自身请求头。按量连接不注入会话。

ID 用于请求归属，不替代每次发送聊天上下文，不增加额度，也不会修复 TLS 网络中断。

## 兼容性测试

| 环境/功能 | 当前验证情况 |
| --- | --- |
| Windows / SillyTavern 1.18.0 | 模型目录、连续对话、分支、重命名、刷新恢复和独立连接测试已实测 |
| Windows / TauriTavern 2.2.0 | Git URL 安装、模型目录、原生非流式连接测试和临时聊天流式回复已实测；该环境需配置应用内出站代理 |
| 手机浏览器连接 SillyTavern | 待设备实测；请求由其连接的酒馆服务端处理 |
| 其他手机酒馆客户端 | 待目标客户端实测；需支持 SillyTavern 第三方前端扩展 |
| 群聊 | 已通过自动检查，尚未做真实群聊生成验证 |
| 临时聊天、流式透传 | 已通过自动检查，并在 Windows / TauriTavern 2.2.0 实测临时聊天的流式回复 |

测试新客户端时，依次确认：能安装并显示 0.2.0 面板、能读取模型、选择后模型名同步、能回复一条中性测试消息、同一聊天 ID 不变、新聊天或分支 ID 改变。

无法安装通常要检查客户端是否支持 Git URL 安装及是否能访问 GitHub。安装后没有面板，检查来源是否为“自定义（兼容 OpenAI）”、URL 是否为官方地址，以及是否完整刷新。目录可用但生成失败时，检查密钥、所选模型、网络和额度；保留具体错误便于定位。

提交兼容性问题请使用 [Issues](https://github.com/SvraEnderk/opencode-adapter/issues)，附客户端名称/版本、失败步骤和已去除密钥的错误信息。

### TauriTavern 提示“安全连接失败”

如果已能读取模型，但生成时出现“安全连接失败：证书校验、系统时间、代理拦截或网络环境可能异常”，先检查 **用户设置 → TauriTavern 设置 → 系统 → 出站代理（高级设置）**。

TauriTavern 2.2.0 的原生 HTTP 客户端显式关闭自动代理，使用应用自己的出站代理设置。因此 Windows 系统代理或 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量已开启，也不代表酒馆原生请求会使用它们。插件不能通过修改请求头来解决 TLS 握手失败。

如果使用本地代理工具：

1. 开启“启用出站代理”。
2. 填写本机实际的代理地址。混合 HTTP/SOCKS 端口可尝试 `socks5h://127.0.0.1:10808`，端口必须与代理工具一致；`socks5h` 让代理处理域名解析。
3. 保留本地地址的绕过列表，保存后先点原生“发送测试消息”，再验证流式对话。

不要把此处的本机地址直接复制到手机：手机上的 `127.0.0.1` 指手机自身，需要填写手机实际可用的代理入口。没有使用代理时，不应凭空填写代理地址，应检查当地网络、证书和系统时间。

本次 Windows 实测中，应用内代理关闭时生成报 TLS 失败；配置现有本地代理后，非流式连接测试和流式回复均成功。此处理保留正常证书校验，不改变 API 密钥、模型或计费方式。

源码依据：[TauriTavern 2.2.0 HTTP 客户端池](https://github.com/Darkatse/TauriTavern/blob/v2.2.0/src-tauri/crates/tt-adapter-http/src/pool.rs)。

## 实现说明

扩展复用酒馆的密钥存储、认证、CSRF、模型选择和保存逻辑，不读取密钥明文。

对 `window.fetch` 的兼容层仅处理同源 `/api/backends/chat-completions/status`、`/api/backends/chat-completions/generate` 的 POST，且必须是 custom 来源和官方 OpenCode 地址。状态检查临时改为模型目录基础路径；Go 生成在发送前注入会话头。其他供应商请求保持原样，内部标记不会发送给酒馆后端。

聊天归属来自 `CHAT_COMPLETION_SETTINGS_READY`，ID 保存在 `opencode_adapter_session` 元数据中。独立 `ChatCompletionService` 请求没有聊天标记，使用临时 ID。原生连接测试通过当前 1.18 的固定特征（quiet、单条 user Hi）识别；正常聊天发送 Hi 不受影响。

额外请求头由酒馆自带 YAML 库解析，再以合法 YAML 的 JSON 形式传给后端；格式有误时停止该次请求并提示。流式响应原样透传，保留取消信号。目录失败最多重试一次，生成请求不自动重试。

当前不包含额度面板、采样参数适配、跨标签页首次生成锁和生成网络恢复。协议适配不改变官方订阅范围及限额。

## 开发检查

使用 Node.js 22 或更新版本，无需安装依赖：

```sh
npm test
```

当前 25 项检查覆盖模型目录、会话隔离、刷新/重命名、额外请求头、Request 输入、CSRF/密钥 ID/取消信号保留、流式透传和失败不自动重试。

官方资料：[OpenCode harnesses](https://opencode.ai/v2/docs/console/harnesses/) · [OpenCode Go](https://opencode.ai/v2/docs/console/go/)。
