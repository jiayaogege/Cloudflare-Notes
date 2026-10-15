# Cloudflare 私人云笔记

一个可以直接推送到 GitHub、再由 GitHub Actions 部署到 Cloudflare 的私人云笔记应用。笔记标题、正文、分类和标签在浏览器端加密，Cloudflare Worker、D1 数据库、日志和备份只保存密文与同步所需的元数据。仓库同时提供浏览器 PWA、Tauri 2 Android APK 和 Windows/macOS/Linux 桌面客户端打包配置。

浏览器版和 PWA 会在 Worker 部署成功后可用。Android/桌面安装包只有在 `.github/workflows/release.yml` 的 `app-v*` 标签工作流全部成功后才会出现在 GitHub Releases；在此之前不要把 `releases/latest` 当作已有安装包的保证。

本项目只使用：

- Cloudflare Workers
- Workers Static Assets
- Cloudflare D1
- GitHub Actions（构建和发布）
- PWA（Web App Manifest + Service Worker）
- Tauri 2（复用同一套 Vite/TypeScript 前端）

不依赖 R2、Queues、Durable Objects、邮件服务、第三方搜索或付费 AI 服务。项目不会主动购买付费资源，但“永久免费”无法由项目保证：Cloudflare、GitHub 的免费额度、可用地区、计费政策和域名费用都可能变化。部署后请开启用量/账单告警，并以官方页面为准：

- [Cloudflare Workers 限制与配额](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare D1 限制与配额](https://developers.cloudflare.com/d1/platform/limits/)
- [GitHub Actions 计费说明](https://docs.github.com/actions/learn-github-actions/usage-limits-billing-and-administration)

## 1. 功能和安全边界

- 注册、登录、退出、会话过期和 CSRF 校验。
- 创建、编辑、删除笔记；Markdown 编辑与预览。
- 分类、标签、自动保存。
- 客户端全文搜索；服务端不接收明文搜索词，也不建立明文索引。
- IndexedDB 保存本地密文和待同步队列；断网时可以继续编辑，联网后自动重试。
- Service Worker 只缓存应用壳和静态资源，不缓存 `/api` 响应、用户密文或明文。
- 两台设备同时修改时使用服务端版本号（compare-and-swap，CAS）检测冲突，不静默覆盖。
- D1 查询和更新都带当前用户 ID，不能通过修改 `note_id` 读取其他用户笔记。
- 可导出加密备份；服务器无法替用户解密备份。
- 响应式界面，支持桌面和移动浏览器。

E2EE 保护的是笔记数据，不隐藏登录时间、同步时间、密文大小、笔记数量、IP 和网络元数据。被恶意软件或浏览器扩展控制的设备、被替换的前端代码、弱密码、XSS 和设备丢失不在本项目的保证范围内。

当前登录协议不是 OPAQUE、SRP 等 PAKE。浏览器派生的验证器是登录所需的 bearer secret，必须使用 HTTPS、高熵密码和可信设备。服务器不知道主密码，也无法在忘记密码时恢复笔记。

## 2. 部署后的数据流

```text
浏览器
  ├─ WebCrypto：由主密码派生密钥，AES-GCM 加密/解密
  ├─ IndexedDB：本地密文、版本号、离线变更队列
  ├─ Service Worker：只缓存同源应用壳
  └─ HTTPS API ──> Cloudflare Worker
                       ├─ HttpOnly 会话 Cookie
                       └─ D1：用户认证材料、密文笔记、同步元数据
```

服务端能看到的内容包括用户 ID、认证材料哈希、会话哈希、密文、nonce、AAD、版本号、时间和大小；标题、正文、分类、标签和搜索词不会以明文上传。

## 3. 目录和关键配置

| 路径 | 用途 |
| --- | --- |
| `src/` | Vite 前端、WebCrypto、IndexedDB、同步和界面 |
| `worker/index.ts` | Cloudflare Worker API、认证、权限隔离、CAS |
| `public/manifest.webmanifest` | PWA 名称、图标、启动模式和主题色 |
| `public/sw.js` | 只缓存应用壳的 Service Worker |
| `src-tauri/` | Tauri 2 桌面/Android 客户端、HTTP 权限和应用图标 |
| `migrations/0001_init.sql` | D1 初始迁移 |
| `wrangler.toml` | Worker、Static Assets 和 D1 绑定 |
| `.github/workflows/deploy.yml` | GitHub Actions 构建、迁移和部署 |
| `.github/workflows/release.yml` | `app-v*` 标签触发的跨平台安装包和 GitHub Release |
| `scripts/smoke.mjs` | API 冒烟测试 |
| `.dev.vars.example` | 本地开发变量模板 |

部署前必须修改 [`wrangler.toml`](./wrangler.toml) 中的：

```toml
database_id = "REPLACE_WITH_D1_DATABASE_ID"
```

`database_id` 不是秘密，可以提交到 GitHub。`AUTH_PEPPER`、Cloudflare API Token、`.dev.vars*`、D1 导出和用户数据都不能提交。

### 配置分层：哪些放环境变量，哪些放 Wrangler 配置

不要把所有配置都塞进环境变量。它们的用途不同：

| 配置 | 正确位置 | 是否秘密 | 原因 |
| --- | --- | --- | --- |
| `database_id` | `wrangler.toml` 的 D1 binding | 否 | 它是 Wrangler 在部署时解析 D1 绑定的资源 ID，不是 Worker 运行时变量 |
| `database_name`、Worker `name`、`compatibility_date` | `wrangler.toml` | 否 | 属于部署配置，便于代码审查和复现 |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub `production` Environment secret，或本地环境变量 | 否，但建议不公开 | Wrangler 登录目标账号所需的 CI 参数 |
| `CLOUDFLARE_API_TOKEN` | GitHub `production` Environment secret | 是 | Wrangler 部署凭据，不能提交到仓库 |
| `AUTH_PEPPER` | Cloudflare Worker Secret（Dashboard 或 `wrangler secret put`） | 是 | Worker 运行时使用的认证密钥，不应传入普通构建变量 |
| `SESSION_TTL_SECONDS` | `wrangler.toml` 的 `[vars]` | 否 | 普通 Worker 运行时配置 |

`wrangler.toml` 不会自动把 `database_id = "$D1_DATABASE_ID"` 替换成 Shell 或 GitHub 环境变量。若强行采用环境变量，需要在 CI 中额外生成临时 Wrangler 配置文件，再通过 `--config` 部署；这会增加模板、校验和本地/CI 漂移的复杂度。单生产环境直接提交 `database_id` 是更可复现的做法。需要多个环境时，应使用 Wrangler 的 `[env.production]`、`[env.staging]` 等配置块，为每个环境绑定各自的 D1 ID。

## 4. 前置条件

需要准备：

1. GitHub 账号和一个仓库。
2. Cloudflare 账号。
3. Node.js 22.13 或更高版本（仅用于本地初始化、测试和设置 Worker Secret）。
4. Git 和 pnpm 11。仓库锁定文件是 `pnpm-lock.yaml`，CI 会使用 `pnpm install --frozen-lockfile`。
5. 已添加到当前 Cloudflare 账号且状态为 Active 的 `goho.eu.org` Zone，以及 `notes.goho.eu.org` 子域名。域名本身的注册、续费和可用性由域名提供方决定。

本地安装 pnpm：

```powershell
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm --version
```

如果系统没有 Corepack，也可以使用 `npm install --global pnpm@11.25.0`。

## 5. 创建 GitHub 仓库并推送代码

建议在 GitHub 创建一个空仓库，不要预先勾选 README、License 或 `.gitignore`，避免第一次合并产生无关冲突。

在项目目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build

git init
git branch -M main
git add .
git status
git commit -m "Initial Cloudflare private notes app"
git remote add origin https://github.com/<YOUR_GITHUB_USER>/<YOUR_REPOSITORY>.git
git push -u origin main
```

如果 Git 尚未配置身份，先执行：

```powershell
git config --global user.name "你的 GitHub 用户名"
git config --global user.email "你的 GitHub 邮箱"
```

推送前确认 `git status` 中没有以下文件：

- `.dev.vars*`
- `.env`、`.env.*`
- `.wrangler/`
- `dist/`
- `node_modules/`
- Cloudflare API Token
- `AUTH_PEPPER`
- D1 导出或用户数据

这些路径已经写入 [`.gitignore`](./.gitignore)，但仍应在提交前人工检查。

## 6. 创建 Cloudflare D1 数据库

有两种方式，选择一种即可。

### 6.1 使用 Wrangler（推荐）

先安装依赖并登录：

```powershell
pnpm install --frozen-lockfile
pnpm exec wrangler login
```

创建生产数据库：

```powershell
pnpm exec wrangler d1 create cloudflare-private-notes
```

命令会返回类似下面的信息：

```text
database_name = "cloudflare-private-notes"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

将真实 `database_id` 写入 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "cloudflare-private-notes"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
migrations_dir = "migrations"
```

提交并推送配置：

```powershell
git add wrangler.toml
git commit -m "Configure production D1 database"
git push
```

### 6.2 使用 Cloudflare Dashboard

在 Cloudflare Dashboard 中打开 **Workers & Pages → D1 → Create database**，数据库名称填写 `cloudflare-private-notes`。创建后复制数据库 ID，写入 `wrangler.toml`，再提交并推送。

不要把数据库名称误认为数据库 ID，也不要在工作流中重新创建数据库；工作流只应用已有迁移。

## 7. 创建 Cloudflare API Token

GitHub Actions 需要一个只允许部署目标账号的 API Token。打开 Cloudflare 的 **My Profile → API Tokens → Create Token → Custom token**，资源只选择目标 Cloudflare 账号。

本仓库的工作流会执行 D1 远程迁移和 Worker 部署，因此 Token 至少需要：

- `Account / Workers Scripts / Edit`
- `Account / D1 / Edit`
- `Account / Account Settings / Read`（如果控制台将账户读取权限单独列出）

首次通过 Wrangler 创建 Worker Custom Domain 时，`Account / Workers Scripts / Edit` 也用于管理该账号的 Custom Domain。Custom Domain 的 DNS 记录和证书由 Cloudflare 自动配置；不要为了此步骤直接授予整个账号的 Global API Key 或不相关的 DNS 权限。如果部署日志明确报告缺少权限，再根据该 API 错误补充最小权限。

按当前 Cloudflare 控制台中的权限名称选择最小范围即可，不要使用 Global API Key。Token 创建后只显示一次，请立即复制到 GitHub Secret；不要写入 `wrangler.toml`、README、Issue 或日志。

如果把 D1 迁移改成手动执行，则自动部署只需要 Worker 部署权限，迁移命令应由有 D1 Edit 权限的受保护流程执行。

## 8. 配置 GitHub Actions Secrets

打开 GitHub 仓库：

1. **Settings → Environments → New environment**，创建环境 `production`。
2. 可选：为 `production` 配置 Required reviewers，防止任意 push 直接修改生产数据库。
3. 进入 **Settings → Secrets and variables → Actions → Environments → production**。
4. 新增以下两个 **Environment secrets**：

| Secret | 值 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 第 7 节创建的 API Token |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Dashboard 中目标账号的 Account ID |

不要把 `AUTH_PEPPER` 放进普通 GitHub 变量或仓库文件。生产环境应把它作为 Cloudflare Worker Secret 保存，下一节会设置。

工作流文件是 [`deploy.yml`](./.github/workflows/deploy.yml)，默认只在 `main` 分支 push 时部署，也支持 **Actions → Deploy to Cloudflare → Run workflow** 手动触发。它会按顺序执行：

1. 拉取代码。
2. 安装 Node.js 22 和 pnpm 11。
3. `pnpm install --frozen-lockfile`。
4. `pnpm run typecheck`。
5. `pnpm run build`。
6. `pnpm exec wrangler d1 migrations apply cloudflare-private-notes --remote`。
7. `pnpm exec wrangler deploy`。

迁移步骤只应用尚未执行的迁移；不会每次重新创建表。Cloudflare 会记录迁移状态并在远程执行时生成备份。新增迁移必须使用更大的编号，例如 `0002_add_...sql`，先在本地验证，再提交到 GitHub。

## 9. 首次 GitHub 部署和 `AUTH_PEPPER`

### 9.1 首次部署

确认 `wrangler.toml` 已填入真实 `database_id`、GitHub `production` 环境已配置两个 Secrets 后，推送一次：

```powershell
git push origin main
```

在 GitHub 打开 **Actions → Deploy to Cloudflare**，等待绿色完成。第一次运行会创建或更新名为 `cloudflare-private-notes` 的 Worker，并发布 `dist/` 静态资源。Worker 名称必须与 `wrangler.toml` 的 `name` 完全一致。

### 9.2 设置生产 `AUTH_PEPPER`

`AUTH_PEPPER` 是服务器端 Secret，不能放进 `wrangler.toml` 的 `[vars]`。生成高熵值：

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

首次 GitHub 部署创建 Worker 后，任选一种方式设置：

**方式 A：Cloudflare Dashboard**

打开 **Workers & Pages → cloudflare-private-notes → Settings → Variables and Secrets**，新增 Secret：

```text
Name:  AUTH_PEPPER
Value: 粘贴上一步生成的随机值
```

**方式 B：Wrangler**

```powershell
pnpm exec wrangler login
pnpm exec wrangler secret put AUTH_PEPPER
```

命令提示输入时粘贴随机值，不要把值写在 PowerShell 历史、脚本或命令行参数中。

设置完成后，在 GitHub Actions 中重新运行最近一次工作流，或者再推送一个小的文档提交。此后 `/api` 才会正常处理注册和登录；在 Secret 设置前，API 返回 `server_misconfigured` 属于预期现象。

### 9.3 Secret 轮换警告

当前认证验证器由 `AUTH_PEPPER` 参与计算。直接替换生产 `AUTH_PEPPER` 会使已有验证器无法通过后续登录校验；现有会话可能在过期前继续有效，但新登录会失败。除非你已经设计并验证了用户重新注册/验证器迁移流程，否则不要随意轮换这个 Secret。至少应保存离线加密备份，并在轮换前安排维护窗口。

## 10. 配置自定义域名并获取访问地址

生产访问地址为：

```text
https://notes.goho.eu.org
```

仓库的 [`wrangler.toml`](./wrangler.toml) 已将 `notes.goho.eu.org` 声明为 Worker Custom Domain，并设置 `workers_dev = false`。首次 GitHub 部署时 Wrangler 会为该 hostname 配置 Worker Custom Domain；Cloudflare 负责对应的 DNS 记录和 TLS 证书。不要额外添加指向 `workers.dev` 的 CNAME，也不要把域名放进 Secret。

如果希望先在控制台绑定，也可以按下面的路径操作：

1. 打开 **Workers & Pages → cloudflare-private-notes → Settings → Domains & Routes**。
2. 点击 **Add → Custom Domain**，填写 `notes.goho.eu.org` 并确认。
3. 等待域名状态显示为 **Active/Ready**，再推送包含本仓库 `wrangler.toml` 的提交。

本仓库选择 Wrangler 作为路由的唯一配置来源。使用控制台完成首次绑定后，仍应保留与它完全一致的 `[[routes]]` 配置；不要在 Dashboard 再添加另一条同 hostname 的普通 Route，也不要一边删除 TOML 路由、一边让 CI 继续执行 `wrangler deploy`。

部署前检查：

1. `goho.eu.org` 已在托管该域名的 Cloudflare 账号中添加为 Zone，且 Overview 显示 **Active**。如果 Zone 还未激活，先到域名注册商处将 Nameserver 改为 Cloudflare 显示的两台 Nameserver，并等待状态变为 Active。
2. `notes.goho.eu.org` 没有与其他服务冲突的 DNS 记录。Custom Domain 创建时由 Cloudflare 配置所需记录；不要预先添加错误的 A、AAAA 或 CNAME。
3. GitHub 仓库的 `production` Environment 中，`CLOUDFLARE_API_TOKEN` 所属账号与该 Zone、D1 数据库一致，并包含第 7 节列出的 Worker、D1 和 Custom Domain 管理权限。不要使用 Global API Key。
4. 如果此前已经通过旧 `workers.dev` 地址使用应用，先在旧地址联网打开并确认所有笔记均已同步，或导出加密备份。浏览器会按 origin 隔离 IndexedDB、Cookie 和待同步队列；切换到 `notes.goho.eu.org` 后需要重新登录，旧域名 origin 中尚未同步的离线草稿不会自动迁移。此前发布的 Android/桌面安装包也固定使用旧 API 地址；由于本配置会关闭 `workers.dev`，旧安装包会失去连接。需要继续使用旧客户端时，先暂时保留 `workers_dev = true`，等新域名验证和新版客户端发布后再关闭。
5. 确认 `wrangler.toml` 中的 `database_id`、`name` 与生产资源匹配，再推送 `main`。GitHub Actions 中的 **Deploy to Cloudflare** 绿色完成后，打开下面的地址检查证书和页面。

检查 DNS、TLS 和 API：

```powershell
Resolve-DnsName notes.goho.eu.org
curl.exe -I https://notes.goho.eu.org/
curl.exe -i https://notes.goho.eu.org/api/auth/me
```

根页面应返回成功状态；未登录的 `/api/auth/me` 应返回 `401`，而不是 DNS 错误、TLS 错误或 `404`。刚绑定时 DNS 更新和证书签发可能需要等待，期间不要反复删除/重建域名；稍后重试并在 Cloudflare Worker 的 **Settings → Domains & Routes** 检查域名状态。确认可访问后，使用测试账号完成第 13 节的注册、同步与加密验证。

该 hostname 由 Wrangler 配置管理，建议不要在 Dashboard 配一个不同域名或路由。若初次部署报告 Custom Domain 权限不足，先确认 `CLOUDFLARE_API_TOKEN` 具有第 7 节的 `Account / Workers Scripts / Edit` 且属于正确账号；再根据 Actions 的具体权限错误补充最小权限。此配置关闭了 `workers.dev` 默认入口，因此部署不会把该入口作为备用地址重新开放。

## 11. 可选：Cloudflare Workers Builds 连接 GitHub

除了本仓库自带的 GitHub Actions，还可以使用 Cloudflare 的原生 GitHub 构建：

1. **Workers & Pages → 选择 Worker → Settings → Builds → Connect**。
2. 连接 GitHub 仓库。
3. Root directory 设为 `/`。
4. Production branch 设为 `main`。
5. Build command 设为 `pnpm run build`。
6. Deploy command 设为 `pnpm exec wrangler deploy`。

Dashboard 中的 Worker 名称必须与 `wrangler.toml` 的 `name` 一致。Workers Builds 适合只构建和发布静态资源/Worker；它生成的默认构建 Token 未必有 D1 Edit 权限，因此本项目仍建议使用上面的 GitHub Actions 运行生产迁移，或者在发布前手动执行 D1 迁移。不要同时让 Workers Builds 和 GitHub Actions 都对 `main` 自动部署，否则同一个提交可能被发布两次。

参考官方文档：

- [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
- [Cloudflare Wrangler Action](https://github.com/cloudflare/wrangler-action)
- [Cloudflare Workers CI/CD](https://developers.cloudflare.com/workers/ci-cd/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

## 12. 本地开发和 D1 验证

复制本地变量模板：

```powershell
Copy-Item .dev.vars.example .dev.vars
```

编辑 `.dev.vars`，至少替换：

```env
AUTH_PEPPER=一条只用于本地的随机值
```

本地迁移：

```powershell
pnpm run db:migrate:local
```

启动完整 Worker（包含本地 D1 和静态资源）：

```powershell
pnpm run cf:dev
```

默认地址通常是 `http://127.0.0.1:8787`，以终端输出为准。另一个 `pnpm run dev` 只启动 Vite，不提供 Worker API，因此不能替代 `pnpm run cf:dev`。

检查远程迁移状态：

```powershell
pnpm exec wrangler d1 migrations list cloudflare-private-notes --remote
```

手动应用远程迁移（通常由 GitHub Actions 执行）：

```powershell
pnpm run db:migrate:remote
```

生产迁移前请先阅读新增 SQL。已经应用的迁移不要直接修改或删除；需要修正时新增一个补偿迁移。

## 13. 验证清单

### 13.1 GitHub 和 Cloudflare

- [ ] `wrangler.toml` 中的 `database_id` 不是占位值。
- [ ] GitHub `production` 环境存在 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。
- [ ] API Token 只属于目标账号，没有使用 Global API Key。
- [ ] GitHub Actions 的 typecheck、build、D1 migration、deploy 均为绿色。
- [ ] Cloudflare Worker 的 Secret 中存在 `AUTH_PEPPER`，且本地和生产值不同。
- [ ] Cloudflare 用量/账单告警已开启。

### 13.2 功能和同步

- [ ] 注册、登录、退出、错误密码和会话过期正常。
- [ ] 创建、编辑、自动保存、删除笔记正常。
- [ ] Markdown 预览、分类和标签正常。
- [ ] 两个浏览器登录同一账号，可以同步新增和编辑。
- [ ] 断网时可以继续编辑，恢复网络后队列重放且不重复写入。
- [ ] 两端同时编辑同一笔记时出现冲突，并保留冲突副本。
- [ ] 客户端搜索能找到已解密笔记。
- [ ] 移动端无横向溢出。

### 13.3 E2EE 和权限隔离

- [ ] 浏览器 Network 中的请求体只有密文、随机 nonce、AAD、版本号和同步元数据，不出现标题、正文、分类、标签或明文搜索词。
- [ ] 更换 URL 中的 `note_id` 无法读取或修改其他用户的笔记。
- [ ] D1 导出中无法直接读出笔记正文。
- [ ] 会话 Cookie 为 `HttpOnly`，生产环境为 `Secure`，并使用 `SameSite=Lax`。
- [ ] 登出后旧会话不能继续同步或写入。
- [ ] CSRF、Origin、请求大小和登录频率限制按预期工作。

### 13.4 API 冒烟测试

本地测试：

```powershell
pnpm run typecheck
pnpm run build

# 另开一个终端先运行 pnpm run cf:dev
pnpm run smoke
```

测试已部署实例：

```powershell
$env:BASE_URL = "https://notes.goho.eu.org"
pnpm run smoke
```

冒烟测试会覆盖注册、会话恢复、密文笔记写入、同步、CAS 冲突、加密导出和登出后的会话失效。测试账号只用于验证，不要使用真实邮箱或真实主密码。

## 14. 发布、回滚和迁移策略

### 发布

普通发布只需要：

```powershell
git add .
git commit -m "Describe the change"
git push origin main
```

GitHub Actions 会自动构建、应用新增迁移并发布 Worker。工作流使用 `concurrency` 防止两个生产发布同时进行。

### 回滚前端或 Worker 代码

可以回滚到一个旧 commit 再推送：

```powershell
git revert <bad-commit>
git push origin main
```

不要通过回滚 Git commit 来撤销已经应用的 D1 schema migration。数据库迁移通常是向前兼容、不可逆的；需要修复时新建补偿迁移，并先使用 Cloudflare 的 D1 备份/导出能力验证恢复方案。

### 增加数据库字段

1. 新建 `migrations/0002_description.sql`。
2. 在本地执行 `pnpm run db:migrate:local`。
3. 运行 typecheck、build、smoke。
4. 提交迁移和代码。
5. 推送到 `main`，由受保护的 `production` 环境执行远程迁移。

## 15. PWA、Android 和桌面客户端

客户端不是另一套笔记后端。它们都复用当前 Vite/TypeScript 前端、WebCrypto、IndexedDB、加密备份和同步协议；Worker、D1、`AUTH_PEPPER` 和 E2EE 数据边界不变。

### 15.1 浏览器 PWA 安装

部署 `main` 成功后，用 HTTPS 打开 Worker 地址，例如：

```text
https://notes.goho.eu.org
```

项目会提供 `public/manifest.webmanifest`、应用图标和 `public/sw.js`。在支持 PWA 的浏览器中可以安装：

- Chrome/Edge 桌面：打开网站后，地址栏右侧选择“安装应用”；也可以在浏览器菜单中选择“安装 Cloudflare Private Notes”。
- Android Chrome：打开网站，菜单选择“添加到主屏幕”或“安装应用”。
- iPhone/iPad Safari：打开网站，点击分享，选择“添加到主屏幕”。

PWA 的 Service Worker 只缓存应用壳和静态资源，不缓存 `/api` 响应、笔记明文或密文响应。首次打开、首次登录和首次同步需要网络；已经解锁过的设备可以依靠 IndexedDB 继续编辑，联网后由现有队列重试同步。清除站点数据会删除本设备的本地密文和待同步队列，执行前应先完成同步并导出加密备份。

### 15.2 GitHub Actions 发布安装包

安装包由 [`release.yml`](./.github/workflows/release.yml) 构建。它只对 `app-v*` 标签自动发布；普通 `main` push 只部署 Worker 和 PWA，不会生成桌面或 Android Release。当前工作流成功前，GitHub 的 `releases/latest` 可能不存在安装包。

在已通过第 13 节验证的 `main` 分支上发布一个版本：

```powershell
git checkout main
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build

git tag -a app-v1.0.0 -m "Cloudflare Private Notes app v1.0.0"
git push origin app-v1.0.0
```

将 `app-v1.0.0` 换成新的版本号，例如 `app-v1.0.1`。不要复用已经发布过的标签；修复版本应创建新的标签。推送后，在 GitHub 的 **Actions → Build Desktop and Android Apps** 查看矩阵任务：

1. Windows x64：Tauri 安装包（通常包含 `.msi`，并按构建结果收集 `.exe`）。
2. Linux x64：`.deb`、`.rpm` 和 `.AppImage`（具体文件以该次构建产物为准）。
3. macOS Apple Silicon：`.dmg`。
4. macOS Intel：`.dmg`。
5. Android：通用 APK。
6. 发布任务计算所有安装包的 `SHA256SUMS.txt`，再创建同名 GitHub Release。

只有桌面和 Android 两个构建矩阵全部成功，发布任务才会创建 Release。安装包文件名会包含版本标签和平台，例如 `Cloudflare-Private-Notes-app-v1.0.0-windows-x64-...msi`。不要根据文件名推断签名状态，以 Release 页面中的说明为准。

当前工作流只监听 `app-v*` 标签；普通分支推送不会触发客户端打包。需要排查构建环境时，可在本地按第 15.7 节运行对应命令，正式对外发布仍应使用新的 `app-v*` 标签。

### 15.3 从 GitHub Releases 下载和校验

打开仓库的 [Releases 页面](https://github.com/jiayaogege/Cloudflare-Notes/releases)，选择目标版本。只有在第 15.2 节工作流成功后，页面才会出现安装包。

下载对应平台的安装包和 `SHA256SUMS.txt`，在下载目录执行校验：

```powershell
# Windows PowerShell
Get-FileHash .\Cloudflare-Private-Notes-app-v1.0.0-windows-x64-*.msi -Algorithm SHA256
Get-Content .\SHA256SUMS.txt
```

```bash
# macOS / Linux
sha256sum -c SHA256SUMS.txt
```

PowerShell 中将计算出的 Hash 与 `SHA256SUMS.txt` 中同名文件的值比较。macOS 没有 `sha256sum` 时可使用：

```bash
shasum -a 256 -c SHA256SUMS.txt
```

校验失败、文件名不匹配或下载来源不是该仓库的 Release 时不要安装。

### 15.4 安装 Android APK

下载 Release 中的 `...android.apk` 或 `...android-test-signed.apk` 到 Android 设备：

1. 在系统设置中临时允许用于下载的浏览器或文件管理器安装未知来源应用。
2. 点击 APK，确认安装。
3. 安装完成后关闭“未知来源安装”权限。
4. 首次登录仍使用现有账号和主密码；主密码不会上传，API 只接收认证材料和密文。

没有配置正式 Android 签名密钥时，工作流会为该次运行临时生成测试密钥，产物名称带 `android-test-signed`。测试 APK 可以正常安装和使用，但不能通过后续另一个测试密钥版本覆盖升级；升级前需要导出加密备份、卸载旧 APK、安装新 APK，再用主密码解锁并同步。正式长期分发应配置第 15.6 节的签名 Secrets。

### 15.5 安装 Windows、macOS 和 Linux 客户端

- Windows x64：下载 `.msi`（推荐）或工作流收集到的 `.exe`，按向导安装。未配置代码签名时，Windows SmartScreen 可能显示“未知发布者”；安装前先校验 SHA-256。
- macOS Apple Silicon：下载 `macos-arm64` 的 `.dmg`；Intel Mac 下载 `macos-x64` 的 `.dmg`。打开 DMG 后将应用拖到 Applications。当前工作流没有导入 Apple Developer 证书或公证流程，macOS 可能需要在“系统设置 → 隐私与安全性”中确认打开。
- Linux：`.deb` 适用于 Debian/Ubuntu，`.rpm` 适用于 Fedora/openSUSE，`.AppImage` 适用于多数桌面发行版。AppImage 需要先授予执行权限：

```bash
chmod +x Cloudflare-Private-Notes-app-v1.0.0-linux-x64-*.AppImage
./Cloudflare-Private-Notes-app-v1.0.0-linux-x64-*.AppImage
```

当前 Release 工作流没有导入 Apple Developer 证书，也没有配置 Windows Authenticode、Apple Developer ID/notarization 或 Linux 包签名 Secrets。即使为 macOS 设置了 `APPLE_SIGNING_IDENTITY`，仓库当前没有证书安装和公证步骤，不能视为可验证的 Developer ID 签名；Windows 和 Linux 包也没有受信任发布者签名。安装前应校验 SHA-256，不要为了“消除”系统警告而关闭系统安全策略。

### 15.6 Android 正式签名（可选）

只有准备长期分发 Android APK 时才配置正式签名。签名材料必须保存在密码管理器和离线备份中；丢失 keystore 将无法用同一应用身份发布升级包。

先在本地生成一个 JKS（示例有效期可按组织政策调整）：

```powershell
keytool -genkeypair -v `
  -keystore cloudflare-notes-release.jks `
  -storetype JKS `
  -alias cloudflare-notes `
  -keyalg RSA -keysize 2048 -validity 10000
```

将 JKS 转为单行 Base64。PowerShell：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes(".\cloudflare-notes-release.jks"))
```

在 GitHub 仓库打开 **Settings → Secrets and variables → Actions → New repository secret**，添加：

| Secret | 内容 |
| --- | --- |
| `ANDROID_KEY_BASE64` | 上一步得到的完整 Base64 字符串 |
| `ANDROID_KEY_PASSWORD` | JKS 的密码 |
| `ANDROID_KEY_ALIAS` | 例如 `cloudflare-notes` |

工作流会将这些 Secrets 写入临时 runner，调用 `scripts/configure-android-signing.mjs` 配置 release build，再删除 runner。不要把 JKS、Base64、密码、`keystore.properties` 或它们的日志提交到仓库。没有这三个 Secrets 时，工作流会自动使用一次性的测试签名，不会因为缺少正式密钥而阻止构建。

桌面签名目前没有对应的证书导入和公证实现，因此不要自行添加未被工作流读取的 `WINDOWS_*`、`APPLE_*` 或 `LINUX_*` Secret 并期待它们生效。需要正式桌面签名时，应先修改并审查 Release 工作流，再为每个平台增加证书安装、签名和公证步骤。

### 15.7 本地构建 Tauri 客户端

Tauri 应用标识为 `com.jiayaogege.cloudflarenotes`。本地构建需要先部署或准备一个可访问的 Worker API；前端仍然使用同一套加密和同步逻辑。

通用前置条件：

- Node.js 22.13 或更高版本、pnpm 11。
- Rust stable、Cargo 和系统 C/C++ 编译工具链。
- Windows：Visual Studio Build Tools 的 C++ 工作负载和 WebView2 Runtime。
- macOS：Xcode Command Line Tools。
- Ubuntu/Debian（与 CI 对齐）：

```bash
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  patchelf
```

安装依赖后：

```powershell
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build

# 调试运行桌面应用
pnpm run app:dev

# 构建当前操作系统的桌面安装包
pnpm run app:build
```

构建产物通常位于 `src-tauri/target/release/bundle/` 下的 `msi`、`dmg`、`deb`、`rpm` 或 `appimage` 目录。

Android 本地构建还需要 Java 17、Android Studio/SDK 命令行工具、Android platform 36、Build Tools 36.1.0、NDK 27.0.12077973 和 Rust Android targets。设置 `ANDROID_HOME` 或 `ANDROID_SDK_ROOT` 指向 Android SDK，并设置 `NDK_HOME` 指向 NDK 目录；安装目标后执行：

```powershell
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
pnpm exec tauri android init
node scripts/set-android-sdk-level.mjs
pnpm run app:android:build
```

Tauri Android CLI 生成的模板目前使用 API 37，但 Android SDK 仓库尚未提供对应的 `platforms;android-37` 包；初始化后先运行此脚本，将生成项目的 `compileSdk` 和 `targetSdk` 设为可用的稳定 API 36。

通用 APK 通常位于：

```text
src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

CI 每次从干净 runner 执行 `tauri android init`，所以 `src-tauri/gen/android` 不要求预先提交到仓库。当前开发机如果没有 Rust、Java 或 Android SDK，可以继续验证 Web/PWA，但不能声称本地已完成原生 APK/桌面包构建；以 GitHub Actions 的绿色结果为准。

### 15.8 原生 API 地址和 Tauri HTTP 权限

原生客户端构建时读取公开的 `VITE_NATIVE_API_BASE_URL`。生产默认值是：

```text
https://notes.goho.eu.org
```

可以在未提交的 `.env.local` 中覆盖：

```env
VITE_NATIVE_API_BASE_URL=https://notes.goho.eu.org
```

也可以在 PowerShell 当前进程中设置后立即构建：

```powershell
$env:VITE_NATIVE_API_BASE_URL = "https://notes.goho.eu.org"
pnpm run app:build
```

`VITE_*` 会被编译进客户端，**不是秘密变量**。不要放入 Cloudflare API Token、`AUTH_PEPPER`、主密码或任何私钥。浏览器运行时仍使用同源 `/api`，只有检测到 Tauri 运行时才使用该 API origin。

GitHub Release 工作流优先读取仓库的 **Settings → Secrets and variables → Actions → Variables** 中的 `VITE_NATIVE_API_BASE_URL`；未设置时使用上面的生产域名。建议显式新增一个 **Repository variable**（不是 Secret）：

| Name | Value |
| --- | --- |
| `VITE_NATIVE_API_BASE_URL` | `https://notes.goho.eu.org` |

这个值是公开 API 地址，不包含凭据。仓库默认配置和构建脚本已将 Tauri HTTP allowlist 与 CSP 限定到 `https://notes.goho.eu.org`。

如果改用自定义 API 域名，必须同时修改 [`src-tauri/capabilities/default.json`](./src-tauri/capabilities/default.json) 的最小 HTTP allowlist，例如：

```json
{
  "identifier": "http:default",
  "allow": [
    {
      "url": "https://notes.goho.eu.org/api/*"
    }
  ]
}
```

只添加你实际控制的 HTTPS origin，不要使用 `*`。自定义域名变更后需要重新构建客户端。Tauri HTTP 插件负责原生 Cookie jar；客户端请求会清空不匹配的浏览器 `Origin`，因此不需要为了桌面/Android 客户端放宽 Worker CORS。Worker 的 CSRF、会话 Cookie、Origin 校验和用户 ID 权限隔离仍然有效。

发布的 APK/桌面安装包会把 API origin 编译进应用。网站切换域名后，已安装的旧版本仍可能连接旧 API 地址；确认新域名和 HTTPS 正常后，基于最新 `main` 创建一个**从未发布过的新 `app-v*` 标签**，等待 **Build Desktop and Android Apps** 完成，再安装新 Release。不要覆盖或复用旧标签。需要回滚时，同时恢复 Wrangler 域名配置并重新构建/发布客户端，单独回滚 Worker 不会改变已发布应用内的地址。

### 15.9 客户端验证清单

- [ ] Worker `main` 部署成功，浏览器/PWA 能打开并完成登录。
- [ ] PWA 安装后刷新页面仍能加载应用壳；离线编辑产生待同步变更，恢复网络后队列重放。
- [ ] `app-v*` 标签工作流的 Windows、Linux、macOS、Android 矩阵全部成功。
- [ ] GitHub Release 同时包含目标平台安装包和 `SHA256SUMS.txt`。
- [ ] 下载后按第 15.3 节校验 SHA-256。
- [ ] Android 首次安装、登录、创建笔记、断网编辑、恢复同步和删除均正常。
- [ ] 桌面端登录、自动保存、跨设备同步和主题切换正常。
- [ ] 原生客户端 Network/日志中没有主密码、解密密钥、笔记标题、正文、分类或标签明文。
- [ ] 使用错误或未 allowlist 的 API origin 时，客户端构建或请求按预期失败，而不是放宽到任意域名。
- [ ] 发生 Android 测试签名升级时，先完成加密备份并确认卸载/重装后的恢复流程。

## 16. 成本和数据安全注意事项

- 项目不主动创建 R2、Queues、Durable Objects 或付费服务。
- 不要为了搜索把明文标题/正文写入 D1；全文搜索必须继续在客户端解密后执行。
- 限制单笔记密文大小、单用户笔记数量和请求体大小，避免异常流量耗尽免费额度。
- 不要开启高频 debug 日志，也不要在日志中打印密码、密钥、请求体或明文。
- D1 导出和加密备份都属于敏感数据，应离线加密保存。
- `AUTH_PEPPER` 丢失或错误轮换可能导致用户无法登录；它不能替代用户自己的加密备份。
- Cloudflare 免费额度和 GitHub Actions 免费额度不是无限资源；超额可能导致请求失败、构建受限或要求启用计费。项目不会自动升级套餐。

## 17. 常见问题

### Actions 报 `database_id` 无效

确认 `wrangler.toml` 中已经替换：

```toml
database_id = "REPLACE_WITH_D1_DATABASE_ID"
```

确认数据库属于 `CLOUDFLARE_ACCOUNT_ID` 对应的账号，并且 API Token 对该账号有 D1 Edit 权限。

### 页面能打开，但注册返回 `server_misconfigured`

Worker 尚未配置 `AUTH_PEPPER`。按第 9.2 节在 Cloudflare Dashboard 或 Wrangler 中添加 Secret，然后重新运行部署工作流。

### 本地页面打开但 API 失败

使用 `pnpm run cf:dev`，不要只使用 `pnpm run dev`。前者才会启动 Worker 和 D1 本地模拟器。

### 登录后刷新页面需要再次输入主密码

这是设计行为：主密码和解密密钥不会保存到服务器，也不会放入 `localStorage`。刷新页面后需要重新解锁，降低设备被读取时的风险。

### 忘记主密码怎么办

服务器没有明文密钥，无法替用户恢复。只能使用之前导出的加密备份，并在本地提供正确的密码解密。

## 18. 许可证和贡献

发布前请补充明确的开源许可证、隐私政策和数据删除说明。提交 Pull Request 时不要包含真实密钥、用户数据、D1 导出、浏览器缓存或生产日志。
