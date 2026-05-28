# 个人管理网站上线与云同步步骤

## 1. 在 Supabase 创建数据表

1. 打开 Supabase 项目后台。
2. 进入 `SQL Editor`。
3. 新建一个 query。
4. 复制 `supabase-schema.sql` 的全部内容进去。
5. 点击 `Run` 执行。

执行完成后会创建：

- `profiles`：账号信息。
- `app_items`：TODO、目标、素材、脑暴、文档、标签记忆等业务数据。
- `personal-assets`：视频、截图、附件等文件存储桶。

## 2. 本项目已填写 Supabase 配置

配置文件是：

```text
supabase-config.js
```

当前已经填入你的：

- Supabase Project URL
- anon public key

注意：不要把 `service_role key` 放进前端项目。

## 3. 本地测试

在当前文件夹运行：

```powershell
.\start-server.ps1
```

然后打开：

```text
http://localhost:5173
```

页面顶部会出现登录/注册区域。

## 4. 第一次迁移本地数据

1. 先在页面顶部注册账号。
2. 如果 Supabase 要求邮箱验证，先去邮箱完成验证，再登录。
3. 登录后点击：

```text
迁移本地数据到云端
```

这会把当前浏览器里的本地数据覆盖到你的 Supabase 账号里。

## 5. 上传到 GitHub Pages

把当前项目文件夹里的这些文件上传到 GitHub 仓库根目录：

- `index.html`
- `styles.css`
- `app.js`
- `supabase-config.js`
- `supabase-schema.sql`
- `LOCAL_README.md`
- `DEPLOYMENT.md`

可以不上传：

- `personal-manager-local.zip`

## 6. GitHub Pages 设置

进入 GitHub 仓库：

```text
Settings -> Pages
```

选择：

- Source：`Deploy from a branch`
- Branch：`main`
- Folder：`/root`

保存后等待 1-2 分钟，GitHub 会生成线上网址。

## 7. 后续更新功能

每次代码更新后，把改过的文件重新上传 GitHub 并提交即可。

通常需要更新：

- `index.html`
- `styles.css`
- `app.js`
- `supabase-config.js`

如果数据库结构也改了，再去 Supabase 的 SQL Editor 执行新版 `supabase-schema.sql`。
