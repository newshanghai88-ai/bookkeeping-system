# Vercel 部署步骤

## 1. 准备代码

确认本地项目可以构建：

```powershell
npm.cmd install --cache .\.npm-cache
npm.cmd run build
```

## 2. 上传到代码仓库

把项目上传到 GitHub、GitLab 或 Bitbucket。Vercel 可以直接连接这些仓库进行自动部署。

## 3. 在 Vercel 创建项目

1. 打开 https://vercel.com/dashboard
2. 点击 Add New Project
3. 选择这个记账系统仓库
4. Framework Preset 选择 Vite
5. Build Command 使用：

```text
npm run build
```

6. Output Directory 使用：

```text
dist
```

Vercel 官方 Vite 文档说明，Vite 项目可以直接部署到 Vercel，并且 Vite 读取客户端环境变量时需要使用 `VITE_` 前缀。

## 4. 配置环境变量

在 Vercel 项目里打开 Settings / Environment Variables，添加：

```text
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
```

值和本地 `.env` 里保持一致。

注意：

- 不要上传 `.env` 文件。
- 修改 Vercel 环境变量后，需要重新部署才会生效。
- 这里使用的是 Supabase anon public key，前端可以使用；数据库安全靠 RLS policy 控制。

自动邮件备份还需要添加服务端环境变量：

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
RESEND_API_KEY
BACKUP_EMAIL_TO
BACKUP_EMAIL_FROM
BACKUP_SYSTEM_NAME
CRON_SECRET
```

注意：

- `SUPABASE_SERVICE_ROLE_KEY` 和 `RESEND_API_KEY` 只能放在 Vercel 服务端环境变量里。
- 这些变量不能以 `VITE_` 开头。
- 不要在前端代码里读取这些变量。
- `CRON_SECRET` 建议使用至少 16 位以上随机字符串。

## 自动备份测试

部署完成后，可以手动访问下面地址测试一次：

```text
https://your-project.vercel.app/api/weekly-backup?secret=你的CRON_SECRET
```

也可以用请求头：

```text
Authorization: Bearer 你的CRON_SECRET
```

自动执行时间由 `vercel.json` 配置：

```text
0 20 * * 0
```

Vercel Cron 使用 UTC 时间。这个配置表示每周日 UTC 20:00 执行，大约是匈牙利周日晚上。

## 5. 部署后访问

部署成功后，Vercel 会生成一个网址，例如：

```text
https://your-project.vercel.app
```

电脑浏览器直接打开这个网址即可使用。

iPhone Safari：

1. 打开部署后的网址
2. 点击分享按钮
3. 选择添加到主屏幕
4. 以后从桌面图标打开

安卓 Chrome：

1. 打开部署后的网址
2. 点击浏览器菜单
3. 选择添加到主屏幕或安装应用
4. 以后从桌面图标打开

## 6. Supabase 登录跳转设置

如果以后增加注册、邮件确认或找回密码，需要在 Supabase Authentication / URL Configuration 里加入线上地址：

```text
https://your-project.vercel.app
```

当前第一版只使用后台创建账号 + 密码登录，不依赖邮件跳转。
