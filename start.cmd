@echo off
cd /d "%~dp0"
set NODE_EXE=C:\Program Files\nodejs\node.exe
if not exist "%NODE_EXE%" set NODE_EXE=C:\Users\Mayn\.workbuddy\binaries\node\versions\22.22.2-6\node.exe
if not defined PORT set PORT=7777
echo.
echo  = 团队沟通 · 项目协作空间 =
echo  本机访问: http://localhost:%PORT%
echo  局域网地址见下方输出，同事用浏览器打开即可加入
echo.
echo  可选环境变量:
echo    PORT=7777            服务端口
echo    REVIEW_MS=4500       评审会停留时长（毫秒）
echo    VOTE_MS=9000         周报互评投票时长（毫秒）
echo    LLM_API_KEY=sk-xxx   自由对话模式接大模型（不设则用本地语义解析）
echo    LLM_BASE_URL=...     OpenAI 兼容接口地址（默认 https://api.openai.com/v1）
echo    LLM_MODEL=gpt-4o-mini 模型名
echo.
"%NODE_EXE%" server.js
pause
