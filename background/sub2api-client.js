const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_STATUSES = Object.freeze(['error', 'temp_unschedulable']);
const DEFAULT_REAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback';

function normalizeString(value = '') {
  return String(value || '').trim();
}

function normalizeEmail(value = '') {
  const email = normalizeString(value).toLowerCase();
  return email.includes('@') ? email : '';
}

function normalizeGroupKey(value = '') {
  return normalizeString(value)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function createRequestError(message, status = 500) {
  const error = new Error(normalizeString(message) || 'SUB2API 请求失败。');
  error.status = Number.isInteger(status) ? status : 500;
  return error;
}

function getErrorMessage(payload, status, path) {
  const candidates = [payload?.message, payload?.detail, payload?.error, payload?.reason];
  return candidates.map(normalizeString).find(Boolean)
    || `SUB2API 请求失败（HTTP ${status}）：${path}`;
}

function normalizeBaseUrl(value = '') {
  const rawUrl = normalizeString(value);
  if (!rawUrl) {
    throw createRequestError('请填写 SUB2API 地址。', 400);
  }

  let parsed;
  try {
    parsed = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`);
  } catch {
    throw createRequestError('SUB2API 地址格式无效。', 400);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw createRequestError('SUB2API 地址必须使用 HTTP 或 HTTPS。', 400);
  }

  return parsed.origin;
}

function extractListFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  for (const key of ['items', 'list', 'accounts', 'results', 'groups']) {
    if (Array.isArray(payload[key])) return payload[key];
  }

  if (Array.isArray(payload.data)) return payload.data;
  if (payload.data && typeof payload.data === 'object') {
    return extractListFromPayload(payload.data);
  }
  return [];
}

function extractTotalFromPayload(payload) {
  return Math.max(0, Number(
    payload?.total
    || payload?.count
    || payload?.pagination?.total
    || payload?.page?.total
    || 0
  ) || 0);
}

function normalizePositiveIds(values = []) {
  return (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}

function normalizeOptionalPositiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function extractOAuthState(oauthUrl = '') {
  try {
    return new URL(oauthUrl).searchParams.get('state') || '';
  } catch {
    return '';
  }
}

function normalizeOAuthUrl(value = '') {
  try {
    const url = new URL(normalizeString(value));
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('unsupported protocol');
    }
    return url.toString();
  } catch {
    throw createRequestError('SUB2API 未返回有效的 OpenAI 授权地址。', 502);
  }
}

function parseReauthCallback(value = '') {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw createRequestError('localhost 回调地址无效。', 400);
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'localhost') {
    throw createRequestError('回调地址必须是 http(s)://localhost/...。', 400);
  }

  const code = normalizeString(url.searchParams.get('code'));
  const state = normalizeString(url.searchParams.get('state'));
  if (!code || !state) {
    throw createRequestError('localhost 回调地址缺少 code 或 state。', 400);
  }
  return { url: url.toString(), code, state };
}

function mergeOpenAiOAuthCredentials(oldCredentials = {}, exchangeData = {}) {
  const credentials = {
    ...(oldCredentials && typeof oldCredentials === 'object' ? oldCredentials : {}),
  };
  const allowedKeys = [
    'access_token',
    'refresh_token',
    'id_token',
    'expires_at',
    'expires_in',
    'email',
    'chatgpt_account_id',
    'chatgpt_user_id',
    'organization_id',
    'plan_type',
    'client_id',
  ];

  for (const key of allowedKeys) {
    if (exchangeData?.[key] !== undefined && exchangeData?.[key] !== null && exchangeData[key] !== '') {
      credentials[key] = exchangeData[key];
    }
  }
  if (exchangeData?.expires_in && !exchangeData?.expires_at) {
    credentials.expires_at = Math.floor(Date.now() / 1000) + Number(exchangeData.expires_in);
  }
  credentials.auth_mode = 'oauth';

  if (!credentials.access_token) {
    throw createRequestError('SUB2API 交换授权码后未返回 access_token。', 502);
  }
  return credentials;
}

function buildReauthExtra(oldExtra = {}, exchangeData = {}) {
  return {
    ...(oldExtra && typeof oldExtra === 'object' && !Array.isArray(oldExtra) ? oldExtra : {}),
    ...(exchangeData?.privacy_mode ? { privacy_mode: exchangeData.privacy_mode } : {}),
    reauth_mode: 'oauth',
    reauthorized_at: new Date().toISOString(),
  };
}

function buildAccountUpdatePayload(account = {}, credentials = {}, extra = {}) {
  const payload = {
    name: account.name,
    notes: account.notes,
    platform: account.platform || 'openai',
    provider: account.provider || '',
    type: account.type || 'oauth',
    credentials,
    extra,
    proxy_id: account.proxy_id,
    concurrency: account.concurrency,
    load_factor: account.load_factor,
    priority: account.priority,
    rate_multiplier: account.rate_multiplier,
    status: 'active',
    auto_pause_on_expired: account.auto_pause_on_expired,
    expires_at: account.expires_at,
  };
  if (Array.isArray(account.group_ids)) payload.group_ids = account.group_ids;
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}

function getAccountEmail(account = {}) {
  return normalizeEmail(account?.credentials?.email)
    || normalizeEmail(account?.email)
    || normalizeEmail(account?.extra?.email)
    || normalizeEmail(account?.name);
}

function getAccountGroupNames(account = {}) {
  return (Array.isArray(account?.groups) ? account.groups : [])
    .map((group) => normalizeString(group?.name))
    .filter(Boolean);
}

function accountBelongsToGroup(account = {}, group = {}) {
  const groupId = Number(group?.id);
  if (Number.isSafeInteger(groupId) && groupId > 0 && normalizePositiveIds(account?.group_ids).includes(groupId)) {
    return true;
  }

  const expectedName = normalizeGroupKey(group?.name);
  return Boolean(expectedName) && getAccountGroupNames(account)
    .some((name) => normalizeGroupKey(name) === expectedName);
}

function isOpenAiOAuthAccount(account = {}) {
  return normalizeString(account?.platform).toLowerCase() === 'openai'
    && normalizeString(account?.type).toLowerCase() === 'oauth';
}

function normalizeCandidate(account = {}, group = {}) {
  return {
    id: Number(account?.id) || null,
    name: normalizeString(account?.name),
    email: getAccountEmail(account),
    status: normalizeString(account?.status),
    groupNames: getAccountGroupNames(account),
    proxyId: Number(account?.proxy_id) || null,
    errorMessage: normalizeString(account?.error_message || account?.temp_unschedulable_reason),
    matchedGroupId: Number(group?.id) || null,
    matchedGroupName: normalizeString(group?.name),
  };
}

function normalizeStatuses(values = DEFAULT_STATUSES) {
  const source = Array.isArray(values) && values.length ? values : DEFAULT_STATUSES;
  return [...new Set(source.map((value) => normalizeString(value).toLowerCase()).filter(Boolean))];
}

function findGroupByName(groups = [], groupName = '') {
  const expectedName = normalizeGroupKey(groupName);
  return (Array.isArray(groups) ? groups : []).find(
    (group) => normalizeGroupKey(group?.name) === expectedName
  ) || null;
}

function listGroupNames(groups = []) {
  return [...new Set(
    (Array.isArray(groups) ? groups : [])
      .map((group) => normalizeString(group?.name))
      .filter(Boolean)
  )].slice(0, 20);
}

export function createSub2ApiClient({ fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl must be a function.');
  }

  async function requestJson(origin, path, options = {}) {
    const controller = new AbortController();
    const effectiveTimeout = Math.max(1_000, Number(options.timeoutMs || timeoutMs) || timeoutMs);
    const timeout = setTimeout(() => controller.abort(), effectiveTimeout);

    try {
      let response;
      try {
        response = await fetchImpl(`${origin}${path}`, {
          method: options.method || 'GET',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
        });
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw createRequestError(`SUB2API 请求超时：${path}`, 504);
        }
        throw createRequestError(`SUB2API 网络请求失败：${path}`, 502);
      }

      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }

      if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'code')) {
        if (Number(payload.code) === 0) {
          return payload.data;
        }
        throw createRequestError(getErrorMessage(payload, response.status, path), response.status);
      }

      if (!response.ok) {
        throw createRequestError(getErrorMessage(payload, response.status, path), response.status);
      }

      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function login(connection = {}) {
    const email = normalizeEmail(connection.email);
    const password = String(connection.password || '');
    const origin = normalizeBaseUrl(connection.baseUrl);

    if (!email) {
      throw createRequestError('请填写有效的管理员邮箱。', 400);
    }
    if (!password) {
      throw createRequestError('请填写管理员密码。', 400);
    }

    const data = await requestJson(origin, '/api/v1/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    const token = normalizeString(data?.access_token || data?.accessToken);
    if (!token) {
      throw createRequestError('SUB2API 登录未返回 access token。', 502);
    }

    return { origin, token };
  }

  async function loadGroups(origin, token, query = '') {
    const payload = await requestJson(origin, `/api/v1/admin/groups/all${query}`, { token });
    return extractListFromPayload(payload);
  }

  async function getGroup(origin, token, groupName) {
    const requestedName = normalizeString(groupName);
    if (!requestedName) {
      throw createRequestError('请填写分组名称。', 400);
    }

    const filteredGroups = await loadGroups(origin, token, '?platform=openai');
    let group = findGroupByName(filteredGroups, requestedName);
    let availableGroups = filteredGroups;

    if (!group) {
      const allGroups = await loadGroups(origin, token);
      group = findGroupByName(allGroups, requestedName);
      availableGroups = allGroups.length ? allGroups : filteredGroups;
    }

    if (!group) {
      const names = listGroupNames(availableGroups);
      const suffix = names.length ? ` 当前接口返回：${names.join('、')}。` : '';
      throw createRequestError(`未找到分组“${requestedName}”。${suffix}`, 404);
    }

    const groupId = Number(group.id);
    if (!Number.isSafeInteger(groupId) || groupId <= 0) {
      throw createRequestError(`分组“${normalizeString(group.name) || requestedName}”缺少有效 ID。`, 502);
    }

    return { id: groupId, name: normalizeString(group.name) };
  }

  async function listAccountsPage(origin, token, params = {}) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        search.set(key, String(value));
      }
    }

    const payload = await requestJson(origin, `/api/v1/admin/accounts?${search.toString()}`, { token });
    return {
      items: extractListFromPayload(payload),
      total: extractTotalFromPayload(payload),
    };
  }

  async function queryReauthCandidates(connection = {}, options = {}) {
    const statuses = normalizeStatuses(options.statuses);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(options.pageSize) || DEFAULT_PAGE_SIZE));
    const maxPages = Math.max(1, Number(options.maxPages) || DEFAULT_MAX_PAGES);
    const { origin, token } = await login(connection);
    const group = await getGroup(origin, token, connection.groupName);
    const candidates = [];

    for (const status of statuses) {
      for (let page = 1; page <= maxPages; page += 1) {
        const { items, total } = await listAccountsPage(origin, token, {
          platform: 'openai',
          type: 'oauth',
          status,
          page,
          page_size: pageSize,
        });

        for (const account of items) {
          const accountStatus = normalizeString(account?.status).toLowerCase();
          if (
            isOpenAiOAuthAccount(account)
            && statuses.includes(accountStatus)
            && accountBelongsToGroup(account, group)
            && getAccountEmail(account)
          ) {
            candidates.push(normalizeCandidate(account, group));
          }
        }

        if (!items.length || items.length < pageSize || (total && page * pageSize >= total)) {
          break;
        }
      }
    }

    return {
      group,
      statuses,
      accounts: candidates,
    };
  }

  /**
   * FlowPilot 对应 prepareFirstOpenAiAccountReauth 的“生成链接”部分。
   * 候选账号已经由侧边栏上一次查询选出，因此这里不重新扫描分组。
   */
  async function prepareReauthForAccount(connection = {}, account = {}) {
    const accountId = normalizeOptionalPositiveId(account.id);
    const email = getAccountEmail(account);
    if (!accountId || !email) {
      throw createRequestError('请选择一个带有效 ID 和邮箱的 OpenAI OAuth 账号。', 400);
    }

    const { origin, token } = await login(connection);
    const proxyId = normalizeOptionalPositiveId(account.proxyId ?? account.proxy_id);
    const requestBody = {
      redirect_uri: DEFAULT_REAUTH_REDIRECT_URI,
      account_id: accountId,
    };
    if (proxyId) requestBody.proxy_id = proxyId;

    const data = await requestJson(origin, '/api/v1/admin/openai/generate-auth-url', {
      method: 'POST',
      token,
      body: requestBody,
    });
    const oauthUrl = normalizeOAuthUrl(data?.auth_url || data?.authUrl);
    const sessionId = normalizeString(data?.session_id || data?.sessionId);
    if (!sessionId) {
      throw createRequestError('SUB2API 未返回重授权 session_id。', 502);
    }

    return {
      oauthUrl,
      sessionId,
      oauthState: normalizeString(data?.state || extractOAuthState(oauthUrl)),
      redirectUri: DEFAULT_REAUTH_REDIRECT_URI,
      account: {
        id: accountId,
        email,
        proxyId,
      },
    };
  }

  /**
   * FlowPilot 对应 submitOpenAiAccountReauthCallback。
   * 仅在用户明确点击第 10 步时交换 code、更新原账号并清除错误状态。
   */
  async function submitReauthCallback(connection = {}, reauthContext = {}, localhostUrl = '') {
    const callback = parseReauthCallback(localhostUrl);
    const accountId = normalizeOptionalPositiveId(reauthContext?.account?.id);
    const sessionId = normalizeString(reauthContext?.sessionId);
    const expectedState = normalizeString(reauthContext?.oauthState);
    const redirectUri = normalizeString(reauthContext?.redirectUri || DEFAULT_REAUTH_REDIRECT_URI);
    const proxyId = normalizeOptionalPositiveId(reauthContext?.account?.proxyId);

    if (!accountId) {
      throw createRequestError('缺少待重授权的 SUB2API 账号 ID，请重新执行第 0 步。', 400);
    }
    if (!sessionId) {
      throw createRequestError('缺少重授权 session_id，请重新执行第 0 步。', 400);
    }
    if (expectedState && callback.state !== expectedState) {
      throw createRequestError('回调 state 与第 0 步生成的 OAuth state 不一致，请重新开始。', 400);
    }

    const { origin, token } = await login(connection);
    const account = await requestJson(origin, `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`, { token });
    if (!isOpenAiOAuthAccount(account)) {
      throw createRequestError(`SUB2API 账号 #${accountId} 不是 OpenAI OAuth 账号。`, 400);
    }

    const exchangeBody = {
      session_id: sessionId,
      code: callback.code,
      state: callback.state,
      redirect_uri: redirectUri,
    };
    if (proxyId) exchangeBody.proxy_id = proxyId;

    const exchangeData = await requestJson(origin, '/api/v1/admin/openai/exchange-code', {
      method: 'POST',
      token,
      body: exchangeBody,
    });
    const credentials = mergeOpenAiOAuthCredentials(account.credentials, exchangeData);
    const extra = buildReauthExtra(account.extra, exchangeData);
    const payload = buildAccountUpdatePayload(account, credentials, extra);
    await requestJson(origin, `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`, {
      method: 'PUT',
      token,
      body: payload,
    });

    // 与 FlowPilot 一致：令牌更新成功后尽力清除旧错误；清除失败不回滚更新。
    await requestJson(origin, `/api/v1/admin/accounts/${encodeURIComponent(accountId)}/clear-error`, {
      method: 'POST',
      token,
      body: {},
    }).catch(() => {});

    // SUB2API 的错误状态和可调度开关是独立字段。重授权成功后显式恢复调度，
    // 但不绕过限流或过载冷却这类运行时保护。
    await requestJson(origin, `/api/v1/admin/accounts/${encodeURIComponent(accountId)}/schedulable`, {
      method: 'POST',
      token,
      body: { schedulable: true },
    });

    const email = getAccountEmail({ ...account, credentials });
    return {
      localhostUrl: callback.url,
      accountId,
      email,
      status: `SUB2API 已重授权账号 #${accountId}${email ? `（${email}）` : ''}，已恢复调度。`,
    };
  }

  return {
    prepareReauthForAccount,
    queryReauthCandidates,
    submitReauthCallback,
  };
}
