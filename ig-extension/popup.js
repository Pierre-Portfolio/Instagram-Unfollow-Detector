// popup.js — tous les event listeners sont ici, zéro inline HTML

let currentResult = null;
let progressTimer = null;

// ── Enregistrement des listeners (DOMContentLoaded) ───
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btnScan').addEventListener('click', startScan);
  document.getElementById('prevResult').addEventListener('click', showResults);
  document.getElementById('btnBackHome').addEventListener('click', () => showScreen('screenHome'));
  document.getElementById('searchGhosts').addEventListener('input', filterGhosts);
  document.getElementById('btnExport').addEventListener('click', exportCSV);
  document.getElementById('btnHomeFromResults').addEventListener('click', () => showScreen('screenHome'));
  document.getElementById('btnRescan').addEventListener('click', startScan);
  init();
});

// ── Init ──────────────────────────────────────────────
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isIG = tab?.url?.includes('instagram.com');

  if (!isIG) {
    showScreen('screenNotIG');
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: 'CHECK_LOGIN' }, (resp) => {
    if (chrome.runtime.lastError || !resp) {
      showScreen('screenHome');
      document.getElementById('profileStatus').textContent = 'En attente du content script...';
      return;
    }
    if (resp.loggedIn) {
      document.getElementById('profileName').textContent = '@' + (resp.username || 'moi');
      document.getElementById('profileStatus').textContent = 'Session active · ID ' + String(resp.userId || '').slice(0, 8) + '...';
    }
    showScreen('screenHome');
  });

  chrome.storage.local.get(['lastResult'], ({ lastResult }) => {
    if (lastResult?.ok && lastResult.ghosts) {
      currentResult = lastResult;
      showPrevResult(lastResult);
    }
  });
}

// ── Helpers UI ────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function setBtnLoading(loading) {
  const btn = document.getElementById('btnScan');
  if (!btn) return;
  btn.disabled = loading;
  if (loading) {
    btn.innerHTML = '<svg class="spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg> Connexion...';
  } else {
    btn.innerHTML = '🔍 Lancer le scan';
  }
}

function showPrevResult(result) {
  const n = result.ghosts.length;
  const date = result.scannedAt
    ? new Date(result.scannedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '';
  document.getElementById('prevBadge').textContent = n + ' fantôme' + (n > 1 ? 's' : '');
  document.getElementById('prevDesc').innerHTML = '<strong>' + result.totalFollowing + '</strong> abonnements · <strong>' + result.totalFollowers + '</strong> abonnés · ' + date;
  document.getElementById('prevResult').style.display = 'block';
}

// ── Scan ──────────────────────────────────────────────
async function startScan() {
  setBtnLoading(true);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.url?.includes('instagram.com')) {
    setBtnLoading(false);
    showScreen('screenNotIG');
    return;
  }

  showScreen('screenScan');
  document.getElementById('scanStatusText').textContent = 'Connexion à Instagram...';
  document.getElementById('scanDetailText').textContent = 'Récupération de la session';
  document.getElementById('progFollowers').style.width = '5%';
  document.getElementById('progFollowing').style.width = '0%';
  document.getElementById('progFollowersCount').textContent = '...';
  document.getElementById('progFollowingCount').textContent = '...';

  startProgressPolling();

  chrome.tabs.sendMessage(tab.id, { type: 'START_SCAN' }, (response) => {
    stopProgressPolling();
    setBtnLoading(false);

    if (chrome.runtime.lastError) {
      showError('Impossible de communiquer avec Instagram.\nRecharge la page instagram.com et réessaie.');
      return;
    }

    if (!response || !response.ok) {
      showError((response && response.error) || "Erreur inconnue. Assure-toi d'être connecté à Instagram.");
      return;
    }

    currentResult = response;
    renderResults(response);
    showScreen('screenResults');
  });
}

// ── Progress polling ──────────────────────────────────
function startProgressPolling() {
  progressTimer = setInterval(() => {
    chrome.storage.local.get(['scanProgress'], ({ scanProgress: p }) => {
      if (p) updateProgress(p);
    });
  }, 400);
}

function stopProgressPolling() {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
}

function updateProgress(p) {
  const statusEl = document.getElementById('scanStatusText');
  const detailEl = document.getElementById('scanDetailText');

  if (p.status === 'getting_user') {
    statusEl.textContent = 'Récupération du profil...';
    detailEl.textContent = 'Identification de ton compte';
  } else if (p.status === 'fetching_followers') {
    statusEl.textContent = 'Chargement des abonnés...';
    detailEl.textContent = p.message || '';
    document.getElementById('progFollowersCount').textContent = p.followersCount || 0;
    document.getElementById('progFollowers').style.width = p.followersCount > 0 ? '70%' : '15%';
  } else if (p.status === 'fetching_following') {
    statusEl.textContent = 'Chargement des abonnements...';
    detailEl.textContent = p.message || '';
    document.getElementById('progFollowersCount').textContent = p.followersCount || 0;
    document.getElementById('progFollowingCount').textContent = p.followingCount || 0;
    document.getElementById('progFollowers').style.width = '100%';
    document.getElementById('progFollowing').style.width = p.followingCount > 0 ? '70%' : '15%';
  } else if (p.status === 'analyzing') {
    statusEl.textContent = 'Analyse en cours...';
    detailEl.textContent = 'Comparaison des listes';
    document.getElementById('progFollowing').style.width = '100%';
  }
}

// ── Results ───────────────────────────────────────────
function showResults() {
  if (!currentResult) return;
  renderResults(currentResult);
  showScreen('screenResults');
}

function renderResults(result) {
  document.getElementById('resGhosts').textContent = result.ghosts.length;
  document.getElementById('resFollowers').textContent = result.totalFollowers;
  document.getElementById('resFollowing').textContent = result.totalFollowing;
  renderGhostList(result.ghosts);
}

function renderGhostList(ghosts) {
  const listEl = document.getElementById('ghostList');
  const label = document.getElementById('ghostCountLabel');
  label.textContent = ghosts.length + ' compte' + (ghosts.length > 1 ? 's' : '') + ' affiché' + (ghosts.length > 1 ? 's' : '');

  if (ghosts.length === 0) {
    listEl.innerHTML = '<div class="empty-ghosts"><div class="em">🎉</div>Tout le monde te suit en retour !</div>';
    return;
  }

  listEl.innerHTML = ghosts.map(function(u, i) {
    const initials = u.username.slice(0, 2).toUpperCase();
    const igUrl = 'https://www.instagram.com/' + u.username + '/';
    const badges = (u.is_private ? '<span class="badge-small badge-private">PRIVÉ</span>' : '') +
                   (u.is_verified ? '<span class="badge-small badge-verified">✓</span>' : '');
    const avatarContent = u.profile_pic_url
      ? '<img src="' + u.profile_pic_url + '" alt="" onerror="this.style.display=\'none\'">'
      : initials;
    return '<a class="ghost-item" href="' + igUrl + '" target="_blank" style="animation-delay:' + Math.min(i * 0.02, 0.5) + 's">' +
      '<div class="ghost-avatar">' + avatarContent + '</div>' +
      '<div class="ghost-name">@' + u.username + '</div>' +
      '<div class="ghost-badges">' + badges + '</div>' +
      '<span class="arrow-icon">↗</span>' +
    '</a>';
  }).join('');
}

function filterGhosts() {
  if (!currentResult) return;
  const q = document.getElementById('searchGhosts').value.toLowerCase();
  const filtered = q
    ? currentResult.ghosts.filter(function(u) {
        return u.username.toLowerCase().includes(q) || (u.full_name || '').toLowerCase().includes(q);
      })
    : currentResult.ghosts;
  renderGhostList(filtered);
}

// ── Export ────────────────────────────────────────────
function exportCSV() {
  if (!currentResult || !currentResult.ghosts.length) return;
  const rows = [['username', 'full_name', 'profile_url', 'is_private', 'is_verified']].concat(
    currentResult.ghosts.map(function(u) {
      return [u.username, u.full_name || '', 'https://www.instagram.com/' + u.username + '/', u.is_private ? 'oui' : 'non', u.is_verified ? 'oui' : 'non'];
    })
  );
  const csv = '\uFEFF' + rows.map(function(r) { return r.map(function(v) { return '"' + v + '"'; }).join(','); }).join('\n');
  chrome.tabs.create({ url: 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv) });
}

// ── Error ─────────────────────────────────────────────
function showError(msg) {
  document.getElementById('errorText').textContent = '⚠️ ' + msg;
  showScreen('screenError');
}
