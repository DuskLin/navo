# Navo · 技术参考

[返回中文首页](../README.md) · [English README](../README.en.md)

本文保留项目原有详细说明，供排查配置、调度、协议与存储行为时查阅。

基于 Electron、React 和 TypeScript 的 Kimi Code / DeepSeek / OpenCode Go 多账号桌面网关。

OpenCode Go 接入：在「添加账号」中选择「OpenCode Go · 订阅」，填写已订阅 Go 的 API Key。使用固定的 `https://opencode.ai/zen/go/v1`，从 `/models` 获取模型、从 `/usage` 获取 5 小时、周、月三个已用百分比窗口，界面显示剩余百分比。三个窗口中任一个新鲜额度耗尽时暂不调度，查询失败保留旧值和原同步时间。模型目录是公开接口，因此用量接口返回 401/403 时会拒绝保存密钥。

OpenCode Go 支持 Chat Completions、Responses、Anthropic Messages 三种客户端协议互转。网关按模型选原生上游协议：`gpt-*`、`grok-*`、`muse-spark-*` 使用 Responses，`minimax-*`、`qwen*` 使用 Messages，其余模型使用 Chat Completions；客户端无需跟随模型切换接口。转换请求和 JSON/SSE 响应，支持系统指令、图片、函数工具及结果、并行工具调用、Responses custom/namespace 客户端工具、思考强度、输出上限和缓存用量换算。同协议仍原样透传，开始输出后不重试。端点规则参考 [OpenCode Go 官方文档](https://opencode.ai/docs/go/#endpoints)。

跨协议需要完整消息历史，不支持引用另一上游私有的 `previous_response_id`、`conversation`、`item_reference`、`file_id`；上游托管搜索工具、后台任务和 `n>1` 返回明确的 400，不会静默丢弃。OpenCode Go 的 `/v1/messages/count_tokens` 在本地估算，并通过 `x-token-count-estimated: true` 标明，不能当作准确账单用量。跨协议转换限制单个 SSE 事件 1 MB、累计输出内容 16 MB；工具参数不合法、流中断或缺少结束事件不会伪造成功结束。OpenCode Zen 按量付费账号不在当前接入范围。

Go 请求转发 `x-opencode-session`：优先复用客户端会话头、`prompt_cache_key` 或 Anthropic `metadata.user_id` 中的会话 ID，均缺失时为本次请求生成 UUID，重试保持同一值。保留客户端 User-Agent，未提供时使用本应用标识；稳定的客户端会话标识有助于上游缓存命中。

账号编辑窗口的「可用模型」以列表展示，每个模型可勾选 Messages、Responses、Completions（Chat Completions）三种上游原生 API，至少选择一种。OpenCode Go 默认沿用按模型确定的原生协议，Kimi/DeepSeek 默认三项均选。请求优先走已勾选的同协议接口；没有同协议时，优先使用已勾选的供应商默认协议，否则按 Messages → Responses → Completions 顺序转换。手动配置按账号和模型保存，刷新、启停和重启保留；新增模型采用默认值，「恢复默认协议」清除手动配置，切换供应商也会重置。勾选表示上游确实支持该接口，不会让上游新增能力。

DeepSeek 接入：在「添加账号」中选择「DeepSeek · 按量付费」，填写开放平台 API Key。模型从官方 `/v1/models` 同步，余额从 `/user/balance` 同步，分别展示 CNY、USD 等币种，不相加或换算；明确返回不可用余额的账号暂停调度，刷新恢复可用后自动参与调度。余额查询失败会保留上次余额及同步时间，并提示错误。

DeepSeek 的原生协议路由：Chat Completions、Responses 使用 `https://api.deepseek.com/v1`，Anthropic Messages 使用 `https://api.deepseek.com/anthropic/v1/messages`。网关 `/v1/models` 汇总已启用、已同步账号的模型，客户端须指定对应模型 ID；现有 Kimi 配置示例使用 Kimi 模型，接入 DeepSeek 时需要修改客户端模型。没有硬编码 DeepSeek 模型列表或套餐额度；并发沿用上游明确值、默认 20 和手动覆盖规则。旧配置未指定供应商时按 Kimi 读取，切换供应商须重新填写 API Key。

## 多账号负载均衡

概览的账号卡片按模型分别展示今日峰期、谷期的平均首 token 时间和平均生成速度。按请求开始时间、北京时间（UTC+8）归类：周一至周五 09:00–12:00、14:00–18:00 为峰期，起点计入、终点不计入；其余包括周末为谷期。首 token 为成功且未中断、已记录首字耗时请求的算术平均（含重试等待）；速度为该时段有效流式请求的总输出 token 除以总上游流式时长（含首字等待）。无有效样本显示「—」，悬停数值查看样本数和口径。

- **账号**：支持 Kimi Code、DeepSeek 与 OpenCode Go API Key；Kimi 可选择中国区与国际区，DeepSeek 为按量付费；编辑、启停、删除；官方上游地址固定，可用模型、额度或余额与并发上限由上游同步。
- **统一账号池**：无需账号分组，所有账号共同参与调度。已有分组地址与密钥作为兼容入口保留，统一使用同一个账号池。
- **调度**：粘性会话优先；新会话统一按并发与额度均衡评分。先筛选启用状态、模型、认证、冷却、并发和已确认耗尽的额度，再复用可用的会话绑定账号，否则选择得分最高的账号。旧策略自动迁移，旧账号优先级与手动权重不再参与调度。
- **故障切换**：401/403 暂停账号；408/429/5xx、连接失败进入冷却并尝试账号池内的其他账号；429 尊重更长的 `Retry-After`（最多 24 小时）。其他 4xx 原样返回。请求最多尝试配置次数，同一账号不重复尝试。
- **网关**：只监听 `127.0.0.1`，支持 OpenAI Responses、Chat Completions 和 Anthropic Messages，包括 SSE、工具调用、取消和流式背压。已经开始返回响应后不会重试。
- **安全与状态**：系统安全存储加密、原子写入、脱敏 IPC、SQLite 仅保留最近 90 天的请求摘要（每页 10 条）、账号并发与成功率统计、启动时自动运行网关。请求记录的延迟列同时显示首字与总耗时，新增思考强度列，记录客户端显式指定的强度；不再展示 requestId，不显示或采集 traceId。旧记录未设置的字段显示「—」。

首 token 耗时从网关收到请求开始，包含重试等待，到流式响应的首个文本、思考或工具调用输出为止；仅计入可见输出，跳过心跳、初始化、usage-only 和错误事件。非流式或未收到有效输出显示「—」。观察器只解析首个有效事件前的有限数据，原始响应字节仍直接透传；不会保存响应内容。

所有新旧接入地址共享账号并发槽位和粘性会话池；会话标识按模型隔离。会话保持使用 `X-Session-Id` 请求头或 `prompt_cache_key` 字段，账号满载或故障时允许重新分配。

上游地址由区域固定为 `https://api.kimi.com/coding/v1` 或 `https://api.kimi.ai/coding/v1`，界面不可编辑，后台也不会采用提交的自定义地址。填写 API Key 后自动查询 `/models`（支持分页），保存新密钥前也会验证并同步。账号行的同步按钮可以重新获取信息；启动时自动同步未获取过或超过 30 秒的账号信息，未完成首次同步的账号暂不参与调度。

额度和并发统一从 `/usages` 同步，用量请求沿用参考项目的 `User-Agent: KimiCLI/1.6`。并发上限读取 `parallel.limit`（兼容数字和数字字符串），5 小时额度读取相应 `limits[].detail`，7 天额度读取 `usage`，总额度读取 `totalQuota`。账号列表显示剩余额度，编辑窗口展示使用进度和重置时间。用量额度、RPM、TPM、上下文长度不会被当作并发上限；查询失败或未识别到并发值时，使用默认 20 并发并显示「20（默认）」；上游返回有效值（包括 0）时优先采用上游值。旧版未保存额度的缓存会在启动时重新查询。模型和额度只读；账号并发上限支持手动设置 1–1000，手动值优先于上游值，刷新和重启均保留。点击「恢复自动」可重新采用上游值或默认 20。

## 开始使用

1. 启动应用，首屏显示网关控制、成功率，以及已关联账号的 5h / 7D 剩余额度卡片（紧凑显示剩余比例和重置时间，悬停查看额度数值与更新时间），支持单账号刷新，底部状态栏显示网关运行状态与监听地址。点击「账号管理」进入账号池和请求记录；点击「返回概览」回到首屏。
2. 在「账号池」添加 Kimi Code、DeepSeek 或 OpenCode Go 账号。选择供应商，填写对应平台生成的 API Key，自动获取上游信息，或点击「获取上游信息」手动刷新。同一模型有多个可用账号时，网关自动分配请求。
3. 根据需要修改账号并发上限；新会话自动按并发和剩余额度分配。会话保持时间可在网关设置中修改。
4. 点击「启动网关」，默认端口为 `17300`；端口占用时可停止网关后修改端口。
5. 在账号池点击「地址」「复制密钥」「Kimi 配置」或「Claude 配置」，将客户端指向本地网关。

### Kimi Code CLI

「Kimi 配置」复制的是 TOML 配置示例。合并到 Kimi CLI 的 `~/.kimi/config.toml`，保留原有其他设置；`default_model` 放在文件顶层并设为 `"navo"`。也可通过 `kimi --model navo` 选择该模型。

复制的 provider 使用 `type = "kimi"`、网关的 `/v1` 地址与本地密钥，模型使用 `kimi-for-coding`。需要其他模型时修改 `model`，并确认对应账号的上游模型列表包含它。网关不改写模型名。

### Claude Code / 其他 Anthropic 客户端

「Claude 配置」复制网关的 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 和 `ANTHROPIC_MODEL`，在启动客户端的终端中执行即可。Anthropic Base URL 不含末尾 `/v1`，SDK 会自行追加 `/v1/messages`。

### 通用 HTTP 接入

接入示例（把密钥替换为应用中复制的**网关密钥**）：

```bash
curl http://127.0.0.1:17300/v1/chat/completions \
  -H 'Authorization: Bearer <网关密钥>' \
  -H 'Content-Type: application/json' \
  -H 'X-Session-Id: my-session' \
  -d '{"model":"kimi-for-coding","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

支持的端点：`POST /v1/responses`、`POST /v1/chat/completions`、`POST /v1/messages`、`POST /v1/messages/count_tokens`、`GET /v1/models`。旧 `/groups/<分组ID>` 前缀保留兼容，但不再隔离账号池。鉴权接受 `Authorization: Bearer ...` 或 `x-api-key`，分组路径与密钥不匹配时拒绝请求。客户端提供的认证头不会透传，上游请求使用所选账号的凭据。根据账号的模型协议配置选择上游接口；同协议透传，跨协议时转换请求与响应。OpenCode Go 默认按模型选择原生协议，Kimi、DeepSeek 默认允许三种协议；勾选配置不代表上游实际支持该接口。统计读取转换前的上游用量，按客户端协议记录请求分类。

各接口的最终可用性由上游决定；模型列表汇总已启用、已同步账号的模型。请求体上限 8 MB，总超时默认 300 秒，无空闲账号时返回 503。当前不支持 WebSocket 或跨机器共享网关。

macOS 关闭窗口后网关继续运行，退出应用才停止；其他平台关闭最后一个窗口会退出应用。启用「打开应用时自动启动网关」可在下次启动时恢复监听。统计、会话保持和冷却状态仅保存在内存中，退出后清空；账号、密钥、网关设置和请求摘要持久保存。请求摘要位于用户数据目录的 `gateway.json.requests.sqlite`，不自动清理；页面仅加载 10 条。早于本次更新且已丢失的内存记录无法补回。

鉴权、来源或路由校验未通过的请求不写入永久业务历史，避免外部无密钥请求持续占用磁盘。正常接入后的请求摘要仍按原规则保存。

## 使用统计

统计查询在独立 Worker 中使用只读 SQLite 连接执行，不阻塞网关转发线程。相同在途查询会合并，结果使用有容量上限的短期缓存；新增记录或价格变化会使对应结果失效。

首页统计口径：真实 Tokens 为新增输入、输出、缓存创建和缓存命中之和；命中率为缓存命中 / 全部输入。OpenAI 输入中已包含的缓存会先扣除，Anthropic 分开的输入和缓存分别统计。流式累计用量快照合并覆盖，不重复相加。

首页统一展示当天用量；统计卡片内的刷新按钮默认 5 秒自动刷新，点击按 5 → 15 → 30 → 5 秒循环切换。趋势图支持悬停、方向键查看数值和图例开关，按小时或天聚合。用量摘要随请求永久落盘；已有记录未捕获的用量无法补回。请求费用优先采用上游报告的美元费用，否则按当前模型单价估算，手动价格优先于匹配的价格目录。估算时缺失价格与用量按 0 计，调整单价后历史估算随之变化；CNY 与 USD 分别汇总，不进行汇率换算。费用估算与订阅额度估值均不代表实际账单。

### 生成速度、中断消耗和热力图

参考 `../kimi-usage-stats` 的时长加权、消耗日历和日期下钻设计。平均生成速度按成功流式请求的输出 token 总数 / 对应上游请求时长总秒数计算（含首字等待，不含先前失败尝试），非流式、旧记录缺少时长或未报告输出的请求不参与平均。按账号 ID 分别汇总当天速度，显示在各自额度卡片内；没有有效样本时显示「—」，不展示迷你柱状图。

网关没有客户端 turnId/轮次中断标记，因此使用“中断请求消耗”口径：由网关的连接、超时和流事件直接记录中断原因，涵盖客户端断开、请求超时、上游传输截断或流内错误、网关退出。缺少正常结束标记的流也会计入；正常 HTTP 错误响应和达到 token 上限的正常终止不误算。每次请求最多计一次，保留中断前已报告的 token 与费用，未报告的用量保持未知。旧记录仅兼容已有 499 标记，无法反推出其他历史中断原因。

每日消耗热力图展示近 112 个本地自然日，周一至周日排列，5 档蓝色表示已报告的 token 总量；有请求但无用量采用斜纹。悬停显示摘要，点击日期显示当天的模型明细。热力图和明细跟随 5/15/30 秒刷新间隔更新。

## 开发

需要 Node.js 22.12 或更高版本，推荐 Node.js 22 LTS。

```bash
npm install
npm run dev
```

窗口右上角可切换浅色／深色模式，重启应用后保留选择。弹窗使用不占内容宽度的悬浮滚动条，滚动时显示，停止后自动淡出，并支持拖拽和键盘滚动。

`npm run dev` 默认启用主进程与预加载脚本监听：修改主进程后等待旧 Electron 完全退出，再启动新进程，避免单实例锁冲突；修改预加载脚本后重新加载界面。首次从旧开发实例升级时，应完整退出旧实例并重新执行此命令；仅刷新界面可能出现 `No handler registered for 'gateway:get'`，因为旧主进程尚未注册新接口。开发重启会中断正在处理的请求，运行网关时可用 `npm start` 启动稳定构建。

## 常用命令

```bash
npm run typecheck    # TypeScript 检查
npm run build        # 编译主进程、预加载脚本和界面
npm start            # 运行已编译的桌面应用
npm test             # 网关测试 + 构建 + 真实 Electron 冒烟测试
npm run test:unit    # 本地模拟上游：调度、转发、流式、存储
npm run test:smoke   # 真实 Electron：界面、加密、持久化与网关
npm run pack         # 生成当前平台的应用目录
npm run dist         # 生成当前平台的安装包
npm run format       # 格式化源代码
npm run format:check # 检查格式
```

桌面冒烟测试需要图形环境和可用的系统安全存储，使用独立临时设置目录与模拟上游，不调用真实 Kimi 服务、不消耗账号额度。截图输出至 `artifacts/`。自动化覆盖不等于真实 Kimi 账号端到端验证；模型可用性需要使用自己的 API Key 验证。

## 目录结构

```text
src/
  main/
    index.ts              # 窗口、生命周期和 IPC 处理
    services/settings.ts       # 主题设置与原子写入
    services/gateway-store.ts  # 账号分组校验、加密配置与串行写入
    services/scheduler.ts      # 并发与额度评分、会话、并发与冷却
    services/kimi-capabilities.ts # 上游模型、额度、并发信息与缓存
    services/gateway.ts        # HTTP 网关、鉴权、故障切换、SSE
  preload/index.ts        # 向界面暴露白名单 API
  shared/contracts.ts    # 跨进程类型与通信通道
  shared/kimi-quota.ts    # 上游额度窗口解析
  renderer/
    index.html
    src/
      App.tsx             # 工作空间和主题切换
      GatewayPanel.tsx    # 网关管理、账号、分组与请求记录
      OverlayScrollArea.tsx # 弹窗悬浮滚动条
      main.tsx            # React 入口和错误边界
      styles.css          # 窗口布局
      theme.css           # 浅色／深色设计变量
scripts/dev.mjs            # 开发监听、串行退出与重启
scripts/smoke.mjs          # 真实 Electron 冒烟验证
tests/gateway.test.ts      # 网关、调度、持久化测试
electron.vite.config.ts    # 开发与构建配置
electron-builder.yml       # 跨平台打包配置
```

主题设置保存在 Electron `app.getPath('userData')` 下的 `settings.json`。macOS 默认位置为 `~/Library/Application Support/Navo/settings.json`。首次启动默认浅色；设置缺失或格式无效时使用默认值。

账号与网关配置位于同目录的 `gateway.json`，使用 Electron `safeStorage` 的系统密钥加密整份配置，再以 `0600` 权限原子写入。Linux 系统密钥环不可用时拒绝保存凭据，不降级到明文存储。加密文件依赖原系统钥匙串，不适合直接复制到另一台机器；无法解密或格式损坏时保留原文件并显示启动错误，不覆盖账号数据。单实例锁防止多个进程同时写入同一份配置。

旧版 OAuth 账号会先将原加密配置备份为同目录的 `gateway.json.oauth-backup`，再转为停用、待填写 API Key 的账号；原名称和分组关联保留。填写 API Key 后可重新启用，不再进行浏览器授权或令牌刷新。

渲染进程启用了沙箱和上下文隔离，并关闭 Node.js 集成。系统操作通过预加载脚本中的受限 API 交给主进程执行，IPC 校验调用来源与输入。

## 打包

构建产物在 `out/`，打包产物在 `dist/`。已配置 macOS（DMG / ZIP）、Windows（NSIS）和 Linux（AppImage）目标。通常在对应系统中生成安装包。macOS 使用本地临时签名（ad hoc），开发者证书签名、公证和应用图标尚未配置。App 内升级使用 GitHub Releases；macOS 通过校验 ZIP 后替换应用实现无证书更新，Windows / Linux 使用 electron-updater。详见 [App 内升级](../README.md#app-内升级)。

### 自动打包与发布

GitHub Actions 工作流 `.github/workflows/release.yml` 支持两种触发方式：

- 推送 `v` 开头的版本 tag（例如 `v0.1.0`、`v0.2.0-beta.1`）：自动打包，创建 Release 草稿并上传安装包；已有 Release 时更新附件。
- 在 GitHub 发布 Release（含预发布）：按该 Release 的 tag 自动打包并上传安装包，保留已有标题和发布说明。

每次构建运行单元测试和 TypeScript 检查，仅生成 macOS x64 / arm64 的 DMG、ZIP。两种架构成功后才上传 Release 附件，安装包也在 Actions Artifacts 中保留 14 天。失败可在 Actions 页面重新运行，或手动运行工作流并指定已有 tag；相同 tag 的运行串行执行，重跑会替换同名附件。

安装包版本自动取自 tag（去掉可选的 `v` 前缀，支持 `1.2.3` 或 `1.2.3-beta.1`），仅修改 CI 工作目录，不提交版本变更。附件名称包含版本、系统与架构，避免不同平台互相覆盖。CI 使用仓库自带的 `GITHUB_TOKEN`，无需配置发布密钥；仓库或组织需允许工作流使用 `contents: write` 权限。

先将工作流合入准备发布的代码，再推送 tag：

```bash
git tag v0.1.0
git push origin v0.1.0
```

打包完成后，在 GitHub Releases 检查草稿和附件，填写发布说明并发布。也可以直接在 GitHub 创建新 tag 并发布 Release 来触发打包。CI 沿用现有签名配置，macOS 未做开发者证书签名和公证，Windows 未做代码签名。

## 协议文档

协议依据：[Kimi Code 文档](https://www.kimi.com/code/docs/)、[Kimi CLI provider 配置](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers)。

## 并发与额度均衡

新会话（或原绑定账号不可用时）的评分：

`S = 0.5 × (1 - (已占用并发 + 1) / 并发上限) + 0.25 × 5h剩余比例 + 0.25 × 7D剩余比例`

- 各比例在 0–1 范围，选择分数最高的账号。按接入下一请求后的并发计算，预占槽位后才发送请求。同分依次比较占用并发数、上次使用时间、累计请求数。
- **粘性会话优先于评分**：同模型、同会话的绑定账号只要仍可用就继续复用，保留缓存命中优势。满载、额度耗尽、冷却、认证失败等情况下才重新分配。默认保持 300 秒，每次分配续期，设为 0 关闭。
- 应用运行期间每 30 秒触发一轮信息同步，不重叠运行；网关未启动或已停止时，已启用账号的额度和余额仍会自动更新。停止网关仅停止请求转发，退出应用时才取消正在进行的后台同步并跳过剩余账号；取消不会覆盖账号信息或记录同步失败。后台刷新不清除冷却、认证失败或会话绑定，手动并发设置不被覆盖。
- 新鲜额度中任一窗口剩余为 0 时暂时跳过。超过 120 秒或越过重置时间的数据视为未知；未知窗口取候选账号已知比例的中位数，全部未知时取 50%，退化为并发均衡。同步失败保留上次真实额度及时间。
- 不保证两个窗口的百分比严格相等：请求成本不同、上游统计延迟、两个窗口余量相反及粘性会话都会影响实际分布。

## License

MIT
