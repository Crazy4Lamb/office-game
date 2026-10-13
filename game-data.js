'use strict';
/**
 * game-data.js —— 全部可扩展配置集中在这里。
 * 想加行业 / 职位 / 出身 / 目标 / 技能 / 事件卡，只改本文件，引擎与界面自动适配。
 *
 * 技能字段：
 *   key        唯一标识
 *   label      显示名（工作术语，不含任何游戏词汇）
 *   tag        P0 / P1 / P2 / ULT —— 仅用于视觉分级
 *   kind       结算类型，见 server.js#applySkill
 *   quote      台词模板，@T 会被替换成接收人
 *   effect     效果说明（手册、按钮提示）
 *   cd         冷却轮数
 *   needTarget 是否需要指定接收人
 *   owner      角色专属（role key）或行业专属（industry key），不填即通用
 *   kw         语义关键词（关键词模式 / 自由对话模式用来自动识别意图）
 *   数值       dmg / dur / heal / selfHeal / selfCost / kpi / pct / fragile / noHeal / allCost
 */

/* ==================================================================== 通用技能 */
const BASE_SKILLS = [
  { key: 'add', label: '加需求', tag: 'P0', kind: 'attack', dmg: 18, cd: 1, needTarget: true,
    quote: '这个需求很简单，顺手加一下', effect: '接收人排期占用 +18',
    kw: ['加需求', '顺手加', '再加一个', '这个也要', '加个功能', '补一个', '临时加', '小需求', '加个入口', '很简单'] },

  { key: 'blame', label: '甩锅', tag: 'P0', kind: 'redirect', cd: 2, needTarget: true,
    quote: '这块逻辑是 @T 负责的，拉他对齐一下', effect: '本轮所有指向自己的需求，全部转嫁给接收人',
    kw: ['甩锅', '不是我的', '他负责', '拉他', '不归我', '找他', '转给他', '这块是他的', '谁改的', '别算我'] },

  { key: 'steal', label: '抢功', tag: 'P0', kind: 'drain', dmg: 12, cd: 2, needTarget: true,
    quote: '这个项目我也有参与，同步一下进度', effect: '接收人排期占用 +12，自己回血（计分类目标转为加分）',
    kw: ['抢功', '我也参与', '同步进度', '这个我做的', '算我一份', '汇报带上我', '蹭一下'] },

  { key: 'borrow', label: '借调', tag: 'P1', kind: 'dot', dmg: 10, dur: 2, cd: 3, needTarget: true,
    quote: '借 @T 支援两个迭代', effect: '接收人未来 2 轮每轮 +10 排期占用',
    kw: ['借调', '借个人', '支援', '调人', '借他', '抽点人力', '借调两周'] },

  { key: 'defer', label: '排期后置', tag: 'P1', kind: 'shield', cd: 2, needTarget: false,
    quote: '这个先排到下个迭代吧', effect: '免疫本轮第一张指向自己的需求',
    kw: ['排期后置', '下个迭代', '先放放', '往后排', '排后面', '下期再做', '先缓缓'] },

  { key: 'reject', label: '驳回', tag: 'P2', kind: 'reflect', cd: 3, needTarget: false,
    quote: '这个需求做不了，依赖还没就绪', effect: '反弹本轮第一张指向自己的需求',
    kw: ['驳回', '做不了', '依赖没就绪', '不接', '拒绝', '退回', '不在范围内'] },

  { key: 'overtime', label: '闭环', tag: 'P2', kind: 'heal', heal: 15, cd: 3, needTarget: false,
    quote: '我周末把这个闭环掉', effect: '自己恢复 15 点带宽',
    kw: ['闭环', '加班', '周末搞', '通宵', '我自己补', '顶一下', '自己扛'] },

  { key: 'inspect', label: '向上管理', tag: 'P2', kind: 'reveal', cd: 2, needTarget: true,
    quote: '进度我同步给老板了', effect: '看穿接收人的真实排期占用',
    kw: ['向上管理', '同步给老板', '汇报', '打听', '看穿', '探底', '摸摸底'] },

  { key: 'slack', label: '摸鱼', tag: 'P2', kind: 'charge', cd: 1, needTarget: false,
    quote: '下楼买杯咖啡，顺便透透气', effect: '摸鱼值 +1，集满 3 点可放「准点下班」',
    kw: ['摸鱼', '咖啡', '歇会儿', '下楼', '偷懒', '划水', '透透气'] },
];

const ULT_SKILL = {
  key: 'ultimate', label: '准点下班', tag: 'ULT', kind: 'ultimate', cd: 0, needTarget: false, ultimate: true,
  quote: '到点了，我先走了', effect: '清空自身全部负担，恢复 25 点带宽，本轮免疫所有需求',
  kw: ['准点下班', '下班', '走了', '提前走'],
};

/* ==================================================================== 角色专属技能 */
const ROLE_SKILLS = [
  /* 研发 */
  { key: 'debt', owner: 'dev', label: '技术债', tag: 'P1', kind: 'dot', dmg: 7, dur: 3, cd: 3, needTarget: true,
    quote: '这段先留个 TODO，后面还债', effect: '接收人未来 3 轮每轮 +7 排期占用',
    kw: ['技术债', '留个todo', '后面还债', '先欠着', '埋个坑'] },
  { key: 'refactor', owner: 'dev', label: '顺手重构', tag: 'P0', kind: 'aoe', dmg: 9, cd: 3, needTarget: false,
    quote: '我顺手把公共模块重构一下', effect: '其他所有同事排期占用 +9',
    kw: ['重构', '公共模块', '顺手改一下底层', '全量改动'] },

  /* 测试 */
  { key: 'bug', owner: 'qa', label: '提 Bug', tag: 'P0', kind: 'attack', dmg: 14, fragile: 1, cd: 1, needTarget: true,
    quote: '这里有个必现 Bug，先别发版', effect: '接收人 +14 排期占用，且下轮受到的需求冲击 +30%',
    kw: ['提bug', '有bug', '必现', '阻塞', '先别发版', '挂了'] },
  { key: 'regress', owner: 'qa', label: '全量回归', tag: 'P2', kind: 'shield', revealSelf: true, cd: 2, needTarget: false,
    quote: '全量回归跑完了，这个版本先封板', effect: '免疫本轮第一次需求，并看到谁在针对自己',
    kw: ['全量回归', '回归', '封板', '用例覆盖', '回归测试'] },

  /* 产品 */
  { key: 'scope', owner: 'pm', label: '需求变更', tag: 'P0', kind: 'attack', dmg: 22, selfCost: 6, cd: 2, needTarget: true,
    quote: '业务方临时加了个场景，很急', effect: '接收人 +22 排期占用，自己 +6',
    kw: ['需求变更', '业务方要', '临时场景', '很急', '口径变了', '需求会'] },
  { key: 'prd', owner: 'pm', label: '拉齐PRD', tag: 'P1', kind: 'disable', cd: 3, needTarget: true,
    quote: 'PRD 还没评审完，先别开发', effect: '接收人本轮提交的需求作废',
    kw: ['拉齐prd', 'prd', '需求评审', '先别开发', '封需求', '方案没定'] },

  /* 设计 */
  { key: 'revise', owner: 'design', label: '改稿', tag: 'P1', kind: 'dot', dmg: 8, dur: 3, cd: 3, needTarget: true,
    quote: '这版设计稿再调整一下，感觉还差点', effect: '接收人未来 3 轮每轮 +8 排期占用',
    kw: ['改稿', '再改一版', '设计稿', '差一点感觉', '像素级', '配色再调'] },
  { key: 'pixel', owner: 'design', label: '像素级还原', tag: 'P2', kind: 'fortify', cd: 3, needTarget: false,
    quote: '这里必须 1:1 还原设计稿', effect: '本轮免疫第一次需求，并将其原路退回',
    kw: ['像素级', '一比一还原', '还原设计稿', '验收标准'] },

  /* 运营 */
  { key: 'data', owner: 'ops', label: '数据造势', tag: 'P2', kind: 'kpi', kpi: 12, cd: 2, needTarget: false,
    quote: '这个数据口径我来定', effect: '自己 KPI +12（非计分类目标转为恢复 12 带宽）',
    kw: ['数据造势', '拉个数据', '口径我来定', '看板加个图', '增长曲线'] },
  { key: 'campaign', owner: 'ops', label: '大促', tag: 'P0', kind: 'aoe', dmg: 8, selfCost: 8, cd: 3, needTarget: false,
    quote: '大促来了，全员上，一个都别跑', effect: '其他所有同事 +8，自己 +8',
    kw: ['大促', '全员上', '冲一把', '活动上线', '双十一'] },

  /* 销售 */
  { key: 'deal', owner: 'sales', label: '签单', tag: 'P2', kind: 'kpi', kpi: 14, kpiTop: 24, cd: 2, needTarget: false,
    quote: '这个单子我签下来了', effect: '自己 KPI +14；若你是全组负载最低，改为 +24',
    kw: ['签单', '成单', '客户签了', '回款', '业绩'] },
  { key: 'credit', owner: 'sales', label: '抢客户', tag: 'P0', kind: 'stealKpi', pct: 50, cd: 3, needTarget: true,
    quote: '这个客户一直是我在跟', effect: '拿走接收人 50% 的 KPI',
    kw: ['抢客户', '客户是我的', '一直是我在跟', '切客户', '抢单'] },

  /* 行政 */
  { key: 'tea', owner: 'admin', label: '订下午茶', tag: 'P2', kind: 'healAll', heal: 8, selfHeal: 20, cd: 3, needTarget: false,
    quote: '订了下午茶，都来歇会儿', effect: '全员恢复 8 点带宽，自己额外 +12',
    kw: ['下午茶', '奶茶', '订餐', '团建', '福利', '零食'] },
  { key: 'seat', owner: 'admin', label: '调整工位', tag: 'P1', kind: 'swap', cd: 2, needTarget: true,
    quote: '工位调整一下，你俩换换', effect: '自己与接收人的排期占用百分比互换',
    kw: ['调工位', '换位置', '工位调整', '换个座', '搬工位'] },

  /* 人力 */
  { key: 'pip', owner: 'hr', label: '绩效改进', tag: 'P0', kind: 'attack', dmg: 20, noHeal: 2, cd: 3, needTarget: true,
    quote: '进入绩效改进计划，先观察两个月', effect: '接收人 +20 排期占用，且 2 轮内无法恢复带宽',
    kw: ['绩效改进', 'pip', '约谈', '进入观察期', '改进计划'] },
  { key: 'reorg', owner: 'hr', label: '组织调整', tag: 'P1', kind: 'cleanse', aoe: 6, cd: 3, needTarget: false,
    quote: '组织架构调整，历史包袱清一清', effect: '清空自己身上所有持续负担，其他同事各 +6',
    kw: ['组织调整', '架构调整', '清包袱', '重新分工'] },

  /* 财务 */
  { key: 'cut', owner: 'finance', label: '削预算', tag: 'P0', kind: 'attack', dmg: 16, noHeal: 1, cd: 2, needTarget: true,
    quote: '预算要砍，这个季度先紧一紧', effect: '接收人 +16 排期占用，且 1 轮内无法恢复带宽',
    kw: ['削预算', '砍预算', '降本', '成本太高', '收紧'] },
  { key: 'budget', owner: 'finance', label: '预算审批', tag: 'P2', kind: 'heal', heal: 18, allCost: 4, cd: 3, needTarget: false,
    quote: '预算我批了，其他人先等等', effect: '自己恢复 18 点带宽，其他同事各 +4',
    kw: ['预算审批', '批预算', '走流程', '费用报销', '先批我这份'] },

  /* 安全 */
  { key: 'audit', owner: 'sec', label: '安全审计', tag: 'P2', kind: 'revealAll', cd: 3, needTarget: false,
    quote: '全量扫一遍，谁有问题一目了然', effect: '看到所有人的真实排期占用',
    kw: ['安全审计', '全量扫', '审计', '查一遍', '体检'] },
  { key: 'lock', owner: 'sec', label: '权限锁定', tag: 'P1', kind: 'disable', cd: 3, needTarget: true,
    quote: '权限先给他锁了，走个审批', effect: '接收人本轮提交的需求作废',
    kw: ['锁权限', '权限回收', '走审批', '封账号', '冻结'] },

  /* 总监 */
  { key: 'empower', owner: 'director', label: '赋能', tag: 'P1', kind: 'buff', pct: 60, cd: 2, needTarget: true,
    quote: '这个方向我来背书，你放心推', effect: '接收人本轮提出的需求冲击 +60%',
    kw: ['赋能', '背书', '你放心推', '给你资源', '倾斜'] },
  { key: 'align', owner: 'director', label: '拉对齐会', tag: 'P2', kind: 'globalShield', pct: 50, kpi: 8, cd: 3, needTarget: false,
    quote: '开个对齐会，把口径统一一下', effect: '本轮所有需求冲击 -50%，自己 KPI +8',
    kw: ['对齐会', '拉齐口径', '统一一下', '开个会', '共识'] },

  /* 实习生 */
  { key: 'misc', owner: 'intern', label: '打杂', tag: 'P2', kind: 'charge', charge: 2, heal: 8, cd: 1, needTarget: false,
    quote: '什么都能干一点，交给我吧', effect: '摸鱼值 +2，自己恢复 8 点带宽',
    kw: ['打杂', '跑腿', '我都能干', '交给我', '帮忙'] },
  { key: 'errand', owner: 'intern', label: '替人跑腿', tag: 'P1', kind: 'heal', heal: 12, healTarget: true, protect: true, cd: 2, needTarget: true,
    quote: '帮哥跑个腿，顺手的事', effect: '接收人恢复 12 点带宽，且本轮不会对你出手',
    kw: ['跑腿', '帮忙顶一下', '替你扛', '顺手'] },
];

/* ==================================================================== 行业专属技能 */
const INDUSTRY_SKILLS = [
  /* 互联网 */
  { key: 'traffic', owner: 'internet', label: '灰度发布', tag: 'P1', kind: 'aoe', dmg: 6, selfHeal: 10, cd: 3, needTarget: false,
    quote: '先放 5% 流量，观察一下再说', effect: '其他同事各 +6 排期占用，自己恢复 10 点带宽',
    kw: ['灰度', '放量', '小流量', '观察一下'] },
  { key: 'sprint', owner: 'internet', label: '敏捷冲刺', tag: 'P2', kind: 'kpi', kpi: 10, heal: 6, cd: 2, needTarget: false,
    quote: '这个迭代我们冲刺一下', effect: '自己 KPI +10，恢复 6 点带宽',
    kw: ['敏捷', '冲刺', '迭代目标', '站会推进'] },

  /* 金融 */
  { key: 'compliance', owner: 'finance', label: '合规检查', tag: 'P0', kind: 'dot', dmg: 9, dur: 3, cd: 3, needTarget: true,
    quote: '这个流程不合规，先整改三个月', effect: '接收人未来 3 轮每轮 +9 排期占用',
    kw: ['合规', '不合规', '整改', '监管要求', '报备'] },
  { key: 'riskctl', owner: 'finance', label: '风控拦截', tag: 'P2', kind: 'fortify', cd: 2, needTarget: false,
    quote: '这笔走不通，风控卡住了', effect: '本轮免疫第一次需求，并将其原路退回',
    kw: ['风控', '拦截', '卡住', '授信', '过不了'] },

  /* 医疗 */
  { key: 'handover', owner: 'medical', label: '交接班', tag: 'P1', kind: 'swap', cd: 2, needTarget: true,
    quote: '这个病人转给你接手吧', effect: '自己与接收人的排期占用百分比互换',
    kw: ['交接班', '转给你', '接手', '交班'] },
  { key: 'triage', owner: 'medical', label: '分诊', tag: 'P2', kind: 'revealAll', cd: 3, needTarget: false,
    quote: '先分个轻重缓急，排个序', effect: '看到所有人的真实排期占用',
    kw: ['分诊', '轻重缓急', '排个序', '急诊'] },

  /* 制造 */
  { key: 'halt', owner: 'manufacture', label: '产线停机', tag: 'P0', kind: 'disable', cd: 3, needTarget: true,
    quote: '这条线先停一下，做个点检', effect: '接收人本轮提交的需求作废',
    kw: ['停机', '点检', '产线停', '检修'] },
  { key: 'qc', owner: 'manufacture', label: '质检', tag: 'P1', kind: 'attack', dmg: 15, fragile: 1, cd: 2, needTarget: true,
    quote: '这批抽检不合格，返工吧', effect: '接收人 +15 排期占用，且下轮受到需求冲击 +30%',
    kw: ['质检', '抽检', '不合格', '返工', '良率'] },

  /* 教育 */
  { key: 'quiz', owner: 'education', label: '随堂测验', tag: 'P2', kind: 'reveal', kpi: 8, cd: 2, needTarget: true,
    quote: '随堂测一下，看看大家掌握得怎么样', effect: '看穿接收人真实排期占用，自己 KPI +8',
    kw: ['随堂测', '测验', '考试', '摸底'] },
  { key: 'assembly', owner: 'education', label: '家长会', tag: 'P1', kind: 'aoe', dmg: 7, selfHeal: 8, cd: 3, needTarget: false,
    quote: '开个家长会，把情况都同步一下', effect: '其他同事各 +7 排期占用，自己恢复 8 点带宽',
    kw: ['家长会', '家长沟通', '同步情况'] },

  /* 传媒 */
  { key: 'hot', owner: 'media', label: '追热点', tag: 'P2', kind: 'kpi', kpi: 12, cd: 2, needTarget: false,
    quote: '这个热点必须跟上，今天就要出片', effect: '自己 KPI +12',
    kw: ['追热点', '热搜', '出片', '蹭流量'] },
  { key: 'wrap', owner: 'media', label: '交片', tag: 'P0', kind: 'attack', dmg: 20, selfCost: 8, cd: 2, needTarget: true,
    quote: '片子今天必须交，通宵也得剪完', effect: '接收人 +20 排期占用，自己 +8',
    kw: ['交片', '剪完', '审片', '成片', '赶档期'] },
];

/* ==================================================================== 职位角色 */
const ROLES = [
  { key: 'dev', label: '研发', icon: '💻', color: '#3370ff',
    blurb: '手上永远有需求，也永远能把需求转给别人',
    passive: { text: '回血类效果额外 +40%（需求消化快）', healMult: 1.4 }, skills: ['debt', 'refactor'] },

  { key: 'qa', label: '测试', icon: '🔍', color: '#0fc6c2',
    blurb: '发现问题的人，也最擅长让别人发现问题',
    passive: { text: '每轮开场自动看穿一名随机同事的真实负载', autoReveal: 1 }, skills: ['bug', 'regress'] },

  { key: 'pm', label: '产品', icon: '📋', color: '#722ed1',
    blurb: '需求的源头，全组压力的分发者',
    passive: { text: '「加需求」类模板的冲击 +25%', attackMult: 1.25 }, skills: ['scope', 'prd'] },

  { key: 'design', label: '设计', icon: '🎨', color: '#eb2f96',
    blurb: '改稿改到麻木，但你的标准就是全组的标准',
    passive: { text: '每轮开场回复 5 点带宽（审美支撑）', roundHeal: 5 }, skills: ['revise', 'pixel'] },

  { key: 'ops', label: '运营', icon: '📈', color: '#fa8c16',
    blurb: '数据口径的制定者，也是最会把功劳写进周报的人',
    passive: { text: '计分类目标下，每轮额外 +3 分', kpiBonus: 3 }, skills: ['data', 'campaign'] },

  { key: 'sales', label: '销售', icon: '💼', color: '#13c2c2',
    blurb: '业绩说话，抢占客户毫不手软',
    passive: { text: '每次成功把需求压给别人，额外获得 4 分（计分类目标）', kpiOnHit: 4 }, skills: ['deal', 'credit'] },

  { key: 'admin', label: '行政', icon: '🗂️', color: '#52c41a',
    blurb: '全组的润滑剂，掌握着下午茶和工位的分配权',
    passive: { text: '所有回血效果 +50%，自身带宽上限 +10', healMult: 1.5, maxBw: 10 }, skills: ['tea', 'seat'] },

  { key: 'hr', label: '人力', icon: '👥', color: '#f5222d',
    blurb: '掌握组织架构，也掌握谁先进入观察期',
    passive: { text: '自己每轮首次受到的冲击 -30%', firstHit: 0.7 }, skills: ['pip', 'reorg'] },

  { key: 'finance', label: '财务', icon: '💰', color: '#d48806',
    blurb: '预算的守门人，一句话就能让项目瘦身',
    passive: { text: '每轮开场让负载最高的同事额外 +3', pressure: 3 }, skills: ['cut', 'budget'] },

  { key: 'sec', label: '安全', icon: '🛡️', color: '#2f54eb',
    blurb: '合规底线，权限在你手里',
    passive: { text: '受到的持续负担（借调/技术债类）减半', dotMult: 0.5 }, skills: ['audit', 'lock'] },

  { key: 'director', label: '总监', icon: '🎯', color: '#c41d7f',
    blurb: '不亲自做需求，但能决定谁能做需求',
    passive: { text: '自身带宽上限 +30', maxBw: 30 }, skills: ['empower', 'align'] },

  { key: 'intern', label: '实习生', icon: '🎒', color: '#8c8c8c',
    blurb: '便宜、灵活、转正欲望强烈',
    passive: { text: '所有模板冷却 -1（最低 1 轮）', cdMod: -1 }, skills: ['misc', 'errand'] },
];

/* ==================================================================== 出身 */
const ORIGINS = [
  { key: 'favored', label: '嫡系', icon: '👑', desc: '老板的人：每轮第一次受到的冲击减半' , firstHit: 0.5 },
  { key: 'cannon', label: '炮灰', icon: '🪖', desc: '皮糙肉厚：受到冲击时反弹 3 点给对方', reflect: 3 },
  { key: 'parachute', label: '空降', icon: '🪂', desc: '起点高：初始带宽 +20，但每轮自然流失 3 点', initBw: 20, bwDrain: 3 },
  { key: 'veteran', label: '老油条', icon: '🐢', desc: '经验足：所有模板冷却 -1（最低 1 轮）', cdMod: -1 },
  { key: 'newbie', label: '新人', icon: '🐣', desc: '没人舍得下狠手：提出与受到的冲击都减半', dealMult: 0.5, takeMult: 0.5 },
  { key: 'rollking', label: '卷王', icon: '🔥', desc: '卷是本能：提出的需求冲击 +30%，但每轮自然流失 3 点', dealMult: 1.3, bwDrain: 3 },
  { key: 'tool', label: '工具人', icon: '🔧', desc: '被需要的感觉挺好：每次被打攒 1 点摸鱼值', chargeOnHit: 1 },
  { key: 'godchild', label: '关系户', icon: '🤝', desc: '有人罩着：每轮开场回复 4 点带宽', roundHeal: 4 },
];

/* ==================================================================== 行业 */
const INDUSTRIES = [
  { key: 'internet', label: '互联网', icon: '🌐', color: '#3370ff',
    group: '交易中台 · 项目群', target: '需求池', boss: '甲方',
    events: [
      { id: 'ie1', text: '老板：我们要拥抱变化，快速试错', effect: '全员带宽 -8', apply: 'allBw:-8' },
      { id: 'ie2', text: '线上出了一个 P0 故障，全员回滚', effect: '全员带宽 -6，负载最高者额外 -8', apply: 'allBw:-6;topBw:-8' },
      { id: 'ie3', text: '双十一预热，流量提前打进来了', effect: '全员带宽 -7，计分类目标全员 +5 分', apply: 'allBw:-7;allKpi:5' },
    ] },

  { key: 'finance', label: '金融', icon: '🏦', color: '#d48806',
    group: '合规整改专班', target: '整改台账', boss: '监管',
    events: [
      { id: 'fi1', text: '监管下发新规，要求下周前完成自查', effect: '全员带宽 -9', apply: 'allBw:-9' },
      { id: 'fi2', text: '季末冲量，全员背指标', effect: '计分类目标全员 +6 分，全员带宽 -4', apply: 'allKpi:6;allBw:-4' },
      { id: 'fi3', text: '风控模型临时升级，部分业务暂停', effect: '负载最低者带宽 -14', apply: 'lowBw:-14' },
    ] },

  { key: 'medical', label: '医疗', icon: '🏥', color: '#0fc6c2',
    group: '门诊排班协调群', target: '待办病例', boss: '科室主任',
    events: [
      { id: 'me1', text: '门诊量激增，加开一个诊室', effect: '全员带宽 -8', apply: 'allBw:-8' },
      { id: 'me2', text: '三甲评审在即，全员补病历', effect: '全员带宽 -7，负载最高者额外 +6', apply: 'allBw:-7;topCost:6' },
      { id: 'me3', text: '完成一例疑难病例多学科会诊', effect: '全员带宽 +6', apply: 'allHeal:6' },
    ] },

  { key: 'manufacture', label: '制造', icon: '🏭', color: '#fa8c16',
    group: '产线攻关组', target: '待交付工单', boss: '客户经理',
    events: [
      { id: 'ma1', text: '原材料到货延迟，产线等料', effect: '全员带宽 -8', apply: 'allBw:-8' },
      { id: 'ma2', text: '良率抽检不达标，全线复检', effect: '全员带宽 -6，负载最高者额外 +8', apply: 'allBw:-6;topCost:8' },
      { id: 'ma3', text: '夜班赶工，产量超预期', effect: '全员带宽 +5，计分类目标 +4 分', apply: 'allHeal:5;allKpi:4' },
    ] },

  { key: 'education', label: '教育', icon: '🎓', color: '#52c41a',
    group: '教学教研群', target: '待备课量', boss: '教研组长',
    events: [
      { id: 'ed1', text: '临时接到公开课任务', effect: '全员带宽 -8', apply: 'allBw:-8' },
      { id: 'ed2', text: '期中考试临近，全组出卷', effect: '全员带宽 -6，负载最高者额外 +7', apply: 'allBw:-6;topCost:7' },
      { id: 'ed3', text: '学生竞赛拿了奖，全组沾光', effect: '全员带宽 +6', apply: 'allHeal:6' },
    ] },

  { key: 'media', label: '传媒', icon: '🎬', color: '#eb2f96',
    group: '内容排期群', target: '待交付内容', boss: '客户爸爸',
    events: [
      { id: 'md1', text: '客户临时改需求，明天就要新版本', effect: '全员带宽 -9', apply: 'allBw:-9' },
      { id: 'md2', text: '突发大事件，全组追热点', effect: '计分类目标全员 +7 分，全员带宽 -5', apply: 'allKpi:7;allBw:-5' },
      { id: 'md3', text: '一条内容爆了，甲方表扬', effect: '全员带宽 +6', apply: 'allHeal:6' },
    ] },
];

/* ==================================================================== 目标类型 */
const GOALS = [
  { key: 'battle', label: '末位优化', icon: '⚔️', kind: 'pvp', rounds: 12,
    desc: '互相甩锅加需求，撑到最后没被优化的人晋升', win: '最后存活者晋升' },
  { key: 'kpi', label: '绩效冲刺', icon: '📊', kind: 'pvp', rounds: 12, target: 100, passive: 9,
    desc: 'KPI 先攒到 100 即晋升，带宽归零同样出局', win: 'KPI 率先达到 100' },
  { key: 'okr', label: 'OKR 对齐', icon: '🎯', kind: 'pvp', rounds: 14, target: 100, passive: 9,
    desc: '每人认领一个 O；同一个 O 上人越多，推进越慢。完成度先到 100% 者胜', win: 'O 完成度率先达到 100%' },
  { key: 'deadline', label: '项目死线', icon: '⏰', kind: 'pvp', rounds: 10, target: 100,
    desc: '固定 10 轮交付窗口，到期按交付量评级；每 3 轮检查一次，掉队者被约谈', win: '死线到期时交付量最高' },
  { key: 'resolve', label: '项目攻坚', icon: '🏔️', kind: 'boss', rounds: 12, roundsSolo: 30, passive: 6,
    desc: '合力打空项目需求池。团队模式下只要有人被优化，整体失败；单人模式要连过三个项目关', win: '打空需求池即通关' },
];

const OKR_OBJECTIVES = [
  { key: 'o1', label: 'O1 · 提升用户留存', short: '留存' },
  { key: 'o2', label: 'O2 · 降低线上故障', short: '稳定性' },
  { key: 'o3', label: 'O3 · 拓展商业收入', short: '营收' },
  { key: 'o4', label: 'O4 · 优化研发效率', short: '效率' },
];

/* ==================================================================== 事件（通用 / 攻坚） */
const COMMON_EVENTS = [
  { id: 'c1', text: '老板：本季度我们要拥抱变化', effect: '全员带宽 -8', apply: 'allBw:-8' },
  { id: 'c2', text: '老板：要降本增效', effect: '全员带宽 -9', apply: 'allBw:-9' },
  { id: 'c3', text: '老板：这个同学最近产出不错', effect: '随机一人带宽 +12', apply: 'randHeal:12' },
  { id: 'c4', text: '老板：季度目标再上调一下', effect: '当前负载最高者带宽 -14', apply: 'topBw:-14' },
  { id: 'c5', text: '全员大会，会后就地摸鱼半小时', effect: '全员带宽 +5，摸鱼值 +1', apply: 'allHeal:5;allCharge:1' },
  { id: 'c6', text: '隔壁组在抢我们的资源，老板要个说法', effect: '负载最高者额外 +10', apply: 'topCost:10' },
];

const BOSS_EVENTS = [
  { id: 'b1', text: '甲方：需求范围临时扩大', effect: '需求池 +6', apply: 'bossHp:6' },
  { id: 'b2', text: '甲方：明天必须交付，压力给到你', effect: '需求池火力 +2', apply: 'bossAtk:2' },
  { id: 'b3', text: '项目达成一个里程碑', effect: '全员带宽 +8，需求池 -10', apply: 'allHeal:8;bossHp:-10' },
  { id: 'b4', text: '需求临时插单', effect: '需求池 +4，全员带宽 -4', apply: 'bossHp:4;allBw:-4' },
  { id: 'b5', text: '老板：这个同学最近产出不错', effect: '带宽 +12', apply: 'randHeal:12' },
];

/** 单人演练专用事件池：只作用于一个人，所以整体更温和 */
const SOLO_EVENTS = [
  { id: 's1', text: '甲方：需求范围临时扩大', effect: '需求池 +6', apply: 'bossHp:6' },
  { id: 's2', text: '项目达成一个里程碑', effect: '带宽 +10，需求池 -10', apply: 'allHeal:10;bossHp:-10' },
  { id: 's3', text: '老板：这个同学最近产出不错', effect: '带宽 +12', apply: 'randHeal:12' },
  { id: 's4', text: '需求临时插单', effect: '需求池 +4', apply: 'bossHp:4' },
  { id: 's5', text: '甲方：明天必须交付，压力给到你', effect: '甲方火力 +2', apply: 'bossAtk:2' },
  { id: 's6', text: '喝到一杯续命的咖啡', effect: '带宽 +8，摸鱼值 +1', apply: 'allHeal:8;allCharge:1' },
];

const BOSS_QUOTES = {
  internet: ['这个需求明天必须上线', '客户那边催得很紧，先做这个', '口径再对齐一下，我先要个结果', '时间不够就加加班，办法总比困难多'],
  finance: ['这个必须合规，一个口子都不能开', '监管那边要材料，今天下班前给我', '风险敞口要压降到零', '这套流程重走一遍'],
  medical: ['这个病人今天必须收进来', '病历书写规范再查一遍', '评审专家组下周就到', '床位周转率还要再提'],
  manufacture: ['这批货明天必须出', '良率再不达标就换供应商', '产线停一天损失多少你算过吗', '工单排期再压一压'],
  education: ['这堂课明天要上公开课', '教案今晚发我看看', '家长那边你得有个交代', '成绩再提一提'],
  media: ['客户明天就要成片', '这个热点今晚必须跟上', '改到客户满意为止', '档期不能挪'],
};

/* ==================================================================== 视图元信息 */
const INPUT_MODES = [
  { key: 'card', label: '卡牌模式', icon: '🃏', hint: '点需求模板选人，最直观' },
  { key: 'keyword', label: '关键词模式', icon: '🔖', hint: '打关键词，系统帮你匹配需求模板' },
  { key: 'free', label: '自由对话模式', icon: '💬', hint: '像聊天一样说人话，系统理解你的意图' },
  { key: 'hybrid', label: '混合协作', icon: '⌨️', hint: '需求模板和普通对话同时可用，每次任选一种' },
];

const FORMATS = [
  { key: 'solo', label: '个人演练', icon: '🎯', hint: '单人逐关完成项目，选择难度与关数' },
  { key: 'pvp', label: '全员竞逐', icon: '👥', hint: '大逃杀或个人目标竞赛，至少两人' },
  { key: 'duel', label: '双人对齐 · 1v1', icon: '↔️', hint: '两人独立竞争，可用虚拟同事补位' },
  { key: 'team', label: '小组竞标 · 3v3', icon: '🧩', hint: '红蓝两组竞争，团队累计目标进度' },
  { key: 'coop', label: '联合攻坚', icon: '🤝', hint: '全组共同完成目标，互相支援' },
];
const DIFFICULTIES = [
  { key: 'easy', label: '轻松', hp: 0.7, attack: 0.65, hint: '需求较少，压力较小，适合熟悉操作' },
  { key: 'normal', label: '标准', hp: 1, attack: 1, hint: '标准需求与压力，兼顾推进和恢复' },
  { key: 'hard', label: '进阶', hp: 1.25, attack: 1.3, hint: '更多需求，更高压力，需要规划冷却' },
  { key: 'expert', label: '挑战', hp: 1.5, attack: 1.6, hint: '高压项目，留意甲方点名与持续负担' },
];

const ROLE_ASSIGN = [
  { key: 'random', label: '随机分配', hint: '进场自动分职位，最省事' },
  { key: 'pick', label: '自己认领', hint: '每人进场后自己挑职位' },
];

const ORIGIN_MODES = [
  { key: 'random', label: '随机出身', hint: '嫡系、炮灰、空降……听天由命' },
  { key: 'off', label: '不带出身', hint: '纯拼技术，不加身世变量' },
];

const CHAT_PRESETS = [
  '这个需求很简单，顺手加一下',
  '我这边的排期已经满了，建议往后放',
  '先对齐一下口径，别各说各的',
  '这个我拉个会同步下',
  '辛苦了，注意休息',
  '明天上线，大家盯一下',
];

module.exports = {
  BASE_SKILLS, ULT_SKILL, ROLE_SKILLS, INDUSTRY_SKILLS,
  ROLES, ORIGINS, INDUSTRIES, GOALS, OKR_OBJECTIVES,
  COMMON_EVENTS, BOSS_EVENTS, SOLO_EVENTS, BOSS_QUOTES,
  INPUT_MODES, ROLE_ASSIGN, ORIGIN_MODES, CHAT_PRESETS, FORMATS, DIFFICULTIES,
};
