# Cennomo 生产部署

## 架构

- GitHub Pages：公开前端。
- Render Web Service：Node API、MCP Gateway、Worker 和无头 Chromium。
- Render Persistent Disk `/app/data`：SQLite、凭证密文和备份。
- `/app/streams`：可重新生成的浏览器画面，不保存到持久磁盘。

## 一、部署后端

1. 登录 Render，并连接 GitHub。
2. 选择 **New → Blueprint**。
3. 选择仓库 `nuttumrunit/Cennomo`。
4. Render 会读取根目录的 `render.yaml`。
5. 创建时填写：
   - `PUBLIC_ORIGIN`：预计为 `https://cennomo-api.onrender.com`，以 Render 最终显示的地址为准。
   - `CENNOMO_WEB_ORIGINS`：先填 `https://nuttumrunit.github.io`。自定义域名启用后，再追加正式前端域名，用英文逗号分隔。
6. 确认使用 `1c-2g` Web Service 和 1GB Persistent Disk。
7. 部署成功后打开 `https://你的后端地址/api/health`，应返回 `ok: true`。

`CENNOMO_WORKER_TOKEN`、`CENNOMO_ADMIN_TOKEN` 和 `CENNOMO_ENCRYPTION_KEY` 由 Render 自动生成，不要复制到仓库。

## 二、连接 GitHub Pages

1. 打开 GitHub 仓库 **Settings → Secrets and variables → Actions → Variables**。
2. 新建变量：
   - Name：`CENNOMO_API_ORIGIN`
   - Value：Render 后端 HTTPS Origin，例如 `https://cennomo-api.onrender.com`，末尾不要 `/`。
3. 打开 **Settings → Pages**，Source 选择 **GitHub Actions**。
4. 打开 **Actions → Deploy Cennomo frontend to GitHub Pages → Run workflow**。
5. Pages 地址应为 `https://nuttumrunit.github.io/Cennomo/`。

## 三、上线检查

- `/api/health` 中 `workers` 至少为 `1`。
- `/api/v1/skills` 返回 12 个工具。
- Pages 的 Gateway 页面显示 `GATEWAY ONLINE`。
- Treasury 地址当前为 `TBA`。
- CA 当前为 `TBA`，Deploy、代币燃烧与付费结算保持锁定，直到正确地址确认并重新配置。
- 7 个凭证型 Operator 保持 `learning`，直到凭证真实验证通过。

## 四、后续自定义域名

前端域名配置到 GitHub Pages；建议将 `api.你的域名` 配置为 Render 后端的自定义域名。配置完成后同时更新：

- GitHub Actions Variable `CENNOMO_API_ORIGIN`
- Render Environment Variable `PUBLIC_ORIGIN`
- Render Environment Variable `CENNOMO_WEB_ORIGINS`
