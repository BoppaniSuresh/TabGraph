function toggleShow(inputId, button) {
  const input = document.getElementById(inputId);
  const shown = input.type === 'text';
  input.type = shown ? 'password' : 'text';
  button.textContent = shown ? 'Show' : 'Hide';
}

async function load() {
  const settings = await chrome.storage.local.get([
    'openaiKey',
    'cfgThreshold',
    'cfgAlpha',
    'cfgTextLimit',
    'cfgLocalEmbeddings',
  ]);

  if (settings.openaiKey) {
    document.getElementById('openai-key').value = settings.openaiKey;
  }

  if (settings.cfgThreshold) {
    document.getElementById('cfg-threshold').value = settings.cfgThreshold;
    document.getElementById('cfg-threshold-val').textContent = settings.cfgThreshold + '%';
  }

  if (settings.cfgAlpha) {
    document.getElementById('cfg-alpha').value = settings.cfgAlpha;
    document.getElementById('cfg-alpha-val').textContent = settings.cfgAlpha + '%';
  }

  if (settings.cfgTextLimit) {
    document.getElementById('cfg-text-limit').value = settings.cfgTextLimit;
  }

  document.getElementById('cfg-local-embeddings').checked = !!settings.cfgLocalEmbeddings;
}

document.getElementById('show-openai-key').addEventListener('click', event => {
  toggleShow(event.currentTarget.dataset.target, event.currentTarget);
});

document.getElementById('cfg-threshold').addEventListener('input', event => {
  document.getElementById('cfg-threshold-val').textContent = event.currentTarget.value + '%';
});

document.getElementById('cfg-alpha').addEventListener('input', event => {
  document.getElementById('cfg-alpha-val').textContent = event.currentTarget.value + '%';
});

document.getElementById('btn-save').addEventListener('click', async () => {
  const key         = document.getElementById('openai-key').value.trim();
  const rawThreshold = parseInt(document.getElementById('cfg-threshold').value, 10);
  const rawAlpha     = parseInt(document.getElementById('cfg-alpha').value, 10);
  const rawTextLimit = parseInt(document.getElementById('cfg-text-limit').value, 10);

  await chrome.storage.local.set({
    openaiKey:           key,
    cfgThreshold:        Math.max(20, Math.min(90,    isNaN(rawThreshold) ? 45   : rawThreshold)),
    cfgAlpha:            Math.max(0,  Math.min(100,   isNaN(rawAlpha)     ? 75   : rawAlpha)),
    cfgTextLimit:        Math.max(1000, Math.min(12000, isNaN(rawTextLimit) ? 6000 : rawTextLimit)),
    cfgLocalEmbeddings:  document.getElementById('cfg-local-embeddings').checked,
  });

  const status = document.getElementById('save-status');
  if (!key) {
    status.textContent = '⚠ Saved — no API key set';
    status.style.color = 'rgba(255,180,60,0.9)';
  } else {
    status.textContent = '✓ Saved';
    status.style.color = '';
  }
  status.classList.add('show');
  setTimeout(() => { status.classList.remove('show'); }, 2500);
});

load();
