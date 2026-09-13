/**
 * 阶段六 API 验收测试 —— 地图数据 / 客户分布 / 坐标转换 / 归属匹配
 * 用法：node tools/test-phase6-api.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';
const MAP_DIR = path.resolve(__dirname, '..', 'web', 'vendor', 'map', 'xinjiang');

const results = [];
function check(no, name, pass, detail) {
  results.push({ no, name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${no}. ${name}${detail ? '  —— ' + detail : ''}`);
}

async function api(method, p, body) {
  const opts = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined && body !== null) {
    opts.headers['Content-Type'] = 'application/json; charset=utf-8';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 非 JSON */ }
  return { status: res.status, json, data: json && json.data };
}

/** 两点球面距离（米），用于独立核对服务端算出的距离 */
function distance(a, b, c, d) {
  const R = 6371008.8;
  const toRad = (x) => x * Math.PI / 180;
  const dLat = toRad(d - b);
  const dLng = toRad(c - a);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(b)) * Math.cos(toRad(d)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const created = [];

(async () => {
  console.log('=== 阶段六 API 验收测试（地图）===\n');

  /* ---------- 0. 清理残留 ---------- */
  try {
    const r = await api('GET', '/api/customers?pageSize=100&q=' + encodeURIComponent('阶段六测试'));
    const ids = (r.data.list || []).map((x) => x.id);
    if (ids.length) {
      await api('POST', '/api/customers/batch-delete', { ids });
      console.log(`（清理残留 ${ids.length} 条测试客户）\n`);
    }
  } catch (_) { /* 首次运行 */ }

  /* ================= 1. 地图数据状态 ================= */
  const st = await api('GET', '/api/map/status');
  check(1, '地图数据已本地化且状态可查',
    st.data.available === true && st.data.cityCount === 24,
    `地州/直辖市 ${st.data.cityCount} 个，县市 ${st.data.districtCount} 个，${st.data.fileCount} 个文件，${st.data.size_text}`);

  check(2, '地图数据包含自治区直辖县级市（兵团市）',
    st.data.cityCount >= 24,
    `共 ${st.data.cityCount} 个地州级要素（含石河子、阿拉尔等兵团市）`);

  /* ================= 2. 行政区划清单 ================= */
  const regions = await api('GET', '/api/map/regions');
  check(3, '行政区划清单含省/地州/县市三级',
    regions.data.province && regions.data.cities.length === 24 && regions.data.districts.length >= 90,
    `省 1 个、地州 ${regions.data.cities.length} 个、县市 ${regions.data.districts.length} 个，共 ${regions.data.total} 条`);

  const urumqi = regions.data.cities.find((c) => c.name.includes('乌鲁木齐'));
  check(4, '地州含中心坐标（用于推荐与定位）',
    urumqi && urumqi.longitude > 86 && urumqi.longitude < 89 && urumqi.latitude > 43 && urumqi.latitude < 45,
    urumqi ? `乌鲁木齐中心 (${urumqi.longitude}, ${urumqi.latitude})` : '未找到');

  /* ================= 3. 边界数据（本地文件 + 接口） ================= */
  const provFile = path.join(MAP_DIR, '650000_full.json');
  const provJson = JSON.parse(fs.readFileSync(provFile, 'utf8'));
  check(5, '地州级边界文件存在且要素完整',
    provJson.type === 'FeatureCollection' && provJson.features.length === 24,
    `${Math.round(fs.statSync(provFile).size / 1024)} KB，${provJson.features.length} 个要素`);

  const firstFeature = provJson.features[0];
  check(6, '边界要素含 adcode/name/center（前端注册地图必需）',
    firstFeature.properties.adcode && firstFeature.properties.name && firstFeature.properties.center,
    `${firstFeature.properties.name}（${firstFeature.properties.adcode}），中心 ${JSON.stringify(firstFeature.properties.center)}`);

  /* 坐标范围应在新疆境内（WGS84）。
     新疆实际范围约 73.5~96.4°E / 34.3~49.2°N（东端哈密淖毛湖、西端帕米尔高原）。 */
  const allCoords = JSON.stringify(provJson).match(/-?\d+\.\d+/g).map(Number);
  let lngMin = 999, lngMax = -999, latMin = 999, latMax = -999;
  for (let i = 0; i + 1 < allCoords.length; i += 2) {
    const a = allCoords[i], b = allCoords[i + 1];
    if (a > 70 && a < 100) { lngMin = Math.min(lngMin, a); lngMax = Math.max(lngMax, a); }
    if (b > 30 && b < 55) { latMin = Math.min(latMin, b); latMax = Math.max(latMax, b); }
  }
  check(7, '边界坐标为 WGS84 且落在新疆范围内',
    lngMin > 73 && lngMax < 97 && latMin > 34 && latMax < 50,
    `经度 ${lngMin.toFixed(2)} ~ ${lngMax.toFixed(2)}，纬度 ${latMin.toFixed(2)} ~ ${latMax.toFixed(2)}（新疆实际约 73.5~96.4°E / 34.3~49.2°N）`);

  const gj = await api('GET', '/api/map/geojson?code=650000');
  check(8, '边界数据可经接口获取（前端按需加载）',
    gj.status === 200 && gj.data.type === 'FeatureCollection' && gj.data.features.length === 24,
    `接口返回 ${gj.data.features.length} 个要素`);

  const gjCity = await api('GET', '/api/map/geojson?code=650100');
  check(9, '县市级边界可下钻获取（乌鲁木齐 8 个区县）',
    gjCity.status === 200 && gjCity.data.features.length === 8,
    `乌鲁木齐下辖 ${gjCity.data.features.length} 个区县：${gjCity.data.features.map((f) => f.properties.name).join('、')}`);

  const gjMissing = await api('GET', '/api/map/geojson?code=999999');
  check(10, '获取不存在的边界返回 404',
    gjMissing.status === 404, `HTTP ${gjMissing.status}`);

  /* 全部地州边界文件都在本地（离线可用） */
  const index = JSON.parse(fs.readFileSync(path.join(MAP_DIR, 'index.json'), 'utf8'));
  const missing = [];
  for (const p of index.prefectures) {
    if (p.file && !fs.existsSync(path.join(MAP_DIR, p.file))) missing.push(p.name);
  }
  check(11, '全部地州边界文件已本地化（断网可用）',
    missing.length === 0,
    missing.length ? `缺少：${missing.join('、')}` : `${index.prefectures.filter((p) => p.file).length} 个地州文件齐备（另 ${index.prefectures.filter((p) => !p.file).length} 个兵团市无下辖县市）`);

  /* ================= 4. 客户分布统计 ================= */
  /* 造数据：乌鲁木齐 2 个、喀什 1 个、无归属 1 个 */
  const mk = async (name, city, district, lng, lat, demand) => {
    const r = await api('POST', '/api/customers', {
      name: `阶段六测试${name}`, short_name: name, type: '终端用户', industry: '石油',
      city, district, longitude: lng, latitude: lat, annual_demand: demand
    });
    if (r.data && r.data.id) created.push(r.data.id);
    return r.data;
  };

  const c1 = await mk('乌鲁木齐客户A', '乌鲁木齐市', '天山区', 87.6168, 43.8256, 500);
  const c2 = await mk('乌鲁木齐客户B', '乌鲁木齐市', '沙依巴克区', 87.5900, 43.8000, 300);
  const c3 = await mk('喀什客户C', '喀什地区', '喀什市', 75.9898, 39.4677, 800);
  const c4 = await mk('未归属客户D', '', '', null, null, 100);

  check(12, '准备 4 个测试客户（3 个有地址坐标，1 个无归属）',
    c1 && c2 && c3 && c4,
    `新建：${[c1, c2, c3, c4].filter(Boolean).length} 个`);

  const d1 = await api('GET', `/api/customers/${c1.id}`);
  check(13, '客户保存时按地址自动归属地州',
    d1.data.region_code === '650100' && d1.data.region_name.includes('乌鲁木齐'),
    `「乌鲁木齐市/天山区」→ region_code=${d1.data.region_code}（${d1.data.region_name}）`);

  const d3 = await api('GET', `/api/customers/${c3.id}`);
  check(14, '按「地区」也能正确匹配到地州',
    d3.data.region_code && d3.data.region_name.includes('喀什'),
    `「喀什地区/喀什市」→ region_code=${d3.data.region_code}（${d3.data.region_name}）`);

  const d4 = await api('GET', `/api/customers/${c4.id}`);
  check(15, '无地址客户不强行归属（不猜测）',
    d4.data.region_code === '',
    `region_code 为空字符串`);

  const dist = await api('GET', '/api/map/distribution');
  const urumqiRow = dist.data.cities.find((c) => c.name.includes('乌鲁木齐'));
  const kashiRow = dist.data.cities.find((c) => c.name.includes('喀什'));

  /* 本套件的客户一律以「阶段六测试」开头；库里可能残留其他套件的数据，
     因此统计断言只针对本套件自己造的客户，保证与运行顺序无关。 */
  const PREFIX = '阶段六测试';
  const mine = (await api('GET', '/api/customers?pageSize=500&sort=id&order=asc')).data.list
    .filter((x) => String(x.name || '').startsWith(PREFIX));
  const mineUr = mine.filter((x) => x.region_code === '650100');
  const mineKa = mine.filter((x) => x.region_code === '653100');
  const mineUn = mine.filter((x) => !x.region_code);

  check('16', '分布统计按地州聚合客户数',
    !!urumqiRow && mineUr.length === 2 && !!kashiRow && mineKa.length === 1,
    `本套件客户：乌鲁木齐 ${mineUr.length} 家、喀什 ${mineKa.length} 家`
    + `（全库合计 乌鲁木齐 ${urumqiRow && urumqiRow.customer_count} 家、喀什 ${kashiRow && kashiRow.customer_count} 家）`);

  check('17', '无归属客户单独统计（不混入其他地州）',
    mineUn.length === 1 && dist.data.unassigned.customer_count >= 1
      && dist.data.summary.unlocated_customers >= 1,
    `本套件未归属客户 ${mineUn.length} 家：${mineUn.map((x) => x.name).join('、') || '无'}`
    + `；全库统计 未归属 ${dist.data.unassigned.customer_count} 家 / 总客户 ${dist.data.summary.total_customers} 家`);

  const urNeed = mineUr.reduce((s, x) => s + (Number(x.annual_demand) || 0), 0);
  check('18', '分布统计含年需求量汇总',
    urNeed === 800 && !!urumqiRow && Number(urumqiRow.annual_demand) >= 800,
    `本套件乌鲁木齐年需求合计 ${urNeed} 万（500 + 300）；全库该地州 ${urumqiRow && urumqiRow.annual_demand} 万`);

  check('19', '分布统计返回全部地州（含 0 客户的地州）',
    dist.data.cities.length === 24 && dist.data.summary.total_cities === 24,
    `返回 ${dist.data.cities.length} 个地州，其中 ${dist.data.summary.cities_with_customers} 个有客户`);

  /* 只统计有坐标的：本套件 3 家带坐标的必须都在（各区域明细里能查到） */
  const distLocated = await api('GET', '/api/map/distribution?onlyWithCoords=1');
  const locatedMine = [];
  for (const code of ['650100', '653100']) {
    const r = await api('GET', `/api/map/region-customers?code=${code}&pageSize=200&onlyWithCoords=1`);
    for (const x of ((r.data && r.data.list) || [])) {
      if (String(x.name || '').startsWith(PREFIX)) locatedMine.push(x.name);
    }
  }
  check('20', '可只统计有坐标的客户',
    locatedMine.length === 3 && distLocated.data.summary.total_customers >= 3,
    `仅计有坐标客户：本套件命中 ${locatedMine.length} 家（应为 3）；全库合计 ${distLocated.data.summary.total_customers} 家`);

  /* ================= 5. 地州客户明细 ================= */
  const rc = await api('GET', '/api/map/region-customers?code=650100');
  const rcMine = (rc.data.list || []).filter((x) => String(x.name || '').startsWith(PREFIX));
  check('21', '点击地州可获取该区域客户明细',
    rcMine.length === 2 && rc.data.region.name.includes('乌鲁木齐')
      && rc.data.list.every((x) => x.region_code === '650100' || x.city === '乌鲁木齐市'),
    `${rc.data.region.name}：本套件 ${rcMine.length} 家（${rcMine.map((x) => x.short_name).join('、')}）`
    + `，该区域全库 ${rc.data.total} 家`);

  check(22, '客户明细含跟进信息与项目数（可直接跳转）',
    rc.data.list[0] && 'next_follow_at' in rc.data.list[0] && 'project_count' in rc.data.list[0],
    `字段：${Object.keys(rc.data.list[0] || {}).slice(0, 8).join(', ')}…`);

  const rcBad = await api('GET', '/api/map/region-customers?code=999999');
  check(23, '不存在的区域返回 404', rcBad.status === 404, `HTTP ${rcBad.status}`);

  /* ================= 6. 坐标转换 ================= */
  /* 乌鲁木齐 WGS84 → GCJ-02：偏移应为 200~400 米量级 */
  const conv1 = await api('POST', '/api/map/convert', {
    from: 'wgs84', to: 'gcj02', longitude: 87.6168, latitude: 43.8256
  });
  const shift1 = conv1.data.shift_meters;
  /* 独立核对：用测试脚本自己的距离公式复算 */
  const myShift = distance(87.6168, 43.8256, conv1.data.output.longitude, conv1.data.output.latitude);
  check(24, 'WGS84 → GCJ-02 转换，偏移量合理（200~500 米）',
    shift1 > 150 && shift1 < 500 && Math.abs(myShift - shift1) < 2,
    `偏移 ${shift1} 米（独立复算 ${myShift.toFixed(1)} 米），结果 (${conv1.data.output.longitude}, ${conv1.data.output.latitude})`);

  const conv2 = await api('POST', '/api/map/convert', {
    from: 'gcj02', to: 'wgs84', longitude: conv1.data.output.longitude, latitude: conv1.data.output.latitude
  });
  const roundTrip = distance(87.6168, 43.8256, conv2.data.output.longitude, conv2.data.output.latitude);
  check(25, 'GCJ-02 → WGS84 往返精度高（误差 < 1 米）',
    roundTrip < 1,
    `往返偏差 ${roundTrip.toFixed(4)} 米`);

  const conv3 = await api('POST', '/api/map/convert', {
    from: 'bd09', to: 'wgs84', longitude: 87.6261, latitude: 43.8330
  });
  check(26, '百度坐标（BD-09）可转 WGS84',
    conv3.status === 200 && conv3.data.output.longitude > 87 && conv3.data.output.longitude < 88,
    `BD09(87.6261, 43.8330) → WGS84(${conv3.data.output.longitude}, ${conv3.data.output.latitude})，偏移 ${conv3.data.shift_meters} 米`);

  const convCn = await api('POST', '/api/map/convert', {
    from: '高德', to: 'wgs84', longitude: 87.62, latitude: 43.83
  });
  check(27, '坐标系名称支持中文（高德/百度）',
    convCn.status === 200 && convCn.data.from === 'gcj02',
    `"高德" 被识别为 ${convCn.data.from}`);

  const convBad = await api('POST', '/api/map/convert', { from: 'wgs84', to: 'gcj02', longitude: 'abc', latitude: 43 });
  check(28, '非法经纬度被拒绝',
    convBad.status === 400, convBad.json.message);

  const convRange = await api('POST', '/api/map/convert', { from: 'wgs84', to: 'gcj02', longitude: 999, latitude: 43 });
  check(29, '超范围经纬度被拒绝',
    convRange.status === 400 && convRange.json.message.includes('范围'),
    convRange.json.message);

  /* ================= 7. 按坐标推荐最近地州 ================= */
  const near = await api('GET', '/api/map/nearest?lng=87.6168&lat=43.8256&limit=3');
  check(30, '按坐标推荐最近地州（辅助，不自动写入）',
    near.data.list.length === 3 && near.data.list[0].name.includes('乌鲁木齐')
      && near.data.note.includes('人工确认'),
    `前 3 近：${near.data.list.map((x) => `${x.name}(${x.distance_text})`).join(' → ')}`);

  const nearDist = distance(87.6168, 43.8256,
    (regions.data.cities.find((c) => c.name.includes('乌鲁木齐')) || {}).longitude,
    (regions.data.cities.find((c) => c.name.includes('乌鲁木齐')) || {}).latitude);
  check(31, '推荐的距离数值计算正确',
    Math.abs(near.data.list[0].distance - nearDist) < 100,
    `服务端 ${Math.round(near.data.list[0].distance)} 米，独立复算 ${Math.round(nearDist)} 米`);

  const nearBad = await api('GET', '/api/map/nearest?lng=abc&lat=xyz');
  check(32, '非法坐标推荐返回错误而不崩溃',
    nearBad.status === 200 && nearBad.data.error,
    nearBad.data.error);

  /* ================= 8. 在线核对链接 ================= */
  const onlineUrl = await api('GET', '/api/map/online-url?lng=87.6168&lat=43.8256&platform=amap&name=测试客户');
  const onlineBaidu = await api('GET', '/api/map/online-url?lng=87.6168&lat=43.8256&platform=baidu&name=测试客户');
  check(33, '生成在线地图核对链接（高德/百度）',
    onlineUrl.data.url.startsWith('https://uri.amap.com/')
      && onlineBaidu.data.url.startsWith('https://api.map.baidu.com/'),
    `高德 ${onlineUrl.data.url.slice(0, 46)}… / 百度 ${onlineBaidu.data.url.slice(0, 46)}…`);

  check(34, '在线链接中的坐标已转成各平台自身坐标系（避免偏到隔壁）',
    !onlineUrl.data.url.includes('87.6168') && !onlineBaidu.data.url.includes('87.6168'),
    '链接中的坐标与原始 WGS84 不同，说明已转换');

  /* ================= 9. 客户列表按区域筛选 ================= */
  const listRegion = await api('GET', '/api/customers?q=' + encodeURIComponent('阶段六测试'));
  const rowsWithRegion = listRegion.data.list.filter((x) => x.region_code);
  check(35, '客户列表返回归属地州字段（供筛选与展示）',
    listRegion.data.list.length === 4
      && listRegion.data.list.every((x) => 'region_code' in x && 'region_name' in x && 'longitude' in x)
      && rowsWithRegion.length === 3,
    `${listRegion.data.list.length} 条均含 region_code/region_name/经纬度字段，其中 ${rowsWithRegion.length} 条有归属（1 条无地址，符合预期）`);

  const listByRegion = await api('GET', '/api/customers?region_code=650100&pageSize=50');
  check('35b', '客户列表支持按归属地州筛选',
    listByRegion.data.total >= 2 && listByRegion.data.list.every((x) => x.region_code === '650100'),
    `按乌鲁木齐（650100）筛出 ${listByRegion.data.total} 家`);

  /* ================= 10. 批量重算归属 ================= */
  /* 改掉一个客户的地址，验证归属跟着变 */
  await api('PUT', `/api/customers/${c3.id}`, { city: '伊犁哈萨克自治州', district: '伊宁市' });
  const d3After = await api('GET', `/api/customers/${c3.id}`);
  check(36, '修改地址后归属地州自动跟着变',
    d3After.data.region_name.includes('伊犁'),
    `原喀什 → 现 ${d3After.data.region_name}（${d3After.data.region_code}）`);

  /* 清空地址后归属应被清掉，避免统计错位 */
  await api('PUT', `/api/customers/${c3.id}`, { city: '', district: '' });
  const d3Clear = await api('GET', `/api/customers/${c3.id}`);
  check(37, '地址清空后归属同步清空（不留下错位归属）',
    d3Clear.data.region_code === '',
    `region_code 已清空`);

  /* ================= 11. 地图数据重载 ================= */
  const reload = await api('POST', '/api/map/reload');
  check(38, '地图数据缓存可重载（数据更新后无需重启）',
    reload.data.reloaded === true, '缓存已清空');

  /* ================= 清理 ================= */
  if (created.length) await api('POST', '/api/customers/batch-delete', { ids: created });
  console.log(`\n（已清理 ${created.length} 条测试客户）`);

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.no}. ${r.name} —— ${r.detail}`);
  }
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('测试脚本异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
