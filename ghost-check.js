/* 验证「幽灵成员清理」与「群主掉线自动交接」。
   需要服务的 LIVE_MS 设小一些，例如 LIVE_MS=3000 PORT=7789 node server.js */
const ORIGIN = 'http://127.0.0.1:' + (process.env.PORT || 7789);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = (r) => r.json();
const post = (p, b) => fetch(ORIGIN + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(J);
const state = (c) => post('/api/act', Object.assign({ cmd: 'state' }, c)).then(r => r.state);

const ctrls = [];
async function openSSE(c) {          // 模拟「页面开着」：建立 SSE 长连接
  const ctrl = new AbortController(); ctrls.push(ctrl);
  const res = await fetch(`${ORIGIN}/sse?id=${c.id}&secret=${c.secret}`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  (async () => { try { while (true) { const { done } = await reader.read(); if (done) break; } } catch (e) { } })();
  await sleep(200);
}
const closeSSE = (ctrl) => { try { ctrl.abort(); } catch (e) { } };

let pass = 0, fail = 0;
const chk = (n, ok, extra) => { if (ok) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + '  ' + JSON.stringify(extra)); } };

(async () => {
  await post('/api/reset', {});

  /* ---------- A. 筹备阶段：幽灵成员被清理 ---------- */
  const a = await post('/api/join', { name: '幽灵甲' });
  await sleep(7000);                                  // 不建 SSE，超过 LIVE_MS + 一轮清理周期
  const b = await post('/api/join', { name: '新人乙' });
  chk('筹备阶段清理掉断线的成员', b.state.players.length === 1 && b.state.players[0].name === '新人乙', b.state.players.map(p => p.name));
  chk('新进来的人直接成为群主', b.state.me.isHost === true, b.state.me);

  /* ---------- B. 对局中：群主掉线后自动交接 ---------- */
  await post('/api/reset', {});
  const h = await post('/api/join', { name: '群主丙' });
  await openSSE(h);                                    // 群主在线
  const m = await post('/api/join', { name: '成员丁' });
  await openSSE(m);                                    // 成员在线
  let s = await state(h);
  chk('开局前群主是在线的丙', s.me.isHost === true && s.players.length === 2, s.players.map(p => p.name));
  const st = await post('/api/act', Object.assign({ cmd: 'start' }, h));
  chk('两人成功立项', !st.error && st.state.phase === 'select', st.error || st.state.phase);

  closeSSE(ctrls[0]);                                  // 群主关掉页面
  await sleep(9000);                                   // 等 reaper 跑一轮
  s = await state(m);
  const hostNow = s.players.filter(p => p.isHost).map(p => p.name);
  chk('对局中群主掉线后自动交接给在线成员', hostNow.length === 1 && hostNow[0] === '成员丁', hostNow);
  chk('成员丁现在可以主持', s.me.isHost === true, s.me.isHost);
  const rs = await post('/api/act', Object.assign({ cmd: 'restart' }, m));
  // 对局还在进行中，正常会回「本季度尚未结束」；关键是不能再被判成「没有主持权限」
  chk('接任者已被认可为主持人（不再被拒于主持权限）', !rs.error || rs.error.indexOf('只有主持人') < 0, rs.error);

  /* ---------- C. 兜底：手动接管主持权 ---------- */
  await post('/api/reset', {});
  const x = await post('/api/join', { name: '成员戊' });
  await openSSE(x);
  const y = await post('/api/join', { name: '成员己' });
  await openSSE(y);
  const cl = await post('/api/act', Object.assign({ cmd: 'claimHost' }, y));
  chk('已有在线群主时不允许抢主持权', !!cl.error, cl);
  closeSSE(ctrls[ctrls.length - 2]);                   // 让在线群主断线
  await sleep(6000);
  const cl2 = await post('/api/act', Object.assign({ cmd: 'claimHost' }, y));
  chk('群主离席后可手动接管主持权', !cl2.error, cl2.error);

  ctrls.forEach(closeSSE);
  console.log('\n结果：通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e); process.exit(1); });
