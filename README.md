# 工作组游戏 · 团队沟通与办公室策略对战 / Office Game · Team Communication and Strategy

## 中文介绍

以项目协作空间为界面的办公室策略游戏。玩家以不同职位和出身加入团队，在需求、资源与评审回合中互动；支持多人参与与单人演练。

## English Introduction

An office-themed strategy game presented as a project collaboration workspace. Players join with different roles and backgrounds, then interact through requirements, resources and review rounds. Supports multiplayer sessions and solo practice. The application UI is currently Chinese.

## 使用说明 / User Guides

- [中文说明](README.zh-CN.md)
- [English guide](README.en.md)

下方提供完整的中文和英文说明与实际界面截图。 / Full guides and actual screenshots follow.

---

# 中文说明

## 功能

- 协作群与主持人配置：行业、目标、职位分配等房间参数。
- 角色、技能与资源系统，以及回合推进和胜负判断。
- 即时对话、迭代看板、季度会议、评审和互评。
- 单人演练与中途加入的观察机制。
- 自由对话的本地语义解析；可选大模型解析，失败时回退本地规则。
- 成员退出与失联清理。

## 快速开始

准备 Node.js 18 或更新版本，以支持可选 AI 使用的内置 fetch。服务使用 Node 内置模块，无需 npm install。

```sh
git clone https://github.com/Crazy4Lamb/office-game.git
cd office-game
node server.js
```

打开 http://localhost:7777。其他玩家通过同一服务加入；局域网访问使用服务电脑的 IP，例如 http://192.168.1.10:7777（替换成实际地址，并允许所需端口通过防火墙）。

Windows 也可双击 start.cmd；若脚本内的 Node 路径不适用，请调整或直接运行 node server.js。

## 游戏流程

1. 输入昵称，进入协作空间。
2. 主持人配置房间，玩家选择或获得职位。
3. 主持人立项，玩家通过技能、对话与看板参与当前回合。
4. 经评审与互评推进游戏，完成目标或触发结算；结束后可重新筹备。

单人也可进入演练模式。房间状态保存在服务进程内存中，服务重启后不会恢复原对局；当前实现围绕单个共享房间运行。

## 配置

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| PORT | 7777 | 服务端口 |
| REVIEW_MS | 4500 | 评审阶段时长（毫秒） |
| VOTE_MS | 9000 | 互评阶段时长（毫秒） |
| LIVE_MS | 40000 | 成员存活判定窗口（毫秒） |
| LLM_API_KEY | 未设置 | 配置后启用大模型语义解析 |
| LLM_BASE_URL | https://api.openai.com/v1 | OpenAI 兼容端点 |
| LLM_MODEL | gpt-4o-mini | 大模型名称 |

PowerShell 自定义端口示例：

```powershell
$env:PORT = "7778"
node server.js
```

大模型密钥只在服务器通过环境变量设置。自由对话解析会把相关内容发送给指定服务商；未配置、请求失败或超时时使用本地规则。

## 文件与开发

| 文件 | 职责 |
|---|---|
| server.js | HTTP 服务、共享房间、游戏引擎与状态同步 |
| game-data.js | 职位、行业、技能、目标等游戏数据 |
| semantic.js | 本地语义与可选 LLM 解析 |
| public/index.html | 网页界面与交互 |
| start.cmd | Windows 启动入口 |
| test.js、dom-check.js、ghost-check.js、repro.js | 开发检查与复现脚本 |

检查脚本可能依赖浏览器工具、特定端口或测试重置设置，运行前请阅读脚本。当前网页界面为中文；文档提供中英文版本。项目没有持久化数据库，GitHub 保存代码而不是运行中的对局。

## 图解玩法说明

![单人项目攻坚中的群聊与操作区](docs/images/game.png)

### 新手第一局：单人演练

1. 输入昵称并进入协作空间，第一位玩家成为主持人。
2. 将「本季度目标」设为「项目攻坚」，再将「赛制」设为「单人演练」。建议先使用「卡牌模式」与随机职位。
3. 点击「立项，开始本季度」。查看右侧需求池、自己的状态与当前轮次。
4. 在底部选择可用需求模板；需要目标的操作选择接收人，再点击「提交评审」。单人演练的需求目标按规则指向甲方。
5. 阅读站会、评审和互评日志，按剩余带宽与需求池调整策略；单人目标是连续通过三个项目关。

### 多人如何开始

同事通过主持人电脑的局域网地址加入同一服务。选择多人目标或团队攻坚，等待所需成员加入后立项。团队攻坚需要合作清空需求池，任一成员出局会导致团队失败；多人混战则按所选目标结算。

### 不同目标的胜负条件

| 目标 | 玩法与目标 |
|---|---|
| 末位优化 | 多人混战，最后存活的玩家晋升 |
| 绩效冲刺 | KPI 先到 100 晋升；带宽归零会出局 |
| OKR 对齐 | 认领目标 O，完成度先到 100% 获胜；同一 O 的人数影响推进 |
| 项目死线 | 10 轮交付窗口，到期按交付评级，并有阶段检查 |
| 项目攻坚 | 团队清空需求池，或单人连续通过三个项目关 |

### 读懂操作区

- **卡牌 / 关键词 / 自由对话**决定如何提出需求；初次体验推荐卡牌。
- **技能与职位**决定可用操作；看清效果与接收人后再提交。
- **摸鱼值**可累积并解锁「准点下班」，恢复、转嫁和防御操作需要结合局势使用。
- **群聊 / 看板 / 会议视图**是同一对局的不同展示，可在右上角切换；「手册」查看内置帮助，「导出周报」导出记录。

截图是使用演示昵称的单人模式。服务重启会清空内存对局。

---

# English Guide

## Features

- A shared collaboration group with host-configured industry, objectives and role assignment.
- Roles, skills, resources, round progression and outcome evaluation.
- Chat, iteration boards, quarterly meetings, reviews and peer voting.
- Solo practice and observation for players joining an active session.
- Local natural-language parsing with optional LLM parsing and fallback on failure.
- Member departure handling and disconnected-player cleanup.

## Getting started

Use Node.js 18 or newer for the built-in fetch used by optional AI integration. The service uses Node built-in modules and does not require npm install.

```sh
git clone https://github.com/Crazy4Lamb/office-game.git
cd office-game
node server.js
```

Open http://localhost:7777. Other players join the same service. For LAN play, use the host computer's actual address, such as http://192.168.1.10:7777, and allow the needed port through its firewall.

On Windows, start.cmd is also available. Adjust its Node executable paths if they do not match your machine, or run node server.js directly.

## Playing

1. Enter a nickname and join the collaboration space.
2. The host configures the room; players choose or receive roles.
3. The host starts the project; players use skills, chat and boards during each round.
4. Reviews and peer voting advance the game until an objective or end condition is reached; a new session can then be prepared.

Solo practice is supported. Room state lives in process memory and is lost when the server restarts. The current implementation runs a single shared room.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| PORT | 7777 | HTTP port |
| REVIEW_MS | 4500 | Review phase duration in milliseconds |
| VOTE_MS | 9000 | Peer-voting duration in milliseconds |
| LIVE_MS | 40000 | Member liveness window in milliseconds |
| LLM_API_KEY | Unset | Enables optional LLM parsing when configured |
| LLM_BASE_URL | https://api.openai.com/v1 | OpenAI-compatible API endpoint |
| LLM_MODEL | gpt-4o-mini | Model name |

PowerShell example for another port:

```powershell
$env:PORT = "7778"
node server.js
```

Set the LLM key through server environment variables. LLM parsing sends relevant conversation content to the selected provider. Missing credentials, failures or timeouts use local rules instead.

## Files and development

| File | Responsibility |
|---|---|
| server.js | HTTP service, shared room, game engine and state synchronization |
| game-data.js | Roles, industries, skills and objectives |
| semantic.js | Local semantic parsing and optional LLM parsing |
| public/index.html | Browser UI and interactions |
| start.cmd | Windows launcher |
| test.js, dom-check.js, ghost-check.js, repro.js | Development checks and reproduction scripts |

Check scripts may require browser tooling, specific ports or test-reset settings; read them before running. Documentation is bilingual while the application UI is Chinese. There is no persistent database: GitHub stores the code, not active game sessions.

## Illustrated Gameplay Guide

![Solo project challenge: chat, status and action area](docs/images/game.png)

### Your first session: solo practice

1. Enter a nickname and join. The first participant becomes the host.
2. Select Project Challenge (项目攻坚), then Solo Practice (单人演练). Start with Card Mode (卡牌模式) and random roles.
3. Click 立项，开始本季度. Read the demand pool, your status and round counter.
4. Choose an available action card at the bottom. Select a recipient when required, then click 提交评审. Solo demand targets follow the client-targeting rules.
5. Read stand-up, review and voting logs; balance remaining bandwidth against the demand pool. Solo play requires clearing three consecutive project stages.

### Multiplayer setup

Coworkers join the same server using the host computer's LAN address. Choose a multiplayer objective or cooperative challenge, wait for the required participants and start. Cooperative play clears the demand pool together; any eliminated teammate causes a team failure. Competitive play uses the selected objective's outcome rules.

### Objectives

| Objective | Winning condition |
|---|---|
| Last-person-standing / 末位优化 | The final surviving player is promoted |
| KPI Sprint / 绩效冲刺 | Reach 100 KPI first; zero bandwidth eliminates a player |
| OKR Alignment / OKR 对齐 | Reach 100% objective completion first; shared objectives affect progress |
| Project Deadline / 项目死线 | A ten-round delivery window with periodic checks and final delivery ratings |
| Project Challenge / 项目攻坚 | Clear the pool cooperatively, or pass three solo project stages |

### Reading the controls

- Card, Keyword and Free Conversation modes determine how actions are entered; cards are easiest to learn.
- Roles determine available skills. Read effects and target requirements before submission.
- Accumulate slack points (摸鱼值) to unlock 准点下班; recovery, redirection and defense depend on the current situation.
- Chat, Board and Meeting views show the same session. Use the top-right selector; 手册 opens built-in help and 导出周报 exports the log.

The screenshot uses a demo nickname in solo mode. Restarting the server clears its in-memory session.
