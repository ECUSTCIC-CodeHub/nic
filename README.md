# NIC - 域名分发系统

基于 EdgeOne Pages Edge Functions + KV Storage 构建的域名分发管理系统，支持 Cloudflare 和 DNSPod（腾讯云）根域名分发，接入 Blessing Skin 皮肤站 OAuth 认证，内置暗色主题管理面板。

## 功能特性

- **OAuth 认证** — Blessing Skin 皮肤站 OAuth 登录，皮肤站管理员自动获得系统权限，会话存储于 KV，支持 Bearer Token + Cookie 双模式鉴权
- **DNS 服务商管理** — 支持 Cloudflare（API Token）和 DNSPod（腾讯云 SecretId/SecretKey）
- **根域名管理** — 将根域名绑定到指定 DNS 服务商
- **DNS 记录管理** — 创建/编辑/删除 DNS 记录，自动同步到 Cloudflare / DNSPod API
- **公开分发 API** — 无需认证即可查询域名解析记录
- **管理面板** — 暗色主题 SPA，包含仪表盘、服务商、域名、记录、设置五个模块
- **权限控制** — 皮肤站管理员 (permission >= 1) 或 UID 在管理员列表中的用户可操作

## 项目结构

```
nic/
├── index.html                                    # 管理面板前端 (SPA)
├── middleware.js                                  # CORS + 健康检查
├── package.json
└── edge-functions/api/
    ├── auth/
    │   ├── login.js                              # Blessing Skin OAuth 登录
    │   ├── callback.js                           # OAuth 回调 + 会话创建
    │   ├── logout.js                             # 退出登录
    │   └── me.js                                 # 获取当前用户信息
    ├── providers/
    │   ├── [id].js                               # 服务商 CRUD (单个)
    │   └── providers.js                          # 服务商列表 + 创建
    ├── domains/
    │   ├── [id].js                               # 域名 CRUD (单个)
    │   └── [id]/
    │       ├── records.js                        # DNS 记录列表 + 创建
    │       └── records/[rid].js                  # DNS 记录 CRUD (单个)
    ├── domains.js                                # 域名列表 + 创建
    ├── distribute/
    │   └── [domain]/[subdomain].js               # 公开分发 API
    ├── admin/
    │   └── config.js                             # 管理员配置
    └── init.js                                   # 系统初始化
```

## API 路由

| 路由 | 方法 | 认证 | 说明 |
|------|------|------|------|
| `/api/auth/login` | GET | 无 | 跳转 Blessing Skin OAuth |
| `/api/auth/callback` | GET | 无 | OAuth 回调 |
| `/api/auth/logout` | POST | 可选 | 退出登录 |
| `/api/auth/me` | GET | 需要 | 获取当前用户 |
| `/api/providers` | GET/POST | 管理员 | 服务商列表 / 创建 |
| `/api/providers/:id` | GET/PUT/DELETE | 管理员 | 服务商详情 / 更新 / 删除 |
| `/api/domains` | GET/POST | 管理员 | 域名列表 / 创建 |
| `/api/domains/:id` | GET/PUT/DELETE | 管理员 | 域名详情 / 更新 / 删除 |
| `/api/domains/:id/records` | GET/POST | 管理员 | 记录列表 / 创建 |
| `/api/domains/:id/records/:rid` | GET/PUT/DELETE | 管理员 | 记录详情 / 更新 / 删除 |
| `/api/distribute/:domain/:subdomain` | GET | 无 | 公开分发查询 |
| `/api/admin/config` | GET/POST | 管理员 | 系统配置 |
| `/api/init` | POST | INIT_KEY | 系统初始化 |
| `/api/health` | GET | 无 | 健康检查 |

### 分发 API 示例

```bash
# 查询 www 记录
curl https://your-domain.com/api/distribute/example.com/www

# 查询根域名 (@) 记录，使用 _ 代替 @
curl https://your-domain.com/api/distribute/example.com/_
```

响应：

```json
{
  "domain": "example.com",
  "subdomain": "www",
  "records": [
    {
      "type": "CNAME",
      "value": "cdn.example.com",
      "ttl": 600,
      "proxied": false
    }
  ]
}
```

## 部署步骤

### 1. 在 Blessing Skin 皮肤站创建 OAuth 客户端

前往皮肤站管理后台（`https://skin.mc.ecustcic.com/admin`）创建 OAuth 客户端：

- **名称**: NIC 域名分发
- **回调 URL**: `https://your-domain.com/api/auth/callback`

记录 **Client ID** 和 **Client Secret**。

> 参考: [Blessing Skin OAuth 文档](https://blessing.netlify.app/api/oauth.html)

### 2. 启用 KV Storage

1. 登录 [EdgeOne Pages 控制台](https://console.cloud.tencent.com/edgeone/pages)
2. 进入 **KV Storage** 页面，点击 **申请开通**
3. 创建命名空间（如 `nic-kv`）
4. 将命名空间绑定到项目，设置变量名为 `my_kv`

### 3. 配置环境变量

在 EdgeOne Pages 项目设置中添加以下环境变量：

| 变量名 | 说明 |
|--------|------|
| `BLESSING_SKIN_URL` | 皮肤站地址（默认 `https://skin.mc.ecustcic.com`） |
| `BLESSING_CLIENT_ID` | Blessing Skin OAuth 客户端 ID |
| `BLESSING_CLIENT_SECRET` | Blessing Skin OAuth 客户端 Secret |
| `INIT_KEY` | 系统初始化密钥（自定义，用于首次初始化管理员） |

### 4. 部署

```bash
edgeone pages deploy
```

### 5. 初始化管理员

首次部署后，调用初始化 API 设置管理员 UID：

```bash
curl -X POST https://your-domain.com/api/init \
  -H "Content-Type: application/json" \
  -d '{
    "init_key": "你设置的INIT_KEY",
    "admins": ["1", "2"]
  }'
```

> 皮肤站管理员（permission >= 1）自动拥有系统管理权限，无需手动添加到 admins 列表。

### 6. 访问管理面板

打开 `https://your-domain.com`，使用皮肤站账号登录即可进入管理面板。

## OAuth 认证流程

```
用户点击登录
    ↓
跳转皮肤站 /oauth/authorize
    ↓
用户授权
    ↓
回调 /api/auth/callback?code=xxx&state=xxx
    ↓
用 code 换取 access_token (POST /oauth/token)
    ↓
用 access_token 获取用户信息 (GET /api/user)
    ↓
判断权限 (UID 在 admins 列表 或 permission >= 1)
    ↓
创建会话，写入 KV，重定向到管理面板
```

## DNS 服务商配置说明

### Cloudflare

需要提供：
- **Zone ID** — 在 Cloudflare 仪表盘的域名概览页获取
- **API Token** — 在 [API Tokens](https://dash.cloudflare.com/profile/api-tokens) 页创建，权限需要 `Zone - DNS - Edit`

### DNSPod（腾讯云）

需要提供：
- **SecretId** — 腾讯云 API 密钥 ID
- **SecretKey** — 腾讯云 API 密钥

在 [腾讯云 API 密钥管理](https://console.cloud.tencent.com/cam/capi) 获取。

## KV 数据结构

| Key 前缀 | 说明 | 示例 |
|----------|------|------|
| `config:admins` | 管理员 UID 列表 | `["1", "2"]` |
| `config:settings` | 系统设置 | `{}` |
| `oauth:state:{state}` | OAuth 状态（一次性） | `{ redirect_uri, created }` |
| `session:{id}` | 用户会话 | `{ uid, nickname, email, permission, isAdmin }` |
| `provider:{id}` | DNS 服务商 | `{ id, type, name, config }` |
| `domain:{id}` | 根域名 | `{ id, root_domain, provider_id }` |
| `record:{domainId}:{recordId}` | DNS 记录 | `{ id, domain_id, subdomain, type, value, ttl, proxied, status, remote_id }` |

## 本地开发

```bash
# 安装 CLI（如未安装）
npm install -g edgeone-pages-cli

# 链接远程项目（KV 访问需要）
edgeone pages link

# 启动本地开发服务器
edgeone pages dev

# 访问 http://localhost:8088
```

## 技术栈

- **运行时**: EdgeOne Pages Edge Functions (V8)
- **存储**: EdgeOne Pages KV Storage
- **认证**: Blessing Skin OAuth 2.0
- **DNS API**: Cloudflare API v4 / 腾讯云 DNSPod API (TC3-HMAC-SHA256 签名)
- **前端**: 原生 HTML/CSS/JS (SPA)
- **加密**: Web Crypto API (`crypto.subtle`)

## License

MIT
