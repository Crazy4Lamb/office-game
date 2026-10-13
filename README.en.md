# Office Game · Team Communication and Strategy

[项目首页 / Overview](README.md) | [中文说明](README.zh-CN.md) | [English guide](README.en.md)

An office-themed strategy game presented as a project collaboration workspace. Players join with different roles and backgrounds, then interact through requirements, resources and review rounds. Supports multiplayer sessions and solo practice. The application UI is currently Chinese.

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

On Windows, double-click `start.cmd`. The launcher detects Node, avoids occupied legacy ports or reuses a current service, and opens the browser after readiness. Use the printed port and keep the server window open. Open pages through HTTP rather than directly as HTML files.

## Playing

1. Enter a nickname and join the collaboration space.
2. The host configures the room; players choose or receive roles.
3. The host starts the project; players use skills, chat and boards during each round.
4. Reviews and peer voting advance the game until an objective or end condition is reached; a new session can then be prepared.

Entering a nickname with an empty room code creates an independent room. Share its invitation URL or code to invite colleagues. Members, configuration, chat and gameplay are isolated between rooms. State lives in process memory and is lost when the server restarts.

## Mix and match

Choose a format and objective independently; all other settings have defaults. Formats include solo campaigns, free-for-all survival, 1v1, teams from 1v1 to 5v5 (default 3v3), and cooperative projects. Objectives include survival, KPI, OKR, a fixed deadline window, and clearing project requirements. Team KPI/OKR use cumulative progress; project competitions compare delivery contributions.

Solo campaigns have four difficulty levels, 1–10 stages and a selectable starting stage. KPI/OKR require 100 progress per stage; deadline stages last 10 rounds and require 60 delivered. Choose cards, keywords, natural language or hybrid input. Natural language uses local parsing by default, with optional server-configured LLM support and local fallback.

Hosts can add virtual colleagues or fill empty seats. Bots act automatically. Teams disable friendly attacks by default and allow support for allies. Optional submission windows of 30, 60 or 120 seconds automatically defend missing submissions. Chat, enterprise workspace, board and meeting views keep a workplace appearance.

Run `node modes-check.js` and `node recovery-check.js` to test independent rooms, formats and recovery on isolated servers.

## Themes and LAN browsers

Choose System, Light, Dark or Eye Comfort on the login page or toolbar. The preference is remembered independently of chat, enterprise workspace, board and meeting views. Narrow screens have compact controls and stacked board/meeting sections.

Use **Invite colleagues** to choose the host computer's Wi-Fi/Ethernet address and copy the complete room URL. Colleagues open it on the same LAN from a phone or desktop browser. Invitation copying includes a fallback for LAN HTTP pages. Multiple tabs can share the same player's live connection; reconnection status is visible and typing is preserved during state updates.

If another device cannot connect, run `./enable-lan.ps1 -Port 7778` from an administrator PowerShell in the project directory, replacing the port with the actual one. The optional rule allows only the current Node program, chosen TCP port, LAN adapter and local subnet on Private/Public profiles. `-Disable` disables the rule created by this project. Administrator permission is required to modify Windows Firewall.

`GET /api/network` reports the actual port, bind address and LAN adapters. `HOST` defaults to `0.0.0.0`; use `127.0.0.1` to restrict access to this computer. LAN sharing does not publish the app to the public Internet.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| PORT | 7777 | HTTP port |
| HOST | 0.0.0.0 | Bind address; 127.0.0.1 restricts access to this computer |
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

Chat actions show the sender's avatar, name, role, recipient and original wording. Blocks, reflections, redirects and passive responses use the responding member's avatar and reference the original request. The right panel contains the roster and technical processing records, with current-round/all-record filtering. On phones, **Members / Records** opens the side drawer.

Actions remain visible after the round changes or the quarter ends. Reading earlier messages does not force the chat to scroll to the newest one. `node conversation-check.js` tests sender identity, response attribution and history on an isolated server.

- Card, Keyword and Free Conversation modes determine how actions are entered; cards are easiest to learn.
- Roles determine available skills. Read effects and target requirements before submission.
- Accumulate slack points (摸鱼值) to unlock 准点下班; recovery, redirection and defense depend on the current situation.
- Chat, Board and Meeting views show the same session. Use the top-right selector; 手册 opens built-in help and 导出周报 exports the log.

The screenshot uses a demo nickname in solo mode. Restarting the server clears its in-memory session.

## Following actions, responses and processing records

1. Read the avatar and display name to identify who initiated a request, then check its recipient and original wording.
2. For blocks, reflections, redirects or passive reactions, inspect the responding member and quoted request to distinguish initiator from responder.
3. Use Processing Records on the right for numerical changes, events and settlement details. Switch between current round and all records; on mobile, open Members / Records.
4. Reading older messages does not force a jump to the latest message. History survives round changes and quarter settlement until the host starts a new quarter.

Chat preserves character interactions; processing records explain game mechanics. Both remain in server memory rather than a persistent archive.
