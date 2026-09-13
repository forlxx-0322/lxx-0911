/**
 * 项目列表页
 * 双视图：14 阶段看板（支持拖动改阶段）/ 表格
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  const STAGES = [
    '信息收集', '初步接洽', '技术交流', '方案选型', '询价报价', '投标/议价',
    '已中标/已签约', '生产执行', '发货交付', '安装调试', '验收结项',
    '质保期内', '已暂停', '已终止'
  ];

  const QUICKS = [
    { key: 'active', label: '进行中' },
    { key: 'bidding', label: '在投标中' },
    { key: 'upcoming_bid', label: '7 天内开标' },
    { key: 'overdue_payment', label: '有逾期回款' },
    { key: 'unsigned', label: '未签约' }
  ];

  const COLUMNS = [
    { key: 'name', label: '项目名称', width: '250px' },
    { key: 'customer', label: '所属客户', width: '136px' },
    { key: 'stage', label: '阶段', width: '112px' },
    { key: 'progress', label: '进度', width: '80px', align: 'center' },
    { key: 'contract_amount', label: '合同额', sortable: true, align: 'right', width: '108px' },
    { key: 'received_amount', label: '已回款', align: 'right', width: '108px' },
    { key: 'debt_amount', label: '欠款', align: 'right', width: '108px' },
    { key: 'payment_rate', label: '回款率', width: '86px', align: 'center' },
    { key: 'bid_date', label: '投标日期', sortable: true, width: '106px' },
    { key: 'delivery_date', label: '交货期', sortable: true, width: '104px' },
    { key: 'ops', label: '操作', width: '122px', align: 'right' }
  ];

  const ProjectsPage = {
    name: 'ProjectsPage',
    data() {
      return {
        columns: COLUMNS,
        stages: STAGES,
        quicks: QUICKS,
        view: 'board',           // board | table
        rows: [],
        columnsData: [],
        total: 0,
        page: 1,
        pageSize: 20,
        pages: 1,
        sort: 'updated_at',
        order: 'desc',
        loading: false,
        editingLoading: false,
        selected: [],
        summary: { contract_total: 0, received_total: 0, debt_total: 0 },
        showAdvanced: false,
        query: {
          q: '', quick: '', stage: '', bid_result: '', payment_status: '',
          customer_id: '', date_field: '', date_from: '', date_to: ''
        },
        editOpen: false,
        editing: null,
        dragId: null,
        dragOverStage: ''
      };
    },
    computed: {
      selectedCount() { return this.selected.length; },
      activeFilterCount() {
        return ['stage', 'bid_result', 'payment_status', 'customer_id', 'date_from', 'date_to']
          .filter((k) => this.query[k]).length;
      },
      bidResults() { return ['未投标', '已投标待开标', '已中标', '未中标', '已废标']; },
      payStatuses() { return ['未签约', '未开始', '部分回款', '已结清', '有欠款']; },
      customers() { return CRM.api.customerOptions(); }
    },
    methods: {
      fmtDate: CRM.util.fmtDate,
      fmtMoney: CRM.util.fmtMoney,
      fmtMoneyShort: CRM.util.fmtMoneyShort,

      stageClass(stage) {
        if (stage === '已终止') return 'danger';
        if (stage === '已暂停') return 'muted';
        if (['已中标/已签约', '生产执行', '发货交付', '安装调试', '验收结项', '质保期内'].includes(stage)) return 'success';
        if (['询价报价', '投标/议价'].includes(stage)) return 'warning';
        return '';
      },

      rowClass(row) {
        return row.overdue_payment ? 'row-overdue clickable' : 'clickable';
      },

      rateColor(rate) {
        if (rate >= 100) return 'var(--c-success)';
        if (rate <= 0) return 'var(--c-text-3)';
        return 'var(--c-warning)';
      },

      async load() {
        this.loading = true;
        try {
          const params = Object.assign({}, this.query, { sort: this.sort, order: this.order });
          if (this.view === 'board') {
            const d = await CRM.api.boardProjects(params);
            this.columnsData = d.columns;
            this.total = d.total;
            this.summary = d.summary || this.summary;
            this.rows = [];
          } else {
            const d = await CRM.api.listProjects(Object.assign({}, params, {
              page: this.page, pageSize: this.pageSize
            }));
            this.rows = d.list;
            this.total = d.total;
            this.pages = d.pages;
            this.summary = d.summary || this.summary;
            this.selected = [];
          }
        } catch (e) {
          CRM.toast(e.message || '加载失败', 'error');
        } finally {
          this.loading = false;
        }
      },

      reload() { this.page = 1; this.load(); },

      switchView(v) {
        if (this.view === v) return;
        this.view = v;
        this.selected = [];
        this.load();
      },

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
       * 打开编辑抽屉：先取完整记录再打开。
       * 列表行只带一部分字段，直接当初始值会导致未包含的字段被保存为空值
       * （与客户「详细地址被清空」同一成因）。
       */
      async openEdit(row, e) {
        if (e) e.stopPropagation();
        this.editingLoading = true;
        try {
          this.editing = await CRM.api.getProject(row.id);
        } catch (err) {
          CRM.toast(err.message || '读取项目资料失败', 'error');
          this.editing = row;
        } finally {
          this.editingLoading = false;
          this.editOpen = true;
        }
      },

      onSaved() { this.load(); },
      openDetail(row) { CRM.router.navigate(`/projects/${row.id}`); },

      async removeOne(row, e) {
        if (e) e.stopPropagation();
        const ok = await CRM.confirm({
          title: '删除项目',
          message: `确定要删除 <strong>${row.name}</strong> 吗？<br>删除后可在「回收站」中还原。`,
          danger: true
        });
        if (!ok) return;
        try {
          await CRM.api.deleteProjects([row.id]);
          CRM.toast('项目已删除，可在回收站还原', 'success');
          this.load();
        } catch (err) {
          CRM.toast(err.message || '删除失败', 'error');
        }
      },

      async bulkDelete() {
        const ok = await CRM.confirm({
          title: '批量删除项目',
          message: `确定要删除选中的 <strong>${this.selectedCount}</strong> 个项目吗？`,
          danger: true
        });
        if (!ok) return;
        try {
          const r = await CRM.api.deleteProjects(this.selected);
          CRM.toast(`已删除 ${r.count} 个项目`, 'success');
          this.load();
        } catch (e) {
          CRM.toast(e.message || '删除失败', 'error');
        }
      },

      /* ---------- 看板拖动 ---------- */
      onDragStart(item, e) {
        this.dragId = item.id;
        if (e && e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', String(item.id)); } catch (_) { /* 忽略 */ }
        }
      },
      onDragOver(stage, e) {
        if (e) e.preventDefault();
        this.dragOverStage = stage;
      },
      onDragLeave(stage) {
        if (this.dragOverStage === stage) this.dragOverStage = '';
      },
      async onDrop(stage) {
        this.dragOverStage = '';
        const id = this.dragId;
        this.dragId = null;
        if (!id) return;
        const item = this.columnsData.flatMap((c) => c.items).find((p) => p.id === id);
        if (!item || item.stage === stage) return;
        try {
          await CRM.api.moveStage(id, stage);
          CRM.toast(`「${item.name.slice(0, 14)}…」阶段已调整为 ${stage}`, 'success');
          this.load();
        } catch (e) {
          CRM.toast(e.message || '调整阶段失败', 'error');
        }
      },
      /* 无鼠标拖动的兜底：卡片上直接选阶段 */
      async quickMove(item, stage, e) {
        if (e) e.stopPropagation();
        if (!stage || stage === item.stage) return;
        try {
          await CRM.api.moveStage(item.id, stage);
          CRM.toast(`阶段已调整为 ${stage}`, 'success');
          this.load();
        } catch (err) {
          CRM.toast(err.message || '调整阶段失败', 'error');
        }
      }
    },
    async created() {
      await CRM.api.loadDict();
      await CRM.api.loadCustomerOptions();
      this.load();
    },
    template: `
      <div>
        <c-page-header title="项目管理"
          desc="以项目为主线串起客户、招投标、阀门需求与回款。欠款与回款率全部由实收流水自动计算。" />

        <div class="stat-grid" style="margin-bottom:14px">
          <div class="stat">
            <div class="n">{{ total }}</div>
            <div class="l">项目总数（按当前筛选）</div>
          </div>
          <div class="stat">
            <div class="n">{{ fmtMoneyShort(summary.contract_total) }}</div>
            <div class="l">合同总额</div>
          </div>
          <div class="stat">
            <div class="n" style="color:var(--c-success)">{{ fmtMoneyShort(summary.received_total) }}</div>
            <div class="l">已回款</div>
          </div>
          <div class="stat">
            <div class="n" :style="summary.debt_total > 0 ? 'color:var(--c-danger)' : ''">
              {{ fmtMoneyShort(summary.debt_total) }}
            </div>
            <div class="l">欠款合计</div>
          </div>
        </div>

        <div class="card" style="margin-bottom:16px">
          <div class="card-body" style="padding:14px 16px">
            <div class="filter-bar">
              <div class="search-box">
                <c-icon name="search" :size="15" style="color:var(--c-text-3)" />
                <input class="input" v-model="query.q"
                       placeholder="搜索项目名 / 客户 / 最终用户 / 设计院 / 阀门需求"
                       @keydown.enter="reload" />
                <button v-if="query.q" class="icon-btn" @click="query.q = ''; reload()">✕</button>
              </div>
              <button class="btn btn-primary" @click="reload">搜索</button>

              <select class="input" v-model="sort" @change="load()">
                <option value="updated_at">排序：最近修改</option>
                <option value="stage">排序：阶段顺序</option>
                <option value="contract_amount">排序：合同额</option>
                <option value="signed_at">排序：签约日期</option>
                <option value="bid_date">排序：投标日期</option>
                <option value="delivery_date">排序：交货期</option>
              </select>
              <select class="input" v-model="order" @change="load()">
                <option value="desc">降序</option>
                <option value="asc">升序</option>
              </select>

              <button class="btn" @click="showAdvanced = !showAdvanced">
                高级筛选<span v-if="activeFilterCount"> ({{ activeFilterCount }})</span>
              </button>
              <button class="btn" v-if="activeFilterCount || query.quick || query.q" @click="clearFilters">清空条件</button>

              <div style="flex:1"></div>
              <button class="btn btn-sm" :class="{ 'btn-primary': view === 'board' }" @click="switchView('board')">看板</button>
              <button class="btn btn-sm" :class="{ 'btn-primary': view === 'table' }" @click="switchView('table')">表格</button>
              <button class="btn btn-primary" @click="openCreate">
                <c-icon name="plus" :size="14" /> 新增项目
              </button>
            </div>

            <div class="quick-chips mt-3">
              <button v-for="q in quicks" :key="q.key" class="chip"
                      :class="{ on: query.quick === q.key }" @click="setQuick(q.key)">{{ q.label }}</button>
            </div>

            <div v-show="showAdvanced" class="filter-bar mt-3">
              <select class="input" v-model="query.stage" @change="reload()">
                <option value="">项目阶段（全部）</option>
                <option v-for="s in stages" :key="s" :value="s">{{ s }}</option>
              </select>
              <select class="input" v-model="query.bid_result" @change="reload()">
                <option value="">投标结果（全部）</option>
                <option v-for="b in bidResults" :key="b" :value="b">{{ b }}</option>
              </select>
              <select class="input" v-model="query.payment_status" @change="reload()">
                <option value="">回款状态（全部）</option>
                <option v-for="p in payStatuses" :key="p" :value="p">{{ p }}</option>
              </select>
              <select class="input" v-model="query.customer_id" @change="reload()">
                <option value="">所属客户（全部）</option>
                <option v-for="c in customers" :key="c.id" :value="c.id">{{ c.short_name || c.name }}</option>
              </select>
              <select class="input" v-model="query.date_field" @change="reload()">
                <option value="">日期字段…</option>
                <option value="bid_date">按投标日期</option>
                <option value="signed_at">按签约日期</option>
                <option value="delivery_date">按交货期</option>
              </select>
              <input class="input" type="date" v-model="query.date_from" @change="reload()" />
              <span class="muted">至</span>
              <input class="input" type="date" v-model="query.date_to" @change="reload()" />
            </div>
          </div>
        </div>

        <div v-if="view === 'board'" class="card">
          <div class="card-body" style="padding:12px">
            <div v-if="loading" class="muted" style="padding:24px;text-align:center">正在加载看板…</div>
            <c-empty v-else-if="!total" icon="projects" title="还没有项目"
                     desc="点击右上角「新增项目」录入第一个项目。" />
            <div v-else class="kanban">
              <div v-for="col in columnsData" :key="col.stage" class="kanban-col"
                   :class="{ 'drag-over': dragOverStage === col.stage }"
                   @dragover="onDragOver(col.stage, $event)"
                   @dragleave="onDragLeave(col.stage)"
                   @drop="onDrop(col.stage)">
                <div class="kanban-head">
                  <span class="tag" :class="stageClass(col.stage)">{{ col.stage }}</span>
                  <span class="muted" style="font-size:var(--fs-xs);margin-left:auto">{{ col.count }} 个</span>
                </div>
                <div class="kanban-amount muted">{{ fmtMoneyShort(col.contract_total) }}</div>
                <div class="kanban-body">
                  <div v-for="p in col.items" :key="p.id" class="kanban-card"
                       :class="{ dragging: dragId === p.id }"
                       draggable="true"
                       @dragstart="onDragStart(p, $event)"
                       @dragend="dragId = null"
                       @click="openDetail(p)">
                    <div class="kc-title">{{ p.name }}</div>
                    <div class="kc-cust muted">{{ p.customer_short || p.customer_name || '—' }}</div>
                    <div class="kc-money">
                      <span>{{ fmtMoneyShort(p.contract_amount) }}</span>
                      <span v-if="p.debt_amount > 0" style="color:var(--c-danger);font-size:var(--fs-xs)">
                        欠 {{ fmtMoneyShort(p.debt_amount) }}
                      </span>
                      <span v-else-if="p.contract_amount > 0" style="color:var(--c-success);font-size:var(--fs-xs)">已结清</span>
                    </div>
                    <div class="kc-meta">
                      <span v-if="p.overdue_payment" class="tag danger" style="font-size:10px">回款逾期</span>
                      <span v-if="p.bid_date" class="muted" style="font-size:10px">投标 {{ fmtDate(p.bid_date) }}</span>
                    </div>
                    <div class="kc-actions" @click.stop>
                      <select class="input input-sm" style="font-size:11px;padding:1px 4px;width:100%"
                              :value="p.stage" @change="quickMove(p, $event.target.value, $event)">
                        <option v-for="s in stages" :key="s" :value="s">{{ s }}</option>
                      </select>
                    </div>
                  </div>
                  <div v-if="!col.items.length" class="kanban-empty muted">暂无</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <template v-else>
          <div v-if="selectedCount" class="note" style="margin-bottom:12px;align-items:center">
            <span>已选中 <strong>{{ selectedCount }}</strong> 个项目</span>
            <div style="flex:1"></div>
            <button class="btn btn-sm btn-danger" @click="bulkDelete">删除选中</button>
            <button class="btn btn-sm" @click="selected = []">取消选择</button>
          </div>

          <div class="card">
            <c-table :columns="columns" :rows="rows" :loading="loading"
                     selectable v-model:selected="selected"
                     :sort="sort" :order="order" :row-class="rowClass"
                     empty-text="还没有项目" empty-desc="点击右上角「新增项目」开始录入。"
                     @sort-change="onSort" @row-click="openDetail">
              <template #cell-name="{ row }">
                <div style="font-weight:500">{{ row.name }}</div>
                <div class="muted" style="font-size:var(--fs-xs)">
                  {{ row.quantity ? row.quantity + ' 台/套' : '' }}
                  <span v-if="row.end_user"> · {{ row.end_user }}</span>
                </div>
              </template>
              <template #cell-customer="{ row }">
                <span v-if="row.customer_short">{{ row.customer_short }}</span>
                <span v-else class="muted">{{ row.customer_name || '—' }}</span>
              </template>
              <template #cell-stage="{ row }">
                <span class="tag" :class="stageClass(row.stage)">{{ row.stage }}</span>
              </template>
              <template #cell-progress="{ row }">
                <div class="mini-bar"><span :style="{ width: row.progress + '%' }"></span></div>
                <div class="muted" style="font-size:10px;text-align:center">{{ row.progress }}%</div>
              </template>
              <template #cell-contract_amount="{ row }">
                <span :class="row.contract_amount ? '' : 'muted'">
                  {{ row.contract_amount ? fmtMoney(row.contract_amount) : '未签约' }}
                </span>
              </template>
              <template #cell-received_amount="{ row }">{{ fmtMoney(row.received_amount) }}</template>
              <template #cell-debt_amount="{ row }">
                <span v-if="row.debt_amount > 0" style="color:var(--c-danger)">{{ fmtMoney(row.debt_amount) }}</span>
                <span v-else-if="row.contract_amount > 0" style="color:var(--c-success)">0</span>
                <span v-else class="muted">—</span>
              </template>
              <template #cell-payment_rate="{ row }">
                <span :style="{ color: rateColor(row.payment_rate) }">
                  {{ row.contract_amount > 0 ? row.payment_rate + '%' : '—' }}
                </span>
              </template>
              <template #cell-bid_date="{ row }">
                <span v-if="row.bid_date">
                  {{ fmtDate(row.bid_date) }}
                  <div v-if="row.bid_result" class="muted" style="font-size:10px">{{ row.bid_result }}</div>
                </span>
                <span v-else class="muted">—</span>
              </template>
              <template #cell-delivery_date="{ row }">
                {{ row.delivery_date ? fmtDate(row.delivery_date) : '—' }}
              </template>
              <template #cell-ops="{ row }">
                <div style="display:flex;gap:4px;justify-content:flex-end" @click.stop>
                  <button class="btn btn-sm" @click="openEdit(row, $event)">编辑</button>
                  <button class="btn btn-sm btn-danger" @click="removeOne(row, $event)">删除</button>
                </div>
              </template>
            </c-table>
            <c-pager :page="page" :pages="pages" :total="total" :page-size="pageSize"
                     @update:page="onPage" @update:page-size="onPageSize" />
          </div>
        </template>

        <c-project-edit v-model="editOpen" :project="editing" @saved="onSaved" />
      </div>`,
    setup() { return { api: CRM.api }; }
  };

  CRM.pages = CRM.pages || {};
  CRM.pages.projects = ProjectsPage;

})(window.CRM);
