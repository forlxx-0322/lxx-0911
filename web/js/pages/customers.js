/**
 * 客户列表页
 * 搜索 / 快捷筛选 / 多维筛选 / 排序 / 分页 / 批量操作 / 新增编辑 / 行内记跟进
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  const { FILTERS, QUICKS, SORTS } = CRM.customerForm;

  const columns = [
    { key: 'name', label: '客户名称', sortable: true, sortKey: 'name', width: '230px' },
    { key: 'type', label: '主体类型', width: '120px' },
    { key: 'industry', label: '下游行业', width: '92px' },
    { key: 'level', label: '等级', width: '104px' },
    { key: 'status', label: '状态', width: '84px' },
    { key: 'primary', label: '主联系人', width: '132px' },
    { key: 'next_follow_at', label: '下次跟进', sortable: true, width: '112px' },
    { key: 'annual_demand', label: '年需求(万)', sortable: true, align: 'right', width: '100px' },
    { key: 'project_count', label: '项目', align: 'center', width: '60px' },
    { key: 'ops', label: '操作', width: '132px', align: 'right' }
  ];

  const CustomersPage = {
    name: 'CustomersPage',
    data() {
      return {
        columns,
        filters: FILTERS,
        quicks: QUICKS,
        sorts: SORTS,
        rows: [],
        total: 0,
        page: 1,
        pageSize: 20,
        pages: 1,
        sort: 'next_follow_at',
        order: 'asc',
        loading: false,
        editingLoading: false,

        /* 批量导入 */
        importOpen: false,
        impStep: 1,
        impFileName: '',
        impParsing: false,
        impDragOver: false,
        impPreview: null,
        impReport: null,
        impImporting: false,
        impMode: 'skip',
        tplBusy: false,
        selected: [],
        showAdvanced: false,
        query: {
          q: '', quick: '', type: '', industry: '', status: '', level: '',
          purchase_mode: '', enterprise_nature: '', source: '', province: '', tag_id: ''
        },
        editOpen: false,
        editing: null,
        followOpen: false,
        followCustomer: null,
        bulkStatus: '',
        bulkTagId: '',
        /* 行政区划（归属地州筛选用） */
        regions: { cities: [] }
      };
    },
    computed: {
      selectedCount() { return this.selected.length; },
      activeFilterCount() {
        return ['type', 'industry', 'status', 'level', 'purchase_mode',
          'enterprise_nature', 'source', 'province', 'tag_id']
          .filter((k) => this.query[k]).length;
      },
      /* 导入预览里有问题的行 */
      impErrors() {
        const rows = (this.impPreview && this.impPreview.rows) || [];
        return rows.filter((r) => r.errors && r.errors.length);
      },
      /* 导入预览里与库中重名的行 */
      impDuplicates() {
        const rows = (this.impPreview && this.impPreview.rows) || [];
        return rows.filter((r) => (r.warnings || []).some((w) => /重复|已存在|同名/.test(w)));
      }
    },
    methods: {
      fmtDate: CRM.util.fmtDate,

      levelClass(level) {
        if (!level) return 'muted';
        if (level.startsWith('A')) return 'danger';
        if (level.startsWith('B')) return '';
        return 'muted';
      },

      statusClass(status) {
        if (status === '已成交') return 'success';
        if (status === '已流失' || status === '暂停合作') return 'muted';
        if (status === '已报价') return 'warning';
        return '';
      },

      rowClass(row) { return row.overdue ? 'row-overdue clickable' : 'clickable'; },

      isOverdue(v) {
        if (!v) return false;
        return new Date(String(v).replace(' ', 'T')).getTime() < Date.now();
      },

      async load() {
        this.loading = true;
        try {
          const params = Object.assign({}, this.query, {
            page: this.page, pageSize: this.pageSize, sort: this.sort, order: this.order
          });
          const d = await CRM.api.listCustomers(params);
          this.rows = d.list;
          this.total = d.total;
          this.pages = d.pages;
          this.selected = [];
        } catch (e) {
          CRM.toast(e.message || '加载失败', 'error');
        } finally {
          this.loading = false;
        }
      },

      reload() { this.page = 1; this.load(); },

      setQuick(key) {
        this.query.quick = (this.query.quick === key) ? '' : key;
        this.reload();
      },

      clearFilters() {
        for (const k of Object.keys(this.query)) this.query[k] = '';
        this.reload();
      },

      onSort({ sort, order }) { this.sort = sort; this.order = order; this.load(); },
      onPage(p) { this.page = p; this.load(); },
      onPageSize(n) { this.pageSize = n; this.page = 1; this.load(); },

      openCreate() { this.editing = null; this.editOpen = true; },

      /**
       * 打开编辑抽屉。
       *
       * 这里**先取一次完整记录**再打开，而不是直接把列表行给表单：
       * 列表行只带一部分字段，若拿它当初始值，表单里没有的字段就是空值，
       * 用户即使只改一个字段、点保存，也会把其余字段覆盖成空
       * （曾因此把「详细地址」清掉）。多一次请求换数据安全，值得。
       */
      async openEdit(row) {
        this.editingLoading = true;
        try {
          this.editing = await CRM.api.getCustomer(row.id);
        } catch (e) {
          CRM.toast(e.message || '读取客户资料失败', 'error');
          /* 读取失败时退回用列表行，至少不阻断操作 */
          this.editing = row;
        } finally {
          this.editingLoading = false;
          this.editOpen = true;
        }
      },

      onSaved() { this.load(); },

      /* ---------------- 批量导入 ---------------- */
      openImport() {
        this.importOpen = true;
        this.impStep = 1;
        this.impFileName = '';
        this.impPreview = null;
        this.impReport = null;
        this.impMode = 'skip';
      },
      closeImport() {
        this.importOpen = false;
        /* 有实际导入过才刷新列表，避免无谓请求 */
        if (this.impReport && this.impReport.imported) this.load();
      },
      resetImport() {
        this.impStep = 1;
        this.impFileName = '';
        this.impPreview = null;
        this.impReport = null;
      },

      async downloadTemplate() {
        this.tplBusy = true;
        try {
          await CRM.importXlsx.downloadTemplate('customer');
          CRM.toast('模板已下载（含填写说明与可选值参考）', 'success');
        } catch (e) {
          CRM.toast(e.message || '下载模板失败', 'error');
        } finally {
          this.tplBusy = false;
        }
      },

      /** 导出现有客户，作为"照着我已有的数据填"的样例 */
      async downloadSampleData() {
        try {
          await CRM.api.exportData('customer', { scope: 'all' });
          CRM.toast('已导出当前客户数据，可作为填写样例', 'success');
        } catch (e) {
          CRM.toast(e.message || '导出失败', 'error');
        }
      },

      onImportFile(e) {
        const f = e.target.files && e.target.files[0];
        if (f) this.handleImportFile(f);
        e.target.value = '';
      },
      onImportDrop(e) {
        this.impDragOver = false;
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) this.handleImportFile(f);
      },

      async handleImportFile(file) {
        this.impParsing = true;
        this.impFileName = (file && file.name) || '';
        try {
          const r = await CRM.importXlsx.parseFile('customer', file);
          if (!r.ok) { CRM.toast(r.message, 'error', 6000); return; }
          this.impPreview = r.preview;
          this.impStep = 2;
          CRM.toast(`已解析 ${r.preview.total} 行：可导入 ${r.preview.valid} 行，有问题 ${r.preview.invalid} 行`,
            'success', 4000);
        } catch (e) {
          CRM.toast('解析文件失败：' + (e.message || ''), 'error');
        } finally {
          this.impParsing = false;
        }
      },

      async doImport() {
        if (!this.impPreview) return;
        this.impImporting = true;
        try {
          const rep = await CRM.importXlsx.run('customer', this.impPreview, { duplicate_mode: this.impMode });
          this.impReport = rep;
          this.impStep = 3;
          CRM.toast(`导入完成：成功 ${rep.imported} 条，跳过 ${rep.skipped} 条`, 'success', 5000);
        } catch (e) {
          CRM.toast(e.message || '导入失败', 'error');
        } finally {
          this.impImporting = false;
        }
      },
      openDetail(row) { CRM.router.navigate(`/customers/${row.id}`); },

      openFollow(row, e) {
        if (e) e.stopPropagation();
        this.followCustomer = row;
        this.followOpen = true;
      },
      onFollowSaved() { this.load(); },

      async removeOne(row, e) {
        if (e) e.stopPropagation();
        const ok = await CRM.confirm({
          title: '删除客户',
          message: `确定要删除 <strong>${row.name}</strong> 吗？<br>删除后可在「回收站」中还原。`,
          danger: true
        });
        if (!ok) return;
        try {
          await CRM.api.deleteCustomers([row.id]);
          CRM.toast('已删除，可在回收站还原', 'success');
          this.load();
        } catch (err) {
          CRM.toast(err.message || '删除失败', 'error');
        }
      },

      async bulkDelete() {
        const ok = await CRM.confirm({
          title: '批量删除客户',
          message: `确定要删除选中的 <strong>${this.selectedCount}</strong> 家客户吗？<br>删除后可在「回收站」中还原。`,
          danger: true
        });
        if (!ok) return;
        try {
          const r = await CRM.api.deleteCustomers(this.selected);
          CRM.toast(`已删除 ${r.count} 家客户，可在回收站还原`, 'success');
          this.load();
        } catch (e) {
          CRM.toast(e.message || '删除失败', 'error');
        }
      },

      async bulkSetStatus() {
        if (!this.bulkStatus) { CRM.toast('请先选择要设置的状态', 'error'); return; }
        try {
          const r = await CRM.api.bulk({ ids: this.selected, type: 'status', value: this.bulkStatus });
          CRM.toast(`已将 ${r.count} 家客户状态改为「${this.bulkStatus}」`, 'success');
          this.bulkStatus = '';
          this.load();
        } catch (e) {
          CRM.toast(e.message || '操作失败', 'error');
        }
      },

      async bulkAddTag() {
        if (!this.bulkTagId) { CRM.toast('请先选择标签', 'error'); return; }
        try {
          const r = await CRM.api.bulk({ ids: this.selected, type: 'tag', tag_id: Number(this.bulkTagId) });
          CRM.toast(`已为 ${r.count} 家客户打上标签`, 'success');
          this.bulkTagId = '';
          this.load();
        } catch (e) {
          CRM.toast(e.message || '操作失败', 'error');
        }
      }
    },
    async created() {
      await CRM.api.loadDict();
      await CRM.api.loadTags();
      /* 行政区划：失败也不影响使用（地图数据未就绪时该筛选项为空） */
      try {
        const r = await CRM.api.get('/api/map/regions');
        this.regions = { cities: r.cities || [] };
      } catch (_) { /* 忽略 */ }
      this.load();
    },
    template: `
      <div>
        <c-page-header title="客户管理"
          desc="阀门行业定制：下游行业、主体类型、采购模式、认证要求、设计院与最终用户等完整画像。" />

        <div class="card" style="margin-bottom:16px">
          <div class="card-body" style="padding:14px 16px">
            <div class="filter-bar">
              <div class="search-box">
                <c-icon name="search" :size="15" style="color:var(--c-text-3)" />
                <input class="input" v-model="query.q"
                       placeholder="搜索客户名 / 简称 / 电话 / 联系人 / 供应商编码 / 设计院"
                       @keydown.enter="reload" />
                <button v-if="query.q" class="icon-btn" title="清空" @click="query.q = ''; reload()">✕</button>
              </div>
              <button class="btn btn-primary" @click="reload">搜索</button>

              <select class="input" v-model="sort" @change="load()">
                <option v-for="s in sorts" :key="s.key" :value="s.key">排序：{{ s.label }}</option>
              </select>
              <select class="input" v-model="order" @change="load()">
                <option value="asc">升序</option>
                <option value="desc">降序</option>
              </select>

              <button class="btn" @click="showAdvanced = !showAdvanced">
                高级筛选<span v-if="activeFilterCount"> ({{ activeFilterCount }})</span>
              </button>
              <button class="btn" v-if="activeFilterCount || query.quick || query.q" @click="clearFilters">
                清空条件
              </button>
              <div style="flex:1"></div>
              <button class="btn" title="下载 Excel 模板，填好后批量导入" @click="openImport">
                <c-icon name="file" :size="14" /> 批量导入
              </button>
              <button class="btn btn-primary" @click="openCreate">
                <c-icon name="plus" :size="14" /> 新增客户
              </button>
            </div>

            <div class="quick-chips mt-3">
              <button v-for="q in quicks" :key="q.key" class="chip"
                      :class="{ on: query.quick === q.key }" @click="setQuick(q.key)">{{ q.label }}</button>
            </div>

            <div v-show="showAdvanced" class="filter-bar mt-3">
              <template v-for="f in filters" :key="f.key">
                <!-- 归属地州：选项来自行政区划表 -->
                <select v-if="f.source === 'region'" class="input" v-model="query[f.key]" @change="reload()">
                  <option value="">{{ f.label }}（全部）</option>
                  <option v-for="c in regions.cities" :key="c.code" :value="c.code">{{ c.name }}</option>
                </select>
                <select v-else class="input" v-model="query[f.key]" @change="reload()">
                  <option value="">{{ f.label }}（全部）</option>
                  <option v-for="o in api.options(f.category)" :key="o" :value="o">{{ o }}</option>
                </select>
              </template>
              <select class="input" v-model="query.tag_id" @change="reload()">
                <option value="">标签（全部）</option>
                <option v-for="t in api.cache.tags" :key="t.id" :value="t.id">{{ t.name }}</option>
              </select>
            </div>
          </div>
        </div>

        <div v-if="selectedCount" class="note" style="margin-bottom:12px;align-items:center;flex-wrap:wrap">
          <span>已选中 <strong>{{ selectedCount }}</strong> 家客户</span>
          <div style="flex:1"></div>
          <select class="input input-sm" v-model="bulkStatus" style="min-width:130px">
            <option value="">改状态为…</option>
            <option v-for="o in api.options('customer_status')" :key="o" :value="o">{{ o }}</option>
          </select>
          <button class="btn btn-sm" :disabled="!bulkStatus" @click="bulkSetStatus">应用</button>
          <select class="input input-sm" v-model="bulkTagId" style="min-width:130px">
            <option value="">打标签…</option>
            <option v-for="t in api.cache.tags" :key="t.id" :value="t.id">{{ t.name }}</option>
          </select>
          <button class="btn btn-sm" :disabled="!bulkTagId" @click="bulkAddTag">应用</button>
          <button class="btn btn-sm btn-danger" @click="bulkDelete">删除选中</button>
          <button class="btn btn-sm" @click="selected = []">取消选择</button>
        </div>

        <div class="card">
          <c-table :columns="columns" :rows="rows" :loading="loading"
                   selectable v-model:selected="selected"
                   :sort="sort" :order="order" :row-class="rowClass"
                   empty-text="还没有客户数据"
                   empty-desc="点击右上角「新增客户」开始录入；也可在阶段四用 Excel 批量导入。"
                   @sort-change="onSort" @row-click="openDetail">

            <template #cell-name="{ row }">
              <div style="font-weight:500">{{ row.name }}</div>
              <div class="muted" style="font-size:var(--fs-xs)">
                {{ row.short_name }}<span v-if="row.city"> · {{ row.city }}</span>
              </div>
            </template>

            <template #cell-type="{ row }">
              <span class="tag muted">{{ row.type || '—' }}</span>
            </template>

            <template #cell-level="{ row }">
              <span v-if="row.level" class="tag" :class="levelClass(row.level)">{{ row.level }}</span>
              <span v-else class="muted">—</span>
            </template>

            <template #cell-status="{ row }">
              <span class="tag" :class="statusClass(row.status)">{{ row.status || '—' }}</span>
            </template>

            <template #cell-primary="{ row }">
              <template v-if="row.primary_contact">
                <div>{{ row.primary_contact }}</div>
                <div class="muted" style="font-size:var(--fs-xs)">{{ row.primary_mobile || '' }}</div>
              </template>
              <span v-else class="muted">未录入</span>
            </template>

            <template #cell-next_follow_at="{ row }">
              <span v-if="row.next_follow_at"
                    :style="isOverdue(row.next_follow_at) ? 'color:var(--c-danger);font-weight:600' : ''">
                {{ fmtDate(row.next_follow_at) }}
                <span v-if="isOverdue(row.next_follow_at)" style="font-size:11px">逾期</span>
              </span>
              <span v-else class="muted">—</span>
            </template>

            <template #cell-annual_demand="{ row }">
              <span :class="row.annual_demand ? '' : 'muted'">{{ row.annual_demand || '—' }}</span>
            </template>

            <template #cell-project_count="{ row }">
              <span :class="row.project_count ? '' : 'muted'">{{ row.project_count }}</span>
            </template>

            <template #cell-ops="{ row }">
              <div style="display:flex;gap:4px;justify-content:flex-end" @click.stop>
                <button class="btn btn-sm" title="记录跟进" @click="openFollow(row, $event)">跟进</button>
                <button class="btn btn-sm" @click="openEdit(row)">编辑</button>
                <button class="btn btn-sm btn-danger" @click="removeOne(row, $event)">删除</button>
              </div>
            </template>
          </c-table>

          <c-pager :page="page" :pages="pages" :total="total" :page-size="pageSize"
                   @update:page="onPage" @update:page-size="onPageSize" />
        </div>

        <c-customer-edit v-model="editOpen" :customer="editing" @saved="onSaved" />

        <c-followup-drawer v-model="followOpen"
                           :customer-id="followCustomer ? followCustomer.id : ''"
                           :customer-name="followCustomer ? (followCustomer.short_name || followCustomer.name) : ''"
                           @saved="onFollowSaved" />

        <!-- ============ 批量导入抽屉 ============ -->
        <div v-if="importOpen" class="drawer-mask" @click.self="closeImport">
          <div class="drawer" style="width:760px;max-width:96vw">
            <div class="drawer-head">
              <div>
                <div class="drawer-title">批量导入客户</div>
                <div class="drawer-sub">下载模板 → 在 Excel 里填好 → 拖进来；导入前会先校验并预览，不会直接写入</div>
              </div>
              <button class="icon-btn" @click="closeImport">✕</button>
            </div>

            <div class="drawer-body">
              <!-- 步骤 1：下载模板 + 选文件 -->
              <template v-if="impStep === 1">
                <div class="note" style="margin-bottom:14px">
                  <c-icon name="alert" :size="16" />
                  <div style="font-size:var(--fs-sm)">
                    先下载模板，里面含 <strong>填写说明</strong> 与 <strong>可选值参考</strong> 两页，
                    按参考页里的写法填可以避免字典里多出重复选项。
                  </div>
                </div>

                <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
                  <button class="btn btn-primary" :disabled="tplBusy" @click="downloadTemplate">
                    <c-icon name="file" :size="14" /> {{ tplBusy ? '生成中…' : '下载导入模板（.xlsx）' }}
                  </button>
                  <button class="btn" @click="downloadSampleData">导出现有客户当作样例</button>
                </div>

                <div class="drop-zone" :class="{ over: impDragOver }"
                     @dragover.prevent="impDragOver = true"
                     @dragleave.prevent="impDragOver = false"
                     @drop.prevent="onImportDrop">
                  <c-icon name="file" :size="30" />
                  <div class="mt-3">
                    {{ impParsing ? '正在解析…' : '把填好的 Excel 拖到这里，或' }}
                    <label v-if="!impParsing" class="link-btn">
                      点击选择文件
                      <input type="file" accept=".xlsx,.xls,.csv" style="display:none"
                             @change="onImportFile" />
                    </label>
                  </div>
                  <div class="muted mt-3" style="font-size:var(--fs-xs)">
                    支持 .xlsx / .xls / .csv，单次最多 5000 行
                  </div>
                </div>
                <div v-if="impFileName" class="muted mt-3" style="font-size:var(--fs-xs)">
                  已选择：{{ impFileName }}
                </div>
              </template>

              <!-- 步骤 2：预览与确认 -->
              <template v-else-if="impStep === 2 && impPreview">
                <div class="import-steps">
                  <div class="import-step on"><span class="idx">1</span>选择文件</div>
                  <div class="import-step on"><span class="idx">2</span>校验预览</div>
                  <div class="import-step"><span class="idx">3</span>完成</div>
                </div>

                <div class="stat-grid" style="margin-bottom:14px;grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">
                  <div class="stat"><div class="n">{{ impPreview.total }}</div><div class="l">总行数</div></div>
                  <div class="stat"><div class="n" style="color:var(--c-success)">{{ impPreview.valid }}</div><div class="l">可导入</div></div>
                  <div class="stat"><div class="n" :style="impPreview.invalid ? 'color:var(--c-danger)' : ''">{{ impPreview.invalid }}</div><div class="l">有问题</div></div>
                </div>

                <div v-if="impErrors.length" class="note warn" style="margin-bottom:14px">
                  <c-icon name="alert" :size="16" />
                  <div style="font-size:var(--fs-sm)">
                    有 {{ impErrors.length }} 行存在问题，这些行<strong>不会被导入</strong>：
                    <div class="table-wrap mt-3" style="max-height:200px;overflow:auto">
                      <table class="data-table">
                        <thead><tr><th style="width:70px">行号</th><th>问题</th></tr></thead>
                        <tbody>
                          <tr v-for="r in impErrors.slice(0, 30)" :key="r.line">
                            <td>第 {{ r.line }} 行</td>
                            <td>{{ r.errors.join('；') }}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <div v-if="impErrors.length > 30" class="muted mt-3" style="font-size:var(--fs-xs)">
                      仅列出前 30 行
                    </div>
                  </div>
                </div>

                <div v-if="impDuplicates.length" class="note" style="margin-bottom:14px">
                  <c-icon name="alert" :size="16" />
                  <div style="font-size:var(--fs-sm)">
                    有 {{ impDuplicates.length }} 行与库中已有客户重名，按下方设置处理。
                  </div>
                </div>

                <c-card title="导入设置" sub="重复客户如何处理">
                  <div class="form-grid">
                    <div class="field">
                      <label class="field-label">遇到同名客户</label>
                      <select class="input" v-model="impMode">
                        <option value="skip">跳过（保留库中已有资料）</option>
                        <option value="update">更新已有记录（用表格里的值覆盖）</option>
                      </select>
                    </div>
                  </div>
                </c-card>
              </template>

              <!-- 步骤 3：结果 -->
              <template v-else-if="impStep === 3 && impReport">
                <div class="import-steps">
                  <div class="import-step on"><span class="idx">1</span>选择文件</div>
                  <div class="import-step on"><span class="idx">2</span>校验预览</div>
                  <div class="import-step on"><span class="idx">3</span>完成</div>
                </div>
                <div class="stat-grid" style="margin-bottom:14px;grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">
                  <div class="stat"><div class="n" style="color:var(--c-success)">{{ impReport.imported }}</div><div class="l">成功导入</div></div>
                  <div class="stat"><div class="n">{{ impReport.skipped }}</div><div class="l">跳过</div></div>
                  <div class="stat"><div class="n" :style="impReport.failed ? 'color:var(--c-danger)' : ''">{{ impReport.failed }}</div><div class="l">失败</div></div>
                  <div class="stat"><div class="n" :style="impReport.invalid ? 'color:var(--c-warning)' : ''">{{ impReport.invalid }}</div><div class="l">校验未通过</div></div>
                </div>
                <div v-if="impReport.dictAdded" class="note" style="margin-bottom:14px">
                  <c-icon name="check" :size="16" />
                  <div style="font-size:var(--fs-sm)">
                    导入过程中自动新增了 {{ impReport.dictAdded }} 个字典选项（表格里出现了字典中没有的词）。
                    可在「功能设置 → 字典管理」里检查与合并。
                  </div>
                </div>
                <div v-if="(impReport.errors || []).length" class="note warn">
                  <c-icon name="alert" :size="16" />
                  <div style="font-size:var(--fs-sm)">
                    失败行原因：
                    <div v-for="(e, i) in impReport.errors.slice(0, 20)" :key="i">第 {{ e.line }} 行：{{ e.message }}</div>
                  </div>
                </div>
              </template>
            </div>

            <div class="drawer-foot">
              <span class="muted" style="font-size:var(--fs-xs);margin-right:auto">
                <template v-if="impStep === 1">提示：模板第 2、3 行是示例，填之前可以删掉</template>
                <template v-else-if="impStep === 2">确认无误后点「开始导入」</template>
                <template v-else>导入完成</template>
              </span>
              <button class="btn" @click="closeImport">{{ impStep === 3 ? '关闭' : '取消' }}</button>
              <button v-if="impStep === 2" class="btn btn-primary" :disabled="impImporting || !impPreview.valid"
                      @click="doImport">
                {{ impImporting ? '导入中…' : '开始导入（' + impPreview.valid + ' 条）' }}
              </button>
              <button v-if="impStep === 3" class="btn btn-primary" @click="resetImport">继续导入</button>
            </div>
          </div>
        </div>
      </div>`,
    setup() { return { api: CRM.api }; }
  };

  CRM.pages = CRM.pages || {};
  CRM.pages.customers = CustomersPage;

})(window.CRM);
