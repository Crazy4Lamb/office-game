'use strict';
// 启动隔离服务，检查独立房间、赛制/目标组合、虚拟成员和单人关卡。
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const PORT = Number(process.env.PORT) || 7792;
const base = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = spawn(process.execPath, ['server.js'], {
  cwd: __dirname, env: { ...process.env, PORT: String(PORT), REVIEW_MS: '30', VOTE_MS: '100' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
server.stdout.on('data', data => { logs += data; });
server.stderr.on('data', data => { logs += data; });
async function post(url, body) {
  const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return response.json();
}
const act = (p, cmd, extra = {}) => post('/api/act', { id: p.id, secret: p.secret, cmd, ...extra });
async function create(config = {}) {
  const result = await post('/api/rooms', { name: '检查员', config });
  assert.equal(result.ok, true, JSON.stringify(result)); return result;
}
async function getState(p) { const r = await act(p, 'state'); assert.ok(r.state, JSON.stringify(r)); return r.state; }
async function play(p, goal) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const s = await getState(p);
    assert.ok(s.me.bw <= s.me.maxBw, '剩余带宽不能超出上限');
    if (s.phase === 'over') return s;
    if (s.phase === 'vote' && !s.votes.mine) await act(p, 'vote', { target: 'abstain' });
    if (s.phase === 'select' && !s.me.submitted && s.me.alive && !s.me.spect) {
      const available = s.me.tools.filter(t => !s.me.cds[t.key]);
      const scoreSkill = available.find(t => t.kind === 'kpi');
      const heal = available.find(t => t.kind === 'heal' && !t.needTarget);
      const bossAttack = available.find(t => ['attack', 'drain', 'dot'].includes(t.kind) && t.bossOk);
      const fallback = available.find(t => !t.needTarget);
      const skill = s.me.bw < 50 && heal ? heal : s.config.format === 'solo' && goal !== 'deadline' ? (goal === 'resolve' ? bossAttack || fallback : scoreSkill || bossAttack || fallback) : (heal || scoreSkill || fallback);
      assert.ok(skill);
      const result = await act(p, 'submit', { skill: skill.key, target: skill.needTarget ? 'boss' : null });
      assert.equal(result.ok, true, JSON.stringify(result));
    }
    await sleep(50);
  }
  throw new Error('对局未能正常结束');
}
(async () => {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(logs)), 5000);
    server.once('error', reject);
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`服务退出 ${code}: ${logs}`)); });
    server.stdout.on('data', () => { if (logs.includes('服务已启动')) { clearTimeout(timeout); resolve(); } });
  });
  for (const format of ['solo', 'pvp', 'duel', 'team', 'coop']) {
    for (const goal of ['battle', 'kpi', 'okr', 'deadline', 'resolve']) {
      const p = await create({ format, goal, inputMode: 'hybrid', stages: 1 });
      assert.equal(p.state.config.format, format);
      assert.equal(p.state.config.goal, goal);
      await act(p, 'leave');
    }
  }
  console.log('PASS 5 种赛制 × 5 种目标均可配置，混合出手可用');
  const quick = await create({ goal: 'kpi' });
  const quickStart = (await act(quick, 'soloStart')).state;
  assert.equal(quickStart.config.goal, 'kpi');
  assert.equal(quickStart.config.format, 'solo');
  await act(quick, 'leave');
  console.log('PASS 单人快捷开局保留已选择的目标');
  const a = await create({ group: '独立一群' });
  const b = await create({ group: '独立二群' });
  assert.notEqual(a.state.roomId, b.state.roomId);
  await act(a, 'chat', { text: '只在一群出现' });
  assert.equal((await getState(b)).log.some(l => l.text === '只在一群出现'), false);
  const colleague = await post('/api/join', { name: '受邀同事', roomId: a.state.roomId });
  assert.equal(colleague.state.players.length, 2);
  assert.equal((await getState(b)).players.length, 1);
  assert.ok((await post('/api/join', { name: '误输编号', roomId: 'missing' })).error);
  await act(colleague, 'leave'); await act(a, 'leave'); await act(b, 'leave');
  console.log('PASS 独立房间、邀请加入、消息隔离及无效编号检查');

  const easy = await create({ format: 'solo', goal: 'resolve', difficulty: 'easy', stages: 1 });
  const hard = await create({ format: 'solo', goal: 'resolve', difficulty: 'expert', stages: 1 });
  const easyStart = (await act(easy, 'start')).state, hardStart = (await act(hard, 'start')).state;
  assert.ok(hardStart.boss.maxHp > easyStart.boss.maxHp);
  await act(easy, 'leave'); await act(hard, 'leave');
  const checkpoint = await create({ format: 'solo', goal: 'resolve', stages: 3, startStage: 3 });
  const checkpointStart = (await act(checkpoint, 'start')).state;
  assert.equal(checkpointStart.challenge.stage, 3);
  assert.equal(checkpointStart.boss.level, 3);
  await act(checkpoint, 'leave');
  console.log('PASS 难度影响真实项目需求，起始关卡实际生效');

  for (const goal of ['resolve', 'kpi', 'okr', 'deadline']) {
    const p = await create({ format: 'solo', goal, difficulty: 'easy', stages: 1, originMode: 'off' });
    await act(p, 'config', { roleAssign: 'pick' });
    await act(p, 'pickrole', { role: 'ops' });
    assert.equal((await act(p, 'start')).ok, true);
    const result = await play(p, goal);
    assert.ok(result.winner, `${goal}: ${result.reason}`);
    if (goal === 'deadline') assert.equal(result.round, 10);
    await act(p, 'leave');
  }
  console.log('PASS 单人项目攻坚、KPI、OKR、deadline 均能完成结算');

  for (const format of ['duel', 'team', 'coop']) {
    const p = await create({ format, goal: 'kpi', originMode: 'off' });
    assert.equal((await act(p, 'fillSeats')).ok, true);
    const r = await act(p, 'start'); assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.state.players.length, format === 'team' ? 6 : format === 'duel' ? 2 : 3);
    if (format === 'team') {
      assert.equal(r.state.teams[0].count, 3); assert.equal(r.state.teams[1].count, 3);
      const ally = r.state.players.find(x => x.id !== p.id && x.team === r.state.me.team);
      const foe = r.state.players.find(x => x.team !== r.state.me.team);
      assert.ok((await act(p, 'submit', { skill: 'add', target: ally.id })).error);
      assert.equal((await act(p, 'submit', { skill: 'add', target: foe.id })).ok, true);
    }
    const final = await play(p, 'kpi');
    assert.equal(final.phase, 'over');
    assert.ok(final.round > 1);
    if (format === 'team' && final.winner) assert.equal(final.winner.team, true);
    await act(p, 'leave');
  }
  console.log('PASS 1v1、3v3、联合攻坚中虚拟成员自动行动，组内冲突限制与团队结算生效');

  const timeout = await create({ format: 'solo', goal: 'resolve', turnSeconds: 1, stages: 1 });
  await act(timeout, 'start'); await sleep(1300);
  assert.ok((await getState(timeout)).round >= 2);
  await act(timeout, 'backToLobby'); await sleep(1100);
  assert.equal((await getState(timeout)).phase, 'lobby');
  await act(timeout, 'leave');
  console.log('PASS 限时提交自动防守，返回筹备取消限时推进');
  console.log('模式与独立房间检查全部通过');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.kill());
