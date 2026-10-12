# Office Game · Team Communication and Strategy

[中文](README.md) | [English](README.en.md)

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
