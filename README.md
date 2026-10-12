# 工作组游戏

团队沟通与办公室策略对战游戏，使用 Node.js 内置模块提供网页及游戏服务。

## 启动

安装 Node.js 后，在项目目录运行：

```sh
node server.js
```

浏览器访问 http://localhost:7777。同一局域网的其他玩家可通过服务所在电脑的局域网 IP 和端口加入。
Windows 也可使用 start.cmd；其中 Node.js 路径可能需要按电脑环境调整。

## 可选配置

- PORT：监听端口，默认 7777。
- REVIEW_MS：评审停留时长，默认 4500 毫秒。
- VOTE_MS：互评投票时长，默认 9000 毫秒。
- LLM_API_KEY、LLM_BASE_URL、LLM_MODEL：可选的大模型接口配置；未配置时使用本地语义解析。

密钥通过环境变量设置，请勿写入源码或提交到 Git。

## 主要文件

- server.js：服务器与游戏引擎。
- game-data.js：游戏数据。
- semantic.js：语义处理。
- public/index.html：网页界面。

修改后执行 git add .、git commit -m "说明本次修改"、git push。
