// Content script — s'exécute dans le contexte d'Instagram
// Peut accéder aux cookies et à la session Instagram

const API_BASE = 'https://www.instagram.com/api/v1';

// Récupère le user_id et le csrftoken depuis les cookies.
// Mémoïsé : ces valeurs ne changent pas pendant un scan, inutile de
// re-parser document.cookie à chaque requête.
let _session = null;
function getSessionInfo() {
  // Parsing robuste : on coupe sur le PREMIER '=' uniquement, sinon une
  // valeur contenant '=' (ex. base64) serait tronquée.
  // On relit toujours le cookie : Instagram est une SPA, l'utilisateur peut
  // changer de compte SANS recharger la page. Le coût d'un parse de cookie est
  // négligeable, et cela permet d'invalider une session mémoïsée périmée.
  const cookies = document.cookie.split(';').reduce((acc, c) => {
    const idx = c.indexOf('=');
    if (idx === -1) return acc;
    acc[c.slice(0, idx).trim()] = c.slice(idx + 1).trim();
    return acc;
  }, {});

  const session = { userId: cookies['ds_user_id'], csrfToken: cookies['csrftoken'] };

  // Le cache n'est réutilisé que si le MÊME compte est toujours connecté.
  if (_session && session.userId && _session.userId === session.userId) {
    return _session;
  }

  // Compte changé ou session incomplète : on invalide le cache. On ne
  // mémoïse de nouveau QUE si la session est complète (sinon on re-parsera au
  // prochain appel, ex. connexion encore en cours sur la SPA).
  _session = (session.userId && session.csrfToken) ? session : null;
  return _session || session;
}

// Fetch depuis le content script (même origine, credentials inclus)
// Backoff automatique sur rate-limit (429) avant d'abandonner
async function igFetch(url, retries = 3) {
  const { csrfToken } = getSessionInfo();
  // Sans csrftoken, Instagram renvoie des erreurs opaques : on échoue tôt
  // avec un message clair plutôt que d'envoyer un header vide.
  if (!csrfToken) {
    throw new Error("Session Instagram introuvable. Connecte-toi sur instagram.com puis réessaie.");
  }
  // Timeout dur via AbortController : sans cela une requête qui ne répond
  // jamais fige le scan entier (ou laisse CHECK_LOGIN sans réponse, popup
  // bloqué sur « En attente du content script »).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'x-ig-app-id': '936619743392459',
        'x-csrftoken': csrfToken,
        'x-asbd-id': '198387',
        'x-requested-with': 'XMLHttpRequest',
        'Accept': '*/*',
      },
      credentials: 'include',
      signal: controller.signal
    });
  } catch (e) {
    // Timeout (abort) ou erreur réseau : on réessaie avec le même backoff
    // exponentiel que pour les 429/5xx, puis on abandonne avec un message clair.
    if (retries > 0) {
      const attempt = 3 - retries;
      await sleep(2000 * Math.pow(2, attempt) + Math.random() * 1000);
      return igFetch(url, retries - 1);
    }
    throw new Error("Instagram ne répond pas (délai dépassé ou réseau). Réessaie dans quelques instants.");
  } finally {
    clearTimeout(timer);
  }
  // Backoff EXPONENTIEL sur rate-limit (429) et erreurs serveur (5xx) :
  // 2s, 4s, 8s (+ jitter) — respecte mieux les limites d'Instagram et
  // reduit le risque de blocage temporaire qu'un delai fixe.
  if ((res.status === 429 || res.status >= 500) && retries > 0) {
    const attempt = 3 - retries; // 0, 1, 2
    await sleep(2000 * Math.pow(2, attempt) + Math.random() * 1000);
    return igFetch(url, retries - 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

// Récupère le user_id depuis les cookies, la page ou l'API
async function getMyUserId() {
  const { userId } = getSessionInfo();
  if (userId) return userId;

  // Fallback: cherche dans la page
  const scripts = document.querySelectorAll('script[type="application/json"]');
  for (const s of scripts) {
    try {
      const d = JSON.parse(s.textContent);
      const id = d?.config?.viewer?.id || d?.viewer?.id;
      if (id) return id;
    } catch {}
  }

  // Fallback: API
  const data = await igFetch(`${API_BASE}/accounts/current_user/?edit=true`);
  return data?.user?.pk_id || data?.user?.pk;
}

// Récupère TOUS les abonnés OU abonnements avec pagination.
// kind : 'followers' | 'following'
// idsOnly : ne retient que l'ensemble des IDs (Set) au lieu des objets
// complets. Utile pour les abonnés, dont seuls les IDs servent au calcul.
async function fetchAllFriendships(userId, kind, onProgress, idsOnly = false) {
  const users = [];
  const seen = new Set();
  let nextMaxId = null;
  let prevMaxId = null;
  let page = 0;
  const MAX_PAGES = 1000;

  do {
    page++;
    const base = `${API_BASE}/friendships/${userId}/${kind}/?count=200`;
    const url = nextMaxId ? `${base}&max_id=${encodeURIComponent(nextMaxId)}` : base;

    const data = await igFetch(url);
    const batch = data?.users || [];
    // Déduplication : si IG renvoie un curseur qui « tourne » (change à
    // chaque page mais re-sert les mêmes comptes), on n'accumule pas de
    // doublons et on évite de gonfler la mémoire jusqu'à MAX_PAGES.
    const seenBefore = seen.size;
    for (const u of batch) {
      const id = String(u.pk ?? u.id ?? '');
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      if (!idsOnly) users.push(u);
    }
    const addedNew = seen.size - seenBefore;
    prevMaxId = nextMaxId;
    nextMaxId = data?.next_max_id || null;

    onProgress?.({ count: idsOnly ? seen.size : users.length, done: !nextMaxId });

    // Garde-fous : page vide, curseur bloqué ou trop de pages → on arrête.
    // La page vide protège contre les boucles où IG renvoie un curseur qui
    // change à chaque fois mais sans plus aucun utilisateur.
    if (batch.length === 0) break;
    // Page entièrement composée de doublons : le curseur « tourne » sans
    // apporter de nouveaux comptes (curseur alternant A,B,A,B… non détecté par
    // le test prevMaxId ci-dessous) → inutile de continuer jusqu'à MAX_PAGES.
    if (addedNew === 0) break;
    if (nextMaxId && nextMaxId === prevMaxId) break;
    if (page >= MAX_PAGES) break;

    // Anti-rate-limit : petite pause entre les requêtes
    if (nextMaxId) await sleep(800 + Math.random() * 400);
  } while (nextMaxId);

  return idsOnly ? seen : users;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Vérification de connexion (message one-shot)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CHECK_LOGIN') {
    const { userId } = getSessionInfo();
    if (!userId) { sendResponse({ loggedIn: false }); return true; }
    // Récupère le username pour l'afficher dans le popup
    igFetch(`${API_BASE}/accounts/current_user/?edit=true`)
      .then(d => sendResponse({ loggedIn: true, userId, username: d?.user?.username || null }))
      .catch(() => sendResponse({ loggedIn: true, userId }));
    return true;
  }
});

// Scan via port long-vivant : la progression est streamée en direct,
// sans polling de chrome.storage côté popup.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'scan') return;
  port.onMessage.addListener((msg) => {
    if (msg.type === 'START_SCAN') runScan(port);
  });
});

async function runScan(port) {
  const send = (m) => { try { port.postMessage(m); } catch {} };

  try {
    send({ type: 'progress', status: 'getting_user' });

    const userId = await getMyUserId();
    if (!userId) {
      send({ type: 'error', error: 'Impossible de récupérer ton ID Instagram. Es-tu bien connecté ?' });
      return;
    }

    send({ type: 'progress', status: 'fetching_followers', followersCount: 0, followingCount: 0 });
    // Abonnés : seuls les IDs servent au calcul, on ne retient donc qu'un Set
    // (idsOnly) au lieu de milliers d'objets complets.
    const followerIds = await fetchAllFriendships(userId, 'followers', (p) => {
      send({ type: 'progress', status: 'fetching_followers', followersCount: p.count, followingCount: 0 });
    }, true);
    const totalFollowers = followerIds.size;

    send({ type: 'progress', status: 'fetching_following', followersCount: totalFollowers, followingCount: 0 });
    const following = await fetchAllFriendships(userId, 'following', (p) => {
      send({ type: 'progress', status: 'fetching_following', followersCount: totalFollowers, followingCount: p.count });
    });

    send({ type: 'progress', status: 'analyzing' });

    // Fantômes = ceux que je suis mais qui ne me suivent pas. Une seule passe,
    // la clé (ID en chaîne, car IG renvoie pk en number ou string) n'est
    // calculée qu'une fois par compte.
    const ghosts = [];
    for (const u of following) {
      const id = String(u.pk ?? u.id ?? '');
      if (followerIds.has(id)) continue;
      ghosts.push({
        id,
        username: u.username,
        full_name: u.full_name || '',
        profile_pic_url: u.profile_pic_url || '',
        is_private: u.is_private || false,
        is_verified: u.is_verified || false,
      });
    }

    const result = {
      ok: true,
      ghosts,
      totalFollowers,
      totalFollowing: following.length,
      scannedAt: new Date().toISOString()
    };

    chrome.storage.local.set({ lastResult: result });
    send({ type: 'result', result });

  } catch (err) {
    send({ type: 'error', error: err.message });
  }
}
