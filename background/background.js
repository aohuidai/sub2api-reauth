import { createSub2ApiClient } from './sub2api-client.js';

const sub2ApiClient = createSub2ApiClient();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'QUERY_REAUTH_CANDIDATES') {
    return undefined;
  }

  sub2ApiClient.queryReauthCandidates(message.connection || {})
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({
      ok: false,
      error: String(error?.message || '查询失败。'),
    }));

  return true;
});
