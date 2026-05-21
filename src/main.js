import { createClient } from '@supabase/supabase-js';
import './styles.css';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

const app = document.querySelector('#app');

const state = {
  session: null,
  stores: [],
  transactions: [],
  latestBackupLog: null,
  editingId: null,
  filters: {
    startDate: '',
    endDate: '',
    storeId: '',
  },
};

const today = () => new Date().toISOString().slice(0, 10);

const supabase =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey)
    : null;

function money(value) {
  return Number(value || 0).toFixed(2);
}

function formatDateTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function escapeCsv(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getStoreLabel(storeId) {
  const store = state.stores.find((item) => item.id === storeId);
  return store ? store.store_no : '';
}

function getTotals() {
  const totals = {
    income: 0,
    expense: 0,
    debt: 0,
    repayment: 0,
  };

  for (const item of state.transactions) {
    const amount = Number(item.amount || 0);
    if (item.transaction_type === '收入') totals.income += amount;
    if (item.transaction_type === '支出') totals.expense += amount;
    if (item.transaction_type === '欠款') totals.debt += amount;
    if (item.transaction_type === '还款') totals.repayment += amount;
  }

  return {
    ...totals,
    net: totals.income + totals.repayment - totals.expense - totals.debt,
    totalDebt: totals.debt - totals.repayment,
  };
}

function requireSupabase() {
  if (!supabase) {
    throw new Error('请先配置 .env 文件中的 VITE_SUPABASE_URL 和 VITE_SUPABASE_ANON_KEY');
  }
}

function getFriendlyError(error) {
  const message = error?.message || String(error);

  if (message.includes('duplicate key') || message.includes('transactions_store_serial_no_unique')) {
    return '保存失败：账目序号重复，请重新保存一次。';
  }

  if (message.includes('not authenticated')) {
    return '操作失败：请先登录。';
  }

  if (message.includes('store not found')) {
    return '保存失败：没有找到这个店铺，请刷新后重新选择店号。';
  }

  return `操作失败：${message}`;
}

async function loadSession() {
  requireSupabase();
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  state.session = data.session;
}

async function signIn(email, password) {
  requireSupabase();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  state.session = data.session;
}

async function signOut() {
  requireSupabase();
  await supabase.auth.signOut();
  state.session = null;
  state.transactions = [];
  renderLogin();
}

async function loadStores() {
  const { data, error } = await supabase
    .from('stores')
    .select('id, store_no, store_name')
    .eq('is_deleted', false)
    .order('store_no', { ascending: true });

  if (error) throw error;
  state.stores = data || [];
}

async function loadTransactions() {
  let query = supabase
    .from('transactions')
    .select('*')
    .eq('is_deleted', false)
    .order('transaction_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (state.filters.startDate) query = query.gte('transaction_date', state.filters.startDate);
  if (state.filters.endDate) query = query.lte('transaction_date', state.filters.endDate);
  if (state.filters.storeId) query = query.eq('store_id', state.filters.storeId);

  const { data, error } = await query;
  if (error) throw error;
  state.transactions = data || [];
}

async function loadAllActiveTransactions() {
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('is_deleted', false)
    .order('transaction_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

async function loadLatestBackupLog() {
  const { data, error } = await supabase
    .from('backup_logs')
    .select('backup_type, status, file_name, record_count, sent_to, error_message, started_at, finished_at, created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  state.latestBackupLog = data || null;
}

async function createTransaction(formData) {
  const { error } = await supabase.rpc('create_transaction_with_serial_no', {
    p_store_id: formData.store_id,
    p_transaction_date: formData.transaction_date,
    p_amount: formData.amount,
    p_transaction_type: formData.transaction_type,
    p_remittance_company: formData.remittance_company || null,
    p_remittance_method: formData.remittance_method,
    p_remittance_account: null,
    p_remark: formData.remark || null,
    p_operator: formData.operator || null,
  });

  if (error) throw error;
}

async function updateTransaction(id, formData) {
  const { error } = await supabase
    .from('transactions')
    .update({
      store_id: formData.store_id,
      transaction_date: formData.transaction_date,
      amount: formData.amount,
      transaction_type: formData.transaction_type,
      remittance_company: formData.remittance_company || null,
      remittance_method: formData.remittance_method,
      remark: formData.remark || null,
      operator: formData.operator || null,
    })
    .eq('id', id);

  if (error) throw error;
}

async function softDeleteTransaction(id) {
  const { error } = await supabase
    .from('transactions')
    .update({ is_deleted: true })
    .eq('id', id);

  if (error) throw error;
}

function readForm(form) {
  const formData = new FormData(form);
  const amount = Number(formData.get('amount'));

  if (!formData.get('store_id')) throw new Error('请选择店号');
  if (!Number.isFinite(amount) || amount < 0) throw new Error('金额必须是大于等于 0 的数字');

  return {
    transaction_date: formData.get('transaction_date'),
    store_id: formData.get('store_id'),
    amount,
    transaction_type: formData.get('transaction_type'),
    remittance_company: formData.get('remittance_company').trim(),
    remittance_method: formData.get('remittance_method'),
    remark: formData.get('remark').trim(),
    operator: formData.get('operator').trim(),
  };
}

function renderLogin(errorMessage = '') {
  app.innerHTML = `
    <main class="shell shell-narrow">
      <section class="panel">
        <h1>记账系统</h1>
        <p class="muted">请使用 Supabase 账号登录。</p>
        ${errorMessage ? `<p class="alert">${errorMessage}</p>` : ''}
        <form id="login-form" class="form">
          <label>
            邮箱
            <input name="email" type="email" autocomplete="email" required />
          </label>
          <label>
            密码
            <input name="password" type="password" autocomplete="current-password" required />
          </label>
          <button type="submit">登录</button>
        </form>
      </section>
    </main>
  `;

  document.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const data = new FormData(event.currentTarget);
      await signIn(data.get('email'), data.get('password'));
      await bootstrapApp();
    } catch (error) {
      renderLogin(error.message);
    }
  });
}

function storeOptions(selectedId = '') {
  return [
    '<option value="">请选择店号</option>',
    ...state.stores.map(
      (store) =>
        `<option value="${escapeHtml(store.id)}" ${store.id === selectedId ? 'selected' : ''}>${escapeHtml(store.store_no)} - ${escapeHtml(store.store_name)}</option>`,
    ),
  ].join('');
}

function transactionForm(item = null) {
  return `
    <form id="${item ? 'edit-form' : 'create-form'}" class="form">
      <label>
        日期
        <input name="transaction_date" type="date" value="${item?.transaction_date || localStorage.getItem('last_transaction_date') || today()}" required />
      </label>
      <label>
        店号
        <select name="store_id" required>${storeOptions(item?.store_id || localStorage.getItem('last_store_id') || '')}</select>
      </label>
      <label>
        金额
        <input name="amount" type="number" step="0.01" min="0" inputmode="decimal" value="${escapeHtml(item?.amount || '')}" required />
      </label>
      <label>
        类型
        <select name="transaction_type" required>
          ${['收入', '支出', '欠款', '还款']
            .map((type) => `<option value="${type}" ${type === (item?.transaction_type || '支出') ? 'selected' : ''}>${type}</option>`)
            .join('')}
        </select>
      </label>
      <label>
        汇款公司
        <input name="remittance_company" value="${escapeHtml(item?.remittance_company || '')}" />
      </label>
      <label>
        汇款方式
        <select name="remittance_method" required>
          ${['现金', '银行转账', '微信', '支付宝', '其他']
            .map(
              (method) =>
                `<option value="${method}" ${method === (item?.remittance_method || localStorage.getItem('last_remittance_method') || '现金') ? 'selected' : ''}>${method}</option>`,
            )
            .join('')}
        </select>
      </label>
      <label>
        备注
        <textarea name="remark" rows="3">${escapeHtml(item?.remark || '')}</textarea>
      </label>
      <label>
        操作人显示名
        <input name="operator" value="${escapeHtml(item?.operator || state.session?.user?.email || '')}" />
      </label>
      <button type="submit">${item ? '保存修改' : '保存账目'}</button>
      ${item ? '<button type="button" class="secondary" id="cancel-edit">取消编辑</button>' : ''}
    </form>
  `;
}

function renderApp() {
  const totals = getTotals();
  const editingItem = state.transactions.find((item) => item.id === state.editingId);

  app.innerHTML = `
    <header class="topbar">
      <strong>记账系统</strong>
      <button class="secondary small" id="sign-out">退出</button>
    </header>
    <main class="shell">
      <section class="grid">
        <section class="panel">
          <h2>${editingItem ? '编辑账目' : '新增账目'}</h2>
          <p class="muted">序号由数据库自动生成，不能手动输入。</p>
          ${transactionForm(editingItem)}
        </section>

        <section class="panel">
          <div class="section-head">
            <h2>账目明细</h2>
            <div class="export-actions">
              <button class="secondary small" id="export-csv">导出 CSV</button>
              <button class="secondary small" id="export-xlsx">导出 Excel</button>
              <button class="secondary small" id="export-all-xlsx">导出全部未删除账目</button>
            </div>
          </div>

          <form id="filter-form" class="filters">
            <label>
              开始日期
              <input name="startDate" type="date" value="${state.filters.startDate}" />
            </label>
            <label>
              结束日期
              <input name="endDate" type="date" value="${state.filters.endDate}" />
            </label>
            <label>
              店号
              <select name="storeId">${storeOptions(state.filters.storeId)}</select>
            </label>
            <button type="submit">查询</button>
            <button type="button" class="secondary" id="reset-filter">重置</button>
          </form>

          <div class="totals">
            <div><span>收入</span><strong>${money(totals.income)}</strong></div>
            <div><span>支出</span><strong>${money(totals.expense)}</strong></div>
            <div><span>欠款</span><strong>${money(totals.debt)}</strong></div>
            <div><span>还款</span><strong>${money(totals.repayment)}</strong></div>
            <div><span>净额</span><strong class="${totals.net >= 0 ? 'positive' : 'negative'}">${money(totals.net)}</strong></div>
            <div><span>总欠款</span><strong>${money(totals.totalDebt)}</strong></div>
          </div>

          ${renderBackupStatus()}

          <div class="list">
            ${
              state.transactions.length
                ? state.transactions.map(renderTransactionItem).join('')
                : '<p class="muted">暂无账目。</p>'
            }
          </div>
        </section>
      </section>
    </main>
  `;

  bindAppEvents();
}

function renderBackupStatus() {
  const log = state.latestBackupLog;

  if (!log) {
    return `
      <section class="backup-status">
        <strong>最近自动备份</strong>
        <span class="muted">暂无备份记录</span>
      </section>
    `;
  }

  const statusText = {
    running: '执行中',
    success: '成功',
    failed: '失败',
  }[log.status] || log.status;

  return `
    <section class="backup-status">
      <div class="backup-status-head">
        <strong>最近自动备份</strong>
        <span class="backup-pill ${escapeHtml(log.status)}">${escapeHtml(statusText)}</span>
      </div>
      <div class="backup-meta">
        <span>时间：${escapeHtml(formatDateTime(log.finished_at || log.started_at || log.created_at))}</span>
        <span>记录数：${escapeHtml(log.record_count ?? 0)}</span>
        <span>文件：${escapeHtml(log.file_name || '')}</span>
        <span>邮箱：${escapeHtml(log.sent_to || '')}</span>
      </div>
      ${log.status === 'failed' ? `<p class="alert">${escapeHtml(log.error_message || '备份失败')}</p>` : ''}
    </section>
  `;
}

function renderTransactionItem(item) {
  return `
    <article class="transaction">
      <div>
        <strong>${escapeHtml(item.transaction_date)}</strong>
        <span class="tag">${escapeHtml(item.transaction_type)}</span>
      </div>
      <div class="amount">${money(item.amount)}</div>
      <div class="muted">${escapeHtml(item.serial_no)} · ${escapeHtml(getStoreLabel(item.store_id))} · ${escapeHtml(item.remittance_method || '')}</div>
      <div>${escapeHtml(item.remittance_company || '')}</div>
      <div class="muted">${escapeHtml(item.remark || '')}</div>
      <div class="actions">
        <button class="secondary small" data-edit="${escapeHtml(item.id)}">编辑</button>
        <button class="danger small" data-delete="${escapeHtml(item.id)}">删除</button>
      </div>
    </article>
  `;
}

function bindAppEvents() {
  document.querySelector('#sign-out').addEventListener('click', signOut);

  const activeForm = document.querySelector('#edit-form') || document.querySelector('#create-form');
  activeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;

    try {
      const data = readForm(form);
      localStorage.setItem('last_transaction_date', data.transaction_date);
      localStorage.setItem('last_store_id', data.store_id);
      localStorage.setItem('last_remittance_method', data.remittance_method);

      if (state.editingId) {
        await updateTransaction(state.editingId, data);
        state.editingId = null;
      } else {
        await createTransaction(data);
        form.amount.value = '';
        form.remittance_company.value = '';
        form.remark.value = '';
        form.transaction_type.value = '支出';
      }

      await loadTransactions();
      renderApp();
    } catch (error) {
      alert(getFriendlyError(error));
    }
  });

  document.querySelector('#filter-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    state.filters.startDate = data.get('startDate');
    state.filters.endDate = data.get('endDate');
    state.filters.storeId = data.get('storeId');
    try {
      await loadTransactions();
      renderApp();
    } catch (error) {
      alert(getFriendlyError(error));
    }
  });

  document.querySelector('#reset-filter').addEventListener('click', async () => {
    state.filters = { startDate: '', endDate: '', storeId: '' };
    try {
      await loadTransactions();
      renderApp();
    } catch (error) {
      alert(getFriendlyError(error));
    }
  });

  document.querySelector('#export-csv').addEventListener('click', exportCsv);
  document.querySelector('#export-xlsx').addEventListener('click', async () => {
    try {
      await exportXlsx(state.transactions, `账目备份_${today()}.xlsx`);
    } catch (error) {
      alert(getFriendlyError(error));
    }
  });

  document.querySelector('#export-all-xlsx').addEventListener('click', async () => {
    try {
      const allTransactions = await loadAllActiveTransactions();
      await exportXlsx(allTransactions, `账目完整备份_${today()}.xlsx`);
    } catch (error) {
      alert(getFriendlyError(error));
    }
  });

  document.querySelectorAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      state.editingId = button.dataset.edit;
      renderApp();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  document.querySelectorAll('[data-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      const confirmed = confirm('确认删除这笔账目吗？\n\n删除后不会真正删除，只会从页面隐藏。\n数据仍保留在数据库中，必要时可以恢复。');
      if (!confirmed) return;
      try {
        await softDeleteTransaction(button.dataset.delete);
        await loadTransactions();
        renderApp();
      } catch (error) {
        alert(getFriendlyError(error));
      }
    });
  });

  document.querySelector('#cancel-edit')?.addEventListener('click', () => {
    state.editingId = null;
    renderApp();
  });
}

function getExportRows(transactions, options = {}) {
  return transactions.map((item) => [
    item.transaction_date,
    item.serial_no,
    getStoreLabel(item.store_id),
    options.numericAmount ? Number(money(item.amount)) : money(item.amount),
    item.transaction_type,
    item.remittance_company || '',
    item.remittance_method || '',
    item.remark || '',
    formatDateTime(item.created_at),
    formatDateTime(item.updated_at),
    item.operator || '',
  ]);
}

function exportCsv() {
  const headers = ['日期', '序号', '店号', '金额', '类型', '汇款公司', '汇款方式', '备注', '创建时间', '修改时间', '操作人'];
  const rows = getExportRows(state.transactions);

  const csv = [headers, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n');
  const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `账目备份_${today()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

async function exportXlsx(transactions, fileName) {
  const { default: ExcelJS } = await import('exceljs');
  const headers = ['日期', '序号', '店号', '金额', '类型', '汇款公司', '汇款方式', '备注', '创建时间', '修改时间', '操作人'];
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('账目明细');

  worksheet.columns = headers.map((header, index) => ({
    header,
    key: header,
    width: [12, 22, 14, 12, 10, 18, 12, 28, 20, 20, 20][index],
  }));

  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).alignment = { vertical: 'middle' };

  for (const row of getExportRows(transactions, { numericAmount: true })) {
    worksheet.addRow(row);
  }

  worksheet.getColumn('金额').numFmt = '0.00';

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

async function bootstrapApp() {
  await loadStores();
  await loadTransactions();
  try {
    await loadLatestBackupLog();
  } catch {
    state.latestBackupLog = null;
  }
  renderApp();
}

async function init() {
  try {
    await loadSession();
    if (!state.session) {
      renderLogin();
      return;
    }
    await bootstrapApp();
  } catch (error) {
    app.innerHTML = `<main class="shell shell-narrow"><section class="panel"><h1>启动失败</h1><p class="alert">${error.message}</p></section></main>`;
  }
}

init();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // PWA install should not block normal bookkeeping use.
    });
  });
}
