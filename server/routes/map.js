/**
 * 地图路由
 *
 * 提供：
 *   - 地图数据状态（未本地化时给出明确指引）
 *   - 行政区划清单
 *   - 客户分布统计（按地州 / 县市）
 *   - 某地州的客户明细
 *   - 坐标转换（供前端粘贴高德/百度坐标时使用）
 *   - 按坐标推荐最近地州（辅助，不自动写入）
 */

'use strict';

const mapService = require('../map/service');
const coord = require('../map/coord');

module.exports = async function mapRoutes(ctx) {
  const { db, method, pathname, query, body, root } = ctx;
  const segments = pathname.split('/').filter(Boolean);
  if (segments[1] !== 'map') return null;

  const ok = (data) => ({ ok: true, data });
  const fail = (status, code, message) => ({ ok: false, status, code, message });
  const sub = segments[2] || '';

  /* ---------- 地图数据状态 ---------- */
  if (sub === 'status' && method === 'GET') {
    return ok(mapService.status(root));
  }

  /* ---------- 行政区划清单 ---------- */
  if (sub === 'regions' && method === 'GET') {
    return ok(mapService.listRegions(db));
  }

  /* ---------- 客户分布统计 ---------- */
  if (sub === 'distribution' && method === 'GET') {
    return ok(mapService.distribution(db, {
      onlyWithCoords: query.onlyWithCoords === '1'
    }));
  }

  /* ---------- 某地州的客户明细 ---------- */
  if (sub === 'region-customers' && method === 'GET') {
    const code = query.code;
    if (!code) return fail(400, 'BAD_PARAM', '请提供行政区划代码 code');
    const r = mapService.regionCustomers(db, code, query.limit);
    if (!r) return fail(404, 'NOT_FOUND', '行政区划不存在：' + code);
    return ok(r);
  }

  /* ---------- 边界数据（前端注册 ECharts 地图用） ---------- */
  if (sub === 'geojson' && method === 'GET') {
    const code = query.code || '650000';
    const gj = mapService.geoJson(root, code);
    if (!gj) return fail(404, 'NOT_FOUND', `没有该层级的边界数据：${code}`);
    return ok(gj);
  }

  /* ---------- 按坐标推荐最近地州 ---------- */
  if (sub === 'nearest' && method === 'GET') {
    return ok(mapService.nearestRegions(db, query.lng, query.lat, query.limit));
  }

  /* ---------- 坐标转换 ---------- */
  if (sub === 'convert' && method === 'POST') {
    const p = body || {};
    const from = String(p.from || 'gcj02').toLowerCase();
    const to = String(p.to || 'wgs84').toLowerCase();
    const lng = Number(p.longitude);
    const lat = Number(p.latitude);

    if (!isFinite(lng) || !isFinite(lat)) {
      return fail(400, 'BAD_PARAM', '经纬度必须是数字');
    }
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
      return fail(400, 'BAD_PARAM', '经纬度超出有效范围');
    }

    /* 归一化坐标系名称 */
    const norm = (s) => {
      if (['gcj02', 'gcj', 'amap', 'gaode', '高德', '腾讯'].includes(s)) return 'gcj02';
      if (['bd09', 'bd', 'baidu', '百度'].includes(s)) return 'bd09';
      return 'wgs84';
    };
    const f = norm(from);
    const t = norm(to);

    /* 统一先转成 WGS84，再转目标坐标系 */
    const [wLng, wLat] = coord.toWgs84(lng, lat, f);
    const [oLng, oLat] = t === 'wgs84' ? [wLng, wLat] : coord.fromWgs84(wLng, wLat, t);

    return ok({
      from: f,
      to: t,
      input: { longitude: lng, latitude: lat },
      output: { longitude: Math.round(oLng * 1e7) / 1e7, latitude: Math.round(oLat * 1e7) / 1e7 },
      shift_meters: Math.round(coord.distanceMeters(lng, lat, oLng, oLat)),
      online_verify: coord.onlineMapUrl(wLng, wLat, 'amap', p.name || '坐标核对')
    });
  }

  /* ---------- 在线地图链接 ---------- */
  if (sub === 'online-url' && method === 'GET') {
    const lng = Number(query.lng);
    const lat = Number(query.lat);
    if (!isFinite(lng) || !isFinite(lat)) {
      return fail(400, 'BAD_PARAM', '请提供有效的 lng / lat');
    }
    const platform = query.platform || 'amap';
    /* 传入坐标默认视为 WGS84（库里存的就是 WGS84） */
    const [wLng, wLat] = coord.toWgs84(lng, lat, query.from || 'wgs84');
    return ok({
      platform,
      url: coord.onlineMapUrl(wLng, wLat, platform, query.name || '客户位置'),
      picker_url: coord.pickerUrl(platform, query.name || '')
    });
  }

  /* ---------- 清空地图数据缓存 ---------- */
  if (sub === 'reload' && method === 'POST') {
    mapService.clearCache();
    return ok({ reloaded: true });
  }

  return fail(404, 'API_NOT_FOUND', '接口不存在：' + pathname);
};
