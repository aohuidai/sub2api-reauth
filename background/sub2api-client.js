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

  return {
    prepareReauthForAccount,
    queryReauthCandidates,
  };
}
