// api.js — all LLM API calls
// OpenAI Responses API: embeddings, summaries, related-tab reasoning, and web context

async function getKeys() {
  const s = await chrome.storage.local.get(['openaiKey']);
  return { openai: s.openaiKey || '' };
}

function extractResponseText(data) {
  if (data?.output_text) return data.output_text;

  return (data?.output || [])
    .flatMap(item => item.content || [])
    .filter(part => part.type === 'output_text' || part.type === 'text')
    .map(part => part.text || '')
    .join(' ')
    .trim();
}

async function createOpenAIResponse(prompt, { maxOutputTokens = 512, tools = null, toolChoice = 'auto' } = {}) {
  const { openai } = await getKeys();
  if (!openai) return null;

  const body = {
    model: 'gpt-4.1-mini',
    input: prompt,
    max_output_tokens: maxOutputTokens,
  };

  if (tools) {
    body.tools = tools;
    body.tool_choice = toolChoice;
  }

  try {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openai}` },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('[TabGraph] OpenAI error', res.status, errText);
      return null;
    }

    return extractResponseText(await res.json());
  } catch (err) {
    console.error('[TabGraph] OpenAI network error:', err.message);
    return null;
  }
}

// ─── OpenAI: Embeddings ───────────────────────────────────────────────────────

// Local embedding pipeline (lazy-loaded when cfgLocalEmbeddings is enabled)
let localPipeline = null;

async function getLocalEmbedding(text) {
  if (!localPipeline) {
    // Dynamic import from CDN — downloads ~23 MB on first use, cached after that
    const { pipeline } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2/dist/transformers.min.js');
    localPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  const output = await localPipeline(text.slice(0, 512), { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

export async function getEmbedding(text) {
  const s = await chrome.storage.local.get(['cfgLocalEmbeddings', 'openaiKey']);

  if (s.cfgLocalEmbeddings) {
    try {
      return await getLocalEmbedding(text);
    } catch (err) {
      console.error('[TabGraph] Local embedding error:', err.message);
      return null;
    }
  }

  const openai = s.openaiKey || '';
  if (!openai) { console.warn('[TabGraph] No OpenAI key set'); return null; }

  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openai}` },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 8000) }),
    });

    if (!res.ok) {
      console.error('[TabGraph] Embedding error', res.status);
      return null;
    }
    const data = await res.json();
    return data?.data?.[0]?.embedding ?? null;
  } catch (err) {
    console.error('[TabGraph] Embedding network error:', err.message);
    return null;
  }
}

// ─── OpenAI: Page summary + key points ───────────────────────────────────────

export async function getSummaryAndKeyPoints(tab) {
  const { openai } = await getKeys();
  if (!openai) return { summary: 'Add your OpenAI API key in extension options.', keyPoints: [] };

  const prompt = `You are analysing a browser tab for a knowledge graph tool.

Tab title: ${tab.title}
Domain: ${tab.domain}
Page text (truncated):
${tab.text.slice(0, 2500)}

Respond with ONLY valid JSON in this exact shape:
{
  "summary": "<3-4 sentence summary of what this page is about>",
  "keyPoints": ["<point 1>", "<point 2>", "<point 3>"]
}`;

  const text = await createOpenAIResponse(prompt, { maxOutputTokens: 512 });
  if (!text) return { summary: 'Summary unavailable — check your API key or connection.', keyPoints: [] };

  try {
    const json = JSON.parse(text.replace(/```json|```/g, '').trim());
    return { summary: json.summary || '', keyPoints: json.keyPoints || [] };
  } catch {
    return { summary: 'Could not parse summary.', keyPoints: [] };
  }
}

// ─── OpenAI: Related-tab reasoning ───────────────────────────────────────────

export async function getRelatedReasoning(sourceTab, relatedTabs) {
  const { openai } = await getKeys();
  if (!openai || !relatedTabs.length) return relatedTabs.map(() => 'Semantic similarity');

  const prompt = `You are explaining why browser tabs are related to each other in a knowledge graph.

Source tab: "${sourceTab.title}" (${sourceTab.domain})

Related tabs (in order of similarity score):
${relatedTabs.map((t, i) => `${i+1}. "${t.title}" (${t.domain}) — similarity ${Math.round(t.weight * 100)}%`).join('\n')}

For each related tab, write a SHORT reason (max 8 words) explaining the specific connection to the source tab.
Respond with ONLY a JSON array of strings, one per related tab, in the same order:
["reason 1", "reason 2", ...]`;

  const text = await createOpenAIResponse(prompt, { maxOutputTokens: 256 });
  if (!text) return relatedTabs.map(() => 'Semantic overlap');

  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    return relatedTabs.map(() => 'Semantic overlap');
  }
}

// ─── OpenAI: Cluster name ─────────────────────────────────────────────────────

export async function getClusterName(tabs) {
  const { openai } = await getKeys();
  if (!openai || !tabs.length) return null;

  const list = tabs.slice(0, 8).map(t => `- "${t.title}" (${t.domain})`).join('\n');
  const prompt = `These browser tabs are grouped together by semantic similarity:
${list}

Give this group a concise 2-3 word label that captures their shared theme.
Respond with ONLY the label — no punctuation, no explanation.`;

  return createOpenAIResponse(prompt, { maxOutputTokens: 16 });
}

// ─── OpenAI: Web search context ───────────────────────────────────────────────

export async function getWebContext(tab) {
  const { openai } = await getKeys();
  if (!openai) return null;

  const prompt = `Give me 2-3 sentences of current context about this web page topic that would be useful supplementary information beyond what the page itself contains. Be specific and factual.

Page: "${tab.title}" on ${tab.domain}
Summary: ${tab.text.slice(0, 500)}

Respond with only the supplementary context text, no preamble.`;

  return createOpenAIResponse(prompt, {
    maxOutputTokens: 200,
    tools: [{ type: 'web_search_preview' }],
    toolChoice: 'required',
  });
}
