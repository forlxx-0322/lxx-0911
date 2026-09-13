/**
 * 端到端验证：地址已填 → 保存客户 → 地图统计是否显示该客户。
 *
 * 覆盖修复前失败、修复后应通过的填法（区县留空、只填县级市/区/县）。
 *
 * 用法：先启动服务，再 node tools/test-region-map.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';
const ROOT = path.resolve(__dirname, '..');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

async function api(method, p, body) {
  const opts = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json; charset=utf-8';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, data: json && json.data, code: json && json.code, message: json && json.message };
}

/* 修复前会落到「未归属」的填法 + 正常填法 */
const CASES = [
  { label: '只填县级市（市字段）', city: '库尔勒市', district: '', expect: '652800' },
  { label: '只填市辖区（市字段）', city: '独山子区', district: '', expect: '650200' },
  { label: '只填县（市字段）', city: '乌鲁木齐县', district: '', expect: '650100' },
  { label: '市字段带括号补充', city: '乌鲁木齐市高新区（新市区）', district: '', expect: '650100' },
  { label: '只填区县字段', city: '', district: '莎车县', expect: '653100' },
  { label: '地州填在区县字段', city: '', district: '巴音郭楞蒙古自治州', expect: '652800' },
  { label: '常规：地州 + 区县', city: '喀什地区', district: '喀什市', expect: '653100' },
  { label: '地州简称', city: '昌吉州', district: '阜康市', expect: '652300' },
  { label: '兵团市（本身即地州级）', city: '石河子市', district: '', expect: '659001' },
  { label: '带省份前缀', city: '新疆维吾尔自治区乌鲁木齐市', district: '天山区', expect: '650100' }
];

(async () => {
  console.log('=== 地址归属 → 地图显示 端到端验证 ===\n');

  const created = [];
  const tag = Date.now().toString().slice(-6);

  try {
    /* 基线：当前地图统计 */
    const before = (await api('GET', '/api/map/distribution')).data;

    for (const c of CASES) {
      const r = await api('POST', '/api/customers', {
        name: `[归属验证${tag}] ${c.label}`,
        short_name: c.label.slice(0, 6),
        type: '终端用户', industry: '石油', status: '潜在',
        city: c.city, district: c.district
      });
      if (!r.data || !r.data.id) { check(c.label, false, '创建失败'); continue; }
      created.push(r.data.id);

      const detail = await api('GET', `/api/customers/${r.data.id}`);
      const code = detail.data.region_code;
      const name = detail.data.region_name;
      check(`保存后自动归属 · ${c.label}`, code === c.expect,
        `地址「${c.city || '—'} / ${c.district || '—'}」→ ${code || '【空】'} ${name || ''}（期望 ${c.expect}）`);
    }

    /* 地图统计应包含这些客户 */
    const dist = (await api('GET', '/api/map/distribution')).data;
    const byCode = new Map(dist.cities.map((x) => [x.code, x.customer_count]));

    const expectCount = (code) => CASES.filter((c) => c.expect === code).length;
    for (const code of [...new Set(CASES.map((c) => c.expect))]) {
      const name = (dist.cities.find((x) => x.code === code) || {}).name || code;
      const now = byCode.get(code) || 0;
      const base = ((before.cities.find((x) => x.code === code) || {}).customer_count) || 0;
      const added = now - base;
      check(`地图统计包含 · ${name}`, added >= expectCount(code),
        `${name} 客户数 ${base} → ${now}（本次新增 ${added}，应 ≥ ${expectCount(code)}）`);
    }

    check('地图上不再出现「未归属」误报',
      (dist.unassigned.customer_count - before.unassigned.customer_count) === 0,
      `未归属 ${before.unassigned.customer_count} → ${dist.unassigned.customer_count}`);

    /* 未归属清单：应能区分「没填地址」与「填了但认不出」 */
    check('未归属明细返回原因分类字段',
      typeof dist.unassigned.no_address_count === 'number'
      && typeof dist.unassigned.no_match_count === 'number'
      && Array.isArray(dist.unassigned.list),
      `没填地址 ${dist.unassigned.no_address_count} 家 / 填了认不出 ${dist.unassigned.no_match_count} 家`);

    /* 故意造一个认不出的地址，验证会被如实标注为 no_match 而不是"未填" */
    const bad = await api('POST', '/api/customers', {
      name: `[归属验证${tag}] 无法识别的地址`,
      short_name: '认不出', type: '终端用户', industry: '石油',
      city: '某某不存在的地方', district: '某某街道'
    });
    created.push(bad.data.id);
    const dist2 = (await api('GET', '/api/map/distribution')).data;
    const mine = (dist2.unassigned.list || []).find((x) => x.id === bad.data.id);
    check('认不出的地址被如实标注为「认不出」而非「未填」',
      !!mine && mine.reason === 'no_match',
      mine ? `原因=${mine.reason}，地址「${mine.city} / ${mine.district}」` : '未出现在未归属清单中');

    /* 改对地址后应自动归入 */
    await api('PUT', `/api/customers/${bad.data.id}`, { city: '阿克苏地区', district: '库车市' });
    const dist3 = (await api('GET', '/api/map/distribution')).data;
    const stillUn = (dist3.unassigned.list || []).some((x) => x.id === bad.data.id);
    const fixed = await api('GET', `/api/customers/${bad.data.id}`);
    check('地址改对后自动归入地图统计（无需手动干预）',
      !stillUn && fixed.data.region_code === '652900',
      `region_code=${fixed.data.region_code} ${fixed.data.region_name}，未归属清单中已移除=${!stillUn}`);

    /* 清空地址应清掉归属，避免统计错位 */
    await api('PUT', `/api/customers/${bad.data.id}`, { city: '', district: '' });
    const cleared = await api('GET', `/api/customers/${bad.data.id}`);
    check('清空地址后归属同步清空（不留错位归属）',
      cleared.data.region_code === '', `region_code=「${cleared.data.region_code}」`);
  } finally {
    for (const id of created) {
      await api('DELETE', `/api/customers/${id}`).catch(() => {});
    }
    /* 软删除后再物理清理，避免留下测试残留 */
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'));
    for (const id of created) {
      db.prepare('DELETE FROM contacts WHERE customer_id = ?').run(id);
      db.prepare('DELETE FROM followups WHERE customer_id = ?').run(id);
      db.prepare('DELETE FROM customer_tags WHERE customer_id = ?').run(id);
      db.prepare("DELETE FROM activity_logs WHERE entity_type = 'customer' AND entity_id = ?").run(id);
      db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    }
    const left = db.prepare("SELECT COUNT(*) AS n FROM customers WHERE name LIKE ?").get(`[归属验证${tag}]%`).n;
    db.close();
    check('测试数据已清理', left === 0, `残留 ${left} 条`);
  }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  }
  fs.writeFileSync(
    path.join(ROOT, '.fixtures', 'region-map-result.json'),
    JSON.stringify({ pass, fail, total: results.length, results }, null, 2),
    'utf8'
  );
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e.stack || e); process.exit(1); });
