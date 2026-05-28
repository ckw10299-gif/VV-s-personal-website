# 个人管理网站本地版使用说明

这是一个本地运行的个人管理网站，不需要注册账号，不需要数据库，也不需要联网部署。

## Windows 使用方式

1. 解压压缩包。
2. 双击或右键运行 `start-server.ps1`。
3. 浏览器打开：

```text
http://localhost:5173
```

## 数据保存在哪里

- TODO、脑暴、文档信息保存在当前浏览器的 localStorage。
- 视频、封面、截图、附件保存在当前浏览器的 IndexedDB。
- 换电脑、换浏览器、清除浏览器数据后，原数据不会自动同步。

## 常见问题

如果 PowerShell 不允许运行脚本，可以在解压目录打开 PowerShell，执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\start-server.ps1
```

如果 `5173` 端口被占用，可以编辑 `start-server.ps1`，把 `$Port = 5173` 改成其他端口，比如 `5180`，再访问：

```text
http://localhost:5180
```
