/**
 * 待办中心
 * 视图：今日 / 本周 / 逾期 / 已完成 / 全部 / 无日期；支持快速添加与关联客户、项目。
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  const TasksPage = {
    name: 'TasksPage',
    data() {
      return {
        views: [
          { key: 'today', label: '今日', tip: '今天到期以及已逾期的待办' },
          { key: 'week', label: '本周', tip: '未来 7 天内到期' },
          { key: 'overdue', label: '逾期', tip: '已过期且未完成' },
          { key: 'done', label: '已完成', tip: '历史完成记录' },
          { key: 'all', label: '全部待办', tip: '所有未完成的待办' },
          { key: 'nodate', label: '无日期', tip: '未设置截止时间' }
        ],
        view: 'today',
        list: [],
        counts: { today: 0, week: 0, overdue: 0, done: 0, all: 0 },
        loading: false,
        filterPriority: '',
        filterSource: '',
        keyword: '',
        form: { title: '', due_at: '', priority: '中', customer_id: '', remark: '' },
        saving: false,
        showMore: false
      };
    },
    computed: {
      customers() { return CRM.api.customerOptions(); },
      sources() { return ['手动', '跟进计划', '回款计划']; },
      currentView() { return this.views.find((v) => v.key === this.view) || this.views[0]; }
    },
    methods: {
      fmtDate: CRM.util.fmtDate,

      async load() {
        this.loading = true;
        try {
          const d = await CRM.api.listTasks({
            view: this.view,
            priority: this.filterPriority,
            source: this.filterSource,
            q: this.keyword
          });
          this.list = d.list;
          this.counts = d.counts;
        } catch (e) {
          CRM.toast(e.message || '加载失败', 'error');
        } finally {
          this.loading = false;
        }
      },

      switchView(v) { this.view = v; this.load(); },

      async add() {
        const title = String(this.form.title || '').trim();
        if (!title) { CRM.toast('请填写待办内容', 'error'); return; }
        this.saving = true;
        try {
          await CRM.api.saveTask({
            title,
            due_at: this.form.due_at ? this.form.due_at.replace('T', ' ') + ':00' : null,
            priority: this.form.priority,
            customer_id: this.form.customer_id ? Number(this.form.customer_id) : null,
            remark: this.form.remark,
            source: '手动'
          });
          this.form.title = '';
          this.form.due_at = '';
          this.form.priority = '中';
          this.form.remark = '';
          CRM.toast('待办已添加', 'success');
          this.load();
        } catch (e) {
          CRM.toast(e.message || '添加失败', 'error');
        } finally {
          this.saving = false;
        }
      },

      async toggle(t) {
        try {
          const r = await CRM.api.toggleTask(t.id);
          CRM.toast(r.status === '已完成' ? '已完成' : '已重新打开', 'success');
          this.load();
        } catch (e) {
          CRM.toast(e.message || '操作失败', 'error');
        }
      },

      async remove(t) {
        const ok = await CRM.confirm({
          title: '删除待办',
          message: `确定删除「${t.title}」吗？`,
          danger: true
        });
        if (!ok) return;
        try {
          await CRM.api.deleteTasks([t.id]);
          CRM.toast('已删除', 'success');
          this.load();
        } catch (e) {
          CRM.toast(e.message || '删除失败', 'error');
        }
      },

      async purgeDone() {
        const ok = await CRM.confirm({
          title: '清理已完成待办',
          message: '将删除 30 天前已完成的待办记录，确定继续吗？',
          danger: true
        });
        if (!ok) return;
        try {
          const r = await CRM.api.purgeDoneTasks(30);
          CRM.toast(`已清理 ${r.removed} 条`, 'success');
          this.load();
        } catch (e) {
          CRM.toast(e.message || '清理失败', 'error');
        }
      },

      async removeAllDone() {
        const ids = this.list.map((t) => t.id);
        if (!ids.length) { CRM.toast('当前列表为空', 'warn'); return; }
        const ok = await CRM.confirm({
          title: '删除已完成待办',
          message: `将删除当前列表中的 <strong>${ids.length}</strong> 条记录，确定吗？`,
          danger: true
        });
        if (!ok) return;
        try {
          const r = await CRM.api.deleteTasks(ids);
          CRM.toast(`已删除 ${r.count} 条`, 'success');
          this.load();
        } catch (e) {
          CRM.toast(e.message || '删除失败', 'error');
        }
      },

      goCustomer(t) { if (t.customer_id) CRM.router.navigate(`/customers/${t.customer_id}`); },
      goProject(t) { if (t.project_id) CRM.router.navigate(`/projects/${t.project_id}`); },

      dueText(t) {
        if (!t.due_at) return '无截止时间';
        const d = this.fmtDate(t.due_at, true);
        if (t.status === '已完成') return d;
        const left = t.days_left;
        if (left === null || left === undefined) return d;
        if (left < 0) return `${d}（已逾期 ${Math.abs(left)} 天）`;
        if (left === 0) return `${d}（今天到期）`;
        if (left === 1) return `${d}（明天）`;
        return `${d}（还有 ${left} 天）`;
      },

      prioClass(p) {
        if (p === '高') return 'danger';
        if (p === '中') return '';
        return 'muted';
      }
    },
    async created() {
      await CRM.api.loadCustomerOptions();
      this.load();
    },
    template: `
      <div>
        <c-page-header title="待办中心"
          desc="把跟进计划、回款计划与手动待办汇总到一处，避免漏事。" />

        <div class="card" style="margin-bottom:16px">
          <div class="quick-add" style="border-bottom:none;background:transparent">
            <input class="input" v-model="form.title" placeholder="添加待办，回车即可保存"
                   @keydown.enter="add" />
            <input class="input" type="datetime-local" v-model="form.due_at" style="flex:0 0 200px" />
            <select class="input" v-model="form.priority" style="flex:0 0 90px">
              <option value="高">高优先</option>
              <option value="中">中优先</option>
              <option value="低">低优先</option>
            </select>
            <button class="btn" @click="showMore = !showMore">{{ showMore ? '收起' : '更多' }}</button>
            <button class="btn btn-primary" :disabled="saving" @click="add">
              <c-icon name="plus" :size="14" /> 添加
            </button>
          </div>
          <div v-show="showMore" class="card-body" style="padding-top:0">
            <div class="form-grid">
              <c-ref-select v-model="form.customer_id" label="关联客户"
                            :options="customers.map(c => ({ value: c.id, label: c.label }))" />
              <c-field v-model="form.remark" label="备注" />
            </div>
          </div>
        </div>

        <div class="card" style="margin-bottom:16px">
          <div class="card-body" style="padding:12px 16px">
            <div class="filter-bar">
              <div class="tabs" style="border:none;margin:0">
                <button v-for="v in views" :key="v.key" class="tab" :class="{ active: view === v.key }"
                        :title="v.tip" @click="switchView(v.key)">
                  {{ v.label }}
                  <span v-if="counts[v.key]" class="badge"
                        :style="v.key === 'overdue' && counts.overdue ? 'background:var(--c-danger-soft);color:var(--c-danger)' : ''">
                    {{ counts[v.key] }}
                  </span>
                </button>
              </div>
              <div style="flex:1"></div>
              <input class="input" v-model="keyword" placeholder="搜索待办" style="min-width:150px"
                     @keydown.enter="load" />
              <select class="input" v-model="filterPriority" @change="load">
                <option value="">优先级（全部）</option>
                <option value="高">高</option>
                <option value="中">中</option>
                <option value="低">低</option>
              </select>
              <select class="input" v-model="filterSource" @change="load">
                <option value="">来源（全部）</option>
                <option v-for="s in sources" :key="s" :value="s">{{ s }}</option>
              </select>
              <button v-if="view === 'done'" class="btn" @click="purgeDone">清理 30 天前</button>
              <button v-if="view === 'done' && list.length" class="btn btn-danger" @click="removeAllDone">
                删除当前列表
              </button>
            </div>
            <div class="muted mt-3" style="font-size:var(--fs-xs)">{{ currentView.tip }}</div>
          </div>
        </div>

        <div class="card">
          <div v-if="loading" class="card-body muted">正在加载…</div>
          <c-empty v-else-if="!list.length" icon="tasks" title="没有符合条件的待办"
                   :desc="view === 'done' ? '还没有已完成记录。' : '换个视图看看，或在上方添加一条待办。'" />
          <div v-else>
            <div v-for="t in list" :key="t.id" class="task-item"
                 :class="{ overdue: t.is_overdue === 1 && t.status !== '已完成', done: t.status === '已完成' }">
              <input class="task-check" type="checkbox" :checked="t.status === '已完成'"
                     :title="t.status === '已完成' ? '标记为未完成' : '标记为已完成'"
                     @change="toggle(t)" />
              <div class="task-main">
                <div class="task-title">{{ t.title }}</div>
                <div class="task-meta">
                  <span :style="t.is_overdue === 1 && t.status !== '已完成' ? 'color:var(--c-danger);font-weight:600' : ''">
                    {{ dueText(t) }}
                  </span>
                  <span class="tag" :class="prioClass(t.priority)" style="font-size:10px">{{ t.priority }}</span>
                  <span class="tag muted" style="font-size:10px">{{ t.source }}</span>
                  <a v-if="t.customer_id" href="javascript:;" @click="goCustomer(t)">
                    客户：{{ t.customer_short || t.customer_name }}
                  </a>
                  <a v-if="t.project_id" href="javascript:;" @click="goProject(t)">
                    项目：{{ t.project_name }}
                  </a>
                  <span v-if="t.status === '已完成' && t.done_at" class="muted">
                    完成于 {{ fmtDate(t.done_at, true) }}
                  </span>
                </div>
              </div>
              <div class="task-ops">
                <button class="btn btn-sm btn-danger" @click="remove(t)">删除</button>
              </div>
            </div>
          </div>
        </div>
      </div>`,
    setup() { return { api: CRM.api }; }
  };

  CRM.pages = CRM.pages || {};
  CRM.pages.tasks = TasksPage;

})(window.CRM);
