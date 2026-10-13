'use strict';
// 在独立服务上验证开局、离场与掉线恢复；不重置正在玩的房间。
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const PORT = Number(process.env.PORT) || 7791;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(PORT), ALLOW_RESET: '1', LIVE_MS: '800', REVIEW_MS: '100', VOTE_MS: '100' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', data => { output += data; });
child.stderr.on('data', data => { output += data; });
const controllers = [];
async function post(route, body = {}) {
  const response = await fetch(ORIGIN + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return response.json();
}
const join = name => post('/api/join', { name });
const act = (p, cmd, body = {}) => post('/api/act', { id: p.id, secret: p.secret, cmd, ...body });
async function state(p) {
  const result = await act(p, 'state');
  assert.ok(result.state, JSON.stringify(result));
  return result.state;
}
async function waitFor(p, predicate) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const s = await state(p);
    if (predicate(s)) return s;
    await sleep(60);
  }
  throw new Error('等待状态变化超时');
}
async function online(p) {
  const controller = new AbortController();
  controllers.push(controller);
  const response = await fetch(`${ORIGIN}/sse?id=${p.id}&secret=${p.secret}`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  (async () => { try { while (!(await reader.read()).done) {} } catch {} })();
}
async function reset() {
  controllers.splice(0).forEach(controller => controller.abort());
  assert.equal((await post('/api/reset')).ok, true);
}

(async () => {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`测试服务未启动：${output}`)), 5000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`测试服务退出 ${code}：${output}`)); });
    child.stdout.on('data', () => { if (output.includes('服务已启动')) { clearTimeout(timer); resolve(); } });
  });

  await reset();
  const solo = await join('演练者');
  let s = (await act(solo, 'soloStart')).state;
  assert.equal(s.phase, 'select');
  assert.equal(s.config.format, 'solo');
  const viewer = await join('观众');
  assert.equal(viewer.state.me.spect, true);
  assert.ok((await act(viewer, 'backToLobby')).error);
  assert.ok((await act(viewer, 'soloStart')).error);
  assert.ok((await act(viewer, 'submit', { skill: 'add', target: 'boss' })).error);
  assert.equal((await act(viewer, 'leave')).ok, true);
  assert.equal((await state(solo)).phase, 'select');
  assert.equal((await act(solo, 'submit', { skill: 'add', target: 'boss' })).ok, true);
  await waitFor(solo, st => st.phase === 'select' && st.round === 2);
  assert.equal((await act(solo, 'backToLobby')).state.phase, 'lobby');
  console.log('PASS 单人快捷开局、观察权限、观众退出、回合推进与返回筹备');

  await reset();
  const host = await join('主持人');
  const member = await join('同事');
  const absent = await join('待离场成员');
  assert.equal((await act(host, 'start')).state.phase, 'select');
  const late = await join('中途加入');
  assert.equal(late.state.me.spect, true);
  assert.ok((await act(late, 'submit', { skill: 'add', target: host.id })).error);
  await act(host, 'submit', { skill: 'slack' });
  await act(member, 'submit', { skill: 'slack' });
  await act(absent, 'leave');
  await waitFor(host, st => st.phase === 'select' && st.round === 2);
  await act(member, 'leave');
  s = await state(host);
  assert.equal(s.phase, 'over');
  assert.equal(s.winner.name, '主持人');
  console.log('PASS 多人中途加入不阻塞、未提交者离场后结算、剩余一人正确结束');

  await reset();
  const oldHost = await join('旧演练者');
  await act(oldHost, 'soloStart');
  const successor = await join('接任者');
  await act(oldHost, 'leave');
  s = await state(successor);
  assert.equal(s.phase, 'over');
  assert.equal(s.me.isHost, true);
  await act(successor, 'restart');
  s = (await act(successor, 'soloStart')).state;
  assert.equal(s.me.spect, false);
  assert.equal(s.phase, 'select');
  console.log('PASS 单人玩家退出后结束旧局，观众接任并重新开局');

  await reset();
  const lost = await join('失联演练者');
  await act(lost, 'soloStart');
  const survivor = await join('在线观众');
  await online(survivor);
  s = await waitFor(survivor, st => st.phase === 'over');
  assert.equal(s.me.isHost, true);
  assert.equal(s.players.length, 1);
  await act(survivor, 'restart');
  assert.equal((await act(survivor, 'soloStart')).state.phase, 'select');
  console.log('PASS 掉线清理不会永久卡回合，在线观众获得恢复入口');

  await reset();
  const picker = await join('认领职位者');
  await join('尚未认领的观众');
  await act(picker, 'config', { roleAssign: 'pick' });
  await act(picker, 'pickrole', { role: 'dev' });
  s = (await act(picker, 'soloStart')).state;
  assert.equal(s.phase, 'select');
  assert.equal(s.ready.alive, 1);
  await act(picker, 'submit', { skill: 'add', target: 'boss' });
  await act(picker, 'backToLobby');
  await sleep(180);
  s = await state(picker);
  assert.equal(s.phase, 'lobby');
  assert.equal(s.round, 0);
  console.log('PASS 单人局无需观众认领职位，返回筹备取消评审定时器');
  console.log('恢复功能全部通过');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  controllers.forEach(controller => controller.abort());
  child.kill();
});
