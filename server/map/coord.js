/**
 * 中国坐标系转换（纯本地算法，不联网、不依赖任何服务）
 *
 * 三种坐标系：
 *   WGS84  —— GPS 原始坐标、GeoJSON 边界数据用的坐标系
 *   GCJ-02 —— 国测局坐标（高德 / 腾讯 / 谷歌中国 使用）
 *   BD-09  —— 百度坐标（在 GCJ-02 基础上再偏移）
 *
 * 为什么必须转换：
 *   地图边界数据是 WGS84，而从高德/百度复制来的坐标是 GCJ-02/BD-09。
 *   若直接混用，会出现几百米的偏移——在地图上就是"标到隔壁厂区"。
 *
 * 算法说明：GCJ-02 是公开的加密偏移算法（各家实现一致），
 *          这里使用业界通用的公开实现，精度对"看客户分布"完全足够。
 */

'use strict';

const X_PI = Math.PI * 3000.0 / 180.0;
const PI = Math.PI;
const A = 6378245.0;              // 克拉索夫斯基椭球长半轴
const EE = 0.00669342162296594323; // 偏心率平方

/** 是否在中国境外（境外不做偏移） */
function outOfChina(lng, lat) {
  return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55);
}

function transformLat(lng, lat) {
  let ret = -100.0 + 2.0 * lng + 3.0 * lat + 0.2 * lat * lat + 0.1 * lng * lat + 0.2 * Math.sqrt(Math.abs(lng));
  ret += (20.0 * Math.sin(6.0 * lng * PI) + 20.0 * Math.sin(2.0 * lng * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(lat * PI) + 40.0 * Math.sin(lat / 3.0 * PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(lat / 12.0 * PI) + 320 * Math.sin(lat * PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(lng, lat) {
  let ret = 300.0 + lng + 2.0 * lat + 0.1 * lng * lng + 0.1 * lng * lat + 0.1 * Math.sqrt(Math.abs(lng));
  ret += (20.0 * Math.sin(6.0 * lng * PI) + 20.0 * Math.sin(2.0 * lng * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(lng * PI) + 40.0 * Math.sin(lng / 3.0 * PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(lng / 12.0 * PI) + 300.0 * Math.sin(lng / 30.0 * PI)) * 2.0 / 3.0;
  return ret;
}

/* ------------------------------------------------------------------ */
/* WGS84 ↔ GCJ-02                                                      */
/* ------------------------------------------------------------------ */

function wgs84ToGcj02(lng, lat) {
  if (outOfChina(lng, lat)) return [lng, lat];
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI);
  dLng = (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * PI);
  return [lng + dLng, lat + dLat];
}

function gcj02ToWgs84(lng, lat) {
  if (outOfChina(lng, lat)) return [lng, lat];
  /* 一次线性反解后迭代逼近，精度可达厘米级 */
  const [gLng, gLat] = wgs84ToGcj02(lng, lat);
  let dLng = gLng - lng;
  let dLat = gLat - lat;
  let wLng = lng - dLng;
  let wLat = lat - dLat;
  for (let i = 0; i < 3; i++) {
    const [tLng, tLat] = wgs84ToGcj02(wLng, wLat);
    const eLng = tLng - lng;
    const eLat = tLat - lat;
    if (Math.abs(eLng) < 1e-8 && Math.abs(eLat) < 1e-8) break;
    wLng -= eLng;
    wLat -= eLat;
  }
  return [wLng, wLat];
}

/* ------------------------------------------------------------------ */
/* GCJ-02 ↔ BD-09                                                      */
/* ------------------------------------------------------------------ */

function gcj02ToBd09(lng, lat) {
  const z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * X_PI);
  const theta = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * X_PI);
  return [z * Math.cos(theta) + 0.0065, z * Math.sin(theta) + 0.006];
}

function bd09ToGcj02(lng, lat) {
  const x = lng - 0.0065;
  const y = lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
  return [z * Math.cos(theta), z * Math.sin(theta)];
}

/* ------------------------------------------------------------------ */
/* 统一入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 任意坐标系 → WGS84（地图渲染统一用 WGS84）
 * @param {number} lng
 * @param {number} lat
 * @param {string} from 'wgs84' | 'gcj02' | 'bd09'
 * @returns {[number, number]}
 */
function toWgs84(lng, lat, from) {
  const a = Number(lng);
  const b = Number(lat);
  if (!isFinite(a) || !isFinite(b)) return [null, null];
  const f = String(from || 'wgs84').toLowerCase();
  if (f === 'gcj02' || f === 'gcj' || f === 'amap' || f === 'gaode') return gcj02ToWgs84(a, b);
  if (f === 'bd09' || f === 'bd' || f === 'baidu') {
    const [gLng, gLat] = bd09ToGcj02(a, b);
    return gcj02ToWgs84(gLng, gLat);
  }
  return [a, b];
}

/** WGS84 → 指定坐标系（用于生成跳转链接） */
function fromWgs84(lng, lat, to) {
  const a = Number(lng);
  const b = Number(lat);
  if (!isFinite(a) || !isFinite(b)) return [null, null];
  const t = String(to || 'wgs84').toLowerCase();
  if (t === 'gcj02' || t === 'gcj' || t === 'amap' || t === 'gaode') return wgs84ToGcj02(a, b);
  if (t === 'bd09' || t === 'bd' || t === 'baidu') return gcj02ToBd09(...wgs84ToGcj02(a, b));
  return [a, b];
}

/**
 * 两个坐标点之间的球面距离（米）
 * 用于「按坐标推荐最近的地州」
 */
function distanceMeters(lng1, lat1, lng2, lat2) {
  const R = 6371008.8;
  const toRad = (d) => d * PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * 格式化距离显示
 */
function formatDistance(m) {
  const v = Number(m);
  if (!isFinite(v)) return '';
  if (v < 1000) return `${Math.round(v)} 米`;
  if (v < 10000) return `${(v / 1000).toFixed(1)} 公里`;
  return `${Math.round(v / 1000)} 公里`;
}

/**
 * 生成在线地图核对链接（用于人工验证坐标是否正确）
 * 注意：这里必须把 WGS84 转成目标平台自己的坐标系，否则对方地图上会偏。
 */
function onlineMapUrl(lng, lat, platform, name) {
  const a = Number(lng);
  const b = Number(lat);
  if (!isFinite(a) || !isFinite(b)) return null;
  const label = encodeURIComponent(name || '客户位置');
  const p = String(platform || 'amap').toLowerCase();

  if (p === 'baidu') {
    const [x, y] = fromWgs84(a, b, 'bd09');
    return `https://api.map.baidu.com/marker?location=${y},${x}&title=${label}&content=${label}&output=html&coord_type=bd09ll`;
  }
  /* 默认高德：使用 uri 协议，可在浏览器打开 */
  const [x, y] = fromWgs84(a, b, 'gcj02');
  return `https://uri.amap.com/marker?position=${x},${y}&name=${label}&coordinate=gaode&callnative=0`;
}

/** 生成坐标拾取器链接（复制坐标回来用） */
function pickerUrl(platform, keyword) {
  const p = String(platform || 'amap').toLowerCase();
  const kw = encodeURIComponent(keyword || '');
  if (p === 'baidu') {
    return `https://api.map.baidu.com/geocoder?address=${kw}&output=html&src=webapp.crm`;
  }
  return `https://lbs.amap.com/tools/picker`;
}

module.exports = {
  outOfChina,
  wgs84ToGcj02,
  gcj02ToWgs84,
  gcj02ToBd09,
  bd09ToGcj02,
  toWgs84,
  fromWgs84,
  distanceMeters,
  formatDistance,
  onlineMapUrl,
  pickerUrl
};
