/**
 * 客户详情页
 * 5 个标签页：基本信息 / 联系人 / 跟进记录 / 关联项目 / 变更记录
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  const { BLOCKS } = CRM.customerForm;

  function emptyContact(customerId) {
    return {
      id: null, customer_id: customerId, name: '', position: '', department: '',
      mobile: '', phone: '', wechat: '', email: '', is_decision: 0, is_primary: 0,
      influence: '', birthday: '', remark: ''
    };
  }

  const CustomerDetail = {
    name: 'CustomerDetail',
    props: { id: [String, Number] },
    data() {
      return {
        customer: null,
        loading: true,
        error: '',
        tab: 'basic',
        editOpen: false,
        followOpen: false,
        contactOpen: false,
        contact: null,
        savingContact: false
      };
    },
    computed: {
      blocks() { return BLOCKS; },
      tabs() {
        const c = this.customer;
        return [
          { key: 'basic', label: '基本信息' },
          { key: 'contacts', label: '联系人', badge: c ? c.contacts.length : 0 },
          { key: 'followups', label: '跟进记录', badge: c ? c.followups.length : 0 },
          { key: 'projects', label: '关联项目', badge: c ? c.projects.length : 0 },
          { key: 'files', label: '附件' },
          { key: 'logs', label: '变更记录', badge: c ? c.logs.length : 0 }
        ];
      },
      /* 基本信息页按区块展示，跳过空区块 */
      visibleBlocks() {
        if (!this.customer) return [];
        return this.blocks.map((b) => {
          const rows = b.fields
            .filter((f) => f.key !== 'tag_ids')
            .map((f) => ({ label: f.label, value: this.displayValue(f) }))
            .filter((r) => r.value !== '' && r.value !== '—' && r.value !== '0');
          return { key: b.key, title: b.title, rows };
        }).filter((b) => b.rows.length > 0);
      }
    },
    watch: {
      id() { this.load(); }
    },
    methods: {
      fmtDate: CRM.util.fmtDate,
      fromNow: CRM.util.fromNow,
      fmtMoney: CRM.util.fmtMoney,

      async load() {
        this.loading = true;
        this.error = '';
        try {
          await CRM.api.loadDict();
          this.customer = await CRM.api.getCustomer(this.id);
        } catch (e) {
          this.error = e.message || '加载失败';
        } finally {
          this.loading = false;
        }
      },

      displayValue(field) {
        const v = this.customer[field.key];
        if (v === null || v === undefined || v === '') return '';
        if (field.type === 'switch') return v === 1 ? '是' : '否';
        if (field.type === 'multi') return String(v).split(',').filter(Boolean).join('、');
        if (field.type === 'number') {
          return CRM.util.fmtMoney(v) + (field.key === 'annual_demand' ? ' 万元' : '');
        }
        if (field.type === 'datetime-local' || field.type === 'date') {
          return CRM.util.fmtDate(v, field.type === 'datetime-local');
        }
        return String(v);
      },

      isOverdue(v) {
        if (!v) return false;
        return new Date(String(v).replace(' ', 'T')).getTime() < Date.now();
      },

      markClass(action) {
        if (action === 'create') return 'success';
        if (action === 'delete') return 'danger';
        if (action === 'followup' || action === 'followup_delete') return '';
        return 'muted';
      },

      actionText(action) {
        const MAP = {
          create: '新建', update: '修改', delete: '删除', restore: '还原',
          followup: '跟进', followup_delete: '删跟进', bulk: '批量'
        };
        return MAP[action] || action;
      },

      openFollow() { this.followOpen = true; },
      onFollowSaved() { this.load(); },

      openContact(ct) {
        this.contact = ct ? JSON.parse(JSON.stringify(ct)) : emptyContact(this.customer.id);
        this.contactOpen = true;
      },

      async saveContact() {
        if (!String(this.contact.name || '').trim()) {
          CRM.toast('请填写联系人姓名', 'error');
          return;
        }
        this.savingContact = true;
        try {
          await CRM.api.saveContact(this.contact);
          CRM.toast('联系人已保存', 'success');
          this.contactOpen = false;
          this.load();
        } catch (e) {
          CRM.toast(e.message || '保存失败', 'error');
        } finally {
          this.savingContact = false;
        }
      },

      async removeContact(ct) {
        const ok = await CRM.confirm({
          title: '删除联系人',
          message: `确定要删除联系人 <strong>${ct.name}</strong> 吗？`,
          danger: true
        });
        if (!ok) return;
        try {
          await CRM.api.deleteContact(ct.id);
          CRM.toast('联系人已删除', 'success');
          this.load();
        } catch (e) {
          CRM.toast(e.message || '删除失败', 'error');
        }
      },

      async removeFollowup(f) {
        const ok = await CRM.confirm({
          title: '删除跟进记录',
          message: '确定要删除这条跟进记录吗？客户的跟进次数会同步回退。',
          danger: true
        });
        if (!ok) return;
        try {
          await CRM.api.deleteFollowup(f.id);
          CRM.toast('跟进记录已删除', 'success');
          this.load();
        } catch (e) {
          CRM.toast(e.message || '删除失败', 'error');
        }
      },

      back() { CRM.router.navigate('/customers'); }
    },
    async created() { this.load(); },
    template: `
      <div>
        <div v-if="loading" class="card"><div class="card-body muted">正在加载客户资料…</div></div>

        <div v-else-if="error" class="note danger">
          <c-icon name="alert" :size="16" />
          <div>
            <strong>{{ error }}</strong>
            <div class="mt-3" style="display:flex;gap:8px">
              <button class="btn btn-sm" @click="back">返回客户列表</button>
              <button class="btn btn-sm" @click="load">重试</button>
            </div>
          </div>
        </div>

        <template v-else-if="customer">
          <!-- 头部 -->
          <div class="detail-head">
            <div style="flex:1;min-width:0">
              <div class="detail-title">{{ customer.name }}</div>
              <div class="detail-meta">
                <span><strong>{{ customer.short_name }}</strong></span>
                <span v-if="customer.type" class="tag muted">{{ customer.type }}</span>
                <span v-if="customer.industry" class="tag muted">{{ customer.industry }}</span>
                <span v-if="customer.level" class="tag">{{ customer.level }}</span>
                <span class="tag" :class="customer.status === '已成交' ? 'success' : ''">{{ customer.status }}</span>
                <span v-if="customer.supplier_code">供应商编码：{{ customer.supplier_code }}</span>
              </div>
              <div class="detail-meta">
                <span>联系人 {{ customer.summary.contact_count }} 人</span>
                <span>跟进 {{ customer.summary.follow_count }} 次</span>
                <span>项目 {{ customer.summary.project_count }} 个</span>
                <span>合同总额 {{ fmtMoney(customer.summary.contract_total) }}</span>
                <span>已回款 {{ fmtMoney(customer.summary.received_total) }}</span>
                <span v-if="customer.summary.debt_total > 0" style="color:var(--c-danger)">
                  欠款 {{ fmtMoney(customer.summary.debt_total) }}
                </span>
              </div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn" @click="back">返回列表</button>
              <button class="btn btn-primary" @click="openFollow">
                <c-icon name="plus" :size="14" /> 记录跟进
              </button>
              <button class="btn" @click="editOpen = true">编辑资料</button>
            </div>
          </div>

          <!-- 标签页 -->
          <div class="tabs">
            <button v-for="t in tabs" :key="t.key" class="tab" :class="{ active: tab === t.key }"
                    @click="tab = t.key">
              {{ t.label }}<span v-if="t.badge" class="badge">{{ t.badge }}</span>
            </button>
          </div>

          <!-- 基本信息 -->
          <div v-show="tab === 'basic'">
            <div v-if="!visibleBlocks.length" class="card">
              <c-empty title="尚未填写任何资料" desc="点击右上角「编辑资料」补充客户信息。" />
            </div>
            <div v-for="b in visibleBlocks" :key="b.key" class="card" style="margin-bottom:12px">
              <div class="card-head"><div class="card-title">{{ b.title }}</div></div>
              <div class="card-body">
                <div class="kv">
                  <template v-for="r in b.rows" :key="r.label">
                    <div class="k">{{ r.label }}</div>
                    <div class="v">{{ r.value }}</div>
                  </template>
                </div>
              </div>
            </div>
            <div class="card" v-if="customer.tags.length">
              <div class="card-head"><div class="card-title">标签</div></div>
              <div class="card-body">
                <span v-for="t in customer.tags" :key="t.id" class="tag" style="margin-right:6px">{{ t.name }}</span>
              </div>
            </div>
          </div>

          <!-- 联系人 -->
          <div v-show="tab === 'contacts'" class="card">
            <div class="card-head">
              <div>
                <div class="card-title">联系人</div>
                <div class="card-sub">一客户可多人；主联系人唯一，决策人与技术把关人建议都录入</div>
              </div>
              <div class="spacer"></div>
              <button class="btn btn-sm btn-primary" @click="openContact(null)">+ 新增联系人</button>
            </div>
            <div class="card-body">
              <c-empty v-if="!customer.contacts.length" icon="customers"
                       title="还没有联系人" desc="真实业务里你联系的是「人」，建议至少录入一个主联系人。" />
              <div v-else class="card-list">
                <div class="mini-card" v-for="ct in customer.contacts" :key="ct.id">
                  <div class="acts">
                    <button class="btn btn-sm" @click="openContact(ct)">编辑</button>
                    <button class="btn btn-sm btn-danger" @click="removeContact(ct)">删</button>
                  </div>
                  <div class="nm">
                    {{ ct.name }}
                    <span v-if="ct.is_primary" class="tag success">主联系人</span>
                    <span v-if="ct.is_decision" class="tag">决策人</span>
                  </div>
                  <div class="pos">
                    {{ ct.department || '' }}{{ ct.department && ct.position ? ' · ' : '' }}{{ ct.position || '职位未填' }}
                    <span v-if="ct.influence"> · {{ ct.influence }}</span>
                  </div>
                  <div class="rows">
                    <div v-if="ct.mobile">手机：{{ ct.mobile }}</div>
                    <div v-if="ct.phone">座机：{{ ct.phone }}</div>
                    <div v-if="ct.wechat">微信：{{ ct.wechat }}</div>
                    <div v-if="ct.email">邮箱：{{ ct.email }}</div>
                    <div v-if="ct.birthday">生日：{{ fmtDate(ct.birthday) }}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 跟进记录 -->
          <div v-show="tab === 'followups'" class="card">
            <div class="card-head">
              <div>
                <div class="card-title">跟进记录</div>
                <div class="card-sub">
                  共 {{ customer.followups.length }} 条；最近跟进 {{ customer.last_follow_at ? fromNow(customer.last_follow_at) : '暂无' }}
                  <span v-if="customer.next_follow_at"
                        :style="isOverdue(customer.next_follow_at) ? 'color:var(--c-danger)' : ''">
                    · 下次跟进 {{ fmtDate(customer.next_follow_at, true) }}
                    {{ isOverdue(customer.next_follow_at) ? '（已逾期）' : '' }}
                  </span>
                </div>
              </div>
              <div class="spacer"></div>
              <button class="btn btn-sm btn-primary" @click="openFollow">+ 记录跟进</button>
            </div>
            <div class="card-body">
              <c-empty v-if="!customer.followups.length" icon="clock"
                       title="还没有跟进记录" desc="每次沟通后记一条，下次跟进时间会自动提醒。" />
              <div v-else class="timeline">
                <div class="tl-item" v-for="f in customer.followups" :key="f.id">
                  <div class="tl-head">
                    <span class="tag">{{ f.method }}</span>
                    <span v-if="f.result" class="tag success">{{ f.result }}</span>
                    <span class="tl-time">{{ fmtDate(f.followed_at, true) }}</span>
                    <div style="flex:1"></div>
                    <button class="btn btn-sm" @click="removeFollowup(f)">删除</button>
                  </div>
                  <div class="tl-body">{{ f.content }}</div>
                  <div class="tl-extra" v-if="f.next_plan">下次计划：{{ f.next_plan }}</div>
                  <div class="tl-extra" v-if="f.next_at">下次跟进：{{ fmtDate(f.next_at, true) }}</div>
                </div>
              </div>
            </div>
          </div>

          <!-- 关联项目 -->
          <div v-show="tab === 'projects'" class="card">
            <div class="card-head">
              <div>
                <div class="card-title">关联项目</div>
                <div class="card-sub">项目管理模块将在阶段三开发，此处已可显示数据</div>
              </div>
            </div>
            <div class="card-body">
              <c-empty v-if="!customer.projects.length" icon="projects"
                       title="该客户暂无项目"
                       desc="阶段三上线项目管理后，可在此看到该客户的全部项目、回款进度与欠款。" />
              <div v-else class="table-wrap">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>项目名称</th><th>阶段</th><th>进度</th>
                      <th style="text-align:right">合同额</th>
                      <th style="text-align:right">已回款</th>
                      <th style="text-align:right">欠款</th>
                      <th>回款率</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="p in customer.projects" :key="p.id">
                      <td>{{ p.name }}</td>
                      <td><span class="tag muted">{{ p.stage }}</span></td>
                      <td>{{ p.progress }}%</td>
                      <td style="text-align:right">{{ fmtMoney(p.contract_amount) }}</td>
                      <td style="text-align:right">{{ fmtMoney(p.received) }}</td>
                      <td style="text-align:right" :style="p.debt > 0 ? 'color:var(--c-danger)' : ''">
                        {{ fmtMoney(p.debt) }}
                      </td>
                      <td>{{ p.rate }}%</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <!-- 附件 -->
          <div v-show="tab === 'files'" class="card">
            <c-attachments owner-type="customer" :owner-id="id" title="客户附件" />
          </div>

          <!-- 变更记录 -->
          <div v-show="tab === 'logs'" class="card">
            <div class="card-head">
              <div>
                <div class="card-title">变更记录</div>
                <div class="card-sub">谁在什么时候改了什么，全部留痕</div>
              </div>
            </div>
            <div class="card-body">
              <c-empty v-if="!customer.logs.length" title="暂无变更记录" />
              <div v-else class="timeline">
                <div class="tl-item" v-for="l in customer.logs" :key="l.id">
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

        <!-- 编辑客户 -->
        <c-customer-edit v-model="editOpen" :customer="customer" @saved="load" />

        <!-- 记录跟进 -->
        <c-followup-drawer v-model="followOpen" :customer-id="id"
                           :customer-name="customer ? customer.short_name : ''"
                           @saved="onFollowSaved" />

        <!-- 联系人编辑 -->
        <c-drawer v-model="contactOpen"
                  :title="contact && contact.id ? '编辑联系人' : '新增联系人'"
                  :sub="customer ? customer.name : ''" width="560px">
          <div v-if="contact" class="form-grid">
            <c-field v-model="contact.name" label="姓名" required />
            <c-select v-model="contact.position" label="职位"
                      :options="api.options('contact_position')" />
            <c-field v-model="contact.department" label="所属部门"
                     placeholder="采购部 / 技术部 / 设备部 / 工程部" />
            <c-select v-model="contact.influence" label="影响力"
                      :options="api.options('contact_influence')"
                      hint="工业客户里技术工程师常有一票否决权" />
            <c-field v-model="contact.mobile" label="手机号" />
            <c-field v-model="contact.phone" label="座机" />
            <c-field v-model="contact.wechat" label="微信" />
            <c-field v-model="contact.email" label="邮箱" />
            <c-field v-model="contact.birthday" label="生日" type="date" />
            <div class="field">
              <label class="field-label">标记</label>
              <div style="display:flex;gap:16px;padding-top:4px">
                <label class="switch">
                  <input type="checkbox" :checked="contact.is_primary === 1"
                         @change="contact.is_primary = $event.target.checked ? 1 : 0" />
                  <span class="switch-track"><span class="switch-thumb"></span></span>
                  <span class="switch-text">主联系人</span>
                </label>
                <label class="switch">
                  <input type="checkbox" :checked="contact.is_decision === 1"
                         @change="contact.is_decision = $event.target.checked ? 1 : 0" />
                  <span class="switch-track"><span class="switch-thumb"></span></span>
                  <span class="switch-text">决策人</span>
                </label>
              </div>
              <div class="field-hint">设为主联系人会自动取消其他人的主联系人标记</div>
            </div>
            <c-field v-model="contact.remark" label="备注" type="textarea" :span="2" :rows="2" />
          </div>
          <template #footer>
            <div style="flex:1"></div>
            <button class="btn" @click="contactOpen = false">取消</button>
            <button class="btn btn-primary" :disabled="savingContact" @click="saveContact">
              {{ savingContact ? '保存中…' : '保存' }}
            </button>
          </template>
        </c-drawer>
      </div>`,
    setup() { return { api: CRM.api }; }
  };

  CRM.pages = CRM.pages || {};
  CRM.pages.CustomerDetail = CustomerDetail;

})(window.CRM);
