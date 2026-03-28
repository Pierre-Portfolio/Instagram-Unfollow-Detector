// Content script — s'exécute dans le contexte d'Instagram
// Peut accéder aux cookies et à la session Instagram

const API_BASE = 'https://www.instagram.com/api/v1';
const GRAPH_BASE = 'https://www.instagram.com/graphql/query';

// Récupère le user_id et le csrftoken depuis les cookies/meta
function getSessionInfo() {
  const cookies = document.cookie.split(';').reduce((acc, c) => {
    const [k, v] = c.trim().split('=');
    acc[k] = v;
    return acc;
  }, {});

  // Cherche aussi dans window._sharedData (ancien) ou dans les scripts
  let userId = cookies['ds_user_id'];
  const csrfToken = cookies['csrftoken'];

  return { userId, csrfToken };
}

// Fetch depuis le content script (même origine, credentials inclus)
async function igFetch(url) {
  const { csrfToken } = getSessionInfo();
  const res = await fetch(url, {
    headers: {
      'x-ig-app-id': '936619743392459',
      'x-csrftoken': csrfToken || '',
      'x-asbd-id': '198387',
      'x-requested-with': 'XMLHttpRequest',
      'Accept': '*/*',
    },
    credentials: 'include'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

// Récupère le user_id depuis le profil courant
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

// Récupère TOUS les followers avec pagination
async function fetchAllFollowers(userId, onProgress) {
  const users = [];
  let nextMaxId = null;
  let page = 0;

  do {
    page++;
    const url = nextMaxId
      ? `${API_BASE}/friendships/${userId}/followers/?count=200&max_id=${nextMaxId}`
      : `${API_BASE}/friendships/${userId}/followers/?count=200`;

    const data = await igFetch(url);
    const batch = data?.users || [];
    users.push(...batch);
    nextMaxId = data?.next_max_id || null;

    onProgress?.({ type: 'followers', count: users.length, done: !nextMaxId });

    // Anti-rate-limit : petite pause entre les requêtes
    if (nextMaxId) await sleep(800 + Math.random() * 400);
  } while (nextMaxId);

  return users;
}

// Récupère TOUS les following avec pagination
async function fetchAllFollowing(userId, onProgress) {
  const users = [];
  let nextMaxId = null;
  let page = 0;

  do {
    page++;
    const url = nextMaxId
      ? `${API_BASE}/friendships/${userId}/following/?count=200&max_id=${nextMaxId}`
      : `${API_BASE}/friendships/${userId}/following/?count=200`;

    const data = await igFetch(url);
    const batch = data?.users || [];
    users.push(...batch);
    nextMaxId = data?.next_max_id || null;

    onProgress?.({ type: 'following', count: users.length, done: !nextMaxId });

    if (nextMaxId) await sleep(800 + Math.random() * 400);
  } while (nextMaxId);

  return users;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Écoute les messages du popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_SCAN') {
    runScan(sendResponse);
    return true; // async response
  }

  if (message.type === 'CHECK_LOGIN') {
    const { userId } = getSessionInfo();
    sendResponse({ loggedIn: !!userId, userId });
    return true;
  }
});

async function runScan(sendResponse) {
  try {
    // Envoie des updates de progression au popup via storage
    const updateProgress = (data) => {
      chrome.storage.local.set({ scanProgress: data });
    };

    updateProgress({ status: 'getting_user', message: 'Récupération du profil...' });

    const userId = await getMyUserId();
    if (!userId) {
      sendResponse({ ok: false, error: 'Impossible de récupérer ton ID Instagram. Es-tu bien connecté ?' });
      return;
    }

    updateProgress({ status: 'fetching_followers', message: 'Chargement des abonnés...', followersCount: 0, followingCount: 0 });

    // Fetch followers et following en séquence (pas parallèle pour éviter le rate limit)
    const followers = await fetchAllFollowers(userId, (p) => {
      updateProgress({ status: 'fetching_followers', message: `Abonnés : ${p.count} chargés...`, followersCount: p.count, followingCount: 0 });
    });

    updateProgress({ status: 'fetching_following', message: 'Chargement des abonnements...', followersCount: followers.length, followingCount: 0 });

    const following = await fetchAllFollowing(userId, (p) => {
      updateProgress({ status: 'fetching_following', message: `Abonnements : ${p.count} chargés...`, followersCount: followers.length, followingCount: p.count });
    });

    updateProgress({ status: 'analyzing', message: 'Analyse en cours...' });

    // Calcul des "fantômes" — ceux que je suis mais qui ne me suivent pas
    const followerIds = new Set(followers.map(u => u.pk || u.id));
    const ghosts = following.filter(u => !followerIds.has(u.pk || u.id)).map(u => ({
      id: u.pk || u.id,
      username: u.username,
      full_name: u.full_name || '',
      profile_pic_url: u.profile_pic_url || '',
      is_private: u.is_private || false,
      is_verified: u.is_verified || false,
    }));

    const result = {
      ok: true,
      ghosts,
      totalFollowers: followers.length,
      totalFollowing: following.length,
      scannedAt: new Date().toISOString()
    };

    // Sauvegarde le résultat
    chrome.storage.local.set({ lastResult: result, scanProgress: { status: 'done' } });
    sendResponse(result);

  } catch (err) {
    chrome.storage.local.set({ scanProgress: { status: 'error', message: err.message } });
    sendResponse({ ok: false, error: err.message });
  }
}
