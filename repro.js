/* 复现「输入花名后无法开始」：真实 DOM 加载 -> 点进入 -> 检查是否渲染出立项按钮 */
const { JSDOM } = require('jsdom');
const ORIGIN = 'http://127.0.0.1:' + (process.env.PORT || 7777);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const html = await (await fetch(ORIGIN + '/')).text();
  const errors = [];
  const dom = new JSDOM(html, {
    url: ORIGIN + '/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = (u, o) => fetch(u.startsWith('http') ? u : ORIGIN + u, o);
      w.EventSource = class { constructor(){ this.onmessage = null; } close(){} };
      w.addEventListener('error', e => errors.push('window.onerror: ' + e.message));
      const oc = w.console.error;
      w.console.error = (...a) => { errors.push('console.error: ' + a.join(' ')); oc && oc.apply(w.console, a); };
    },
  });
  const w = dom.window, d = w.document;
  await sleep(400);

  console.log('1) 登录卡片可见:', !d.querySelector('#login').hidden);
  console.log('2) 页面加载期错误:', errors.length ? errors : '无');

  d.querySelector('#nameInput').value = '复现员';
  d.querySelector('#joinBtn').click();
  await sleep(900);

  console.log('3) 登录卡片已隐藏:', d.querySelector('#login').hidden);
  console.log('4) 主界面已显示:', !d.querySelector('#app').hidden);
  console.log('5) 运行期错误:', errors.length ? errors : '无');
  const main = d.querySelector('#main');
  console.log('6) main 内容长度:', main ? main.innerHTML.length : 'main 不存在');
  console.log('7) 有立项按钮:', !!d.querySelector('[data-act="start"]'));
  console.log('8) 我是群主:', w.S && w.S.me && w.S.me.isHost);

  if (d.querySelector('[data-act="start"]')) {
    // 先让第二名同事加入（真实场景：主持人等同事进来再立项）
    const p2 = await (await fetch(ORIGIN + '/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '同事乙', roomId: w.S.roomId }) })).json();
    console.log('9) 第二名同事已加入:', p2.state.players.length, '人');
    await sleep(600);
    d.querySelector('[data-act="start"]').click();
    await sleep(1800);
    console.log('10) 点击立项后 phase:', w.S && w.S.phase, '(期望 select)');
    console.log('11) 立项后错误:', errors.length ? errors : '无');
    // 顺手验证第二轮：同事乙提交一张需求，看能否正常结算
    const tools = (p2.state.me.tools || []).filter(t => !t.ultimate);
    console.log('12) 同事乙可用操作数:', tools.length);
    if (tools.length) {
      const sk = tools[0];
      const cands = p2.state.players.filter(x => x.alive && !x.spect && x.id !== p2.id);
      const tg = sk.needTarget && cands.length ? cands[0].id : null;
      const sub = await (await fetch(ORIGIN + '/api/act', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: p2.id, secret: p2.secret, cmd: 'submit', skill: sk.key, target: tg }) })).json();
      console.log('13) 提交需求:', sub.error ? ('失败 ' + sub.error) : '成功');
    }
  }
  process.exit(0);
})().catch(e => { console.error('脚本异常:', e); process.exit(1); });
