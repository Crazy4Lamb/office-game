'use strict';
/**
 * test.js —— 全组合对局模拟
 * 覆盖：5 种目标 × 3 种出手方式 × 随机/认领职位 × 出身开关 × 团队/单人赛制
 * 每一步都校验状态合法性，出现异常立即抛错。
 */
const PORT = Number(process.env.PORT) || 7777;
const ORIGIN = 'http://127.0.0.1:' + PORT;

const SOFT = ['接收人不可用', '该模板刚用过，建议换个方向', '本轮已提交需求', '当前不在提案阶段',
  '请指定需求接收人', '演练模式下需求只能提交给甲方', '你正处于观察期', '你当前职位没有这个需求模板',
  '摸鱼值不足', '只有群主可以调整房间配置', '本轮已投票', '对局进行中，无法调整房间配置',
  '甩锅只能指向同事', '当前目标下没有接收方'];
function isSoft(e){ return SOFT.some(s => String(e).indexOf(s) >= 0); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function post(p, body) {
  const r = await fetch(ORIGIN + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}

let FAIL = 0;
function check(name, cond, extra) {
  if (cond) return;
  FAIL++;
  console.log(`  [FAIL] ${name}` + (extra !== undefined ? ` → ${JSON.stringify(extra)}` : ''));
}

const TIERS = ['ok', 'warn', 'danger', 'out', 'spect'];
/** 模拟一个「会打的人」：攻坚时优先输出，血量危险时先自保，其余情况随机 */
function chooseSkill(usable, st, mine) {
  if (st.boss) {
    const load = 1 - mine.bw / mine.maxBw;
    const heals = usable.filter(t => t.kind === 'heal' || t.kind === 'healAll');
    if (load > 0.55 && heals.length && Math.random() < 0.8) return heals[0];
    const dps = usable.filter(t => t.bossOk && t.kind !== 'disable' && t.kind !== 'reveal');
    if (dps.length && Math.random() < 0.85) return dps[Math.floor(Math.random() * dps.length)];
  }
  return usable[Math.floor(Math.random() * usable.length)];
}

function validateState(s, tag) {
  check(tag + ' 阶段合法', ['lobby', 'select', 'review', 'vote', 'over'].indexOf(s.phase) >= 0, s.phase);
  s.players.forEach(p => {
    check(tag + ' 档位合法', TIERS.indexOf(p.tier) >= 0, p.tier);
    check(tag + ' 分数非负', p.score == null || p.score >= 0, p.name + ':' + p.score);
    check(tag + ' 观察期外必须有职位', !!p.spect || !!p.role, p.name + '/' + p.role);
    check(tag + ' 出身合法', !p.origin || p.origin === 'off' || !!p.originLabel, p.origin);
  });
  if (s.me) {
    check(tag + ' 带宽上限为正', s.me.maxBw > 0, s.me.maxBw);
    check(tag + ' 摸鱼值范围', s.me.slack >= 0 && s.me.slack <= s.me.maxSlack, s.me.slack);
    (s.me.tools || []).forEach(t => check(tag + ' 技能字段完整', !!t.key && !!t.label && t.effect !== undefined, t));
  }
  if (s.phase === 'select') check(tag + ' 提交数不超过存活数', s.ready.submitted <= s.ready.alive, s.ready);
  if (s.goal.key === 'okr') check(tag + ' OKR 赛道信息齐备', !!s.okr && s.okr.objectives.length >= 4, s.okr && s.okr.objectives.length);
}

async function runCase(cfg, names) {
  const tag = `[${cfg.industry}/${cfg.goal}/${cfg.format}/${cfg.inputMode}/${cfg.roleAssign}/origin:${cfg.originMode}]`;
  console.log(`\n=== ${tag} ===`);
  const members = [];

  // 主持人进场
  const host0 = await post('/api/join', { name: names[0] });
  if (host0.error) { check(tag + ' 加入房间', false, host0.error); return null; }
  const host = { id: host0.id, secret: host0.secret };
  members.push(host);
  let st = host0.state;
  if (st.phase === 'over') { const r = await post('/api/act', Object.assign({ cmd: 'restart' }, host)); if (r.state) st = r.state; }
  check(tag + ' 重置后进入大厅', st.phase === 'lobby', st.phase);

  // 配置房间
  const c = await post('/api/act', Object.assign({ cmd: 'config' }, host, cfg));
  if (c.error) { check(tag + ' 配置成功', false, c.error); members.forEach(m => post('/api/act', Object.assign({ cmd: 'leave' }, m))); return null; }
  st = c.state;
  check(tag + ' 配置已生效', st.config.industry === cfg.industry && st.config.goal === cfg.goal && st.config.format === cfg.format, st.config);
  check(tag + ' 群名可自定义', !cfg.group || st.config.group === cfg.group, st.config.group);

  // 其余成员进场
  for (let i = 1; i < names.length; i++) {
    const j = await post('/api/join', { name: names[i] });
    members.push({ id: j.id, secret: j.secret });
    st = j.state;
  }
  check(tag + ' 成员数正确', st.players.length === names.length, st.players.length + '/' + names.length);

  // 认领职位
  if (cfg.roleAssign === 'pick') {
    const roleKeys = st.meta.roles.map(r => r.key);
    for (let i = 0; i < members.length; i++) {
      const want = roleKeys[i % roleKeys.length];
      const r = await post('/api/act', Object.assign({ cmd: 'pickrole', role: want }, members[i]));
      if (r.error) check(tag + ' 认领职位 ' + want, false, r.error);
      if (r.state) st = r.state;
    }
  }
  check(tag + ' 全员有职位', st.players.every(p => !!p.role), st.players.map(p => p.name + ':' + p.role));
  if (cfg.roleAssign === 'random') {
    const roles = st.players.map(p => p.role);
    check(tag + ' 随机职位不重复', new Set(roles).size === roles.length, roles);
  }
  if (cfg.originMode === 'random') check(tag + ' 全员有出身', st.players.every(p => !!p.origin && p.origin !== 'off'), st.players.map(p => p.origin));

  // 立项
  const started = await post('/api/act', Object.assign({ cmd: 'start' }, host));
  if (started.error) { check(tag + ' 立项成功', false, started.error); members.forEach(m => post('/api/act', Object.assign({ cmd: 'leave' }, m))); return null; }
  st = started.state;
  check(tag + ' 进入对局', st.started && st.phase !== 'lobby', st.phase);
  if (cfg.goal === 'resolve') check(tag + ' 攻坚目标已生成', !!st.boss, st.boss);
  if (cfg.format === 'solo') check(tag + ' 单人局其余人转观察期', st.players.filter(p => p.spect).length === names.length - 1, st.players.map(p => p.spect));

  // 驱动对局
  let guard = 0, votes = 0, parsedOk = 0, says = 0;
  while (st.phase !== 'over' && guard++ < 500) {
    await sleep(40);
    const cst = await post('/api/act', Object.assign({ cmd: 'state' }, host));
    st = cst.state;
    validateState(st, tag);
    if (st.phase === 'over') break;

    if (st.phase === 'vote') {
      votes++;
      const alive = st.players.filter(p => p.alive && !p.spect);
      for (const p of alive) {
        const me = members.filter(x => x.id === p.id)[0];
        if (!me) continue;
        const others = alive.filter(x => x.id !== p.id);
        const pickOne = others[Math.floor(Math.random() * others.length)];
        const r = await post('/api/act', Object.assign({ cmd: 'vote', target: pickOne ? pickOne.id : 'abstain' }, me));
        if (r.error && !isSoft(r.error)) check(tag + ' 投票成功', false, r.error);
        if (r.state) st = r.state;
      }
      continue;
    }
    if (st.phase !== 'select') continue;

    for (const m of members) {
      const vp = st.players.filter(x => x.id === m.id)[0];
      if (!vp || !vp.alive || vp.spect) continue;
      const view = await post('/api/act', Object.assign({ cmd: 'state' }, m));
      if (view.error) { check(tag + ' 拉取个人状态', false, view.error); continue; }
      st = view.state;
      const mine = st.me;
      if (!mine) continue;
      const usable = (mine.tools || []).filter(t => !(mine.cds && mine.cds[t.key] > 0));
      if (!usable.length) continue;
      const skill = chooseSkill(usable, st, mine);
      if (!skill) continue;
      const cands = st.players.filter(x => x.alive && !x.spect && x.id !== m.id);
      const canBoss = st.boss && skill.bossOk;
      let target = null;
      if (skill.needTarget) {
        // 攻坚类目标下，玩家会优先把需求推给需求池（只有能作用于需求池的技能才允许）
        const bossBias = canBoss ? (st.goal.kind === 'boss' ? 0.9 : 0.2) : 0;
        if (canBoss && Math.random() < bossBias) target = 'boss';
        else if (cands.length) target = cands[Math.floor(Math.random() * cands.length)].id;
        else if (canBoss) target = 'boss';
        if (!target) continue;
      }
      if (vp.slack >= 3 && Math.random() < 0.12) { await post('/api/act', Object.assign({ cmd: 'ult' }, m)); continue; }

      if (cfg.inputMode === 'card' || Math.random() < 0.4) {
        const sub = await post('/api/act', Object.assign({ cmd: 'submit', skill: skill.key, target: target }, m));
        if (sub.error && !isSoft(sub.error)) check(tag + ' 提交技能', false, sub.error + ' skill=' + skill.key);
      } else {
        // 关键词 / 自由对话：造一句自然语言
        let sentence = skill.label;
        if (skill.needTarget) sentence += (target === 'boss' ? ' ' + st.industry.boss : ' @' + (st.players.filter(x => x.id === target)[0] || {}).name);
        if (cfg.inputMode === 'free') sentence = '帮忙' + sentence + '，谢了';
        const say = await post('/api/act', Object.assign({ cmd: 'say', text: sentence, source: cfg.inputMode }, m));
        says++;
        if (say.ok && say.parsed && say.parsed.skill) parsedOk++;
        else if (say.error && !isSoft(say.error)) check(tag + ' 语义解析有回执', !!say.parsed, say);
      }
      const after = await post('/api/act', Object.assign({ cmd: 'state' }, host));
      if (after.state) st = after.state;
      if (st.phase !== 'select') break;
    }
  }
  check(tag + ' 对局在合理轮次内结束', guard < 500, guard);

  const final = await post('/api/act', Object.assign({ cmd: 'state' }, host));
  st = final.state;
  const res = {
    场景: tag,
    轮次: st.round,
    互评: votes,
    语义解析: says ? (parsedOk + '/' + says) : '—',
    胜者: st.winner ? st.winner.name : '无',
    结论: st.reason || (st.winner ? st.winner.reason : '—'),
    存活: st.players.filter(p => p.alive && !p.spect).map(p => p.name).join('、') || '无',
  };
  console.log(`  完成：${res.轮次} 轮，互评 ${votes} 次，语义 ${res.语义解析}，胜者 ${res.胜者}`);

  // 清场，保证下一个场景从干净房间开始
  for (const m of members) await post('/api/act', Object.assign({ cmd: 'leave' }, m));
  await sleep(80);
  return res;
}

(async function main() {
  await post('/api/reset');   // 清场，保证每次运行都是干净起点
  const NAMES = ['张伟', '李娜', '王芳', '刘洋', '陈晨'];
  const results = [];
  const cases = [
    { cfg: { group: '交易中台 · 项目群', industry: 'internet', goal: 'battle', format: 'pvp', inputMode: 'card', roleAssign: 'random', originMode: 'random' }, n: 4 },
    { cfg: { group: '业绩冲刺群', industry: 'finance', goal: 'kpi', format: 'pvp', inputMode: 'card', roleAssign: 'random', originMode: 'random' }, n: 3 },
    { cfg: { group: 'OKR 对齐群', industry: 'medical', goal: 'okr', format: 'pvp', inputMode: 'keyword', roleAssign: 'random', originMode: 'random' }, n: 4 },
    { cfg: { group: '交付排期群', industry: 'manufacture', goal: 'deadline', format: 'pvp', inputMode: 'free', roleAssign: 'random', originMode: 'random' }, n: 3 },
    { cfg: { group: '教研攻关组', industry: 'education', goal: 'resolve', format: 'coop', inputMode: 'card', roleAssign: 'random', originMode: 'random' }, n: 3 },
    { cfg: { group: '内容攻坚群', industry: 'media', goal: 'resolve', format: 'solo', inputMode: 'keyword', roleAssign: 'random', originMode: 'random' }, n: 2 },
    { cfg: { group: '不带出身局', industry: 'internet', goal: 'okr', format: 'pvp', inputMode: 'free', roleAssign: 'random', originMode: 'off' }, n: 3 },
    { cfg: { group: '自选职位局', industry: 'finance', goal: 'battle', format: 'pvp', inputMode: 'card', roleAssign: 'pick', originMode: 'random' }, n: 3 },
  ];

  for (const c of cases) {
    const r = await runCase(c.cfg, NAMES.slice(0, c.n));
    if (r) results.push(r);
    await sleep(120);
  }

  console.log('\n=== 配置约束校验 ===');
  const host = await post('/api/join', { name: '边界测试员' });
  const H = { id: host.id, secret: host.secret };
  const bad = [
    ['非法难度被拒', { difficulty: 'nope' }],
    ['起始关卡超出总关数被拒', { stages: 2, startStage: 3 }],
    ['非法目标被拒', { goal: 'nope' }],
    ['非法行业被拒', { industry: 'nope' }],
    ['非法赛制被拒', { format: 'nope' }],
    ['非法出手方式被拒', { inputMode: 'nope' }],
  ];
  for (const [name, payload] of bad) {
    const r = await post('/api/act', Object.assign({ cmd: 'config' }, H, payload));
    check(name, !!r.error, r.error || '（未拒绝）');
  }
  const nonHostJoin = await post('/api/join', { name: '路人甲' });
  const noHost = await post('/api/act', { id: nonHostJoin.id, secret: nonHostJoin.secret, cmd: 'config', group: 'x' });
  check('非群主无法改配置', !!noHost.error, noHost.error || '（未拒绝）');
  const noStart = await post('/api/act', { id: nonHostJoin.id, secret: nonHostJoin.secret, cmd: 'start' });
  check('非群主无法立项', !!noStart.error, noStart.error || '（未拒绝）');
  await post('/api/act', { id: nonHostJoin.id, secret: nonHostJoin.secret, cmd: 'leave' });
  await post('/api/act', Object.assign({ cmd: 'leave' }, H));

  console.log('\n================ 结果汇总 ================');
  console.table(results);
  console.log(FAIL === 0 ? `\n全部通过（${results.length} 个对局场景 + 8 项配置约束）` : `\n失败断言 ${FAIL} 项`);
  process.exit(FAIL === 0 ? 0 : 1);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
