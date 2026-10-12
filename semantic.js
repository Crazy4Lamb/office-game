'use strict';
/**
 * semantic.js —— 三种出手模式共用的意图解析。
 *   卡牌模式：不走这里，前端直接提交 skillKey。
 *   关键词模式 / 自由对话模式：把一句话解析成 { skillKey, targetId }。
 *
 * 解析分两段：
 *   1) 本地规则解析（同义词加权 + 接收人抽取 + 置信度）—— 离线可用，局域网上零依赖。
 *   2) 可选的 LLM 解析 —— 设置环境变量 LLM_API_KEY 后自动启用，失败或超时会无感降级回本地规则。
 */

const BOSS_ALIAS = ['老板', '甲方', '领导', '上层', '上级', 'boss', '客户', '监管', '主任', '组长', '经理', '总监', '专家', '督导'];
const ALL_ALIAS = ['全员', '所有人', '大家', '全组', '全部人', '每个人', '都'];
const SELF_ALIAS = ['自己', '我自己', '我'];

function normalize(t) {
  return String(t == null ? '' : t)
    .replace(/[，。！？、,\.!\?~～；;：:""''（）()\[\]【】]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 把一句话里的接收人抽出来 */
function extractTarget(raw, ctx) {
  const norm = normalize(raw);
  const players = (ctx.players || []).filter(p => p.id !== ctx.meId && p.alive && !p.spect);
  // @某人 精确优先
  const atNames = String(raw || '').match(/@([^\s@，。,.!？?]{1,12})/g) || [];
  for (const a of atNames) {
    const nm = a.slice(1).trim();
    const hit = players.find(p => p.name === nm) || players.find(p => p.name.startsWith(nm));
    if (hit) return { id: hit.id, label: '@' + hit.name, how: 'at', confident: true };
  }
  // 直接出现名字（长名优先，单字名必须带 @）
  const named = players
    .filter(p => p.name.length >= 2 && norm.includes(p.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length);
  if (named.length) return { id: named[0].id, label: '@' + named[0].name, how: 'name', confident: true };

  if (ctx.bossAllowed && BOSS_ALIAS.some(w => norm.includes(w))) {
    return { id: 'boss', label: ctx.bossName || '甲方', how: 'boss', confident: true };
  }
  if (ALL_ALIAS.some(w => norm.includes(w))) {
    return { id: 'all', label: '全员', how: 'all', confident: true };
  }
  if (named.length === 0) {
    // 只有一个人可选时，代词默认指向他
    const pronoun = /\b(他|她|ta|对方|那谁)\b/.test(norm) || /他|她|对方|那谁/.test(raw || '');
    if (pronoun && players.length === 1) {
      return { id: players[0].id, label: '@' + players[0].name, how: 'pronoun', confident: true };
    }
    if (pronoun) return { id: null, label: '不确定是谁', how: 'pronoun', confident: false };
  }
  return { id: null, label: '', how: 'none', confident: false };
}

/** 本地规则解析 */
function localParse(raw, ctx) {
  const norm = normalize(raw);
  const scored = [];
  const skills = ctx.skills || [];
  for (const s of skills) {
    let score = 0;
    let hitWord = '';
    for (const kw of (s.kw || [])) {
      const k = normalize(kw);
      if (!k) continue;
      if (norm.includes(k)) {
        // 关键词越长越具体，权重越高
        const w = 1 + Math.min(2, (k.length - 2) * 0.5);
        if (w > score) { score = w; hitWord = kw; }
        else score += w * 0.35;
      }
    }
    // 直接说技能名（如「甩锅吧」）
    if (norm.includes(normalize(s.label))) score += 2.2;
    if (score > 0) scored.push({ skill: s, score, hitWord });
  }
  scored.sort((a, b) => b.score - a.score);

  const target = extractTarget(raw, ctx);
  const candidates = scored.slice(0, 3).map(x => ({ key: x.skill.key, label: x.skill.label, score: Math.round(x.score * 10) / 10 }));

  if (!scored.length) {
    return { ok: false, reason: 'no_skill', confidence: 0, target, candidates,
      note: '没听出你想提什么需求，试试「甩锅 @张三」或「先排到下个迭代」' };
  }
  const best = scored[0];
  const second = scored[1];
  let confidence = Math.min(1, best.score / 3);
  // 有第二候选且分数接近时降低置信度
  if (second && best.score - second.score < 1) confidence *= 0.65;
  if (best.skill.needTarget && !target.confident) confidence *= 0.7;
  if (!best.skill.needTarget && target.how !== 'none') confidence *= 0.9;

  return {
    ok: confidence >= 0.45,
    skillKey: best.skill.key,
    skillLabel: best.skill.label,
    targetId: best.skill.needTarget ? target.id : null,
    needsTarget: !!best.skill.needTarget,
    targetLabel: target.label,
    confidence: Math.round(confidence * 100) / 100,
    hitWord: best.hitWord,
    candidates,
    note: confidence >= 0.45 ? '' : '不太确定你的意思，请确认一下',
  };
}

/** 可选 LLM 解析（OpenAI 兼容接口） */
async function llmParse(raw, ctx) {
  const key = process.env.LLM_API_KEY;
  if (!key) return null;
  const base = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';
  const skillList = (ctx.skills || []).map(s => `${s.key}=${s.label}（${s.effect}${s.needTarget ? '｜需要接收人' : ''}）`).join('\n');
  const people = (ctx.players || []).filter(p => p.id !== ctx.meId && p.alive && !p.spect)
    .map(p => `${p.name}(id:${p.id})`).join('、') || '（无）';
  const sys = '你是办公室黑话策略游戏的意图解析器。把用户的一句话解析成一条技能。'
    + '只输出 JSON，不要任何解释。格式：{"skill":"技能key或null","target":"接收人id，或 boss，或 null","confidence":0到1的小数}';
  const user = `可选技能：\n${skillList}\n\n可选接收人：${people}${ctx.bossAllowed ? '；另有：boss（' + (ctx.bossName || '甲方') + '）' : ''}\n\n用户说：「${String(raw).slice(0, 120)}」`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 7000);
  try {
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const j = await r.json();
    const txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]);
    const skill = (ctx.skills || []).find(s => s.key === obj.skill);
    if (!skill) return null;
    let tid = obj.target;
    if (tid === 'boss' && !ctx.bossAllowed) tid = null;
    if (tid && tid !== 'boss' && tid !== 'all' && !(ctx.players || []).some(p => p.id === tid && p.alive)) tid = null;
    if (tid === 'all') tid = null;
    return {
      ok: (Number(obj.confidence) || 0.8) >= 0.45,
      skillKey: skill.key, skillLabel: skill.label,
      targetId: skill.needTarget ? tid : null,
      needsTarget: !!skill.needTarget,
      targetLabel: tid === 'boss' ? (ctx.bossName || '甲方') : (tid ? ('@' + ((ctx.players || []).find(p => p.id === tid) || {}).name) : ''),
      confidence: Number(obj.confidence) || 0.8,
      source: 'llm', candidates: [], note: '',
    };
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

/** 统一入口 */
async function interpret(raw, ctx) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { ok: false, reason: 'empty', note: '还没说你要提什么需求' };
  const viaLlm = await llmParse(text, ctx);
  if (viaLlm) return viaLlm;
  const r = localParse(text, ctx);
  r.source = 'local';
  return r;
}

module.exports = { interpret, localParse, extractTarget, normalize };
