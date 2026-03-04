// injector.js — runs on claude.ai pages
// Listens for messages from the service worker to assist with DOM automation

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PING") {
    sendResponse({ ok: true });
  }
});
