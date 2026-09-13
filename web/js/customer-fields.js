/**
 * 客户表单结构定义
 * 62 个可写字段按 7 个区块组织；仅「基础」区块常显，其余折叠。
 * 字典类字段统一带 allowAdd，可在表单内直接「+ 新增选项」。
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  /* 单选（字典） */
  const sel = (key, label, category, opts) => Object.assign({
    key, label, type: 'select', category, allowAdd: true, span: 1
  }, opts || {});

  /* 多选题（逗号分隔多值） */
  const multi = (key, label, category, opts) => Object.assign({
    key, label, type: 'multi', category, allowAdd: true, span: 2
  }, opts || {});

  /* 文本 */
  const txt = (key, label, opts) => Object.assign({
    key, label, type: 'text', span: 1
  }, opts || {});

  /* 开关 */
  const sw = (key, label, opts) => Object.assign({
    key, label, type: 'switch', span: 1
  }, opts || {});

  const BLOCKS = [
    {
      key: 'basic',
      title: '基础信息',
      always: true,
      desc: '必填项：客户全称、简称、主体类型、下游行业',
      fields: [
        txt('name', '客户全称', {
          required: true, span: 2,
          placeholder: '工商注册全称，用于投标与合同，例如：中国石油天然气股份有限公司独山子石化分公司'
        }),
        txt('short_name', '客户简称', {
          required: true, span: 1, placeholder: '列表显示用，例如：独山子石化'
        }),
        sel('type', '客户主体类型', 'customer_type', {
          required: true, hint: '决定跟进打法：终端用户 / 设计院 / EPC / 贸易商'
        }),
        sel('industry', '下游行业', 'industry', { required: true }),
        sel('level', '客户等级', 'customer_level', { allowAdd: true }),
        sel('status', '客户状态', 'customer_status', { allowAdd: false }),
        sel('source', '客户来源', 'customer_source', { allowAdd: true }),
        txt('owner', '归属业务员', { placeholder: '默认本人' }),
        { key: 'tag_ids', label: '标签', type: 'tags', span: 2 }
      ]
    },
    {
      key: 'contact',
      title: '联系方式',
      desc: '公司层面的联系方式；联系人请到「联系人」标签页维护',
      fields: [
        txt('phone', '公司电话'),
        txt('fax', '传真'),
        txt('email', '公司邮箱'),
        txt('website', '网址'),
        txt('wechat', '微信'),
        txt('credit_code', '统一社会信用代码', { hint: '投标、开票、查资质用', span: 2 })
      ]
    },
    {
      key: 'address',
      title: '地址信息',
      desc: '填写「市 / 地区」后会自动归属到地图上的地州；坐标用于在地图上精确定位',
      fields: [
        txt('province', '省 / 自治区', { placeholder: '新疆维吾尔自治区' }),
        txt('city', '市 / 地区', { hint: '如「乌鲁木齐市」「喀什地区」——填写后自动归入地图统计' }),
        txt('district', '区 / 县', { hint: '如「天山区」「库尔勒市」' }),
        txt('zip_code', '邮编'),
        txt('address', '详细地址', { span: 2 }),
        {
          key: 'region_code', label: '归属地州', type: 'region', span: 2,
          hint: '由地址自动匹配；也可手动指定。用于地图统计与按区域筛选'
        },
        txt('longitude', '经度', {
          type: 'number',
          hint: '可留空。在高德坐标拾取器复制后粘贴，或点右侧「坐标工具」转换'
        }),
        txt('latitude', '纬度', { type: 'number' })
      ]
    },
    {
      key: 'company',
      title: '企业概况',
      desc: '央企二级/三级单位投标主体不同，所属集团务必填写',
      fields: [
        sel('enterprise_nature', '企业性质', 'enterprise_nature', { allowAdd: true }),
        txt('parent_group', '所属集团', { hint: '例如：中国石油天然气集团有限公司' }),
        txt('scale', '企业规模', { placeholder: '大型 / 中型 / 小型 / 微型' }),
        txt('employees', '员工人数', { placeholder: '例如：1000人以上' }),
        txt('legal_person', '法定代表人'),
        txt('founded_at', '成立日期', { type: 'date' }),
        sw('is_listed', '是否上市')
      ]
    },
    {
      key: 'valve',
      title: '行业属性（阀门业务专用）',
      desc: '这组字段决定报价与选型效率，建议尽早补全',
      fields: [
        sel('purchase_mode', '采购模式', 'purchase_mode', { allowAdd: true }),
        txt('end_user', '最终用户', { hint: '经销商/工程公司建档时必填：阀门最终装到哪个厂' }),
        txt('design_institute', '关联设计院', { hint: '上图是阀门行业的关键打法，单独记录便于反向统计' }),
        txt('epc_contractor', '关联工程公司 / EPC 总包'),
        multi('valve_types', '常用阀门类型', 'valve_type'),
        multi('drive_mode', '常用驱动方式', 'drive_mode', { span: 1 }),
        multi('body_material', '常用阀体材质', 'body_material'),
        multi('pressure_rating', '常用压力等级', 'pressure_rating', { span: 1 }),
        multi('size_range', '常用口径范围', 'size_range'),
        multi('design_standard', '常用设计标准', 'design_standard', { span: 1 }),
        multi('connection_type', '连接方式', 'connection_type', { span: 1 }),
        multi('cert_required', '认证要求', 'cert_required')
      ]
    },
    {
      key: 'business',
      title: '采购与商务条件',
      desc: '账期与质保金直接影响报价与现金流',
      fields: [
        txt('annual_demand', '年需求量预估（万元）', { type: 'number', hint: '用于排优先级' }),
        txt('purchase_cycle', '采购周期', { placeholder: '月度 / 季度 / 年度 / 项目制随机' }),
        sel('account_period', '账期', 'account_period', { allowAdd: true }),
        txt('warranty_ratio', '质保金比例（%）', { type: 'number', placeholder: '常见 5 ~ 10' }),
        txt('warranty_months', '质保期（月）', { type: 'number', placeholder: '常见 12 / 18 / 24' }),
        txt('payer', '付款方', { placeholder: '客户本身 / 集团财务 / 项目业主' }),
        txt('tender_platform', '常用招标平台', { placeholder: '中石油 / 中石化 / 国家能源 / 中国采招网 等', span: 2 })
      ]
    },
    {
      key: 'qualify',
      title: '资质合规',
      desc: '石化项目没有 TS 与防爆认证连投标资格都没有',
      fields: [
        multi('qualification', '客户要求资质', 'cert_required', {
          hint: '与上方「认证要求」互补：这里记客户方硬性门槛'
        }),
        sw('has_ts_license', '是否要求 TS 特种设备许可证'),
        sw('has_explosion_proof', '是否要求防爆认证'),
        txt('quality_grade', '客户分级 / 信用评级', { placeholder: '例如：中石油一级供应商' }),
        txt('supplier_code', '客户方供应商编码', { hint: '入网后必有，投标与订单都要填' }),
        sel('credit_rating', '我方信用评级', 'credit_rating', {
          allowAdd: true, options: ['优', '良', '一般', '差', '有欠款']
        })
      ]
    },
    {
      key: 'relation',
      title: '业务关系与跟进计划',
      desc: '介绍人是工业客户圈子里最值钱的信息',
      fields: [
        txt('introducer', '介绍人 / 关键引荐人'),
        txt('competitor', '主要竞争对手', { hint: '该客户目前在用哪个品牌' }),
        txt('customer_since', '合作起始日期', { type: 'date' }),
        txt('next_follow_at', '下次跟进时间', { type: 'datetime-local', hint: '到期后首页与列表会红色提醒' }),
        txt('remark', '备注', { type: 'textarea', span: 2, rows: 3 })
      ]
    }
  ];

  /* 列表页筛选字段 */
  const FILTERS = [
    { key: 'type', label: '主体类型', category: 'customer_type' },
    { key: 'industry', label: '下游行业', category: 'industry' },
    { key: 'status', label: '客户状态', category: 'customer_status' },
    { key: 'level', label: '客户等级', category: 'customer_level' },
    { key: 'purchase_mode', label: '采购模式', category: 'purchase_mode' },
    { key: 'cert_required', label: '认证要求', category: 'cert_required' },
    { key: 'enterprise_nature', label: '企业性质', category: 'enterprise_nature' },
    { key: 'source', label: '客户来源', category: 'customer_source' },
    { key: 'province', label: '省份', category: null },
    /* region 特殊：选项来自行政区划表（地州），不是字典 */
    { key: 'region_code', label: '归属地州', category: null, source: 'region' }
  ];

  /* 列表页快捷筛选（阀门口径） */
  const QUICKS = [
    { key: 'today', label: '今日待跟进' },
    { key: 'overdue', label: '已逾期跟进' },
    { key: 'level_a', label: '我的重点客户（A 级）' },
    { key: 'design', label: '设计院（上图的）' },
    { key: 'has_debt', label: '有欠款的客户' },
    { key: 'stale30', label: '超 30 天未跟进' },
    { key: 'no_follow', label: '从未跟进过' }
  ];

  /* 列表排序 */
  const SORTS = [
    { key: 'next_follow_at', label: '下次跟进时间' },
    { key: 'updated_at', label: '最近修改' },
    { key: 'created_at', label: '建档时间' },
    { key: 'annual_demand', label: '年需求量' },
    { key: 'name', label: '客户名称（拼音）' },
    { key: 'level', label: '客户等级' }
  ];

  /* 字段中文名（用于变更记录展示） */
  const FIELD_LABEL = {};
  for (const b of BLOCKS) for (const f of b.fields) FIELD_LABEL[f.key] = f.label;

  CRM.customerForm = { BLOCKS, FILTERS, QUICKS, SORTS, FIELD_LABEL };

})(window.CRM);
