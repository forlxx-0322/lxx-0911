/**
 * 列出新疆公共资源交易网的完整栏目结构，定位"招标公告"真实入口。
 * 用法：node tools/dump-xj-nav.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const BASE = 'https://ggzy.xinjiang.gov.cn';

(async () => {
  const res = await fetch(BASE + '/xinjiangggzy_new/', {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' },
    redirect: 'follow'
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let html = buf.toString('utf8');
  if ((html.match(/\uFFFD/g) || []).length > 5) {
    try { html = new TextDecoder('gbk').decode(buf); } catch (_) { /* utf8 */ }
  }
  console.log(`首页 HTTP ${res.status}，${html.length} 字符\n`);

  /* 1. 所有 infolist.html 栏目及其锚文本 */
  const catRe = /<a[^>]+href\s*=\s*["']([^"']*infolist\.html)["'][^>]*>([\s\S]{0,60}?)<\/a>/gi;
  const cats = new Map();
  let m;
  while ((m = catRe.exec(html))) {
    const name = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (name && !cats.has(m[1])) cats.set(m[1], name);
  }
  console.log(`=== infolist 栏目（${cats.size} 个）===`);
  for (const [href, name] of cats) console.log(`   ${name.padEnd(16, '　')} ${href}`);

  /* 2. 全部一级路径段统计，找出交易信息板块 */
  const segs = new Map();
  const linkRe = /href\s*=\s*["']([^"']+)["']/gi;
  while ((m = linkRe.exec(html))) {
    try {
      const u = new URL(m[1], BASE);
      if (u.host !== new URL(BASE).host) continue;
      const parts = u.pathname.split('/').filter(Boolean);
      const key = '/' + (parts[0] || '') + '/' + (parts[1] || '');
      segs.set(key, (segs.get(key) || 0) + 1);
    } catch (_) { /* 忽略 */ }
  }
  console.log('\n=== 一级/二级路径分布 ===');
  for (const [k, v] of [...segs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24)) {
    console.log(`   ${String(v).padStart(4)} 次  ${k}`);
  }

  /* 3. 含"招标/交易/公告"字样的链接 */
  console.log('\n=== 含招标/交易/公告字样的链接 ===');
  const hotRe = /<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,70}?)<\/a>/gi;
  const seen = new Set();
  while ((m = hotRe.exec(html))) {
    const name = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!/招标|交易|公告|采购|中标|开标|挂牌/.test(name)) continue;
    if (seen.has(m[1] + name)) continue;
    seen.add(m[1] + name);
    console.log(`   ${name.slice(0, 26).padEnd(28, '　')} ${m[1]}`);
    if (seen.size > 45) break;
  }

  /* 4. 保存一份供后续查阅 */
  const out = path.resolve(__dirname, '..', '.fixtures', 'xj-home-raw.html');
  fs.writeFileSync(out, html, 'utf8');
  console.log(`\n原始首页已保存：${out}`);
})();
