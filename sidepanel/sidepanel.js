const form = document.querySelector('#query-form');
const button = document.querySelector('#query-button');
const resultCount = document.querySelector('#result-count');
const queryState = document.querySelector('#query-state');
const errorState = document.querySelector('#error-state');
const tableWrap = document.querySelector('#results-table-wrap');
const resultsBody = document.querySelector('#results-body');
const savedFieldNames = ['baseUrl', 'email', 'groupName'];

function setBusy(isBusy) {
  button.disabled = isBusy;
  button.textContent = isBusy ? '查询中…' : '查询账号';
}

function createCell(value, className = '') {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = value || '—';
  return cell;
}

function renderAccounts(accounts) {
  resultsBody.replaceChildren();
  for (const account of accounts) {
    const row = document.createElement('tr');
    row.append(
      createCell(String(account.id ?? '—'), 'mono'),
      createCell(account.email || account.name, 'account-name'),
      createCell(account.status, 'status-cell'),
      createCell(account.proxyId ? `#${account.proxyId}` : '未配置', 'mono'),
      createCell(account.errorMessage || '未返回错误详情', 'error-copy')
    );
    resultsBody.append(row);
  }
}

function normalizeInputUrl(value = '') {
  const rawValue = String(value || '').trim();
  if (!rawValue) throw new Error('请填写 SUB2API 地址。');
  const parsed = new URL(/^https?:\/\//i.test(rawValue) ? rawValue : `http://${rawValue}`);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('SUB2API 地址必须使用 HTTP 或 HTTPS。');
  }
  return parsed;
}

function getPermissionPattern(baseUrl) {
  const parsed = normalizeInputUrl(baseUrl);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

async function ensureHostPermission(baseUrl) {
  const origin = getPermissionPattern(baseUrl);
  const hasPermission = await chrome.permissions.contains({ origins: [origin] });
  if (hasPermission) return;

  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) {
    throw new Error(`未授予访问 ${origin} 的权限。`);
  }
}

async function restoreSettings() {
  const saved = await chrome.storage.local.get(savedFieldNames);
  for (const fieldName of savedFieldNames) {
    const input = form.elements.namedItem(fieldName);
    if (input && saved[fieldName]) input.value = saved[fieldName];
  }
}

async function saveNonSensitiveFields() {
  const values = new FormData(form);
  await chrome.storage.local.set(Object.fromEntries(
    savedFieldNames.map((name) => [name, String(values.get(name) || '').trim()])
  ));
}

async function queryAccounts(event) {
  event.preventDefault();
  const values = new FormData(form);
  const connection = {
    baseUrl: String(values.get('baseUrl') || '').trim(),
    email: String(values.get('email') || '').trim(),
    password: String(values.get('password') || ''),
    groupName: String(values.get('groupName') || '').trim(),
  };

  setBusy(true);
  errorState.hidden = true;
  tableWrap.hidden = true;
  queryState.textContent = '正在查询…';

  try {
    await ensureHostPermission(connection.baseUrl);
    await saveNonSensitiveFields();
    const response = await chrome.runtime.sendMessage({
      type: 'QUERY_REAUTH_CANDIDATES',
      connection,
    });
    if (!response?.ok) {
      throw new Error(response?.error || '查询失败。');
    }

    const accounts = Array.isArray(response.result?.accounts) ? response.result.accounts : [];
    renderAccounts(accounts);
    resultCount.textContent = String(accounts.length);
    tableWrap.hidden = accounts.length === 0;
    queryState.textContent = accounts.length
      ? `${response.result.group.name} · ${response.result.statuses.join(' / ')}`
      : '没有匹配的账号';
  } catch (error) {
    resultCount.textContent = '0';
    errorState.textContent = error.message || '查询失败。';
    errorState.hidden = false;
    queryState.textContent = '查询未完成';
  } finally {
    setBusy(false);
  }
}

form.addEventListener('submit', queryAccounts);
form.addEventListener('input', (event) => {
  if (savedFieldNames.includes(event.target.name)) {
    saveNonSensitiveFields().catch(() => {});
  }
});

restoreSettings().catch(() => {});
