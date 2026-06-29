// sidepanel.js — graph rendering + detail panel
import { getSummaryAndKeyPoints, getRelatedReasoning, getWebContext } from './api.js';
import { filterEdges } from './graph.js';

const CLUSTER_COLORS = ['#6382ff','#3db885','#e8873a','#c45fd4','#e05c6a','#4abcd4','#f5c842','#a0b060'];
const CLUSTER_NAMES  = ['Research','Work','News','Shopping','Social','Dev','Finance','Health'];

// ── State ─────────────────────────────────────────────────────────────────────
let nodes = [], edges = [], threshold = 0.45, layout = 'force';
let selectedId = null, hoveredId = null, selectedDetailTs = null;
let animId = null;
let alpha = 1;
let detailLoadToken = 0;
let clusterNames = {};  // clusterId -> GPT-generated label (populated async after each rebuild)
let searchQuery    = '';    // active filter string
let windowFilter   = 'all'; // 'all' or a windowId string
let nlMatches      = null;  // null = inactive; Map<tabId, similarity> when active

// ── Canvas ────────────────────────────────────────────────────────────────────
const canvas = document.getElementById('graph-canvas');
const ctx    = canvas.getContext('2d');
let W = 0, H = 0;

function resize() {
  const wrap = document.getElementById('graph-wrap');
  W = wrap.clientWidth;
  H = wrap.clientHeight;
  canvas.width  = W * devicePixelRatio;
  canvas.height = H * devicePixelRatio;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(devicePixelRatio, devicePixelRatio);
}

new ResizeObserver(resize).observe(document.getElementById('graph-wrap'));
resize();

// ── Graph data ────────────────────────────────────────────────────────────────
function applyPayload(payload) {
  if (!payload) return;

  const oldPos = {};
  nodes.forEach(n => oldPos[n.id] = { x: n.x, y: n.y });

  nodes = payload.nodes.map(n => ({
    ...n,
    x: oldPos[n.id]?.x ?? W / 2 + (Math.random() - 0.5) * W * 0.5,
    y: oldPos[n.id]?.y ?? H / 2 + (Math.random() - 0.5) * H * 0.5,
    vx: 0, vy: 0,
    r: 9,
  }));

  edges = payload.edges || [];
  clusterNames = payload.clusterNames || {};
  updateLegend();
  updateWindowFilter();
  updateCounter();
  document.getElementById('empty-state').hidden = nodes.length > 0;

  const selected = nodes.find(n => n.id === selectedId);
  const panelOpen = selected && !document.getElementById('detail-panel').classList.contains('hidden');
  if (panelOpen && selected.ts !== selectedDetailTs) openDetail(selected);

  alpha = 0.8;
}

// ── Window filter ─────────────────────────────────────────────────────────────
function updateWindowFilter() {
  const sel = document.getElementById('window-filter');
  const windows = [...new Set(nodes.map(n => n.windowId).filter(Boolean))];
  const prev = sel.value;
  sel.replaceChildren();
  const all = document.createElement('option');
  all.value = 'all'; all.textContent = `All windows (${windows.length})`;
  sel.append(all);
  windows.forEach((wid, i) => {
    const opt = document.createElement('option');
    opt.value = String(wid);
    opt.textContent = `Window ${i + 1}`;
    sel.append(opt);
  });
  sel.value = windows.map(String).includes(prev) ? prev : 'all';
  windowFilter = sel.value;
}

document.getElementById('window-filter').addEventListener('change', e => {
  windowFilter = e.target.value;
  updateCounter();
});

// Falls back to the static array while GPT names are still loading
function clusterLabel(clusterId) {
  return clusterNames[clusterId] || CLUSTER_NAMES[clusterId % CLUSTER_NAMES.length] || `Cluster ${clusterId}`;
}

function updateCounter() {
  const vis = filterEdges(edges, threshold);
  document.getElementById('tab-counter').textContent =
    `${nodes.length} tabs · ${vis.length} edges`;
}

// ── Force simulation ──────────────────────────────────────────────────────────
function tick() {
  const visEdges = filterEdges(edges, threshold);

  if (layout === 'force') {
    runForce(visEdges);
  } else {
    runCluster();
  }

  draw(visEdges);
  alpha = Math.max(0.005, alpha * 0.97);
  animId = requestAnimationFrame(tick);
}

function runForce(visEdges) {
  const k = Math.sqrt((W * H) / Math.max(nodes.length, 1)) * 1.1;

  // Repulsion
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].vx = 0; nodes[i].vy = 0;
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const dx = nodes[i].x - nodes[j].x;
      const dy = nodes[i].y - nodes[j].y;
      const d  = Math.sqrt(dx * dx + dy * dy) || 1;
      const rep = (k * k) / d * 0.55;
      nodes[i].vx += (dx / d) * rep;
      nodes[i].vy += (dy / d) * rep;
    }
  }

  // Attraction along edges
  visEdges.forEach(({ a, b, weight }) => {
    const na = nodes.find(n => n.id === a);
    const nb = nodes.find(n => n.id === b);
    if (!na || !nb) return;
    const dx = nb.x - na.x, dy = nb.y - na.y;
    const d  = Math.sqrt(dx * dx + dy * dy) || 1;
    const f  = (d - k * 0.9) / d * 0.10 * weight;
    na.vx += dx * f; na.vy += dy * f;
    nb.vx -= dx * f; nb.vy -= dy * f;
  });

  // Gravity to centre
  nodes.forEach(n => {
    n.vx += (W / 2 - n.x) * 0.012;
    n.vy += (H / 2 - n.y) * 0.012;
    n.x += n.vx * alpha;
    n.y += n.vy * alpha;
    n.x = Math.max(n.r + 4, Math.min(W - n.r - 4, n.x));
    n.y = Math.max(n.r + 4, Math.min(H - n.r - 4, n.y));
  });
}

function runCluster() {
  const clusterIds = [...new Set(nodes.map(n => n.cluster))];
  const cols = Math.min(clusterIds.length, 3);
  const rows = Math.ceil(clusterIds.length / cols);

  clusterIds.forEach((c, ci) => {
    const col = ci % cols, row = Math.floor(ci / cols);
    const cx  = W * (col + 0.5) / cols;
    const cy  = H * (row + 0.5) / rows;
    const members = nodes.filter(n => n.cluster === c);
    const r   = Math.min(W / (cols * 2.8), H / (rows * 2.8)) * 0.85;
    members.forEach((n, mi) => {
      const angle = (mi / Math.max(members.length, 1)) * Math.PI * 2;
      const tx = cx + Math.cos(angle) * r * (members.length > 1 ? 1 : 0);
      const ty = cy + Math.sin(angle) * r * (members.length > 1 ? 1 : 0);
      n.x += (tx - n.x) * 0.07;
      n.y += (ty - n.y) * 0.07;
    });
  });
}

// ── Draw ──────────────────────────────────────────────────────────────────────
function draw(visEdges) {
  ctx.clearRect(0, 0, W, H);
  const styles = getComputedStyle(document.documentElement);
  const textPrimary = styles.getPropertyValue('--text-primary').trim() || 'rgba(255,255,255,0.88)';
  const textMuted = styles.getPropertyValue('--text-muted').trim() || 'rgba(255,255,255,0.3)';
  const bg1 = styles.getPropertyValue('--bg1').trim() || '#13151c';
  const border = styles.getPropertyValue('--border-med').trim() || 'rgba(255,255,255,0.12)';
  const lightTheme = document.documentElement.dataset.theme === 'light';

  // Edges
  visEdges.forEach(({ a, b, weight }) => {
    const na = nodes.find(n => n.id === a);
    const nb = nodes.find(n => n.id === b);
    if (!na || !nb) return;
    const sel = selectedId === a || selectedId === b;
    ctx.beginPath();
    ctx.moveTo(na.x, na.y);
    ctx.lineTo(nb.x, nb.y);
    ctx.strokeStyle = sel
      ? `rgba(99,130,255,${0.2 + weight * 0.55})`
      : lightTheme
        ? `rgba(18,25,38,${0.04 + weight * 0.12})`
        : `rgba(255,255,255,${0.03 + weight * 0.08})`;
    ctx.lineWidth = sel ? 1 + weight * 1.5 : 0.5 + weight * 0.7;
    ctx.stroke();
  });

  // Nodes
  nodes.forEach(n => {
    const col = CLUSTER_COLORS[n.cluster % CLUSTER_COLORS.length] || '#888';
    const sel = n.id === selectedId;
    const hover = n.id === hoveredId;
    const matchesSearch = !searchQuery ||
      n.title?.toLowerCase().includes(searchQuery) ||
      n.domain?.toLowerCase().includes(searchQuery);
    const matchesWindow = windowFilter === 'all' || String(n.windowId) === windowFilter;
    const nlScore = nlMatches ? (nlMatches.get(n.id) || 0) : null;
    const dimmed = (searchQuery && !matchesSearch) || (!matchesWindow) ||
                   (nlMatches !== null && nlScore < 0.35);

    if (sel || hover) {
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 7, 0, Math.PI * 2);
      ctx.fillStyle = col + '20'; ctx.fill();
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 4, 0, Math.PI * 2);
      ctx.fillStyle = col + '40'; ctx.fill();
    }

    // NL query: highlight top matches with a white glow ring
    if (nlMatches !== null && nlScore >= 0.5) {
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 6, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,255,255,${0.3 + nlScore * 0.4})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Pinned nodes get a gold dashed ring
    if (n.pinned) {
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 5, 0, Math.PI * 2);
      ctx.setLineDash([3, 2]);
      ctx.strokeStyle = '#f5c842cc';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.globalAlpha = dimmed ? 0.15 : 1;
    ctx.beginPath();
    if (n.bookmarkNode) {
      // Bookmarks drawn as diamonds
      const s = n.r * 1.1;
      ctx.moveTo(n.x, n.y - s); ctx.lineTo(n.x + s, n.y);
      ctx.lineTo(n.x, n.y + s); ctx.lineTo(n.x - s, n.y);
      ctx.closePath();
    } else {
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    }
    ctx.fillStyle = sel || hover ? col : col + 'cc';
    ctx.fill();
    ctx.strokeStyle = sel || hover ? textPrimary : col + '55';
    ctx.lineWidth   = sel || hover ? 1.5 : 0.5;
    ctx.stroke();
    ctx.globalAlpha = 1;

    if (sel && !dimmed) {
      ctx.font = `${Math.round(9 * getFontScale())}px -apple-system, Segoe UI, sans-serif`;
      ctx.fillStyle = textPrimary;
      ctx.textAlign = 'center';
      ctx.fillText(n.domain.slice(0, 20), n.x, n.y + n.r + 10);
    }
  });

  const hovered = nodes.find(n => n.id === hoveredId);
  if (hovered) drawTooltip(hovered, { bg1, border, textPrimary, textMuted });
}

function getFontScale() {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-scale')) || 1;
}

function drawTooltip(node, colors) {
  const title = node.title || node.domain;
  const domain = node.domain || '';
  const scale = getFontScale();
  const titleFont = `${Math.round(11 * scale)}px -apple-system, Segoe UI, sans-serif`;
  const domainFont = `${Math.round(9 * scale)}px -apple-system, Segoe UI, sans-serif`;
  const maxWidth = Math.min(260, W - 24);
  const padding = 8;

  ctx.font = titleFont;
  const titleText = ellipsizeCanvas(title, maxWidth - padding * 2);
  const titleWidth = ctx.measureText(titleText).width;
  ctx.font = domainFont;
  const domainText = ellipsizeCanvas(domain, maxWidth - padding * 2);
  const domainWidth = ctx.measureText(domainText).width;
  const boxWidth = Math.ceil(Math.max(titleWidth, domainWidth) + padding * 2);
  const boxHeight = Math.round(40 * scale);

  let x = node.x + 14;
  let y = node.y - boxHeight - 12;
  if (x + boxWidth > W - 8) x = W - boxWidth - 8;
  if (y < 8) y = node.y + 16;

  ctx.beginPath();
  roundRect(ctx, x, y, boxWidth, boxHeight, 6);
  ctx.fillStyle = colors.bg1;
  ctx.fill();
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.font = titleFont;
  ctx.fillStyle = colors.textPrimary;
  ctx.fillText(titleText, x + padding, y + Math.round(16 * scale));
  ctx.font = domainFont;
  ctx.fillStyle = colors.textMuted;
  ctx.fillText(domainText, x + padding, y + Math.round(31 * scale));
}

function ellipsizeCanvas(text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 3 && ctx.measureText(out + '...').width > maxWidth) {
    out = out.slice(0, -1);
  }
  return out + '...';
}

function roundRect(context, x, y, width, height, radius) {
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
}

// ── Interaction ───────────────────────────────────────────────────────────────
function getPointerPos(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function findHit(x, y) {
  return nodes.find(n => Math.hypot(n.x - x, n.y - y) <= n.r + 5) || null;
}

canvas.addEventListener('click', e => {
  const { x, y } = getPointerPos(e);
  const hit = findHit(x, y);
  if (hit) {
    selectedId = hit.id;
    openDetail(hit);
  } else {
    selectedId = null;
  }
});

canvas.addEventListener('mousemove', e => {
  const { x, y } = getPointerPos(e);
  const hit = findHit(x, y);
  hoveredId = hit?.id ?? null;
  canvas.style.cursor = hit ? 'pointer' : 'default';
});
canvas.addEventListener('mouseleave', () => {
  hoveredId = null;
  canvas.style.cursor = 'default';
});

// Drag support
let dragging = null, dragOx = 0, dragOy = 0;
canvas.addEventListener('mousedown', e => {
  const { x, y } = getPointerPos(e);
  dragging = findHit(x, y);
  if (dragging) { dragOx = x - dragging.x; dragOy = y - dragging.y; }
});
canvas.addEventListener('mousemove', e => {
  if (!dragging) return;
  const { x, y } = getPointerPos(e);
  dragging.x = x - dragOx;
  dragging.y = y - dragOy;
  dragging.vx = 0; dragging.vy = 0;
});
canvas.addEventListener('mouseup', () => { dragging = null; });

// ── Detail panel ──────────────────────────────────────────────────────────────
async function openDetail(node) {
  const token = ++detailLoadToken;
  selectedDetailTs = node.ts;
  const panel = document.getElementById('detail-panel');
  panel.classList.remove('hidden');

  // Header
  document.getElementById('detail-domain').textContent = node.domain;
  document.getElementById('detail-title').textContent  = node.title;

  const favicon = document.getElementById('detail-favicon');
  favicon.replaceChildren();
  const img = document.createElement('img');
  img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(node.domain)}&sz=28`;
  img.alt = '';
  img.addEventListener('error', () => { img.style.display = 'none'; });
  favicon.append(img);

  const col  = CLUSTER_COLORS[node.cluster % CLUSTER_COLORS.length] || '#888';
  const name = clusterLabel(node.cluster);
  const badgeWrap = document.getElementById('detail-cluster-badge');
  badgeWrap.replaceChildren();
  const badge = document.createElement('span');
  badge.className = 'cluster-badge';
  badge.style.background = col + '20';
  badge.style.color = col;
  badge.style.border = `0.5px solid ${col}44`;
  badge.textContent = name;
  badgeWrap.append(badge);

  // Reset content to skeletons
  document.getElementById('summary-content').innerHTML        = skeletonLines(3);
  document.getElementById('kp-content').replaceChildren();
  document.getElementById('related-content').replaceChildren();
  document.getElementById('web-content').innerHTML            = skeletonLines(2);
  document.getElementById('recommendations-content').innerHTML = skeletonLines(2);

  // Load note for this URL immediately (doesn't need API key)
  loadNote(node.url);

  // Footer buttons
  const btnPin = document.getElementById('btn-pin-tab');
  btnPin.textContent = node.pinned ? '📌 Pinned' : 'Pin';
  btnPin.classList.toggle('pinned', !!node.pinned);
  btnPin.onclick = () => {
    chrome.runtime.sendMessage({ type: 'TOGGLE_PIN', tabId: node.id }, res => {
      if (!res?.ok) return;
      node.pinned = res.pinned;
      btnPin.textContent = res.pinned ? '📌 Pinned' : 'Pin';
      btnPin.classList.toggle('pinned', res.pinned);
    });
  };

  document.getElementById('btn-open-tab').onclick  = () => chrome.tabs.create({ url: node.url });
  document.getElementById('btn-focus-tab').onclick = () => {
    chrome.tabs.update(node.id, { active: true });
    chrome.windows.update(node.windowId || chrome.windows.WINDOW_ID_CURRENT, { focused: true });
  };

  // Fetch tab text from background
  const detail = await new Promise(res =>
    chrome.runtime.sendMessage({ type: 'GET_TAB_DETAIL', tabId: node.id }, res)
  );
  const tab = detail?.tab || node;

  // Phase 1: Summary + key points
  const { summary, keyPoints } = await getSummaryAndKeyPoints(tab);
  if (token !== detailLoadToken) return;
  document.getElementById('summary-content').textContent = summary;
  const kpContent = document.getElementById('kp-content');
  kpContent.replaceChildren();
  keyPoints.forEach(point => {
    const item = document.createElement('div');
    item.className = 'kp-item';
    const dot = document.createElement('span');
    dot.className = 'kp-dot';
    dot.textContent = '·';
    item.append(dot, document.createTextNode(point));
    kpContent.append(item);
  });

  // Phase 2: Related tabs
  const relEdges = edges
    .filter(e => (e.a === node.id || e.b === node.id) && e.weight >= threshold)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 5);

  const relNodes = relEdges.map(e => {
    const otherId = e.a === node.id ? e.b : e.a;
    const other   = nodes.find(n => n.id === otherId);
    return other ? { ...other, weight: e.weight } : null;
  }).filter(Boolean);

  let reasons = relNodes.map(() => 'Semantic overlap');
  try {
    reasons = await getRelatedReasoning(tab, relNodes);
  } catch {}
  if (token !== detailLoadToken) return;

  const relatedContent = document.getElementById('related-content');
  relatedContent.replaceChildren();
  if (!relNodes.length) {
    relatedContent.append(createMutedNote('No related tabs above threshold.'));
  }
  relNodes.forEach((rn, i) => {
    const rc  = CLUSTER_COLORS[rn.cluster % CLUSTER_COLORS.length] || '#888';
    const pct = Math.round(rn.weight * 100);
    const item = document.createElement('div');
    item.className = 'related-item';
    const dot = document.createElement('div');
    dot.className = 'rel-dot';
    dot.style.background = rc;
    const body = document.createElement('div');
    body.className = 'rel-body';
    const title = document.createElement('div');
    title.className = 'rel-title';
    title.textContent = rn.title;
    const reason = document.createElement('div');
    reason.className = 'rel-reason';
    reason.textContent = `${reasons[i] || 'Semantic overlap'} · ${pct}%`;
    const track = document.createElement('div');
    track.className = 'rel-bar-track';
    const fill = document.createElement('div');
    fill.className = 'rel-bar-fill';
    fill.style.width = pct + '%';
    fill.style.background = rc + '88';
    track.append(fill);
    body.append(title, reason, track);
    item.append(dot, body);
    item.addEventListener('click', () => {
      const n = nodes.find(candidate => candidate.id === rn.id);
      if (n) { selectedId = rn.id; openDetail(n); }
    });
    relatedContent.append(item);
  });

  // Phase 3: History recommendations + knowledge base search (no API key needed)
  chrome.runtime.sendMessage({ type: 'KB_SEARCH', tabId: node.id }, kbRes => {
    if (token !== detailLoadToken) return;
    const recContent = document.getElementById('recommendations-content');
    // Prepend KB results before history results (already set to skeleton; we'll build the full list)
    const kbItems = kbRes?.results || [];
    if (kbItems.length) {
      const kbLabel = document.createElement('div');
      kbLabel.style.cssText = 'font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted);margin-bottom:4px';
      kbLabel.textContent = 'Semantically similar (past visits)';
      recContent.replaceChildren(kbLabel);
      kbItems.forEach(({ url, title, similarity }) => {
        const item = document.createElement('div');
        item.className = 'rec-item';
        const t = document.createElement('div');
        t.className = 'rec-title'; t.textContent = title; t.title = url;
        const v = document.createElement('div');
        v.className = 'rec-visits'; v.textContent = `${Math.round(similarity * 100)}%`;
        item.append(t, v);
        item.addEventListener('click', () => chrome.tabs.create({ url }));
        recContent.append(item);
      });
    }
  });

  chrome.runtime.sendMessage({ type: 'GET_RECOMMENDATIONS', tabId: node.id }, res => {
    if (token !== detailLoadToken) return;
    const recContent = document.getElementById('recommendations-content');
    recContent.replaceChildren();
    const items = res?.items || [];
    if (!items.length) {
      recContent.append(createMutedNote('No related history found.'));
      return;
    }
    items.forEach(({ url, title, visitCount }) => {
      const item = document.createElement('div');
      item.className = 'rec-item';
      const t = document.createElement('div');
      t.className = 'rec-title';
      t.textContent = title;
      t.title = url;
      const v = document.createElement('div');
      v.className = 'rec-visits';
      v.textContent = `${visitCount}×`;
      item.append(t, v);
      item.addEventListener('click', () => chrome.tabs.create({ url }));
      recContent.append(item);
    });
  });

  // Phase 4: Web context
  const webCtx = await getWebContext(tab);
  if (token !== detailLoadToken) return;
  const webContent = document.getElementById('web-content');
  webContent.replaceChildren();
  if (webCtx) {
    const snippet = document.createElement('div');
    snippet.className = 'web-snippet';
    snippet.textContent = webCtx;
    webContent.append(snippet);
  } else {
    webContent.append(createMutedNote('No web context available.'));
  }
}

function createMutedNote(text) {
  const note = document.createElement('div');
  note.className = 'muted-note';
  note.textContent = text;
  return note;
}

function skeletonLines(n) {
  const ws = ['w80','w95','w70','w90','w60'];
  return `<div class="skeleton-lines">${
    Array.from({ length: n }, (_, i) => `<div class="sk-line ${ws[i % ws.length]}"></div>`).join('')
  }</div>`;
}

document.getElementById('btn-close-detail').addEventListener('click', () => {
  document.getElementById('detail-panel').classList.add('hidden');
  selectedId = null;
  selectedDetailTs = null;
});

// ── Controls ──────────────────────────────────────────────────────────────────
document.querySelectorAll('.seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    layout = btn.dataset.layout;
    alpha  = 0.6;
  });
});

const slider = document.getElementById('threshold-slider');
slider.addEventListener('input', () => {
  threshold = slider.value / 100;
  document.getElementById('threshold-val').textContent = slider.value + '%';
  updateCounter();
});

// ── Bookmarks integration ─────────────────────────────────────────────────────
document.getElementById('bookmarks-toggle').addEventListener('change', e => {
  const status = document.getElementById('bookmarks-status');
  if (e.target.checked) {
    status.textContent = 'Loading…';
    chrome.runtime.sendMessage({ type: 'LOAD_BOOKMARKS' }, res => {
      status.textContent = res?.added ? `+${res.added} added` : 'None new';
      setTimeout(() => { status.textContent = ''; }, 3000);
    });
  } else {
    chrome.runtime.sendMessage({ type: 'CLEAR_BOOKMARKS' });
    status.textContent = '';
  }
});

// ── NL search ─────────────────────────────────────────────────────────────────
document.getElementById('btn-nl-search').addEventListener('click', () => {
  document.getElementById('nl-bar').classList.toggle('hidden');
  if (!document.getElementById('nl-bar').classList.contains('hidden')) {
    document.getElementById('nl-input').focus();
  }
});

document.getElementById('btn-nl-close').addEventListener('click', () => {
  document.getElementById('nl-bar').classList.add('hidden');
  document.getElementById('nl-input').value = '';
  nlMatches = null;
});

document.getElementById('nl-input').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const query = e.target.value.trim();
  if (!query) { nlMatches = null; return; }
  chrome.runtime.sendMessage({ type: 'NL_QUERY', query }, res => {
    if (!res?.ok) return;
    nlMatches = new Map(res.matches.map(m => [m.id, m.similarity]));
  });
});

document.getElementById('search-input').addEventListener('input', e => {
  searchQuery = e.target.value.trim().toLowerCase();
  updateCounter();
});

document.getElementById('btn-refresh').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'REBUILD' });
  alpha = 0.8;
});

document.getElementById('btn-export').addEventListener('click', () => {
  // Export graph as JSON
  const data = {
    exportedAt: new Date().toISOString(),
    nodes: nodes.map(({ id, title, url, domain, cluster, pinned, offline }) =>
      ({ id, title, url, domain, cluster, clusterName: clusterLabel(cluster), pinned, offline })
    ),
    edges: edges.map(e => ({ ...e, weight: e.weight })),
    clusterNames,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tab-graph-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById('btn-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// ── Preferences ───────────────────────────────────────────────────────────────
const mediaDark = matchMedia('(prefers-color-scheme: dark)');

async function loadPreferences() {
  const prefs = await chrome.storage.local.get([
    'uiThemeMode',
    'uiFontSize',
    'detailPanelHeight',
    'cfgThreshold',
  ]);

  applyTheme(prefs.uiThemeMode || 'system');
  applyFontSize(prefs.uiFontSize || 'medium');
  applyDetailPanelHeight(prefs.detailPanelHeight || '58vh');

  if (prefs.cfgThreshold != null) {
    threshold = prefs.cfgThreshold / 100;
    slider.value = prefs.cfgThreshold;
    document.getElementById('threshold-val').textContent = prefs.cfgThreshold + '%';
    updateCounter();
  }
}

function applyTheme(mode) {
  const resolved = mode === 'system'
    ? (mediaDark.matches ? 'dark' : 'light')
    : mode;

  document.documentElement.dataset.theme = resolved;
  document.getElementById('theme-mode').value = mode;
}

function applyFontSize(size) {
  document.documentElement.dataset.fontSize = size;
  document.querySelectorAll('.font-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.fontSize === size);
  });
}

function applyDetailPanelHeight(height) {
  document.documentElement.style.setProperty('--detail-panel-height', height);
}

document.getElementById('theme-mode').addEventListener('change', async event => {
  const mode = event.currentTarget.value;
  applyTheme(mode);
  await chrome.storage.local.set({ uiThemeMode: mode });
});

mediaDark.addEventListener('change', async () => {
  const { uiThemeMode = 'system' } = await chrome.storage.local.get(['uiThemeMode']);
  if (uiThemeMode === 'system') applyTheme('system');
});

document.querySelectorAll('.font-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const size = btn.dataset.fontSize;
    applyFontSize(size);
    await chrome.storage.local.set({ uiFontSize: size });
  });
});

// ── Detail resize ─────────────────────────────────────────────────────────────
const detailPanel = document.getElementById('detail-panel');
const detailHandle = document.getElementById('detail-resize-handle');
let resizingDetail = false;

detailHandle.addEventListener('mousedown', event => {
  resizingDetail = true;
  event.preventDefault();
});

window.addEventListener('mousemove', event => {
  if (!resizingDetail) return;
  const vh = Math.round(((window.innerHeight - event.clientY) / window.innerHeight) * 100);
  const clamped = Math.max(30, Math.min(85, vh));
  applyDetailPanelHeight(clamped + 'vh');
  resize();
});

window.addEventListener('mouseup', async () => {
  if (!resizingDetail) return;
  resizingDetail = false;
  const height = getComputedStyle(document.documentElement)
    .getPropertyValue('--detail-panel-height')
    .trim();
  await chrome.storage.local.set({ detailPanelHeight: height });
});

// ── Legend ────────────────────────────────────────────────────────────────────
function updateLegend() {
  const usedClusters = [...new Set(nodes.map(n => n.cluster))].sort();
  const legend = document.getElementById('legend');
  legend.replaceChildren();
  usedClusters.forEach(c => {
    const col  = CLUSTER_COLORS[c % CLUSTER_COLORS.length];
    const name = clusterLabel(c);
    const item = document.createElement('div');
    item.className = 'leg-item';
    const dot = document.createElement('div');
    dot.className = 'leg-dot';
    dot.style.background = col;
    item.append(dot, document.createTextNode(name));
    legend.append(item);
  });
}

// ── Cluster context menu ──────────────────────────────────────────────────────
const clusterMenu = document.getElementById('cluster-menu');

canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  const { x, y } = getPointerPos(e);
  const hit = findHit(x, y);
  if (!hit) { clusterMenu.classList.add('hidden'); return; }

  const usedClusters = [...new Set(nodes.map(n => n.cluster))].sort();
  const opts = document.getElementById('cluster-menu-options');
  opts.replaceChildren();

  usedClusters.forEach(c => {
    if (c === hit.cluster) return;
    const opt = document.createElement('div');
    opt.className = 'cluster-menu-opt';
    const dot = document.createElement('div');
    dot.className = 'cluster-menu-dot';
    dot.style.background = CLUSTER_COLORS[c % CLUSTER_COLORS.length];
    opt.append(dot, document.createTextNode(clusterLabel(c)));
    opt.addEventListener('click', () => {
      clusterMenu.classList.add('hidden');
      chrome.runtime.sendMessage({ type: 'SET_CLUSTER', tabId: hit.id, cluster: c });
      hit.cluster = c;  // optimistic local update
    });
    opts.append(opt);
  });

  // Position near the right-clicked node, stay within viewport
  const rect = canvas.getBoundingClientRect();
  let mx = rect.left + x + 8;
  let my = rect.top + y + 8;
  clusterMenu.classList.remove('hidden');
  const mw = clusterMenu.offsetWidth, mh = clusterMenu.offsetHeight;
  if (mx + mw > window.innerWidth)  mx = rect.left + x - mw - 8;
  if (my + mh > window.innerHeight) my = rect.top  + y - mh - 8;
  clusterMenu.style.left = mx + 'px';
  clusterMenu.style.top  = my + 'px';
});

document.addEventListener('click', () => clusterMenu.classList.add('hidden'));

// ── Session history ───────────────────────────────────────────────────────────
document.getElementById('btn-history').addEventListener('click', () => {
  document.getElementById('history-drawer').classList.remove('hidden');
  chrome.runtime.sendMessage({ type: 'GET_SESSIONS' }, res => {
    const list = document.getElementById('history-list');
    list.replaceChildren();
    const sessions = res?.sessions || [];
    if (!sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'muted-note';
      empty.style.padding = '16px 4px';
      empty.textContent = 'No sessions saved yet — the graph saves automatically as you browse.';
      list.append(empty);
      return;
    }
    sessions.forEach(session => {
      const item = document.createElement('div');
      item.className = 'history-item';
      const time = document.createElement('div');
      time.className = 'history-item-time';
      time.textContent = new Date(session.ts).toLocaleString();
      const summary = document.createElement('div');
      summary.className = 'history-item-summary';
      const names = Object.values(session.clusterNames || {});
      summary.textContent = `${session.nodes.length} tabs · ${session.edges.length} edges` +
        (names.length ? ` · ${names.slice(0, 3).join(', ')}` : '');
      item.append(time, summary);
      item.addEventListener('click', () => {
        applyPayload(session);
        document.getElementById('history-drawer').classList.add('hidden');
      });
      list.append(item);
    });
  });
});

document.getElementById('btn-close-history').addEventListener('click', () => {
  document.getElementById('history-drawer').classList.add('hidden');
});

// ── Notes ─────────────────────────────────────────────────────────────────────
let currentNoteUrl = null;
let noteSaveTimer  = null;

async function loadNote(url) {
  currentNoteUrl = url;
  const saved = await chrome.storage.local.get(['notes']);
  document.getElementById('note-input').value = (saved.notes || {})[url] || '';
  document.getElementById('note-status').classList.remove('visible');
}

async function saveNote(url, text) {
  const saved = await chrome.storage.local.get(['notes']);
  const notes = saved.notes || {};
  if (text.trim()) {
    notes[url] = text;
  } else {
    delete notes[url];
  }
  await chrome.storage.local.set({ notes });
  const status = document.getElementById('note-status');
  status.textContent = 'Saved';
  status.classList.add('visible');
  setTimeout(() => status.classList.remove('visible'), 1500);
}

document.getElementById('note-input').addEventListener('input', e => {
  if (!currentNoteUrl) return;
  clearTimeout(noteSaveTimer);
  const url = currentNoteUrl;
  noteSaveTimer = setTimeout(() => saveNote(url, e.target.value), 600);
});

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'GRAPH_UPDATE') applyPayload(msg.payload);
});

// ── Boot ──────────────────────────────────────────────────────────────────────
chrome.runtime.sendMessage({ type: 'GET_GRAPH' }, res => {
  if (res?.ok) applyPayload(res.payload);
});

loadPreferences();
tick();
