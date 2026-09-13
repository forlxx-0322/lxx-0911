/**
 * 抓取新疆公共资源交易网列表页原始 HTML，导出片段用于确定解析策略。
 * 用法：node tools/dump-xj-list.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const BASE = 'https://ggzy.xinjiang.gov.cn';
const PATH_ = '/xinjiangggzy_new/xxzx/025002/infolist.html';
const OUT = path.resolve(__dirname, '..', '.fixtures', 'xj-list-raw.html');

(async () => {
  const res = await fetch(BASE + PATH_, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' },
    redirect: 'follow'
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let html = buf.toString('utf8');
  if ((html.match(/\uFFFD/g) || []).length > 5) {
    try { html = new TextDecoder('gbk').decode(buf); } catch (_) { /* 保持 utf8 */ }
  }
  fs.writeFileSync(OUT, html, 'utf8');
  console.log(`HTTP ${res.status}，${html.length} 字符 → ${OUT}`);

  /* 找出所有 iframe / script 数据源 / 常见列表容器 */
  const iframes = [...html.matchAll(/<iframe[^>]+src\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  console.log('\niframe：' + (iframes.length ? iframes.join('\n          ') : '无'));

  const scripts = [...html.matchAll(/<script[^>]+src\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  console.log('\n外链脚本：');
  for (const s of scripts.slice(0, 20)) console.log('   ' + s);

  const jsonUrls = [...new Set([...html.matchAll(/["']([^"']*\.(?:json|do|action)[^"']*)["']/gi)].map((m) => m[1]))];
  console.log('\n疑接口地址：');
  for (const u of jsonUrls.slice(0, 20)) console.log('   ' + u);

  /* 内联脚本里出现的 URL / ajax */
  const inlineAjax = [...html.matchAll(/(?:url|action)\s*[:=]\s*["']([^"']{4,120})["']/gi)].map((m) => m[1]);
  console.log('\n内联脚本中的 url/action：');
  for (const u of [...new Set(inlineAjax)].slice(0, 25)) console.log('   ' + u);

  /* 正文里是否直接含条目链接 */
  const detailLinks = [...new Set([...html.matchAll(/href\s*=\s*["']([^"']*\/20\d{6}\/[^"']+\.html)["']/gi)].map((m) => m[1]))];
  console.log(`\n详情页链接：${detailLinks.length} 个`);
  for (const d of detailLinks.slice(0, 8)) console.log('   ' + d);

  /* 打印 body 中段，便于目视判断结构 */
  const bodyStart = html.search(/<body/i);
  if (bodyStart > 0) {
    const seg = html.slice(bodyStart, bodyStart + 2600).replace(/\s+/g, ' ');
    console.log('\n--- body 起始片段 ---\n' + seg);
  }
})();
