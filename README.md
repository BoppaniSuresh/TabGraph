# Tab Knowledge Graph

A Chrome extension (Manifest V3) that visualises your open browser tabs as an interactive semantic knowledge graph — surfacing hidden connections between pages you're researching.

## How it works

1. **Content extraction** — a content script captures page text from every tab and detects navigation changes via History API patching and MutationObserver.
2. **Embeddings** — page text is encoded via OpenAI `text-embedding-3-small` (or a local `all-MiniLM-L6-v2` model via Transformers.js).
3. **Edge scoring** — each pair of tabs receives a combined weight:
   ```
   weight = α · cosine_similarity(embeddings) + (1 − α) · entity_jaccard(entities)
   ```
   Pairs above the configurable threshold become edges in the graph.
4. **Clustering** — a full two-phase Louvain community detection algorithm groups tabs into semantic clusters, which are named automatically by GPT-4.1-mini.
5. **Visualisation** — a Canvas-based force-directed layout (or radial cluster layout) renders the graph in the Chrome side panel with live physics simulation.

## Features

- **Interactive graph** — drag nodes, zoom, pan; hover highlights connections; click opens a detail panel
- **AI detail panel** — per-tab summary, key points, related-tab reasoning, web search context (via OpenAI web search tool), and tab recommendations
- **Natural-language search** — embed a freeform query and highlight the most semantically similar tabs
- **Bookmark overlay** — optionally pull bookmarks into the graph alongside open tabs
- **Session history** — browse previously seen tabs from browser history
- **Per-tab notes** — attach personal notes to any tab node
- **Export** — download the graph as a JSON snapshot
- **Multi-window support** — filter the graph to a specific browser window
- **Theme** — system / dark / light, with adjustable text size

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome and enable **Developer mode**.
3. Click **Load unpacked** and select the project folder.
4. Click the extension icon → **Open Tab Graph** to open the side panel.
5. Open **Settings** (gear icon) and enter your OpenAI API key.

## Configuration

All settings are saved in `chrome.storage.local` and applied immediately.

| Setting | Default | Range | Description |
|---|---|---|---|
| OpenAI API key | — | — | Required unless local embeddings are enabled |
| Edge threshold | 45% | 20–90% | Minimum similarity to draw an edge |
| Alpha (α) | 75% | 0–100% | Weight given to semantic vs. entity similarity |
| Text limit | 6 000 chars | 1 000–12 000 | Page text sent for embedding |
| Local embeddings | off | — | Use on-device `all-MiniLM-L6-v2` (~23 MB, downloaded once) |

## Project structure

```
tab-knowledge-graph/
├── manifest.json          # MV3 manifest — permissions, entry points
├── sidepanel.html/css     # Side panel UI shell
├── options.html           # Settings page
├── icons/                 # Extension icons (16, 48, 128 px)
└── src/
    ├── background.js      # Service worker — tab lifecycle, central state
    ├── content.js         # Page text extraction, SPA navigation detection
    ├── graph.js           # Edge weight computation, Louvain clustering
    ├── api.js             # All OpenAI calls (embeddings, summaries, search)
    ├── sidepanel.js       # Canvas rendering, force layout, UI interactions
    └── options.js         # Settings page logic
```

## Permissions

| Permission | Purpose |
|---|---|
| `tabs` | Read tab titles, URLs, window IDs |
| `storage` | Persist embeddings, settings, notes |
| `sidePanel` | Render the graph in Chrome's side panel |
| `scripting` | Inject content script on demand |
| `activeTab` | Focus / switch to a selected tab |
| `history` | Load session history into the graph |
| `bookmarks` | Optional bookmark overlay |
| `<all_urls>` | Extract page text from any site |

## Privacy

- Page text and embeddings are stored locally in `chrome.storage.local`.
- Text is sent to OpenAI only when an API key is configured and the user triggers an action that requires it (embedding, summary, search).
- No data is sent to any server other than `api.openai.com`.
- Enable **Local embeddings** in settings to keep all embedding computation on-device.

## Requirements

- Chrome 114+ (side panel API)
- OpenAI API key with access to `text-embedding-3-small` and `gpt-4.1-mini` (or local embeddings enabled)
