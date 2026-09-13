/**
 * 新疆地图数据本地化工具
 *
 * 做什么：
 *   1. 下载新疆地州级 GeoJSON（14 个地州市 + 10 个自治区直辖县级市）
 *   2. 逐个下载各地州下辖县市级 GeoJSON，支持地图下钻
 *   3. 生成索引文件 index.json（名称/层级/上级/中心点）
 *   4. 把行政区划灌入数据库 region 表（供统计与筛选使用）
 *
 * 为什么必须本地化：
 *   验收要求「断网后所有功能正常」。若用在线瓦片或在线 GeoJSON，
 *   断网后地图直接空白，与既有 289 项验收标准冲突。
 *
 * 用法：node tools/fetch-map-data.js
 * 说明：仅开发期联网执行一次；之后完全离线可用。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const MAP_DIR = path.join(ROOT, 'web', 'vendor', 'map', 'xinjiang');
const DB_FILE = path.join(ROOT, 'data', 'crm.db');

const SOURCE = 'https://geo.datav.aliyun.com/areas_v3/bound';
const PROVINCE_CODE = '650000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, retries) {
  const max = retries === undefined ? 3 : retries;
  let lastErr = null;
  for (let i = 0; i <= max; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < max) await sleep(600 * (i + 1));
    }
  }
  throw lastErr;
}

/** 精简 GeoJSON：去掉不需要的字段，只保留渲染必需的，减小体积 */
function slimFeature(f, parentCode) {
  const p = f.properties || {};
  return {
    type: 'Feature',
    properties: {
      adcode: p.adcode,
      name: p.name,
      level: p.level,
      parent: parentCode ? { adcode: Number(parentCode) } : (p.parent || null),
      center: p.center || null,
      centroid: p.centroid || null
    },
    geometry: f.geometry
  };
}

function slimCollection(json, parentCode) {
  return {
    type: 'FeatureCollection',
    features: (json.features || []).map((f) => slimFeature(f, parentCode))
  };
}

(async () => {
  console.log('=== 新疆地图数据本地化 ===\n');
  fs.mkdirSync(MAP_DIR, { recursive: true });

  /* ---------- 1. 地州级 ---------- */
  process.stdout.write('下载地州级边界 … ');
  const provRaw = await fetchJson(`${SOURCE}/${PROVINCE_CODE}_full.json`);
  const provSlim = slimCollection(provRaw, PROVINCE_CODE);
  const provFile = path.join(MAP_DIR, `${PROVINCE_CODE}_full.json`);
  fs.writeFileSync(provFile, JSON.stringify(provSlim), 'utf8');

  const cities = provSlim.features.map((f) => ({
    adcode: f.properties.adcode,
    name: f.properties.name,
    level: f.properties.level,
    center: f.properties.center,
    centroid: f.properties.centroid
  }));
  console.log(`完成：${cities.length} 个要素，${Math.round(fs.statSync(provFile).size / 1024)} KB`);

  /* ---------- 2. 县市级（逐个下钻） ---------- */
  console.log(`\n下载 ${cities.length} 个地州下辖的县市边界（用于地图下钻）…`);
  const index = {
    province: { code: PROVINCE_CODE, name: '新疆维吾尔自治区', file: `${PROVINCE_CODE}_full.json` },
    prefectures: [],
    generatedAt: new Date().toISOString(),
    source: SOURCE
  };

  let okCount = 0;
  let failCount = 0;
  let noChildCount = 0;
  const failures = [];

  for (let i = 0; i < cities.length; i++) {
    const c = cities[i];
    const label = `[${String(i + 1).padStart(2)}/${cities.length}] ${c.name}`;
    process.stdout.write(`  ${label} … `);
    try {
      const raw = await fetchJson(`${SOURCE}/${c.adcode}_full.json`);
      const slim = slimCollection(raw, c.adcode);
      const file = `${c.adcode}_full.json`;
      fs.writeFileSync(path.join(MAP_DIR, file), JSON.stringify(slim), 'utf8');

      const children = slim.features.map((f) => ({
        code: f.properties.adcode,
        name: f.properties.name,
        level: f.properties.level,
        center: f.properties.center,
        centroid: f.properties.centroid
      }));

      index.prefectures.push({
        code: c.adcode,
        name: c.name,
        level: c.level,
        center: c.center,
        centroid: c.centroid,
        file,
        children,
        hasChildren: true
      });
      okCount++;
      console.log(`${children.length} 个县市，${Math.round(fs.statSync(path.join(MAP_DIR, file)).size / 1024)} KB`);
    } catch (e) {
      /* 自治区直辖县级市（兵团市，如石河子）没有下辖县市，接口返回 404 属正常，
         这类城市直接作为一个可点击区域参与地图渲染，不算失败。 */
      if (String(e.message).includes('404')) {
        index.prefectures.push({
          code: c.adcode,
          name: c.name,
          level: c.level,
          center: c.center,
          centroid: c.centroid,
          file: null,
          children: [],
          hasChildren: false,
          note: '自治区直辖县级市，无下辖行政区分级'
        });
        noChildCount++;
        console.log('无下辖县市（自治区直辖县级市，正常）');
      } else {
        failCount++;
        failures.push(`${c.name}(${c.adcode}): ${e.message}`);
        console.log(`失败：${e.message}`);
      }
    }
    await sleep(220);   // 温和请求，避免给对方服务器压力
  }

  /* 索引里保留失败项，便于后续重试 */
  index.failures = failures;
  fs.writeFileSync(path.join(MAP_DIR, 'index.json'), JSON.stringify(index, null, 2), 'utf8');

  /* ---------- 3. 汇总 ---------- */
  const files = fs.readdirSync(MAP_DIR).filter((f) => f.endsWith('.json'));
  let totalSize = 0;
  for (const f of files) totalSize += fs.statSync(path.join(MAP_DIR, f)).size;

  console.log('');
  console.log('--- 本地化结果 ---');
  console.log(`地州级：1 个文件（${cities.length} 个地州/自治区直辖县级市）`);
  console.log(`县市级：${okCount} 个文件；无下辖县市 ${noChildCount} 个${failCount ? `；失败 ${failCount} 个` : ''}`);
  console.log(`合计：${files.length} 个文件，${Math.round(totalSize / 1024)} KB`);
  if (failures.length) {
    console.log('失败清单（可重跑本脚本补齐）：');
    for (const f of failures) console.log('  - ' + f);
  }

  /* ---------- 4. 灌入 region 表 ---------- */
  if (!fs.existsSync(DB_FILE)) {
    console.log('\n数据库不存在，跳过 region 表灌入（先启动一次软件即可）。');
    return;
  }

  console.log('\n正在把行政区划灌入数据库 region 表 …');
  const db = new DatabaseSync(DB_FILE);
  try {
    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const ins = db.prepare(
      `INSERT INTO region (code, name, level, parent_code, longitude, latitude, geojson_path, sort, customer_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(code) DO UPDATE SET
         name = excluded.name,
         level = excluded.level,
         parent_code = excluded.parent_code,
         longitude = excluded.longitude,
         latitude = excluded.latitude,
         geojson_path = excluded.geojson_path`
    );

    db.exec('BEGIN');
    /* geojson_path 是 NOT NULL，无下钻文件的层级传空串 */
    ins.run(
      PROVINCE_CODE, index.province.name, 'province', '',
      null, null, index.province.file, 0
    );
    let n = 1;

    let sort = 0;
    for (const p of index.prefectures) {
      const center = p.center || p.centroid || [null, null];
      ins.run(String(p.code), p.name, 'city', PROVINCE_CODE,
        center[0] === undefined ? null : center[0],
        center[1] === undefined ? null : center[1],
        p.file || '', ++sort);
      n++;

      for (const ch of p.children) {
        const cc = ch.center || ch.centroid || [null, null];
        ins.run(String(ch.code), ch.name, 'district', String(p.code),
          cc[0] === undefined ? null : cc[0],
          cc[1] === undefined ? null : cc[1],
          '', 0);
        n++;
      }
    }
    db.exec('COMMIT');

    const stat = db.prepare(
      `SELECT level, COUNT(*) AS n FROM region GROUP BY level ORDER BY level`
    ).all();
    console.log(`已写入 ${n} 条行政区划：` + stat.map((s) => `${s.level} ${s.n}`).join('，'));
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
    console.error('灌入失败：', e.message);
    process.exitCode = 1;
  } finally {
    db.close();
  }

  console.log('\n完成。地图数据存放于 web/vendor/map/xinjiang/，之后完全离线可用。');
})().catch((e) => {
  console.error('执行失败：', e && e.stack ? e.stack : e);
  process.exit(1);
});
