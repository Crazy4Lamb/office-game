'use strict';
/**
 * server.js —— 办公室黑话策略对战 · 引擎
 * 三层结构：引擎（本文件） + 数据（game-data.js） + 语义（semantic.js） + 皮肤（public/index.html）
 * 零外部依赖，纯 Node 内置模块。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const D = require('./game-data');
const SEM = require('./semantic');

const PORT = Number(process.env.PORT) || 7777;
const REVIEW_MS = Number(process.env.REVIEW_MS) || 4500;
const VOTE_MS = Number(process.env.VOTE_MS) || 9000;
const START_BW = 100;
const MAX_SLACK = 3;
const BOSS = 'boss';
/** 可以直接作用在需求池 / 甲方身上的技能类型 */
const BOSS_OK_KINDS = ['attack', 'drain', 'dot', 'disable', 'reveal'];

/* ---------------------------------------------------------------- 技能注册 */
const ALL_SKILLS = [].concat(D.BASE_SKILLS, D.ROLE_SKILLS, D.INDUSTRY_SKILLS, [D.ULT_SKILL]);
const SKILL_BY_KEY = {};
ALL_SKILLS.forEach(s => { SKILL_BY_KEY[s.key] = s; });
const ROLE_BY_KEY = {}; D.ROLES.forEach(r => { ROLE_BY_KEY[r.key] = r; });
const ORIGIN_BY_KEY = {}; D.ORIGINS.forEach(o => { ORIGIN_BY_KEY[o.key] = o; });
const GOAL_BY_KEY = {}; D.GOALS.forEach(g => { GOAL_BY_KEY[g.key] = g; });
const IND_BY_KEY = {}; D.INDUSTRIES.forEach(i => { IND_BY_KEY[i.key] = i; });
const OBJ_BY_KEY = {}; D.OKR_OBJECTIVES.forEach(o => { OBJ_BY_KEY[o.key] = o; });

/* ---------------------------------------------------------------- 房间状态 */
function defaultConfig(industry) {
  const ind = IND_BY_KEY[industry] || D.INDUSTRIES[0];
  return {
    group: ind.group,
    industry: ind.key,
    goal: 'battle',
    format: 'pvp',
    inputMode: 'card',
    roleAssign: 'random',
    originMode: 'random',
  };
}

const room = {
  config: defaultConfig('internet'),
  phase: 'lobby',
  round: 0,
  players: [],
  boss: null,
  log: [],
  event: null,
  eventExtra: null,
  revealed: [],
  winner: null,
  winnerReason: '',
  reviewTimer: null,
  voteTimer: null,
  votes: {},
  globalShieldPct: 0,
  revealFeed: [],
  started: false,
};

/* ---------------------------------------------------------------- 工具 */
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function byId(id) { return room.players.find(p => p.id === id) || null; }
function actives() { return room.players.filter(p => !p.spect && p.alive); }
function seated() { return room.players.filter(p => !p.spect); }
function uid() { return crypto.randomBytes(6).toString('hex'); }
function cfg() { return room.config; }
function goal() { return GOAL_BY_KEY[room.config.goal] || D.GOALS[0]; }
function ind() { return IND_BY_KEY[room.config.industry] || D.INDUSTRIES[0]; }
function isSolo() { return room.config.format === 'solo'; }
function isCoop() { return room.config.format === 'coop'; }
function hasBoss() { return goal().kind === 'boss'; }
/** 单人演练需要更长的回合窗口才能连过三关 */
function roundsMax() { const g = goal(); return (isSolo() && g.roundsSolo) ? g.roundsSolo : g.rounds; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function pushLog(kind, text, name) {
  room.log.push({ ts: Date.now(), kind, text, name: name || '' });
  if (room.log.length > 400) room.log.splice(0, room.log.length - 400);
}

/* ---------------------------------------------------------------- 角色 / 出身 */
function usedRoles() { return room.players.map(p => p.role).filter(Boolean); }
function assignRole(p) {
  if (cfg().roleAssign === 'pick') return;
  const taken = usedRoles();
  const free = D.ROLES.filter(r => !taken.includes(r.key));
  const r = free.length ? pick(free) : pick(D.ROLES);
  p.role = r.key;
}
function assignOrigin(p) {
  if (cfg().originMode === 'off') { p.origin = null; return; }
  p.origin = pick(D.ORIGINS).key;
}

function roleOf(p) { return p.role ? ROLE_BY_KEY[p.role] : null; }
function originOf(p) { return (p.origin && p.origin !== 'off') ? ORIGIN_BY_KEY[p.origin] : null; }

/** 汇总某个玩家当前生效的所有被动修正 */
function mods(p) {
  const o = originOf(p) || {};
  const r = roleOf(p) || {};
  const rp = r.passive || {};
  return {
    dealMult: (o.dealMult || 1),
    takeMult: (o.takeMult || 1),
    healMult: (o.healMult || 1) * (rp.healMult || 1),
    attackMult: (rp.attackMult || 1),
    cdMod: (o.cdMod || 0) + (rp.cdMod || 0),
    firstHit: (o.firstHit != null ? o.firstHit : (rp.firstHit != null ? rp.firstHit : null)),
    reflect: (o.reflect || 0),
    dotMult: (rp.dotMult || 1),
    maxBw: START_BW + (o.initBw || 0) + (rp.maxBw || 0),
    bwDrain: (o.bwDrain || 0),
    roundHeal: (o.roundHeal || 0) + (rp.roundHeal || 0),
    chargeOnHit: (o.chargeOnHit || 0),
    kpiBonus: (rp.kpiBonus || 0),
    kpiOnHit: (rp.kpiOnHit || 0),
    pressure: (rp.pressure || 0),
    autoReveal: (rp.autoReveal || 0),
  };
}

/** 某玩家本轮可用的技能清单 */
function skillsFor(p) {
  const list = D.BASE_SKILLS.slice();
  const r = roleOf(p);
  if (r) r.skills.forEach(k => { const s = SKILL_BY_KEY[k]; if (s) list.push(s); });
  D.INDUSTRY_SKILLS.filter(s => s.owner === cfg().industry).forEach(s => list.push(s));
  return list;
}

function effCd(p, skill) {
  if (skill.ultimate) return 0;
  return Math.max(1, (skill.cd || 1) + mods(p).cdMod);
}

/* ---------------------------------------------------------------- 计分 */
function scoreOf(p) {
  const g = goal();
  if (g.key === 'kpi') return p.kpi;
  if (g.key === 'okr') return Math.round(p.oProg);
  if (g.key === 'deadline') return Math.round(p.delivered);
  return 0;
}
function scoreLabel() {
  const g = goal();
  if (g.key === 'kpi') return 'KPI';
  if (g.key === 'okr') return 'O 完成度';
  if (g.key === 'deadline') return '交付量';
  return '';
}
function gainScore(p, n, reason) {
  const g = goal();
  if (g.key === 'kpi') { p.kpi = Math.max(0, p.kpi + n); }
  else if (g.key === 'okr') { p.oProg = Math.max(0, p.oProg + n); }
  else if (g.key === 'deadline') { p.delivered = Math.max(0, p.delivered + n); }
  else { p.bw = Math.min(mods(p).maxBw, p.bw + n); }
  if (reason) pushLog('sys', `@${p.name} ${reason}`);
}

/* ---------------------------------------------------------------- 视图层 */
function tierOf(p) {
  if (p.spect) return 'spect';
  if (!p.alive) return 'out';
  const load = 100 * (1 - p.bw / mods(p).maxBw);
  if (load >= 75) return 'danger';
  if (load >= 50) return 'warn';
  return 'ok';
}
const TIER_TEXT = { ok: '带宽充裕', warn: '高负荷', danger: '濒临满负荷', out: '已优化', spect: '观察期' };

function lanUrls() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name in ifs) for (const i of ifs[name]) if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${PORT}`);
  const rank = u => u.includes('192.168.') ? 0 : (u.includes('//10.') ? 1 : (u.includes('172.') ? 2 : 3));
  return out.sort((a, b) => rank(a) - rank(b));
}

function skillMeta(s) {
  return { key: s.key, label: s.label, tag: s.tag, quote: s.quote, effect: s.effect, kind: s.kind, cd: s.cd || 0, needTarget: !!s.needTarget, owner: s.owner || '', ultimate: !!s.ultimate, bossOk: BOSS_OK_KINDS.indexOf(s.kind) >= 0 };
}

function okrInfo() {
  if (goal().key !== 'okr') return null;
  const counts = {};
  actives().forEach(p => { counts[p.oKey] = (counts[p.oKey] || 0) + 1; });
  return {
    objectives: D.OKR_OBJECTIVES.map(o => ({ key: o.key, label: o.label, short: o.short, count: counts[o.key] || 0 })),
    counts,
  };
}

function viewFor(viewer) {
  const g = goal(), i = ind();
  const mySkills = viewer && !viewer.spect ? skillsFor(viewer) : [];
  return {
    phase: room.phase,
    round: room.round,
    started: room.started,
    config: Object.assign({}, room.config, { group: room.config.group }),
    industry: { key: i.key, label: i.label, icon: i.icon, color: i.color, group: i.group, target: i.target, boss: i.boss },
    goal: { key: g.key, label: g.label, icon: g.icon, kind: g.kind, rounds: roundsMax(), desc: g.desc, target: g.target || 0, win: g.win },
    scoreLabel: scoreLabel(),
    meta: {
      roles: D.ROLES.map(r => ({ key: r.key, label: r.label, icon: r.icon, color: r.color, blurb: r.blurb, passive: r.passive.text, skills: r.skills.map(k => SKILL_BY_KEY[k] ? SKILL_BY_KEY[k].label : k) })),
      origins: D.ORIGINS.map(o => ({ key: o.key, label: o.label, icon: o.icon, desc: o.desc })),
      goals: D.GOALS.map(x => ({ key: x.key, label: x.label, icon: x.icon, kind: x.kind, rounds: x.rounds, desc: x.desc })),
      industries: D.INDUSTRIES.map(x => ({ key: x.key, label: x.label, icon: x.icon, group: x.group, target: x.target })),
      inputModes: D.INPUT_MODES,
      roleAssign: D.ROLE_ASSIGN,
      originModes: D.ORIGIN_MODES,
      chatPresets: D.CHAT_PRESETS,
      allSkills: ALL_SKILLS.map(skillMeta),
      mySkills: mySkills.map(skillMeta),
      maxSlack: MAX_SLACK,
      llm: !!process.env.LLM_API_KEY,
    },
    event: room.event ? { text: room.event.text, effect: room.event.effect, extra: room.eventExtra } : null,
    boss: room.boss ? {
      hp: Math.round(room.boss.hp), maxHp: room.boss.maxHp, level: room.boss.level,
      label: i.target,
      telegraph: room.boss.telegraph ? { name: (byId(room.boss.telegraph.targetId) || {}).name || '—' } : null,
    } : null,
    players: room.players.map(p => ({
      id: p.id, name: p.name, isHost: p.isHost, spect: p.spect, alive: p.alive,
      role: p.role, roleLabel: p.role ? (ROLE_BY_KEY[p.role] || {}).label : '', roleIcon: p.role ? (ROLE_BY_KEY[p.role] || {}).icon : '',
      origin: p.origin, originLabel: p.origin ? (ORIGIN_BY_KEY[p.origin] || {}).label : '', originIcon: p.origin ? (ORIGIN_BY_KEY[p.origin] || {}).icon : '',
      tier: tierOf(p), tierText: TIER_TEXT[tierOf(p)],
      score: scoreOf(p), scoreLabel: scoreLabel(),
      submitted: !!p.submitted,
      isYou: !!viewer && p.id === viewer.id,
      dots: p.dots.length,
      slack: p.slack,
      oKey: p.oKey,
    })),
    me: viewer ? {
      id: viewer.id, name: viewer.name, isHost: viewer.isHost, spect: viewer.spect, alive: viewer.alive,
      role: viewer.role, origin: viewer.origin, originOn: cfg().originMode !== 'off',
      roleLabel: viewer.role ? (ROLE_BY_KEY[viewer.role] || {}).label : '',
      roleIcon: viewer.role ? (ROLE_BY_KEY[viewer.role] || {}).icon : '',
      roleSkills: viewer.role ? ((ROLE_BY_KEY[viewer.role] || {}).skills || []).map(k => SKILL_BY_KEY[k] ? SKILL_BY_KEY[k].label : k) : [],
      originLabel: viewer.origin ? (ORIGIN_BY_KEY[viewer.origin] || {}).label : '',
      originIcon: viewer.origin ? (ORIGIN_BY_KEY[viewer.origin] || {}).icon : '',
      originDesc: viewer.origin ? (ORIGIN_BY_KEY[viewer.origin] || {}).desc : '',
      bw: Math.round(viewer.bw), maxBw: mods(viewer).maxBw,
      score: scoreOf(viewer), scoreLabel: scoreLabel(),
      kpi: viewer.kpi, oProg: Math.round(viewer.oProg), oKey: viewer.oKey, delivered: Math.round(viewer.delivered),
      passiveText: (roleOf(viewer) || {}).passive ? roleOf(viewer).passive.text : '',
      cds: Object.assign({}, viewer.cds),
      submitted: viewer.submitted ? { skill: viewer.submitted.skill, target: viewer.submitted.target, source: viewer.submitted.source, raw: viewer.submitted.raw } : null,
      dots: viewer.dots.map(d => ({ dmg: d.dmg, dur: d.dur, label: d.label })),
      slack: viewer.slack, maxSlack: MAX_SLACK, ultReady: viewer.slack >= MAX_SLACK,
      tools: mySkills.map(skillMeta),
      okrPeers: goal().key === 'okr' ? actives().filter(x => x.oKey === viewer.oKey).map(x => x.name) : [],
    } : null,
    votes: room.phase === 'vote' ? {
      mine: room.votes[viewer ? viewer.id : ''] || null,
      count: Object.keys(room.votes).length,
      total: actives().length,
      tally: tallyVotes().map(t => ({ name: t.name, n: t.n })),
    } : null,
    revealed: room.revealed,
    log: room.log.slice(-140),
    urls: lanUrls(),
    winner: room.winner ? { name: room.winner.name, team: !!room.winner.team, reason: room.winnerReason } : null,
    reason: room.phase === 'over' ? room.winnerReason : '',
    okr: okrInfo(),
    ready: { alive: actives().length, submitted: actives().filter(p => p.submitted).length, total: seated().length, voted: Object.keys(room.votes).length },
  };
}

const clients = new Map();

/* ---------------- 在线判定与群主交接 ----------------
 * 幽灵成员（页面关掉但还留在房间里的人）会霸占群主身份，导致后来的人永远开不了局。
 * 这里以「SSE 长连接在」或「最近有过请求」作为在线依据，定期清理并在群主离席时自动交接。 */
const LIVE_MS = Number(process.env.LIVE_MS || 40000);
function isLive(p) { return !!p && (clients.has(p.id) || (Date.now() - (p.lastSeen || 0) < LIVE_MS)); }
function touch(p) { if (p) p.lastSeen = Date.now(); }
function ensureHost() {
  if (!room.players.length) return false;
  const host = room.players.filter(p => p.isHost)[0];
  if (host && isLive(host)) return false;
  // 没人在线时先不交接，等下一个进来的人自然成为群主
  const cand = room.players.filter(p => isLive(p))[0];
  if (!cand || cand === host) return false;
  room.players.forEach(p => { p.isHost = (p === cand); });
  pushLog('sys', host ? `群主 @${host.name} 已离开，群主身份移交给 @${cand.name}` : `@${cand.name} 成为群主`);
  return true;
}
function reapGhosts() {
  if (room.phase !== 'lobby') { if (ensureHost()) broadcast(); return; }
  const gone = room.players.filter(p => !isLive(p));
  if (gone.length) {
    room.players = room.players.filter(p => !gone.includes(p));
    gone.forEach(p => { clients.delete(p.id); delete room.votes[p.id]; });
    pushLog('sys', `清理 ${gone.length} 位已离开的成员：${gone.map(p => p.name).join('、')}`);
    if (!room.players.length) { resetToLobby(); return; }
  }
  ensureHost();
  if (gone.length) broadcast();
}
setInterval(reapGhosts, 3000);

function broadcast() {
  clients.forEach((res, pid) => {
    const viewer = byId(pid);
    try { res.write(`data: ${JSON.stringify(viewFor(viewer))}\n\n`); } catch (e) { clients.delete(pid); }
  });
}

/* ---------------------------------------------------------------- 事件卡 */
function applyEventExpr(expr) {
  const parts = String(expr).split(';').map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    const [rawKey, rawVal] = part.split(':');
    const v = Number(rawVal);
    const list = actives();
    if (!list.length) continue;
    switch (rawKey) {
      case 'allBw': list.forEach(p => { p.bw -= v; }); break;
      case 'allHeal': list.forEach(p => { p.bw = Math.min(mods(p).maxBw, p.bw + v); }); break;
      case 'allKpi': if (goal().key !== 'battle') list.forEach(p => gainScore(p, v)); break;
      case 'allCharge': list.forEach(p => { p.slack = Math.min(MAX_SLACK, p.slack + v); }); break;
      case 'topBw': {
        const t = list.slice().sort((a, b) => a.bw - b.bw)[0];
        if (t) { t.bw -= v; room.eventExtra = t.name; }
        break;
      }
      case 'topCost': {
        const t = list.slice().sort((a, b) => a.bw - b.bw)[0];
        if (t) { t.bw -= Math.abs(v); room.eventExtra = t.name; }
        break;
      }
      case 'lowBw': {
        const t = list.slice().sort((a, b) => b.bw - a.bw)[0];
        if (t) { t.bw -= Math.abs(v); room.eventExtra = t.name; }
        break;
      }
      case 'randHeal': { const t = pick(list); t.bw = Math.min(mods(t).maxBw, t.bw + v); room.eventExtra = t.name; break; }
      case 'bossHp': if (room.boss) { room.boss.hp = Math.max(0, room.boss.hp + v); room.boss.maxHp = Math.max(room.boss.maxHp, room.boss.hp); } break;
      case 'bossAtk': if (room.boss) room.boss.atkBase += v; break;
      default: break;
    }
  }
}

function drawEvent() {
  if (isSolo()) return pick(D.SOLO_EVENTS);
  const pool = hasBoss() ? D.BOSS_EVENTS : ind().events.concat(D.COMMON_EVENTS);
  return pick(pool);
}

/* ---------------------------------------------------------------- 死亡与胜负 */
function endGame(winner, reason) {
  room.phase = 'over';
  room.winner = winner;
  room.winnerReason = reason;
  if (room.boss) room.boss.telegraph = null;
  clearTimeout(room.reviewTimer); room.reviewTimer = null;
  clearTimeout(room.voteTimer); room.voteTimer = null;
  pushLog('sys', `【季度总结】${reason}`);
  broadcast();
}

function maybeEndAfterDeaths() {
  const g = goal();
  const list = actives();
  if (isCoop()) { endGame(null, '团队中有人被优化，攻坚失败'); return true; }
  if (isSolo()) { if (!list.length) { endGame(null, '演练失败：带宽耗尽被优化'); return true; } return false; }
  if (list.length === 1) { endGame(list[0], '最后存活，晋升答辩通过'); return true; }
  if (list.length === 0) { endGame(null, '全员被优化，本季度无人通过'); return true; }
  return false;
}

function checkDeaths() {
  let changed = false;
  room.players.forEach(p => {
    if (!p.spect && p.alive && p.bw <= 0) {
      p.alive = false; p.bw = 0; changed = true;
      pushLog('sys', `@${p.name} 排期占用 100%，已被优化，转入观察期`);
    }
  });
  if (changed) return maybeEndAfterDeaths();
  return room.phase === 'over';
}

/* ---------------------------------------------------------------- 回合流程 */
function startGame() {
  const c = cfg();
  if (!GOAL_BY_KEY[c.goal]) return '未知目标';
  if (goal().kind === 'boss' && c.format === 'pvp') return '攻坚类目标需要选择团队或单人赛制';
  if (goal().kind !== 'boss' && c.format !== 'pvp') return '该目标只支持多人混战赛制';
  // 角色去重（随机分配时可能撞车）
  if (c.roleAssign === 'random') {
    const seen = {};
    room.players.forEach(p => {
      if (!p.role || seen[p.role]) { const free = D.ROLES.filter(r => !seen[r.key]); p.role = (free.length ? pick(free) : pick(D.ROLES)).key; }
      seen[p.role] = 1;
    });
  }
  const missing = room.players.filter(p => !p.spect && !p.role);
  if (missing.length) return `还有成员没有认领职位：${missing.map(p => p.name).join('、')}`;

  room.round = 0; room.winner = null; room.winnerReason = ''; room.revealed = []; room.log = [];
  room.event = null; room.eventExtra = null; room.phase = 'lobby'; room.votes = {};
  room.globalShieldPct = 0; room.revealFeed = [];
  clearTimeout(room.reviewTimer); clearTimeout(room.voteTimer);
  room.reviewTimer = null; room.voteTimer = null;

  const oKeys = shuffle(D.OKR_OBJECTIVES.map(o => o.key));
  room.players.forEach((p, idx) => {
    p.spect = isSolo() ? !p.isHost : false;
    const m = mods(p);
    p.maxBw = m.maxBw;
    p.alive = true; p.bw = m.maxBw; p.kpi = 0; p.oProg = 0; p.delivered = 0;
    p.oKey = goal().key === 'okr' ? oKeys[idx % oKeys.length] : null;
    p.slack = 0; p.cds = {}; p.dots = [];
    p.submitted = null; p.shield = false; p.reflect = false; p.redirectTo = null;
    p.fragile = 0; p.noHeal = 0; p.buffPct = 0; p.protect = [];
    p.disabled = false; p.usedFirstHit = false; p.ultShield = false;
    p.stats = { dealt: 0, taken: 0 };
  });
  room.boss = hasBoss() ? makeBoss(1, actives().length) : null;
  room.started = true;
  pushLog('sys', `【立项】${ind().label} · ${goal().label}（${goal().desc}）`);
  pushLog('sys', `赛制：${c.format === 'pvp' ? '多人混战' : (c.format === 'coop' ? '团队攻坚' : '单人演练')}｜出手方式：${(D.INPUT_MODES.find(x => x.key === c.inputMode) || {}).label}｜职位：${(D.ROLE_ASSIGN.find(x => x.key === c.roleAssign) || {}).label}`);
  const spects = room.players.filter(p => p.spect);
  if (spects.length) pushLog('sys', `演练模式开启，${spects.map(p => '@' + p.name).join('、')} 进入观察期`);
  startRound();
}

function makeBoss(level, count) {
  if (isCoop()) { const hp = 40 * count + 40; return { hp, maxHp: hp, level: 1, atkBase: 7, round: 0, dots: [], telegraph: null }; }
  // 单人演练：三关递进，压力来自轮次累积而非单点爆发
  const hp = 80 + 20 * (level - 1);
  return { hp, maxHp: hp, level, atkBase: 6 + 2 * (level - 1), round: 0, dots: [], telegraph: null };
}
function bossDmgFor(base) { return Math.round(base * (isSolo() ? (1 + 0.25 * (room.boss.level - 1)) : 1)); }
function quoteBoss(round) {
  const pool = D.BOSS_QUOTES[cfg().industry] || D.BOSS_QUOTES.internet;
  return pool[round % pool.length];
}

function startRound() {
  if (room.phase === 'over') return;
  room.round++;
  room.revealed = []; room.eventExtra = null; room.votes = {}; room.globalShieldPct = 0;
  const g = goal();

  room.players.forEach(p => {
    p.submitted = null; p.shield = false; p.reflect = false; p.redirectTo = null;
    for (const k in p.cds) if (p.cds[k] > 0) p.cds[k]--;
    if (p.spect || !p.alive) return;
    const m = mods(p);
    // 出身 / 职位 的每轮开场被动
    if (m.roundHeal) p.bw = Math.min(p.maxBw, p.bw + m.roundHeal);
    if (m.bwDrain) p.bw -= m.bwDrain;
    if (p.noHeal > 0) p.noHeal--;
    if (p.fragile > 0) p.fragile--;
  });

  // 站会事件
  const ev = drawEvent();
  room.event = ev; room.eventExtra = null;
  applyEventExpr(ev.apply);
  pushLog('sys', `【站会】第 ${room.round}/${roundsMax()} 轮 · ${ev.text}（${ev.effect}${room.eventExtra ? '：' + room.eventExtra : ''}）`);

  // 职位特殊开场：财务施压 / 测试摸底
  actives().forEach(p => {
    const m = mods(p);
    if (m.pressure) {
      const t = actives().filter(x => x.id !== p.id).sort((a, b) => a.bw - b.bw)[0];
      if (t) { t.bw -= m.pressure; pushLog('sys', `@${p.name}（财务）例行压降预算，@${t.name} 带宽 -${m.pressure}`); }
    }
    if (m.autoReveal) {
      const t = pick(actives().filter(x => x.id !== p.id));
      if (t) pushLog('sys', `@${p.name}（测试）例行摸底：@${t.name} 真实排期占用 ${Math.round(100 * (1 - t.bw / t.maxBw))}%`);
    }
  });

  // 甲方火力
  if (room.boss) {
    const list = actives();
    if (list.length) {
      room.boss.round++;
      const target = isSolo() ? list[0] : pick(list);
      const dmg = isSolo() ? (room.boss.atkBase + Math.ceil(room.boss.round / 3)) : (room.boss.atkBase + Math.floor(room.round / 2));
      room.boss.telegraph = { targetId: target.id, dmg };
      pushLog('sys', `【${ind().boss}】${quoteBoss(room.round)} → @${target.name}${isSolo() ? `（预判 -${dmg} 带宽）` : ''}`);
    } else room.boss.telegraph = null;
  }

  if (checkDeaths()) return;

  // 周报互评：每 3 轮一次，人多时开启
  if (g.kind === 'pvp' && room.round % 3 === 0 && actives().length >= 3) {
    room.phase = 'vote';
    pushLog('sys', '【周报互评】本轮开始前，全组匿名互评：谁最该被优化？');
    room.voteTimer = setTimeout(() => { if (room.phase === 'vote') resolveVote(); }, VOTE_MS);
    broadcast();
    return;
  }
  room.phase = 'select';
  broadcast();
}

/* ---------------------------------------------------------------- 周报互评 */
function tallyVotes() {
  const cnt = {};
  for (const voter in room.votes) { const t = room.votes[voter]; if (!t || t === 'abstain') continue; cnt[t] = (cnt[t] || 0) + 1; }
  return Object.keys(cnt).map(id => ({ id, name: (byId(id) || {}).name || '—', n: cnt[id] })).sort((a, b) => b.n - a.n);
}

function resolveVote() {
  if (room.phase !== 'vote') return;
  clearTimeout(room.voteTimer); room.voteTimer = null;
  const tally = tallyVotes();
  if (!tally.length) pushLog('sys', '本轮互评全员弃权，无人被点名');
  else {
    const top = tally[0];
    const t = byId(top.id);
    if (t && t.alive) {
      const dmg = 14 + (top.n - 1) * 4;
      t.bw -= dmg;
      pushLog('sys', `【互评结果】@${t.name} 得票最高（${top.n} 票），被纳入绩效观察名单，带宽 -${dmg}`);
      const rest = tally.slice(1).map(x => `${x.name} ${x.n} 票`).join('、');
      if (rest) pushLog('sys', `其余得票：${rest}`);
    }
  }
  if (checkDeaths()) return;
  room.phase = 'select';
  broadcast();
}

/* ---------------------------------------------------------------- 伤害管线 */
/**
 * 统一伤害入口。
 * kind: 'demand' 普通需求 / 'dot' 持续负担 / 'vote' 互评 / 'direct' 无视护盾
 */
function dealDamage(att, to, amount, label, kind) {
  kind = kind || 'demand';
  if (!to || !to.alive || to.spect) return { dealt: 0, text: '接收人已离场，需求落空' };

  // 防守姿态（互评与直接伤害不吃防御）
  if (kind === 'demand') {
    if (to.ultShield) return { dealt: 0, text: `@${to.name} 已准点下班，本轮不再接收任何需求` };
    if (room.globalShieldPct) amount = amount * (1 - room.globalShieldPct / 100);
    if (to.shield) {
      to.shield = false;
      if (att) pushLog('sys', `@${to.name} 把「${label}」排期后置，需求被推迟到下个迭代`);
      return { dealt: 0, text: '需求被排期后置，本轮失效' };
    }
    if (to.reflect) {
      to.reflect = false;
      if (att && att.alive !== undefined) { att.bw -= amount; pushLog('sys', `@${to.name} 驳回「${label}」，需求原路返回：@${att.name} 带宽 -${Math.round(amount)}`); }
      else if (room.boss) { room.boss.hp = Math.max(0, room.boss.hp - amount); pushLog('sys', `@${to.name} 驳回甲方的「${label}」，需求被打回：剩余需求 -${Math.round(amount)}`); }
      return { dealt: 0, text: `需求被驳回并原路返回（-${Math.round(amount)}）` };
    }
    if (to.redirectTo) {
      const f = byId(to.redirectTo);
      if (f && f.alive && f !== to) {
        f.bw -= amount;
        pushLog('sys', `@${to.name} 熟练甩锅，「${label}」转嫁给 @${f.name}：带宽 -${Math.round(amount)}`);
        return { dealt: amount, text: `被甩锅转给 @${f.name}（-${Math.round(amount)}）` };
      }
    }
  }

  const m = mods(to);
  let amt = amount;
  if (kind === 'demand') {
    amt *= m.takeMult;
    if (to.fragile > 0) amt *= 1.3;
    if (m.firstHit != null && !to.usedFirstHit) { amt *= m.firstHit; to.usedFirstHit = true; }
  } else if (kind === 'dot') {
    amt *= m.dotMult;
  }
  amt = Math.max(1, Math.round(amt));
  to.bw -= amt;
  to.stats.taken += amt;

  // 出身反伤 / 工具人摸鱼值
  if (att && att.alive !== undefined && m.reflect) {
    att.bw -= m.reflect;
    pushLog('sys', `@${to.name} 出身「${(ORIGIN_BY_KEY[to.origin] || {}).label || ''}」，反弹 ${m.reflect} 点给 @${att.name}`);
  }
  if (m.chargeOnHit) to.slack = Math.min(MAX_SLACK, to.slack + m.chargeOnHit);
  if (att) att.stats.dealt += amt;
  return { dealt: amt, text: '' };
}

function playerAttack(att, t, dmg, label) {
  if (!t) return { text: '接收人不可用', dealt: 0 };
  const m = mods(att);
  const v = Math.round(dmg * m.dealMult);
  const r = dealDamage(att, t, v, label, 'demand');
  if (r.dealt > 0 && !r.text) pushLog('sys', `@${att.name} 对 @${t.name} 使用「${label}」：带宽 -${Math.round(v)}`);
  if (r.dealt > 0) {
    const rp = mods(att);
    if (rp.kpiOnHit && goal().key !== 'battle') gainScore(att, rp.kpiOnHit);
  }
  return { text: r.text || `@${t.name} 带宽 -${Math.round(v)}`, dealt: r.dealt };
}

function bossDamage(att, dmg, label) {
  let v = Math.round(dmg * mods(att).dealMult * mods(att).attackMult);
  room.boss.hp = Math.max(0, room.boss.hp - v);
  pushLog('sys', `@${att.name} 用「${label}」推进项目：剩余需求 -${v}（还剩 ${Math.round(room.boss.hp)}）`);
  return { text: `项目推进 ${v}，剩余需求 ${Math.round(room.boss.hp)}`, dealt: v };
}

/* ---------------------------------------------------------------- 技能结算 */
function applySkill(entry) {
  const p = entry.p, s = entry.skill, targetId = entry.target;
  const bossAllowed = hasBoss() && (targetId === BOSS || (!s.needTarget && s.kind !== 'redirect'));
  const toBoss = hasBoss() && targetId === BOSS;
  const t = toBoss || targetId === 'all' || !targetId ? null : byId(targetId);
  const others = () => actives().filter(x => x.id !== p.id);

  switch (s.kind) {
    /* ---- 单点需求 ---- */
    case 'attack': {
      if (toBoss) return bossDamage(p, bossDmgFor(s.dmg), s.label).text;
      if (s.selfCost) p.bw -= s.selfCost;
      const r = playerAttack(p, t, s.dmg, s.label);
      if (s.fragile && t && t.alive) t.fragile = s.fragile;
      if (s.noHeal && t && t.alive) t.noHeal = s.noHeal;
      return r.text + (s.selfCost ? `（自己 -${s.selfCost}）` : '');
    }
    /* ---- 群体 ---- */
    case 'aoe': {
      if (toBoss) return bossDamage(p, bossDmgFor(s.dmg), s.label).text;
      if (s.selfCost) p.bw -= s.selfCost;
      const log = [];
      others().forEach(x => {
        const r = dealDamage(p, x, Math.round(s.dmg * mods(p).dealMult), s.label, 'demand');
        if (r.dealt > 0) log.push('@' + x.name + ' -' + Math.round(r.dealt));
      });
      if (s.selfHeal) p.bw = Math.min(p.maxBw, p.bw + Math.round(s.selfHeal * mods(p).healMult));
      pushLog('sys', `@${p.name} 使用「${s.label}」：${log.join('、') || '无人受影响'}${s.selfHeal ? `，自己 +${s.selfHeal}` : ''}${s.selfCost ? `，自己 -${s.selfCost}` : ''}`);
      if (s.aoe) { others().forEach(x => { x.bw -= s.aoe; }); pushLog('sys', `其余同事各 -${s.aoe}`); }
      return log.length ? log.join('、') : '暂无其他同事可影响';
    }
    /* ---- 持续负担 ---- */
    case 'dot': {
      if (toBoss) {
        const d = bossDmgFor(s.dmg);
        room.boss.dots.push({ dmg: d, dur: s.dur });
        pushLog('sys', `@${p.name} 派人支援项目：未来 ${s.dur} 轮各推进 ${d}`);
        return `支援成立：未来 ${s.dur} 轮各推进 ${d}`;
      }
      const m = mods(p);
      const dmg = Math.round(s.dmg * m.dealMult);
      if (!t || !t.alive) return '接收人已离场，需求落空';
      t.dots.push({ dmg, dur: s.dur, label: s.label, src: p.name });
      pushLog('sys', `@${p.name} 对 @${t.name} 使用「${s.label}」：未来 ${s.dur} 轮每轮 -${dmg}`);
      return `已挂上：@${t.name} 未来 ${s.dur} 轮每轮 -${dmg}`;
    }
    /* ---- 抢功 ---- */
    case 'drain': {
      if (toBoss) return bossDamage(p, bossDmgFor(s.dmg), s.label).text;
      const r = playerAttack(p, t, s.dmg, s.label);
      if (r.dealt > 0) {
        if (goal().key === 'battle') {
          p.bw = Math.min(p.maxBw, p.bw + s.dmg);
          pushLog('sys', `@${p.name} 抢功成功，自己带宽 +${s.dmg}`);
          return r.text + `，@${p.name} 带宽 +${s.dmg}`;
        }
        gainScore(p, Math.round(s.dmg * 0.8), `抢功成功，${scoreLabel()} +${Math.round(s.dmg * 0.8)}`);
        return r.text + `，@${p.name} ${scoreLabel()} +${Math.round(s.dmg * 0.8)}`;
      }
      return r.text;
    }
    /* ---- 防御 ---- */
    case 'shield': {
      p.shield = true;
      if (s.revealSelf) {
        const attackers = room.revealed.filter(x => x.target === '@' + p.name).map(x => x.from);
        const uniq = attackers.filter((v, i) => attackers.indexOf(v) === i);
        pushLog('sys', `@${p.name} 全量回归封板：本轮免疫第一次需求${uniq.length ? `（正在针对你：${uniq.join('、')}）` : ''}`);
        return '已封板：免疫本次需求' + (uniq.length ? `；正在针对你的是 ${uniq.join('、')}` : '');
      }
      return '已进入防御姿态：本轮第一张指向自己的需求将被推迟';
    }
    case 'reflect': return '已进入防御姿态：本轮第一张指向自己的需求将被驳回并原路返回';
    case 'fortify': { p.shield = true; p.reflect = true; return '已进入强化防御：本轮第一次需求将被驳回并原路返回'; }
    case 'redirect': {
      if (isSolo()) { p.shield = true; return '需求原样退回，本轮免除一次点名'; }
      p.redirectTo = (t && t.alive && t !== p) ? t.id : null;
      return p.redirectTo ? `甩锅姿态：本轮针对自己的需求将全部转嫁给 @${t.name}` : '接收人不可用，甩锅姿态未生效';
    }
    /* ---- 恢复 ---- */
    case 'heal': {
      const hm = mods(p).healMult;
      const hv = Math.round((isSolo() ? s.heal + 8 : s.heal) * hm);
      if (s.allCost) {
        p.bw = Math.min(p.maxBw, p.bw + hv);
        others().forEach(x => { x.bw -= s.allCost; });
        pushLog('sys', `@${p.name} 使用「${s.label}」：自己 +${hv}，其余同事各 -${s.allCost}`);
        return `自己 +${hv}，其余同事各 -${s.allCost}`;
      }
      if (s.healTarget && t) {
        t.bw = Math.min(t.maxBw, t.bw + hv);
        if (s.protect) t.protect.push(p.id);
        pushLog('sys', `@${p.name} 帮 @${t.name} 顶了一下：@${t.name} 带宽 +${hv}`);
        return `@${t.name} 带宽 +${hv}`;
      }
      p.bw = Math.min(p.maxBw, p.bw + hv);
      pushLog('sys', `@${p.name} 使用「${s.label}」：带宽 +${hv}`);
      return `带宽 +${hv}`;
    }
    case 'healAll': {
      const hm = mods(p).healMult;
      const base = Math.round(s.heal * hm);
      actives().forEach(x => { x.bw = Math.min(x.maxBw, x.bw + base); });
      if (s.selfHeal) p.bw = Math.min(p.maxBw, p.bw + s.selfHeal);
      pushLog('sys', `@${p.name} 使用「${s.label}」：全员 +${base}${s.selfHeal ? `，自己额外 +${s.selfHeal}` : ''}`);
      return `全员 +${base}${s.selfHeal ? `，自己额外 +${s.selfHeal}` : ''}`;
    }
    case 'cleanse': {
      p.dots = []; p.fragile = 0; p.noHeal = 0;
      if (s.aoe) { others().forEach(x => { x.bw -= s.aoe; }); }
      pushLog('sys', `@${p.name} 使用「${s.label}」：清除自身全部持续负担${s.aoe ? `，其余同事各 -${s.aoe}` : ''}`);
      return `已清除自身全部持续负担${s.aoe ? `，其余同事各 -${s.aoe}` : ''}`;
    }
    /* ---- 情报 ---- */
    case 'reveal': {
      if (toBoss && room.boss) {
        const next = room.boss.atkBase + (isSolo() ? Math.ceil(room.boss.round / 3) : Math.floor(room.round / 2));
        pushLog('sys', `@${p.name} 向上同步：${ind().boss}剩余需求 ${Math.round(room.boss.hp)}，下轮火力约 ${next}`);
        let extra = '';
        if (s.kpi && goal().key !== 'battle') { gainScore(p, s.kpi); extra = `，${scoreLabel()} +${s.kpi}`; }
        return `剩余需求 ${Math.round(room.boss.hp)}，下轮火力约 ${next}${extra}`;
      }
      if (!t || !t.alive) return '接收人已离场，信息已作废';
      const load = Math.round(100 * (1 - t.bw / t.maxBw));
      pushLog('sys', `@${p.name} 向上同步：@${t.name} 真实排期占用 ${load}%${t.dots.length ? `，另有 ${t.dots.length} 项持续负担` : ''}`);
      let extra = '';
      if (s.kpi && goal().key !== 'battle') { gainScore(p, s.kpi); extra = `，${scoreLabel()} +${s.kpi}`; }
      return `真实排期占用 ${load}%${t.dots.length ? `，另有 ${t.dots.length} 项持续负担` : ''}${extra}`;
    }
    case 'revealAll': {
      const list = actives().filter(x => x.id !== p.id).map(x => `${x.name} ${Math.round(100 * (1 - x.bw / x.maxBw))}%`).join('、');
      pushLog('sys', `@${p.name} 完成全量审计：${list || '暂无其他同事'}`);
      room.revealFeed = actives().map(x => ({ name: x.name, load: Math.round(100 * (1 - x.bw / x.maxBw)) }));
      return list ? '已掌握全员负载：' + list : '暂无其他同事';
    }
    /* ---- 资源 / 计分 ---- */
    case 'charge': {
      const n = s.charge || 1;
      p.slack = Math.min(MAX_SLACK, p.slack + n);
      if (s.heal) p.bw = Math.min(p.maxBw, p.bw + Math.round(s.heal * mods(p).healMult));
      pushLog('sys', `@${p.name} 摸了一会儿鱼：摸鱼值 +${n}（${p.slack}/${MAX_SLACK}）${s.heal ? `，带宽 +${s.heal}` : ''}`);
      return `摸鱼值 +${n}（${p.slack}/${MAX_SLACK}）${s.heal ? `，带宽 +${s.heal}` : ''}`;
    }
    case 'kpi': {
      let n = s.kpi;
      if (s.kpiTop) {
        const lowest = actives().slice().sort((a, b) => b.bw - a.bw)[0];
        if (lowest && lowest.id === p.id) n = s.kpiTop;
      }
      if (s.heal) p.bw = Math.min(p.maxBw, p.bw + s.heal);
      if (goal().key === 'battle') { p.bw = Math.min(p.maxBw, p.bw + n); pushLog('sys', `@${p.name} 使用「${s.label}」：带宽 +${n}`); return `带宽 +${n}`; }
      gainScore(p, n, `使用「${s.label}」：${scoreLabel()} +${n}`);
      return `${scoreLabel()} +${n}${s.heal ? `，带宽 +${s.heal}` : ''}`;
    }
    case 'stealKpi': {
      if (!t || !t.alive) return '接收人已离场，抢功落空';
      let taken = 0;
      if (goal().key === 'okr') { taken = Math.round(t.oProg * s.pct / 100); t.oProg -= taken; p.oProg += taken; }
      else if (goal().key === 'deadline') { taken = Math.round(t.delivered * s.pct / 100); t.delivered -= taken; p.delivered += taken; }
      else if (goal().key === 'kpi') { taken = Math.round(t.kpi * s.pct / 100); t.kpi -= taken; p.kpi += taken; }
      else { taken = Math.round(t.bw * s.pct / 100); t.bw -= taken; p.bw = Math.min(p.maxBw, p.bw + taken); }
      pushLog('sys', `@${p.name} 使用「${s.label}」：从 @${t.name} 处拿走 ${taken} 点${goal().key === 'battle' ? '带宽' : scoreLabel()}`);
      return `从 @${t.name} 拿走 ${taken} 点${goal().key === 'battle' ? '带宽' : scoreLabel()}`;
    }
    /* ---- 控制 ---- */
    case 'disable': {
      if (toBoss) {
        if (room.boss && room.boss.telegraph) {
          const victim = byId(room.boss.telegraph.targetId);
          room.boss.telegraph = null;
          pushLog('sys', `@${p.name} 使用「${s.label}」：${ind().boss}本轮的点名被冻结${victim ? `，@${victim.name} 免于一击` : ''}`);
          return `${ind().boss}本轮点名被冻结`;
        }
        return `${ind().boss}本轮暂未点名，控制已备档`;
      }
      if (!t || !t.alive) return '接收人已离场，控制落空';
      t.disabled = true;
      pushLog('sys', `@${p.name} 使用「${s.label}」：@${t.name} 本轮的需求被冻结`);
      return `@${t.name} 本轮提交的需求作废`;
    }
    case 'swap': {
      if (!t || !t.alive) return '接收人不可用';
      const a = p.bw, b = t.bw;
      p.bw = clamp(b, 1, p.maxBw); t.bw = clamp(a, 1, t.maxBw);
      pushLog('sys', `@${p.name} 使用「${s.label}」：与 @${t.name} 的排期占用完成互换（${Math.round(100 * (1 - a / p.maxBw))}% ↔ ${Math.round(100 * (1 - b / t.maxBw))}%）`);
      return `与 @${t.name} 互换排期占用`;
    }
    case 'buff': {
      if (!t || !t.alive) return '接收人不可用';
      t.buffPct += s.pct;
      pushLog('sys', `@${p.name} 为 @${t.name} 赋能：本轮需求冲击 +${s.pct}%`);
      return `@${t.name} 本轮需求冲击 +${s.pct}%`;
    }
    case 'globalShield': {
      room.globalShieldPct = s.pct;
      if (s.kpi) gainScore(p, s.kpi, `拉齐口径，${scoreLabel()} +${s.kpi}`);
      pushLog('sys', `@${p.name} 使用「${s.label}」：本轮所有需求冲击 -${s.pct}%`);
      return `本轮所有需求冲击 -${s.pct}%`;
    }
    /* ---- 大招 ---- */
    case 'ultimate': {
      p.dots = []; p.fragile = 0; p.noHeal = 0; p.slack = 0;
      p.bw = Math.min(p.maxBw, p.bw + 25);
      p.ultShield = true;
      pushLog('sys', `@${p.name} 准点下班：清空所有负担，带宽 +25，本轮不再接收任何需求`);
      return '清空全部负担，带宽 +25，本轮免疫所有需求';
    }
    default: return '需求已归档';
  }
}

/* ---------------------------------------------------------------- 结算 */
function labelOf(id) {
  if (!id) return '—';
  if (id === BOSS) return ind().boss;
  if (id === 'all') return '全员';
  const p = byId(id);
  return p ? '@' + p.name : '—';
}

function resolveRound() {
  const g = goal();
  room.phase = 'review';
  const entries = [];
  actives().forEach(p => {
    if (p.submitted) { const s = SKILL_BY_KEY[p.submitted.skill]; if (s) entries.push({ p, skill: s, target: p.submitted.target, raw: p.submitted.raw, source: p.submitted.source }); }
  });
  shuffle(entries);

  // 控制类技能先落位（冻结、赋能、全局减伤）
  entries.filter(e => e.skill.kind === 'disable').forEach(e => {
    const t = byId(e.target);
    if (t && t.alive) t.disabled = true;
  });
  entries.filter(e => e.skill.kind === 'buff').forEach(e => {
    const t = byId(e.target);
    if (t && t.alive) t.buffPct += e.skill.pct;
  });
  entries.filter(e => e.skill.kind === 'globalShield').forEach(e => { room.globalShieldPct = Math.max(room.globalShieldPct, e.skill.pct); });
  entries.filter(e => e.skill.kind === 'shield').forEach(e => { e.p.shield = true; });
  entries.filter(e => e.skill.kind === 'reflect').forEach(e => { e.p.reflect = true; });
  entries.filter(e => e.skill.kind === 'fortify').forEach(e => { e.p.shield = true; e.p.reflect = true; });
  entries.filter(e => e.skill.kind === 'redirect').forEach(e => {
    const t = byId(e.target);
    e.p.redirectTo = (t && t.alive && t !== e.p) ? t.id : null;
    if (isSolo()) e.p.shield = true;
  });

  room.revealed = entries.map(e => ({
    from: e.p.name, fromId: e.p.id, label: e.skill.label, tag: e.skill.tag,
    quote: String(e.skill.quote).replace('@T', labelOf(e.target)),
    target: labelOf(e.target), raw: e.raw || '', source: e.source || 'card', result: '',
  }));

  entries.forEach((e, i) => {
    if (room.phase === 'over') { room.revealed[i].result = '本季度已结束'; return; }
    if (!e.p.alive) { room.revealed[i].result = '提案人已离场，需求作废'; return; }
    if (e.p.disabled) { room.revealed[i].result = '需求被上级冻结，本轮作废'; return; }
    const before = room.revealed[i];
    // 赋能：提升本次伤害
    if (e.p.buffPct > 0 && (e.skill.kind === 'attack' || e.skill.kind === 'aoe' || e.skill.kind === 'dot')) {
      e.skill = Object.assign({}, e.skill, { dmg: Math.round((e.skill.dmg || 0) * (1 + e.p.buffPct / 100)) });
    }
    room.revealed[i].result = applySkill(e);
    checkDeaths();
  });

  // 清空临时控制标记
  room.players.forEach(p => { p.disabled = false; p.buffPct = 0; p.ultShield = false; });

  // 甲方落点
  if (room.boss && room.boss.telegraph && room.phase !== 'over') {
    const t = byId(room.boss.telegraph.targetId);
    if (t && t.alive) {
      const dmg = room.boss.telegraph.dmg;
      const r = dealDamage(null, t, dmg, '甲方需求', 'demand');
      if (!r.dealt) pushLog('sys', `甲方需求落到 @${t.name} 头上，但被挡了下来`);
      else pushLog('sys', `甲方需求落到 @${t.name} 头上：带宽 -${r.dealt}`);
    } else pushLog('sys', `被点名的同学已离场，需求暂时搁置`);
    room.boss.telegraph = null;
    checkDeaths();
  }

  // 甲方持续伤害 & 项目推进 dot
  if (room.boss && room.boss.dots.length && room.phase !== 'over') {
    let total = 0;
    room.boss.dots.forEach(b => { total += b.dmg; b.dur--; });
    room.boss.dots = room.boss.dots.filter(b => b.dur > 0);
    if (total > 0) { room.boss.hp = Math.max(0, room.boss.hp - total); pushLog('sys', `借调的人力持续支援，项目推进 ${total}（剩余 ${Math.round(room.boss.hp)}）`); }
  }

  // 玩家身上的持续负担
  actives().forEach(p => {
    if (!p.dots.length) return;
    let sum = 0;
    p.dots.forEach(d => { sum += d.dmg; d.dur--; });
    p.dots = p.dots.filter(d => d.dur > 0);
    const r = dealDamage(null, p, sum, '持续负担', 'dot');
    pushLog('sys', `@${p.name} 仍有持续负担在身，带宽 -${r.dealt}`);
  });
  if (checkDeaths()) { broadcast(); return; }

  // 本轮基础产出
  if (g.key === 'kpi' || g.key === 'okr' || g.key === 'deadline') {
    const list = actives();
    if (g.key === 'okr') {
      const counts = {};
      list.forEach(p => { counts[p.oKey] = (counts[p.oKey] || 0) + 1; });
      list.forEach(p => {
        const crowd = counts[p.oKey] || 1;
        const eff = 1 / (1 + 0.3 * (crowd - 1));
        const gain = Math.max(1, Math.round(g.passive * eff)) + mods(p).kpiBonus;
        gainScore(p, gain);
        p.lastGain = gain;
      });
      pushLog('sys', `O 推进结算：各自按赛道拥挤度折算完成度（同一 O 上人越多推进越慢）`);
    } else if (g.key === 'deadline') {
      list.forEach(p => {
        const gain = 7 + mods(p).kpiBonus;
        gainScore(p, gain);
        p.lastGain = gain;
      });
      pushLog('sys', `交付结算：全员各自推进交付量`);
    } else {
      list.forEach(p => { const gain = g.passive + mods(p).kpiBonus; gainScore(p, gain); p.lastGain = gain; });
      pushLog('sys', `产出结算：全员 ${scoreLabel()} +${g.passive}${D.ROLES.some(r => r.passive.kpiBonus) ? '（含职位加成）' : ''}`);
    }
    list.forEach(p => { p.stats.taken = 0; });
    const w = list.find(p => scoreOf(p) >= (g.target || 100));
    if (w) { endGame(w, `${scoreLabel()} 率先达到 ${g.target}，晋升答辩通过`); return; }
  }

  // 项目死线：每 3 轮检查进度
  if (g.key === 'deadline' && room.round % 3 === 0) {
    const list = actives().slice().sort((a, b) => b.delivered - a.delivered);
    const median = list.length ? list[Math.floor(list.length / 2)].delivered : 0;
    const lag = list.filter(p => p.delivered < median);
    if (lag.length) {
      lag.forEach(p => { p.bw -= 12; });
      pushLog('sys', `【进度检查】交付量低于全组中位数（${median}）的成员被约谈：${lag.map(p => '@' + p.name).join('、')}，各 -12 带宽`);
      if (checkDeaths()) { broadcast(); return; }
    } else pushLog('sys', `【进度检查】全员交付节奏正常，无风险项`);
  }

  // 攻坚目标推进
  if (room.boss && room.boss.hp <= 0) {
    const b = room.boss;
    if (isCoop()) { endGame({ team: true, name: '全员' }, `${ind().target}全部交付完成，团队绩效 A`); return; }
    if (b.level >= 3) { endGame(actives()[0] || null, '三个项目全部通关，晋升答辩通过'); return; }
    room.boss = makeBoss(b.level + 1, 1);
    actives().forEach(p => { p.bw = p.maxBw; p.dots = []; });
    pushLog('sys', `项目交付完成！休整后带宽恢复，新项目立项：第 ${room.boss.level} 关（总量 ${room.boss.maxHp}，${ind().boss}火力提升）`);
  }

  // 轮次耗尽
  if (room.round >= roundsMax()) {
    if (isCoop()) { const left = Math.max(0, Math.round(room.boss.hp)); endGame(null, `季度结束，${ind().target}仍剩 ${left} 未交付，团队未通过评审`); return; }
    if (isSolo()) { endGame(null, '演练超时结束，未能通关'); return; }
    const list = actives().slice();
    if (g.key === 'battle') { const best = list.sort((a, b) => b.bw - a.bw)[0] || null; endGame(best, '季度结束，剩余带宽最高'); return; }
    const best = list.sort((a, b) => scoreOf(b) - scoreOf(a))[0] || null;
    endGame(best, `季度结束，${scoreLabel()} 排名第一`);
    return;
  }

  broadcast();
  room.reviewTimer = setTimeout(() => { startRound(); }, REVIEW_MS);
}

/* ---------------------------------------------------------------- 提交 */
function submit(p, skillKey, target, source, raw) {
  const g = goal();
  if (room.phase !== 'select') return '当前不在提案阶段';
  if (!p || p.spect || !p.alive) return '你正处于观察期，暂不能提需求';
  if (p.submitted) return '本轮已提交需求';
  const skill = SKILL_BY_KEY[skillKey];
  if (!skill) return '未找到该需求模板';
  if (p.cds[skillKey] > 0) return '该模板刚用过，建议换个方向';
  if (skill.ultimate && p.slack < MAX_SLACK) return `摸鱼值不足（${p.slack}/${MAX_SLACK}）`;
  const owned = skillsFor(p).some(s => s.key === skillKey);
  if (skillKey !== 'ultimate' && !owned) return '你当前职位没有这个需求模板';
  let tgt = null;
  if (skill.needTarget) {
    if (!target) return '请指定需求接收人';
    if (target === BOSS) {
      if (!hasBoss()) return '当前目标下没有接收方';
      if (skill.kind === 'redirect' && !isSolo()) return '甩锅只能指向同事';
      if (BOSS_OK_KINDS.indexOf(skill.kind) < 0) return `「${skill.label}」用不到${ind().boss}身上，换个接收人`;
      tgt = BOSS;
    } else if (target === 'all') {
      if (skill.kind !== 'aoe' && skill.kind !== 'healAll' && skill.kind !== 'revealAll') return '该模板需要指定具体接收人';
    } else {
      const t = byId(target);
      if (!t || !t.alive || t === p || t.spect) return '接收人不可用';
      if (isSolo()) return '演练模式下需求只能提交给甲方';
      tgt = t.id;
    }
  }
  p.submitted = { skill: skillKey, target: tgt, source: source || 'card', raw: raw || '' };
  p.cds[skillKey] = effCd(p, skill) + 1;
  return null;
}

function tryResolve() {
  if (room.phase !== 'select') return;
  const list = actives();
  if (!list.length) return;
  if (list.every(p => p.submitted)) resolveRound();
}

function resetToLobby() {
  clearTimeout(room.reviewTimer); clearTimeout(room.voteTimer);
  room.reviewTimer = null; room.voteTimer = null;
  room.phase = 'lobby'; room.round = 0; room.revealed = []; room.winner = null; room.winnerReason = '';
  room.event = null; room.boss = null; room.log = []; room.votes = {}; room.started = false;
  room.players.forEach(p => {
    p.spect = false; p.alive = true; p.bw = START_BW; p.kpi = 0; p.oProg = 0; p.delivered = 0;
    p.slack = 0; p.cds = {}; p.dots = []; p.submitted = null;
    p.shield = false; p.reflect = false; p.redirectTo = null; p.disabled = false;
  });
  if (cfg().roleAssign === 'random') room.players.forEach(p => { p.role = null; assignRole(p); });
  if (cfg().originMode === 'random') room.players.forEach(p => assignOrigin(p));
  pushLog('sys', '新一轮筹备中，请主持人配置房间参数并立项');
  broadcast();
}

/* ---------------------------------------------------------------- 入 / 离场 */
function handleJoin(name, wantRole) {
  const clean = String(name || '').trim().slice(0, 12) || '匿名同事';
  // 只有「在线的群主」才算数；群主是幽灵成员时，新进来的人直接接管群主
  const joinAsHost = !room.players.some(x => x.isHost && isLive(x));
  if (joinAsHost) room.players.forEach(x => { x.isHost = false; });
  const p = {
    id: uid(), secret: uid(), name: clean,
    isHost: joinAsHost, lastSeen: Date.now(),
    role: null, origin: null,
    maxBw: START_BW, bw: START_BW, kpi: 0, oProg: 0, delivered: 0, oKey: null,
    slack: 0, alive: true, cds: {}, dots: [], submitted: null,
    shield: false, reflect: false, redirectTo: null,
    fragile: 0, noHeal: 0, buffPct: 0, protect: [], disabled: false,
    usedFirstHit: false, ultShield: false, lastGain: 0, stats: { dealt: 0, taken: 0 },
    spect: !!(room.started && isSolo()),
  };
  if (wantRole && ROLE_BY_KEY[wantRole] && cfg().roleAssign === 'pick' && !usedRoles().includes(wantRole)) p.role = wantRole;
  if (!p.role) assignRole(p);
  assignOrigin(p);
  room.players.push(p);
  pushLog('sys', room.phase === 'lobby' ? `@${p.name} 加入了协作空间` : `@${p.name} 加入协作空间（本轮为观察期）`);
  broadcast();
  return p;
}

function handleLeave(p) {
  if (!p) return;
  room.players = room.players.filter(x => x.id !== p.id);
  clients.delete(p.id);
  delete room.votes[p.id];
  if (!p.spect) { p.alive = false; pushLog('sys', `@${p.name} 已退出协作空间`); }
  // 房间空了就回到筹备状态，方便下一批同事直接开局
  if (!room.players.length) { resetToLobby(); return; }
  if (!room.players.some(x => x.isHost)) room.players[0].isHost = true;
  if (room.phase === 'review' || room.phase === 'select') { checkDeaths(); tryResolve(); }
  if (room.phase === 'vote' && Object.keys(room.votes).length >= actives().length) resolveVote();
  broadcast();
}

/* ---------------------------------------------------------------- 指令 */
const CONFIG_KEYS = ['group', 'industry', 'goal', 'format', 'inputMode', 'roleAssign', 'originMode'];

function setConfig(p, body) {
  if (!p || !p.isHost) return '只有主持人可以调整房间配置';
  if (room.phase !== 'lobby') return '本季度进行中，无法调整房间配置';
  const next = Object.assign({}, room.config);
  CONFIG_KEYS.forEach(k => { if (body[k] != null) next[k] = String(body[k]).slice(0, 40); });
  if (!IND_BY_KEY[next.industry]) return '未知行业';
  if (!GOAL_BY_KEY[next.goal]) return '未知目标';
  if (!['pvp', 'coop', 'solo'].includes(next.format)) return '未知赛制';
  if (!D.INPUT_MODES.some(x => x.key === next.inputMode)) return '未知出手方式';
  if (!D.ROLE_ASSIGN.some(x => x.key === next.roleAssign)) return '未知职位分配方式';
  if (!D.ORIGIN_MODES.some(x => x.key === next.originMode)) return '未知出身设置';
  const goalKind = GOAL_BY_KEY[next.goal].kind;
  if (goalKind === 'boss' && next.format === 'pvp') return '攻坚类目标需要选择团队攻坚或单人演练赛制';
  if (goalKind !== 'boss' && next.format !== 'pvp') return '该目标只支持多人混战赛制';

  const changedIndustry = next.industry !== room.config.industry;
  const changedRoleAssign = next.roleAssign !== room.config.roleAssign;
  const changedOrigin = next.originMode !== room.config.originMode;
  // 只有本次请求没有显式带群名时，换行业才自动跟随该行业的默认群名
  const explicitGroup = body.group != null && String(body.group).trim() !== '';
  if (!explicitGroup && changedIndustry) next.group = IND_BY_KEY[next.industry].group;
  room.config = next;

  if (changedRoleAssign) {
    if (next.roleAssign === 'random') room.players.forEach(x => { x.role = null; assignRole(x); });
    else room.players.forEach(x => { x.role = null; });
  }
  if (changedOrigin) {
    if (next.originMode === 'off') room.players.forEach(x => { x.origin = null; });
    else room.players.forEach(x => { if (!x.origin) assignOrigin(x); });
  }
  pushLog('sys', `【配置更新】${IND_BY_KEY[next.industry].label} · ${GOAL_BY_KEY[next.goal].label} · 房间「${next.group}」`);
  broadcast();
  return null;
}

async function apiAct(p, body) {
  const cmd = body.cmd;
  switch (cmd) {
    case 'state': return { ok: true };

    case 'chat': {
      const text = String(body.text || '').trim().slice(0, 200);
      if (!text || !p) return { error: '消息为空' };
      pushLog('chat', text, p.name);
      broadcast();
      return { ok: true };
    }

    case 'config': {
      const err = setConfig(p, body);
      return err ? { error: err } : { ok: true };
    }

    case 'pickrole': {
      if (!p) return { error: '身份无效' };
      if (room.phase !== 'lobby') return { error: '本季度进行中，无法更换职位' };
      if (cfg().roleAssign !== 'pick') return { error: '当前是随机分配职位模式' };
      const want = String(body.role || '');
      if (!ROLE_BY_KEY[want]) return { error: '未知职位' };
      if (room.players.some(x => x !== p && x.role === want)) return { error: '该职位已被其他同事认领' };
      p.role = want;
      pushLog('sys', `@${p.name} 认领职位：${ROLE_BY_KEY[want].icon} ${ROLE_BY_KEY[want].label}`);
      broadcast();
      return { ok: true };
    }

    case 'reroll': {
      if (!p) return { error: '身份无效' };
      if (room.phase !== 'lobby') return { error: '本季度进行中，无法重新分配' };
      if (cfg().originMode === 'off') return { error: '当前未启用出身' };
      assignOrigin(p);
      pushLog('sys', `@${p.name} 重新抽取出身：${(ORIGIN_BY_KEY[p.origin] || {}).label || '—'}`);
      broadcast();
      return { ok: true };
    }

    case 'start': {
      if (!p || !p.isHost) return { error: '只有主持人可以立项' };
      if (room.phase !== 'lobby') return { error: '当前不在筹备阶段' };
      const need = isSolo() ? 1 : 2;
      if (room.players.length < need) return { error: `至少需要 ${need} 名成员` };
      const err = startGame();
      return err ? { error: err } : { ok: true };
    }

    /* 群主离席时的兜底：在线成员可接管主持权，避免全组都开不了局 */
    case 'claimHost': {
      if (!p) return { error: '身份无效' };
      if (room.phase !== 'lobby') return { error: '本季度进行中，无法更换群主' };
      if (room.players.some(x => x.isHost && x !== p && isLive(x))) return { error: '已有在线的群主' };
      room.players.forEach(x => { x.isHost = (x === p); });
      pushLog('sys', `@${p.name} 接管了主持权`);
      broadcast();
      return { ok: true };
    }

    case 'submit': {
      const err = submit(p, body.skill, body.target, body.source || 'card', body.raw || '');
      if (err) return { error: err };
      broadcast();
      tryResolve();
      return { ok: true };
    }

    /* 关键词 / 自由对话模式：解析一句话再提交 */
    case 'say': {
      if (room.phase !== 'select') return { error: '当前不在提案阶段' };
      if (!p || p.spect || !p.alive) return { error: '你正处于观察期' };
      if (p.submitted) return { error: '本轮已提交需求，可先撤回' };
      const text = String(body.text || '').trim().slice(0, 200);
      if (!text) return { error: '还没说你要提什么需求' };
      const skills = skillsFor(p);
      const r = await SEM.interpret(text, {
        skills,
        players: room.players.map(x => ({ id: x.id, name: x.name, alive: x.alive, spect: x.spect })),
        meId: p.id,
        bossAllowed: hasBoss(),
        bossName: ind().boss,
      });
      if (room.phase !== 'select') return { error: '本轮已结算' };
      if (p.submitted) return { error: '本轮已提交需求' };
      if (!r.ok) {
        pushLog('chat', text, p.name);
        return {
          error: r.note || '没听明白你的意思',
          parsed: { text, confidence: r.confidence || 0, candidates: r.candidates || [], target: r.targetLabel || '' },
        };
      }
      const err = submit(p, r.skillKey, r.targetId, body.source || 'keyword', text);
      if (err) return { error: err };
      pushLog('chat', text, p.name);
      broadcast();
      tryResolve();
      return {
        ok: true,
        parsed: { text, skill: r.skillLabel, target: r.targetLabel || '', confidence: r.confidence, source: r.source, candidates: r.candidates || [] },
      };
    }

    /* 只解析不提交，用于前端实时预览 */
    case 'parse': {
      if (!p) return { error: '身份无效' };
      const text = String(body.text || '').trim();
      if (!text) return { ok: true, parsed: null };
      const r = await SEM.interpret(text, {
        skills: skillsFor(p),
        players: room.players.map(x => ({ id: x.id, name: x.name, alive: x.alive, spect: x.spect })),
        meId: p.id, bossAllowed: hasBoss(), bossName: ind().boss,
      });
      return { ok: true, parsed: r };
    }

    case 'ult': {
      const s = SKILL_BY_KEY.ultimate;
      if (!p || p.slack < MAX_SLACK) return { error: `摸鱼值不足（${p ? p.slack : 0}/${MAX_SLACK}）` };
      if (room.phase !== 'select') return { error: '当前不在提案阶段' };
      if (p.submitted) return { error: '本轮已提交，先撤回再放大招' };
      const err = submit(p, 'ultimate', null, 'ult');
      if (err) return { error: err };
      broadcast();
      tryResolve();
      return { ok: true };
    }

    case 'unsubmit': {
      if (room.phase !== 'select' || !p || !p.submitted) return { error: '当前无法撤回' };
      p.cds[p.submitted.skill] = 0;
      p.submitted = null;
      broadcast();
      return { ok: true };
    }

    case 'vote': {
      if (room.phase !== 'vote' || !p || !p.alive || p.spect) return { error: '当前不在互评阶段' };
      if (room.votes[p.id]) return { error: '本轮已投票' };
      const tid = String(body.target || 'abstain');
      if (tid !== 'abstain') {
        const t = byId(tid);
        if (!t || !t.alive || t.id === p.id) return { error: '投票对象不可用' };
      }
      room.votes[p.id] = tid;
      broadcast();
      if (Object.keys(room.votes).length >= actives().length) resolveVote();
      return { ok: true };
    }

    case 'restart': {
      if (!p || !p.isHost) return { error: '只有主持人可以开启新一轮' };
      if (room.phase !== 'over') return { error: '本季度尚未结束' };
      resetToLobby();
      return { ok: true };
    }

    default: return { error: '未知操作' };
  }
}

/* ---------------------------------------------------------------- HTTP */
function readBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { resolve({}); } });
  });
}
function sendJSON(res, obj, code) {
  res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, buf) => {
      if (err) { res.writeHead(500); res.end('index.html 缺失'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/sse') {
    const p = byId(url.searchParams.get('id') || '');
    if (!p || p.secret !== url.searchParams.get('secret')) { res.writeHead(403); res.end('身份无效'); return; }
    touch(p);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.set(p.id, res);
    res.write(`data: ${JSON.stringify(viewFor(p))}\n\n`);
    req.on('close', () => { if (clients.get(p.id) === res) clients.delete(p.id); });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/reset') {
    // 仅在设置了 ALLOW_RESET=1 时开放，用于自动化测试清场
    if (process.env.ALLOW_RESET !== '1') { res.writeHead(403); res.end('forbidden'); return; }
    clearTimeout(room.reviewTimer); clearTimeout(room.voteTimer);
    room.reviewTimer = null; room.voteTimer = null;
    clients.clear();
    room.players = [];
    room.votes = {};
    room.config = defaultConfig('internet');
    resetToLobby();
    sendJSON(res, { ok: true });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/join') {
    const body = await readBody(req);
    const p = handleJoin(body.name, body.role);
    sendJSON(res, { ok: true, id: p.id, secret: p.secret, state: viewFor(p) });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/act') {
    const body = await readBody(req);
    const p = byId(body.id || '');
    if (!p || p.secret !== body.secret) { sendJSON(res, { error: '身份无效' }, 403); return; }
    touch(p);
    if (body.cmd === 'leave') { handleLeave(p); sendJSON(res, { ok: true }); return; }
    const r = await apiAct(p, body);
    if (r.error) { sendJSON(res, r); return; }
    // parse 只是实时预览，不回传 state，避免前端整页重渲染把用户正在输入的草稿冲掉
    const payload = body.cmd === 'parse' ? { ok: true } : { ok: true, state: viewFor(p) };
    sendJSON(res, Object.assign(payload, r));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

setInterval(() => { clients.forEach(r => { try { r.write(': ping\n\n'); } catch (e) { } }); }, 20000);

server.listen(PORT, '0.0.0.0', () => {
  const urls = lanUrls();
  console.log(`协作空间服务已启动：http://localhost:${PORT}`);
  urls.forEach(u => console.log(`局域网访问：${u}`));
  if (process.env.LLM_API_KEY) console.log('自由对话模式：已接入大模型解析');
  else console.log('自由对话模式：使用本地语义解析（设置 LLM_API_KEY 可接入大模型）');
});
