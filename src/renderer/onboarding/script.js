'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let selectedPreset = null;

// ── Platform detection ──
const _isMac = window.polishAPI.platform === 'darwin';
if (!_isMac) {
  const badge = document.getElementById('shortcutBadge');
  if (badge) badge.textContent = 'Ctrl+Alt+V';
  const tip = document.getElementById('tipPermission');
  if (tip) tip.style.display = 'none';
}

// ── Step navigation ──
function showStep(stepId) {
  $$('.step').forEach(s => s.classList.remove('active'));
  $(`#step-${stepId}`).classList.add('active');
}

// ── Step 1: Welcome ──
$('#btnQuickStart').addEventListener('click', async () => {
  // Use built-in Together AI — zero config
  await window.polishAPI.completeOnboarding('together');
  showStep('ready');
});

$('#btnCustomSetup').addEventListener('click', async () => {
  await loadProviders();
  showStep('provider');
});

// ── Step 2: Provider selection ──
async function loadProviders() {
  const { presets, order } = await window.polishAPI.getPresets();
  const list = $('#providerList');
  list.innerHTML = '';

  for (const id of order) {
    const p = presets[id];
    if (!p || id === 'custom') continue; // Skip custom in onboarding

    const card = document.createElement('div');
    card.className = 'provider-card';
    card.dataset.id = id;

    let html = `
      <div>
        <div class="provider-name">${p.name.replace(/（.*）/, '')}</div>
        <div class="provider-desc">${p.description}</div>
      </div>
    `;
    if (p.badge) {
      html += `<span class="provider-badge">${p.badge}</span>`;
    }
    card.innerHTML = html;

    card.addEventListener('click', () => selectProvider(id, p));
    list.appendChild(card);
  }
}

function selectProvider(id, preset) {
  // Update selection UI
  $$('.provider-card').forEach(c => c.classList.remove('selected'));
  $(`.provider-card[data-id="${id}"]`).classList.add('selected');
  selectedPreset = id;

  const keyArea = $('#providerKeyArea');
  if (preset.needsKey) {
    keyArea.classList.remove('hidden');
    $('#onboardApiKey').placeholder = preset.keyPlaceholder || '输入 API Key';
    $('#onboardApiKey').focus();
  } else {
    keyArea.classList.add('hidden');
    // For no-key presets (Together, Ollama), go directly
    finishWithPreset(id, '');
  }
}

$('#btnStartWithKey').addEventListener('click', () => {
  const key = $('#onboardApiKey').value.trim();
  if (!key) {
    $('#onboardApiKey').style.borderColor = '#ff3b30';
    $('#onboardApiKey').focus();
    return;
  }
  finishWithPreset(selectedPreset, key);
});

async function finishWithPreset(presetId, apiKey) {
  if (apiKey) {
    await window.polishAPI.setConfig('provider.apiKey', apiKey);
  }
  await window.polishAPI.completeOnboarding(presetId);
  showStep('ready');
}

// ── Step 2: Back button ──
$('#btnBack').addEventListener('click', () => {
  showStep('welcome');
});

// ── Step 3: Finish ──
$('#btnFinish').addEventListener('click', () => {
  window.close();
});
