import { createClient } from '@supabase/supabase-js';
import './styles.css';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

const app = document.querySelector('#app');

const state = {
  session: null,
  stores: [],
  companies: [],
  allCompanies: [],
  transactions: [],
  companyDebtTransactions: [],
  latestBackupLog: null,
  editingId: null,
  editingCompanyId: null,
  companySearch: '',
  activeTab: 'entry',
  filters: {
    startDate: '',
    endDate: '',
    storeId: '',
    companyId: '',
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

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function getCompanyLabel(itemOrCompanyId) {
  const companyId = typeof itemOrCompanyId === 'string' ? itemOrCompanyId : itemOrCompanyId?.company_id;
  const company = state.allCompanies.find((item) => item.id === companyId);
  if (company) return company.company_name;
  if (typeof itemOrCompanyId === 'object') return itemOrCompanyId.remittance_company || '';
  return '';
}

function getDefaultStoreId() {
  const savedStoreId = localStorage.getItem('last_store_id');
  if (state.stores.some((store) => store.id === savedStoreId)) return savedStoreId;
  return state.stores[0]?.id || '';
}

function getTypeLabel(type) {
  return type || '';
}

function getTotals() {
  const totals = {
    debt: 0,
    repayment: 0,
    bankTransfer: 0,
  };

  for (const item of state.transactions) {
    const amount = Number(item.amount || 0);
    if (item.transaction_type === '欠款') totals.debt += amount;
    if (item.transaction_type === '还款') totals.repayment += amount;
    if (item.transaction_type === '银行汇款') totals.bankTransfer += amount;
  }

  return {
    ...totals,
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

  if (message.includes('company is required')) {
    return '保存失败：请选择公司/店号。';
  }

  if (message.includes('company not found')) {
    return '保存失败：没有找到这个公司/店号，可能已经停用，请刷新后重新选择。';
  }

  if (message.includes('idx_companies_name_unique')) {
    return '公司/店号已存在，请直接选择已有名称。';
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

async function loadCompanies() {
  const { data, error } = await supabase
    .from('companies')
    .select('id, company_name, company_type, phone, remark, is_deleted, created_at, updated_at')
    .order('company_name', { ascending: true });

  if (error) throw error;
  state.allCompanies = data || [];
  state.companies = state.allCompanies.filter((item) => !item.is_deleted);
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
  if (state.filters.companyId) query = query.eq('company_id', state.filters.companyId);

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

async function loadCompanyDebtTransactions() {
  state.companyDebtTransactions = await loadAllActiveTransactions();
}

async function createCompany(company) {
  const { data, error } = await supabase
    .from('companies')
    .insert({
      company_name: company.company_name,
      company_type: company.company_type || '其他',
      phone: company.phone || null,
      remark: company.remark || null,
    })
    .select('id')
    .single();

  if (error) throw error;
  return data;
}

async function updateCompany(id, company) {
  const { error } = await supabase
    .from('companies')
    .update({
      company_name: company.company_name,
      phone: company.phone || null,
      remark: company.remark || null,
    })
    .eq('id', id);

  if (error) throw error;
}

async function softDeleteCompany(id) {
  const { error } = await supabase
    .from('companies')
    .update({ is_deleted: true })
    .eq('id', id);

  if (error) throw error;
}

async function quickAddCompany(name) {
  const companyName = name.trim();
  if (!companyName) throw new Error('请输入公司/店号名称');

  const existing = state.companies.find((item) => normalizeName(item.company_name) === normalizeName(companyName));
  if (existing) return existing.id;

  const { data: remoteCompanies, error: findError } = await supabase
    .from('companies')
    .select('id, company_name')
    .eq('is_deleted', false)
    .ilike('company_name', companyName);

  if (findError) throw findError;

  const remoteExisting = (remoteCompanies || []).find((item) => normalizeName(item.company_name) === normalizeName(companyName));
  if (remoteExisting) {
    await loadCompanies();
    return remoteExisting.id;
  }

  const created = await createCompany({ company_name: companyName, company_type: '其他' });
  await loadCompanies();
  return created.id;
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
    p_company_id: formData.company_id,
    p_transaction_date: formData.transaction_date,
    p_amount: formData.amount,
    p_transaction_type: formData.transaction_type,
    p_remittance_company: null,
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
      company_id: formData.company_id,
      transaction_date: formData.transaction_date,
      amount: formData.amount,
      transaction_type: formData.transaction_type,
      remittance_company: null,
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

  if (!formData.get('store_id')) throw new Error('没有可用的默认店铺，请先在数据库创建一个店铺');
  if (!formData.get('company_id')) throw new Error('请选择公司/店号');
  if (!Number.isFinite(amount) || amount < 0) throw new Error('金额必须是大于等于 0 的数字');

  return {
    transaction_date: formData.get('transaction_date'),
    store_id: formData.get('store_id'),
    company_id: formData.get('company_id'),
    amount,
    transaction_type: formData.get('transaction_type'),
    remittance_method: '银行转账',
    remark: formData.get('remark').trim(),
    operator: state.session?.user?.email || '',
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

function companyOptions(selectedId = '') {
  return [
    '<option value="">请选择公司/店号</option>',
    ...state.companies.map(
      (company) =>
        `<option value="${escapeHtml(company.id)}" ${company.id === selectedId ? 'selected' : ''}>${escapeHtml(company.company_name)}</option>`,
    ),
  ].join('');
}

function transactionForm(item = null) {
  return `
    <form id="${item ? 'edit-form' : 'create-form'}" class="form">
      <input type="hidden" name="store_id" value="${escapeHtml(item?.store_id || getDefaultStoreId())}" />
      <label>
        日期
        <input name="transaction_date" type="date" value="${item?.transaction_date || localStorage.getItem('last_transaction_date') || today()}" required />
      </label>
      <label>
        公司/店号
        <select name="company_id" required>${companyOptions(item?.company_id || localStorage.getItem('last_company_id') || '')}</select>
      </label>
      <div class="quick-company">
        <label>
          新公司/店号
          <input id="quick-company-name" placeholder="输入新名称" />
        </label>
        <button type="button" class="secondary" id="quick-add-company">新增并选中</button>
      </div>
      ${item?.remittance_company && !item?.company_id ? `<p class="muted">历史公司文本：${escapeHtml(item.remittance_company)}</p>` : ''}
      <label>
        金额
        <input name="amount" type="number" step="0.01" min="0" inputmode="decimal" value="${escapeHtml(item?.amount || '')}" required />
      </label>
      <label>
        类型
        <select name="transaction_type" required>
          ${[
              { value: '欠款', label: '欠款' },
              { value: '还款', label: '还款' },
              { value: '银行汇款', label: '银行汇款' },
            ]
            .map((type) => `<option value="${type.value}" ${type.value === (item?.transaction_type || '欠款') ? 'selected' : ''}>${type.label}</option>`)
            .join('')}
        </select>
      </label>
      <label>
        备注
        <textarea name="remark" rows="3">${escapeHtml(item?.remark || '')}</textarea>
      </label>
      <button type="submit">${item ? '保存修改' : '保存账目'}</button>
      ${item ? '<button type="button" class="secondary" id="cancel-edit">取消编辑</button>' : ''}
    </form>
  `;
}

function renderApp() {
  const editingItem = state.transactions.find((item) => item.id === state.editingId);
  const editingCompany = state.companies.find((item) => item.id === state.editingCompanyId);

  app.innerHTML = `
    <header class="topbar">
      <strong>记账系统</strong>
      <button class="secondary small" id="sign-out">退出</button>
    </header>
    <nav class="tabs">
      ${renderTabButton('entry', '记账')}
      ${renderTabButton('details', '明细')}
      ${renderTabButton('companies', '公司管理')}
      ${renderTabButton('backup', '备份')}
    </nav>
    <main class="shell">
      ${renderActivePage(editingItem, editingCompany)}
    </main>
  `;

  bindAppEvents();
}

function renderTabButton(tabId, label) {
  return `<button type="button" class="tab-button ${state.activeTab === tabId ? 'active' : ''}" data-tab="${tabId}">${label}</button>`;
}

function renderActivePage(editingItem, editingCompany) {
  if (state.activeTab === 'details') return renderDetailsPage(editingItem);
  if (state.activeTab === 'companies') return renderCompanyManager(editingCompany);
  if (state.activeTab === 'backup') return renderBackupPage();
  return renderEntryPage(editingItem);
}

function renderEntryPage(editingItem) {
  return `
    <section class="panel page-panel">
      <h2>${editingItem ? '编辑账目' : '记账'}</h2>
      <p class="muted">序号由数据库自动生成。</p>
      ${transactionForm(editingItem)}
    </section>
  `;
}

function renderDetailsPage(editingItem) {
  const totals = getTotals();
  const selectedCompanyDebt = state.filters.companyId ? getCompanyDebtRow(state.filters.companyId) : null;

  return `
    <section class="panel page-panel">
      <div class="section-head">
        <h2>${editingItem ? '编辑账目' : '账目明细'}</h2>
        <div class="export-actions">
          <button class="secondary small" id="export-csv">导出 CSV</button>
          <button class="secondary small" id="export-xlsx">导出 Excel</button>
        </div>
      </div>

      ${editingItem ? transactionForm(editingItem) : ''}

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
          公司/店号
          <select name="companyId">${companyOptions(state.filters.companyId)}</select>
        </label>
        <button type="submit">查询</button>
        <button type="button" class="secondary" id="reset-filter">重置</button>
      </form>

      ${selectedCompanyDebt ? `
        <div class="company-summary">
          <strong>${escapeHtml(selectedCompanyDebt.companyName)}</strong>
          <span>欠款合计：${money(selectedCompanyDebt.debt)}</span>
          <span>还款合计：${money(selectedCompanyDebt.repayment)}</span>
          <span class="${selectedCompanyDebt.balance >= 0 ? 'negative' : 'positive'}">当前余额：${money(selectedCompanyDebt.balance)}</span>
        </div>
      ` : ''}

      <div class="totals compact-totals">
        <div><span>欠款合计</span><strong>${money(totals.debt)}</strong></div>
        <div><span>还款合计</span><strong>${money(totals.repayment)}</strong></div>
        <div><span>银行汇款</span><strong>${money(totals.bankTransfer)}</strong></div>
        <div><span>当前余额</span><strong class="${totals.totalDebt >= 0 ? 'negative' : 'positive'}">${money(totals.totalDebt)}</strong></div>
      </div>

      <div class="list">
        ${
          state.transactions.length
            ? state.transactions.map(renderTransactionItem).join('')
            : '<p class="muted">暂无账目。</p>'
        }
      </div>
    </section>
  `;
}

function renderBackupPage() {
  return `
    <section class="panel page-panel">
      <div class="section-head">
        <h2>备份</h2>
        <div class="export-actions">
          <button class="secondary small" id="export-all-xlsx">导出全部未删除账目</button>
        </div>
      </div>
      ${renderBackupStatus()}
    </section>
  `;
}

function getCompanyDebtRows() {
  const byCompany = new Map();

  for (const transaction of state.companyDebtTransactions) {
    if (!transaction.company_id) continue;
    const company = state.companies.find((item) => item.id === transaction.company_id);
    if (!company) continue;

    if (!byCompany.has(transaction.company_id)) {
      byCompany.set(transaction.company_id, {
        companyId: transaction.company_id,
        companyName: company.company_name,
        debt: 0,
        repayment: 0,
        balance: 0,
      });
    }

    const row = byCompany.get(transaction.company_id);
    const amount = Number(transaction.amount || 0);
    if (transaction.transaction_type === '欠款') row.debt += amount;
    if (transaction.transaction_type === '还款') row.repayment += amount;
    row.balance = row.debt - row.repayment;
  }

  return [...byCompany.values()]
    .filter((row) => row.debt > 0 || row.repayment > 0)
    .sort((a, b) => b.balance - a.balance);
}

function getCompanyDebtRow(companyId) {
  return getCompanyDebtRows().find((row) => row.companyId === companyId) || {
    companyId,
    companyName: getCompanyLabel(companyId),
    debt: 0,
    repayment: 0,
    balance: 0,
  };
}

function renderCompanyDebtSection() {
  const rows = getCompanyDebtRows();

  return `
    <section class="panel">
      <h2>公司欠款</h2>
      <p class="muted">公司欠款 = 欠款合计 - 还款合计，只统计当前明细范围内未删除账目。</p>
      <div class="company-debt-list">
        ${
          rows.length
            ? rows.map((row) => `
                <article class="company-debt-row">
                  <strong>${escapeHtml(row.companyName)}</strong>
                  <span>欠款：${money(row.debt)}</span>
                  <span>还款：${money(row.repayment)}</span>
                  <span class="${row.balance >= 0 ? 'negative' : 'positive'}">余额：${money(row.balance)}</span>
                </article>
              `).join('')
            : '<p class="muted">暂无公司欠款数据。</p>'
        }
      </div>
    </section>
  `;
}

function renderCompanyManager(editingCompany = null) {
  return `
    <section class="panel page-panel">
      <h2>${editingCompany ? '编辑公司/店号' : '公司/店号管理'}</h2>
      <form id="company-form" class="form">
        <label>
          公司/店号名称
          <input name="company_name" value="${escapeHtml(editingCompany?.company_name || '')}" required />
        </label>
        <label>
          电话
          <input name="phone" value="${escapeHtml(editingCompany?.phone || '')}" />
        </label>
        <label>
          备注
          <textarea name="remark" rows="2">${escapeHtml(editingCompany?.remark || '')}</textarea>
        </label>
        <button type="submit">${editingCompany ? '保存公司' : '新增公司'}</button>
        ${editingCompany ? '<button type="button" class="secondary" id="cancel-company-edit">取消编辑</button>' : ''}
      </form>

      <label class="company-search">
        搜索公司/店号
        <input id="company-search" value="${escapeHtml(state.companySearch)}" placeholder="公司名、电话、备注" />
      </label>

      <div class="company-list">
        ${renderCompanyListItems()}
      </div>
    </section>
  `;
}

function getVisibleCompanies() {
  const keyword = normalizeName(state.companySearch);
  return state.companies.filter((company) => {
    if (!keyword) return true;
    return [company.company_name, company.phone, company.remark].some((value) => normalizeName(value).includes(keyword));
  });
}

function renderCompanyListItems() {
  const visibleCompanies = getVisibleCompanies();

  return visibleCompanies.length
    ? visibleCompanies.map((company) => `
        <article class="company-item">
          <div>
            <strong>${escapeHtml(company.company_name)}</strong>
            <p class="muted">${escapeHtml(company.phone || '')} ${escapeHtml(company.remark || '')}</p>
          </div>
          <div class="actions">
            <button class="secondary small" data-company-edit="${escapeHtml(company.id)}">编辑</button>
            <button class="danger small" data-company-delete="${escapeHtml(company.id)}">停用</button>
          </div>
        </article>
      `).join('')
    : '<p class="muted">暂无公司。</p>';
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
  const companyName = getCompanyLabel(item);
  return `
    <article class="transaction">
      <div>
        <strong>${escapeHtml(item.transaction_date)}</strong>
      </div>
      <div>${escapeHtml(companyName)}</div>
      <div class="amount">${money(item.amount)}</div>
      <div><span class="tag">${escapeHtml(getTypeLabel(item.transaction_type))}</span></div>
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

  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      state.activeTab = button.dataset.tab;
      if (state.activeTab !== 'details') state.editingId = null;
      if (state.activeTab !== 'companies') state.editingCompanyId = null;
      renderApp();
    });
  });

  const activeForm = document.querySelector('#edit-form') || document.querySelector('#create-form');
  activeForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;

    try {
      const data = readForm(form);
      localStorage.setItem('last_transaction_date', data.transaction_date);
      localStorage.setItem('last_store_id', data.store_id);
      localStorage.setItem('last_company_id', data.company_id);
      localStorage.setItem('last_remittance_method', data.remittance_method);

      if (state.editingId) {
        await updateTransaction(state.editingId, data);
        state.editingId = null;
        state.activeTab = 'details';
      } else {
        await createTransaction(data);
      }

      await loadTransactions();
      await loadCompanyDebtTransactions();
      if (state.activeTab === 'entry') {
        form.amount.value = '';
        form.remark.value = '';
        form.transaction_type.value = '欠款';
      } else {
        renderApp();
      }
    } catch (error) {
      alert(getFriendlyError(error));
    }
  });

  document.querySelector('#filter-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    state.filters.startDate = data.get('startDate');
    state.filters.endDate = data.get('endDate');
    state.filters.storeId = '';
    state.filters.companyId = data.get('companyId');
    try {
      await loadTransactions();
      renderApp();
    } catch (error) {
      alert(getFriendlyError(error));
    }
  });

  document.querySelector('#reset-filter')?.addEventListener('click', async () => {
    state.filters = { startDate: '', endDate: '', storeId: '', companyId: '' };
    try {
      await loadTransactions();
      renderApp();
    } catch (error) {
      alert(getFriendlyError(error));
    }
  });

  document.querySelector('#export-csv')?.addEventListener('click', exportCsv);
  document.querySelector('#export-xlsx')?.addEventListener('click', async () => {
    try {
      await exportXlsx(state.transactions, `账目备份_${today()}.xlsx`);
    } catch (error) {
      alert(getFriendlyError(error));
    }
  });

  document.querySelector('#export-all-xlsx')?.addEventListener('click', async () => {
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
      state.activeTab = 'details';
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
        await loadCompanyDebtTransactions();
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

  document.querySelector('#quick-add-company')?.addEventListener('click', async () => {
    const input = document.querySelector('#quick-company-name');
    try {
      const companyId = await quickAddCompany(input.value);
      localStorage.setItem('last_company_id', companyId);
      const select = document.querySelector('[name="company_id"]');
      if (select) {
        select.innerHTML = companyOptions(companyId);
        select.value = companyId;
      }
      input.value = '';
    } catch (error) {
      alert(getFriendlyError(error));
    }
  });

  document.querySelector('#company-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const company = {
      company_name: formData.get('company_name').trim(),
      phone: formData.get('phone').trim(),
      remark: formData.get('remark').trim(),
    };

    if (!company.company_name) {
      alert('请输入公司名称');
      return;
    }

    const duplicate = state.companies.find(
      (item) => normalizeName(item.company_name) === normalizeName(company.company_name) && item.id !== state.editingCompanyId,
    );
    if (duplicate) {
      alert('公司/店号已存在，请直接使用已有名称。');
      return;
    }

    try {
      if (state.editingCompanyId) {
        await updateCompany(state.editingCompanyId, company);
        state.editingCompanyId = null;
      } else {
        await createCompany(company);
      }
      await loadCompanies();
      renderApp();
    } catch (error) {
      alert(getFriendlyError(error));
    }
  });

  document.querySelector('#company-search')?.addEventListener('input', (event) => {
    state.companySearch = event.target.value;
    const list = document.querySelector('.company-list');
    if (list) list.innerHTML = renderCompanyListItems();
  });

  document.querySelector('.company-list')?.addEventListener('click', async (event) => {
    const editButton = event.target.closest('[data-company-edit]');
    const deleteButton = event.target.closest('[data-company-delete]');

    if (editButton) {
      state.editingCompanyId = editButton.dataset.companyEdit;
      renderApp();
    }

    if (deleteButton) {
      const confirmed = confirm('确认停用这个公司吗？\n\n停用后不会删除历史账目，只是不再出现在选择列表中。');
      if (!confirmed) return;
      try {
        await softDeleteCompany(deleteButton.dataset.companyDelete);
        if (state.filters.companyId === deleteButton.dataset.companyDelete) {
          state.filters.companyId = '';
        }
        if (localStorage.getItem('last_company_id') === deleteButton.dataset.companyDelete) {
          localStorage.removeItem('last_company_id');
        }
        await loadCompanies();
        renderApp();
      } catch (error) {
        alert(getFriendlyError(error));
      }
    }
  });

  document.querySelector('#cancel-company-edit')?.addEventListener('click', () => {
    state.editingCompanyId = null;
    renderApp();
  });
}

function getExportRows(transactions, options = {}) {
  return transactions.map((item) => [
    item.transaction_date,
    item.serial_no,
    getStoreLabel(item.store_id),
    options.numericAmount ? Number(money(item.amount)) : money(item.amount),
    getTypeLabel(item.transaction_type),
    getCompanyLabel(item),
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
  await loadCompanies();
  await loadTransactions();
  await loadCompanyDebtTransactions();
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
