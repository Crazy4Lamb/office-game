'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { networkInfo } = require('./network');
const PORT = Number(process.env.PORT) || 7793;
const base = `http://127.0.0.1:${PORT}`;
const mock = {
  WLAN: [{ family: 'IPv4', address: '192.168.1.23', internal: false }],
  'vEthernet (WSL)': [{ family: 4, address: '172.28.16.1', internal: false }],
  VPN: [{ family: 'IPv4', address: '28.0.0.1', internal: false }],
  Ethernet: [{ family: 'IPv4', address: '169.254.1.2', internal: false }],
  loopback: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
};
const info = networkInfo(PORT, '0.0.0.0', mock);
assert.equal(info.recommendedUrl, `http://192.168.1.23:${PORT}`);
assert.equal(info.addresses.length, 3);
assert.equal(info.addresses[0].kind, 'lan');
assert.equal(networkInfo(PORT, '127.0.0.1', mock).lanEnabled, false);
assert.deepEqual(networkInfo(PORT, '127.0.0.1', mock).addresses, []);
console.log('PASS 优先真实局域网，区分虚拟网卡，过滤无效地址，支持仅本机绑定');

const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname, env: { ...process.env, PORT: String(PORT), HOST: '0.0.0.0', LIVE_MS: '800' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', data => { logs += data; });
child.stderr.on('data', data => { logs += data; });
const controllers = [];
const post = async (url, body) => (await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const act = (p, cmd, body = {}) => post('/api/act', { id: p.id, secret: p.secret, cmd, ...body });
async function openStream(p) {
  const controller = new AbortController();controllers.push(controller);
  const response = await fetch(`${base}/sse?id=${p.id}&secret=${p.secret}`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const reader = response.body.getReader();
  let buffer = '';
  return {
    controller,
    async nextState() {
      let timeout;
      const read = async () => {
        for (;;) {
          const end = buffer.indexOf('\n\n');
          if (end >= 0) {
            const event = buffer.slice(0, end);buffer = buffer.slice(end + 2);
            const data = event.split('\n').find(line => line.startsWith('data: '));
            if (data) return JSON.parse(data.slice(6));
            continue;
          }
          const chunk = await reader.read();
          assert.equal(chunk.done, false, '在线的另一个标签页不应被踢断连接');
          buffer += new TextDecoder().decode(chunk.value);
        }
      };
      try { return await Promise.race([read(), new Promise((_, reject) => {timeout = setTimeout(() => reject(new Error('实时更新超时')), 3000);})]); }
      finally {clearTimeout(timeout);}
    },
  };
}
(async () => {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(logs)), 5000);
    child.once('error', reject);
    child.once('exit', code => {clearTimeout(timeout);reject(new Error(`服务退出 ${code}: ${logs}`));});
    child.stdout.on('data', () => {if(logs.includes('服务已启动')){clearTimeout(timeout);resolve();}});
  });
  const networkResponse = await fetch(base + '/api/network');
  const network = await networkResponse.json();
  assert.equal(network.app, 'office-game');assert.equal(network.version, 4);assert.equal(network.host, '0.0.0.0');
  assert.equal(networkResponse.headers.get('cache-control'), 'no-store');
  if (network.recommendedUrl) {
    const viaLAN = await fetch(network.recommendedUrl + '/api/network');
    assert.equal(viaLAN.status, 200);
    assert.equal((await viaLAN.json()).port, PORT);
    console.log('PASS 通过本机真实局域网 IP 访问网页服务');
  }
  const malformed = await fetch(base + '/api/rooms', { method: 'POST', body: '{broken' });
  assert.equal(malformed.status, 400);
  const oversized = await fetch(base + '/api/rooms', { method: 'POST', body: 'x'.repeat(1000001) });
  assert.equal(oversized.status, 413);
  assert.equal((await fetch(base + '/missing')).status, 404);
  console.log('PASS 非法或超大请求返回错误，服务保持可用');
  const unicode = await new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ name: '跨分包中文花名' }));
    const offset = body.indexOf(Buffer.from('跨')) + 1;
    const request = http.request(base + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
      const chunks = [];response.on('data', chunk => chunks.push(chunk));response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    });
    request.on('error', reject);request.write(body.subarray(0, offset));setTimeout(() => request.end(body.subarray(offset)), 30);
  });
  assert.equal(unicode.state.me.name, '跨分包中文花名');await act(unicode, 'leave');
  console.log('PASS 中文请求跨网络分包后仍正确解码');
  const host = await post('/api/rooms', { name: '网页主持人' });
  assert.equal(host.ok, true);
  const peer = await post('/api/join', { name: '局域网同事', roomId: host.state.roomId.toUpperCase() });
  assert.equal(peer.state.players.length, 2);
  const one = await openStream(host);await one.nextState();
  const two = await openStream(host);await two.nextState();
  await act(host, 'chat', { text: '两个标签同时接收' });
  assert.ok((await one.nextState()).log.some(entry => entry.text === '两个标签同时接收'));
  assert.ok((await two.nextState()).log.some(entry => entry.text === '两个标签同时接收'));
  one.controller.abort();
  await act(host, 'chat', { text: '关闭一个标签后继续' });
  let state;
  do { state = await two.nextState(); } while (!state.log.some(entry => entry.text === '关闭一个标签后继续'));
  assert.equal(state.me.isHost, true);
  await act(host, 'leave');
  console.log('PASS 多标签实时连接并存，关闭其中一个不会中断剩余标签');
  console.log('网页和局域网检查全部通过（其他设备及防火墙需现场验证）');
})().catch(error => {console.error(error);process.exitCode = 1;}).finally(() => {controllers.forEach(controller => controller.abort());child.kill();});
