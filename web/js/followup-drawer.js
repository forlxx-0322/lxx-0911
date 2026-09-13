/**
 * 跟进记录抽屉（列表页与详情页共用）
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  function nowLocal() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  const FollowupDrawer = {
    name: 'FollowupDrawer',
    props: {
      modelValue: Boolean,
      customerId: [Number, String],
      customerName: String
    },
    emits: ['update:modelValue', 'saved'],
    data() {
      return {
        form: {
          followed_at: nowLocal(),
          method: '电话',
          content: '',
          result: '',
          next_plan: '',
          next_at: ''
        },
        saving: false
      };
    },
    watch: {
      modelValue(v) {
        if (v) {
          this.form = {
            followed_at: nowLocal(),
            method: '电话',
            content: '',
            result: '',
            next_plan: '',
            next_at: ''
          };
        }
      }
    },
    methods: {
      async save() {
        if (!String(this.form.content || '').trim()) {
          CRM.toast('请填写跟进内容', 'error');
          return;
        }
        this.saving = true;
        try {
          const payload = Object.assign({ customer_id: Number(this.customerId) }, this.form);
          /* datetime-local 的 T 分隔符转成数据库习惯的空格格式 */
          if (payload.followed_at) payload.followed_at = String(payload.followed_at).replace('T', ' ') + ':00';
          if (payload.next_at) payload.next_at = String(payload.next_at).replace('T', ' ') + ':00';
          const r = await CRM.api.saveFollowup(payload);
          CRM.toast(r.taskCreated ? '跟进已记录，并已自动生成待办' : '跟进已记录', 'success');
          this.$emit('saved', r);
          this.$emit('update:modelValue', false);
        } catch (e) {
          CRM.toast(e.message || '保存失败', 'error');
        } finally {
          this.saving = false;
        }
      }
    },
    template: `
      <c-drawer :model-value="modelValue" title="记录跟进"
                :sub="customerName ? '客户：' + customerName : ''" width="560px"
                @update:model-value="$emit('update:modelValue', $event)">
        <div class="form-grid">
          <c-field v-model="form.followed_at" label="跟进时间" type="datetime-local" required />
          <c-select v-model="form.method" label="跟进方式"
                    :options="api.options('follow_method')" />
          <c-field v-model="form.content" label="跟进内容" type="textarea" :span="2" :rows="4" required
                   placeholder="例如：拜访采购部王经理，沟通 2026 年度框架协议续签，客户关注交货期与质保期。" />
          <c-select v-model="form.result" label="跟进结果"
                    :options="api.options('follow_result')" />
          <c-field v-model="form.next_at" label="下次跟进时间" type="datetime-local"
                   hint="填写后自动生成待办并回填到客户" />
          <c-field v-model="form.next_plan" label="下次计划" type="textarea" :span="2" :rows="2"
                   placeholder="例如：准备技术方案与报价单" />
        </div>
        <template #footer>
          <span class="muted" style="font-size:var(--fs-xs)">保存后会更新客户的跟进次数与最近跟进时间</span>
          <div style="flex:1"></div>
          <button class="btn" @click="$emit('update:modelValue', false)">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="save">
            {{ saving ? '保存中…' : '保存跟进' }}
          </button>
        </template>
      </c-drawer>`,
    setup() { return { api: CRM.api }; }
  };

  CRM.pages = CRM.pages || {};
  CRM.pages.FollowupDrawer = FollowupDrawer;

})(window.CRM);
