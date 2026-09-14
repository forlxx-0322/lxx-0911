/**
 * 设置页 · 标签管理 / 提醒规则 / 回收站 / 操作日志
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  /* ================= 标签管理 ================= */
  const TagPanel = {
    name: 'TagPanel',
    data() {
      return {
        tags: [],
        loading: true,
        adding: false,
        newName: '',
        newColor: '#4b7bec',
        saving: false,
        editingId: null,
        editingName: ''
      };
    },
    methods: {
      async load() {
        this.loading = true;
        try {
          this.tags = await CRM.api.listTags(true);
        } catch (e) {
          CRM.toast(e.message || '加载标签失败', 'error');
        } finally {
          this.loading = false;
        }
      },
      async add() {
        const name = String(this.newName || '').trim();
        if (!name) { CRM.toast('请输入标签名称', 'error'); return; }
        this.saving = true;
        try {
          await CRM.api.saveTag({ name, color: this.newColor });
          await this.load();
          this.newName = '';
          this.adding = false;
          CRM.toast(`已新建标签「${name}」`, 'success');
        } catch (e) {
          CRM.toast(e.message || '新建失败', 'error');
        } finally {
          this.saving = false;
        }
      },
      startEdit(t) { this.editingId = t.id; this.editingName = t.name; },
      async saveEdit(t) {
        const name = String(this.editingName || '').trim();
        if (!name || name === t.name) { this.editingId = null; return; }
        try {
          await CRM.api.saveTag({ id: t.id, name, color: t.color });
          await this.load();
          this.editingId = null;
          CRM.toast('标签名称已更新', 'success');
        } catch (e) {
          CRM.toast(e.message || '修改失败', 'error');
        }
      },
      async setColor(t, color) {
        try {
          await CRM.api.saveTag({ id: t.id, name: t.name, color });
          await this.load();
        } catch (e) {
          CRM.toast(e.message || '设置颜色失败', 'error');
        }
      },
      async remove(t) {
        const extra = t.customer_count > 0
          ? `<br>当前有 <strong>${t.customer_count}</strong> 家客户使用该标签，删除后会一并解除关联。`
          : '';
        const ok = await CRM.confirm({
          title: '删除标签',
          message: `确定删除标签「${t.name}」吗？${extra}`,
          danger: true
        });
        if (!ok) return;
        try {
          await CRM.api.deleteTag(t.id);
          await this.load();
          CRM.toast('标签已删除', 'success');
        } catch (e) {
          CRM.toast(e.message || '删除失败', 'error');
        }
      }
    },
    async created() { this.load(); },
    template: `
      <c-card title="标签管理" :sub="'共 ' + tags.length + ' 个标签，用于客户分组与筛选'">
        <template #head>
          <button class="btn btn-sm btn-primary" @click="adding = true">
            <c-icon name="plus" :size="13" /> 新建标签
          </button>
        </template>

        <div v-if="adding" class="filter-bar" style="margin-bottom:14px">
          <input class="input" v-model="newName" placeholder="标签名称，例如：重点跟进" style="flex:1 1 220px"
                 @keydown.enter="add" />
          <input type="color" v-model="newColor"
                 style="width:38px;height:32px;padding:2px;border:1px solid var(--c-border-strong);border-radius:6px;cursor:pointer" />
          <button class="btn btn-primary" :disabled="saving" @click="add">{{ saving ? '保存中…' : '保存' }}</button>
          <button class="btn" @click="adding = false; newName = ''">取消</button>
        </div>

        <div v-if="loading" class="muted">加载中…</div>
        <c-empty v-else-if="!tags.length" icon="list" title="还没有标签"
                 desc="标签用于给客户打标记，比如「重点跟进」「已入网」「需回访」。" />

        <div v-else class="dict-items">
          <div v-for="t in tags" :key="t.id" class="dict-item">
            <input type="color" :value="t.color" @change="setColor(t, $event.target.value)"
                   style="width:14px;height:14px;border:none;padding:0;background:none;cursor:pointer"
                   title="修改颜色" />
            <template v-if="editingId === t.id">
              <input class="chip-input" v-model="editingName" style="width:120px"
                     @keydown.enter="saveEdit(t)" @keydown.esc="editingId = null" />
              <button class="acts" style="border:none;background:none;cursor:pointer;color:var(--c-primary)"
                      @click="saveEdit(t)">保存</button>
              <button class="acts" style="border:none;background:none;cursor:pointer;color:var(--c-text-3)"
                      @click="editingId = null">取消</button>
            </template>
            <template v-else>
              <span>{{ t.name }}</span>
              <span class="sys">{{ t.customer_count }} 家客户</span>
              <span class="acts">
                <button title="改名" @click="startEdit(t)">改名</button>
                <button class="danger" title="删除" @click="remove(t)">删除</button>
              </span>
            </template>
          </div>
        </div>
      </c-card>`
  };

  /* ================= 提醒规则与界面偏好 ================= */
  const PrefsPanel = {
    name: 'PrefsPanel',
    data() {
      return {
        loading: true, settings: {}, meta: {}, saving: false, dirty: false,
        /* 邮件提醒（独立于普通设置：授权码单独处理，且状态需要单独查询） */
        email: { loading: true, providers: [], smtp_pass_configured: false },
        emailDirty: false,
        status: null,
        testing: false,
        sending: false
      };
    },
    computed: {
      /** 各服务商的授权码获取指引（避免用户把登录密码填进来） */
      providerHint() {
        const p = this.email.smtp_provider;
        const hints = {
          qq: 'QQ 邮箱：设置 → 账户 → 开启 SMTP 服务 → 生成授权码',
          163: '163 邮箱：设置 → POP3/SMTP/IMAP → 开启服务 → 新增授权码',
          126: '126 邮箱：设置 → POP3/SMTP/IMAP → 开启服务 → 新增授权码',
          exmail: '腾讯企业邮：邮箱设置 → 收发信设置 → 客户端专用密码',
          '189': '天翼 189 邮箱：设置 → 客户端设置 → 生成授权码',
          custom: '请填写该邮箱服务商提供的 SMTP 授权码'
        };
        return hints[p] || '请填写邮箱服务商提供的授权码（不是登录密码）';
      }
    },
    setup() {
      return { theme: CRM.theme.state };
    },
    methods: {
      /* 主题保存在本机 localStorage（无需登录，也不属于服务端偏好） */
      setTheme(mode) {
        CRM.theme.set(mode);
        CRM.toast(mode === 'dark' ? '已切换到深色主题' : '已切换到浅色主题', 'success');
      },
      async load() {
        this.loading = true;
        try {
          const d = await CRM.api.getSettings();
          this.settings = d.settings;
          this.meta = d.meta;
          this.dirty = false;
        } catch (e) {
          CRM.toast(e.message || '加载设置失败', 'error');
        } finally {
          this.loading = false;
        }
      },
      markDirty() { this.dirty = true; },

      /* ---------------- 邮件提醒 ---------------- */
      async loadEmail() {
        this.email.loading = true;
        try {
          const d = await CRM.api.remindSettings();
          this.email = Object.assign({ loading: false, providers: [] }, d);
          this.emailDirty = false;
          await this.loadEmailStatus();
        } catch (e) {
          this.email.loading = false;
          CRM.toast(e.message || '加载邮件提醒设置失败', 'error');
        }
      },
      async loadEmailStatus() {
        try { this.status = await CRM.api.emailStatus(); } catch (_) { this.status = null; }
      },
      markEmailDirty() { this.emailDirty = true; },
      /** 换服务商时自动带出服务器与端口（用户可再手改） */
      onProviderChange() {
        const p = (this.email.providers || []).find((x) => x.key === this.email.smtp_provider);
        if (p && p.host) {
          this.email.smtp_host = p.host;
          this.email.smtp_port = String(p.port);
        }
        this.markEmailDirty();
      },
      async saveEmail() {
        const patch = {
          follow_remind_days: this.email.follow_remind_days,
          follow_remind_time: this.email.follow_remind_time,
          follow_remind_quiet: this.email.follow_remind_quiet,
          follow_remind_on_start: this.email.follow_remind_on_start,
          remind_email_on: this.email.remind_email_on,
          remind_email_time: this.email.remind_email_time,
          remind_email_to: this.email.remind_email_to,
          smtp_provider: this.email.smtp_provider,
          smtp_host: this.email.smtp_host,
          smtp_port: this.email.smtp_port,
          smtp_user: this.email.smtp_user
        };
        /* 授权码留空表示不修改；填了才提交 */
        if (this.email.smtp_pass) patch.smtp_pass = this.email.smtp_pass;
        try {
          const r = await CRM.api.saveRemindSettings(patch);
          this.email = Object.assign(this.email, r.settings, { loading: false });
          this.email.smtp_pass = '';
          this.emailDirty = false;
          await this.loadEmailStatus();
          CRM.toast('邮件提醒设置已保存', 'success');
          return true;
        } catch (e) {
          CRM.toast(e.message || '保存失败', 'error');
          return false;
        }
      },
      async doTestEmail() {
        if (this.emailDirty) {
          const ok = await this.saveEmail();
          if (!ok) return;
        }
        this.testing = true;
        try {
          const r = await CRM.api.testEmail();
          CRM.toast(r.message || '测试邮件已发送', 'success', 6000);
          await this.loadEmailStatus();
        } catch (e) {
          CRM.toast(e.message || '测试发送失败', 'error', 8000);
          await this.loadEmailStatus();
        } finally {
          this.testing = false;
        }
      },
      async doSendNow() {
        if (this.emailDirty) {
          const ok = await this.saveEmail();
          if (!ok) return;
        }
        this.sending = true;
        try {
          const r = await CRM.api.sendReminderNow();
          CRM.toast(r.message || `已发送 ${r.count} 位客户的提醒`, 'success', 6000);
          await this.loadEmailStatus();
        } catch (e) {
          CRM.toast(e.message || '发送失败', 'error', 8000);
          await this.loadEmailStatus();
        } finally {
          this.sending = false;
        }
      },
      async save() {
        this.saving = true;
        try {
          const patch = {
            follow_remind_days: this.settings.follow_remind_days,
            payment_remind_days: this.settings.payment_remind_days,
            birthday_remind: this.settings.birthday_remind,
            page_size: this.settings.page_size,
            attachment_max_mb: this.settings.attachment_max_mb,
            app_name: this.settings.app_name,
            company_name: this.settings.company_name,
            map_approval_no: this.settings.map_approval_no
          };
          const r = await CRM.api.saveSettings(patch);
          this.dirty = false;
          CRM.toast(`已保存 ${r.updated.length} 项设置`, 'success');
        } catch (e) {
          CRM.toast(e.message || '保存失败', 'error');
        } finally {
          this.saving = false;
        }
      }
    },
    async created() { this.load(); this.loadEmail(); },
    template: `
      <div>
        <div v-if="loading" class="card"><div class="card-body muted">加载中…</div></div>
        <template v-else>
          <c-card title="提醒规则" sub="影响首页提醒与自动生成的待办时间" icon="clock">
            <div class="form-grid">
              <div class="field">
                <label class="field-label">跟进提醒提前天数</label>
                <input class="input" type="number" min="0" max="90" v-model="settings.follow_remind_days"
                       @input="markDirty" />
                <div class="field-hint">客户「下次跟进时间」到期前几天开始提醒</div>
              </div>
              <div class="field">
                <label class="field-label">回款提醒提前天数</label>
                <input class="input" type="number" min="0" max="180" v-model="settings.payment_remind_days"
                       @input="markDirty" />
                <div class="field-hint">新建回款计划时，按此天数提前生成待办（当前影响新建的计划）</div>
              </div>
              <div class="field">
                <label class="field-label">生日提醒</label>
                <div class="switch" @click="settings.birthday_remind = settings.birthday_remind === '1' ? '0' : '1'; markDirty()">
                  <input type="checkbox" :checked="settings.birthday_remind === '1'" readonly />
                  <span class="switch-track"><span class="switch-thumb"></span></span>
                  <span class="switch-text">{{ settings.birthday_remind === '1' ? '已开启' : '已关闭' }}</span>
                </div>
                <div class="field-hint">联系人过生日时在首页提示</div>
              </div>
              <div class="field">
                <label class="field-label">列表每页条数</label>
                <select class="input" v-model="settings.page_size" @change="markDirty">
                  <option value="20">20 条</option>
                  <option value="50">50 条</option>
                  <option value="100">100 条</option>
                </select>
              </div>
            </div>
          </c-card>

          <!-- ============ 邮件提醒（默认关闭；关闭时不产生任何网络请求） ============ -->
          <c-card class="mt-4" title="邮件提醒" sub="即使软件没开，也能在手机上收到当天要跟进谁" icon="mail">
            <div v-if="email.loading" class="muted">加载中…</div>
            <template v-else>
              <div class="note" style="margin-bottom:14px">
                <c-icon name="alert" :size="16" />
                <div style="font-size:var(--fs-sm)">
                  这是本软件**第二个会联网的功能**（第一个是招标采集）。
                  <strong>关闭时不产生任何外部网络请求</strong>，软件内提醒照常工作。<br>
                  邮件只会发给你自己填的地址，不会发给客户。
                </div>
              </div>

              <div class="form-grid">
                <div class="field">
                  <label class="field-label">启用邮件提醒</label>
                  <div class="switch" @click="email.remind_email_on = email.remind_email_on === '1' ? '0' : '1'; markEmailDirty()">
                    <input type="checkbox" :checked="email.remind_email_on === '1'" readonly />
                    <span class="switch-track"><span class="switch-thumb"></span></span>
                    <span class="switch-text">{{ email.remind_email_on === '1' ? '已开启' : '已关闭' }}</span>
                  </div>
                </div>
                <div class="field">
                  <label class="field-label">每天发送时间</label>
                  <input class="input" type="time" v-model="email.remind_email_time" @input="markEmailDirty" />
                  <div class="field-hint">当天没有待跟进客户时不会发送空邮件</div>
                </div>

                <div class="field">
                  <label class="field-label">邮箱服务商</label>
                  <select class="input" v-model="email.smtp_provider" @change="onProviderChange">
                    <option v-for="p in (email.providers || [])" :key="p.key" :value="p.key">{{ p.label }}</option>
                  </select>
                </div>
                <div class="field">
                  <label class="field-label">SMTP 服务器</label>
                  <input class="input" v-model="email.smtp_host" @input="markEmailDirty" placeholder="smtp.qq.com" />
                </div>
                <div class="field">
                  <label class="field-label">端口</label>
                  <input class="input" v-model="email.smtp_port" @input="markEmailDirty" placeholder="465" />
                  <div class="field-hint">使用 465（隐式 TLS）</div>
                </div>
                <div class="field">
                  <label class="field-label">邮箱账号</label>
                  <input class="input" v-model="email.smtp_user" @input="markEmailDirty" placeholder="you@qq.com" />
                </div>
                <div class="field">
                  <label class="field-label">
                    邮箱授权码
                    <span v-if="email.smtp_pass_configured" class="tag" style="margin-left:6px">已配置</span>
                  </label>
                  <input class="input" type="password" v-model="email.smtp_pass" @input="markEmailDirty"
                         :placeholder="email.smtp_pass_configured ? '已保存，留空表示不修改' : '不是登录密码，是邮箱设置里生成的授权码'" />
                  <div class="field-hint">
                    {{ providerHint }}
                    <button class="link-btn" style="margin-left:6px" @click="email.smtp_pass = '__CLEAR__'; markEmailDirty()">清空</button>
                  </div>
                </div>
                <div class="field">
                  <label class="field-label">收件地址</label>
                  <input class="input" v-model="email.remind_email_to" @input="markEmailDirty"
                         placeholder="留空则发给上面的账号自己" />
                </div>
              </div>

              <!-- 通道状态 -->
              <div v-if="status" class="note mt-4" :class="status.lastOk === false ? 'warn' : ''">
                <c-icon :name="status.lastOk === false ? 'alert' : 'check'" :size="16" />
                <div style="font-size:var(--fs-sm)">
                  <div>
                    配置{{ status.configured ? '完整' : '不完整' }}
                    <span v-if="!status.configured">：还缺 {{ (status.missing || []).join('、') }}</span>
                  </div>
                  <div v-if="status.lastAt" class="mt-3">
                    上次尝试：{{ status.lastAt }} · {{ status.lastOk ? '成功' : '失败' }}
                    <span v-if="status.lastMsg">（{{ status.lastMsg }}）</span>
                  </div>
                  <div v-else class="mt-3 muted">尚未发送过</div>
                  <div v-if="status.failStreak" class="mt-3" style="color:var(--c-warning)">
                    连续失败 {{ status.failStreak }} 次，达到 {{ status.failStreakLimit }} 次会自动关闭邮件提醒
                  </div>
                </div>
              </div>

              <div class="mt-4" style="display:flex;gap:8px;flex-wrap:wrap">
                <button class="btn" :disabled="testing" @click="doTestEmail">
                  {{ testing ? '发送中…' : '测试发送' }}
                </button>
                <button class="btn" :disabled="sending" @click="doSendNow">
                  {{ sending ? '发送中…' : '立即发送当日提醒' }}
                </button>
                <span class="muted" style="font-size:var(--fs-xs);align-self:center">
                  改完配置请先保存，再点测试发送
                </span>
              </div>

              <div class="mt-3" style="display:flex;gap:8px;align-items:center">
                <button class="btn btn-primary" :disabled="!emailDirty" @click="saveEmail">保存邮件提醒设置</button>
                <button class="btn" :disabled="!emailDirty" @click="loadEmail">放弃修改</button>
                <span v-if="emailDirty" class="muted" style="font-size:var(--fs-xs)">有未保存的修改</span>
              </div>
            </template>
          </c-card>

          <c-card class="mt-4" title="基本资料与界面" sub="软件名称与公司名会显示在界面标题与导出文件中" icon="settings">
            <div class="form-grid">
              <div class="field">
                <label class="field-label">软件名称</label>
                <input class="input" v-model="settings.app_name" @input="markDirty" />
              </div>
              <div class="field">
                <label class="field-label">我方公司名称</label>
                <input class="input" v-model="settings.company_name" @input="markDirty"
                       placeholder="例如：新疆某某阀门有限公司" />
              </div>
              <div class="field">
                <label class="field-label">单个附件大小上限（MB）</label>
                <input class="input" type="number" min="1" max="500" v-model="settings.attachment_max_mb"
                       @input="markDirty" />
                <div class="field-hint">附件功能在阶段五提供</div>
              </div>
              <div class="field">
                <label class="field-label">地图审图号</label>
                <input class="input" v-model="settings.map_approval_no" @input="markDirty"
                       placeholder="对外发布地图时必填" />
                <div class="field-hint">个人自用可留空；阶段六地图界面会显示此编号</div>
              </div>
              <div class="field">
                <label class="field-label">界面主题</label>
                <select class="input" :value="theme.mode" @change="setTheme($event.target.value)">
                  <option value="light">浅色（默认）</option>
                  <option value="dark">深色</option>
                </select>
                <div class="field-hint">只在本地记住；顶栏右上角的开关也能随时切换</div>
              </div>
            </div>

            <div class="mt-5" style="display:flex;gap:8px;align-items:center">
              <button class="btn btn-primary" :disabled="saving || !dirty" @click="save">
                {{ saving ? '保存中…' : '保存设置' }}
              </button>
              <button class="btn" :disabled="saving" @click="load">放弃修改</button>
              <span v-if="dirty" class="muted" style="font-size:var(--fs-xs)">有未保存的修改</span>
            </div>
          </c-card>
        </template>
      </div>`
  };

  /* ================= 回收站 ================= */
  const TrashPanel = {
    name: 'TrashPanel',
    data() {
      return {
        types: [
          { key: 'customer', label: '客户' },
          { key: 'project', label: '项目' },
          { key: 'followup', label: '跟进记录' }
        ],
        type: 'customer',
        list: [],
        loading: false,
        selected: []
      };
    },
    computed: {
      allChecked() {
        return this.list.length > 0 && this.list.every((x) => this.selected.includes(x.id));
      }
    },
    methods: {
      fmtDate: CRM.util.fmtDate,
      async load() {
        this.loading = true;
        this.selected = [];
        try {
          this.list = await CRM.api.listTrash(this.type);
        } catch (e) {
          CRM.toast(e.message || '加载回收站失败', 'error');
        } finally {
          this.loading = false;
        }
      },
      switchType(t) { this.type = t; this.load(); },
      toggleAll(e) {
        if (e.target.checked) this.selected = this.list.map((x) => x.id);
        else this.selected = [];
      },
      toggleOne(item) {
        const i = this.selected.indexOf(item.id);
        if (i >= 0) this.selected.splice(i, 1);
        else this.selected.push(item.id);
      },
      async restore(ids) {
        if (!ids.length) { CRM.toast('请先勾选要还原的记录', 'error'); return; }
        try {
          const r = await CRM.api.restore(ids, this.type);
          CRM.toast(`已还原 ${r.count} 条`, 'success');
          this.load();
        } catch (e) {
          CRM.toast(e.message || '还原失败', 'error');
        }
      }
    },
    async created() { this.load(); },
    template: `
      <c-card title="回收站" sub="删除的记录先放这里，可随时还原；「彻底删除」不可恢复" icon="trash">
        <div class="tabs" style="margin-bottom:12px">
          <button v-for="t in types" :key="t.key" class="tab"
                  :class="{ active: type === t.key }" @click="switchType(t.key)">{{ t.label }}</button>
        </div>

        <div v-if="loading" class="muted">加载中…</div>
        <c-empty v-else-if="!list.length" icon="check" title="回收站是空的"
                 :desc="'没有已删除的' + (types.find(t => t.key === type) || {}).label + '。'" />

        <div v-else>
          <div style="display:flex;gap:8px;margin-bottom:10px;align-items:center;flex-wrap:wrap">
            <label class="switch" style="font-size:var(--fs-sm)">
              <input type="checkbox" :checked="allChecked" @change="toggleAll" />
              <span class="switch-track"><span class="switch-thumb"></span></span>
              <span class="switch-text">全选</span>
            </label>
            <span class="muted" style="font-size:var(--fs-xs)">已选 {{ selected.length }} / {{ list.length }}</span>
            <div style="flex:1"></div>
            <button class="btn btn-sm btn-primary" :disabled="!selected.length" @click="restore(selected)">
              还原选中
            </button>
          </div>

          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th style="width:40px"></th>
                  <th>名称 / 内容</th>
                  <th style="width:200px">所属</th>
                  <th style="width:150px">删除时间</th>
                  <th style="width:90px;text-align:right">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="it in list" :key="it.id">
                  <td>
                    <input type="checkbox" :checked="selected.includes(it.id)" @change="toggleOne(it)" />
                  </td>
                  <td>{{ it.title }}</td>
                  <td class="muted">{{ it.sub || '—' }}</td>
                  <td class="muted">{{ fmtDate(it.deleted_at, true) }}</td>
                  <td style="text-align:right">
                    <button class="btn btn-sm" @click="restore([it.id])">还原</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </c-card>`
  };

  /* ================= 操作日志 ================= */
  const LogPanel = {
    name: 'LogPanel',
    data() {
      return {
        list: [],
        total: 0,
        page: 1,
        pageSize: 50,
        pages: 1,
        stats: { by_entity: [], by_action: [] },
        loading: false,
        q: '',
        entityType: '',
        action: '',
        dateFrom: '',
        dateTo: ''
      };
    },
    methods: {
      fmtDate: CRM.util.fmtDate,
      fromNow: CRM.util.fromNow,

      async load() {
        this.loading = true;
        try {
          const d = await CRM.api.listLogs({
            page: this.page, pageSize: this.pageSize, q: this.q,
            entity_type: this.entityType, action: this.action,
            date_from: this.dateFrom, date_to: this.dateTo
          });
          this.list = d.list;
          this.total = d.total;
          this.pages = d.pages;
          this.stats = d.stats;
        } catch (e) {
          CRM.toast(e.message || '加载日志失败', 'error');
        } finally {
          this.loading = false;
        }
      },
      search() { this.page = 1; this.load(); },
      reset() {
        this.q = ''; this.entityType = ''; this.action = '';
        this.dateFrom = ''; this.dateTo = '';
        this.page = 1; this.load();
      },
      onPage(p) { this.page = p; this.load(); },
      onPageSize(n) { this.pageSize = n; this.page = 1; this.load(); },

      tagClass(entityType) {
        const MAP = { customer: '', project: 'success', import: 'warning', backup: 'muted', settings: 'muted' };
        return MAP[entityType] || 'muted';
      },

      async clearOld() {
        const ok = await CRM.confirm({
          title: '清理旧日志',
          message: '将删除 <strong>90 天前</strong> 的操作日志。日志用于追溯改动，建议保留较长时间。确定继续吗？',
          danger: true
        });
        if (!ok) return;
        try {
          const r = await CRM.api.clearLogs(90);
          CRM.toast(`已清理 ${r.removed} 条旧日志`, 'success');
          this.load();
        } catch (e) {
          CRM.toast(e.message || '清理失败', 'error');
        }
      },

      async exportLogs() {
        try {
          const XLSX = window.XLSX;
          const d = await CRM.api.listLogs({
            page: 1, pageSize: 500, q: this.q,
            entity_type: this.entityType, action: this.action,
            date_from: this.dateFrom, date_to: this.dateTo
          });
          if (!d.list.length) { CRM.toast('没有可导出的日志', 'warn'); return; }
          const aoa = [['时间', '对象类型', '操作', '对象ID', '内容']];
          for (const l of d.list) {
            aoa.push([l.created_at, l.entity_label, l.action_label, l.entity_id || '', l.summary]);
          }
          const ws = XLSX.utils.aoa_to_sheet(aoa);
          ws['!cols'] = [{ wch: 20 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 70 }];
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, '操作日志');
          XLSX.writeFile(wb, `操作日志_${new Date().toISOString().slice(0, 10)}.xlsx`);
          CRM.toast(`已导出 ${d.list.length} 条日志`, 'success');
        } catch (e) {
          CRM.toast(e.message || '导出失败', 'error');
        }
      }
    },
    async created() { this.load(); },
    template: `
      <c-card title="操作日志" :sub="'共 ' + total + ' 条记录，谁在什么时候改了什么全部留痕'" icon="list">
        <template #head>
          <button class="btn btn-sm" @click="exportLogs">导出日志</button>
          <button class="btn btn-sm" @click="clearOld">清理 90 天前</button>
        </template>

        <div class="filter-bar" style="margin-bottom:12px">
          <div class="search-box">
            <c-icon name="search" :size="15" style="color:var(--c-text-3)" />
            <input class="input" v-model="q" placeholder="搜索日志内容" @keydown.enter="search" />
          </div>
          <select class="input" v-model="entityType" @change="search">
            <option value="">对象类型（全部）</option>
            <option v-for="s in stats.by_entity" :key="s.entity_type" :value="s.entity_type">
              {{ s.label }}（{{ s.n }}）
            </option>
          </select>
          <select class="input" v-model="action" @change="search">
            <option value="">操作类型（全部）</option>
            <option v-for="s in stats.by_action" :key="s.action" :value="s.action">
              {{ s.label }}（{{ s.n }}）
            </option>
          </select>
          <input class="input" type="date" v-model="dateFrom" @change="search" />
          <span class="muted">至</span>
          <input class="input" type="date" v-model="dateTo" @change="search" />
          <button class="btn" @click="reset">清空条件</button>
        </div>

        <div v-if="loading" class="muted" style="padding:16px 0">加载中…</div>
        <c-empty v-else-if="!list.length" icon="list" title="没有符合条件的日志" />

        <template v-else>
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th style="width:150px">时间</th>
                  <th style="width:90px">对象</th>
                  <th style="width:80px">操作</th>
                  <th>内容</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="l in list" :key="l.id">
                  <td class="muted">{{ fmtDate(l.created_at, true) }}</td>
                  <td><span class="tag" :class="tagClass(l.entity_type)" style="font-size:10px">{{ l.entity_label }}</span></td>
                  <td>{{ l.action_label }}</td>
                  <td>{{ l.summary }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <c-pager :page="page" :pages="pages" :total="total" :page-size="pageSize"
                   @update:page="onPage" @update:page-size="onPageSize" />
        </template>
      </c-card>`
  };

  CRM.settings = CRM.settings || {};
  CRM.settings.TagPanel = TagPanel;
  CRM.settings.PrefsPanel = PrefsPanel;
  CRM.settings.TrashPanel = TrashPanel;
  CRM.settings.LogPanel = LogPanel;

})(window.CRM);
