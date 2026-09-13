/**
 * 招标信息抽取测试（离线，用邮件夹具 + 真实库内客户数据）
 *
 * 覆盖：
 *   - 字段抽取：项目名称/编号/地区/金额（含万元换算）/单位/时间/公告类型/行业
 *   - 过滤：阀门关键词、只收新疆项目、外省项目排除
 *   - 红线：个人信息检测命中且**不出现在任何输出字段里**、摘要已剔除
 *   - 溯源：缺原文链接的邮件被丢弃
 *   - 匹配打分：与库内客户名称/设计院/最终用户匹配
 *   - 增量：内容指纹稳定性（同内容同指纹、字段变化即变化）
 *
 * 用法：node tools/test-collect-extract.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const mail = require(path.join(ROOT, 'server', 'collect', 'mail.js'));
const ex = require(path.join(ROOT, 'server', 'collect', 'extract.js'));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

const FIX = path.join(ROOT, '.fixtures', 'mail');
const read = (n) => mail.parseMail(fs.readFileSync(path.join(FIX, n)));

/* 模拟库内客户（含设计院与最终用户，用于匹配打分） */
const CUSTOMERS = [
  { id: 1, name: '中国石油天然气股份有限公司独山子石化分公司', short_name: '独山子石化', design_institute: '中石化工程建设公司', end_user: '独山子石化炼油厂', region_code: '650200' },
  { id: 2, name: '中国石化塔河炼化有限责任公司', short_name: '塔河炼化', design_institute: '中石化洛阳工程有限公司', end_user: '塔河炼化', region_code: '652900' },
  { id: 3, name: '新疆宜化化工有限公司', short_name: '新疆宜化', design_institute: '', end_user: '', region_code: '652300' },
  { id: 4, name: '新疆维吾尔自治区水利厅', short_name: '新疆水利厅', design_institute: '', end_user: '', region_code: '650100' }
];

console.log('=== 招标信息抽取测试 ===\n');

/* ---------- 1. 金额换算 ---------- */
{
  check('金额 · 万元 → 元', ex.toYuan('328.50', '万元') === 3285000, `${ex.toYuan('328.50', '万元')} 元`);
  check('金额 · 亿元 → 元', ex.toYuan('1.2', '亿元') === 120000000, `${ex.toYuan('1.2', '亿元')} 元`);
  check('金额 · 千分位逗号', ex.toYuan('1,568,000', '元') === 1568000, `${ex.toYuan('1,568,000', '元')} 元`);
  check('金额 · 非法输入返回 null', ex.toYuan('abc', '元') === null && ex.toYuan('0', '元') === null, '返回 null');
}

/* ---------- 2. 日期归一化 ---------- */
{
  check('日期 · 2026-03-25 10:30 → 2026-03-25', ex.normalizeDate('2026-03-25 10:30') === '2026-03-25', ex.normalizeDate('2026-03-25 10:30'));
  check('日期 · 2026年3月5日 → 2026-03-05', ex.normalizeDate('2026年3月5日') === '2026-03-05', ex.normalizeDate('2026年3月5日'));
  check('日期 · 非法输入返回空', ex.normalizeDate('另行通知') === '', '空字符串');
}

/* ---------- 3. 个人信息检测 ---------- */
{
  const p = read('04-with-personal-info.eml');
  const d = ex.detectPersonalInfo(p.text);
  check('个人信息检测 · 命中手机号/姓名/邮箱',
    d.has && d.fields.includes('手机号') && d.fields.includes('联系人姓名'),
    `命中类型：${d.fields.join('、')}`);
  check('个人信息检测 · 只记录类型不记录值（避免个人信息入库，对应验收标准 C3）',
    d.fields.every((f) => !/\d{5,}/.test(f)),
    `字段：${JSON.stringify(d.fields)}`);

  const clean = ex.detectPersonalInfo('招标人：某公司  项目编号：ABC-123');
  check('个人信息检测 · 无个人信息时不误报', clean.has === false, JSON.stringify(clean.fields));
}

/* ---------- 4. 新疆项目抽取（主力来源） ---------- */
{
  const p = read('01-xj-trade-gbk-html.eml');
  const r = ex.extractFromMail(p, { sourceName: '新疆公共资源交易网 · 邮件订阅', customers: CUSTOMERS });
  check('新疆项目 · 通过筛选', r.ok === true, r.ok ? '通过' : r.reason);
  const i = r.info || {};
  check('新疆项目 · 项目编号', i.project_code === 'E6500003901006789001', i.project_code);
  check('新疆项目 · 项目名称', /塔河炼化/.test(i.project_name) && /阀门/.test(i.project_name), i.project_name);
  check('新疆项目 · 地区归属到地州', i.region_code === '652900' && i.region_name === '阿克苏地区',
    `${i.region_code} ${i.region_name}`);
  check('新疆项目 · 金额 328.50 万元 → 3285000 元', i.amount === 3285000, `${i.amount} 元`);
  check('新疆项目 · 招标人', i.tenderee === '中国石化塔河炼化有限责任公司', i.tenderee);
  check('新疆项目 · 代理机构', i.agency === '新疆中油招标有限公司', i.agency);
  check('新疆项目 · 设计单位', /洛阳工程/.test(i.design_institute), i.design_institute);
  check('新疆项目 · 开标时间', i.bid_date === '2026-03-25', i.bid_date);
  check('新疆项目 · 公告类型', i.notice_type === '招标公告', i.notice_type);
  check('新疆项目 · 行业推断为石油', i.industry === '石油', i.industry);
  check('新疆项目 · 关键词命中', i.keyword_hits.includes('阀门') && i.keyword_hits.includes('球阀'),
    i.keyword_hits.join('、'));
  check('新疆项目 · 原文链接已记录', /^https:\/\//.test(i.source_url), i.source_url.slice(0, 60) + '…');
  check('新疆项目 · 客户匹配到塔河炼化',
    i.match.customer === '塔河炼化' && i.match.score >= 70,
    `${i.match.customer}（${i.match.score} 分：${i.match.reason}）`);
  check('新疆项目 · 摘要中不含个人信息字段',
    !/1[3-9]\d{9}/.test(i.raw_excerpt), `摘要 ${i.raw_excerpt.length} 字，无手机号`);
}

/* ---------- 5. 政府采购网 ---------- */
{
  const p = read('02-ccgp-plain.eml');
  const r = ex.extractFromMail(p, { sourceName: '中国政府采购网 · 邮件订阅', customers: CUSTOMERS });
  check('政采项目 · 通过筛选', r.ok === true, r.ok ? '通过' : r.reason);
  const i = r.info || {};
  check('政采项目 · 编号', i.project_code === 'XJSL-2026-GK-0087', i.project_code);
  check('政采项目 · 地区（乌鲁木齐）', i.region_code === '650100', `${i.region_code} ${i.region_name}`);
  check('政采项目 · 金额 1568000 元', i.amount === 1568000, `${i.amount} 元`);
  check('政采项目 · 招标人（水利厅）', i.tenderee === '新疆维吾尔自治区水利厅', i.tenderee);
  check('政采项目 · 客户匹配到水利厅', i.match.customer === '新疆水利厅', `${i.match.customer}（${i.match.score} 分）`);
  check('政采项目 · 检测到个人信息（该项目含联系人姓名与座机）',
    i.has_personal_info === true,
    `命中：${(i.personal_fields || []).join('、')}；界面应提示查看原文`);
  check('政采项目 · 摘要去掉了联系人行',
    !/阿依古丽/.test(i.raw_excerpt), '摘要无个人姓名');
}

/* ---------- 6. 地州摘要邮件（多条目但只取第一条） ---------- */
{
  const p = read('03-prefecture-digest.eml');
  const r = ex.extractFromMail(p, { sourceName: '各地州公共资源交易网 · 邮件订阅', customers: CUSTOMERS });
  check('地州摘要邮件 · 可抽取（取首条公告）', r.ok === true, r.ok ? '通过' : r.reason);
  const i = r.info || {};
  check('地州摘要邮件 · 地区为昌吉', i.region_code === '652300', `${i.region_code} ${i.region_name}`);
  check('地州摘要邮件 · 客户匹配到新疆宜化', i.match.customer === '新疆宜化', `${i.match.customer}（${i.match.score} 分）`);
}

/* ---------- 7. 过滤：与阀门无关 ---------- */
{
  const p = read('05-unrelated.eml');
  const r = ex.extractFromMail(p, { sourceName: 'x' });
  check('过滤 · 非阀门项目被排除', r.ok === false && /关键词/.test(r.reason), r.reason);
}

/* ---------- 8. 过滤：非新疆 ---------- */
{
  const p = read('06-other-province.eml');
  const r = ex.extractFromMail(p, { sourceName: 'x' });
  check('过滤 · 外省项目被排除（只要新疆）', r.ok === false && /新疆/.test(r.reason), r.reason);

  /* 关掉地区限制时应能通过 */
  const r2 = ex.extractFromMail(p, { sourceName: 'x', requireXinjiang: false });
  check('过滤 · 关闭地区限制后可通过（配置项生效）', r2.ok === true, r2.ok ? '通过' : r2.reason);
  check('过滤 · 外省项目不会误判为新疆', ex.isXinjiang(ex.pickRegion(p.text), p.text) === false,
    '正确识别为江苏项目');
}

/* ---------- 9. 过滤：缺原文链接 ---------- */
{
  const p = read('08-no-source-url.eml');
  const r = ex.extractFromMail(p, { sourceName: 'x' });
  check('红线 · 缺原文链接的公告被丢弃', r.ok === false && /来源|链接/.test(r.reason), r.reason);
}

/* ---------- 10. 匹配打分 ---------- */
{
  const p = read('07-match-customer.eml');
  const r = ex.extractFromMail(p, { sourceName: 'x', customers: CUSTOMERS });
  check('匹配 · 独山子石化项目命中客户与设计院',
    r.ok && r.info.match.customer === '独山子石化' && r.info.match.score >= 100,
    `${r.info.match.customer}（${r.info.match.score} 分：${r.info.match.reason}）`);

  const noMatch = ex.matchCustomer({ tenderee: '某某不知名公司', project_name: 'x' }, CUSTOMERS);
  check('匹配 · 无关联客户时不误匹配', noMatch.customer === '' && noMatch.score === 0,
    `得分 ${noMatch.score}`);
}

/* ---------- 11. 内容指纹（增量判定基础） ---------- */
{
  const p = read('01-xj-trade-gbk-html.eml');
  const a = ex.extractFromMail(p, { sourceName: 's', customers: CUSTOMERS }).info;
  const b = ex.extractFromMail(p, { sourceName: 's', customers: CUSTOMERS }).info;
  check('指纹 · 同一封邮件两次抽取指纹一致', ex.contentHash(a) === ex.contentHash(b),
    ex.contentHash(a));

  const changed = Object.assign({}, a, { amount: 9999999 });
  check('指纹 · 字段变化后指纹改变（触发更新）', ex.contentHash(a) !== ex.contentHash(changed),
    `${ex.contentHash(a)} → ${ex.contentHash(changed)}`);

  const changedRegion = Object.assign({}, a, { region_code: '650100' });
  check('指纹 · 地区变化也会改变指纹', ex.contentHash(a) !== ex.contentHash(changedRegion), '已变化');
}

/* ---------- 12. 去重键 ---------- */
{
  const p = read('01-xj-trade-gbk-html.eml');
  const i = ex.extractFromMail(p, { sourceName: 's', customers: CUSTOMERS }).info;
  check('去重键 · 优先用公告编号', ex.noticeKey(i) === 'code:E6500003901006789001', ex.noticeKey(i));

  const noCode = Object.assign({}, i, { project_code: '' });
  check('去重键 · 无编号时退化为来源链接', ex.noticeKey(noCode).startsWith('url:'), ex.noticeKey(noCode).slice(0, 40) + '…');
}

/* ---------- 13. 关键段落标签抽取稳健性 ---------- */
{
  const t1 = '招标控制价：人民币 328.50 万元\n招标人：某某公司';
  check('标签抽取 · 不把下一行标签粘进值里',
    ex.pickLabeled(t1, ['招标控制价']) === '人民币 328.50 万元',
    `得到「${ex.pickLabeled(t1, ['招标控制价'])}」`);

  const t2 = '预算金额: 1,568,000 元  采购需求: 蝶阀 40 台';
  const v = ex.pickLabeled(t2, ['预算金额']);
  check('标签抽取 · 半角冒号与逗号金额', /1,568,000/.test(v), `得到「${v}」`);
}

/* ---------- 14. 仅 HTML 正文的邮件（很多平台只发 HTML 版） ---------- */
{
  const boundary = '----=_OnlyHtml';
  const rawHtml = '<table>'
    + '<tr><td>项目编号：</td><td>HTML-ONLY-0001</td></tr>'
    + '<tr><td>项目名称：</td><td>某地阀门采购项目</td></tr>'
    + '<tr><td>所在地区：</td><td>新疆维吾尔自治区喀什地区</td></tr>'
    + '<tr><td>招标控制价：</td><td>86.5 万元</td></tr>'
    + '<tr><td>招标人：</td><td>喀什某水务公司</td></tr>'
    + '<tr><td>采购内容：</td><td>蝶阀、闸阀共 20 台</td></tr>'
    + '</table><p>原文：<a href="https://ggzy.xinjiang.gov.cn/n/20260312/htm001.html">链接</a></p>';
  const eml = Buffer.from(
    'From: x <a@b.com>\r\nSubject: HTML 版公告\r\nMIME-Version: 1.0\r\n'
    + `Content-Type: multipart/related; boundary="${boundary}"\r\n\r\n`
    + `--${boundary}\r\n`
    + 'Content-Type: text/html; charset="utf-8"\r\n'
    + 'Content-Transfer-Encoding: base64\r\n\r\n'
    + Buffer.from(rawHtml, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n')
    + '\r\n'
    + `--${boundary}--\r\n`, 'utf8');

  const parsed = mail.parseMail(eml);
  const r = ex.extractFromMail(parsed, { sourceName: 'html-only' });
  check('仅 HTML 正文 · 端到端可抽取（HTML→文本→字段）', r.ok === true, r.ok ? '通过' : r.reason);
  if (r.ok) {
    check('仅 HTML 正文 · 表格字段全部抽到',
      r.info.project_code === 'HTML-ONLY-0001'
      && r.info.region_code === '653100'
      && r.info.amount === 865000
      && r.info.tenderee === '喀什某水务公司',
      `编号=${r.info.project_code} 地区=${r.info.region_name} 金额=${r.info.amount} 招标人=${r.info.tenderee}`);
    check('仅 HTML 正文 · 关键词命中蝶阀/闸阀',
      r.info.keyword_hits.includes('蝶阀') && r.info.keyword_hits.includes('闸阀'),
      r.info.keyword_hits.join('、'));
  } else {
    check('仅 HTML 正文 · 表格字段全部抽到', false, '抽取被拒，无法继续断言');
    check('仅 HTML 正文 · 关键词命中蝶阀/闸阀', false, '抽取被拒');
  }
}

/* ---------- 汇总 ---------- */
const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
if (fail) {
  console.log('\n失败项：');
  for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
}
fs.writeFileSync(
  path.join(ROOT, '.fixtures', 'collect-extract-result.json'),
  JSON.stringify({ pass, fail, total: results.length, results }, null, 2),
  'utf8'
);
process.exit(fail ? 1 : 0);
