/**
 * 造一批"看起来像真实业务"的演示数据，用于 UI 评审与截图。
 * 全部走接口写入，数据带「演示」前缀，便于一键清理。
 *
 * 用法：node tools/seed-demo-data.js
 */
'use strict';

const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';

async function api(method, p, body) {
  const opts = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json; charset=utf-8';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, opts);
  const json = await res.json().catch(() => null);
  if (!res.ok || (json && json.ok === false)) {
    throw new Error(`${method} ${p} → ${res.status} ${json && (json.code || json.message)}`);
  }
  return json && json.data;
}

const dayOffset = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/* 客户：覆盖多个地州、行业、等级，方便地图与图表出效果 */
const CUSTOMERS = [
  ['中国石油天然气股份有限公司独山子石化分公司', '独山子石化', '终端用户', '石油', 'A 重点客户', '已成交', '克拉玛依市', '独山子区', 84.8862, 44.3286, 1200, '中石化工程建设公司', '球阀,闸阀,止回阀', '框架协议', 1],
  ['新疆天业（集团）有限公司', '天业集团', '终端用户', '化工', 'A 重点客户', '跟进中', '石河子市', '', 86.0411, 44.3050, 860, '中国成达工程有限公司', '蝶阀,球阀', '年度框架', 1],
  ['宝钢集团新疆八一钢铁有限公司', '八一钢铁', '终端用户', '冶金', 'A 重点客户', '已成交', '乌鲁木齐市', '头屯河区', 87.4250, 43.8760, 720, '中冶京诚工程技术有限公司', '闸阀,截止阀', '框架协议', 1],
  ['新疆广汇新能源有限公司', '广汇新能源', '终端用户', '煤化工', 'B 普通客户', '跟进中', '哈密市', '伊州区', 93.5150, 42.8270, 540, '东华工程科技股份有限公司', '球阀,蝶阀', '项目制', 1],
  ['中泰化学阜康能源有限公司', '中泰化学', '终端用户', '化工', 'A 重点客户', '已成交', '昌吉回族自治州', '阜康市', 87.9830, 44.1570, 480, '中国天辰工程有限公司', '球阀,旋塞阀', '年度框架', 1],
  ['新疆油田公司克拉玛依油田', '克拉玛依油田', '终端用户', '石油', 'A 重点客户', '跟进中', '克拉玛依市', '克拉玛依区', 84.8900, 45.5800, 960, '中油工程设计有限公司', '闸阀,截止阀,止回阀', '框架协议', 1],
  ['特变电工新疆新能源股份有限公司', '特变电工', '终端用户', '电力', 'B 普通客户', '潜在', '昌吉回族自治州', '昌吉市', 87.3040, 44.0140, 320, '中国电力工程顾问集团', '球阀,蝶阀', '项目制', 0],
  ['新疆中核天山铀业有限公司', '中核天山', '终端用户', '矿业', 'B 普通客户', '跟进中', '伊犁哈萨克自治州', '伊宁市', 81.3240, 43.9160, 260, '中核第四研究设计工程有限公司', '闸阀,隔膜阀', '项目制', 1],
  ['新疆众和股份有限公司', '新疆众和', '终端用户', '有色', 'B 普通客户', '跟进中', '乌鲁木齐市', '新市区', 87.5700, 43.8600, 300, '贵阳铝镁设计研究院', '蝶阀,球阀', '年度框架', 0],
  ['新疆金风科技股份有限公司', '金风科技', '终端用户', '新能源', 'C 潜在客户', '潜在', '乌鲁木齐市', '头屯河区', 87.3900, 43.8500, 180, '金风科技工程设计院', '球阀,截止阀', '项目制', 0],
  ['中国石化塔河炼化有限责任公司', '塔河炼化', '终端用户', '石油', 'A 重点客户', '已成交', '阿克苏地区', '库车市', 82.9630, 41.7170, 890, '中石化洛阳工程有限公司', '闸阀,球阀,截止阀', '框架协议', 1],
  ['新疆宜化化工有限公司', '新疆宜化', '终端用户', '化工', 'B 普通客户', '跟进中', '昌吉回族自治州', '准东经济技术开发区', 88.9200, 44.7300, 420, '五环工程有限公司', '蝶阀,球阀', '框架协议', 1],
  ['中国石油乌鲁木齐石化公司', '乌鲁木齐石化', '终端用户', '石油', 'A 重点客户', '已成交', '乌鲁木齐市', '米东区', 87.6800, 43.9700, 1050, '中石油华东设计院', '闸阀,球阀,止回阀', '框架协议', 1],
  ['新疆喀什噶尔河水利枢纽管理局', '喀什水利', '市政水务单位', '水利', 'C 潜在客户', '潜在', '喀什地区', '喀什市', 75.9898, 39.4677, 150, '新疆水利水电勘测设计研究院', '蝶阀,闸阀', '项目制', 0],
  ['新疆伊犁钢铁有限责任公司', '伊犁钢铁', '终端用户', '冶金', 'B 普通客户', '跟进中', '伊犁哈萨克自治州', '伊宁县', 81.5300, 43.9700, 340, '中钢设备有限公司', '闸阀,蝶阀', '项目制', 1],
  ['新疆天富能源股份有限公司', '天富能源', '终端用户', '电力', 'B 普通客户', '跟进中', '石河子市', '', 86.0800, 44.3100, 280, '西北电力设计院', '球阀,截止阀', '年度框架', 0],
  ['新疆中油化工集团有限公司', '中油化工', '贸易商/经销商', '化工', 'C 潜在客户', '潜在', '乌鲁木齐市', '沙依巴克区', 87.5900, 43.8000, 200, '', '球阀,闸阀', '现货采购', 0],
  ['新疆昆仑工程咨询管理集团', '昆仑工程', '设计院', '石化工程', 'B 普通客户', '跟进中', '乌鲁木齐市', '天山区', 87.6168, 43.8256, 120, '', '球阀,蝶阀,闸阀', '项目制', 0],
  ['中石油新疆油田勘察设计研究院', '油田设计院', '设计院', '石油', 'A 重点客户', '已成交', '克拉玛依市', '克拉玛依区', 84.8700, 45.5900, 460, '', '闸阀,截止阀', '框架协议', 1],
  ['新疆塔里木油田分公司', '塔里木油田', '终端用户', '石油', 'A 重点客户', '跟进中', '巴音郭楞蒙古自治州', '库尔勒市', 86.1450, 41.7600, 1100, '中石油塔里木油田设计院', '球阀,闸阀,止回阀', '框架协议', 1],
  ['新疆阿克苏华锦化肥有限公司', '华锦化肥', '终端用户', '化工', 'C 潜在客户', '潜在', '阿克苏地区', '阿克苏市', 80.2600, 41.1700, 160, '中国寰球工程有限公司', '蝶阀,球阀', '项目制', 0],
  ['新疆吐鲁番雪银金属矿业', '雪银矿业', '终端用户', '矿业', 'C 潜在客户', '潜在', '吐鲁番市', '高昌区', 89.1900, 42.9500, 140, '', '闸阀,隔膜阀', '现货采购', 0],
  ['新疆博尔塔拉蒙古自治州水利局', '博州水利', '市政水务单位', '水利', 'C 潜在客户', '潜在', '博尔塔拉蒙古自治州', '博乐市', 82.0700, 44.9000, 130, '', '蝶阀,闸阀', '项目制', 0],
  ['新疆和田玉龙喀什水利水电公司', '和田水电', '市政水务单位', '水利', 'C 潜在客户', '潜在', '和田地区', '和田市', 79.9200, 37.1100, 110, '', '蝶阀,球阀', '项目制', 0],
  ['新疆阿勒泰正元国际矿业', '阿勒泰矿业', '终端用户', '矿业', 'C 潜在客户', '潜在', '阿勒泰地区', '阿勒泰市', 88.1400, 47.8500, 100, '', '闸阀,球阀', '现货采购', 0],
  ['新疆塔城地区乌苏化工园区', '乌苏化工园', '终端用户', '化工', 'C 潜在客户', '潜在', '塔城地区', '乌苏市', 84.6800, 44.4300, 170, '', '蝶阀,球阀', '项目制', 0],
  ['新疆克孜勒苏柯尔克孜自治州供水公司', '克州供水', '市政水务单位', '水利', 'C 潜在客户', '潜在', '克孜勒苏柯尔克孜自治州', '阿图什市', 76.1700, 39.7100, 90, '', '蝶阀', '项目制', 0]
];

const PROJECTS = [
  ['独山子石化 2026 年大修阀门采购', 0, '生产执行', 4860000, '已中标', -75, 30, '框架协议下的年度大修备件，重点保供'],
  ['天业集团 PVC 三期扩建阀门成套', 1, '投标/议价', 3260000, '已投标待开标', 4, 90, '参与技术交流两轮，方案已通过'],
  ['八一钢铁高炉煤气系统阀门更换', 2, '已中标/已签约', 2180000, '已中标', -40, 45, '合同已签，等待排产'],
  ['广汇新能源煤制气装置蝶阀采购', 3, '技术交流', 1450000, '未投标', 22, 120, '待业主确认技术规格书'],
  ['中泰化学阜康能源球阀年度框架', 4, '生产执行', 3920000, '已中标', -95, 15, '分批发货，第二批已排产'],
  ['克拉玛依油田注水系统闸阀更新', 5, '询价报价', 1760000, '未投标', 12, 100, '已提交报价，等待比价结果'],
  ['特变电工多晶硅项目阀门配套', 6, '初步接洽', 680000, '未投标', 30, 150, '初次接触，需提供业绩清单'],
  ['中核天山铀业隔膜阀采购', 7, '方案选型', 920000, '未投标', 18, 110, '对耐腐蚀材质有特殊要求'],
  ['新疆众和电极箔项目球阀采购', 8, '信息收集', 540000, '未投标', 40, 160, '项目前期，预计明年招标'],
  ['塔河炼化常减压装置阀门大修', 10, '质保期内', 2760000, '已中标', -200, -30, '已交付，跟踪质保期内使用情况'],
  ['乌鲁木齐石化乙烯装置球阀采购', 12, '已中标/已签约', 3340000, '已中标', -55, 20, '首批已发货，等待验收'],
  ['塔里木油田集输系统阀门框架', 19, '投标/议价', 4120000, '已投标待开标', 1, 80, '开标在即，做好答疑准备'],
  ['伊犁钢铁除尘系统蝶阀更换', 14, '项目暂停', 380000, '未投标', -20, 60, '业主资金未到位，暂停推进'],
  ['新疆天富能源热电阀门备件', 15, '初步接洽', 460000, '未投标', 26, 130, '需先入库成为合格供应商'],
  ['新疆宜化化工球阀年度供货', 11, '生产执行', 1980000, '已中标', -60, 10, '长协订单，按季度供货'],
  ['喀什水利枢纽蝶阀成套', 13, '信息收集', 1240000, '未投标', 55, 200, '项目可研阶段，需持续跟进'],
  ['新疆昆仑工程阀门选型咨询', 17, '技术交流', 260000, '未投标', 15, 95, '设计院推荐目录入库机会'],
  ['新疆金风科技风电项目阀门', 9, '已终止', 0, '未投标', -50, 0, '项目取消，已终止跟进'],
  ['新疆石油管理局老旧管网改造', 26, '信息收集', 320000, '未投标', 48, 180, '政府投资项目，关注招标公告'],
  ['新疆华锦化肥尿素装置阀门采购', 20, '初步接洽', 410000, '未投标', 35, 140, '等待业主技术交流安排']
];

(async () => {
  console.log('=== 生成演示数据 ===\n');

  /* 标签 */
  const tagNames = ['重点跟进', '老客户', '待开发', '战略客户'];
  const tagIds = [];
  for (const name of tagNames) {
    try {
      const t = await api('POST', '/api/tags', { name, color: '' });
      tagIds.push(t.id);
    } catch (_) { /* 已存在 */ }
  }
  const allTags = await api('GET', '/api/tags');
  console.log(`标签：${allTags.length} 个`);

  /* 客户 */
  const custIds = [];
  for (const c of CUSTOMERS) {
    const [name, short, type, industry, level, status, city, district, lng, lat, demand, design, valves, mode, ts] = c;
    const r = await api('POST', '/api/customers', {
      name: `[演示] ${name}`, short_name: short, type, industry, level, status,
      province: '新疆维吾尔自治区', city, district,
      longitude: lng, latitude: lat, annual_demand: demand,
      design_institute: design, end_user: name, valve_types: valves,
      purchase_mode: mode, drive_mode: '气动,电动', body_material: '碳钢 WCB,不锈钢 316L',
      pressure_rating: 'Class150,Class300', cert_required: '特种设备制造许可证 TS,API 6D',
      account_period: '月结60天', warranty_ratio: 10, warranty_months: 18,
      has_ts_license: ts, has_explosion_proof: ts,
      supplier_code: `SUP-${String(custIds.length + 1).padStart(4, '0')}`,
      phone: `099${1 + (custIds.length % 8)}-${String(2000000 + custIds.length * 137).slice(0, 7)}`,
      website: '', introducer: '李工',
      next_follow_at: dayOffset((custIds.length % 7) - 3) + ' 10:00:00',
      last_follow_at: dayOffset(-(custIds.length % 25) - 1) + ' 15:30:00',
      remark: '演示数据，用于界面评审'
    });
    custIds.push(r.id);
  }
  console.log(`客户：${custIds.length} 家`);

  /* 联系人 */
  const CONTACTS = [
    ['张建军', '采购部经理', '采购部', '关键决策'],
    ['李工', '设备工程师', '设备管理部', '技术把关'],
    ['王主任', '设备部主任', '设备管理部', '最终拍板'],
    ['刘敏', '采购专员', '采购部', '执行采购']
  ];
  let contactCount = 0;
  for (let i = 0; i < custIds.length; i++) {
    const n = 1 + (i % 3);
    for (let k = 0; k < n; k++) {
      const [nm, position, dept, influence] = CONTACTS[(i + k) % CONTACTS.length];
      await api('POST', '/api/contacts', {
        customer_id: custIds[i], name: nm, position, department: dept,
        mobile: `139${String(90000000 + i * 1000 + k).slice(0, 8)}`,
        phone: '', email: '', wechat: '',
        is_primary: k === 0 ? 1 : 0, is_decision: influence === '最终拍板' ? 1 : 0,
        influence, remark: ''
      });
      contactCount++;
    }
  }
  console.log(`联系人：${contactCount} 人`);

  /* 跟进记录 */
  const FOLLOWS = [
    ['电话', '已技术交流', '沟通了阀门材质要求，客户倾向于不锈钢 316L'],
    ['拜访', '已方案确认', '现场确认了安装空间与法兰标准，方案基本敲定'],
    ['微信', '需再跟进', '客户反馈预算尚未批复，下月再看'],
    ['邮件', '已报价', '已发送正式报价单，等待比价结果'],
    ['电话', '已成交', '客户确认下单，进入合同流程'],
    ['拜访', '已技术交流', '与设计院对接选型参数，推荐了 API 6D 球阀']
  ];
  let followCount = 0;
  for (let i = 0; i < custIds.length; i++) {
    const n = 1 + (i % 4);
    for (let k = 0; k < n; k++) {
      const [method, result, content] = FOLLOWS[(i + k) % FOLLOWS.length];
      await api('POST', '/api/followups', {
        customer_id: custIds[i], method, result, content,
        followed_at: dayOffset(-(k * 6 + (i % 5) + 1)) + ' 1' + (k % 8) + ':20:00',
        next_follow_at: k === 0 ? dayOffset((i % 9) - 4) + ' 10:00:00' : null
      });
      followCount++;
    }
  }
  console.log(`跟进记录：${followCount} 条`);

  /* 项目 */
  const projIds = [];
  for (const p of PROJECTS) {
    const [name, ci, stage, amount, bidResult, bidDay, deliveryDay, remark] = p;
    const r = await api('POST', '/api/projects', {
      name: `[演示] ${name}`, customer_id: custIds[ci], stage,
      contract_amount: amount,
      contract_no: amount > 0 ? `HT-2026-${String(projIds.length + 1).padStart(3, '0')}` : '',
      sign_date: ['已中标/已签约', '生产执行', '质保期内'].includes(stage) ? dayOffset(-120) : '',
      bid_date: dayOffset(bidDay), bid_result: bidResult,
      delivery_date: deliveryDay > 0 ? dayOffset(deliveryDay) : '',
      end_user: CUSTOMERS[ci][0], design_institute: CUSTOMERS[ci][11],
      valve_types: CUSTOMERS[ci][12], quantity: 20 + (projIds.length * 7),
      data_origin: '本人跟进', remark,
      owner: '我'
    });
    projIds.push(r.id);
  }
  console.log(`项目：${projIds.length} 个`);

  /* 回款计划与实收 */
  let payCount = 0;
  for (let i = 0; i < projIds.length; i++) {
    const amount = PROJECTS[i][3];
    if (!amount) continue;
    const stage = PROJECTS[i][2];
    const signed = ['已中标/已签约', '生产执行', '质保期内'].includes(stage);
    if (!signed) {
      // 未签约项目：只放一条近期计划，用于"即将到期"提醒
      if (i % 3 === 0) {
        await api('POST', '/api/payments', {
          project_id: projIds[i], type: '计划', amount: Math.round(amount * 0.3),
          plan_date: dayOffset(10 + i), method: '电汇', remark: '预付 30%'
        });
        payCount++;
      }
      continue;
    }
    // 签约项目：3 条计划 + 1~2 条实收
    const parts = [
      [0.3, -110 + (i % 7), '预付 30%'],
      [0.5, -40 + (i % 9), '发货前付 50%'],
      [0.2, 20 + (i % 15), '质保金 20%']
    ];
    for (const [ratio, day, remark] of parts) {
      await api('POST', '/api/payments', {
        project_id: projIds[i], type: '计划', amount: Math.round(amount * ratio),
        plan_date: dayOffset(day), method: '电汇', remark
      });
      payCount++;
    }
    const received = i % 3 === 0 ? [0.3] : (i % 3 === 1 ? [0.3, 0.5] : [0.3, 0.5, 0.2]);
    for (const ratio of received) {
      await api('POST', '/api/payments', {
        project_id: projIds[i], type: '实收', amount: Math.round(amount * ratio),
        actual_date: dayOffset(-100 + Math.round(ratio * 100)), method: '电汇', remark: '按合同节点收款'
      });
      payCount++;
    }
  }
  console.log(`回款记录：${payCount} 条`);

  /* 待办 */
  const TASKS = [
    ['整理独山子石化大修备件清单并回传', 0, 0, 2, '高'],
    ['天业集团技术协议盖章回传', 1, 1, 1, '高'],
    ['八一钢铁合同原件寄送并确认收货', 2, 2, 3, '中'],
    ['跟进广汇新能源技术规格书确认进度', 3, 3, 5, '中'],
    ['中泰化学第二批货排产确认', 4, 4, 4, '高'],
    ['克拉玛依油田报价答疑准备', 5, 5, 6, '中'],
    ['特变电工业绩清单与资质包整理', 6, null, 8, '低'],
    ['中核天山耐腐蚀材质选型方案', 7, null, 7, '中'],
    ['塔河炼化质保期内回访', 9, 9, -2, '低'],
    ['塔里木油田开标准备与答疑材料', 11, 11, 1, '高'],
    ['伊犁钢铁项目重启跟进', 12, 12, 20, '低'],
    ['金风科技入库资料提交', 8, null, 12, '中']
  ];
  for (const [title, ci, pi, day, priority] of TASKS) {
    await api('POST', '/api/tasks', {
      title: `[演示] ${title}`,
      customer_id: custIds[ci],
      project_id: pi === null ? null : projIds[pi],
      due_at: dayOffset(day) + ' 09:30:00',
      priority, status: day < -1 ? '已完成' : '待办', source: '手动', remark: ''
    });
  }
  console.log(`待办：${TASKS.length} 条`);

  /* 客户标签 */
  if (allTags.length) {
    for (let i = 0; i < custIds.length; i += 3) {
      await api('POST', '/api/customers/bulk-tag', {
        ids: [custIds[i]], tag_id: allTags[i % allTags.length].id
      }).catch(() => {});
    }
  }

  const stat = await api('GET', '/api/dashboard');
  console.log('\n--- 首页统计 ---');
  console.log(`客户 ${stat.cards.customer_total} 家 · 进行中项目 ${stat.cards.project_active} 个 · 本月回款 ${stat.cards.month_received}`);
  console.log('\n演示数据生成完成。清理：node tools/cleanup-test-data.js');
})().catch((e) => {
  console.error('生成演示数据失败：', e.message);
  process.exit(1);
});
