/**
 * 招标信息抽取（零依赖）
 *
 * 输入：一封订阅邮件的解析结果（来自 mail.js）
 * 输出：结构化招标信息 + 命中判定 + 个人信息标记
 *
 * 设计原则（对应附录 A.4 与 A.7）：
 *   1. **只抽单位，不抽个人**：正文里出现的姓名/手机号/邮箱一律不进入结果，
 *      仅置 has_personal_info 标记，界面提示"原公告含联系人信息，请点原文查看"。
 *   2. **缺来源即丢弃**：抽不到原文链接的公告不产出结果（无法溯源的数据不入库）。
 *   3. **宁可少抽不可错抽**：字段抽不到就留空，绝不用推测值填充。
 *   4. **不做网络请求**：纯文本处理，邮件正文里的链接只作为来源记录，不主动访问。
 */
'use strict';

const mailUtil = require('./mail.js');

/* ------------------------------------------------------------------ */
/* 关键词与地区判定                                                    */
/* ------------------------------------------------------------------ */

/** 阀门相关关键词（命中任一即视为相关）
 * 顺序：具体阀种在前，"阀门"兜底在后 —— 这样关键词命中列表更有信息量，
 * 避免用"阀门采购"这类宽泛组合把具体阀种盖掉。 */
const VALVE_KEYWORDS = [
  '球阀', '闸阀', '蝶阀', '截止阀', '止回阀', '调节阀', '安全阀',
  '疏水阀', '隔膜阀', '旋塞阀', '减压阀', '电动阀', '气动阀',
  '阀体', '阀组', '阀站', '阀门井', '阀门'
];

/** 新疆地州（含常见简称），用于"只要新疆项目"过滤 */
const XINJIANG_REGIONS = [
  { code: '650100', name: '乌鲁木齐市', alias: ['乌鲁木齐'] },
  { code: '650200', name: '克拉玛依市', alias: ['克拉玛依', '独山子'] },
  { code: '650400', name: '吐鲁番市', alias: ['吐鲁番'] },
  { code: '650500', name: '哈密市', alias: ['哈密'] },
  { code: '652300', name: '昌吉回族自治州', alias: ['昌吉', '准东'] },
  { code: '652700', name: '博尔塔拉蒙古自治州', alias: ['博尔塔拉', '博州', '博乐'] },
  { code: '652800', name: '巴音郭楞蒙古自治州', alias: ['巴音郭楞', '巴州', '库尔勒'] },
  { code: '652900', name: '阿克苏地区', alias: ['阿克苏', '库车'] },
  { code: '653000', name: '克孜勒苏柯尔克孜自治州', alias: ['克孜勒苏', '克州', '阿图什'] },
  { code: '653100', name: '喀什地区', alias: ['喀什'] },
  { code: '653200', name: '和田地区', alias: ['和田'] },
  { code: '654000', name: '伊犁哈萨克自治州', alias: ['伊犁', '伊宁'] },
  { code: '654200', name: '塔城地区', alias: ['塔城', '乌苏', '沙湾'] },
  { code: '654300', name: '阿勒泰地区', alias: ['阿勒泰'] },
  { code: '659001', name: '石河子市', alias: ['石河子'] },
  { code: '659002', name: '阿拉尔市', alias: ['阿拉尔'] },
  { code: '659003', name: '图木舒克市', alias: ['图木舒克'] },
  { code: '659004', name: '五家渠市', alias: ['五家渠'] },
  { code: '659005', name: '北屯市', alias: ['北屯'] },
  { code: '659006', name: '铁门关市', alias: ['铁门关'] },
  { code: '659007', name: '双河市', alias: ['双河'] },
  { code: '659008', name: '可克达拉市', alias: ['可克达拉'] },
  { code: '659009', name: '昆玉市', alias: ['昆玉'] },
  { code: '659010', name: '胡杨河市', alias: ['胡杨河'] }
];

/** 非新疆省份特征词（用于排除，避免"新疆"二字出现在无关上下文时误判） */
const OTHER_PROVINCES = [
  '江苏', '浙江', '广东', '山东', '河南', '河北', '湖北', '湖南', '四川', '陕西',
  '甘肃', '宁夏', '青海', '内蒙古', '辽宁', '吉林', '黑龙江', '安徽', '福建', '江西',
  '山西', '云南', '贵州', '广西', '海南', '西藏', '北京', '上海', '天津', '重庆'
];

/** 公告类型 */
const NOTICE_TYPES = [
  ['招标公告', ['招标公告', '招标通告', '公开招标', '采购公告', '询价公告', '竞争性磋商', '资格预审']],
  ['澄清答疑', ['澄清', '答疑', '更正公告', '变更公告', '补遗']],
  ['中标候选人', ['中标候选人', '评标结果']],
  ['中标结果', ['中标结果', '中标公告', '成交公告', '成交结果']],
  ['异常公告', ['异常公告', '流标', '废标', '终止公告']]
];

/* ------------------------------------------------------------------ */
/* 字段抽取                                                            */
/* ------------------------------------------------------------------ */

/**
 * 按「标签：值」抽取。
 * 邮件正文（尤其 HTML 转文本后）通常形如：
 *   项目编号：E6500003901006789001
 *   招标控制价：人民币 328.50 万元
 * 标签可能出现在值的前面，也可能被制表符/空格分隔。
 */
function pickLabeled(text, labels, opt) {
  const o = opt || {};
  const maxLen = o.maxLen || 80;
  for (const label of labels) {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    /* 两种形态都要支持：
       - 纯文本邮件："项目编号：E650001"（值紧跟冒号）
       - HTML 表格转文本："项目编号：\tE650001"（值与标签被制表符隔开）
       因此冒号后的空白（含制表符）要吃掉，值本身再排除后续制表符。 */
    const re = new RegExp(esc + '[\\s\\t]*[:：]?[\\s\\t]*([^\\n\\t]{1,' + maxLen + '})', 'i');
    const m = text.match(re);
    if (m) {
      const v = clean(m[1]);
      if (v) return v;
    }
    /* 没有冒号的形态："招标控制价 人民币 328.50 万元" */
    const re2 = new RegExp(esc + '[\\s\\t]+([^\\n\\t:：]{1,' + maxLen + '})', 'i');
    const m2 = text.match(re2);
    if (m2) {
      const v = clean(m2[1]);
      /* 避免把后续标签本身当值（例如 "设计单位 招标人：xxx"） */
      if (v && !/^(招标人|采购人|代理机构|联系人|电话|地址|项目编号)$/.test(v)) return v;
    }
  }
  return '';
}

/** 清理抽取值：去尾部粘连的标签、多余空白、常见噪音 */
function clean(s) {
  let v = String(s || '').trim();
  /* 去掉行内后续的"招标人：xxx"之类粘连 */
  v = v.split(/[\s]{2,}/)[0];
  /* 去掉结尾的孤立标点 */
  v = v.replace(/[，,。；;、|]+$/, '').trim();
  /* 纯占位符或噪声 */
  if (/^(无|略|详见|见公告|—|-|\/|待定|另行通知)$/.test(v)) return '';
  /* 结尾像是下一个标签（以 XX：开头）就截掉 */
  const cut = v.search(/[\u4e00-\u9fa5]{2,6}[:：]/);
  if (cut > 0) v = v.slice(0, cut).trim();
  return v.replace(/[，,。；;、|]+$/, '').trim();
}

/** 项目编号 */
function pickProjectCode(text) {
  /* 先按标签 */
  const labeled = pickLabeled(text, ['项目编号', '招标编号', '采购编号', '标段编号', '招标项目编号', '公告编号', '项目代码'], { maxLen: 40 });
  if (labeled) return labeled;
  /* 再按形态：常见招标编号形如 XJSL-2026-GK-0087 / E6500003901006789001 */
  const m = text.match(/\b((?:[A-Z]{2,8}[-_])?\d{8,25}|[A-Z]{2,8}[-_]\d{4}[-_][A-Z]{2,4}[-_]\d{2,6})\b/);
  return m ? m[1] : '';
}

/** 项目名称 */
function pickProjectName(text, subject) {
  let v = pickLabeled(text, ['项目名称', '工程名称', '招标项目名称', '采购项目名称', '标段名称'], { maxLen: 90 });
  if (v) return v;
  v = pickLabeled(text, ['项目', '标的名称'], { maxLen: 90 });
  if (v) return v;
  /* 退化：用邮件主题，去掉【】前缀与"公告"后缀 */
  if (subject) {
    return subject.replace(/^【[^】]*】\s*/, '')
      .replace(/(公开)?(招标公告|采购公告|询价公告|中标公告|竞争性磋商公告)$/, '')
      .trim();
  }
  return '';
}

/** 金额（统一转成"元"） */
function pickAmount(text) {
  const labeled = pickLabeled(text, [
    '招标控制价', '招标控制价格', '最高限价', '预算金额', '采购预算', '合同估算价',
    '项目总投资', '投资额', '预算价', '概算金额', '控制价'
  ], { maxLen: 50 });
  const src = labeled || '';
  if (!src) {
    /* 无标签时，找正文里带金额单位的短语（保守：必须有"万元"或"元"） */
    const m = text.match(/(?:人民币)?\s*([0-9][0-9,，.]*)\s*(亿元|万元|万|元)/);
    return m ? toYuan(m[1], m[2]) : null;
  }
  const m = src.match(/([0-9][0-9,，.]*)\s*(亿元|万元|万|元)?/);
  if (!m) return null;
  /* 标签里没带单位时，看后续文本里的单位（例如"预算金额：1568000 元"） */
  let unit = m[2];
  if (!unit) {
    const after = src.slice(m.index + m[0].length);
    const u = after.match(/(亿元|万元|万|元)/);
    unit = u ? u[1] : '';
  }
  return toYuan(m[1], unit || '元');
}

/** 数额 + 单位 → 元 */
function toYuan(numStr, unit) {
  const n = Number(String(numStr).replace(/[,，]/g, ''));
  if (!isFinite(n) || n <= 0) return null;
  if (unit === '亿元') return Math.round(n * 1e8 * 100) / 100;
  if (unit === '万元' || unit === '万') return Math.round(n * 1e4 * 100) / 100;
  return Math.round(n * 100) / 100;
}

/** 地区：返回 { code, name, locationText } */
function pickRegion(text) {
  /* 文本里优先找"所在地区/建设地点/项目所在地"等标签值 */
  const labeled = pickLabeled(text, [
    '所在地区', '项目所在地区', '建设地点', '项目地点', '工程地点', '实施地点',
    '项目所在地', '交货地点', '所在省', '所在城市', '地区'
  ], { maxLen: 60 });
  const haystack = (labeled ? labeled + '\n' : '') + text;

  let best = null;
  for (const r of XINJIANG_REGIONS) {
    const names = [r.name, ...r.alias];
    for (const n of names) {
      const i = haystack.indexOf(n);
      if (i >= 0) {
        /* 命中越靠前、名字越长越可信；标签值内命中优先级最高 */
        const score = (labeled && labeled.includes(n) ? 1000 : 0) + n.length * 10 - Math.min(i, 500) / 100;
        if (!best || score > best.score) best = { code: r.code, name: r.name, score, hit: n, label: labeled };
      }
    }
  }
  if (!best) {
    /* 只提到"新疆"但没到地州 */
    if (/新疆/.test(haystack)) {
      return { code: '650000', name: '新疆维吾尔自治区', locationText: labeled, provinceOnly: true };
    }
    return null;
  }
  return { code: best.code, name: best.name, locationText: labeled, hit: best.hit };
}

/**
 * 是否属于新疆项目。
 * 规则：明确命中新疆地州 → 是；只命中"新疆"且未命中其他省份 → 是；
 *       同时出现多个外省且无新疆地州 → 判定为外省项目（排除）。
 */
function isXinjiang(region, text) {
  if (region && region.code && region.code !== '650000') return true;
  if (region && region.code === '650000') {
    const others = OTHER_PROVINCES.filter((p) => new RegExp(p).test(text));
    return others.length === 0;
  }
  /* 没有地区命中：再看正文有没有"新疆"字样 */
  if (!/新疆/.test(text)) return false;
  const others = OTHER_PROVINCES.filter((p) => new RegExp(p).test(text));
  return others.length === 0;
}

/** 阀门关键词命中 */
function pickKeywords(text) {
  const hits = [];
  for (const k of VALVE_KEYWORDS) {
    if (text.includes(k)) hits.push(k);
  }
  return [...new Set(hits)];
}

/** 单位类字段（只抽单位，不抽个人） */
function pickOrganizations(text) {
  return {
    tenderee: pickLabeled(text, ['招标人', '采购人', '招标单位', '建设单位', '采购单位', '招标人名称', '采购人名称'], { maxLen: 60 }),
    agency: pickLabeled(text, ['招标代理机构', '采购代理机构', '代理机构', '代理单位', '招标代理'], { maxLen: 60 }),
    design_institute: pickLabeled(text, ['设计单位', '设计院', '勘察设计单位', '设计人'], { maxLen: 60 })
  };
}

/** 时间字段 */
function pickDates(text) {
  const out = {};
  /* 投标/开标时间 */
  const bid = pickLabeled(text, ['投标截止时间', '递交截止时间', '开标时间', '投标文件递交截止时间', '响应文件递交截止时间'], { maxLen: 50 });
  out.bid_date = normalizeDate(bid) || '';
  /* 公告发布时间 */
  const pub = pickLabeled(text, ['公告发布时间', '发布时间', '公告日期', '发布日期', '公告时间'], { maxLen: 50 });
  out.publish_date = normalizeDate(pub) || '';
  return out;
}

/** 从任意字符串里抽日期，统一成 YYYY-MM-DD */
function normalizeDate(s) {
  if (!s) return '';
  const m = String(s).match(/(20\d{2})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/);
  if (!m) return '';
  const p = (x) => String(x).padStart(2, '0');
  return `${m[1]}-${p(m[2])}-${p(m[3])}`;
}

/** 公告类型 */
function pickNoticeType(text, subject) {
  const hay = (subject || '') + '\n' + text;
  for (const [name, words] of NOTICE_TYPES) {
    if (words.some((w) => hay.includes(w))) return name;
  }
  return '其他';
}

/* ------------------------------------------------------------------ */
/* 个人信息检测（只检测、不采集）                                       */
/* ------------------------------------------------------------------ */

/**
 * 检测正文中的个人信息，返回 { has, fields }。
 * fields 只记录**类型**，不记录具体值——避免个人信息进入库里。
 */
function detectPersonalInfo(text) {
  const fields = [];
  /* 手机号（中国大陆） */
  if (/(?<!\d)1[3-9]\d{9}(?!\d)/.test(text)) fields.push('手机号');
  /* 邮箱（非单位通用的个人邮箱也一并算，稳妥起见全部标记） */
  if (/[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/.test(text)) fields.push('邮箱');
  /* 联系人/负责人 + 姓名（2~4 个汉字） */
  if (/(?:联系人|项目负责人|项目经理|报名联系人|技术负责人|招标联系人)\s*[:：]?\s*[\u4e00-\u9fa5]{2,4}/.test(text)) {
    fields.push('联系人姓名');
  }
  /* 身份证 */
  if (/(?<!\d)\d{17}[\dXx](?!\d)/.test(text)) fields.push('身份证号');
  /* 座机（区号-号码） */
  if (/\(?0\d{2,3}\)?[- ]?\d{7,8}/.test(text)) fields.push('固定电话');
  return { has: fields.length > 0, fields: [...new Set(fields)] };
}

/* ------------------------------------------------------------------ */
/* 客户匹配                                                            */
/* ------------------------------------------------------------------ */

/**
 * 与库内客户 / 设计院 / 最终用户做名称匹配打分。
 * @param {object} info    抽出的信息
 * @param {Array} customers [{id, name, short_name, design_institute, end_user}]
 * @returns {{customer: string, score: number, reason: string}}
 */
function matchCustomer(info, customers) {
  const hay = [info.tenderee, info.project_name, info.title, info.agency, info.design_institute]
    .filter(Boolean).join(' ');
  if (!hay) return { customer: '', score: 0, reason: '' };

  let best = { customer: '', score: 0, reason: '' };
  for (const c of customers || []) {
    let score = 0;
    const reasons = [];
    const names = [
      { v: c.name, w: 70, label: '招标人/项目名含客户全称' },
      { v: c.short_name, w: 45, label: '招标人/项目名含客户简称' },
      { v: c.end_user, w: 35, label: '最终用户匹配' },
      { v: c.design_institute, w: 30, label: '设计院匹配' }
    ];
    for (const n of names) {
      const v = String(n.v || '').trim();
      if (v.length < 3) continue;              // 太短容易误命中
      if (hay.includes(v)) { score += n.w; reasons.push(n.label); }
    }
    /* 地区一致再加分 */
    if (c.region_code && info.region_code && c.region_code === info.region_code) {
      score += 10; reasons.push('同地州');
    }
    if (score > best.score) {
      best = { customer: c.short_name || c.name, score, reason: reasons.join(' + ') };
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/**
 * 从一封邮件抽取招标信息。
 * @param {object} parsed      mail.parseMail 的结果
 * @param {object} opt
 *   sourceName, keywords(数组，默认阀门词), customers(库内客户列表),
 *   requireXinjiang(默认 true)
 * @returns {object|null} 不符合条件的返回 null，并给出原因
 */
function extractFromMail(parsed, opt) {
  const o = opt || {};
  const text = String(parsed.text || '');
  const subject = String(parsed.subject || '');
  const hay = subject + '\n' + text;

  const reject = (reason) => ({ ok: false, reason });

  /* 1) 必须有原文链接（无来源的数据一律不入库） */
  const urls = (parsed.links || []).filter((u) => !/unsubscribe|退订|\.(png|jpg|gif|css|js)$/i.test(u));
  if (!urls.length) return reject('缺少原文链接，无法溯源');

  /* 2) 关键词过滤：默认只收阀门相关 */
  const keywords = o.keywords && o.keywords.length ? o.keywords : VALVE_KEYWORDS;
  const hits = keywords.filter((k) => hay.includes(k));
  if (!hits.length) return reject('未命中阀门相关关键词');

  /* 3) 地区过滤：默认只收新疆项目 */
  const region = pickRegion(text);
  if (o.requireXinjiang !== false && !isXinjiang(region, text)) {
    return reject('非新疆本地项目');
  }

  /* 4) 字段抽取 */
  const orgs = pickOrganizations(text);
  const dates = pickDates(text);
  const amount = pickAmount(text);
  const personal = detectPersonalInfo(text);

  const info = {
    title: subject || pickProjectName(text, subject),
    project_name: pickProjectName(text, subject),
    project_code: pickProjectCode(text),
    region_code: region ? region.code : '',
    region_name: region ? region.name : '',
    location: region ? (region.locationText || '') : '',
    amount,
    industry: pickIndustry(hay),
    tenderee: orgs.tenderee,
    agency: orgs.agency,
    design_institute: orgs.design_institute,
    bid_date: dates.bid_date,
    publish_date: dates.publish_date,
    notice_type: pickNoticeType(text, subject),
    source_url: urls[0],
    source_platform: o.sourceName || '',
    keyword_hits: hits,
    has_personal_info: personal.has,
    personal_fields: personal.fields,
    raw_excerpt: buildExcerpt(text),
    match: matchCustomer({
      tenderee: orgs.tenderee,
      project_name: pickProjectName(text, subject),
      title: subject,
      agency: orgs.agency,
      design_institute: orgs.design_institute,
      region_code: region ? region.code : ''
    }, o.customers || [])
  };

  return { ok: true, info };
}

/** 从文本推断行业（用于与客户画像对齐） */
function pickIndustry(text) {
  const MAP = [
    ['石油', ['石油', '石化', '炼化', '油田', '油气', '天然气']],
    ['化工', ['化工', '化学', '煤化工', '化肥', 'PVC', '氯碱']],
    ['冶金', ['冶金', '钢铁', '有色', '铝业', '冶炼']],
    ['电力', ['电力', '电厂', '热电', '发电', '新能源']],
    ['水利', ['水利', '水务', '供水', '灌区', '水库', '引水']],
    ['矿业', ['矿业', '矿山', '煤业', '铀业']],
    ['煤化工', ['煤制气', '煤制油', '煤化工']],
    ['市政', ['市政', '污水处理', '供热', '燃气']]
  ];
  const hits = [];
  for (const [name, words] of MAP) {
    if (words.some((w) => text.includes(w))) hits.push(name);
  }
  return hits[0] || '';
}

/** 生成正文摘要（截断，去掉个人信息片段） */
function buildExcerpt(text, maxLen) {
  const max = maxLen || 300;
  /* 逐行剔除含个人信息的行，避免摘要里带出姓名/手机号 */
  const lines = String(text).split('\n').filter((l) => {
    if (/(?<!\d)1[3-9]\d{9}(?!\d)/.test(l)) return false;
    if (/(?:联系人|项目负责人|项目经理|报名联系人)\s*[:：]/.test(l)) return false;
    if (/[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/.test(l)) return false;
    return l.trim().length > 0;
  });
  return lines.join('\n').slice(0, max).trim();
}

/** 内容指纹：用于"内容有变才覆盖"的增量判定 */
function contentHash(info) {
  const parts = [
    info.project_name, info.project_code, info.amount == null ? '' : info.amount,
    info.tenderee, info.bid_date, info.region_code, info.notice_type
  ].map((x) => String(x == null ? '' : x).trim());
  /* 用 Node 内置 crypto 做稳定哈希 */
  const crypto = require('node:crypto');
  return crypto.createHash('sha1').update(parts.join('\u0001')).digest('hex').slice(0, 16);
}

/** 去重键：优先公告编号，其次来源 URL */
function noticeKey(info) {
  if (info.project_code) return 'code:' + info.project_code;
  if (info.source_url) return 'url:' + info.source_url;
  return '';
}

module.exports = {
  VALVE_KEYWORDS,
  XINJIANG_REGIONS,
  NOTICE_TYPES,
  extractFromMail,
  detectPersonalInfo,
  matchCustomer,
  pickRegion,
  isXinjiang,
  pickKeywords,
  pickAmount,
  toYuan,
  normalizeDate,
  contentHash,
  noticeKey,
  buildExcerpt,
  pickLabeled
};
