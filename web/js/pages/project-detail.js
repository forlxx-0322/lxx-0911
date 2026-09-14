/**
 * 项目详情页
 * 5 个标签页：基本信息 / 回款计划 / 实收流水 / 待办 / 变更记录
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  const ProjectDetail = {
    name: 'ProjectDetail',
    props: { id: [String, Number] },
    data() {
      return {
        project: null,
        loading: true,
        error: '',
        tab: 'basic',
        editOpen: false,
        followOpen: false,
        paymentOpen: false,
        paymentType: '计划',
        editingPayment: null,
        taskTitle: '',
        taskDue: '',
        taskPriority: '中',
        savingTask: false,
        /* 报价单 */
        quotations: [],
        quotationsLoading: false,
        quotationOpen: false,
        editingQuotation: null,
        /* 落标登记抽屉 */
        loseOpen: false,
        loseTarget: null,
        loseForm: { competitor: '', competitor_price: '', lose_reason: '' },
        loseSaving: false
      };
    },
    computed: {
      tabs() {
        const p = this.project;
        return [
          { key: 'basic', label: '基本信息' },
          { key: 'quotations', label: '报价单', badge: this.quotations.length },
          { key: 'plans', label: '回款计划', badge: p ? p.plans.length : 0 },
          { key: 'receipts', label: '实收流水', badge: p ? p.receipts.length : 0 },
          { key: 'tasks', label: '待办', badge: p ? p.summary.task_count : 0 },
          { key: 'files', label: '附件' },
          { key: 'logs', label: '变更记录', badge: p ? p.logs.length : 0 }
        ];
      },
      basicRows() {
        const p = this.project;
        if (!p) return [];
        const rows = [
          ['项目阶段', p.stage],
          ['进度', (p.progress || 0) + '%'],
          ['所属客户', p.customer ? (p.customer.short_name || p.customer.name) : ''],
          ['最终用户', p.end_user],
          ['设计院', p.design_institute],
          ['阀门需求', String(p.valve_needs || '').split(',').filter(Boolean).join('、')],
          ['数量', p.quantity ? p.quantity + ' 台/套' : ''],
          ['投标日期', p.bid_date ? CRM.util.fmtDate(p.bid_date) : ''],
          ['投标结果', p.bid_result],
          ['中标/失标原因', p.win_rate_note],
          ['签约日期', p.signed_at ? CRM.util.fmtDate(p.signed_at) : ''],
          ['合同金额', p.contract_amount ? CRM.util.fmtMoney(p.contract_amount) + ' 元' : ''],
          ['合同交货期', p.delivery_date ? CRM.util.fmtDate(p.delivery_date) : ''],
          ['开始日期', p.start_date ? CRM.util.fmtDate(p.start_date) : ''],
          ['预计结束', p.end_date ? CRM.util.fmtDate(p.end_date) : ''],
          ['负责人', p.owner],
          ['备注', p.remark]
        ];
        return rows.filter((r) => r[1] !== '' && r[1] !== null && r[1] !== undefined && r[1] !== '0%');
      }
    },
    watch: {
      id() { this.load(); }
    },
    methods: {
      fmtDate: CRM.util.fmtDate,
      fmtMoney: CRM.util.fmtMoney,
      fmtMoneyShort: CRM.util.fmtMoneyShort,

      async load() {
        this.loading = true;
        this.error = '';
        try {
          await CRM.api.loadDict();
          this.project = await CRM.api.getProject(this.id);
          await this.loadQuotations();
        } catch (e) {
          this.error = e.message || '加载失败';
        } finally {
          this.loading = false;
        }
      },

      /* ---------------- 报价单 ---------------- */
      async loadQuotations() {
        this.quotationsLoading = true;
        try {
          const r = await CRM.api.listQuotations({ project_id: this.id });
          this.quotations = r.list || [];
        } catch (e) {
          this.quotations = [];
        } finally {
          this.quotationsLoading = false;
        }
      },
      openQuotation() {
        this.editingQuotation = null;
        this.quotationOpen = true;
      },
      async editQuotation(row) {
        try {
          this.editingQuotation = await CRM.api.getQuotation(row.id);
          this.quotationOpen = true;
        } catch (e) {
          CRM.toast(e.message || '读取报价单失败', 'error');
        }
      },
      async onQuotationSaved() { await this.loadQuotations(); },

      statusClass(s) {
        if (s === '已中标') return 'success';
        if (s === '已落标') return 'danger';
        if (s === '已报出') return 'warning';
        if (s === '已过期') return 'muted';
        return '';
      },

      /** 复制为新版本 */
      async copyQuotation(row) {
        const ok = await CRM.confirm({
          title: '复制为新版本',
          message: `将以「${row.quote_no}」为基础创建一个新版本（版本号 +1，状态重置为草稿）。<br>原单保留，可随时对比。`,
          okText: '复制'
        });
        if (!ok) return;
        try {
          const r = await CRM.api.copyQuotation(row.id);
          CRM.toast(`已创建 V${r.version}（${r.quote_no}）`, 'success');
          await this.loadQuotations();
        } catch (e) {
          CRM.toast(e.message || '复制失败', 'error');
        }
      },

      /** 删除报价单（软删除，进回收站） */
      async removeQuotation(row) {
        const ok = await CRM.confirm({
          title: '删除报价单',
          message: `确定删除报价单「${row.quote_no}」（V${row.version}）吗？<br>删除后进入回收站，可还原。`,
          okText: '删除',
          danger: true
        });
        if (!ok) return;
        try {
          await CRM.api.deleteQuotation(row.id);
          CRM.toast('已删除', 'success');
          await this.loadQuotations();
        } catch (e) {
          CRM.toast(e.message || '删除失败', 'error');
        }
      },

      /**
       * 改状态。中标时额外询问是否把报价合计回填到项目合同额。
       *
       * 这是本模块唯一会改动项目金额的入口，因此做成"两步确认"：
       * 先确认改状态，中标时再单独确认回填（并列出将改动的字段）。
       */
      async changeStatus(row, status) {
        if (row.status === status) return;

        let extra = {};
        if (status === '已落标') {
          /* 落标要登记竞对信息，用抽屉收集（单值 prompt 不够用） */
          this.loseTarget = row;
          this.loseForm = { competitor: row.competitor || '', competitor_price: row.competitor_price || '', lose_reason: row.lose_reason || '' };
          this.loseOpen = true;
          return;
        }

        try {
          const r = await CRM.api.setQuotationStatus(row.id, { status });
          CRM.toast(`报价单状态已改为「${status}」`, 'success');
          await this.loadQuotations();
          await this.maybeOfferApply(r);
        } catch (e) {
          CRM.toast(e.message || '改状态失败', 'error');
        }
      },

      /** 落标抽屉保存 */
      async saveLose() {
        const row = this.loseTarget;
        if (!row) return;
        this.loseSaving = true;
        try {
          const r = await CRM.api.setQuotationStatus(row.id, Object.assign({ status: '已落标' }, this.loseForm));
          this.loseOpen = false;
          CRM.toast('已标记为落标', 'success');
          await this.loadQuotations();
          await this.maybeOfferApply(r);
        } catch (e) {
          CRM.toast(e.message || '标记落标失败', 'error');
        } finally {
          this.loseSaving = false;
        }
      },

      /**
       * 中标后询问是否回填项目。
       * 独立成方法：正常改状态与落标抽屉两条路径都会走到这里。
       */
      async maybeOfferApply(r) {
        if (!r || !r.can_apply || !r.project) return;
        const yes = await CRM.confirm({
          title: '是否回填项目合同额？',
          message: `报价单已标记为「已中标」。<br><br>`
            + `项目「${r.project.name}」将更新为：<br>`
            + `合同额：${CRM.util.fmtMoney(r.project.contract_amount)} → <strong>${CRM.util.fmtMoney(r.quote_total)}</strong> 元<br>`
            + `阶段：${r.project.stage || '（空）'} → <strong>已中标/已签约</strong><br>`
            + `投标结果：${r.project.bid_result || '（空）'} → <strong>已中标</strong>`,
          okText: '回填项目',
          cancelText: '暂不'
        });
        if (!yes) return;
        try {
          const a = await CRM.api.applyQuotationToProject(r.id);
          CRM.toast(a.applied ? `已回填 ${a.changes.length} 项到项目` : (a.message || '无需修改'), 'success');
          await this.load();
        } catch (e) {
          CRM.toast(e.message || '回填失败', 'error');
        }
      },

      /** 导出 Excel 报价单（浏览器端 SheetJS 生成，后端只给数据） */
      async exportQuotation(row) {
        try {
          const data = await CRM.api.quotationExportData(row.id);
          CRM.quotation.buildWorkbook(data);
          CRM.toast('报价单已导出', 'success');
        } catch (e) {
          CRM.toast(e.message || '导出失败', 'error');
        }
      },

      stageClass(stage) {
        if (!stage) return 'muted';
        if (stage === '已终止') return 'danger';
        if (stage === '已暂停') return 'muted';
        if (['已中标/已签约', '生产执行', '发货交付', '安装调试', '验收结项', '质保期内'].includes(stage)) return 'success';
        if (['询价报价', '投标/议价'].includes(stage)) return 'warning';
        return '';
      },

      payStatusClass(s) {
        if (s === '已结清') return 'success';
        if (s === '部分回款') return 'warning';
        if (s === '未签约') return 'muted';
        return '';
      },

      markClass(action) {
        if (action === 'create') return 'success';
        if (action === 'delete') return 'danger';
        if (action === 'payment') return 'warning';
        return 'muted';
      },
      actionText(action) {
        const MAP = {
          create: '新建', update: '修改', delete: '删除', restore: '还原',
          payment: '回款', followup: '跟进', bulk: '批量'
        };
        return MAP[action] || action;
      },

      back() { CRM.router.navigate('/projects'); },

      openPlan() { this.editingPayment = null; this.paymentType = '计划'; this.paymentOpen = true; },
      openReceipt() { this.editingPayment = null; this.paymentType = '实收'; this.paymentOpen = true; },
      editPlan(p) { this.editingPayment = p; this.paymentType = '计划'; this.paymentOpen = true; },
      editReceipt(r) { this.editingPayment = r; this.paymentType = '实收'; this.paymentOpen = true; },
      onPaymentSaved() { this.load(); },

      async removePayment(p) {
        const isPlan = p.type === '计划';
        const ok = await CRM.confirm({
          title: isPlan ? '删除回款计划' : '删除实收记录',
          message: isPlan
            ? `确定要删除这条回款计划（${CRM.util.fmtMoney(p.amount)} 元）吗？<br>已核销的实收记录会保留，但会解除与它的关联。`
            : `确定要删除这条实收记录（${CRM.util.fmtMoney(p.amount)} 元）吗？<br>删除后项目欠款与回款率会自动重算。`,
          danger: true
        });
        if (!ok) return;
        try {
          await CRM.api.deletePayment(p.id);
          CRM.toast('已删除，金额已自动重算', 'success');
          this.load();
        } catch (e) {
          CRM.toast(e.message || '删除失败', 'error');
        }
      },

      async addTask() {
        const title = String(this.taskTitle || '').trim();
        if (!title) { CRM.toast('请填写待办内容', 'error'); return; }
        this.savingTask = true;
        try {
          await CRM.api.saveTask({
            title,
            project_id: Number(this.id),
            customer_id: this.project.customer_id,
            due_at: this.taskDue ? this.taskDue.replace('T', ' ') + ':00' : null,
            priority: this.taskPriority,
            source: '手动'
          });
          this.taskTitle = '';
          this.taskDue = '';
          this.taskPriority = '中';
          CRM.toast('待办已添加', 'success');
          this.load();
        } catch (e) {
          CRM.toast(e.message || '添加失败', 'error');
        } finally {
          this.savingTask = false;
        }
      },

      async toggleTask(t) {
        try {
          await CRM.api.toggleTask(t.id);
          this.load();
        } catch (e) {
          CRM.toast(e.message || '操作失败', 'error');
        }
      },

      async removeTask(t) {
        const ok = await CRM.confirm({ title: '删除待办', message: `确定删除「${t.title}」吗？`, danger: true });
        if (!ok) return;
        try {
          await CRM.api.deleteTasks([t.id]);
          this.load();
        } catch (e) {
          CRM.toast(e.message || '删除失败', 'error');
        }
      },

      isOverdue(t) {
        if (!t.due_at || t.status === '已完成') return false;
        return new Date(String(t.due_at).replace(' ', 'T')).getTime() < Date.now();
      }
    },
    async created() { this.load(); },
    template: `
      <div>
        <div v-if="loading" class="card"><div class="card-body muted">正在加载项目资料…</div></div>

        <div v-else-if="error" class="note danger">
          <c-icon name="alert" :size="16" />
          <div>
            <strong>{{ error }}</strong>
            <div class="mt-3" style="display:flex;gap:8px">
              <button class="btn btn-sm" @click="back">返回项目列表</button>
              <button class="btn btn-sm" @click="load">重试</button>
            </div>
          </div>
        </div>

        <template v-else-if="project">
          <div class="detail-head">
            <div style="flex:1;min-width:0">
              <div class="detail-title">{{ project.name }}</div>
              <div class="detail-meta">
                <span v-if="project.customer">
                  客户：<strong>{{ project.customer.short_name || project.customer.name }}</strong>
                </span>
                <span class="tag" :class="stageClass(project.stage)">{{ project.stage }}</span>
                <span class="tag" :class="payStatusClass(project.payment_status)">{{ project.payment_status }}</span>
                <span v-if="project.quantity">{{ project.quantity }} 台/套</span>
                <span v-if="project.end_user">最终用户：{{ project.end_user }}</span>
              </div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn" @click="back">返回列表</button>
              <button class="btn" @click="followOpen = true">记录跟进</button>
              <button class="btn" @click="editOpen = true">编辑项目</button>
              <button class="btn" @click="openPlan">+ 回款计划</button>
              <button class="btn btn-primary" @click="openReceipt">+ 登记实收</button>
            </div>
          </div>

          <!-- 金额汇总 -->
          <div class="stat-grid" style="margin-bottom:16px">
            <div class="stat">
              <div class="n money">{{ fmtMoney(project.summary.contract_amount) }}</div>
              <div class="l">合同金额（元）</div>
            </div>
            <div class="stat">
              <div class="n money" style="color:var(--c-success)">{{ fmtMoney(project.summary.received_amount) }}</div>
              <div class="l">已回款（元）</div>
            </div>
            <div class="stat">
              <div class="n money" :style="project.summary.debt_amount > 0 ? 'color:var(--c-danger)' : ''">
                {{ fmtMoney(project.summary.debt_amount) }}
              </div>
              <div class="l">欠款（元）</div>
            </div>
            <div class="stat">
              <div class="n money">{{ project.summary.payment_rate }}%</div>
              <div class="l">回款率</div>
            </div>
            <div class="stat">
              <div class="n" :style="project.summary.overdue_count ? 'color:var(--c-danger)' : ''">
                {{ project.summary.overdue_count }}
              </div>
              <div class="l">逾期计划数</div>
            </div>
          </div>

          <div class="tabs">
            <button v-for="t in tabs" :key="t.key" class="tab" :class="{ active: tab === t.key }"
                    @click="tab = t.key">
              {{ t.label }}<span v-if="t.badge" class="badge">{{ t.badge }}</span>
            </button>
          </div>

          <!-- 基本信息 -->
          <div v-show="tab === 'basic'">
            <div class="card">
              <div class="card-head"><div class="card-title">项目信息</div></div>
              <div class="card-body">
                <div v-if="!basicRows.length" class="muted">尚未填写详细资料，点击右上角「编辑项目」补充。</div>
                <div v-else class="kv">
                  <template v-for="r in basicRows" :key="r[0]">
                    <div class="k">{{ r[0] }}</div>
                    <div class="v">{{ r[1] }}</div>
                  </template>
                </div>
              </div>
            </div>
            <div class="card mt-4" v-if="project.followups.length">
              <div class="card-head">
                <div class="card-title">关联跟进记录</div>
                <div class="card-sub">共 {{ project.followups.length }} 条</div>
              </div>
              <div class="card-body">
                <div class="timeline">
                  <div class="tl-item" v-for="f in project.followups" :key="f.id">
                    <div class="tl-head">
                      <span class="tag">{{ f.method }}</span>
                      <span v-if="f.result" class="tag success">{{ f.result }}</span>
                      <span class="tl-time">{{ fmtDate(f.followed_at, true) }}</span>
                    </div>
                    <div class="tl-body">{{ f.content }}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- ============ 报价单 ============ -->
          <div v-show="tab === 'quotations'" class="card">
            <div class="card-head">
              <div>
                <div class="card-title">报价单</div>
                <div class="card-sub">
                  同一项目可有多张报价单，改价用「复制为新版本」保留历史；金额由系统计算
                </div>
              </div>
              <button class="btn btn-primary" @click="openQuotation">+ 新建报价单</button>
            </div>

            <div v-if="quotationsLoading" class="muted" style="padding:16px">加载中…</div>
            <c-empty v-else-if="!quotations.length" icon="file"
                     title="还没有报价单"
                     desc="点右上角「新建报价单」开始；改价时用「复制为新版本」，历史版本会保留下来" />
            <div v-else class="table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>报价单号</th>
                    <th style="width:64px">版本</th>
                    <th style="width:110px">报价日期</th>
                    <th style="width:96px">状态</th>
                    <th style="width:60px">行数</th>
                    <th style="width:130px">合计</th>
                    <th style="width:110px">有效期至</th>
                    <th style="width:230px">操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="q in quotations" :key="q.id">
                    <td class="mono">{{ q.quote_no }}</td>
                    <td>V{{ q.version }}</td>
                    <td>{{ q.quote_date || '—' }}</td>
                    <td>
                      <select class="input input-sm" :value="q.status"
                              @change="changeStatus(q, $event.target.value)">
                        <option v-for="s in ['草稿','已报出','已中标','已落标','已过期']" :key="s" :value="s">{{ s }}</option>
                      </select>
                    </td>
                    <td>{{ q.item_count }}</td>
                    <td class="num">{{ fmtMoney(q.total_amount) }}</td>
                    <td>{{ q.valid_until || '—' }}</td>
                    <td>
                      <div style="display:flex;gap:4px;justify-content:flex-end">
                        <button class="btn btn-sm" @click="editQuotation(q)">编辑</button>
                        <button class="btn btn-sm" @click="copyQuotation(q)">新版本</button>
                        <button class="btn btn-sm" @click="exportQuotation(q)">导出</button>
                        <button class="btn btn-sm btn-danger" @click="removeQuotation(q)">删除</button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div v-if="quotations.some(q => q.status === '已落标')" class="note mt-3">
              <c-icon name="alert" :size="14" />
              <div style="font-size:var(--fs-xs)">
                落标时登记的竞争对手与原因会被保存下来，便于以后复盘「谁在抢单、为什么丢单」。
              </div>
            </div>
          </div>

          <!-- 回款计划 -->
          <div v-show="tab === 'plans'" class="card">
            <div class="card-head">
              <div>
                <div class="card-title">回款计划</div>
                <div class="card-sub">
                  计划合计 {{ fmtMoney(project.summary.planned_amount) }} 元 ·
                  已核销 {{ fmtMoney(project.summary.settled_amount) }} 元 ·
                  未核销 <strong :style="project.summary.unsettled_amount > 0 ? 'color:var(--c-danger)' : ''">{{ fmtMoney(project.summary.unsettled_amount) }}</strong> 元
                </div>
              </div>
              <div class="spacer"></div>
              <button class="btn btn-sm btn-primary" @click="openPlan">+ 新增计划</button>
            </div>
            <div class="card-body">
              <c-empty v-if="!project.plans.length" icon="money" title="还没有回款计划"
                       desc="按合同约定的付款节点建立计划，到期前会自动生成待办提醒。" />
              <div v-else class="table-wrap">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>计划收款日期</th>
                      <th style="text-align:right">计划金额</th>
                      <th style="text-align:right">已核销</th>
                      <th style="text-align:right">未收余额</th>
                      <th>状态</th>
                      <th>备注</th>
                      <th style="text-align:right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="p in project.plans" :key="p.id" :class="p.is_overdue ? 'row-overdue' : ''">
                      <td>{{ fmtDate(p.plan_date) }}</td>
                      <td class="right money">{{ fmtMoney(p.amount) }}</td>
                      <td class="right money">{{ fmtMoney(p.settled_amount) }}</td>
                      <td class="right money" :style="p.remain > 0 ? 'color:var(--c-danger)' : ''">
                        {{ fmtMoney(p.remain) }}
                      </td>
                      <td>
                        <span v-if="p.is_settled" class="tag success">已核销</span>
                        <span v-else-if="p.is_overdue" class="tag danger">已逾期</span>
                        <span v-else class="tag warning">待收款</span>
                      </td>
                      <td class="muted">{{ p.remark || '—' }}</td>
                      <td style="text-align:right">
                        <div style="display:flex;gap:4px;justify-content:flex-end">
                          <button v-if="!p.is_settled" class="btn btn-sm btn-primary"
                                  @click="editingPayment = null; paymentType = '实收'; paymentOpen = true">登记实收</button>
                          <button class="btn btn-sm" @click="editPlan(p)">编辑</button>
                          <button class="btn btn-sm btn-danger" @click="removePayment(p)">删除</button>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <!-- 实收流水 -->
          <div v-show="tab === 'receipts'" class="card">
            <div class="card-head">
              <div>
                <div class="card-title">实收流水</div>
                <div class="card-sub">
                  共 {{ project.receipts.length }} 笔，合计 <strong>{{ fmtMoney(project.summary.received_amount) }}</strong> 元。
                  欠款与回款率由此自动计算，无需手填。
                </div>
              </div>
              <div class="spacer"></div>
              <button class="btn btn-sm btn-primary" @click="openReceipt">+ 登记实收</button>
            </div>
            <div class="card-body">
              <c-empty v-if="!project.receipts.length" icon="money" title="还没有实收记录"
                       desc="收到款后在此登记，项目欠款与回款率会自动更新。" />
              <div v-else class="table-wrap">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>收款日期</th>
                      <th style="text-align:right">金额</th>
                      <th>收款方式</th>
                      <th>核销计划</th>
                      <th>备注</th>
                      <th style="text-align:right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="r in project.receipts" :key="r.id">
                      <td>{{ fmtDate(r.actual_date) }}</td>
                      <td class="right money" style="color:var(--c-success);font-weight:500">{{ fmtMoney(r.amount) }}</td>
                      <td>{{ r.method || '—' }}</td>
                      <td>
                        <span v-if="r.linked_plan_date" class="tag muted">{{ fmtDate(r.linked_plan_date) }} 的计划</span>
                        <span v-else class="muted">未核销</span>
                      </td>
                      <td class="muted">{{ r.remark || '—' }}</td>
                      <td style="text-align:right">
                        <div style="display:flex;gap:4px;justify-content:flex-end">
                          <button class="btn btn-sm" @click="editReceipt(r)">编辑</button>
                          <button class="btn btn-sm btn-danger" @click="removePayment(r)">删除</button>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <!-- 待办 -->
          <div v-show="tab === 'tasks'" class="card">
            <div class="card-head">
              <div>
                <div class="card-title">项目待办</div>
                <div class="card-sub">待办 {{ project.summary.task_count }} 项</div>
              </div>
            </div>
            <div class="quick-add">
              <input class="input" v-model="taskTitle" placeholder="添加待办，例如：跟进技术协议签署"
                     @keydown.enter="addTask" />
              <input class="input" type="datetime-local" v-model="taskDue" style="flex:0 0 200px" />
              <select class="input" v-model="taskPriority" style="flex:0 0 90px">
                <option value="高">高</option>
                <option value="中">中</option>
                <option value="低">低</option>
              </select>
              <button class="btn btn-primary" :disabled="savingTask" @click="addTask">添加</button>
            </div>
            <div>
              <c-empty v-if="!project.tasks.length" title="该项目暂无待办"
                       desc="回款计划会自动生成待办；也可以在上面手动添加。" />
              <div v-else>
                <div v-for="t in project.tasks" :key="t.id" class="task-item"
                     :class="{ overdue: isOverdue(t), done: t.status === '已完成' }">
                  <input class="task-check" type="checkbox" :checked="t.status === '已完成'"
                         @change="toggleTask(t)" />
                  <div class="task-main">
                    <div class="task-title">{{ t.title }}</div>
                    <div class="task-meta">
                      <span v-if="t.due_at">截止 {{ fmtDate(t.due_at, true) }}</span>
                      <span v-if="t.due_at && isOverdue(t)" style="color:var(--c-danger);font-weight:600">已逾期</span>
                      <span class="tag" :class="t.priority === '高' ? 'danger' : (t.priority === '中' ? '' : 'muted')"
                            style="font-size:10px">{{ t.priority }}优先</span>
                      <span class="tag muted" style="font-size:10px">{{ t.source }}</span>
                    </div>
                  </div>
                  <div class="task-ops">
                    <button class="btn btn-sm btn-danger" @click="removeTask(t)">删除</button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 附件 -->
          <div v-show="tab === 'files'" class="card">
            <c-attachments owner-type="project" :owner-id="id" title="项目附件" />
          </div>

          <!-- 变更记录 -->
          <div v-show="tab === 'logs'" class="card">
            <div class="card-head">
              <div>
                <div class="card-title">变更记录</div>
                <div class="card-sub">项目改动与回款动作全部留痕</div>
              </div>
            </div>
            <div class="card-body">
              <c-empty v-if="!project.logs.length" title="暂无变更记录" />
              <div v-else class="timeline">
                <div class="tl-item" v-for="l in project.logs" :key="l.id">
                  <div class="tl-head">
                    <span class="tag" :class="markClass(l.action)">{{ actionText(l.action) }}</span>
                    <span class="tl-time">{{ fmtDate(l.created_at, true) }}</span>
                  </div>
                  <div class="tl-body">{{ l.summary }}</div>
                </div>
              </div>
            </div>
          </div>
        </template>

        <c-project-edit v-model="editOpen" :project="project" @saved="load" />

        <c-followup-drawer v-model="followOpen" :customer-id="project ? project.customer_id : ''"
                           :customer-name="project && project.customer ? project.customer.short_name : ''"
                           @saved="load" />

        <c-payment-drawer v-model="paymentOpen" :type="paymentType"
                          :project-id="id"
                          :project-name="project ? project.name : ''"
                          :contract-amount="project ? project.summary.contract_amount : 0"
                          :debt-amount="project ? project.summary.debt_amount : 0"
                          :plans="project ? project.plans : []"
                          :payment="editingPayment"
                          @saved="onPaymentSaved" />

        <!-- 报价单抽屉 -->
        <c-quotation-drawer v-model="quotationOpen"
                            :project-id="id"
                            :project-name="project ? project.name : ''"
                            :customer-name="project && project.customer ? (project.customer.short_name || project.customer.name) : ''"
                            :quotation="editingQuotation"
                            @saved="onQuotationSaved" />

        <!-- 落标登记抽屉：收集竞争对手与落标原因（后续复盘"谁在抢单"的数据来源） -->
        <c-drawer v-model="loseOpen" title="登记落标信息"
                  sub="记下来便于以后复盘：为什么丢单、对手什么价" width="560px">
          <div class="form-grid">
            <div class="field">
              <label class="field-label">竞争对手</label>
              <input class="input" v-model="loseForm.competitor" placeholder="例如：某某阀门厂" />
            </div>
            <div class="field">
              <label class="field-label">对手报价（元）</label>
              <input class="input" type="number" min="0" step="any" v-model="loseForm.competitor_price" placeholder="可留空" />
            </div>
            <div class="field" style="grid-column: span 2">
              <label class="field-label">落标原因</label>
              <input class="input" v-model="loseForm.lose_reason" placeholder="例如：价格高 8% / 交期不满足 / 品牌指定" />
            </div>
          </div>
          <div class="note mt-3">
            <c-icon name="alert" :size="14" />
            <div style="font-size:var(--fs-xs)">
              报价单「{{ loseTarget ? loseTarget.quote_no : '' }}」将标记为<strong>已落标</strong>。
              这些信息只存在你自己的电脑上。
            </div>
          </div>
          <template #footer>
            <button class="btn" @click="loseOpen = false">取消</button>
            <button class="btn btn-primary" :disabled="loseSaving" @click="saveLose">
              {{ loseSaving ? '保存中…' : '保存并标记落标' }}
            </button>
          </template>
        </c-drawer>
      </div>`
  };

  CRM.pages = CRM.pages || {};
  CRM.pages.ProjectDetail = ProjectDetail;

})(window.CRM);
