# Cloudflare 私人云笔记

一个可以直接推送到 GitHub、再由 GitHub Actions 部署到 Cloudflare 的私人云笔记应用。笔记标题、正文、分类和标签在浏览器端加密，Cloudflare Worker、D1 数据库、日志和备份只保存密文与同步所需的元数据。

本项目只使用：

- Cloudflare Workers
- Workers Static Assets
- Cloudflare D1
- GitHub Actions（构建和发布）

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
| `public/sw.js` | 离线应用壳 Service Worker |
| `migrations/0001_init.sql` | D1 初始迁移 |
| `wrangler.toml` | Worker、Static Assets 和 D1 绑定 |
| `.github/workflows/deploy.yml` | GitHub Actions 构建、迁移和部署 |
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
3. Node.js 20 或更高版本（仅用于本地初始化、测试和设置 Worker Secret）。
4. Git 和 pnpm 11。仓库锁定文件是 `pnpm-lock.yaml`，CI 会使用 `pnpm install --frozen-lockfile`。
5. Cloudflare 的免费 `workers.dev` 子域名，或你自己的域名。域名注册和某些域名服务可能产生费用。

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
2. 安装 Node.js 20 和 pnpm 11。
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

## 10. 获取访问地址

`wrangler deploy` 的 Actions 日志会输出 Worker 地址，通常是：

```text
https://cloudflare-private-notes.<你的-subdomain>.workers.dev
```

也可以在 Cloudflare Dashboard 的 Worker 详情页复制 URL。打开后先注册一个测试账号，再按第 13 节执行验证。

如果绑定自定义域名，请在 Cloudflare Dashboard 为该 Worker 配置 Custom Domain，并确认 DNS、HTTPS 和域名本身的费用/套餐。项目默认 `workers_dev = true`，因此不配置自定义域名也可以使用 `workers.dev`。

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
$env:BASE_URL = "https://cloudflare-private-notes.<你的-subdomain>.workers.dev"
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

## 15. 成本和数据安全注意事项

- 项目不主动创建 R2、Queues、Durable Objects 或付费服务。
- 不要为了搜索把明文标题/正文写入 D1；全文搜索必须继续在客户端解密后执行。
- 限制单笔记密文大小、单用户笔记数量和请求体大小，避免异常流量耗尽免费额度。
- 不要开启高频 debug 日志，也不要在日志中打印密码、密钥、请求体或明文。
- D1 导出和加密备份都属于敏感数据，应离线加密保存。
- `AUTH_PEPPER` 丢失或错误轮换可能导致用户无法登录；它不能替代用户自己的加密备份。
- Cloudflare 免费额度和 GitHub Actions 免费额度不是无限资源；超额可能导致请求失败、构建受限或要求启用计费。项目不会自动升级套餐。

## 16. 常见问题

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

## 17. 许可证和贡献

发布前请补充明确的开源许可证、隐私政策和数据删除说明。提交 Pull Request 时不要包含真实密钥、用户数据、D1 导出、浏览器缓存或生产日志。
