// Content script — s'exécute dans le contexte d'Instagram
// Peut accéder aux cookies et à la session Instagram

const API_BASE = 'https://www.instagram.com/api/v1';

// Récupère le user_id et le csrftoken depuis les cookies
function getSessionInfo() {
  const cookies = document.cookie.split(';').reduce((acc, c) => {
    const [k, v] = c.trim().split('=');
    acc[k] = v;
    return acc;
  }, {});

  const userId = cookies['ds_user_id'];
  const csrfToken = cookies['csrftoken'];

  return { userId, csrfToken };
}

// Fetch depuis le content script (même origine, credentials inclus)
// Backoff automatique sur rate-limit (429) avant d'abandonner
async function igFetch(url, retries = 3) {
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
  if (res.status === 429 && retries > 0) {
    await sleep(2000 + Math.random() * 2000);
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
async function fetchAllFriendships(userId, kind, onProgress) {
  const users = [];
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
    users.push(...batch);
    prevMaxId = nextMaxId;
    nextMaxId = data?.next_max_id || null;

    onProgress?.({ count: users.length, done: !nextMaxId });

    // Garde-fous : curseur bloqué ou trop de pages → on arrête
    if (nextMaxId && nextMaxId === prevMaxId) break;
    if (page >= MAX_PAGES) break;

    // Anti-rate-limit : petite pause entre les requêtes
    if (nextMaxId) await sleep(800 + Math.random() * 400);
  } while (nextMaxId);

  return users;
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
    const followers = await fetchAllFriendships(userId, 'followers', (p) => {
      send({ type: 'progress', status: 'fetching_followers', followersCount: p.count, followingCount: 0 });
    });

    send({ type: 'progress', status: 'fetching_following', followersCount: followers.length, followingCount: 0 });
    const following = await fetchAllFriendships(userId, 'following', (p) => {
      send({ type: 'progress', status: 'fetching_following', followersCount: followers.length, followingCount: p.count });
    });

    send({ type: 'progress', status: 'analyzing' });

    // Calcul des "fantômes" — ceux que je suis mais qui ne me suivent pas
    const key = (u) => u.pk || u.id;
    const followerIds = new Set(followers.map(key));
    const ghosts = following.filter(u => !followerIds.has(key(u))).map(u => ({
      id: key(u),
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

    chrome.storage.local.set({ lastResult: result });
    send({ type: 'result', result });

  } catch (err) {
    send({ type: 'error', error: err.message });
  }
}
