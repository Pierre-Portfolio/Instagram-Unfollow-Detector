// Background service worker
// Reçoit les messages du content script et du popup

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FETCH_IG') {
    fetchInstagram(message.url, message.headers)
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // async
  }
});

async function fetchInstagram(url, extraHeaders = {}) {
  const response = await fetch(url, {
    headers: {
      'x-ig-app-id': '936619743392459',
      'x-asbd-id': '198387',
      'x-ig-www-claim': '0',
      'Accept': '*/*',
      ...extraHeaders
    },
    credentials: 'include'
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}
