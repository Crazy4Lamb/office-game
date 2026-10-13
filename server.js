'use strict';
/**
 * server.js —— 办公室黑话策略对战 · 引擎
 * 三层结构：引擎（本文件） + 数据（game-data.js） + 语义（semantic.js） + 皮肤（public/index.html）
 * 零外部依赖，纯 Node 内置模块。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const D = require('./game-data');
const SEM = require('./semantic');
const { networkInfo } = require('./network');

const PORT = Number(process.env.PORT) || 7777;
const HOST = process.env.HOST || '0.0.0.0';
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
function createRoom(roomId) {
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
    difficulty: 'normal',
    stages: 3,
    startStage: 1,
    teamSize: 3,
    turnSeconds: 0,
    friendlyFire: 'off',
  };
}

const room = {
  createdAt: Date.now(),
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
  stage: 1,
  stageRound: 0,
  deadline: 0,
  turnTimer: null,
  botTimer: null,
  gameVersion: 0,
  logSequence: 0,
  bossMessage: null,
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
function isTeam() { return room.config.format === 'team'; }
function difficulty() { return D.DIFFICULTIES.find(d => d.key === cfg().difficulty) || D.DIFFICULTIES[1]; }
function formatMeta() {
  const format = D.FORMATS.find(f => f.key === cfg().format) || D.FORMATS[1];
  return isTeam() ? { ...format, label: `小组竞标 · ${cfg().teamSize}v${cfg().teamSize}` } : format;
}
function objectiveText() {
  const key = goal().key;
  if (key === 'deadline') return isSolo() ? '每关 10 轮交付窗口，交付至少 60 才能进入下一关' : isCoop() ? '10 轮内全组累计交付达到 100，通过联合评审' : '固定 10 轮交付窗口，到期按个人或小组交付量评定';
  if (key === 'kpi' || key === 'okr') return `${isSolo() ? '每关个人' : isTeam() || isCoop() ? '全组累计' : '个人'}${key === 'kpi' ? ' KPI' : ' O 完成度'}达到 100${isSolo() ? '，进入下一项目' : '，晋升答辩通过'}`;
  if (isSolo()) return '逐关完成项目需求池，保住带宽，完成所选关卡';
  if (isCoop()) return '共同完成项目需求池；有人被优化则联合攻坚失败';
  return key === 'battle' ? '最后存活的成员或小组晋升；季度到期比较剩余带宽' : '共同完成需求池，按个人或小组交付贡献评定';
}
function hasBoss() { return goal().kind === 'boss' || isSolo() || isCoop(); }
function allies(p, t) { return isCoop() || (isTeam() && p.team && p.team === t.team); }
function enemies(p) { return actives().filter(t => t !== p && (!allies(p, t) || cfg().friendlyFire === 'on')); }
/** 单人演练需要更长的回合窗口才能连过三关 */
function roundsMax() { const g = goal(); return isSolo() ? (cfg().stages - cfg().startStage + 1) * (g.key === 'deadline' ? g.rounds : 10) : g.rounds; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function pushLog(kind, text, name, extra) {
  const entry = Object.assign({ id: 'message-' + (++room.logSequence), ts: Date.now(), round: room.round, stage: room.stage, kind, text, name: name || '' }, extra || {});
  room.log.push(entry);
  if (room.log.length > 400) room.log.splice(0, room.log.length - 400);
  return entry;
}
function messagePerson(value) {
  if (value === BOSS) return { id: BOSS, name: ind().boss, roleLabel: '项目方', roleIcon: '🏢', npc: true };
  const p = typeof value === 'string' ? byId(value) : value;
  if (!p) return null;
  const role = roleOf(p) || {};
  return { id: p.id, name: p.name, roleLabel: role.label || '', roleIcon: role.icon || '', team: p.team || '', bot: !!p.bot };
}
let activeMessage = null;
function exchangeMessage(category, actor, target, label, quote, extra) {
  const from = messagePerson(actor), to = messagePerson(target);
  return pushLog('exchange', `${from ? from.name : ''} · ${label}`, from ? from.name : '', Object.assign({ category, actor: from, recipient: to, label, quote: quote || '' }, extra || {}));
}
function responseMessage(defender, source, label, outcome, redirected) {
  return exchangeMessage('response', defender, source || BOSS, label, '', {
    outcome, parentId: activeMessage ? activeMessage.id : '',
    replyTo: activeMessage ? { actor: activeMessage.actor, label: activeMessage.label, quote: activeMessage.quote } : null,
    redirected: redirected ? messagePerson(redirected) : null,
  });
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
function teamViews() {
  if (!isTeam()) return [];
  return ['red', 'blue'].map(key => {
    const members = seated().filter(p => p.team === key);
    return { key, name: key === 'red' ? '项目一组' : '项目二组', count: members.length,
      alive: members.filter(p => p.alive).length,
      score: members.reduce((sum, p) => sum + scoreOf(p), 0),
      work: members.reduce((sum, p) => sum + (p.projectWork || 0), 0),
      bandwidth: members.filter(p => p.alive).reduce((sum, p) => sum + p.bw, 0) };
  });
}
function teamWinner(team, reason) { endGame({ team: true, name: team.name }, reason); }
function clearTurn() {
  clearTimeout(room.turnTimer); clearTimeout(room.botTimer);
  room.turnTimer = null; room.botTimer = null; room.deadline = 0;
}
function botMove(p) {
  const usable = skillsFor(p).filter(s => !p.cds[s.key]);
  const foes = enemies(p);
  const choices = usable.filter(s => !s.needTarget || (room.boss && BOSS_OK_KINDS.includes(s.kind)) || foes.length);
  const heals = choices.filter(s => ['heal', 'healAll', 'ultimate'].includes(s.kind));
  const attacks = choices.filter(s => ['attack', 'drain', 'dot', 'kpi'].includes(s.kind));
  const skill = pick(p.bw < p.maxBw * 0.45 && heals.length ? heals : (attacks.length ? attacks : choices));
  if (!skill) return;
  const target = skill.needTarget ? (room.boss && BOSS_OK_KINDS.includes(skill.kind) ? BOSS : (pick(foes) || {}).id) : null;
  const err = submit(p, skill.key, target, 'assistant', '');
  if (err) {
    const fallback = choices.find(s => !s.needTarget);
    if (fallback) submit(p, fallback.key, null, 'assistant', '');
  }
}
function armTurn() {
  clearTurn();
  room.botTimer = setTimeout(() => {
    if (room.phase !== 'select') return;
    actives().filter(p => p.bot && !p.submitted).forEach(botMove);
    broadcast(); tryResolve();
  }, 500);
  if (cfg().turnSeconds) {
    room.deadline = Date.now() + cfg().turnSeconds * 1000;
    room.turnTimer = setTimeout(() => {
      if (room.phase !== 'select') return;
      actives().filter(p => !p.submitted).forEach(p => {
        // 自动进入防守，不替玩家决定攻击对象，也不额外消费冷却。
        p.submitted = { skill: 'defer', target: null, source: 'timeout', raw: '' };
        pushLog('sys', `@${p.name} 未在窗口内提交，本轮自动排期后置`);
      });
      tryResolve();
    }, cfg().turnSeconds * 1000);
  }
}
function advanceStage(reason) {
  if (room.stage >= cfg().stages) {
    endGame(actives()[0] || null, `${reason}，完成第 ${cfg().startStage} 至 ${cfg().stages} 关，晋升答辩通过`);
    return true;
  }
  room.stage++; room.stageRound = 0;
  room.boss = makeBoss(room.stage, 1);
  actives().forEach(p => { p.bw = p.maxBw; p.dots = []; p.cds = {}; p.kpi = 0; p.oProg = 0; p.delivered = 0; });
  pushLog('sys', `${reason}，休整后进入第 ${room.stage}/${cfg().stages} 关，带宽与冷却恢复`);
  return false;
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
  return networkInfo(PORT, HOST).addresses.filter(entry => entry.kind === 'lan').map(entry => entry.url);
}

function skillMeta(s) {
  return { key: s.key, label: s.label, tag: s.tag, quote: s.quote, effect: s.effect, kind: s.kind, cd: s.cd || 0, needTarget: !!s.needTarget, owner: s.owner || '', ultimate: !!s.ultimate, bossOk: BOSS_OK_KINDS.indexOf(s.kind) >= 0 || (isSolo() && s.kind === 'redirect') };
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
    roomId,
    joinUrl: `/?room=${roomId}`,
    format: formatMeta(),
    challenge: { stage: room.stage, stages: cfg().stages, stageRound: room.stageRound, difficulty: difficulty().label },
    deadline: room.deadline,
    phase: room.phase,
    round: room.round,
    started: room.started,
    config: Object.assign({}, room.config, { group: room.config.group }),
    industry: { key: i.key, label: i.label, icon: i.icon, color: i.color, group: i.group, target: i.target, boss: i.boss },
    goal: { key: g.key, label: g.label, icon: g.icon, kind: g.kind, rounds: roundsMax(), desc: objectiveText(), target: g.target || 0, win: objectiveText() },
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
      formats: D.FORMATS,
      difficulties: D.DIFFICULTIES,
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
      id: p.id, name: p.name, isHost: p.isHost, spect: p.spect, alive: p.alive, bot: !!p.bot, team: p.team || '', projectWork: p.projectWork || 0,
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
      id: viewer.id, name: viewer.name, isHost: viewer.isHost, spect: viewer.spect, alive: viewer.alive, team: viewer.team || '',
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
    gameVersion: room.gameVersion,
    urls: lanUrls(),
    network: networkInfo(PORT, HOST),
    winner: room.winner ? { name: room.winner.name, team: !!room.winner.team, reason: room.winnerReason } : null,
    reason: room.phase === 'over' ? room.winnerReason : '',
    okr: okrInfo(),
    ready: { alive: actives().length, submitted: actives().filter(p => p.submitted).length, total: seated().length, voted: Object.keys(room.votes).length },
    teams: teamViews(),
  };
}

const clients = new Map();

/* ---------------- 在线判定与群主交接 ----------------
 * 幽灵成员（页面关掉但还留在房间里的人）会霸占群主身份，导致后来的人永远开不了局。
 * 这里以「SSE 长连接在」或「最近有过请求」作为在线依据，定期清理并在群主离席时自动交接。 */
const LIVE_MS = Number(process.env.LIVE_MS || 40000);
function isLive(p) { return !!p && (p.bot || clients.has(p.id) || (Date.now() - (p.lastSeen || 0) < LIVE_MS)); }
function touch(p) { if (p) p.lastSeen = Date.now(); }
function ensureHost() {
  if (!room.players.length) return false;
  const host = room.players.filter(p => p.isHost)[0];
  if (host && isLive(host)) return false;
  // 没人在线时先不交接，等下一个进来的人自然成为群主
  const cand = room.players.filter(p => !p.bot && isLive(p))[0];
  if (!cand || cand === host) return false;
  room.players.forEach(p => { p.isHost = (p === cand); });
  pushLog('sys', host ? `群主 @${host.name} 已离开，群主身份移交给 @${cand.name}` : `@${cand.name} 成为群主`);
  return true;
}
function reapGhosts() {
  const gone = room.players.filter(p => !isLive(p));
  if (gone.length) {
    removePlayers(gone, '连接已超时，退出本局');
    return;
  }
  if (ensureHost()) broadcast();
}

function broadcast() {
  clients.forEach((responses, pid) => {
    const viewer = byId(pid);
    const data = `data: ${JSON.stringify(viewFor(viewer))}\n\n`;
    responses.forEach(res => {
      if (res.destroyed) { responses.delete(res); return; }
      try { res.write(data); } catch (e) { responses.delete(res); }
    });
    if (!responses.size) clients.delete(pid);
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
      case 'allBw': list.forEach(p => { p.bw = Math.min(mods(p).maxBw, p.bw + v); }); break;
      case 'allHeal': list.forEach(p => { p.bw = Math.min(mods(p).maxBw, p.bw + v); }); break;
      case 'allKpi': if (goal().key !== 'battle') list.forEach(p => gainScore(p, v)); break;
      case 'allCharge': list.forEach(p => { p.slack = Math.min(MAX_SLACK, p.slack + v); }); break;
      case 'topBw': {
        const t = list.slice().sort((a, b) => a.bw - b.bw)[0];
        if (t) { t.bw += v; room.eventExtra = t.name; }
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
  clearTurn();
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
  if (isTeam()) {
    const liveTeams = teamViews().filter(t => t.alive);
    if (liveTeams.length === 1) { teamWinner(liveTeams[0], '另一组已全部进入观察期，项目组晋升'); return true; }
    if (!liveTeams.length) { endGame(null, '两组均被优化'); return true; }
    return false;
  }
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
  if (c.format === 'duel' && room.players.length !== 2) return '双人对齐需要恰好 2 位成员';
  if (isTeam()) {
    const size = Number(c.teamSize);
    if (room.players.length !== size * 2) return `小组竞标需要 ${size * 2} 位成员（${size}v${size}）`;
    room.players.filter(p => !['red', 'blue'].includes(p.team)).forEach(p => {
      p.team = room.players.filter(x => x.team === 'red').length < size ? 'red' : 'blue';
    });
    if (['red', 'blue'].some(key => room.players.filter(p => p.team === key).length !== size)) return `两组各需要 ${size} 位成员，请调整分组`;
  }
  // 角色去重（随机分配时可能撞车）
  if (c.roleAssign === 'random') {
    const seen = {};
    room.players.forEach(p => {
      if (!p.role || seen[p.role]) { const free = D.ROLES.filter(r => !seen[r.key]); p.role = (free.length ? pick(free) : pick(D.ROLES)).key; }
      seen[p.role] = 1;
    });
  }
  const missing = room.players.filter(p => !p.spect && !p.role && (!isSolo() || p.isHost));
  if (missing.length) return `还有成员没有认领职位：${missing.map(p => p.name).join('、')}`;

  room.round = 0; room.winner = null; room.winnerReason = ''; room.revealed = []; room.log = [];
  room.event = null; room.eventExtra = null; room.phase = 'lobby'; room.votes = {};
  room.globalShieldPct = 0; room.revealFeed = [];
  clearTurn(); room.stage = c.startStage; room.stageRound = 0;
  room.gameVersion++;
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
    p.projectWork = 0;
    p.submitted = null; p.shield = false; p.reflect = false; p.redirectTo = null;
    p.fragile = 0; p.noHeal = 0; p.buffPct = 0; p.protect = [];
    p.disabled = false; p.usedFirstHit = false; p.ultShield = false;
    p.stats = { dealt: 0, taken: 0 };
  });
  room.boss = hasBoss() ? makeBoss(room.stage, actives().length) : null;
  room.started = true;
  pushLog('sys', `【立项】${ind().label} · ${goal().label}（${objectiveText()}）`);
  pushLog('sys', `赛制：${formatMeta().label}｜出手方式：${(D.INPUT_MODES.find(x => x.key === c.inputMode) || {}).label}｜职位：${(D.ROLE_ASSIGN.find(x => x.key === c.roleAssign) || {}).label}`);
  const spects = room.players.filter(p => p.spect);
  if (spects.length) pushLog('sys', `演练模式开启，${spects.map(p => '@' + p.name).join('、')} 进入观察期`);
  startRound();
}

function makeBoss(level, count) {
  const diff = difficulty();
  if (!isSolo()) { const hp = Math.round((40 * count + 40) * diff.hp); return { hp, maxHp: hp, level: 1, atkBase: Math.round(7 * diff.attack), round: 0, dots: [], telegraph: null }; }
  // 单人演练：三关递进，压力来自轮次累积而非单点爆发
  const hp = Math.round((80 + 20 * (level - 1)) * diff.hp);
  return { hp, maxHp: hp, level, atkBase: Math.round((6 + 2 * (level - 1)) * diff.attack), round: 0, dots: [], telegraph: null };
}
function bossDmgFor(base) { return Math.round(base * (isSolo() ? (1 + 0.25 * (room.boss.level - 1)) : 1)); }
function quoteBoss(round) {
  const pool = D.BOSS_QUOTES[cfg().industry] || D.BOSS_QUOTES.internet;
  return pool[round % pool.length];
}

function startRound() {
  if (room.phase === 'over') return;
  room.round++;
  room.bossMessage = null;
  room.stageRound++;
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
      const t = enemies(p).sort((a, b) => a.bw - b.bw)[0];
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
      room.bossMessage = exchangeMessage('proposal', BOSS, target, '甲方需求', quoteBoss(room.round));
    } else room.boss.telegraph = null;
  }

  if (checkDeaths()) return;

  // 周报互评：每 3 轮一次，人多时开启
  if (!isSolo() && !isCoop() && g.kind === 'pvp' && room.round % 3 === 0 && actives().length >= 3) {
    room.phase = 'vote';
    pushLog('sys', '【周报互评】本轮开始前，全组匿名互评：谁最该被优化？');
    room.voteTimer = setTimeout(() => { if (room.phase === 'vote') resolveVote(); }, VOTE_MS);
    actives().filter(p => p.bot).forEach(p => { room.votes[p.id] = (pick(enemies(p)) || {}).id || 'abstain'; });
    broadcast();
    return;
  }
  room.phase = 'select';
  armTurn();
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
  armTurn();
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
    if (to.ultShield) {
      responseMessage(to, att, '准点下班', '未接收这条需求');
      pushLog('sys', `@${to.name} 已准点下班，挡下「${label}」`);
      return { dealt: 0, text: `@${to.name} 已准点下班，本轮不再接收任何需求` };
    }
    if (room.globalShieldPct) amount = amount * (1 - room.globalShieldPct / 100);
    if (to.shield) {
      to.shield = false;
      responseMessage(to, att, to.defenseLabel || '排期后置', '已挡下这条需求');
      if (att) pushLog('sys', `@${to.name} 把「${label}」排期后置，需求被推迟到下个迭代`);
      return { dealt: 0, text: '需求被排期后置，本轮失效' };
    }
    if (to.reflect) {
      to.reflect = false;
      responseMessage(to, att, to.defenseLabel || '驳回', '已驳回，需求原路返回');
      if (att && att.alive !== undefined) { att.bw -= amount; pushLog('sys', `@${to.name} 驳回「${label}」，需求原路返回：@${att.name} 带宽 -${Math.round(amount)}`); }
      else if (room.boss) { room.boss.hp = Math.max(0, room.boss.hp - amount); pushLog('sys', `@${to.name} 驳回甲方的「${label}」，需求被打回：剩余需求 -${Math.round(amount)}`); }
      return { dealt: 0, text: `需求被驳回并原路返回（-${Math.round(amount)}）` };
    }
    if (to.redirectTo) {
      const f = byId(to.redirectTo);
      if (f && f.alive && f !== to) {
        f.bw -= amount;
        responseMessage(to, att, '甩锅', '已转交需求', f);
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
    responseMessage(to, att, '出身 · 被动反弹', '已将部分需求反弹给对方');
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
  const delivered = Math.min(room.boss.hp, v);
  att.projectWork = (att.projectWork || 0) + delivered;
  if (isSolo() && ['kpi', 'okr', 'deadline'].includes(goal().key)) gainScore(att, Math.round(delivered * 0.5));
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
  const others = () => enemies(p);

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
        room.boss.dots.push({ dmg: d, dur: s.dur, srcId: p.id });
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
      actives().filter(x => !isTeam() || x === p || allies(p, x)).forEach(x => { x.bw = Math.min(x.maxBw, x.bw + base); });
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
  clearTurn();
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
  entries.forEach(e => { e.p.defenseLabel = ['shield', 'reflect', 'fortify', 'redirect'].includes(e.skill.kind) ? e.skill.label : ''; });
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
    actor: messagePerson(e.p), recipient: messagePerson(e.target), round: room.round,
    quote: String(e.skill.quote).replace('@T', labelOf(e.target)),
    target: labelOf(e.target), raw: e.raw || '', source: e.source || 'card', result: '',
  }));
  const actionMessages = entries.map((e, i) => {
    const target = e.target === 'all' ? null : e.target || (!e.skill.needTarget && !['aoe', 'healAll', 'revealAll', 'globalShield'].includes(e.skill.kind) ? e.p : null);
    return exchangeMessage('action', e.p, target, e.skill.label, room.revealed[i].quote, { tag: e.skill.tag, raw: e.raw || '' });
  });

  entries.forEach((e, i) => {
    const message = actionMessages[i];
    activeMessage = message;
    if (room.phase === 'over') { room.revealed[i].result = '本季度已结束'; message.outcome = '本季度已结束'; return; }
    if (!e.p.alive) { room.revealed[i].result = '提案人已离场，需求作废'; message.outcome = '成员已离场'; return; }
    if (e.p.disabled) { room.revealed[i].result = '需求被上级冻结，本轮作废'; message.outcome = '需求被上级冻结'; return; }
    const before = room.revealed[i];
    // 赋能：提升本次伤害
    if (e.p.buffPct > 0 && (e.skill.kind === 'attack' || e.skill.kind === 'aoe' || e.skill.kind === 'dot')) {
      e.skill = Object.assign({}, e.skill, { dmg: Math.round((e.skill.dmg || 0) * (1 + e.p.buffPct / 100)) });
    }
    room.revealed[i].result = applySkill(e);
    message.outcome = '已处理';
    pushLog('sys', `@${e.p.name}「${e.skill.label}」处理结果：${room.revealed[i].result}`);
    checkDeaths();
  });
  activeMessage = null;

  // 清空临时控制标记
  room.players.forEach(p => { p.disabled = false; p.buffPct = 0; });

  // 甲方落点
  if (room.boss && room.boss.telegraph && room.phase !== 'over') {
    activeMessage = room.bossMessage;
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
  activeMessage = null;
  room.players.forEach(p => { p.ultShield = false; });

  // 甲方持续伤害 & 项目推进 dot
  if (room.boss && room.boss.dots.length && room.phase !== 'over') {
    let total = 0;
    room.boss.dots.forEach(b => {
      const contributor = byId(b.srcId);
      const amount = Math.min(b.dmg, Math.max(0, room.boss.hp - total));
      if (contributor) contributor.projectWork = (contributor.projectWork || 0) + amount;
      total += b.dmg; b.dur--;
    });
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
    if (g.key !== 'deadline') {
      if (isTeam()) {
        const team = teamViews().find(t => t.score >= (g.target || 100));
        if (team) { teamWinner(team, `全组 ${scoreLabel()} 达到 ${g.target}，项目组晋升`); return; }
      } else if (isCoop()) {
        if (list.reduce((sum, p) => sum + scoreOf(p), 0) >= (g.target || 100)) { endGame({ team: true, name: '全员' }, `共同 ${scoreLabel()} 达标，联合攻坚完成`); return; }
      } else {
        const w = list.find(p => scoreOf(p) >= (g.target || 100));
        if (w) {
          if (isSolo()) { if (advanceStage(`${scoreLabel()} 达标`)) return; }
          else { endGame(w, `${scoreLabel()} 率先达到 ${g.target}，晋升答辩通过`); return; }
        }
      }
    }
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
    if (isSolo()) {
      if (g.key === 'resolve' || g.key === 'battle') { if (advanceStage('本关项目交付完成')) return; }
      else { room.boss = makeBoss(room.stage, 1); pushLog('sys', '本批需求已完成，继续处理新需求以完成本关目标'); }
    } else if (isCoop()) {
      if (g.key === 'resolve' || g.key === 'battle') { endGame({ team: true, name: '全员' }, `${ind().target}全部交付完成，团队绩效 A`); return; }
      room.boss = makeBoss(1, actives().length);
    } else if (isTeam()) {
      const ranked = teamViews().sort((a, b) => b.work - a.work);
      if (ranked[0].work === ranked[1].work) endGame(null, '项目交付完成，两组贡献相同，联合晋升');
      else teamWinner(ranked[0], '项目交付完成，本组交付贡献最高');
      return;
    } else {
      const list = actives().slice().sort((a, b) => (b.projectWork || 0) - (a.projectWork || 0));
      endGame(list[0] || null, '项目交付完成，交付贡献最高者晋升'); return;
    }
  }

  if (isSolo() && g.key === 'deadline' && room.stageRound >= g.rounds) {
    if (scoreOf(actives()[0]) < 60) { endGame(null, '本关死线已到，交付不足 60，评审未通过'); return; }
    if (advanceStage('本关在死线内达到交付要求')) return;
  }

  // 轮次耗尽
  if (room.round >= roundsMax()) {
    if (isCoop()) {
      if (g.key === 'deadline' && actives().reduce((sum, p) => sum + scoreOf(p), 0) >= 100) endGame({ team: true, name: '全员' }, '死线内共同交付达标，联合评审通过');
      else endGame(null, '季度结束，共同目标尚未达标');
      return;
    }
    if (isSolo()) { endGame(null, '演练超时结束，未能通关'); return; }
    if (isTeam()) {
      const ranked = teamViews().sort((a, b) => (g.key === 'battle' ? b.bandwidth - a.bandwidth : g.key === 'resolve' ? b.work - a.work : b.score - a.score));
      const metric = t => g.key === 'battle' ? t.bandwidth : g.key === 'resolve' ? t.work : t.score;
      if (metric(ranked[0]) === metric(ranked[1])) endGame(null, '两组目标进度相同，本季度平局');
      else teamWinner(ranked[0], '季度截止，全组目标进度领先');
      return;
    }
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
      if (BOSS_OK_KINDS.indexOf(skill.kind) < 0 && !(isSolo() && skill.kind === 'redirect')) return `「${skill.label}」用不到${ind().boss}身上，换个接收人`;
      tgt = BOSS;
    } else if (target === 'all') {
      if (skill.kind !== 'aoe' && skill.kind !== 'healAll' && skill.kind !== 'revealAll') return '该模板需要指定具体接收人';
    } else {
      const t = byId(target);
      if (!t || !t.alive || t === p || t.spect) return '接收人不可用';
      if (isSolo()) return '演练模式下需求只能提交给甲方';
      const supportive = ['heal', 'buff'].includes(skill.kind);
      if (isTeam() && cfg().friendlyFire !== 'on' && allies(p, t) && !supportive) return '当前关闭组内冲突，请选择另一组成员';
      if (isTeam() && !allies(p, t) && supportive) return '支援只能指向本组成员';
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
  clearTurn(); room.stage = cfg().startStage; room.stageRound = 0;
  room.gameVersion++;
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
  // 新成员进入前也清理超时房间，避免接管一局无人继续的单人演练。
  reapGhosts();
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
    spect: room.started,
    team: '', projectWork: 0, bot: false,
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
  removePlayers([p], '已退出协作空间');
}

function removePlayers(gone, reason) {
  const lostParticipant = gone.some(p => !p.spect && p.alive);
  room.players = room.players.filter(p => !gone.includes(p));
  gone.forEach(p => {
    const client = clients.get(p.id);
    clients.delete(p.id);
    if (client) client.forEach(res => { try { res.end(); } catch (e) {} });
    delete room.votes[p.id];
    pushLog('sys', `@${p.name} ${reason}`);
  });
  if (room.players.every(p => p.bot)) room.players = [];
  // 房间空了就回到筹备状态，方便下一批同事直接开局
  if (!room.players.length) { resetToLobby(); return; }
  ensureHost();
  if (lostParticipant && room.started && room.phase !== 'over') {
    if (isSolo()) { endGame(null, '演练成员已离开，请开启新一轮'); return; }
    if (isCoop()) { endGame(null, '团队成员已离开，攻坚结束，请开启新一轮'); return; }
    if (maybeEndAfterDeaths()) return;
  }
  if (room.phase === 'select') tryResolve();
  if (room.phase === 'vote' && Object.keys(room.votes).length >= actives().length) resolveVote();
  broadcast();
}

/* ---------------------------------------------------------------- 指令 */
const CONFIG_KEYS = ['group', 'industry', 'goal', 'format', 'inputMode', 'roleAssign', 'originMode', 'difficulty', 'stages', 'startStage', 'teamSize', 'turnSeconds', 'friendlyFire'];

function setConfig(p, body) {
  if (!p || !p.isHost) return '只有主持人可以调整房间配置';
  if (room.phase !== 'lobby') return '本季度进行中，无法调整房间配置';
  const next = Object.assign({}, room.config);
  CONFIG_KEYS.forEach(k => { if (body[k] != null) next[k] = String(body[k]).slice(0, 40); });
  if (!IND_BY_KEY[next.industry]) return '未知行业';
  if (!GOAL_BY_KEY[next.goal]) return '未知目标';
  if (!D.FORMATS.some(f => f.key === next.format)) return '未知赛制';
  if (!D.INPUT_MODES.some(x => x.key === next.inputMode)) return '未知出手方式';
  if (!D.ROLE_ASSIGN.some(x => x.key === next.roleAssign)) return '未知职位分配方式';
  if (!D.ORIGIN_MODES.some(x => x.key === next.originMode)) return '未知出身设置';
  if (!D.DIFFICULTIES.some(d => d.key === next.difficulty)) return '未知项目难度';
  for (const [key, low, high] of [['stages', 1, 10], ['startStage', 1, 10], ['teamSize', 1, 5], ['turnSeconds', 0, 300]]) {
    const number = Number(next[key]);
    if (!Number.isInteger(number) || number < low || number > high) return `无效的 ${key} 设置`;
    next[key] = number;
  }
  if (next.startStage > next.stages) return '起始关卡不能超过总关数';
  if (!['on', 'off'].includes(next.friendlyFire)) return '未知组内冲突设置';

  const changedIndustry = next.industry !== room.config.industry;
  const changedRoleAssign = next.roleAssign !== room.config.roleAssign;
  const changedOrigin = next.originMode !== room.config.originMode;
  // 只有本次请求没有显式带群名时，换行业才自动跟随该行业的默认群名
  const explicitGroup = body.group != null && String(body.group).trim() !== '';
  if (!explicitGroup && changedIndustry) next.group = IND_BY_KEY[next.industry].group;
  room.config = next;

  if (changedRoleAssign) {
    if (next.roleAssign === 'random') room.players.forEach(x => { x.role = null; assignRole(x); });
    else room.players.forEach(x => { x.role = x.bot ? pick(D.ROLES).key : null; });
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
      pushLog('chat', text, p.name, { actor: messagePerson(p) });
      broadcast();
      return { ok: true };
    }

    case 'config': {
      const err = setConfig(p, body);
      return err ? { error: err } : { ok: true };
    }

    case 'addBot':
    case 'fillSeats': {
      if (!p.isHost || room.phase !== 'lobby') return { error: '只有主持人可以在筹备时添加虚拟同事' };
      const desired = cmd === 'addBot' ? room.players.length + 1 : (cfg().format === 'duel' ? 2 : isTeam() ? cfg().teamSize * 2 : isCoop() ? 3 : 4);
      if (desired > 12) return { error: '协作群最多支持 12 位成员' };
      while (room.players.length < desired) {
        const bot = handleJoin(`同事${room.players.length + 1}`);
        bot.bot = true;
        if (!bot.role) bot.role = pick(D.ROLES.filter(r => !usedRoles().includes(r.key))).key;
        if (isTeam()) bot.team = room.players.filter(x => x.team === 'red').length <= room.players.filter(x => x.team === 'blue').length ? 'red' : 'blue';
      }
      broadcast(); return { ok: true };
    }

    case 'setTeam': {
      if (!p.isHost || room.phase !== 'lobby' || !isTeam()) return { error: '只有主持人可以在筹备时调整分组' };
      const member = byId(body.playerId);
      if (!member || !['red', 'blue'].includes(body.team)) return { error: '成员或分组无效' };
      member.team = body.team; broadcast(); return { ok: true };
    }

    case 'removeBot': {
      if (!p.isHost || room.phase !== 'lobby') return { error: '只有主持人可以在筹备时移除虚拟同事' };
      const member = byId(body.playerId);
      if (!member || !member.bot) return { error: '只能移除虚拟同事' };
      handleLeave(member); return { ok: true };
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
      const need = isSolo() ? 1 : isTeam() ? cfg().teamSize * 2 : 2;
      if (room.players.length < need) return { error: `至少需要 ${need} 名成员` };
      const err = startGame();
      return err ? { error: err } : { ok: true };
    }

    case 'soloStart': {
      if (!p || !p.isHost) return { error: '只有主持人可以开启单人演练' };
      if (room.phase !== 'lobby') return { error: '请先返回筹备，再开启单人演练' };
      if (cfg().roleAssign === 'pick' && !p.role) return { error: '请先认领你的职位' };
      const configErr = setConfig(p, { format: 'solo' });
      if (configErr) return { error: configErr };
      const err = startGame();
      return err ? { error: err } : { ok: true };
    }

    case 'backToLobby': {
      if (!p || !p.isHost) return { error: '只有主持人可以返回筹备' };
      resetToLobby();
      return { ok: true };
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
      const requestRound = room.round, requestVersion = room.gameVersion;
      const skills = skillsFor(p);
      const r = await SEM.interpret(text, {
        skills,
        players: room.players.map(x => ({ id: x.id, name: x.name, alive: x.alive, spect: x.spect })),
        meId: p.id,
        bossAllowed: hasBoss(),
        bossName: ind().boss,
      });
      if (room.phase !== 'select' || room.round !== requestRound || room.gameVersion !== requestVersion) return { error: '本轮已结算' };
      if (p.submitted) return { error: '本轮已提交需求' };
      if (!r.ok) {
        pushLog('chat', text, p.name, { actor: messagePerson(p) });
        return {
          error: r.note || '没听明白你的意思',
          parsed: { text, confidence: r.confidence || 0, candidates: r.candidates || [], target: r.targetLabel || '' },
        };
      }
      const err = submit(p, r.skillKey, r.targetId, body.source || 'keyword', text);
      if (err) return { error: err };
      pushLog('chat', text, p.name, { actor: messagePerson(p) });
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

return { room, clients, byId, touch, viewFor, handleJoin, handleLeave, apiAct, reapGhosts, defaultConfig, resetToLobby, lanUrls };
}

const rooms = new Map([['main', createRoom('main')]]);
function gameForPlayer(id) { return [...rooms.values()].find(game => game.byId(id)) || null; }

/* ---------------------------------------------------------------- HTTP */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0, tooLarge = false;
    const invalid = (message, statusCode) => Object.assign(new Error(message), { statusCode });
    req.on('data', chunk => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > 1000000) { tooLarge = true; chunks = []; reject(invalid('请求内容过大', 413)); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch (e) { reject(invalid('请求需要有效的 JSON 对象', 400)); }
    });
    req.on('error', () => reject(invalid('请求连接已中断', 400)));
    req.on('aborted', () => reject(invalid('请求连接已中断', 400)));
  });
}
function sendJSON(res, obj, code) {
  res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/network') {
    sendJSON(res, { ok: true, ...networkInfo(PORT, HOST) }); return;
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, buf) => {
      if (err) { res.writeHead(500); res.end('index.html 缺失'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/sse') {
    const game = gameForPlayer(url.searchParams.get('id') || '');
    const p = game && game.byId(url.searchParams.get('id'));
    if (!p || p.secret !== url.searchParams.get('secret')) { res.writeHead(403); res.end('身份无效'); return; }
    game.touch(p);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    const responses = game.clients.get(p.id) || new Set();
    responses.add(res);
    game.clients.set(p.id, responses);
    res.write(`data: ${JSON.stringify(game.viewFor(p))}\n\n`);
    req.on('close', () => { responses.delete(res); if (!responses.size && game.clients.get(p.id) === responses) game.clients.delete(p.id); });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/reset') {
    // 仅在设置了 ALLOW_RESET=1 时开放，用于自动化测试清场
    if (process.env.ALLOW_RESET !== '1') { res.writeHead(403); res.end('forbidden'); return; }
    const game = rooms.get('main'), room = game.room;
    game.clients.forEach(responses => responses.forEach(client => client.end()));
    game.clients.clear();
    room.players = [];
    room.votes = {};
    room.config = game.defaultConfig('internet');
    game.resetToLobby();
    sendJSON(res, { ok: true });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/join') {
    const body = await readBody(req);
    const game = rooms.get(String(body.roomId || 'main').trim().toLowerCase());
    if (!game) { sendJSON(res, { error: '协作群不存在，请确认房间编号' }, 404); return; }
    if (!String(body.name || '').trim()) { sendJSON(res, { error: '请先输入花名' }, 400); return; }
    game.reapGhosts();
    if (game.room.players.length >= 12) { sendJSON(res, { error: '协作群已满（12 位成员）' }); return; }
    const p = game.handleJoin(body.name, body.role);
    sendJSON(res, { ok: true, id: p.id, secret: p.secret, state: game.viewFor(p) });
    return;
  }
  if (url.pathname === '/api/rooms' && req.method === 'GET') {
    const list = [...rooms.entries()].filter(([, game]) => game.room.players.some(p => !p.bot)).map(([id, game]) => ({
      id, group: game.room.config.group, phase: game.room.phase, count: game.room.players.length,
      format: game.room.config.format === 'team' ? `小组竞标 · ${game.room.config.teamSize}v${game.room.config.teamSize}` : (D.FORMATS.find(f => f.key === game.room.config.format) || {}).label,
      goal: (GOAL_BY_KEY[game.room.config.goal] || {}).label,
    }));
    sendJSON(res, { ok: true, rooms: list }); return;
  }
  if (url.pathname === '/api/rooms' && req.method === 'POST') {
    const body = await readBody(req);
    if (!String(body.name || '').trim()) { sendJSON(res, { error: '请先输入花名' }); return; }
    if (rooms.size >= 100) { sendJSON(res, { error: '当前协作群较多，请稍后再创建' }); return; }
    const id = crypto.randomBytes(3).toString('hex');
    const game = createRoom(id), p = game.handleJoin(body.name);
    if (body.config) {
      const result = await game.apiAct(p, { ...body.config, cmd: 'config' });
      if (result.error) { sendJSON(res, result); return; }
    }
    rooms.set(id, game);
    sendJSON(res, { ok: true, id: p.id, secret: p.secret, state: game.viewFor(p) }); return;
  }
  if (req.method === 'POST' && url.pathname === '/api/act') {
    const body = await readBody(req);
    const game = gameForPlayer(body.id || '');
    const p = game && game.byId(body.id);
    if (!p || p.secret !== body.secret) { sendJSON(res, { error: '身份无效' }, 403); return; }
    game.touch(p);
    if (body.cmd === 'leave') { game.handleLeave(p); sendJSON(res, { ok: true }); return; }
    const r = await game.apiAct(p, body);
    if (r.error) { sendJSON(res, r); return; }
    // parse 只是实时预览，不回传 state，避免前端整页重渲染把用户正在输入的草稿冲掉
    const payload = body.cmd === 'parse' ? { ok: true } : { ok: true, state: game.viewFor(p) };
    sendJSON(res, Object.assign(payload, r));
    return;
  }
  sendJSON(res, { error: '访问地址不存在，请刷新页面或检查服务版本' }, 404);
  } catch (error) {
    if (res.destroyed) return;
    if (!res.headersSent) sendJSON(res, { error: error.statusCode ? error.message : '服务暂时异常，请稍后重试' }, error.statusCode || 500);
    else res.end();
    if (!error.statusCode) console.error('请求处理异常:', error.message);
  }
});

setInterval(() => { rooms.forEach((game, id) => {
  game.reapGhosts();
  if (id !== 'main' && !game.room.players.length && Date.now() - game.room.createdAt > 300000) rooms.delete(id);
}); }, 3000);
setInterval(() => { rooms.forEach(game => game.clients.forEach(responses => responses.forEach(r => { try { r.write(': ping\n\n'); } catch (e) { } }))); }, 20000);

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `端口 ${PORT} 已被占用，请使用 start.cmd 自动选择可用端口，或设置 PORT。` : `服务启动失败：${error.message}`);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const urls = rooms.get('main').lanUrls();
  console.log(`协作空间服务已启动：http://localhost:${PORT}`);
  urls.forEach(u => console.log(`局域网访问：${u}`));
  if (process.env.LLM_API_KEY) console.log('自由对话模式：已接入大模型解析');
  else console.log('自由对话模式：使用本地语义解析（设置 LLM_API_KEY 可接入大模型）');
});
