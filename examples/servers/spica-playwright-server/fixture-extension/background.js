// Service worker. Two jobs: mint the session id and open the work tab.
//
// The session id is deliberately issued HERE rather than in the panel, because that is where the real
// extension issues it — the panel only displays what the worker decided. It is also what makes the id
// stable across panel reloads, which the server relies on when it reads the panel a moment after the
// tab opens.

const SESSION_KEY = "spica_session_id";

async function currentSessionId() {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  if (stored[SESSION_KEY]) return stored[SESSION_KEY];
  const sessionId = `spica-${crypto.randomUUID()}`;
  await chrome.storage.session.set({ [SESSION_KEY]: sessionId });
  return sessionId;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "start-remote") return false;
  (async () => {
    try {
      const sessionId = await currentSessionId();
      // The work tab is what the agent drives; the panel stays open beside it. Opening a real extension
      // page (not about:blank) keeps this a genuine navigation the automation can wait for.
      const tab = await chrome.tabs.create({ url: chrome.runtime.getURL("work.html"), active: true });
      sendResponse({ ok: true, sessionId, tabId: tab.id });
    } catch (error) {
      sendResponse({ ok: false, error: String(error) });
    }
  })();
  return true; // keep the message channel open for the async response
});
