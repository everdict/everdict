// Panel behaviour: menu -> remote view -> start -> show the session id the worker issued.

const $ = (selector) => document.querySelector(selector);

const menuButton = $("[data-testid='menu-button']");
const menu = $("[data-testid='menu']");
const remoteLink = $("[data-testid='remote-view-link']");
const remoteView = $("[data-testid='remote-view']");
const startButton = $("[data-testid='remote-start-button']");
const sessionBox = $("[data-testid='session']");
const sessionCode = sessionBox.querySelector("code");
const errorBox = $("[data-testid='error']");

menuButton.addEventListener("click", () => {
  menu.hidden = !menu.hidden;
});

remoteLink.addEventListener("click", (event) => {
  event.preventDefault();
  remoteView.hidden = false;
});

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "start-remote" });
    if (!response?.ok) throw new Error(response?.error ?? "no response from the service worker");
    // The attribute is set before the panel is otherwise touched: the server waits for this element,
    // and it may read it the instant the work tab appears.
    sessionCode.setAttribute("data-session-id", response.sessionId);
    sessionCode.textContent = response.sessionId;
    sessionBox.hidden = false;
  } catch (error) {
    errorBox.textContent = String(error);
    errorBox.hidden = false;
    startButton.disabled = false;
  }
});
