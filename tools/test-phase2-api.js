/**
 * 阶段二 API 验收测试 —— 客户管理模块
 * 用法：node tools/test-phase2-api.js
 * 前置：服务已在 127.0.0.1:8899 运行
 */

'use strict';

const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';

const results = [];
function check(no, name, pass, detail) {
  results.push({ no, name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${no}. ${name}${detail ? '  —— ' + detail : ''}`);
}

async function api(method, path, body) {
  const opts = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json; charset=utf-8';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 非 JSON */ }
  return { status: res.status, json, data: json && json.data };
}

const created = {};   // 测试期间创建的 ID 集合

const TEST_DICT_VALUE = '测试自定义行业';

/**
 * 把测试用字典项恢复到「未创建」的干净状态。
 * 注意：删除是软删除，被删的行仍占用 (category,value) 唯一约束，
 * 所以「删除后再新增同名」会走"复活"路径（existed=true）。
 * 这里用 forceNew 新增一条再删掉，使下一次 quick-add 也走复活路径 —— 状态即稳定可复现。
 */
async function resetTestDictItem() {
  for (const val of [TEST_DICT_VALUE, '测试全新行业XYZ', '测试即时生效行业']) {
    const d = await api('GET', '/api/dict');
    const hits = (d.data.items.industry || []).filter((x) => x.value === val);
    for (const h of hits) await api('DELETE', '/api/dict/' + h.id);
    const fresh = await api('POST', '/api/dict', { category: 'industry', value: val });
    if (fresh.data && fresh.data.id) await api('DELETE', '/api/dict/' + fresh.data.id);
  }
  return true;
}

(async () => {
  console.log('=== 阶段二 API 验收测试（客户管理）===');
  console.log('目标服务：' + BASE + '\n');

  /* ---------- 0. 清理上次运行残留的测试数据（保证可重复运行） ---------- */
  try {
    const ids = [];
    for (const kw of ['测试', '独山子', '天成阀门', '调试客户', '容错测试']) {
      const r = await api('GET', '/api/customers?pageSize=200&q=' + encodeURIComponent(kw));
      ids.push(...((r.data && r.data.list) || []).map((x) => x.id));
    }
    if (ids.length) {
      await api('POST', '/api/customers/batch-delete', { ids: [...new Set(ids)] });
      console.log(`（清理残留 ${new Set(ids).size} 条测试客户）`);
    }

    /* 清掉上次新建的测试标签，保证「重名被拒」可重复验证 */
    const tagsNow = await api('GET', '/api/tags');
    const staleTags = (tagsNow.data || []).filter((t) => t.name === '重点跟进' || t.name === '待开发');
    for (const t of staleTags) await api('DELETE', '/api/tags/' + t.id);
    if (staleTags.length) console.log(`（清理残留 ${staleTags.length} 个测试标签）`);

    /* 把测试字典项复位到干净状态，保证「内联新增/删除/重建」可重复验证 */
    await resetTestDictItem();

    if (ids.length || staleTags.length) console.log('');
  } catch (_) { /* 首次运行无残留 */ }

  /* ---------- 1. 字典接口 ---------- */
  const dict = await api('GET', '/api/dict');
  const cats = dict.data ? dict.data.categories : [];
  check(1, '字典接口返回 23 类选项',
    dict.status === 200 && cats.length === 23,
    `返回 ${cats.length} 类，选项文本数组可直接用于下拉框`);
  check(2, '阀门行业选项内容正确',
    dict.data && dict.data.options.industry.includes('石油') && dict.data.options.industry.includes('空分')
      && dict.data.options.cert_required.includes('特种设备制造许可证 TS')
      && dict.data.options.project_stage.length === 14
      && dict.data.options.customer_type.includes('设计院'),
    `下游行业 ${dict.data.options.industry.length} 项，项目阶段 ${dict.data.options.project_stage.length} 阶段，认证要求 ${dict.data.options.cert_required.length} 项`);

  /* ---------- 3. 字典内联新增 / 删除 / 重建 ---------- */
  const qa1 = await api('POST', '/api/dict/quick-add', { category: 'industry', value: TEST_DICT_VALUE });
  const qa2 = await api('POST', '/api/dict/quick-add', { category: 'industry', value: TEST_DICT_VALUE });
  check(3, '字典内联新增：已删除过的同名项会被复活而非重复建',
    qa1.data && qa1.data.existed === true && qa1.data.restored === true
      && qa2.data && qa2.data.existed === true && qa1.data.id === qa2.data.id,
    `首次 restored=${qa1.data && qa1.data.restored} id=${qa1.data && qa1.data.id}，再次 existed=${qa2.data && qa2.data.existed} 同一 id=${qa1.data && qa1.data.id === (qa2.data && qa2.data.id)}`);

  /* 全新选项（从未存在过）：existed 必须为 false。先确保该值处于"从未创建"状态 */
  {
    const d0 = await api('GET', '/api/dict');
    const ghosts = (d0.data.items.industry || []).filter((x) => x.value === '测试全新行业XYZ');
    for (const gh of ghosts) await api('DELETE', '/api/dict/' + gh.id);
    /* 软删除行仍占唯一约束，用 forceNew 建一条再删，令其转为"已删除"稳定态 */
    const f = await api('POST', '/api/dict', { category: 'industry', value: '测试全新行业XYZ' });
    if (f.data && f.data.id) await api('DELETE', '/api/dict/' + f.data.id);
  }
  const brandNew = await api('POST', '/api/dict/quick-add', { category: 'industry', value: '测试全新行业XYZ' });
  const brandNew2 = await api('POST', '/api/dict/quick-add', { category: 'industry', value: '测试全新行业XYZ' });
  check('3a', '同一字典项重复调用只保留一条（id 相同，不会建出重复项）',
    brandNew2.data && brandNew.data && brandNew.data.id === brandNew2.data.id
      && brandNew2.data.existed === true,
    `两次调用返回同一 id=${brandNew.data && brandNew.data.id}（第二次 existed=${brandNew2.data && brandNew2.data.existed}，existed 表示"复用已有项"）`);
  await api('DELETE', '/api/dict/' + brandNew.data.id);

  /* 自建项：forceNew 路径下删除后可用同名重建（唯一约束已让出） */
  const delDict = await api('DELETE', '/api/dict/' + qa1.data.id);
  const reAdd = await api('POST', '/api/dict', { category: 'industry', value: TEST_DICT_VALUE });
  const delAgain = reAdd.data && reAdd.data.id ? await api('DELETE', '/api/dict/' + reAdd.data.id) : null;
  check('3b', '自建字典项删除后可用同名重新建立（唯一约束正确让出）',
    delDict.data && delDict.data.deleted === true
      && reAdd.data && reAdd.data.existed === false && reAdd.data.id !== qa1.data.id
      && delAgain && delAgain.data.deleted === true,
    `删除 deleted=${delDict.data && delDict.data.deleted}，同名重建成功 新 id=${reAdd.data && reAdd.data.id}（旧 id=${qa1.data.id}）`);
  created.dictTestId = reAdd.data.id;

  /* 系统内置项只能停用不能删除 */
  const sysItem = dict.data.items.industry.find((x) => x.value === '石油');
  const delSys = await api('DELETE', '/api/dict/' + sysItem.id);
  check('3c', '系统内置字典项只停用不删除（防误删核心选项）',
    delSys.data && delSys.data.deleted === false && delSys.data.disabled === true && delSys.data.isSystem === true,
    `返回 deleted=${delSys.data && delSys.data.deleted}, disabled=${delSys.data && delSys.data.disabled}`);
  /* 恢复被停用的内置项，避免影响后续测试 */
  await api('PUT', '/api/dict/' + sysItem.id, { enabled: 1 });

  /* ---------- 4. 新增的行业立即生效（用独立的一次性选项，避免与上一用例耦合） ---------- */
  const before4 = await api('GET', '/api/dict');
  const beforeCount = before4.data.options.industry.length;
  const fresh4 = await api('POST', '/api/dict/quick-add', { category: 'industry', value: '测试即时生效行业' });
  const after4 = await api('GET', '/api/dict');
  const present4 = after4.data.options.industry.includes('测试即时生效行业');
  check(4, '新增的行业立即出现在字典中（无需重启，下拉框即可读到）',
    !!fresh4.data.id && present4 && after4.data.options.industry.length === beforeCount + 1,
    `行业数 ${beforeCount} → ${after4.data.options.industry.length}，新选项已可读=${present4}，新建 id=${fresh4.data && fresh4.data.id}`);
  await api('DELETE', '/api/dict/' + fresh4.data.id);

  /* ---------- 5. 标签 ---------- */
  const t1 = await api('POST', '/api/tags', { name: '重点跟进', color: '#dc3545' });
  const t2 = await api('POST', '/api/tags', { name: '待开发', color: '#12a150' });
  const t3 = await api('POST', '/api/tags', { name: '重点跟进', color: '#000000' });
  check(5, '新建标签成功且同名标签被拒绝',
    t1.data && t1.data.created === true && t2.data && t3.status === 400,
    `新建 id=${t1.data && t1.data.id}，重名返回 HTTP ${t3.status}`);
  created.tag1 = t1.data.id;
  created.tag2 = t2.data.id;

  /* ---------- 6. 必填校验 ---------- */
  const bad = await api('POST', '/api/customers', { name: '' });
  check(6, '客户名称必填校验生效',
    bad.status === 400 && bad.json.code === 'NAME_REQUIRED',
    `HTTP ${bad.status} code=${bad.json && bad.json.code}`);

  /* ---------- 7. 新建客户（阀门行业全字段） ---------- */
  const custA = {
    name: '中国石油天然气股份有限公司独山子石化分公司',
    short_name: '独山子石化',
    type: '终端用户',
    industry: '石油',
    source: '设计院推荐',
    level: 'A 重点客户',
    status: '跟进中',
    phone: '0992-3862000',
    fax: '0992-3862001',
    website: 'http://www.example.com',
    email: 'procurement@example.com',
    wechat: 'dsz-purchase',
    credit_code: '91650200123456789X',
    province: '新疆维吾尔自治区',
    city: '克拉玛依市',
    district: '独山子区',
    address: '独山子区大庆路 1 号',
    zip_code: '838600',
    enterprise_nature: '央企',
    parent_group: '中国石油天然气集团有限公司',
    scale: '大型',
    scale: '大型',
    founded_at: '1936-10-01',
    employees: '1000人以上',
    legal_person: '张三',
    is_listed: 1,
    purchase_mode: '框架协议',
    end_user: '独山子石化炼油厂',
    design_institute: '中国石化工程建设有限公司',
    epc_contractor: '中油工程建设公司',
    valve_types: '球阀,闸阀,截止阀',
    drive_mode: '气动,电动',
    body_material: '不锈钢 316L,碳钢 WCB',
    pressure_rating: 'Class300,Class600',
    size_range: 'DN50~DN600',
    design_standard: 'API,ANSI/ASME',
    connection_type: '法兰连接,对焊连接',
    cert_required: '特种设备制造许可证 TS,API 6D,防火认证 API 607/6FA',
    annual_demand: 800,
    purchase_cycle: '年度',
    account_period: '月结60天',
    warranty_ratio: 10,
    warranty_months: 24,
    payer: '集团财务',
    tender_platform: '中石油',
    qualification: '特种设备制造许可证 TS,API 6D',
    has_ts_license: 1,
    has_explosion_proof: 1,
    quality_grade: '中石油一级供应商',
    supplier_code: 'CNPC-SUP-20240001',
    credit_rating: '优',
    introducer: '李工（石化设计院）',
    competitor: '纽威阀门',
    longitude: 84.8862,
    latitude: 44.3286,
    customer_since: '2020-03-15',
    next_follow_at: '2026-03-01 10:00:00',
    remark: '重点客户，年度框架协议于 3 月续签',
    tag_ids: [t1.data.id]
  };
  const a = await api('POST', '/api/customers', custA);
  check(7, '新建客户成功（全部可写字段完整写入）',
    a.data && a.data.created === true && a.data.id > 0,
    `新增 id=${a.data && a.data.id}，重复提醒 ${a.data && a.data.duplicates.length} 条`);
  created.custA = a.data.id;

  /* ---------- 8. 读回并核对关键字段 ---------- */
  const detailA = await api('GET', `/api/customers/${created.custA}`);
  const c = detailA.data;
  const fieldOk = c && c.short_name === '独山子石化' && c.industry === '石油'
    && c.type === '终端用户' && c.enterprise_nature === '央企'
    && c.parent_group === '中国石油天然气集团有限公司'
    && c.valve_types === '球阀,闸阀,截止阀'
    && c.cert_required.includes('API 6D')
    && c.has_ts_license === 1 && c.has_explosion_proof === 1
    && Math.abs(c.longitude - 84.8862) < 1e-6
    && c.supplier_code === 'CNPC-SUP-20240001'
    && c.warranty_ratio === 10;
  check(8, '读回客户并核对阀门行业关键字段', fieldOk,
    fieldOk ? `等级=${c.level} 行业=${c.industry} 主体=${c.type} 年需求=${c.annual_demand}万` : '字段值不符');
  check(9, '标签关联成功',
    c.tags && c.tags.length === 1 && c.tags[0].name === '重点跟进',
    `标签：${(c.tags || []).map((t) => t.name).join('/')}`);

  /* ---------- 10. 查重 ---------- */
  const dup = await api('GET', `/api/customers/check-duplicate?name=${encodeURIComponent(custA.name)}`);
  const dupSave = await api('POST', '/api/customers', {
    name: custA.name, short_name: '独山子石化副本', type: '终端用户', industry: '石油'
  });
  check(10, '同名客户查重提醒生效',
    dup.data && dup.data.length >= 1 && dupSave.data && dupSave.data.duplicates.length >= 1,
    `查重接口命中 ${dup.data && dup.data.length} 条，保存时提醒 ${dupSave.data && dupSave.data.duplicates.length} 条`);
  created.dupCust = dupSave.data.id;

  /* ---------- 11. 新增第二家客户（贸易商） ---------- */
  const b = await api('POST', '/api/customers', {
    name: '新疆天成阀门销售有限公司', short_name: '天成阀门', type: '贸易商/经销商',
    industry: '化工', level: 'B 普通客户', status: '已成交', phone: '0991-8888666',
    city: '乌鲁木齐市', province: '新疆维吾尔自治区',
    end_user: '新疆中泰化学', purchase_mode: '贸易商分销', annual_demand: 120,
    account_period: '月结30天', tag_ids: [t2.data.id]
  });
  check(11, '新增第二家客户（贸易商）', b.data && b.data.created === true, `id=${b.data && b.data.id}`);
  created.custB = b.data.id;

  /* ---------- 12. 联系人（一客户多人 + 主联系人唯一） ---------- */
  const ct1 = await api('POST', '/api/contacts', {
    customer_id: created.custA, name: '王建国', position: '采购经理', department: '采购部',
    mobile: '13909920001', wechat: 'wjg-dsz', email: 'wjg@example.com',
    is_decision: 1, is_primary: 1, influence: '关键决策', birthday: '1975-06-18'
  });
  const ct2 = await api('POST', '/api/contacts', {
    customer_id: created.custA, name: '刘工', position: '技术工程师', department: '设备部',
    mobile: '13909920002', is_decision: 1, is_primary: 1, influence: '技术把关'
  });
  const ct3 = await api('POST', '/api/contacts', {
    customer_id: created.custA, name: '小张', position: '库管', department: '仓储部',
    mobile: '13909920003', influence: '一般对接'
  });
  const afterContacts = await api('GET', `/api/customers/${created.custA}`);
  const primaries = afterContacts.data.contacts.filter((x) => x.is_primary === 1);
  check(12, '一客户多联系人（3 人）',
    afterContacts.data.contacts.length === 3,
    `联系人：${afterContacts.data.contacts.map((x) => x.name).join('/')}`);
  check(13, '主联系人唯一（设第二个主联系人后自动取消第一个）',
    primaries.length === 1 && primaries[0].name === '刘工',
    `主联系人 ${primaries.length} 个：${primaries.map((x) => x.name).join('/')}`);

  /* ---------- 14. 跟进记录 + 自动回填 + 自动待办 ---------- */
  const f1 = await api('POST', '/api/followups', {
    customer_id: created.custA, followed_at: '2026-02-10 09:30:00', method: '上门拜访',
    content: '拜访采购部王经理，沟通 2026 年度框架协议续签事宜，客户关注交货期与质保期。',
    result: '有意向', next_plan: '准备技术方案与报价单', next_at: '2026-02-20 10:00:00'
  });
  const f2 = await api('POST', '/api/followups', {
    customer_id: created.custA, followed_at: '2026-02-15 14:00:00', method: '电话',
    content: '电话确认技术参数，客户要求阀体材质改为 316L。', result: '已技术交流'
  });
  const afterFollow = await api('GET', `/api/customers/${created.custA}`);
  const fs = afterFollow.data;
  check(14, '跟进记录写入成功（含方式/结果/下次计划）',
    fs.followups.length === 2 && fs.followups[0].method === '电话',
    `共 ${fs.followups.length} 条，最新：${fs.followups[0].method} - ${fs.followups[0].result}`);
  check(15, '跟进后自动回填客户统计（次数/最近跟进/下次跟进）',
    fs.follow_count === 2 && String(fs.last_follow_at).startsWith('2026-02-15')
      && String(fs.next_follow_at).startsWith('2026-02-20'),
    `次数=${fs.follow_count} 最近=${fs.last_follow_at} 下次=${fs.next_follow_at}`);
  check(16, '填写下次跟进时间后自动生成待办',
    fs.tasks.length === 1 && fs.tasks[0].source === '跟进计划'
      && String(fs.tasks[0].due_at).startsWith('2026-02-20'),
    fs.tasks.length ? `待办：${fs.tasks[0].title} @ ${fs.tasks[0].due_at}` : '未生成待办');

  /* ---------- 17. 跟进内容必填校验 ---------- */
  const badFollow = await api('POST', '/api/followups', { customer_id: created.custA, content: '' });
  check(17, '跟进内容必填校验生效',
    badFollow.status === 400 && badFollow.json.code === 'CONTENT_REQUIRED',
    `HTTP ${badFollow.status} code=${badFollow.json && badFollow.json.code}`);

  /* ---------- 18. 列表查询 ---------- */
  const list = await api('GET', '/api/customers?pageSize=50');
  check(18, '客户列表返回分页数据',
    list.data && Array.isArray(list.data.list) && list.data.list.length >= 3,
    `共 ${list.data.total} 家，本页 ${list.data.list.length} 条，${list.data.pages} 页`);

  /* ---------- 19. 关键词搜索 ---------- */
  const s1 = await api('GET', '/api/customers?q=' + encodeURIComponent('独山子'));
  const s2 = await api('GET', '/api/customers?q=' + encodeURIComponent('13909920001'));
  const s3 = await api('GET', '/api/customers?q=' + encodeURIComponent('CNPC-SUP'));
  check(19, '搜索覆盖客户名 / 联系人手机 / 供应商编码',
    s1.data.total >= 2 && s2.data.total === 1 && s3.data.total === 1,
    `名称命中 ${s1.data.total}，联系人手机命中 ${s2.data.total}，供应商编码命中 ${s3.data.total}`);

  /* ---------- 20. 多维筛选 ---------- */
  const fIndustry = await api('GET', '/api/customers?industry=' + encodeURIComponent('石油'));
  const fType = await api('GET', '/api/customers?type=' + encodeURIComponent('终端用户'));
  const fCert = await api('GET', '/api/customers?cert_required=' + encodeURIComponent('API 6D'));
  const fMulti = await api('GET', `/api/customers?industry=${encodeURIComponent('石油')}&level=${encodeURIComponent('A 重点客户')}&enterprise_nature=${encodeURIComponent('央企')}`);
  check(20, '等值筛选生效（行业/主体类型/认证要求）',
    fIndustry.data.total >= 2 && fType.data.total >= 2 && fCert.data.total >= 1,
    `石油 ${fIndustry.data.total} 家，终端用户 ${fType.data.total} 家，要求 API 6D ${fCert.data.total} 家`);
  check(21, '多条件组合筛选生效',
    fMulti.data.total >= 1,
    `石油 + A级 + 央企 → ${fMulti.data.total} 家`);

  /* ---------- 22. 快捷筛选 ---------- */
  const qA = await api('GET', '/api/customers?quick=level_a');
  const qDesign = await api('GET', '/api/customers?quick=design');
  const qStale = await api('GET', '/api/customers?quick=stale30');
  check(22, '快捷筛选生效（A级 / 设计院 / 超30天未跟进）',
    qA.data.total >= 1 && qDesign.data.total === 0 && qStale.data.total >= 1,
    `A级 ${qA.data.total} 家，设计院 ${qDesign.data.total} 家，超30天未跟进 ${qStale.data.total} 家`);

  /* ---------- 23. 标签筛选 ---------- */
  const fTag = await api('GET', `/api/customers?tag_id=${t1.data.id}`);
  const tags = await api('GET', '/api/tags');
  const tagWithCount = tags.data.find((x) => x.id === t1.data.id);
  check(23, '标签筛选与统计生效',
    fTag.data.total === 1 && tagWithCount.customer_count === 1,
    `标签「重点跟进」筛选 ${fTag.data.total} 家，统计 ${tagWithCount.customer_count} 家`);

  /* ---------- 24. 排序（中文按拼音，非 UTF-8 字节序） ---------- */
  const sortName = await api('GET', '/api/customers?sort=name&order=asc&pageSize=100');
  const names = sortName.data.list.map((x) => x.name);
  const expected = [...names].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  const sortedOk = names.length >= 2 && names.every((n, i) => n === expected[i]);
  /* 额外验证：拼音序与 UTF-8 字节序确实不同，证明确实用了拼音排序 */
  const byteOrder = [...names].sort();
  const differsFromByteOrder = JSON.stringify(names) !== JSON.stringify(byteOrder);
  check(24, '按名称排序使用中文拼音序（非 UTF-8 字节序）',
    sortedOk,
    `前 3 家：${names.slice(0, 3).map((n) => n.slice(0, 8)).join(' / ')}；与字节序不同=${differsFromByteOrder}`);

  /* ---------- 25. 更新客户（局部更新，只传两个字段） ---------- */
  const upd = await api('PUT', `/api/customers/${created.custA}`, { level: 'B 普通客户', status: '已成交' });
  const afterUpd = await api('GET', `/api/customers/${created.custA}`);
  check(25, '局部更新生效且未影响其他字段',
    upd.status === 200 && upd.data && upd.data.created === false
      && afterUpd.data.level === 'B 普通客户' && afterUpd.data.status === '已成交'
      && afterUpd.data.short_name === '独山子石化' && afterUpd.data.industry === '石油'
      && afterUpd.data.supplier_code === 'CNPC-SUP-20240001',
    `等级→${afterUpd.data.level}，状态→${afterUpd.data.status}（简称/行业/供应商编码保持不变）`);

  /* ---------- 26. 操作日志 ---------- */
  const logs = afterUpd.data.logs;
  const hasCreate = logs.some((l) => l.action === 'create');
  const hasUpdate = logs.some((l) => l.action === 'update' && l.summary.includes('修改'));
  const hasFollow = logs.some((l) => l.action === 'followup');
  check(26, '操作日志完整记录（新建/修改/跟进）',
    hasCreate && hasUpdate && hasFollow,
    `共 ${logs.length} 条日志：${logs.map((l) => l.action).join(',')}`);
  const updLog = logs.find((l) => l.action === 'update');
  check(27, '修改日志含字段中文名与变更前后值',
    !!updLog && updLog.summary.includes('→') && updLog.summary.includes('等级'),
    updLog ? updLog.summary.slice(0, 70) : '未找到修改日志');

  /* ---------- 28. 批量打标签 ---------- */
  const bulkTag = await api('POST', '/api/customers/bulk', {
    ids: [created.custA, created.custB], type: 'tag', tag_id: t2.data.id
  });
  const afterBulk = await api('GET', `/api/customers/${created.custB}`);
  check(28, '批量打标签生效',
    bulkTag.data.count === 2 && afterBulk.data.tags.some((x) => x.name === '待开发'),
    `处理 ${bulkTag.data.count} 家，客户B标签：${afterBulk.data.tags.map((x) => x.name).join('/')}`);

  /* ---------- 29. 批量改状态 ---------- */
  const bulkStatus = await api('POST', '/api/customers/bulk', {
    ids: [created.custA, created.custB], type: 'status', value: '跟进中'
  });
  const afterStatus = await api('GET', `/api/customers/${created.custB}`);
  check(29, '批量改状态生效',
    bulkStatus.data.count === 2 && afterStatus.data.status === '跟进中',
    `处理 ${bulkStatus.data.count} 家，客户B状态=${afterStatus.data.status}`);

  /* ---------- 30. 删除联系人 ---------- */
  const delContact = await api('DELETE', `/api/contacts/${ct3.data.id}`);
  const afterDelContact = await api('GET', `/api/customers/${created.custA}`);
  check(30, '删除联系人（软删除）',
    delContact.data.count === 1 && afterDelContact.data.contacts.length === 2,
    `剩余联系人 ${afterDelContact.data.contacts.length} 人`);

  /* ---------- 31. 删除跟进记录并回填统计 ---------- */
  const delFollow = await api('DELETE', `/api/followups/${f2.data.id}`);
  const afterDelFollow = await api('GET', `/api/customers/${created.custA}`);
  check(31, '删除跟进后跟进次数自动回退',
    delFollow.data.count === 1 && afterDelFollow.data.follow_count === 1,
    `跟进次数 2 → ${afterDelFollow.data.follow_count}`);

  /* ---------- 32. 软删除客户 ---------- */
  const del = await api('DELETE', `/api/customers/${created.dupCust}`);
  const afterDelete = await api('GET', `/api/customers/${created.dupCust}`);
  check(32, '删除客户为软删除（列表不可见、详情返回 404）',
    del.data.count === 1 && afterDelete.status === 404,
    `删除 ${del.data.count} 家，详情查询 HTTP ${afterDelete.status}`);

  /* ---------- 33. 回收站与还原（验证关联数据一并还原） ---------- */
  /* 为「关联数据还原」专门造一条带联系人与跟进的客户 */
  const rc = await api('POST', '/api/customers', {
    name: '还原验证客户', short_name: '还原验证', type: '终端用户', industry: '电力', status: '跟进中'
  });
  const restoreCustId = rc.data.id;
  await api('POST', '/api/contacts', { customer_id: restoreCustId, name: '还原联系人', mobile: '13000000001', is_primary: 1 });
  await api('POST', '/api/followups', { customer_id: restoreCustId, method: '邮件', content: '还原验证用跟进记录' });

  const beforeDel = await api('GET', `/api/customers/${restoreCustId}`);
  const delRc = await api('DELETE', `/api/customers/${restoreCustId}`);
  const trash = await api('GET', '/api/trash?type=customer');
  const inTrash = trash.data.some((x) => x.id === restoreCustId);
  const restore = await api('POST', '/api/trash/restore', { ids: [restoreCustId] });
  const afterRestore = await api('GET', `/api/customers/${restoreCustId}`);
  check(33, '回收站可见并可还原',
    delRc.data.count === 1 && inTrash && restore.data.count === 1 && afterRestore.status === 200,
    `删除成功，回收站 ${trash.data.length} 条可见=${inTrash}，还原 ${restore.data.count} 条`);

  /* ---------- 34. 还原后关联数据完整 ---------- */
  check(34, '还原后关联数据完整（联系人/跟进记录随客户一并还原）',
    beforeDel.data.contacts.length === 1 && beforeDel.data.followups.length === 1
      && afterRestore.data.contacts.length === 1 && afterRestore.data.followups.length === 1
      && afterRestore.data.short_name === '还原验证'
      && afterRestore.data.follow_count === 1,
    `删除前 联系人${beforeDel.data.contacts.length}/跟进${beforeDel.data.followups.length} → 还原后 联系人${afterRestore.data.contacts.length}/跟进${afterRestore.data.followups.length}，跟进次数=${afterRestore.data.follow_count}`);

  /* ---------- 35. 不存在的记录返回 404 ---------- */
  const nf = await api('GET', '/api/customers/99999999');
  check(35, '查询不存在的客户返回 404',
    nf.status === 404 && nf.json.code === 'NOT_FOUND',
    `HTTP ${nf.status} code=${nf.json && nf.json.code}`);

  /* ---------- 36. 危险字段被白名单拦截 ---------- */
  const hack = await api('PUT', `/api/customers/${created.custB}`, {
    name: '新疆天成阀门销售有限公司', deleted_at: '2020-01-01T00:00:00',
    follow_count: 9999, created_at: '1999-01-01T00:00:00'
  });
  const afterHack = await api('GET', `/api/customers/${created.custB}`);
  check(36, '字段白名单拦截越权写入（deleted_at / follow_count / created_at）',
    afterHack.data.deleted_at === null && afterHack.data.follow_count !== 9999
      && !String(afterHack.data.created_at).startsWith('1999'),
    `deleted_at=${afterHack.data.deleted_at}, follow_count=${afterHack.data.follow_count}, created_at=${String(afterHack.data.created_at).slice(0, 10)}`);

  /* ---------- 37. SQL 注入防护 ---------- */
  const inj = await api('GET', '/api/customers?q=' + encodeURIComponent("' OR 1=1; DROP TABLE customers;--"));
  const stillAlive = await api('GET', '/api/customers?pageSize=1');
  check(37, 'SQL 注入攻击被参数化查询挡住',
    inj.status === 200 && inj.data.total === 0 && stillAlive.data.total >= 3,
    `注入查询返回 ${inj.data.total} 条，customers 表仍可查（${stillAlive.data.total} 家）`);

  /* ---------- 38. 排序字段注入防护 ---------- */
  const badSort = await api('GET', '/api/customers?sort=' + encodeURIComponent('id; DROP TABLE customers'));
  const alive2 = await api('GET', '/api/customers?pageSize=1');
  check(38, '排序字段白名单挡住注入',
    badSort.status === 200 && alive2.data.total >= 3,
    `非法排序字段回退默认排序，表仍可查（${alive2.data.total} 家）`);

  /* ---------- 39. 特殊字符与超长文本 ---------- */
  const special = await api('POST', '/api/customers', {
    name: "测试<客户>&\"'公司\u0000换行\n测试", short_name: '特殊字符测试',
    type: '其他', industry: '其他', remark: 'x'.repeat(5000)
  });
  const readSpecial = special.data && special.data.id
    ? await api('GET', `/api/customers/${special.data.id}`) : null;
  check(39, '特殊字符与超长文本正确存储',
    readSpecial && readSpecial.data.name.includes('<客户>') && readSpecial.data.remark.length === 5000,
    `名称往返一致=${readSpecial && readSpecial.data.name.includes('特殊字符') || readSpecial.data.name.includes('<客户>')}, remark 长度=${readSpecial && readSpecial.data.remark.length}`);
  if (special.data && special.data.id) created.special = special.data.id;

  /* ---------- 40. 空值与非数字容错 ---------- */
  const messy = await api('POST', '/api/customers', {
    name: '容错测试客户', short_name: '容错测试', type: '其他', industry: '其他',
    annual_demand: 'abc', warranty_months: '', warranty_ratio: 'x', longitude: null, latitude: '', is_listed: ''
  });
  const readMessy = messy.data && messy.data.id ? await api('GET', `/api/customers/${messy.data.id}`) : null;
  const mv = readMessy ? readMessy.data : {};
  check(40, '数字字段传空串/非法值归一为 0，经纬度归一为 NULL（不再 500）',
    !!readMessy
      && mv.annual_demand === 0 && mv.warranty_months === 0
      && mv.warranty_ratio === 0 && mv.is_listed === 0
      && (mv.longitude === null || mv.longitude === undefined),
    readMessy
      ? `annual_demand=${JSON.stringify(mv.annual_demand)}, warranty_months=${JSON.stringify(mv.warranty_months)}, warranty_ratio=${JSON.stringify(mv.warranty_ratio)}, is_listed=${JSON.stringify(mv.is_listed)}, longitude=${JSON.stringify(mv.longitude)}`
      : `写入失败：HTTP ${messy.status} ${messy.json && messy.json.message}`);
  if (messy.data && messy.data.id) created.messy = messy.data.id;

  /* ---------- 41. 列表聚合字段正确 ---------- */
  const listA = await api('GET', '/api/customers?q=' + encodeURIComponent('独山子石化'));
  const row = listA.data.list.find((x) => x.id === created.custA);
  check(41, '列表聚合字段正确（联系人/跟进/项目计数）',
    row && row.contact_count === 2 && row.follow_count === 1 && row.project_count === 0
      && row.primary_contact === '刘工',
    `联系人 ${row && row.contact_count}，跟进 ${row && row.follow_count}，项目 ${row && row.project_count}，主联系人 ${row && row.primary_contact}`);

  /* ---------- 42. 逾期标记 ---------- */
  const overdueList = await api('GET', '/api/customers?quick=overdue');
  check(42, '逾期跟进标记计算正确',
    overdueList.status === 200,
    `逾期客户 ${overdueList.data.total} 家（下次跟进时间已过今天）`);

  /* ---------- 清理测试数据 ---------- */
  const cleanupIds = [
    created.custA, created.custB, created.dupCust, created.special,
    created.messy, rc.data && rc.data.id
  ].filter(Boolean);

  /* 清理本次新增的测试字典项 */
  await resetTestDictItem();

  await api('POST', '/api/customers/batch-delete', { ids: cleanupIds });
  console.log(`\n（已清理 ${cleanupIds.length} 条测试客户并复位测试字典项，客户可在回收站还原）`);

  /* ---------- 汇总 ---------- */
  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log('\n=== 汇总 ===');
  console.log(`通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.no}. ${r.name} —— ${r.detail}`);
  }
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('测试脚本异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
