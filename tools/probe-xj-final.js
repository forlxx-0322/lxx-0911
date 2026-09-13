/**
 * 最后一步可行性验证：找到 siteGuid / controlName，真正打通列表接口。
 * 打通与否，直接决定实现难度与工作量估算。
 *
 * 用法：node tools/probe-xj-final.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const BASE = 'https://ggzy.xinjiang.gov.cn';
const REF = BASE + '/xinjiangggzy_new/jyxx/trade_info.html';
const FIX = path.resolve(__dirname, '..', '.fixtures');
const TIMEOUT = 20000;

async function req(url, opts) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, Object.assign({
      signal: ctl.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': REF
      },
      redirect: 'follow'
    }, opts || {}));
    const buf = Buffer.from(await res.arrayBuffer());
    let text = buf.toString('utf8');
    if ((text.match(/\uFFFD/g) || []).length > 5) {
      try { text = new TextDecoder('gbk').decode(buf); } catch (_) { /* utf8 */ }
    }
    return { status: res.status, type: res.headers.get('content-type') || '', text };
  } catch (e) {
    return { status: 0, error: e.name === 'AbortError' ? '超时' : e.message };
  } finally { clearTimeout(timer); }
}

const POST = (url, data) => req(url, {
  method: 'POST',
  headers: {
    'User-Agent': UA,
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': REF,
    'Origin': BASE
  },
  body: new URLSearchParams(data).toString()
});

(async () => {
  /* 1. 抓 common.js，找 siteInfo 定义 */
  console.log('=== 1. 寻找 siteInfo / siteGuid ===');
  let siteGuid = '';
  for (const p of ['/xinjiangggzy_new/js/common.js', '/xinjiangggzy_new/js/util.f9x.js']) {
    const r = await req(BASE + p);
    if (r.status !== 200) { console.log(`   ${p} → HTTP ${r.status}`); continue; }
    fs.writeFileSync(path.join(FIX, 'xj-' + path.basename(p)), r.text, 'utf8');
    const si = r.text.match(/siteInfo\s*[:=]\s*\{[\s\S]{0,500}?\}/);
    const sg = r.text.match(/siteGuid["']?\s*[:=]\s*["']([0-9a-fA-F-]{20,})["']/);
    console.log(`   ${p} → ${r.text.length} 字符；siteInfo=${si ? '有' : '无'}；siteGuid=${sg ? sg[1] : '无'}`);
    if (si) console.log('        ' + si[0].replace(/\s+/g, ' ').slice(0, 400));
    if (sg && !siteGuid) siteGuid = sg[1];
    await new Promise((s) => setTimeout(s, 800));
  }

  /* 2. 首页里的独立 GUID（站点级 GUID 通常只出现一次） */
  try {
    const home = fs.readFileSync(path.join(FIX, 'xj-home-raw.html'), 'utf8');
    const all = [...home.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)].map((m) => m[0]);
    const count = new Map();
    for (const g of all) count.set(g, (count.get(g) || 0) + 1);
    console.log('\n=== 2. 首页 GUID 频次（出现 1 次的最可能是站点 GUID）===');
    for (const [g, c] of [...count.entries()].sort((a, b) => a[1] - b[1]).slice(0, 5)) {
      console.log(`   ${c} 次  ${g}`);
    }
    const once = [...count.entries()].filter((x) => x[1] === 1).map((x) => x[0]);
    if (once.length) {
      /* 取第一个作为候选（0b845470… 在首页只出现一次且位置靠前） */
      const cand = once.find((g) => g.startsWith('0b845470')) || once[0];
      console.log(`   选用候选：${cand}`);
      if (!siteGuid) siteGuid = cand;
    }
  } catch (e) {
    console.log('   读取首页失败：' + e.message);
  }

  console.log(`\n最终使用 siteGuid = ${siteGuid || '（空）'}`);

  /* 3. 试接口：不同 controlName */
  console.log('\n=== 3. 调用 getPageInfoList（多组 controlName）===');
  const ENDPOINT = BASE + '/EpointWebBuilder/frontAppAction.action?cmd=getPageInfoList';
  const CANDIDATES = ['', 'infoList', 'list', 'pageList', 'tradeInfo', 'jyxxList', 'infoListControl'];

  for (const controlName of CANDIDATES) {
    const r = await POST(ENDPOINT, {
      categoryNum: '001001001',
      siteGuid,
      pageIndex: '0',
      controlName
    });
    const ok = r.status === 200 && r.text.length > 150 && /"controls"/.test(r.text) && !/"code":"503"/.test(r.text);
    console.log(`   controlName="${controlName}" → HTTP ${r.status} ${r.text.length} 字符 ${ok ? '✅ 有数据' : ''}`);
    if (ok) {
      fs.writeFileSync(path.join(FIX, 'xj-api-ok.json'), r.text, 'utf8');
      console.log('        已保存 .fixtures/xj-api-ok.json');
      console.log('        内容前 800 字：' + r.text.slice(0, 800).replace(/\s+/g, ' '));
      break;
    } else if (r.text.length < 300) {
      console.log('        ' + r.text.slice(0, 200).replace(/\s+/g, ' '));
    }
    await new Promise((s) => setTimeout(s, 1500));
  }

  /* 4. 换一个思路：直接试频次更高的"信息发布"栏目接口 getGovInfoList / getInfoList */
  console.log('\n=== 4. 试其他 cmd ===');
  for (const cmd of ['getInfoList', 'getCateTopInfoContent', 'getTitleListByCategoryNum']) {
    const r = await POST(BASE + '/EpointWebBuilder/frontAppAction.action?cmd=' + cmd, {
      categoryNum: '001001001', siteGuid, pageIndex: '0', pageSize: '10', length: '10'
    });
    console.log(`   ${cmd} → HTTP ${r.status} ${r.text.length} 字符  ${r.text.slice(0, 150).replace(/\s+/g, ' ')}`);
    await new Promise((s) => setTimeout(s, 1200));
  }
  console.log('\n完成。');
})();
