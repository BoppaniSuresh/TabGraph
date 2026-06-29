// graph.js — edge computation and clustering
// Edge weight = α·cosine_similarity + (1-α)·entity_jaccard

const ALPHA = 0.75;
const EDGE_THRESHOLD = 0.45;

// ─── Cosine similarity ────────────────────────────────────────────────────────

function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Entity Jaccard ───────────────────────────────────────────────────────────

function entityJaccard(entA, entB) {
  if (!entA?.length || !entB?.length) return 0;
  const setA = new Set(entA.map(e => e.toLowerCase()));
  const setB = new Set(entB.map(e => e.toLowerCase()));
  let inter = 0;
  setA.forEach(e => { if (setB.has(e)) inter++; });
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ─── Edge computation ─────────────────────────────────────────────────────────

export function computeEdges(tabs, threshold = EDGE_THRESHOLD, alpha = ALPHA) {
  const edges = [];

  for (let i = 0; i < tabs.length; i++) {
    for (let j = i + 1; j < tabs.length; j++) {
      const tA = tabs[i], tB = tabs[j];

      const sem    = cosineSim(tA.embedding, tB.embedding);
      const entity = entityJaccard(tA.entities, tB.entities);
      const weight = alpha * sem + (1 - alpha) * entity;

      if (weight >= threshold) {
        edges.push({ a: tA.id, b: tB.id, weight: parseFloat(weight.toFixed(4)) });
      }
    }
  }

  return edges;
}

// Computes edges between one tab and a list of others (for incremental updates)
export function computeEdgesForTab(tab, others, threshold = EDGE_THRESHOLD, alpha = ALPHA) {
  const edges = [];
  for (const other of others) {
    if (!tab.embedding || !other.embedding) continue;
    const sem    = cosineSim(tab.embedding, other.embedding);
    const entity = entityJaccard(tab.entities, other.entities);
    const weight = alpha * sem + (1 - alpha) * entity;
    if (weight >= threshold) {
      edges.push({ a: tab.id, b: other.id, weight: parseFloat(weight.toFixed(4)) });
    }
  }
  return edges;
}

// ─── Full Louvain community detection ────────────────────────────────────────
// Phase 1: Greedy local modularity optimisation (repeated until no gain).
// Phase 2: Community contraction — build a super-graph and repeat.
// Returns a map of nodeId -> communityId (0-indexed integers).

export function detectCommunities(tabs, edges) {
  if (!tabs.length) return {};
  if (!edges.length) {
    const r = {};
    tabs.forEach((t, i) => { r[t.id] = i; });
    return r;
  }

  const ids = tabs.map(t => t.id);
  const totalWeight = edges.reduce((s, e) => s + e.weight, 0) * 2 || 1;

  // Build weighted adjacency and node strength (sum of edge weights)
  function buildAdj(nodeIds, edgeList) {
    const adj = {};
    const strength = {};
    nodeIds.forEach(id => { adj[id] = {}; strength[id] = 0; });
    edgeList.forEach(({ a, b, weight }) => {
      if (!adj[a] || !adj[b]) return;
      adj[a][b] = (adj[a][b] || 0) + weight;
      adj[b][a] = (adj[b][a] || 0) + weight;
      strength[a] = (strength[a] || 0) + weight;
      strength[b] = (strength[b] || 0) + weight;
    });
    return { adj, strength };
  }

  // Phase 1: local moves
  function localMoves(nodeIds, edgeList) {
    const { adj, strength } = buildAdj(nodeIds, edgeList);
    const community = {};
    nodeIds.forEach(id => { community[id] = id; });

    let improved = true;
    while (improved) {
      improved = false;
      for (const node of nodeIds) {
        const currentComm = community[node];
        // Weighted connections to each neighbour community
        const commEdge = {};
        Object.entries(adj[node] || {}).forEach(([nb, w]) => {
          const c = community[nb];
          commEdge[c] = (commEdge[c] || 0) + w;
        });

        // Modularity gain = edgeToComm - (strength[node] * commStrength) / totalWeight
        const commStrength = {};
        nodeIds.forEach(id => {
          const c = community[id];
          commStrength[c] = (commStrength[c] || 0) + (strength[id] || 0);
        });

        let bestComm = currentComm;
        let bestGain = 0;

        Object.entries(commEdge).forEach(([c, eic]) => {
          if (c === currentComm) return;
          const gain = eic / totalWeight -
            (strength[node] || 0) * (commStrength[c] || 0) / (totalWeight * totalWeight);
          if (gain > bestGain) { bestGain = gain; bestComm = c; }
        });

        if (bestComm !== currentComm) {
          community[node] = bestComm;
          improved = true;
        }
      }
    }
    return community;
  }

  // Run phase 1
  const community = localMoves(ids, edges);

  // Phase 2: contract and repeat if more than one community
  const commIds = [...new Set(Object.values(community))];
  if (commIds.length > 1 && commIds.length < ids.length) {
    // Build super-graph: one node per community
    const superEdges = {};
    edges.forEach(({ a, b, weight }) => {
      const ca = community[a], cb = community[b];
      if (ca === cb) return;
      const key = ca < cb ? `${ca}|${cb}` : `${cb}|${ca}`;
      superEdges[key] = (superEdges[key] || 0) + weight;
    });
    const superEdgeList = Object.entries(superEdges).map(([k, w]) => {
      const [a, b] = k.split('|');
      return { a, b, weight: w };
    });
    const superComm = localMoves(commIds, superEdgeList);
    // Map original nodes through both levels
    Object.keys(community).forEach(id => {
      community[id] = superComm[community[id]] ?? community[id];
    });
  }

  // Normalise to 0-indexed integers
  const idMap = {};
  let next = 0;
  Object.entries(community).forEach(([nodeId, comm]) => {
    if (!(comm in idMap)) idMap[comm] = next++;
    community[nodeId] = idMap[comm];
  });

  return community;
}

// ─── Filter edges by threshold ────────────────────────────────────────────────

export function filterEdges(edges, threshold) {
  return edges.filter(e => e.weight >= threshold);
}
