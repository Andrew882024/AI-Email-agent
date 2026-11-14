// The extension shows up only on Gmail: its toolbar button and side panel are enabled per tab,
// for mail.google.com tabs, and clicking the button opens the panel. Chrome closes a tab's panel
// when the user switches to a tab where it's disabled. No imports: Chrome loads this file alone.

const GMAIL = 'https://mail.google.com/';
const PANEL = 'sidepanel.html';

/** Only Gmail tabs' URLs are readable (host permission), so any other tab has none here. */
const isGmail = (url: string | undefined) => !!url?.startsWith(GMAIL);

async function update(tabId: number, url: string | undefined) {
  const enabled = isGmail(url);
  await chrome.sidePanel.setOptions({ tabId, path: PANEL, enabled });
  await (enabled ? chrome.action.enable(tabId) : chrome.action.disable(tabId));
}

async function setup() {
  await chrome.action.disable(); // every tab, unless update() enables it
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => (tab.id ? update(tab.id, tab.url) : undefined)));
}

chrome.runtime.onInstalled.addListener(() => void setup());
chrome.runtime.onStartup.addListener(() => void setup());

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url !== undefined || change.status === 'loading') void update(tabId, tab.url);
});
