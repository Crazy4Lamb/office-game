'use strict';
// 验证人物消息、回应归属及记录保留；只在隔离服务中创建测试房间。
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const PORT = Number(process.env.PORT) || 7794;
const base = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, ['server.js'], { cwd: __dirname,
  env: { ...process.env, PORT: String(PORT), REVIEW_MS: '120', VOTE_MS: '100' }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
child.stdout.on('data', data => { logs += data; });child.stderr.on('data', data => { logs += data; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function post(url, body) { return (await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json(); }
const act = (p, cmd, body = {}) => post('/api/act', { id: p.id, secret: p.secret, cmd, ...body });
const create = config => post('/api/rooms', { name: '提出需求的同事', config: { originMode: 'off', ...config } });
async function waitRound(p, round) {
  for (let i = 0; i < 80; i++) {
    const result = await act(p, 'state');
    if (result.state.round >= round) return result.state;
    await sleep(20);
  }
  throw new Error('回合没有推进');
}
(async () => {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(logs)), 5000);
    child.once('error', reject);child.once('exit', code => { clearTimeout(timer);reject(new Error(`服务退出 ${code}: ${logs}`)); });
    child.stdout.on('data', () => { if (logs.includes('服务已启动')) {clearTimeout(timer);resolve();} });
  });
  for (const defense of ['reject', 'defer']) {
    const a = await create({ format: 'duel', goal: 'kpi' });
    const b = await post('/api/join', { name: '接收需求的同事', roomId: a.state.roomId });
    await act(a, 'start');
    const hidden = await act(a, 'submit', { skill: 'add', target: b.id });
    assert.equal(hidden.state.log.some(l => l.kind === 'exchange'), false, '未齐交时不能提前公开需求');
    const resolved = await act(b, 'submit', { skill: defense });
    const messages = resolved.state.log.filter(l => l.kind === 'exchange');
    const attack = messages.find(l => l.category === 'action' && l.actor.id === a.id);
    const reply = messages.find(l => l.category === 'response' && l.actor.id === b.id);
    assert.equal(attack.recipient.id, b.id);
    assert.equal(reply.recipient.id, a.id);
    assert.equal(reply.parentId, attack.id);
    assert.equal(reply.replyTo.actor.name, '提出需求的同事');
    assert.equal(reply.replyTo.label, '加需求');
    assert.ok(reply.actor.roleLabel);
    assert.equal(reply.label, defense === 'reject' ? '驳回' : '排期后置');
    const next = await waitRound(a, 2);
    assert.equal(next.revealed.length, 0);
    assert.ok(next.log.some(l => l.id === reply.id), '进入下一轮后仍保留回应消息');
    assert.ok(next.log.filter(l => l.kind === 'sys').length, '技术结算记录保留供右侧展示');
    await act(a, 'leave');await act(b, 'leave');
  }
  console.log('PASS 公开时机、出招头像身份、驳回与挡下的回应归属、下一轮历史保留');
  const solo = await create({ format: 'solo', goal: 'resolve' });
  const started = await act(solo, 'start');
  const proposal = started.state.log.find(l => l.category === 'proposal' && l.actor.id === 'boss');
  assert.equal(proposal.recipient.id, solo.id);assert.equal(proposal.actor.npc, true);
  const reflected = await act(solo, 'submit', { skill: 'reject' });
  const response = reflected.state.log.find(l => l.category === 'response');
  assert.equal(response.actor.id, solo.id);assert.equal(response.recipient.id, 'boss');
  assert.equal(response.parentId, proposal.id);assert.equal(response.replyTo.quote, proposal.quote);
  console.log('PASS 甲方独立人物身份、玩家反击头像、回复原始甲方需求');
  await act(solo, 'leave');

  const redirected = await create({ format: 'pvp', goal: 'kpi' });
  const defender = await post('/api/join', { name: '转交需求的同事', roomId: redirected.state.roomId });
  const receiver = await post('/api/join', { name: '最后接收的同事', roomId: redirected.state.roomId });
  await act(redirected, 'start');
  await act(redirected, 'submit', { skill: 'add', target: defender.id });
  await act(defender, 'submit', { skill: 'blame', target: receiver.id });
  const redirectResult = await act(receiver, 'submit', { skill: 'slack' });
  const redirectReply = redirectResult.state.log.find(l => l.kind === 'exchange' && l.category === 'response' && l.label === '甩锅');
  assert.equal(redirectReply.actor.id, defender.id);assert.equal(redirectReply.recipient.id, redirected.id);
  assert.equal(redirectReply.redirected.id, receiver.id);
  await act(redirected, 'leave');await act(defender, 'leave');await act(receiver, 'leave');
  console.log('PASS 甩锅保留原始出招人、回应人和最终接收人');
  const origins = require('./game-data').ORIGINS;
  const reflectedOrigin = origins.find(origin => origin.reflect);
  const passiveHost = await create({ format: 'duel', goal: 'kpi', originMode: 'random' });
  const passivePeer = await post('/api/join', { name: '被动回应的同事', roomId: passiveHost.state.roomId });
  let peerState = passivePeer.state;
  for (let attempt = 0; peerState.me.origin !== reflectedOrigin.key && attempt < 80; attempt++) peerState = (await act(passivePeer, 'reroll')).state;
  assert.equal(peerState.me.origin, reflectedOrigin.key);
  await act(passiveHost, 'start');
  await act(passiveHost, 'submit', { skill: 'add', target: passivePeer.id });
  const passiveResult = await act(passivePeer, 'submit', { skill: 'slack' });
  const passiveReply = passiveResult.state.log.find(message => message.kind === 'exchange' && message.label === '出身 · 被动反弹');
  assert.equal(passiveReply.actor.id, passivePeer.id);assert.equal(passiveReply.recipient.id, passiveHost.id);
  assert.equal(passiveReply.replyTo.actor.id, passiveHost.id);
  console.log('PASS 出身被动反弹也保留回应方身份及原始出招引用');
  await act(passiveHost, 'leave');await act(passivePeer, 'leave');
  console.log('群聊对战消息检查全部通过');
})().catch(error => {console.error(error);process.exitCode = 1;}).finally(() => child.kill());
