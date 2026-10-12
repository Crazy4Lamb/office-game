'use strict';
/**
 * dom-check.js —— 前端真实渲染与交互验证（jsdom，不污染用户环境）
 * 用法：先起服务，再 NODE_PATH 指向隔离目录的 node_modules 运行本脚本。
 */
const { JSDOM } = require('jsdom');
const PORT = Number(process.env.PORT) || 7788;
const ORIGIN = 'http://127.0.0.1:' + PORT;
const REVIEW_MS = Number(process.env.REVIEW_MS) || 400;

let FAIL = 0;
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}` + (!cond && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ''));
  if (!cond) FAIL++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(p, body) {
  const r = await fetch(ORIGIN + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}
const FORBIDDEN = ['攻击', '血量', '伤害', '技能', '敌人', '生命值', '战斗', '击杀', '魔法', '装备', '卡组', '回合'];

(async function main() {
  // 清场，保证每次运行都是干净起点
  await api('/api/reset');

  const dom = await JSDOM.fromURL(ORIGIN + '/', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = (u, o) => fetch(new URL(u, ORIGIN).toString(), o);
      w.EventSource = class { constructor() { } close() { } };
    },
  });
  const w = dom.window, d = w.document;
  await sleep(400);

  /* ---------- 1. 登录 ---------- */
  check('登录页渲染', !!d.querySelector('#login') && !d.querySelector('#login').hidden);
  check('窗口标题是工作软件口径', d.title.indexOf('团队沟通') >= 0 || d.title.indexOf('迭代看板') >= 0, d.title);

  d.querySelector('#nameInput').value = '张伟';
  d.querySelector('#joinBtn').click();
  await sleep(700);
  check('进入后隐藏登录页', d.querySelector('#login').hidden);
  check('主应用已显示', !d.querySelector('#app').hidden);

  /* ---------- 2. 建房向导 ---------- */
  check('建房向导渲染', !!d.querySelector('.wizard'), !!d.querySelector('#main').innerHTML.slice(0, 60));
  check('群名称输入框可用', !!d.querySelector('#groupInput') && d.querySelector('#groupInput').value.length > 0, d.querySelector('#groupInput') && d.querySelector('#groupInput').value);
  const optCount = d.querySelectorAll('.optCard').length;
  check('向导选项卡数量充足', optCount >= 18, optCount);
  ['行业', '本季度目标', '赛制', '出手方式', '职位分配', '出身'].forEach(lbl => {
    check('向导包含分组：' + lbl, d.querySelector('#main').textContent.indexOf(lbl) >= 0);
  });
  check('行业选项 6 个', d.querySelectorAll('.optCard[data-opt="industry"]').length === 6, d.querySelectorAll('.optCard[data-opt="industry"]').length);
  check('目标选项 5 个', d.querySelectorAll('.optCard[data-opt="goal"]').length === 5, d.querySelectorAll('.optCard[data-opt="goal"]').length);
  check('出手方式 3 个', d.querySelectorAll('.optCard[data-opt="inputmode"]').length === 3, d.querySelectorAll('.optCard[data-opt="inputmode"]').length);
  check('默认选中行业高亮', !!d.querySelector('.optCard[data-opt="industry"].sel'));
  check('身份卡展示职位与被动', d.querySelector('#main').textContent.indexOf('被动') >= 0);
  check('加入地址已展示', d.querySelector('#main').textContent.indexOf('http://') >= 0);

  /* ---------- 3. 切换配置 ---------- */
  d.querySelector('.optCard[data-opt="industry"][data-value="medical"]').click();
  await sleep(400);
  check('换行业后群名跟随', w.S.config.industry === 'medical' && w.S.config.group.indexOf('门诊') >= 0, w.S.config);
  d.querySelector('.optCard[data-opt="industry"][data-value="finance"]').click();
  await sleep(400);
  check('换行业后群名跟随', w.S.config.industry === 'finance' && w.S.config.group.indexOf('合规') >= 0, w.S.config);
  check('换行业后高亮转移', d.querySelector('.optCard[data-opt="industry"][data-value="finance"]').classList.contains('sel'));

  const gInput = d.querySelector('#groupInput');
  gInput.value = '季度冲刺 · 攻坚群';
  gInput.dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(400);
  check('群名可自定义', w.S.config.group === '季度冲刺 · 攻坚群', w.S.config.group);

  d.querySelector('.optCard[data-opt="inputmode"][data-value="keyword"]').click();
  await sleep(400);
  check('出手方式可切换到关键词模式', w.S.config.inputMode === 'keyword', w.S.config.inputMode);

  d.querySelector('.optCard[data-opt="goal"][data-value="okr"]').click();
  await sleep(400);
  check('目标可切换到 OKR', w.S.config.goal === 'okr', w.S.config.goal);
  check('切换到 OKR 后赛制被限制为混战', w.S.config.format === 'pvp', w.S.config.format);

  /* ---------- 4. 另外两名成员 ---------- */
  const p2 = await api('/api/join', { name: '李娜' });
  const p3 = await api('/api/join', { name: '王芳' });
  const CREDS = { 李娜: p2, 王芳: p3 };
  await w.act('state');
  await sleep(250);
  check('成员出现在侧栏', d.querySelectorAll('.mLite').length >= 3, d.querySelectorAll('.mLite').length);
  check('随机分配的职位有徽标', d.querySelectorAll('.bdg.role').length >= 3, d.querySelectorAll('.bdg.role').length);
  check('随机分配的出身有徽标', d.querySelectorAll('.bdg.origin').length >= 3, d.querySelectorAll('.bdg.origin').length);
  const roleLabels = [].slice.call(d.querySelectorAll('.bdg.role')).map(e => e.textContent.trim());
  check('随机职位互不重复', new Set(roleLabels).size === roleLabels.length, roleLabels);

  /* ---------- 5. 立项 ---------- */
  check('立项按钮可用', !!d.querySelector('[data-act="start"]'));
  d.querySelector('[data-act="start"]').click();
  await sleep(900);
  check('已进入对局', w.S.started && w.S.phase !== 'lobby', w.S.phase);

  /* ---------- 6. 群聊皮肤 ---------- */
  check('群聊三栏布局', !!d.querySelector('.imWrap') && !!d.querySelector('.imSide') && !!d.querySelector('.imMain') && !!d.querySelector('.imRight'));
  check('左侧有群列表', d.querySelectorAll('.imGroup').length >= 2, d.querySelectorAll('.imGroup').length);
  check('群名显示在会话头', d.querySelector('.imHead').textContent.indexOf('季度冲刺') >= 0);
  check('成员负载条渲染', d.querySelectorAll('.imRight .bar').length >= 2, d.querySelectorAll('.imRight .bar').length);
  check('负载以档位呈现而非精确数值', d.querySelector('.imRight').textContent.indexOf('排期占用') >= 0);

  /* ---------- 7. 关键词模式输入区 ---------- */
  check('关键词提示条渲染', d.querySelectorAll('.kwChip').length >= 6, d.querySelectorAll('.kwChip').length);
  check('自然语言输入框渲染', !!d.querySelector('#sayInput'));
  const kw = d.querySelector('.kwChip');
  kw.click();
  await sleep(600);
  const inp = d.querySelector('#sayInput');
  check('点关键词会填入输入框', inp.value.length > 0, inp.value);
  check('语义解析提示有回执', !!d.querySelector('#parseHint'), d.querySelector('#parseHint') && d.querySelector('#parseHint').textContent);

  /* ---------- 8. 提交需求 + 评审会翻卡 ---------- */
  inp.value = '甩锅 @李娜';
  inp.dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(600);
  d.querySelector('[data-act="say"]').click();
  await sleep(700);
  const submittedTxt = d.querySelector('#actionBar').textContent;
  check('提交后进入已提交状态', submittedTxt.indexOf('已提交') >= 0 || d.querySelector('#main').textContent.indexOf('需求卡已加密') >= 0, submittedTxt.slice(0, 80));

  // 让李娜也提交，触发评审
  await api('/api/act', { id: p2.id, secret: p2.secret, cmd: 'submit', skill: 'add', target: w.S.players.filter(p => p.name === '张伟')[0].id });
  await sleep(1400);
  await w.act('state');
  await sleep(300);
  const mainTxt = d.querySelector('#main').textContent;
  check('评审会揭开需求卡', mainTxt.indexOf('原始输入') >= 0 || mainTxt.indexOf('甩锅') >= 0, mainTxt.slice(0, 160));
  check('结算结果展示黑话效果', /带宽 -|排期占用|已提交|O 完成度|KPI|交付量/.test(mainTxt), mainTxt.slice(0, 200));

  /* ---------- 9. 目标面板 ---------- */
  check('目标面板显示 OKR 赛道', d.querySelector('.imRight').textContent.indexOf('赛道') >= 0, d.querySelector('.imRight').textContent.slice(0, 200));
  check('我的状态面板有摸鱼值', d.querySelector('.imRight').textContent.indexOf('摸鱼值') >= 0);

  /* ---------- 10. 其他两套皮肤 ---------- */
  const sel = d.querySelector('#skinSel');
  sel.value = 'board'; sel.dispatchEvent(new w.Event('change'));
  await sleep(300);
  check('看板皮肤渲染', !d.querySelector('.imWrap') && d.body.dataset.skin === 'board', d.body.dataset.skin);
  check('看板皮肤标题切换', d.querySelector('#appTitle').textContent === '迭代看板', d.querySelector('#appTitle').textContent);

  sel.value = 'meeting'; sel.dispatchEvent(new w.Event('change'));
  await sleep(300);
  check('会议皮肤渲染', d.body.dataset.skin === 'meeting' && d.querySelector('#appTitle').textContent === '视频会议', d.querySelector('#appTitle').textContent);
  check('会议皮肤显示参会人', d.querySelector('#main').textContent.indexOf('参会人') >= 0);

  sel.value = 'chat'; sel.dispatchEvent(new w.Event('change'));
  await sleep(300);
  check('切回群聊皮肤', d.body.dataset.skin === 'chat' && !!d.querySelector('.imWrap'));

  /* ---------- 11. 手册 ---------- */
  d.querySelector('[data-act="rules"]').click();
  await sleep(300);
  const rulesTxt = d.querySelector('#rulesBody').textContent;
  check('手册已打开', !d.querySelector('#rules').hidden);
  check('手册含本局目标', rulesTxt.indexOf('本局手册') >= 0);
  check('手册列出全部职位', d.querySelectorAll('#rulesBody .roleCard').length === 12, d.querySelectorAll('#rulesBody .roleCard').length);
  check('手册列出出身被动', rulesTxt.indexOf('嫡系') >= 0 && rulesTxt.indexOf('炮灰') >= 0);
  check('手册列出全部目标', rulesTxt.indexOf('末位优化') >= 0 && rulesTxt.indexOf('项目死线') >= 0);
  check('手册说明摸鱼值与大招', rulesTxt.indexOf('摸鱼值') >= 0 && rulesTxt.indexOf('准点下班') >= 0);
  check('手册说明老板键', rulesTxt.indexOf('Ctrl+B') >= 0);
  d.querySelector('[data-act="closerules"]').click();
  await sleep(200);

  /* ---------- 12. 老板键 ---------- */
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }));
  await sleep(250);
  check('Ctrl+B 打开周报伪装页', !d.querySelector('#bossView').hidden);
  check('老板键改了窗口标题', d.title.indexOf('周报') >= 0, d.title);
  check('周报页面内容像模像样', d.querySelector('#bossView').textContent.indexOf('本周工作汇总') >= 0);
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }));
  await sleep(400);
  check('再按一次切回工作台', d.querySelector('#bossView').hidden);

  /* ---------- 13. 周报互评阶段 ---------- */
  let sawVote = false;
  for (let i = 0; i < 40 && !sawVote; i++) {
    await w.act('state');
    if (w.S.phase === 'vote') { sawVote = true; break; }
    if (w.S.phase === 'over') break;
    if (w.S.phase === 'select') {
      for (const p of w.S.players.filter(x => x.alive && !x.spect)) {
        if (w.S.phase !== 'select') break;
        const cred = p.isYou ? { id: w.me.id, secret: w.me.secret } : CREDS[p.name];
        if (!cred) continue;
        const st = await api('/api/act', Object.assign({ cmd: 'state' }, cred));
        if (!st.state || !st.state.me) continue;
        const tools = (st.state.me.tools || []).filter(t => !t.ultimate && !(st.state.me.cds && st.state.me.cds[t.key] > 0));
        if (!tools.length) continue;
        const sk = tools[0];
        let tgt = null;
        if (sk.needTarget) tgt = st.state.players.filter(x => x.alive && !x.spect && x.id !== cred.id)[0];
        await api('/api/act', Object.assign({ cmd: 'submit', skill: sk.key, target: tgt ? tgt.id : null }, cred));
      }
    }
    await sleep(REVIEW_MS + 150);
  }
  await w.act('state');
  await sleep(300);
  check('每 3 轮触发周报互评', sawVote, w.S.phase + ' / round ' + w.S.round);
  if (sawVote) {
    check('互评面板渲染候选人', d.querySelectorAll('.voteBtn').length >= 1, d.querySelectorAll('.voteBtn').length);
    check('互评面板说明是匿名', d.querySelector('#main').textContent.indexOf('匿名') >= 0);
    const vb = d.querySelector('.voteBtn');
    if (vb) { vb.click(); await sleep(200); }
    const castBtn = d.querySelector('[data-act="dovote"]');
    check('投票按钮可用', !!castBtn);
    if (castBtn) { castBtn.click(); await sleep(600); check('本人投票生效', !!(w.S.votes && w.S.votes.mine)); }
    // 其余成员也投一票，验证结果结算
    for (const p of w.S.players.filter(x => x.alive && !x.spect && !x.isYou)) {
      const c = CREDS[p.name];
      if (c) await api('/api/act', { id: c.id, secret: c.secret, cmd: 'vote', target: 'abstain' });
    }
    await sleep(900);
    await w.act('state');
    await sleep(300);
    check('互评结束后回到提案阶段', w.S.phase === 'select' || w.S.phase === 'over', w.S.phase);
  }

  /* ---------- 14. 伪装度总检 ---------- */
  const bodyTxt = d.body.textContent;
  const hits = FORBIDDEN.filter(x => bodyTxt.indexOf(x) >= 0);
  check('界面文案不含游戏词汇', hits.length === 0, hits);
  check('界面用工作术语替代血量', bodyTxt.indexOf('带宽') >= 0 || bodyTxt.indexOf('排期占用') >= 0);

  console.log(FAIL === 0 ? '\n前端全部校验通过' : `\n前端失败 ${FAIL} 项`);
  dom.window.close();
  process.exit(FAIL === 0 ? 0 : 1);
})().catch(e => { console.error('渲染验证异常：', e); process.exit(1); });
