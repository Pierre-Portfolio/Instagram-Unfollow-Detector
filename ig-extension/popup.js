// popup.js — tous les event listeners sont ici, zéro inline HTML

let currentResult = null;
let filterTimer = null;
let scanning = false;

// Vérifie qu'on est bien sur le host Instagram. `String.includes` matcherait
// aussi « notinstagram.com » ou « instagram.com.evil.com » : on compare donc
// le hostname exact.
function isInstagramUrl(url) {
  try {
    return new URL(url).hostname === 'www.instagram.com';
  } catch {
    return false;
  }
}

// ── Enregistrement des listeners (DOMContentLoaded) ───
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btnScan').addEventListener('click', startScan);
  document.getElementById('prevResult').addEventListener('click', showResults);
  document.getElementById('btnBackHome').addEventListener('click', () => showScreen('screenHome'));
  document.getElementById('searchGhosts').addEventListener('input', onFilterInput);
  document.getElementById('btnExport').addEventListener('click', exportCSV);
  document.getElementById('btnHomeFromResults').addEventListener('click', () => showScreen('screenHome'));
  document.getElementById('btnRescan').addEventListener('click', startScan);
  document.getElementById('footerVersion').textContent = 'v' + chrome.runtime.getManifest().version;
  init();
});

// ── Init ──────────────────────────────────────────────
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isIG = isInstagramUrl(tab?.url);

  if (!isIG) {
    showScreen('screenNotIG');
    return;
  }

  // Le résultat précédent est indépendant de la session : on le charge d'abord
  // (await) pour éviter un re-rendu/scintillement quand la vérif de login
  // arrive ensuite de façon asynchrone.
  const { lastResult } = await chrome.storage.local.get(['lastResult']);
  if (lastResult?.ok && lastResult.ghosts) {
    currentResult = lastResult;
    showPrevResult(lastResult);
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
      document.getElementById('btnScan').disabled = false;
    } else {
      // Onglet Instagram ouvert mais aucune session : on le signale
      // explicitement au lieu de laisser le texte « Connecté » par défaut.
      document.getElementById('profileName').textContent = 'Non connecté';
      document.getElementById('profileStatus').textContent = 'Connecte-toi sur Instagram puis rouvre ce popup';
      document.getElementById('btnScan').disabled = true;
    }
    showScreen('screenHome');
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
  // Verrou : empêche de lancer plusieurs scans en parallèle (boutons
  // « Lancer le scan », « Nouveau scan » et « Rescan » partagent ce flux).
  if (scanning) return;
  scanning = true;
  setBtnLoading(true);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!isInstagramUrl(tab?.url)) {
    scanning = false;
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

  // Connexion au content script via un port : la progression arrive en
  // direct, plus besoin de poller chrome.storage.
  let settled = false;
  let port;
  try {
    port = chrome.tabs.connect(tab.id, { name: 'scan' });
  } catch (e) {
    scanning = false;
    setBtnLoading(false);
    showError('Impossible de communiquer avec Instagram.\nRecharge la page instagram.com et réessaie.');
    return;
  }

  port.onMessage.addListener((msg) => {
    if (msg.type === 'progress') {
      updateProgress(msg);
    } else if (msg.type === 'result') {
      settled = true;
      scanning = false;
      setBtnLoading(false);
      currentResult = msg.result;
      renderResults(msg.result);
      showScreen('screenResults');
      port.disconnect();
    } else if (msg.type === 'error') {
      settled = true;
      scanning = false;
      setBtnLoading(false);
      showError(msg.error || "Erreur inconnue. Assure-toi d'être connecté à Instagram.");
      port.disconnect();
    }
  });

  // Déconnexion non sollicitée (content script absent / page rechargée)
  port.onDisconnect.addListener(() => {
    if (settled) return;
    scanning = false;
    setBtnLoading(false);
    showError('Impossible de communiquer avec Instagram.\nRecharge la page instagram.com et réessaie.');
  });

  port.postMessage({ type: 'START_SCAN' });
}

// ── Progression (poussée par le content script) ───────
// L'API Instagram ne renvoie pas de total : on ne peut pas afficher un vrai
// pourcentage. On fait croître la barre de façon asymptotique avec le nombre
// d'éléments chargés (15% → 90%) pour qu'elle bouge visiblement sans jamais
// « finir » prématurément.
function approxWidth(count) {
  return Math.min(90, 15 + (count || 0) * 0.05) + '%';
}

function updateProgress(p) {
  const statusEl = document.getElementById('scanStatusText');
  const detailEl = document.getElementById('scanDetailText');

  if (p.status === 'getting_user') {
    statusEl.textContent = 'Récupération du profil...';
    detailEl.textContent = 'Identification de ton compte';
  } else if (p.status === 'fetching_followers') {
    statusEl.textContent = 'Chargement des abonnés...';
    detailEl.textContent = 'Abonnés : ' + (p.followersCount || 0) + ' chargés...';
    document.getElementById('progFollowersCount').textContent = p.followersCount || 0;
    document.getElementById('progFollowers').style.width = approxWidth(p.followersCount);
  } else if (p.status === 'fetching_following') {
    statusEl.textContent = 'Chargement des abonnements...';
    detailEl.textContent = 'Abonnements : ' + (p.followingCount || 0) + ' chargés...';
    document.getElementById('progFollowersCount').textContent = p.followersCount || 0;
    document.getElementById('progFollowingCount').textContent = p.followingCount || 0;
    document.getElementById('progFollowers').style.width = '100%';
    document.getElementById('progFollowing').style.width = approxWidth(p.followingCount);
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

function setGhostCount(n) {
  const label = document.getElementById('ghostCountLabel');
  label.textContent = n + ' compte' + (n > 1 ? 's' : '') + ' affiché' + (n > 1 ? 's' : '');
}

function renderGhostList(ghosts) {
  const listEl = document.getElementById('ghostList');
  setGhostCount(ghosts.length);

  // Construction via le DOM (textContent/setAttribute) — pas d'innerHTML
  // avec des données distantes, pour éviter toute injection XSS.
  listEl.textContent = '';

  if (ghosts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-ghosts';
    const em = document.createElement('div');
    em.className = 'em';
    em.textContent = '🎉';
    empty.appendChild(em);
    empty.appendChild(document.createTextNode('Tout le monde te suit en retour !'));
    listEl.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  ghosts.forEach(function(u, i) {
    const username = String(u.username || '');

    const item = document.createElement('a');
    item.className = 'ghost-item';
    item.href = 'https://www.instagram.com/' + encodeURIComponent(username) + '/';
    item.target = '_blank';
    item.rel = 'noopener noreferrer';
    item.style.animationDelay = Math.min(i * 0.02, 0.5) + 's';
    // Texte de recherche pré-calculé : le filtrage (opt 4) se contente de
    // masquer/afficher les items existants au lieu de reconstruire le DOM.
    item._search = (username + ' ' + (u.full_name || '')).toLowerCase();

    const avatar = document.createElement('div');
    avatar.className = 'ghost-avatar';
    const picUrl = typeof u.profile_pic_url === 'string' ? u.profile_pic_url : '';
    if (/^https:\/\//i.test(picUrl)) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', function() {
        img.remove();
        avatar.textContent = username.slice(0, 2).toUpperCase();
      });
      img.src = picUrl;
      avatar.appendChild(img);
    } else {
      avatar.textContent = username.slice(0, 2).toUpperCase();
    }

    const name = document.createElement('div');
    name.className = 'ghost-name';
    name.textContent = '@' + username;

    const badges = document.createElement('div');
    badges.className = 'ghost-badges';
    if (u.is_private) {
      const b = document.createElement('span');
      b.className = 'badge-small badge-private';
      b.textContent = 'PRIVÉ';
      badges.appendChild(b);
    }
    if (u.is_verified) {
      const b = document.createElement('span');
      b.className = 'badge-small badge-verified';
      b.textContent = '✓';
      badges.appendChild(b);
    }

    const arrow = document.createElement('span');
    arrow.className = 'arrow-icon';
    arrow.textContent = '↗';

    item.appendChild(avatar);
    item.appendChild(name);
    item.appendChild(badges);
    item.appendChild(arrow);
    frag.appendChild(item);
  });
  listEl.appendChild(frag);
}

// ── Recherche (debounce) ──────────────────────────────
function onFilterInput() {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(filterGhosts, 120);
}

function filterGhosts() {
  if (!currentResult) return;
  const q = document.getElementById('searchGhosts').value.toLowerCase().trim();
  // Opt 4 : on ne reconstruit pas le DOM à chaque frappe — on masque/affiche
  // les items déjà rendus via leur texte de recherche pré-calculé.
  const items = document.getElementById('ghostList').children;
  let visible = 0;
  for (const item of items) {
    if (typeof item._search !== 'string') continue; // ignore l'état "vide"
    const match = !q || item._search.includes(q);
    item.style.display = match ? '' : 'none';
    if (match) visible++;
  }
  setGhostCount(visible);
}

// ── Export ────────────────────────────────────────────
function exportCSV() {
  if (!currentResult || !currentResult.ghosts.length) return;
  const esc = function(v) {
    let s = String(v == null ? '' : v);
    // Anti CSV-injection : neutralise les formules (=, +, -, @, tab, CR)
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const rows = [['username', 'full_name', 'profile_url', 'is_private', 'is_verified']].concat(
    currentResult.ghosts.map(function(u) {
      return [u.username, u.full_name || '', 'https://www.instagram.com/' + encodeURIComponent(u.username || '') + '/', u.is_private ? 'oui' : 'non', u.is_verified ? 'oui' : 'non'];
    })
  );
  const csv = '﻿' + rows.map(function(r) { return r.map(esc).join(','); }).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'unfollowers-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function() { URL.revokeObjectURL(url); }, 60000);
}

// ── Error ─────────────────────────────────────────────
function showError(msg) {
  document.getElementById('errorText').textContent = '⚠️ ' + msg;
  showScreen('screenError');
}
