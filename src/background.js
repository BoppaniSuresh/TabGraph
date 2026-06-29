// background.js — service worker
// Manages tab lifecycle, triggers content extraction,
// computes embeddings + edges, and maintains graph state.

import { getEmbedding, getClusterName } from './api.js';
import { computeEdges, computeEdgesForTab, detectCommunities } from './graph.js';

// In-memory graph state (persisted to chrome.storage.local)
let tabData = {};   // tabId -> { id, title, url, domain, text, embedding, cluster, ts, contentHash, lastIndexedAt }
let edges = [];     // [{ a, b, weight }]
let clusterNames = {};      // clusterId -> display name from GPT
let clusterNameCache = {};  // memberHash -> name (avoids re-fetching unchanged clusters)

const indexingTabs = new Set();
const pendingTimers = new Map();
const REINDEX_COOLDOWN_MS = 45000;

// Config loaded from chrome.storage (mirrors options page settings)
let cfg = { threshold: 0.45, alpha: 0.75, textLimit: 6000 };

async function loadConfig() {
  const s = await chrome.storage.local.get(['cfgThreshold', 'cfgAlpha', 'cfgTextLimit']);
  cfg = {
    threshold: s.cfgThreshold != null ? s.cfgThreshold / 100 : 0.45,
    alpha:     s.cfgAlpha     != null ? s.cfgAlpha / 100     : 0.75,
    textLimit: s.cfgTextLimit != null ? s.cfgTextLimit        : 6000,
  };
}

function isIndexableTab(tab) {
  return !!tab?.id && /^https?:\/\//.test(tab.url || '');
}

function hashText(value = '') {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  await loadConfig();
  await loadState();
  await syncPull();
  chrome.sidePanel.setOptions({ enabled: true });
  indexOpenTabs({ force: false });
});

chrome.runtime.onStartup.addListener(async () => {
  await loadConfig();
  await loadState();
  await syncPull();
  indexOpenTabs({ force: false });
});

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
  indexOpenTabs({ force: false });
});

// Tab created / updated
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!isIndexableTab({ ...tab, id: tabId })) return;
  await extractAndEmbed(tabId, tab, { force: true });
});

// Tab removed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (!tabData[tabId]) return;
  if (tabData[tabId].pinned) {
    // Keep pinned tabs in the graph; mark them offline so the UI can show them differently
    tabData[tabId].offline = true;
    tabData[tabId].id = tabId;  // preserve id for edge lookups
  } else {
    delete tabData[tabId];
  }
  await rebuildEdges();
  await persistState();
  broadcastUpdate();
  refreshClusterNames(Object.values(tabData)).then(() => {
    broadcastUpdate();
    persistState();
  }).catch(() => {});
});

// Tab activated (switch) — ensure it's extracted
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!isIndexableTab(tab)) return;
  if (!tabData[tabId]) await extractAndEmbed(tabId, tab, { force: true });
});

// ─── Extraction + Embedding ───────────────────────────────────────────────────

async function extractAndEmbed(tabId, tab, { force = false } = {}) {
  if (!isIndexableTab({ ...tab, id: tabId }) || indexingTabs.has(tabId)) return;

  try {
    indexingTabs.add(tabId);

    // Inject content script to get page text
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPageContent,
    });

    const content = results?.[0]?.result;
    if (!content?.text) return;

    const { text, entities } = content;
    const domain = new URL(tab.url).hostname.replace('www.', '');
    const contentHash = hashText(`${tab.url}\n${tab.title || ''}\n${text.slice(0, 3000)}`);
    const existing = tabData[tabId];
    if (!force && existing?.embedding && existing.contentHash === contentHash) return;

    // Get embedding from OpenAI (use configured text limit)
    const embedding = await getEmbedding(text.slice(0, cfg.textLimit));
    if (!embedding) return;

    tabData[tabId] = {
      id: tabId,
      title: tab.title || domain,
      url: tab.url,
      windowId: tab.windowId,
      domain,
      text: text.slice(0, 3000),   // store truncated for summary use
      entities,
      embedding,
      cluster: existing?.cluster ?? -1,
      contentHash,
      lastIndexedAt: Date.now(),
      ts: Date.now(),
    };

    // Persist to long-term knowledge base
    kbUpsert(tabData[tabId]);

    // Incremental edge recompute: only recalculate edges for this tab
    await rebuildEdges(tabId);
    await persistState();
    broadcastUpdate();

    // Refresh cluster names in background; re-broadcast when ready
    // Cache ensures unchanged clusters resolve instantly without API calls
    refreshClusterNames(Object.values(tabData)).then(() => {
      broadcastUpdate();
      persistState();
      maybeSnapshot();
    }).catch(() => {});

  } catch (err) {
    console.warn('[TabGraph] extract failed for tab', tabId, err.message);
  } finally {
    indexingTabs.delete(tabId);
  }
}

async function scheduleTabIndex(tabId, { urlChanged = false } = {}) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!isIndexableTab(tab)) return;

  const existing = tabData[tabId];
  const elapsed = Date.now() - (existing?.lastIndexedAt || 0);
  const shouldRunNow = urlChanged || !existing || elapsed >= REINDEX_COOLDOWN_MS;

  if (shouldRunNow) {
    if (pendingTimers.has(tabId)) {
      clearTimeout(pendingTimers.get(tabId));
      pendingTimers.delete(tabId);
    }
    await extractAndEmbed(tabId, tab, { force: urlChanged });
    return;
  }

  if (pendingTimers.has(tabId)) return;
  const delay = REINDEX_COOLDOWN_MS - elapsed;
  const timer = setTimeout(async () => {
    pendingTimers.delete(tabId);
    const latest = await chrome.tabs.get(tabId).catch(() => null);
    if (isIndexableTab(latest)) await extractAndEmbed(tabId, latest);
  }, delay);
  pendingTimers.set(tabId, timer);
}

async function indexOpenTabs({ force = false } = {}) {
  const tabs = await chrome.tabs.query({});
  const indexableTabs = tabs.filter(isIndexableTab);

  for (const tab of indexableTabs) {
    await extractAndEmbed(tab.id, tab, { force });
  }

  return indexableTabs.length;
}

// Runs inside the page (no closure access — must be self-contained)
function extractPageContent() {
  // Remove script/style nodes
  const clone = document.cloneNode(true);
  clone.querySelectorAll('script, style, noscript, nav, footer, header, aside').forEach(el => el.remove());

  const text = (clone.body?.innerText || document.body?.innerText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12000);  // 12000 covers the max configurable textLimit

  // Extract simple entities: capitalised phrases, domains in links
  const entitySet = new Set();
  document.querySelectorAll('a[href]').forEach(a => {
    try {
      const h = new URL(a.href).hostname.replace('www.', '');
      if (h && h !== location.hostname.replace('www.', '')) entitySet.add(h);
    } catch {}
  });

  // Capitalised word sequences (rough NER)
  const matches = text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4})\b/g);
  for (const m of matches) {
    if (m[1].length > 4 && m[1].length < 60) entitySet.add(m[1]);
  }

  return { text, entities: [...entitySet].slice(0, 60) };
}

// ─── Graph computation ────────────────────────────────────────────────────────

async function rebuildEdges(updatedTabId = null) {
  const tabs = Object.values(tabData);
  if (tabs.length < 2) { edges = []; return; }

  if (updatedTabId !== null && edges.length > 0) {
    // Incremental: only recompute edges involving the updated tab (O(n) not O(n²))
    edges = edges.filter(e => e.a !== updatedTabId && e.b !== updatedTabId);
    const updated = tabData[updatedTabId];
    if (updated?.embedding) {
      const others = tabs.filter(t => t.id !== updatedTabId && t.embedding);
      edges = [...edges, ...computeEdgesForTab(updated, others, cfg.threshold, cfg.alpha)];
    }
  } else {
    // Full recompute (on load, tab removal, or config change)
    edges = computeEdges(tabs, cfg.threshold, cfg.alpha);
  }

  assignClusters(tabs, edges);
}

function assignClusters(tabs, edgeList) {
  // Run full Louvain on tabs that don't have a manual override
  const freeTabs = tabs.filter(t => !t.clusterOverride);
  const community = detectCommunities(freeTabs, edgeList);
  freeTabs.forEach(t => {
    if (community[t.id] !== undefined) t.cluster = community[t.id];
  });
}

// ─── Persistent knowledge base ────────────────────────────────────────────────
// Stores a compact record of previously-visited pages (URL, title, domain,
// embedding, entities) so they contribute to the graph on future sessions.
// Capped at 500 entries (LRU by lastSeen).

const KB_MAX = 500;

async function kbUpsert(tab) {
  if (!tab?.url || !tab.embedding) return;
  const saved = await chrome.storage.local.get(['knowledgeBase']);
  const kb = saved.knowledgeBase || {};
  kb[tab.url] = {
    url: tab.url, title: tab.title, domain: tab.domain,
    embedding: tab.embedding, entities: tab.entities || [],
    lastSeen: Date.now(), visits: (kb[tab.url]?.visits || 0) + 1,
  };
  // Evict oldest entries if over cap
  const entries = Object.values(kb).sort((a, b) => b.lastSeen - a.lastSeen);
  const trimmed = {};
  entries.slice(0, KB_MAX).forEach(e => { trimmed[e.url] = e; });
  await chrome.storage.local.set({ knowledgeBase: trimmed });
}

async function kbSearch(embedding, topN = 5) {
  const saved = await chrome.storage.local.get(['knowledgeBase']);
  const kb = saved.knowledgeBase || {};
  const openUrls = new Set(Object.values(tabData).map(t => t.url));

  return Object.values(kb)
    .filter(e => !openUrls.has(e.url) && e.embedding)
    .map(e => {
      // Inline cosine sim to avoid cross-module import in this context
      let dot = 0, nA = 0, nB = 0;
      for (let i = 0; i < embedding.length; i++) {
        dot += embedding[i] * e.embedding[i];
        nA  += embedding[i] * embedding[i];
        nB  += e.embedding[i] * e.embedding[i];
      }
      const sim = Math.sqrt(nA) * Math.sqrt(nB) === 0 ? 0 : dot / (Math.sqrt(nA) * Math.sqrt(nB));
      return { ...e, similarity: parseFloat(sim.toFixed(4)) };
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topN);
}

// ─── Session history ──────────────────────────────────────────────────────────
// Saves a lightweight snapshot whenever the graph changes significantly.
// Keeps the 20 most recent sessions; each entry is ~2KB (no embeddings).

const MAX_SESSIONS = 20;
let lastSnapshotHash = '';

async function maybeSnapshot() {
  const tabs = Object.values(tabData);
  if (tabs.length < 2) return;

  // Cheap fingerprint: sorted tab URLs
  const hash = tabs.map(t => t.url).sort().join('|');
  if (hash === lastSnapshotHash) return;
  lastSnapshotHash = hash;

  const snapshot = {
    ts: Date.now(),
    nodes: tabs.map(t => ({ id: t.id, title: t.title, url: t.url, domain: t.domain, cluster: t.cluster })),
    edges: edges.map(e => ({ a: e.a, b: e.b, weight: e.weight })),
    clusterNames: { ...clusterNames },
  };

  const saved = await chrome.storage.local.get(['sessions']);
  const sessions = (saved.sessions || []).slice(0, MAX_SESSIONS - 1);
  sessions.unshift(snapshot);
  await chrome.storage.local.set({ sessions });
}

// ─── Cluster naming ───────────────────────────────────────────────────────────

async function refreshClusterNames(tabs) {
  // Group tabs by cluster id
  const groups = {};
  tabs.forEach(t => {
    if (!groups[t.cluster]) groups[t.cluster] = [];
    groups[t.cluster].push(t);
  });

  const updates = {};
  await Promise.all(
    Object.entries(groups).map(async ([clusterId, members]) => {
      // Key by sorted member ids so unchanged clusters reuse the cached name
      const hash = members.map(m => m.id).sort().join(',');
      if (clusterNameCache[hash]) {
        updates[clusterId] = clusterNameCache[hash];
        return;
      }
      const name = await getClusterName(members);
      if (name) {
        const trimmed = name.trim();
        clusterNameCache[hash] = trimmed;
        updates[clusterId] = trimmed;
      }
    })
  );

  if (Object.keys(updates).length) {
    clusterNames = { ...clusterNames, ...updates };
  }
}

// ─── Cross-device sync ────────────────────────────────────────────────────────
// Syncs lightweight user data (notes, pin list, manual cluster overrides, API key)
// via chrome.storage.sync so they survive across devices and reinstalls.
// Heavy data (embeddings, full tabData) stays in storage.local only.

async function syncPush() {
  const notes    = (await chrome.storage.local.get(['notes'])).notes || {};
  const pinnedUrls = Object.values(tabData).filter(t => t.pinned).map(t => t.url);
  const overrides = {};
  Object.values(tabData).filter(t => t.clusterOverride).forEach(t => {
    overrides[t.url] = t.cluster;
  });
  await chrome.storage.sync.set({ notes, pinnedUrls, clusterOverrides: overrides }).catch(() => {});
}

async function syncPull() {
  const synced = await chrome.storage.sync.get(['notes', 'pinnedUrls', 'clusterOverrides', 'openaiKey']).catch(() => ({}));
  if (synced.notes) await chrome.storage.local.set({ notes: synced.notes });
  if (synced.openaiKey) await chrome.storage.local.set({ openaiKey: synced.openaiKey });

  // Apply pinned + override state to current tabData
  const pinnedSet = new Set(synced.pinnedUrls || []);
  const overrides = synced.clusterOverrides || {};
  Object.values(tabData).forEach(t => {
    if (pinnedSet.has(t.url)) t.pinned = true;
    if (overrides[t.url] !== undefined) { t.cluster = overrides[t.url]; t.clusterOverride = true; }
  });
}

// Push after any user action that modifies syncable data
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.notes || changes.tabData)) {
    syncPush().catch(() => {});
  }
});

// ─── State persistence ────────────────────────────────────────────────────────

async function persistState() {
  const slim = {};
  const embeddings = {};
  Object.entries(tabData).forEach(([id, t]) => {
    slim[id] = { ...t, embedding: null };
    if (t.embedding) embeddings[id] = t.embedding;
  });
  // Embeddings stored separately so tabData stays compact
  await chrome.storage.local.set({
    tabData: slim, edges, embeddings,
    clusterNames, clusterNameCache,
    lastSaved: Date.now(),
  });
}

async function loadState() {
  const saved = await chrome.storage.local.get(['tabData', 'edges', 'embeddings', 'clusterNames', 'clusterNameCache']);
  if (saved.tabData) {
    tabData = saved.tabData;
    // Restore embeddings so startup doesn't re-fetch from OpenAI
    if (saved.embeddings) {
      Object.entries(saved.embeddings).forEach(([id, emb]) => {
        if (tabData[id]) tabData[id].embedding = emb;
      });
    }
  }
  if (saved.edges)            edges            = saved.edges;
  if (saved.clusterNames)     clusterNames     = saved.clusterNames;
  if (saved.clusterNameCache) clusterNameCache = saved.clusterNameCache;
}

// ─── Message passing ──────────────────────────────────────────────────────────

function broadcastUpdate() {
  chrome.runtime.sendMessage({
    type: 'GRAPH_UPDATE',
    payload: getGraphPayload(),
  }).catch(() => {});   // sidepanel may not be open
}

function getGraphPayload() {
  return {
    nodes: Object.values(tabData).map(t => ({
      id: t.id, title: t.title, url: t.url, domain: t.domain,
      windowId: t.windowId, cluster: t.cluster, ts: t.ts,
      pinned: !!t.pinned, offline: !!t.offline,
    })),
    edges,
    clusterNames,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_GRAPH') {
    sendResponse({ ok: true, payload: getGraphPayload() });
    indexOpenTabs({ force: false });
    return true;
  }

  if (msg.type === 'GET_TAB_DETAIL') {
    const tab = tabData[msg.tabId];
    sendResponse({ ok: !!tab, tab });
    return true;
  }

  if (msg.type === 'PAGE_READY') {
    const tab = sender.tab;
    if (isIndexableTab(tab)) {
      const existing = tabData[tab.id];
      scheduleTabIndex(tab.id, { urlChanged: !!existing && existing.url !== tab.url });
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'PAGE_CHANGED') {
    const tab = sender.tab;
    if (isIndexableTab(tab)) {
      const existing = tabData[tab.id];
      scheduleTabIndex(tab.id, { urlChanged: !!existing && existing.url !== msg.url });
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'LOAD_BOOKMARKS') {
    chrome.bookmarks.getRecent(50, async bookmarks => {
      const openUrls = new Set(Object.values(tabData).map(t => t.url));
      let added = 0;
      for (const bm of bookmarks) {
        if (!bm.url || openUrls.has(bm.url)) continue;
        try {
          const url  = new URL(bm.url);
          const domain = url.hostname.replace('www.', '');
          const text = bm.title || domain;
          const embedding = await getEmbedding(text);
          if (!embedding) continue;
          const fakeId = `bm_${bm.id}`;
          tabData[fakeId] = {
            id: fakeId, title: bm.title || domain, url: bm.url,
            domain, text, entities: [], embedding,
            cluster: -1, bookmarkNode: true, ts: bm.dateAdded || Date.now(),
            contentHash: '', lastIndexedAt: Date.now(),
          };
          added++;
        } catch {}
      }
      if (added > 0) {
        await rebuildEdges();
        await persistState();
        broadcastUpdate();
      }
      sendResponse({ ok: true, added });
    });
    return true;
  }

  if (msg.type === 'CLEAR_BOOKMARKS') {
    (async () => {
      Object.keys(tabData).filter(id => tabData[id]?.bookmarkNode).forEach(id => delete tabData[id]);
      await rebuildEdges();
      await persistState();
      broadcastUpdate();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'NL_QUERY') {
    getEmbedding(msg.query).then(queryEmb => {
      if (!queryEmb) { sendResponse({ ok: false, matches: [] }); return; }
      const tabs = Object.values(tabData).filter(t => t.embedding);
      const scored = tabs.map(t => {
        let dot = 0, nA = 0, nB = 0;
        for (let i = 0; i < queryEmb.length; i++) {
          dot += queryEmb[i] * t.embedding[i];
          nA  += queryEmb[i] * queryEmb[i];
          nB  += t.embedding[i] * t.embedding[i];
        }
        const sim = Math.sqrt(nA) * Math.sqrt(nB) === 0 ? 0 : dot / (Math.sqrt(nA) * Math.sqrt(nB));
        return { id: t.id, similarity: parseFloat(sim.toFixed(4)) };
      }).sort((a, b) => b.similarity - a.similarity);
      sendResponse({ ok: true, matches: scored });
    });
    return true;
  }

  if (msg.type === 'KB_SEARCH') {
    const tab = tabData[msg.tabId];
    if (!tab?.embedding) { sendResponse({ ok: false, results: [] }); return true; }
    kbSearch(tab.embedding, 5).then(results => sendResponse({ ok: true, results }));
    return true;
  }

  if (msg.type === 'SET_CLUSTER') {
    const t = tabData[msg.tabId];
    if (t) {
      t.cluster = msg.cluster;
      t.clusterOverride = true;
      (async () => {
        await persistState();
        broadcastUpdate();
        syncPush().catch(() => {});
        sendResponse({ ok: true });
      })();
    } else {
      sendResponse({ ok: false });
    }
    return true;
  }

  if (msg.type === 'GET_RECOMMENDATIONS') {
    const tab = tabData[msg.tabId];
    if (!tab) { sendResponse({ ok: false, items: [] }); return true; }

    // Pull recent history (last 7 days, up to 200 items)
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    chrome.history.search({ text: '', startTime: cutoff, maxResults: 200 }, histItems => {
      const openUrls = new Set(Object.values(tabData).map(t => t.url));
      const entities = new Set((tab.entities || []).map(e => e.toLowerCase()));
      const domain   = tab.domain.toLowerCase();

      const scored = histItems
        .filter(h => h.url && !openUrls.has(h.url))  // exclude already-open tabs
        .map(h => {
          const text  = `${h.title || ''} ${h.url}`.toLowerCase();
          const hits  = [...entities].filter(e => text.includes(e)).length;
          const sameDomain = h.url.includes(domain) ? 0.3 : 0;
          const score = hits / Math.max(entities.size, 1) + sameDomain;
          return { url: h.url, title: h.title || h.url, score, visitCount: h.visitCount };
        })
        .filter(h => h.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      sendResponse({ ok: true, items: scored });
    });
    return true;
  }

  if (msg.type === 'GET_SESSIONS') {
    chrome.storage.local.get(['sessions']).then(s =>
      sendResponse({ ok: true, sessions: s.sessions || [] })
    );
    return true;
  }

  if (msg.type === 'TOGGLE_PIN') {
    const t = tabData[msg.tabId];
    if (t) {
      t.pinned = !t.pinned;
      if (!t.pinned) t.offline = false;
      (async () => {
        await persistState();
        broadcastUpdate();
        syncPush().catch(() => {});
        sendResponse({ ok: true, pinned: t.pinned });
      })();
    } else {
      sendResponse({ ok: false });
    }
    return true;
  }

  if (msg.type === 'REBUILD') {
    // Reload config then re-index so fresh settings are applied
    loadConfig().then(() =>
      indexOpenTabs({ force: true }).then(count => sendResponse({ ok: true, count }))
    );
    return true;
  }
});
