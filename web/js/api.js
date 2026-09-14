/**
 * API 客户端 + 字典缓存
 * 约定：服务端统一返回 { ok:true, data } 或 { ok:false, code, message }
 *       本模块把成功响应解包为 data，失败抛出带 code 的 Error。
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  const { reactive } = Vue;

  function toQuery(params) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === '') continue;
      sp.append(k, v);
    }
    return sp.toString();
  }

  async function request(method, url, body) {
    const opts = { method, headers: { Accept: 'application/json' }, cache: 'no-store' };
    if (body !== undefined && body !== null) {
      opts.headers['Content-Type'] = 'application/json; charset=utf-8';
      opts.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(url, opts);
    } catch (netErr) {
      const e = new Error('无法连接本地服务，请确认服务窗口仍在运行');
      e.code = 'NETWORK';
      throw e;
    }

    let payload = null;
    const text = await res.text();
    if (text) { try { payload = JSON.parse(text); } catch (_) { /* 非 JSON */ } }

    if (!res.ok || !payload || payload.ok !== true) {
      const message = (payload && payload.message) || `请求失败（HTTP ${res.status}）`;
      const e = new Error(message);
      e.code = (payload && payload.code) || `HTTP_${res.status}`;
      e.status = res.status;
      throw e;
    }
    return payload.data;
  }

  /* ------------------------------------------------------------------ */
  /* 字典与标签缓存：多页面共用，避免重复请求                              */
  /* ------------------------------------------------------------------ */

  const cache = reactive({
    dict: { options: {}, items: {}, categories: [] },
    tags: [],
    customers: [],
    loaded: false,
    tagsLoaded: false,
    customersLoaded: false
  });

  async function loadDict(force) {
    if (cache.loaded && !force) return cache.dict;
    const d = await request('GET', '/api/dict');
    cache.dict = d;
    cache.loaded = true;
    return d;
  }

  async function loadTags(force) {
    if (cache.tagsLoaded && !force) return cache.tags;
    cache.tags = await request('GET', '/api/tags');
    cache.tagsLoaded = true;
    return cache.tags;
  }

  function options(category) {
    return (cache.dict.options && cache.dict.options[category]) || [];
  }

  function items(category) {
    return (cache.dict.items && cache.dict.items[category]) || [];
  }

  /** 客户选项：形如 [{id, name, short_name, label}] */
  function customerOptions() {
    return cache.customers || [];
  }

  /** 新增字典选项后就地同步缓存，使所有表单下拉立刻可见（无需刷新页面） */
  function applyDictAdded(result, category) {
    if (!result || !cache.dict || !cache.dict.items) return loadDict(true);
    if (!cache.dict.items[category]) cache.dict.items[category] = [];
    const list = cache.dict.items[category];
    if (!list.some((x) => x.id === result.id)) {
      list.push({ id: result.id, category, value: result.value, color: '', sort: 99999, is_system: 0 });
      cache.dict.options[category] = list.map((x) => x.value);
    }
    return Promise.resolve(cache.dict);
  }

  /** 客户下拉选项（项目表单选客户用） */
  async function loadCustomerOptions(force) {
    if (cache.customersLoaded && !force) return cache.customers;
    const d = await request('GET', '/api/customers?pageSize=500&sort=name&order=asc');
    cache.customers = (d.list || []).map((c) => ({
      id: c.id,
      name: c.name,
      short_name: c.short_name,
      label: c.short_name ? `${c.short_name}（${c.name}）` : c.name
    }));
    cache.customersLoaded = true;
    return cache.customers;
  }

  CRM.api = {
    get:   (url) => request('GET', url),
    post:  (url, body) => request('POST', url, body),
    put:   (url, body) => request('PUT', url, body),
    patch: (url, body) => request('PATCH', url, body),
    del:   (url, body) => request('DELETE', url, body),

    health: () => request('GET', '/api/health'),
    status: () => request('GET', '/api/status'),
    openDataDir: () => request('POST', '/api/open-data-dir'),

    /* 提醒 */
    remindersDue: () => request('GET', '/api/reminders/due'),
    remindSettings: () => request('GET', '/api/reminders/settings'),
    saveRemindSettings: (data) => request('PUT', '/api/reminders/settings', data),
    emailStatus: () => request('GET', '/api/reminders/email-status'),
    testEmail: () => request('POST', '/api/reminders/test-email'),
    sendReminderNow: () => request('POST', '/api/reminders/send-now'),

    /* 地图客户坐标点 */
    customerPoints: (params) => request('GET', '/api/map/customer-points?' + toQuery(params)),

    /* 报价单 */
    listQuotations: (params) => request('GET', '/api/quotations?' + toQuery(params)),
    getQuotation: (id) => request('GET', `/api/quotations/${id}`),
    saveQuotation: (data) => data.id
      ? request('PUT', `/api/quotations/${data.id}`, data)
      : request('POST', '/api/quotations', data),
    copyQuotation: (id) => request('POST', `/api/quotations/${id}/copy`),
    setQuotationStatus: (id, payload) => request('POST', `/api/quotations/${id}/status`, payload),
    applyQuotationToProject: (id) => request('POST', `/api/quotations/${id}/apply-to-project`),
    deleteQuotation: (id) => request('DELETE', `/api/quotations/${id}`),
    quotationExportData: (id) => request('GET', `/api/quotations/${id}/export`),
    quotationStatuses: () => request('GET', '/api/quotations/statuses'),
    /* 跨项目总列表（独立报价单页）与状态计数 */
    quotationOverview: (params) => request('GET', '/api/quotations/overview?' + toQuery(params)),
    quotationStatusCounts: () => request('GET', '/api/quotations/status-counts'),

    /* 报价模板 */
    listTemplates: (params) => request('GET', '/api/quotation-templates?' + toQuery(params)),
    getQuotationTemplate: (id) => request('GET', `/api/quotation-templates/${id}`),
    saveQuotationTemplate: (data) => data.id
      ? request('PUT', `/api/quotation-templates/${data.id}`, data)
      : request('POST', '/api/quotation-templates', data),
    deleteQuotationTemplate: (id) => request('DELETE', `/api/quotation-templates/${id}`),
    moveQuotationTemplate: (id, dir) => request('POST', `/api/quotation-templates/${id}/move`, { dir }),
    applyQuotationTemplate: (id) => request('POST', `/api/quotation-templates/${id}/apply`),
    templateFromQuotation: (quotationId, data) =>
      request('POST', `/api/quotation-templates/from-quotation/${quotationId}`, data || {}),

    /* 报价自定义列（报价单与报价模板共用） */
    listQuotationFields: (params) => request('GET', '/api/quotation-fields?' + toQuery(params)),
    saveQuotationField: (data) => data.id
      ? request('PUT', `/api/quotation-fields/${data.id}`, data)
      : request('POST', '/api/quotation-fields', data),
    deleteQuotationField: (id) => request('DELETE', `/api/quotation-fields/${id}`),
    moveQuotationField: (id, dir) => request('POST', `/api/quotation-fields/${id}/move`, { dir }),
    /* 移动任意列（内置列也算），key 形如 'remark' 或 'f:12' */
    moveQuotationColumn: (key, dir) => request('POST', '/api/quotation-fields/move', { key, dir }),
    /* 内置列改名（label 传空 = 恢复默认名） */
    renameQuotationColumn: (key, label) => request('POST', '/api/quotation-fields/rename', { key, label }),
    /* 内置列删除（隐藏）/ 恢复 */
    setQuotationColumnVisible: (key, visible) =>
      request('POST', '/api/quotation-fields/visibility', { key, visible }),
    quotationColumnOrder: () => request('GET', '/api/quotation-fields/order'),
    saveQuotationColumnOrder: (order) => request('POST', '/api/quotation-fields/order', { order }),

    /* 客户 */
    listCustomers: (params) => request('GET', '/api/customers?' + toQuery(params)),
    getCustomer: (id) => request('GET', `/api/customers/${id}`),
    saveCustomer: (data) => data.id
      ? request('PUT', `/api/customers/${data.id}`, data)
      : request('POST', '/api/customers', data),
    deleteCustomers: (ids) => request('POST', '/api/customers/batch-delete', { ids }),
    bulk: (payload) => request('POST', '/api/customers/bulk', payload),
    checkDuplicate: (name, phone, excludeId) =>
      request('GET', '/api/customers/check-duplicate?' + toQuery({ name, phone, excludeId })),

    /* 联系人 */
    saveContact: (data) => request('POST', '/api/contacts', data),
    deleteContact: (id) => request('DELETE', `/api/contacts/${id}`),

    /* 跟进 */
    saveFollowup: (data) => request('POST', '/api/followups', data),
    deleteFollowup: (id) => request('DELETE', `/api/followups/${id}`),

    /* 标签 */
    listTags: () => request('GET', '/api/tags'),
    saveTag: (data) => request('POST', '/api/tags', data),
    deleteTag: (id) => request('DELETE', `/api/tags/${id}`),

    /* 字典 */
    listDict: () => request('GET', '/api/dict'),
    addDict: (category, value) => request('POST', '/api/dict', { category, value }),
    quickAddDict: (category, value) => request('POST', '/api/dict/quick-add', { category, value }),
    updateDict: (id, data) => request('PUT', `/api/dict/${id}`, data),
    deleteDict: (id) => request('DELETE', `/api/dict/${id}`),
    dictUsage: (category, value) => request('GET', '/api/dict/usage?' + toQuery({ category, value })),

    /* 回收站 */
    listTrash: (type) => request('GET', '/api/trash?' + toQuery({ type })),
    restore: (ids, type) => request('POST', '/api/trash/restore', { ids, type }),

    /* 项目 */
    listProjects: (params) => request('GET', '/api/projects?' + toQuery(params)),
    boardProjects: (params) => request('GET', '/api/projects/board?' + toQuery(params)),
    projectStages: () => request('GET', '/api/projects/stages'),
    getProject: (id) => request('GET', `/api/projects/${id}`),
    saveProject: (data) => data.id
      ? request('PUT', `/api/projects/${data.id}`, data)
      : request('POST', '/api/projects', data),
    deleteProjects: (ids) => request('POST', '/api/projects/batch-delete', { ids }),
    moveStage: (id, stage) => request('POST', `/api/projects/${id}/move-stage`, { stage }),

    /* 回款 */
    savePayment: (data) => request('POST', '/api/payments', data),
    deletePayment: (id) => request('DELETE', `/api/payments/${id}`),
    paymentOverview: (days) => request('GET', '/api/payment-overview?' + toQuery({ days })),

    /* 待办 */
    listTasks: (params) => request('GET', '/api/tasks?' + toQuery(params)),
    saveTask: (data) => data.id
      ? request('PUT', `/api/tasks/${data.id}`, data)
      : request('POST', '/api/tasks', data),
    toggleTask: (id, done) => request('POST', `/api/tasks/${id}/toggle`, { done }),
    deleteTasks: (ids) => request('POST', '/api/tasks/batch-delete', { ids }),
    purgeDoneTasks: (keepDays) => request('POST', '/api/tasks/purge-done', { keepDays }),

    /* 阶段四：首页总览 / 设置 / 备份 / 导入导出 / 日志 */
    dashboard: () => request('GET', '/api/dashboard'),

    getSettings: () => request('GET', '/api/settings'),
    saveSettings: (patch) => request('PUT', '/api/settings', patch),

    listBackups: () => request('GET', '/api/backup/list'),
    createBackup: (reason) => request('POST', '/api/backup/create', { reason }),
    verifyBackup: (name) => request('POST', '/api/backup/verify', { name }),
    restoreBackup: (name, confirm) => request('POST', '/api/backup/restore', { name, confirm }),
    deleteBackup: (name) => request('POST', '/api/backup/delete', { name }),

    getTemplate: (entity) => request('GET', '/api/data/template?' + toQuery({ entity })),
    exportData: (entity, filters) => request('POST', '/api/data/export', Object.assign({ entity }, filters || {})),
    previewImport: (entity, rows) => request('POST', '/api/data/preview', { entity, rows }),
    runImport: (entity, rows, opts) =>
      request('POST', '/api/data/import', Object.assign({ entity, rows }, opts || {})),

    listLogs: (params) => request('GET', '/api/logs?' + toQuery(params)),
    clearLogs: (keepDays) => request('POST', '/api/logs/clear', { keepDays }),

    /* 阶段五：附件 */
    listAttachments: (ownerType, ownerId) =>
      request('GET', '/api/attachments?' + toQuery({ owner_type: ownerType, owner_id: ownerId })),
    uploadAttachment: (payload) => request('POST', '/api/attachments', payload),
    updateAttachment: (id, data) => request('PUT', `/api/attachments/${id}/meta`, data),
    deleteAttachment: (id) => request('DELETE', `/api/attachments/${id}`),
    attachmentUsage: () => request('GET', '/api/attachments/usage'),
    cleanOrphanAttachments: () => request('POST', '/api/attachments/clean-orphans'),

    /* 招标信息采集（软件里唯一会联网的模块，默认关闭） */
    collectSummary: () => request('GET', '/api/collect/summary'),
    collectProviders: () => request('GET', '/api/collect/providers'),
    collectSources: () => request('GET', '/api/collect/sources'),
    saveCollectSource: (data) => data.id
      ? request('PUT', `/api/collect/sources/${data.id}`, data)
      : request('POST', '/api/collect/sources', data),
    deleteCollectSource: (id) => request('DELETE', `/api/collect/sources/${id}`),
    testCollectSource: (id) => request('POST', `/api/collect/sources/${id}/test`),
    collectRun: (opt) => request('POST', '/api/collect/run',
      { ignoreInterval: !!(opt && opt.ignore_interval) }),
    collectStaging: (params) => request('GET', '/api/collect/staging?' + toQuery(params || {})),
    collectStagingDetail: (id) => request('GET', `/api/collect/staging/${id}`),
    reviewStaging: (id, data) => request('POST', `/api/collect/staging/${id}/review`, data),
    rejectStagingBatch: (ids, reason) => request('POST', '/api/collect/staging-reject', { ids, reason }),
    collectLogs: (params) => request('GET', '/api/collect/logs?' + toQuery(params || {})),

    /* 缓存工具 */
    loadDict, loadTags, options, items, applyDictAdded, loadCustomerOptions, customerOptions, cache
  };

})(window.CRM);
