/**
 * MIME 解析测试（零依赖，纯本地，不需要网络与邮箱）
 *
 * 覆盖：
 *   - RFC 2047 编码主题（UTF-8 / GBK、B / Q 两种编码）
 *   - multipart/alternative 递归与正文优先级
 *   - base64 / quoted-printable / 8bit 传输编码
 *   - GBK 正文解码（手工构造真实 GBK 字节）
 *   - HTML 正文转纯文本（表格 → "标签：值" 可抽取）
 *   - 链接抽取、地址抽取
 *   - 折行头字段
 *
 * 用法：node tools/test-collect-mail.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const mail = require(path.join(ROOT, 'server', 'collect', 'mail.js'));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

const FIX = path.join(ROOT, '.fixtures', 'mail');
const readFix = (n) => fs.readFileSync(path.join(FIX, n));

console.log('=== MIME 解析测试 ===\n');

/* ---------- 1. 编码字解码 ---------- */
{
  const r1 = mail.decodeEncodedWords('=?UTF-8?B?5oub5qCH5YWs5ZGK?=');
  check('RFC2047 · UTF-8 / Base64 解码', r1 === '招标公告', `得到「${r1}」`);

  const r2 = mail.decodeEncodedWords('=?utf-8?Q?=E9=98=80=E9=97=A8=E9=87=87=E8=B4=AD?=');
  check('RFC2047 · UTF-8 / Q 编码解码', r2 === '阀门采购', `得到「${r2}」`);

  /* GBK：'阀门' 的 GBK 字节为 B7 A7 C3 C5 */
  const gbkWord = '=?GBK?B?' + Buffer.from([0xB7, 0xA7, 0xC3, 0xC5]).toString('base64') + '?=';
  const r3 = mail.decodeEncodedWords(gbkWord);
  check('RFC2047 · GBK 编码字解码', r3 === '阀门', `得到「${r3}」`);

  const r4 = mail.decodeEncodedWords('【招标】=?UTF-8?B?5oub5qCH?= 通知');
  check('RFC2047 · 普通文本与编码字混排', r4.includes('招标') && r4.includes('通知'), `得到「${r4}」`);

  const r5 = mail.decodeEncodedWords('plain subject');
  check('无编码字时原样返回', r5 === 'plain subject', `得到「${r5}」`);
}

/* ---------- 2. quote-printable ---------- */
{
  const buf = Buffer.from('=E9=98=80=E9=97=A8=3D=E6=B5=8B=E8=AF=95=\r\n=E7=BB=AD=E8=A1=8C', 'latin1');
  const out = mail.decodeQP(buf).toString('utf8');
  check('quoted-printable · 十六进制与软换行', out === '阀门=测试续行', `得到「${out}」`);
}

/* ---------- 3. GBK 正文解码（手工构造） ---------- */
{
  /* '新疆阀门采购公告' 的 GBK 字节 */
  const gbkBytes = Buffer.from([
    0xD0, 0xC2, 0xBD, 0xAE, 0xB7, 0xA7, 0xC3, 0xC5, 0xB2, 0xC9, 0xB9, 0xBA, 0xB9, 0xAB, 0xB8, 0xE6
  ]);
  const eml = Buffer.concat([
    Buffer.from('From: a@b.com\r\nSubject: test\r\nContent-Type: text/plain; charset="gbk"\r\n\r\n', 'latin1'),
    gbkBytes
  ]);
  const parsed = mail.parseMail(eml);
  check('GBK 正文按 charset 声明正确解码', parsed.text === '新疆阀门采购公告', `得到「${parsed.text}」`);

  /* 声明 utf-8 但实际是 GBK 的常见情况：应自动回退 */
  const eml2 = Buffer.concat([
    Buffer.from('From: a@b.com\r\nContent-Type: text/plain; charset="utf-8"\r\n\r\n', 'latin1'),
    gbkBytes
  ]);
  const parsed2 = mail.parseMail(eml2);
  check('声明 utf-8 实际 GBK 时自动回退解码', parsed2.text === '新疆阀门采购公告', `得到「${parsed2.text}」`);
}

/* ---------- 4. 头字段折行 ---------- */
{
  const eml = 'From: a@b.com\r\nSubject: this is a\r\n very long subject\r\nContent-Type: text/plain\r\n\r\nbody';
  const p = mail.parseMail(eml);
  check('头字段折行被合并', p.subject === 'this is a very long subject', `得到「${p.subject}」`);
}

/* ---------- 5. HTML 转文本 ---------- */
{
  const html = '<table><tr><td>项目编号：</td><td>E650001</td></tr>'
    + '<tr><td>招标人：</td><td>新疆某公司</td></tr></table>'
    + '<p>原文：<a href="https://x.gov.cn/a.html">链接</a></p>';
  const txt = mail.htmlToText(html);
  check('HTML 表格转为可抽取的「标签：值」文本',
    txt.includes('项目编号：') && txt.includes('E650001')
    && txt.includes('招标人：') && txt.includes('新疆某公司'),
    txt.replace(/\s+/g, ' ').slice(0, 90));

  const entities = mail.htmlToText('<p>A&amp;B&nbsp;&lt;x&gt;&#65;</p>');
  check('HTML 实体还原正确', entities === 'A&B <x>A', `得到「${entities}」`);
}

/* ---------- 6. 真实夹具：multipart/alternative + base64 ---------- */
{
  const p = mail.parseMail(readFix('01-xj-trade-gbk-html.eml'));
  check('夹具1 · 编码主题解码', p.subject.includes('招标公告') && p.subject.includes('塔河炼化'),
    `主题「${p.subject}」`);
  check('夹具1 · multipart 两个正文都解析出来',
    p.bodies.filter((b) => b.type === 'text/plain').length === 1
    && p.bodies.filter((b) => b.type === 'text/html').length === 1,
    `正文部分 ${p.bodies.length} 个：${p.bodies.map((b) => b.type).join(', ')}`);
  check('夹具1 · 正文含关键字段（utf8 声明下的中文）',
    p.text.includes('塔河炼化') && p.text.includes('E6500003901006789001'),
    `正文字数 ${p.text.length}`);
  check('夹具1 · 抽到原文链接',
    p.links.some((u) => u.includes('ggzy.xinjiang.gov.cn') && u.endsWith('.html')),
    p.links[0] || '（无）');
  check('夹具1 · 发件人地址抽取',
    mail.parseAddress(p.from) === 'noreply@ggzy.xinjiang.gov.cn',
    mail.parseAddress(p.from));
}

/* ---------- 7. 真实夹具：quoted-printable 与 base64 ---------- */
{
  const p2 = mail.parseMail(readFix('02-ccgp-plain.eml'));
  check('夹具2 · 8bit 纯文本正文', p2.text.includes('预算金额：1568000'), p2.text.slice(0, 40).replace(/\n/g, ' '));

  const p3 = mail.parseMail(readFix('03-prefecture-digest.eml'));
  check('夹具3 · base64 正文解码', p3.text.includes('昌吉') && p3.text.includes('新疆宜化'),
    p3.text.slice(0, 46).replace(/\n/g, ' '));
  check('夹具3 · 摘要邮件抽到 2 条链接', p3.links.length === 2, `抽到 ${p3.links.length} 条`);
}

/* ---------- 8. 其它夹具可解析性 ---------- */
{
  const names = ['04-with-personal-info.eml', '05-unrelated.eml',
    '06-other-province.eml', '07-match-customer.eml', '08-no-source-url.eml'];
  let ok = 0;
  const bad = [];
  for (const n of names) {
    const p = mail.parseMail(readFix(n));
    if (p.text.length > 30 && p.subject) ok++;
    else bad.push(n);
  }
  check('其余 5 个夹具均可解析出主题与正文', ok === names.length, bad.length ? `异常：${bad.join(', ')}` : `${ok}/${names.length}`);

  const p8 = mail.parseMail(readFix('08-no-source-url.eml'));
  check('无原文链接的邮件确实没有链接（用于验证"缺来源即丢弃"）',
    p8.links.length === 0, `链接数 ${p8.links.length}`);
}

/* ---------- 9. 健壮性 ---------- */
{
  const empty = mail.parseMail('');
  check('空输入不抛错', empty && empty.text === '' && empty.bodies.length === 0, '返回空结构');

  const garbage = mail.parseMail(Buffer.from([0x00, 0xFF, 0x12, 0x34, 0x0A, 0x0A, 0x41]));
  check('二进制垃圾输入不抛错', !!garbage, `正文「${garbage.text}」`);

  const noBody = mail.parseMail('From: a@b.com\r\nSubject: x\r\n');
  check('只有头没有正文时不抛错', noBody.text === '' && noBody.subject === 'x', '正常返回');

  /* 深递归保护 */
  let nested = 'Content-Type: text/plain\r\n\r\nhi';
  for (let i = 0; i < 12; i++) {
    const b = 'B' + i;
    nested = `Content-Type: multipart/mixed; boundary="${b}"\r\n\r\n--${b}\r\n${nested}\r\n--${b}--`;
  }
  let deep = null;
  try { deep = mail.parseMail('Subject: deep\r\n' + nested); } catch (e) { deep = { err: e.message }; }
  check('超深 multipart 嵌套不栈溢出', deep && !deep.err, deep && deep.err ? deep.err : '安全返回');
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
  path.join(ROOT, '.fixtures', 'collect-mail-result.json'),
  JSON.stringify({ pass, fail, total: results.length, results }, null, 2),
  'utf8'
);
process.exit(fail ? 1 : 0);
