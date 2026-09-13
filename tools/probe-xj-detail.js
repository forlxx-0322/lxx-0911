/**
 * 验证新疆公共资源交易网「列表页 + 详情页」的实际可取字段。
 * 这是采集可行性的决定性验证：能否稳定拿到 项目名称/金额/单位/时间/公告编号。
 *
 * 用法：node tools/probe-xj-detail.js
 */
'use strict';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const BASE = 'https://ggzy.xinjiang.gov.cn';
const TIMEOUT = 18000;

async function get(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      redirect: 'follow'
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, type: res.headers.get('content-type') || '', buf, text: buf.toString('utf8') };
  } catch (e) {
    return { status: 0, error: e.name === 'AbortError' ? '超时' : e.message };
  } finally { clearTimeout(timer); }
}

function decode(buf, type) {
  /* 站点可能是 UTF-8 或 GBK；先按 UTF-8 试，出现大量替换字符再按 GBK 解 */
  const utf8 = buf.toString('utf8');
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (bad > 5) {
    try { return new TextDecoder('gbk').decode(buf); } catch (_) { return utf8; }
  }
  return utf8;
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** 从列表页抽出条目 */
function parseList(html, base) {
  const items = [];
  /* 该站列表通常是 <li><a href="...">标题</a><span>日期</span></li> */
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(html))) {
    const chunk = m[1];
    const a = chunk.match(/<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const title = stripTags(a[2]).replace(/\s+/g, ' ').trim();
    if (!title || title.length < 6) continue;
    const date = (stripTags(chunk).match(/(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})/) || []).join('');
    let url = a[1];
    try { url = new URL(url, base).href; } catch (_) { continue; }
    items.push({ title, url, date });
  }
  return items;
}

(async () => {
  console.log('=== 列表页验证 ===\n');

  const LISTS = [
    ['交易公告(025002)', '/xinjiangggzy_new/xxzx/025002/infolist.html'],
    ['澄清/答疑(025004)', '/xinjiangggzy_new/xxzx/025004/infolist.html'],
    ['中心动态(025001)', '/xinjiangggzy_new/xxzx/025001/infolist.html']
  ];

  const found = [];
  for (const [name, path] of LISTS) {
    const r = await get(BASE + path);
    if (r.status !== 200) { console.log(`${name}: HTTP ${r.status} ${r.error || ''}`); continue; }
    const html = decode(r.buf, r.type);
    const items = parseList(html, BASE + path);
    console.log(`${name}: HTTP 200，解析出 ${items.length} 条`);
    for (const it of items.slice(0, 6)) {
      console.log(`   [${it.date || '无日期'}] ${it.title.slice(0, 46)}`);
      console.log(`        ${it.url}`);
    }
    /* 是否含分页/接口线索 */
    const pager = /(下一页|totalPage|pageCount|createPageHTML|\.json)/i.test(html);
    console.log(`   分页或接口线索：${pager}`);
    console.log('');
    if (items.length) found.push(...items.slice(0, 2));
    await new Promise((s) => setTimeout(s, 1500));
  }

  if (!found.length) { console.log('未解析到条目，需换解析策略。'); return; }

  console.log('=== 详情页字段验证 ===\n');
  for (const it of found.slice(0, 3)) {
    const r = await get(it.url);
    if (r.status !== 200) { console.log(`HTTP ${r.status}  ${it.url}`); continue; }
    const html = decode(r.buf, r.type);
    const text = stripTags(html);

    console.log('── ' + it.title.slice(0, 50));
    console.log('   URL：' + it.url);
    console.log('   长度：' + text.length + ' 字符');

    /* 提取本工具关心的字段 */
    const grab = (re) => { const m = text.match(re); return m ? (m[1] || m[0]).replace(/\s+/g, ' ').trim().slice(0, 60) : ''; };
    const fields = {
      公告编号: grab(/(?:招标编号|项目编号|公告编号|标段编号|采购编号|招标项目编号)\s*[:：]?\s*([^\s，。;；]{4,40})/),
      项目名称: grab(/(?:项目名称|工程名称|招标项目名称)\s*[:：]?\s*([^\n]{4,60})/),
      招标人: grab(/(?:招标人|采购人|建设单位|招标单位)\s*[:：]?\s*([^\n]{2,40})/),
      代理机构: grab(/(?:招标代理机构|代理机构|采购代理机构)\s*[:：]?\s*([^\n]{2,40})/),
      金额: grab(/(?:招标控制价|最高限价|预算金额|合同估算价|项目总投资|投资额|资金来源)[^\n]{0,40}/),
      地点: grab(/(?:建设地点|项目地点|工程地点|交货地点|实施地点)\s*[:：]?\s*([^\n]{2,40})/),
      时间: grab(/(?:招标文件获取|投标截止时间|开标时间|递交截止时间|公告发布)[^\n]{0,40}/)
    };
    for (const [k, v] of Object.entries(fields)) {
      console.log(`   ${k}：${v ? v : '（未取到）'}`);
    }
    /* 个人信息检测：验证"不采集个人联系方式"是否可自动识别 */
    const phones = text.match(/1[3-9]\d{9}/g) || [];
    const contacts = text.match(/(?:联系人|项目负责人|项目经理)\s*[:：]?\s*([\u4e00-\u9fa5]{2,4})/g) || [];
    console.log(`   ⚠ 个人手机号命中：${phones.length} 个${phones.length ? '（需过滤，不采集）' : ''}`);
    console.log(`   ⚠ 联系人姓名命中：${contacts.length} 处${contacts.length ? '（需过滤，仅提示查看原文）' : ''}`);
    console.log(`   阀门相关关键词：${/阀门|球阀|闸阀|蝶阀|截止阀|止回阀|调节阀|电动阀/.test(text) ? '有 ✅' : '无'}`);
    console.log('');
    await new Promise((s) => setTimeout(s, 2000));
  }
  console.log('完成。');
})();
