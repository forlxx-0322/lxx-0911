/**
 * 地图数据服务
 *
 * 职责：
 *   1. 读取本地化的新疆 GeoJSON 边界（离线可用）
 *   2. 统计客户在地州 / 县市的分布（数量、合同额、回款、欠款）
 *   3. 按坐标推荐最近的地州（辅助定位，不自动写入）
 *   4. 行政区划清单（供筛选与表单下拉）
 *
 * 数据来源：web/vendor/map/xinjiang/（由 tools/fetch-map-data.js 本地化）
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { plainAll } = require('../db');
const coord = require('./coord');

/* ------------------------------------------------------------------ */
/* 数据加载与缓存                                                      */
/* ------------------------------------------------------------------ */

const cache = {
  index: null,
  geojson: new Map(),
  indexMtime: 0
};

function mapDir(root) {
  return path.join(root, 'web', 'vendor', 'map', 'xinjiang');
}

/** 读取索引文件（带缓存，文件变更后自动失效） */
function loadIndex(root) {
  const file = path.join(mapDir(root), 'index.json');
  if (!fs.existsSync(file)) {
    return { available: false, error: '地图数据未本地化，请先运行 node tools/fetch-map-data.js' };
  }
  const st = fs.statSync(file);
  if (cache.index && cache.indexMtime === st.mtimeMs) return cache.index;

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache.index = raw;
    cache.indexMtime = st.mtimeMs;
    return raw;
  } catch (e) {
    return { available: false, error: '地图索引文件损坏：' + e.message };
  }
}

/** 读取某个层级的 GeoJSON（带缓存） */
function loadGeoJson(root, code) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  if (cache.geojson.has(code)) return cache.geojson.get(code);

  const file = path.join(mapDir(root), `${code}_full.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache.geojson.set(code, json);
    return json;
  } catch (_) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 行政区划清单                                                        */
/* ------------------------------------------------------------------ */

/** 全部行政区划（从 region 表读取，按层级与排序） */
function listRegions(db) {
  const rows = plainAll(db.prepare(
    `SELECT code, name, level, parent_code, longitude, latitude, sort
     FROM region ORDER BY level, sort, code`
  ).all());
  return {
    province: rows.find((r) => r.level === 'province') || null,
    cities: rows.filter((r) => r.level === 'city'),
    districts: rows.filter((r) => r.level === 'district'),
    total: rows.length
  };
}

/* ------------------------------------------------------------------ */
/* 客户分布统计                                                        */
/* ------------------------------------------------------------------ */

/**
 * 按行政区划统计客户分布
 * 依据客户的 region_code（地州级）聚合；无 region_code 的按 city 文本兜底匹配
 */
function distribution(db, opts) {
  const o = opts || {};
  const onlyWithCoords = !!o.onlyWithCoords;

  /* 基础过滤：未删除 */
  const baseWhere = ['c.deleted_at IS NULL'];
  const params = [];
  if (onlyWithCoords) baseWhere.push('c.longitude IS NOT NULL AND c.latitude IS NOT NULL');
  const whereSql = `WHERE ${baseWhere.join(' AND ')}`;

  /* 先取全部区域，建立「名称 → code」映射，用于文本兜底 */
  const regions = listRegions(db);
  const byCode = new Map();
  for (const r of [...regions.cities, ...regions.districts]) byCode.set(r.code, r);

  const nameToCityCode = new Map();
  for (const c of regions.cities) {
    nameToCityCode.set(c.name, c.code);
    /* 兼容简称：去掉「回族自治州」等后缀 */
    const short = c.name.replace(/(回族自治州|蒙古自治州|哈萨克自治州|柯尔克孜自治州|地区|市|自治州)$/, '');
    if (short && !nameToCityCode.has(short)) nameToCityCode.set(short, c.code);
  }

  /* 聚合统计：region_code 优先，其次按 city 文本匹配 */
  const rows = plainAll(db.prepare(`
    SELECT c.region_code,
           c.city,
           COUNT(*) AS customer_count,
           COALESCE(SUM(c.deal_amount), 0) AS deal_amount,
           COALESCE(SUM(c.annual_demand), 0) AS annual_demand,
           SUM(CASE WHEN c.longitude IS NOT NULL AND c.latitude IS NOT NULL THEN 1 ELSE 0 END) AS located_count
    FROM customers c
    ${whereSql}
    GROUP BY c.region_code, c.city
  `).all(...params));

  /* 汇总到地州维度 */
  const cityMap = new Map();
  for (const c of regions.cities) {
    cityMap.set(c.code, {
      code: c.code, name: c.name, longitude: c.longitude, latitude: c.latitude,
      customer_count: 0, deal_amount: 0, annual_demand: 0, located_count: 0
    });
  }
  let unassigned = { customer_count: 0, deal_amount: 0, annual_demand: 0, located_count: 0, name: '未归属地州' };

  for (const r of rows) {
    let code = r.region_code;
    if (!code && r.city) {
      code = nameToCityCode.get(r.city)
        || nameToCityCode.get(String(r.city).replace(/(市|地区)$/, ''))
        || '';
    }
    const hit = code ? cityMap.get(code) : null;
    if (hit) {
      hit.customer_count += r.customer_count;
      hit.deal_amount += r.deal_amount;
      hit.annual_demand += r.annual_demand;
      hit.located_count += r.located_count;
    } else {
      unassigned.customer_count += r.customer_count;
      unassigned.deal_amount += r.deal_amount;
      unassigned.annual_demand += r.annual_demand;
      unassigned.located_count += r.located_count;
    }
  }

  /* 合同与回款按项目统计（更真实：客户成交额是缓存字段，这里用项目实际值） */
  const projRows = plainAll(db.prepare(`
    SELECT c.region_code, c.city,
           COALESCE(SUM(p.contract_amount), 0) AS contract_amount,
           COALESCE(SUM(COALESCE((SELECT SUM(pm.amount) FROM payments pm
             WHERE pm.project_id = p.id AND pm.type = '实收'), 0)), 0) AS received_amount
    FROM projects p
    JOIN customers c ON c.id = p.customer_id
    WHERE p.deleted_at IS NULL AND c.deleted_at IS NULL
    GROUP BY c.region_code, c.city
  `).all());

  for (const r of projRows) {
    let code = r.region_code;
    if (!code && r.city) {
      code = nameToCityCode.get(r.city)
        || nameToCityCode.get(String(r.city).replace(/(市|地区)$/, ''))
        || '';
    }
    const hit = code ? cityMap.get(code) : null;
    const contract = Number(r.contract_amount) || 0;
    const received = Number(r.received_amount) || 0;
    if (hit) {
      hit.contract_amount = (hit.contract_amount || 0) + contract;
      hit.received_amount = (hit.received_amount || 0) + received;
    } else {
      unassigned.contract_amount = (unassigned.contract_amount || 0) + contract;
      unassigned.received_amount = (unassigned.received_amount || 0) + received;
    }
  }

  const cities = [...cityMap.values()].map((c) => {
    const contract = Math.round((c.contract_amount || 0) * 100) / 100;
    const received = Math.round((c.received_amount || 0) * 100) / 100;
    return Object.assign(c, {
      deal_amount: Math.round(c.deal_amount * 100) / 100,
      contract_amount: contract,
      received_amount: received,
      debt_amount: Math.round((contract - received) * 100) / 100
    });
  });

  /* 总览 */
  const totalCustomers = cities.reduce((s, c) => s + c.customer_count, 0) + unassigned.customer_count;
  const totalLocated = cities.reduce((s, c) => s + c.located_count, 0) + unassigned.located_count;

  /* 未归属客户清单：把「到底是没填地址，还是填了但匹配不出来」查清楚。
     原来界面一律提示「未填市/地区」，遇到填了却匹配不上的地址会误导用户，
     所以这里返回客户名与具体原因，供界面给出可操作的提示。 */
  let unassignedList = [];
  if (!onlyWithCoords) {
    unassignedList = plainAll(db.prepare(
      `SELECT c.id, c.name, c.short_name, c.city, c.district,
              CASE WHEN TRIM(COALESCE(c.city,'')) = '' AND TRIM(COALESCE(c.district,'')) = ''
                   THEN 'no_address' ELSE 'no_match' END AS reason
       FROM customers c
       WHERE c.deleted_at IS NULL
         AND (c.region_code IS NULL OR c.region_code = '')
       ORDER BY c.id DESC
       LIMIT 200`
    ).all());
  }

  return {
    cities: cities.sort((a, b) => b.customer_count - a.customer_count),
    unassigned: Object.assign(unassigned, {
      deal_amount: Math.round(unassigned.deal_amount * 100) / 100,
      contract_amount: Math.round((unassigned.contract_amount || 0) * 100) / 100,
      received_amount: Math.round((unassigned.received_amount || 0) * 100) / 100,
      debt_amount: Math.round(((unassigned.contract_amount || 0) - (unassigned.received_amount || 0)) * 100) / 100,
      /* 未归属客户明细（最多 200 条）与原因分类 */
      list: unassignedList,
      no_address_count: unassignedList.filter((x) => x.reason === 'no_address').length,
      no_match_count: unassignedList.filter((x) => x.reason === 'no_match').length
    }),
    summary: {
      total_customers: totalCustomers,
      located_customers: totalLocated,
      unlocated_customers: totalCustomers - totalLocated,
      cities_with_customers: cities.filter((c) => c.customer_count > 0).length,
      total_cities: cities.length
    }
  };
}

/**
 * 某地州下的客户明细（地图点击区域后展示）
 * @param {string} code 地州 code
 */
function regionCustomers(db, code, limit) {
  const region = db.prepare('SELECT code, name, level FROM region WHERE code = ?').get(String(code));
  if (!region) return null;

  const rows = plainAll(db.prepare(`
    SELECT c.id, c.name, c.short_name, c.type, c.industry, c.level, c.status,
           c.city, c.district, c.longitude, c.latitude,
           c.deal_amount, c.next_follow_at, c.phone,
           (SELECT ct.name FROM contacts ct WHERE ct.customer_id = c.id AND ct.deleted_at IS NULL
              ORDER BY ct.is_primary DESC, ct.id ASC LIMIT 1) AS primary_contact,
           (SELECT ct.mobile FROM contacts ct WHERE ct.customer_id = c.id AND ct.deleted_at IS NULL
              ORDER BY ct.is_primary DESC, ct.id ASC LIMIT 1) AS primary_mobile,
           (SELECT COUNT(*) FROM projects p WHERE p.customer_id = c.id AND p.deleted_at IS NULL) AS project_count,
           (SELECT COALESCE(SUM(p.contract_amount),0) FROM projects p
              WHERE p.customer_id = c.id AND p.deleted_at IS NULL) AS contract_total
    FROM customers c
    WHERE c.deleted_at IS NULL AND (
      c.region_code = ?
      OR (c.region_code = '' AND c.city = ?)
    )
    ORDER BY c.deal_amount DESC, c.id DESC
    LIMIT ?
  `).all(String(code), region.name, Math.min(Number(limit) || 200, 500)));

  return {
    region: { code: region.code, name: region.name, level: region.level },
    list: rows.map((r) => Object.assign(r, {
      contract_total: Math.round((Number(r.contract_total) || 0) * 100) / 100
    })),
    total: rows.length
  };
}

/* ------------------------------------------------------------------ */
/* 坐标相关辅助                                                        */
/* ------------------------------------------------------------------ */

/**
 * 按坐标推荐最近的地州（辅助，不自动写入）
 * 只返回距离最近的前几个，由用户决定
 */
function nearestRegions(db, lng, lat, limit) {
  const a = Number(lng);
  const b = Number(lat);
  if (!isFinite(a) || !isFinite(b)) return { error: '坐标无效', list: [] };

  const cities = plainAll(db.prepare(
    `SELECT code, name, longitude, latitude FROM region
     WHERE level = 'city' AND longitude IS NOT NULL AND latitude IS NOT NULL`
  ).all());

  const withDist = cities.map((c) => ({
    code: c.code,
    name: c.name,
    distance: coord.distanceMeters(a, b, c.longitude, c.latitude),
    distance_text: coord.formatDistance(coord.distanceMeters(a, b, c.longitude, c.latitude))
  })).sort((x, y) => x.distance - y.distance);

  return {
    input: { longitude: a, latitude: b },
    list: withDist.slice(0, Math.min(Number(limit) || 3, 10)),
    note: '仅供参考：客户可能不在最近的地州，请人工确认'
  };
}

/** 地图数据状态（前端判断是否需要提示用户先本地化数据） */
function status(root) {
  const index = loadIndex(root);
  if (index.available === false) return index;
  const files = fs.existsSync(mapDir(root)) ? fs.readdirSync(mapDir(root)).filter((f) => f.endsWith('.json')) : [];
  let size = 0;
  for (const f of files) {
    try { size += fs.statSync(path.join(mapDir(root), f)).size; } catch (_) { /* 忽略 */ }
  }
  return {
    available: true,
    generatedAt: index.generatedAt,
    source: index.source,
    province: index.province,
    cityCount: (index.prefectures || []).length,
    districtCount: (index.prefectures || []).reduce((s, p) => s + (p.children || []).length, 0),
    fileCount: files.length,
    size,
    size_text: size < 1048576 ? (size / 1024).toFixed(0) + ' KB' : (size / 1048576).toFixed(2) + ' MB'
  };
}

/** 供前端注册 ECharts 地图用：返回指定层级的 GeoJSON */
function geoJson(root, code) {
  return loadGeoJson(root, code);
}

/** 清空缓存（地图数据更新后调用） */
function clearCache() {
  cache.index = null;
  cache.geojson.clear();
  cache.indexMtime = 0;
}

module.exports = {
  mapDir,
  loadIndex,
  loadGeoJson,
  geoJson,
  listRegions,
  distribution,
  regionCustomers,
  nearestRegions,
  status,
  clearCache,
  coord
};
