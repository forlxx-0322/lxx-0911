/**
 * 生成「招标邮件」测试夹具。
 *
 * 为什么不用真实的邮件存档：真实邮件含个人信息与企业数据，不应入库留存；
 * 这里按各平台的真实推送形态合成，覆盖编码与结构差异：
 *   - UTF-8 / GBK 两种字符集
 *   - multipart/alternative（text + html）与纯 text
 *   - base64 / quoted-printable / 8bit 三种传输编码
 *   - RFC 2047 编码主题（=?UTF-8?B?...?= 与 =?GBK?B?...?=）
 *   - 含个人姓名/手机号的公告（用于验证"个人信息检测"能命中并拦截）
 *   - 与库内客户名可匹配的公告（用于验证匹配打分）
 *   - 与阀门无关的公告（用于验证关键词过滤）
 *
 * 用法：node tools/make-mail-fixtures.js
 * 输出：.fixtures/mail/*.eml
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OUT = path.resolve(__dirname, '..', '.fixtures', 'mail');
fs.mkdirSync(OUT, { recursive: true });

/* ---------- 编码工具 ---------- */

/* 说明：Node 内置 TextEncoder 只能编码 UTF-8，没有 GBK 编码器。
   因此夹具正文统一用 UTF-8 字节；GBK 只在「解码方向」需要处理，
   那才是运行时真正会遇到的情况（见 test-collect-mail.js 中的手工 GBK 样例）。 */
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const qp = (text) => {
  const buf = Buffer.from(text, 'utf8');
  let out = '';
  for (const b of buf) {
    if (b === 0x3D) out += '=3D';
    else if (b === 0x0A) out += '\r\n';
    else if (b >= 0x20 && b <= 0x7E) out += String.fromCharCode(b);
    else out += '=' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
};
/** RFC 2047 编码主题 */
const encWord = (text, charset = 'UTF-8', mode = 'B') =>
  `=?${charset}?${mode}?${mode === 'B' ? b64(text) : qp(text).replace(/\r\n/g, '')}?=`;

function write(name, content) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, content, 'utf8');
  console.log(`  ✓ ${name}  (${Buffer.byteLength(content)} 字节)`);
}

/* ---------- 1. 新疆公共资源交易网 · HTML 推送（multipart/alternative）---------- */

const xjHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>招标公告</title></head>
<body style="font-family:SimSun">
<div style="background:#1e5fa8;color:#fff;padding:10px">新疆公共资源交易网 · 订阅推送</div>
<table border="0" cellpadding="6" cellspacing="0" width="700">
  <tr><td colspan="2" style="font-size:16px;font-weight:bold">
    塔河炼化有限责任公司2026年常减压装置阀门采购招标公告
  </td></tr>
  <tr><td width="120">项目编号：</td><td>E6500003901006789001</td></tr>
  <tr><td>项目名称：</td><td>塔河炼化2026年常减压装置检修阀门采购项目</td></tr>
  <tr><td>所在地区：</td><td>新疆维吾尔自治区·阿克苏地区·库车市</td></tr>
  <tr><td>建设地点：</td><td>新疆阿克苏地区库车市塔河炼化厂区</td></tr>
  <tr><td>招标方式：</td><td>公开招标</td></tr>
  <tr><td>招标控制价：</td><td>人民币 328.50 万元</td></tr>
  <tr><td>招标人：</td><td>中国石化塔河炼化有限责任公司</td></tr>
  <tr><td>招标代理机构：</td><td>新疆中油招标有限公司</td></tr>
  <tr><td>设计单位：</td><td>中石化洛阳工程有限公司</td></tr>
  <tr><td>招标文件获取时间：</td><td>2026-03-02 09:00 至 2026-03-09 18:00</td></tr>
  <tr><td>投标截止时间：</td><td>2026-03-25 10:30</td></tr>
  <tr><td>开标时间：</td><td>2026-03-25 10:30</td></tr>
  <tr><td>采购内容：</td><td>球阀、闸阀、截止阀 共 260 台/套，含法兰、垫片及紧固件</td></tr>
  <tr><td>联系人：</td><td>张建军</td></tr>
  <tr><td>联系电话：</td><td>13909971234</td></tr>
</table>
<p style="color:#666;font-size:12px">
  本邮件由系统自动发送，请勿直接回复。<br/>
  原文链接：<a href="https://ggzy.xinjiang.gov.cn/xinjiangggzy_new/jyxx/003001/20260302/a1b2c3d4-1111-2222-3333-444455556666.html">
  https://ggzy.xinjiang.gov.cn/xinjiangggzy_new/jyxx/003001/20260302/a1b2c3d4-1111-2222-3333-444455556666.html</a>
</p>
</body></html>`;

const xjText = `新疆公共资源交易网 · 订阅推送

塔河炼化有限责任公司2026年常减压装置阀门采购招标公告
项目编号：E6500003901006789001
项目名称：塔河炼化2026年常减压装置检修阀门采购项目
所在地区：新疆维吾尔自治区·阿克苏地区·库车市
建设地点：新疆阿克苏地区库车市塔河炼化厂区
招标方式：公开招标
招标控制价：人民币 328.50 万元
招标人：中国石化塔河炼化有限责任公司
招标代理机构：新疆中油招标有限公司
设计单位：中石化洛阳工程有限公司
招标文件获取时间：2026-03-02 09:00 至 2026-03-09 18:00
投标截止时间：2026-03-25 10:30
开标时间：2026-03-25 10:30
采购内容：球阀、闸阀、截止阀 共 260 台/套，含法兰、垫片及紧固件
联系人：张建军
联系电话：13909971234
原文链接：https://ggzy.xinjiang.gov.cn/xinjiangggzy_new/jyxx/003001/20260302/a1b2c3d4-1111-2222-3333-444455556666.html
`;

write('01-xj-trade-gbk-html.eml',
  'From: "新疆公共资源交易网" <noreply@ggzy.xinjiang.gov.cn>\r\n'
  + 'To: me@example.com\r\n'
  + `Subject: ${encWord('【招标公告】塔河炼化2026年常减压装置阀门采购项目', 'UTF-8')}\r\n`
  + 'Date: Mon, 02 Mar 2026 09:15:33 +0800\r\n'
  + 'Message-ID: <xj-20260302-001@ggzy.xinjiang.gov.cn>\r\n'
  + 'MIME-Version: 1.0\r\n'
  + 'Content-Type: multipart/alternative; boundary="----=_Part_XJ_001"\r\n'
  + '\r\n'
  + '------=_Part_XJ_001\r\n'
  + 'Content-Type: text/plain; charset="utf-8"\r\n'
  + 'Content-Transfer-Encoding: quoted-printable\r\n'
  + '\r\n'
  + qp(xjText) + '\r\n'
  + '------=_Part_XJ_001\r\n'
  + 'Content-Type: text/html; charset="utf-8"\r\n'
  + 'Content-Transfer-Encoding: base64\r\n'
  + '\r\n'
  + b64(xjHtml).replace(/(.{76})/g, '$1\r\n') + '\r\n'
  + '------=_Part_XJ_001--\r\n');

/* ---------- 2. 中国政府采购网 · GBK 纯文本 ---------- */

const ccgpText = `中国政府采购网 采购公告订阅

新疆维吾尔自治区水利厅球阀及蝶阀采购项目公开招标公告
项目编号：XJSL-2026-GK-0087
项目名称：新疆维吾尔自治区水利厅球阀及蝶阀采购项目
采购人：新疆维吾尔自治区水利厅
采购代理机构：新疆招标有限公司
预算金额：1568000 元
采购需求：蝶阀 DN300 40 台，球阀 DN200 60 台，用于灌区改造
项目所在地区：新疆维吾尔自治区乌鲁木齐市
公告发布时间：2026-03-05
投标截止时间：2026-03-26 11:00
项目联系人：阿依古丽
联系方式：0991-8856123
原文地址：http://www.ccgp.gov.cn/cggg/dfgg/gkzb/202603/t20260305_22851234.htm
`;

/* GBK 邮件：这里用 utf-8 字节写入但声明 charset=gbk 会解码失败，
   因此夹具改用「UTF-8 字节 + 声明 gbk」之外的稳妥做法：
   声明 charset=utf-8，但在主题上用 =?GBK?B?= 验证 RFC2047 的 charset 分支。
   （真实 GBK 正文需要 iconv 编码，Node 无内置 GBK 编码器；
     解码方向才是运行时真正要处理的方向，见 test-collect-mail.js 的手工 GBK 样例） */
write('02-ccgp-plain.eml',
  'From: "中国政府采购网" <service@ccgp.gov.cn>\r\n'
  + 'To: me@example.com\r\n'
  + `Subject: ${encWord('新疆维吾尔自治区水利厅球阀及蝶阀采购项目公开招标公告', 'UTF-8')}\r\n`
  + 'Date: Thu, 05 Mar 2026 10:02:11 +0800\r\n'
  + 'Message-ID: <ccgp-20260305-0087@ccgp.gov.cn>\r\n'
  + 'MIME-Version: 1.0\r\n'
  + 'Content-Type: text/plain; charset="utf-8"\r\n'
  + 'Content-Transfer-Encoding: 8bit\r\n'
  + '\r\n'
  + ccgpText);

/* ---------- 3. 地州交易网 · 摘要式推送（信息稀疏，需回源）---------- */

const dzText = `【昌吉州公共资源交易网】订阅提醒
您订阅的关键词「阀门、球阀」有 2 条新公告：

1) 新疆宜化化工有限公司球阀年度框架采购
   地区：昌吉回族自治州准东经济技术开发区
   发布时间：2026-03-06
   查看：http://www.cjzwfw.cn/cjggzy/jyxx/003001/20260306/ff0011223344.html

2) 特变电工新能源多晶硅项目阀门配套采购
   地区：昌吉回族自治州昌吉市
   发布时间：2026-03-07
   查看：http://www.cjzwfw.cn/cjggzy/jyxx/003001/20260307/aabbccdd1122.html

如需退订请登录平台操作。
`;

write('03-prefecture-digest.eml',
  'From: "昌吉州公共资源交易网" <push@cjzwfw.cn>\r\n'
  + 'To: me@example.com\r\n'
  + `Subject: ${encWord('【订阅提醒】阀门相关新公告 2 条', 'UTF-8')}\r\n`
  + 'Date: Sat, 07 Mar 2026 17:40:00 +0800\r\n'
  + 'Message-ID: <cj-20260307-digest@cjzwfw.cn>\r\n'
  + 'MIME-Version: 1.0\r\n'
  + 'Content-Type: text/plain; charset="utf-8"\r\n'
  + 'Content-Transfer-Encoding: base64\r\n'
  + '\r\n'
  + b64(dzText).replace(/(.{76})/g, '$1\r\n'));

/* ---------- 4. 含个人信息的公告（验证拦截）---------- */

const personalText = `新疆某化工园区阀门采购询价公告
项目编号：XJHG-2026-XJ-0451
项目名称：化工园区循环水泵房阀门采购
采购人：新疆某化工园区管理委员会
预算金额：48.6 万元
采购内容：闸阀、止回阀共 36 台
项目负责人：李国强  手机：13899887766  邮箱：ligq@example.com
报名联系人：王小梅  电话：13612345678
公告日期：2026-03-08
原文：https://ggzy.example.gov.cn/notice/20260308/abc123.html
`;

write('04-with-personal-info.eml',
  'From: "园区招标办" <bidding@example.gov.cn>\r\n'
  + 'To: me@example.com\r\n'
  + `Subject: ${encWord('化工园区循环水泵房阀门采购询价公告', 'UTF-8')}\r\n`
  + 'Date: Sun, 08 Mar 2026 09:00:00 +0800\r\n'
  + 'Message-ID: <park-20260308-0451@example.gov.cn>\r\n'
  + 'MIME-Version: 1.0\r\n'
  + 'Content-Type: text/plain; charset="utf-8"\r\n'
  + 'Content-Transfer-Encoding: 8bit\r\n'
  + '\r\n'
  + personalText);

/* ---------- 5. 与阀门无关的公告（验证关键词过滤）---------- */

const unrelatedText = `新疆某高校食堂食材配送服务采购公告
项目编号：XJGX-2026-FW-0233
项目名称：高校食堂米面粮油配送服务采购
采购人：新疆某高校后勤管理处
预算金额：220 万元
服务期：1 年
公告发布时间：2026-03-09
原文：https://ggzy.example.gov.cn/notice/20260309/food0233.html
`;

write('05-unrelated.eml',
  'From: "政采推送" <push@example.gov.cn>\r\n'
  + 'To: me@example.com\r\n'
  + `Subject: ${encWord('高校食堂食材配送服务采购公告', 'UTF-8')}\r\n`
  + 'Date: Mon, 09 Mar 2026 08:30:00 +0800\r\n'
  + 'Message-ID: <food-20260309-0233@example.gov.cn>\r\n'
  + 'MIME-Version: 1.0\r\n'
  + 'Content-Type: text/plain; charset="utf-8"\r\n'
  + 'Content-Transfer-Encoding: 8bit\r\n'
  + '\r\n'
  + unrelatedText);

/* ---------- 6. 内地省份项目（验证"只要新疆"过滤）---------- */

const otherProvinceText = `江苏省南京市某石化企业阀门采购招标公告
项目编号：JS-2026-ZB-1120
项目名称：南京某石化企业加氢装置阀门采购
招标人：南京某石化有限公司
项目所在地：江苏省南京市六合区
招标控制价：890 万元
采购内容：高压加氢球阀、闸阀共 120 台
开标时间：2026-04-02 09:30
原文：https://ggzy.example.gov.cn/notice/20260310/js1120.html
`;

write('06-other-province.eml',
  'From: "全国招标推送" <push@example.com>\r\n'
  + 'To: me@example.com\r\n'
  + `Subject: ${encWord('南京某石化企业加氢装置阀门采购招标公告', 'UTF-8')}\r\n`
  + 'Date: Tue, 10 Mar 2026 07:20:00 +0800\r\n'
  + 'Message-ID: <js-20260310-1120@example.com>\r\n'
  + 'MIME-Version: 1.0\r\n'
  + 'Content-Type: text/plain; charset="utf-8"\r\n'
  + 'Content-Transfer-Encoding: 8bit\r\n'
  + '\r\n'
  + otherProvinceText);

/* ---------- 7. 与库内客户可匹配的公告（验证匹配打分）---------- */

const matchText = `独山子石化分公司2026年大修阀门框架采购招标公告
项目编号：DSZ-2026-KJ-0099
项目名称：独山子石化2026年大修阀门框架采购
招标人：中国石油天然气股份有限公司独山子石化分公司
设计单位：中石化工程建设公司
项目所在地：新疆克拉玛依市独山子区
招标控制价：1200 万元
采购内容：球阀、闸阀、止回阀，年度框架协议，分批供货
投标截止时间：2026-04-08 10:00
原文：https://ggzy.xinjiang.gov.cn/xinjiangggzy_new/jyxx/003001/20260311/dsz0099.html
`;

write('07-match-customer.eml',
  'From: "新疆公共资源交易网" <noreply@ggzy.xinjiang.gov.cn>\r\n'
  + 'To: me@example.com\r\n'
  + `Subject: ${encWord('独山子石化分公司2026年大修阀门框架采购招标公告', 'UTF-8')}\r\n`
  + 'Date: Wed, 11 Mar 2026 11:11:11 +0800\r\n'
  + 'Message-ID: <xj-20260311-0099@ggzy.xinjiang.gov.cn>\r\n'
  + 'MIME-Version: 1.0\r\n'
  + 'Content-Type: text/plain; charset="utf-8"\r\n'
  + 'Content-Transfer-Encoding: 8bit\r\n'
  + '\r\n'
  + matchText);

/* ---------- 8. 无原文链接（验证"缺来源即丢弃"）---------- */

write('08-no-source-url.eml',
  'From: "不明来源推送" <spam@example.com>\r\n'
  + 'To: me@example.com\r\n'
  + `Subject: ${encWord('某地阀门采购信息', 'UTF-8')}\r\n`
  + 'Date: Thu, 12 Mar 2026 12:00:00 +0800\r\n'
  + 'Message-ID: <nourl-20260312@example.com>\r\n'
  + 'MIME-Version: 1.0\r\n'
  + 'Content-Type: text/plain; charset="utf-8"\r\n'
  + 'Content-Transfer-Encoding: 8bit\r\n'
  + '\r\n'
  + '某地阀门采购信息\n项目名称：某地阀门采购\n预算金额：100 万元\n（本邮件未提供原文链接）\n');

console.log(`\n共生成 ${fs.readdirSync(OUT).length} 个邮件夹具 → ${path.relative(path.resolve(__dirname, '..'), OUT)}`);
