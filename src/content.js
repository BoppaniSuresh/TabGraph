// content.js — page lifecycle signals for dynamic tabs.
// Extraction still happens in background.js via executeScript; this file only
// reports meaningful URL/title/text-signature changes.

let lastUrl = location.href;
let lastTitle = document.title;
let lastSignature = '';
let changeTimer = null;

function getTextSignature() {
  const text = (document.body?.innerText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);

  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

function send(type) {
  chrome.runtime.sendMessage({
    type,
    url: location.href,
    title: document.title,
    signature: lastSignature,
  }).catch(() => {});
}

function checkForChange() {
  const url = location.href;
  const title = document.title;
  const signature = getTextSignature();

  const changed = url !== lastUrl || title !== lastTitle || signature !== lastSignature;
  if (!changed) return;

  lastUrl = url;
  lastTitle = title;
  lastSignature = signature;
  send('PAGE_CHANGED');
}

function scheduleCheck() {
  if (changeTimer) return;
  changeTimer = setTimeout(() => {
    changeTimer = null;
    checkForChange();
  }, 3000);
}

function patchHistoryMethod(name) {
  const original = history[name];
  history[name] = function patchedHistoryMethod(...args) {
    const result = original.apply(this, args);
    scheduleCheck();
    return result;
  };
}

lastSignature = getTextSignature();
send('PAGE_READY');

patchHistoryMethod('pushState');
patchHistoryMethod('replaceState');
window.addEventListener('popstate', scheduleCheck);

new MutationObserver(scheduleCheck).observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true,
});

setInterval(checkForChange, 15000);
