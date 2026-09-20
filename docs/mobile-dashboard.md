# 远程额度仪表盘

桌面 App **设置 → 远程仪表盘**。启用后可通过浏览器只读查看当前账号名、额度、余额和用量。无需安装独立服务或 cloudflared。

## 使用

1. 开启「启用只读仪表盘」，需要手机同网访问时开启「允许局域网访问」。默认 HTTPS 端口为 61948；相邻的 61949 端口仅监听本机回环，供内置 Tunnel 使用。
2. 保存并应用。打开本机／局域网地址即可自动登录，无需手动输入访问码。
3. 局域网使用 App 自动生成的自签名 HTTPS 证书。首次信任前，请对照浏览器证书详情与 App 中的 SHA-256 指纹；本机 IP 改变或证书到期时会在服务重启时重新生成。公网使用 Cloudflare 提供的 HTTPS 证书。
4. 本机、局域网和公网链接均通过 URL 的 `#code=...` 携带访问码。公网链接生成时同步显示二维码，手机扫码即可自动登录；网页读取后立即从地址栏移除访问码。请仅向可信任的人分享链接或二维码。访问码重置后，旧链接、旧二维码和所有现有会话立即失效；每个会话最长有效 8 小时，退出 App 或重新应用监听设置也会清除会话。

### 临时公网链接

选择「临时链接」，保存并应用。App 启动内置连接器，连接成功后显示 `https://….trycloudflare.com`。每次重启连接器会生成新地址。Quick Tunnel 无需 Cloudflare 账号，适合临时访问，不提供固定地址或可用性承诺。页面使用定时 GET 拉取，避免依赖 Quick Tunnel 不支持的 SSE。

「连接器已连接」只表示到 Cloudflare 的连接成功。App 另外使用 Chromium 网络栈（遵循系统代理）对公网只读接口做不带凭证的 HTTPS 回访，校验通过后显示「本机公网校验通过」。失败每 15 秒重试，也可点击「重新检测」；不会因暂时 DNS 失败自动生成新链接。不同网络的 DNS 传播与代理规则可能不同，若连接器在线但回访失败，可换手机移动网络或检查代理的远程 DNS 解析。公网地址复制使用 Electron 原生剪贴板，不依赖网页剪贴板权限。

### 固定域名

1. 在 Cloudflare 创建一个专用于 Navo 的 Tunnel，复制该 Tunnel Token（不是全局 API Key）。
2. 将域名的代理 CNAME 指向 `<Tunnel ID>.cfargotunnel.com`。域名需已由你的 Cloudflare 账号托管。
3. 在 App 选择「固定域名」，填写例如 `quota.example.com` 和 Tunnel Token，保存并应用。无需执行安装命令。
4. 建议在 Cloudflare Access 为该域名增加身份白名单／MFA；App 自身的访问码鉴权始终保留。

App 将 Token 转换为连接凭证，以本地配置模式启动连接器。转发规则只允许配置的域名到仪表盘回环端口，并以 404 规则兜底；不接受远端任意本地转发配置。不支持自定义 Cloudflare Endpoint。若已有 Tunnel 承载其他业务，请新建专用 Tunnel，避免影响其他连接器。

## 数据与状态

- 读取桌面 App 已同步的真实额度，沿用桌面供应商刷新机制；网页每 30 秒拉取、回到前台时刷新，可手动刷新读取最新缓存。
- 请求／Token 汇总基于本机时区的今日已记录请求；趋势显示近 24 小时。统计查询在现有 SQLite worker 中执行。账号名和卡片顺序使用用户配置。
- 额度上游同步超过 2 分钟标记过期。断网保留最后一次数据并显示过期提示，不伪装成实时数据。未取得的额度／余额显示「—」。
- 停用、认证异常、额度耗尽与数据过期均显示独立状态。
- 手机竖屏单列、横屏双列；平板竖屏双列、横屏三列；桌面三至四列。详情、圆点和曲线随视口适配。

## 安全边界

- 仪表盘独立监听，不将模型网关、管理 IPC、请求正文、API Key、分组密钥、上游错误内容或配置文件暴露到公网。
- 即使来自 localhost 也必须登录；公网和局域网均使用独立的 256 位随机访问码。
- 访问码、Tunnel 凭证、TLS 私钥使用 Electron safeStorage 加密；Linux basic_text 后端不允许保存。网页读取 URL 片段中的访问码后立即清理地址栏，不在 localStorage 保存凭证。
- 会话使用 Secure / HttpOnly / SameSite=Strict 的 `__Host-` Cookie，绑定来源、过期撤销；登录限速和总会话数有上限。
- Host 白名单、Origin 校验、跨站 API 拒绝、无 CORS 授权、CSP、防 iframe 嵌入和 `no-store` 响应。静态资源仅允许构建的 HTML、资产文件，不提供目录浏览或源码映射。
- 局域网只接受本机和私有 IPv4 来源；公网 origin 仅绑定 127.0.0.1，并要求匹配已配置的 HTTPS 域名。不信任局域网客户端提供的转发头。
- Tunnel 凭证不出现在进程参数或日志里。临时凭证文件权限为 0600，停用后删除，意外退出遗留文件在下次启动清理。正常退出 App 会停止连接器；自更新关闭，连接器随 App 更新。
- Cloudflare 是 TLS 终止方，因此需要信任 Cloudflare 对代理流量的处理；本机管理员和持有访问码的人也属于信任边界。请勿在路由器上额外转发仪表盘或模型网关端口。

## 开发与打包

- `npm run dev:mobile`：原有示例数据 UI 预览（仅 Vite 开发模式）。
- `npm run dev`：准备内置连接器、构建生产移动页面并启动桌面开发环境。
- `npm run build`：构建桌面应用及真实数据仪表盘；生产页面没有示例数据回退。
- `npm run pack` / `npm run dist`：构建并打包内置 cloudflared。
- `npm run prepare:tunnel`：开发机准备连接器。打包钩子自动针对目标平台执行同样的操作。

连接器固定为 `scripts/cloudflared-manifest.json` 中的 Cloudflare 官方版本与 SHA-256，校验失败拒绝打包。支持 macOS x64/arm64、Linux x64/arm64、Windows x64；其他架构明确报错。连接器许可证随安装包提供。升级版本时需重新核验官方资产摘要并更新清单。

## 验证命令

- `npm run test:unit`：包含 HTTPS、鉴权、跨站防护、只读隔离、限速、撤销和白名单投影测试。
- `node scripts/mobile-smoke.mjs`：需启动 dev:mobile，检查手机／平板横竖屏及桌面布局与交互。
- `node scripts/dashboard-live-smoke.mjs`：需先 build，使用隔离的 Electron 配置和模拟上游验证真实 HTTP 接口、登录、局域网和撤销。不会修改用户账号。
- `TEST_PUBLIC_TUNNEL=1 node scripts/dashboard-live-smoke.mjs`：额外建立临时 Tunnel 验证公网拒绝匿名读取及已登录读取，退出时自动关闭。公网检测使用 Electron Chromium 网络栈及系统已配置代理，不改变 App 或系统网络配置。

参考：[Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)、[本地 Tunnel 配置](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/)、[cloudflared 官方发布](https://github.com/cloudflare/cloudflared/releases)。
