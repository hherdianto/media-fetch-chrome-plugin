/**
 * TikTok In-Page Network Interceptor (Runs in MAIN world)
 * Intercepts TikTok's internal fetch & XHR responses (api/item/detail, api/comment/list,
 * item_list feeds, search results, and user profile details)
 * and relays them via CustomEvent to the isolated content script.
 */
(function() {
  if (window.__TIKTOK_INTERCEPTOR_INSTALLED__) return;
  window.__TIKTOK_INTERCEPTOR_INSTALLED__ = true;

  window.__TIKTOK_CAPTURED_ITEMS__ = window.__TIKTOK_CAPTURED_ITEMS__ || {};
  window.__TIKTOK_CAPTURED_COMMENTS__ = window.__TIKTOK_CAPTURED_COMMENTS__ || {};
  window.__TIKTOK_USER_STATS__ = window.__TIKTOK_USER_STATS__ || {};

  const MAX_CACHE_ENTRIES = 120;
  const itemKeys = [];
  const commentKeys = [];
  const userKeys = [];

  function saveItem(id, item) {
    if (!id || !item) return;
    const sId = String(id);
    if (!window.__TIKTOK_CAPTURED_ITEMS__[sId]) {
      itemKeys.push(sId);
      if (itemKeys.length > MAX_CACHE_ENTRIES) {
        const oldest = itemKeys.shift();
        delete window.__TIKTOK_CAPTURED_ITEMS__[oldest];
      }
    }
    // Enrich with cached user stats if item lacks them
    const authorName = (typeof item.author === 'string' ? item.author : (item.author?.uniqueId || item.author?.unique_id || '')).toLowerCase();
    if (authorName && window.__TIKTOK_USER_STATS__[authorName]) {
      const uStats = window.__TIKTOK_USER_STATS__[authorName];
      if (!item.authorStats || (!item.authorStats.followerCount && !item.authorStats.heartCount)) {
        item.authorStats = {
          followerCount: uStats.followerCount || 0,
          followingCount: uStats.followingCount || 0,
          heartCount: uStats.heartCount || 0,
          videoCount: uStats.videoCount || 0
        };
      }
      if (typeof item.author === 'string') {
        item.author = {
          uniqueId: uStats.uniqueId,
          nickname: uStats.nickname,
          avatarLarger: uStats.avatar,
          verified: uStats.verified,
          signature: uStats.signature
        };
      }
    }
    window.__TIKTOK_CAPTURED_ITEMS__[sId] = item;
    broadcastData('item', item);
  }

  function saveComments(awemeId, comments) {
    if (!awemeId || !Array.isArray(comments) || comments.length === 0) return;
    const sId = String(awemeId);
    if (!window.__TIKTOK_CAPTURED_COMMENTS__[sId]) {
      commentKeys.push(sId);
      if (commentKeys.length > MAX_CACHE_ENTRIES) {
        const oldest = commentKeys.shift();
        delete window.__TIKTOK_CAPTURED_COMMENTS__[oldest];
      }
      window.__TIKTOK_CAPTURED_COMMENTS__[sId] = [];
    }
    const existing = window.__TIKTOK_CAPTURED_COMMENTS__[sId];
    const existingIds = new Set(existing.map((c) => String(c.cid || c.id || '')));
    for (const c of comments) {
      const cid = String(c.cid || c.id || '');
      if (cid && !existingIds.has(cid)) {
        existing.push(c);
        existingIds.add(cid);
      }
    }
    broadcastData('comments', { awemeId: sId, comments: existing });
  }

  function saveUserStats(userObj, statsObj) {
    if (!userObj) return;
    const uniqueId = String(userObj.uniqueId || userObj.unique_id || userObj.name || '').toLowerCase();
    if (!uniqueId) return;
    const payload = {
      uniqueId: userObj.uniqueId || userObj.unique_id || '',
      nickname: userObj.nickname || '',
      avatar: userObj.avatarLarger || userObj.avatarMedium || userObj.avatarThumb || '',
      verified: Boolean(userObj.verified || userObj.custom_verify),
      signature: userObj.signature || '',
      followerCount: statsObj?.followerCount || statsObj?.fans || 0,
      followingCount: statsObj?.followingCount || statsObj?.following || 0,
      heartCount: statsObj?.heartCount || statsObj?.heart || 0,
      videoCount: statsObj?.videoCount || statsObj?.video || 0
    };
    if (!window.__TIKTOK_USER_STATS__[uniqueId]) {
      userKeys.push(uniqueId);
      if (userKeys.length > MAX_CACHE_ENTRIES) {
        const oldest = userKeys.shift();
        delete window.__TIKTOK_USER_STATS__[oldest];
      }
    }
    window.__TIKTOK_USER_STATS__[uniqueId] = payload;
    broadcastData('user', payload);
  }

  function broadcastData(type, payload) {
    try {
      window.dispatchEvent(
        new CustomEvent('TIKTOK_INTERCEPTED_DATA', {
          detail: { type, payload }
        })
      );
    } catch (_) {}
  }

  function isRelevantTikTokUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return (
      url.includes('/api/item/detail') ||
      url.includes('/api/comment/list') ||
      url.includes('/api/user/detail') ||
      url.includes('item_list') ||
      url.includes('/api/search/')
    );
  }

  function processParsedJson(url, json) {
    if (!json || typeof json !== 'object') return;

    // 1. User detail endpoint: /api/user/detail/
    if (json.userInfo) {
      saveUserStats(json.userInfo.user, json.userInfo.stats);
    }

    // 2. Single item detail: /api/item/detail/
    if (json?.itemInfo?.itemStruct) {
      const item = json.itemInfo.itemStruct;
      const sId = String(item.id || item.awemeId || item.aweme_id || item.itemId || item.item_id || '');
      if (sId) {
        saveItem(sId, item);
      }
    }

    // 3. Batch item lists (recommend, post, related, explore, challenge, music, search)
    const rawList = json.itemList || json.items || json.item_list || json.data || [];
    if (Array.isArray(rawList)) {
      for (const entry of rawList) {
        const item = entry?.itemStruct || entry?.item || entry;
        if (item && typeof item === 'object') {
          const sId = String(item.id || item.awemeId || item.aweme_id || item.itemId || item.item_id || '');
          if (sId) {
            saveItem(sId, item);
          }
        }
      }
    }

    // 4. Comments: /api/comment/list/
    if (url.includes('/api/comment/list') || json.comments) {
      const comments = json.comments || [];
      const awemeIdMatch = url.match(/(?:aweme_?id|item_?id)=(\d+)/i);
      const awemeId = awemeIdMatch ? awemeIdMatch[1] : '';
      if (awemeId && Array.isArray(comments) && comments.length > 0) {
        saveComments(awemeId, comments);
      }
    }
  }

  // 1. Intercept window.fetch
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function(...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || args[0]?.href || String(args[0] || ''));
        if (isRelevantTikTokUrl(url)) {
          const clone = response.clone();
          clone.text().then(text => {
            if (!text || !text.trim()) return;
            try {
              const json = JSON.parse(text);
              processParsedJson(url, json);
            } catch (_) {}
          }).catch(() => {});
        }
      } catch (_) {}
      return response;
    };
  }

  // 2. Intercept XMLHttpRequest
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._tiktokInterceptUrl = typeof url === 'string' ? url : String(url || '');
    return originalXhrOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', function() {
      try {
        const url = this._tiktokInterceptUrl || '';
        if (isRelevantTikTokUrl(url)) {
          let json = null;
          if (this.responseType === 'json') {
            json = this.response;
          } else if (!this.responseType || this.responseType === 'text') {
            const text = this.responseText;
            if (!text || !text.trim()) return;
            json = JSON.parse(text);
          }
          if (json && typeof json === 'object') {
            processParsedJson(url, json);
          }
        }
      } catch (_) {}
    });
    return originalXhrSend.apply(this, args);
  };

  // 3. Bidirectional request/response channel with isolated content script
  window.addEventListener('TIKTOK_REQUEST_CAPTURED_DATA', (e) => {
    try {
      const targetId = String(e.detail?.videoId || '');
      let item = null;
      if (targetId && window.__TIKTOK_CAPTURED_ITEMS__[targetId]) {
        item = window.__TIKTOK_CAPTURED_ITEMS__[targetId];
      }
      const targetComments = (targetId && window.__TIKTOK_CAPTURED_COMMENTS__[targetId]) || null;
      const allItems = Object.values(window.__TIKTOK_CAPTURED_ITEMS__ || {});
      const allUserStats = window.__TIKTOK_USER_STATS__ || {};
      const allComments = window.__TIKTOK_CAPTURED_COMMENTS__ || {};
      window.dispatchEvent(
        new CustomEvent('TIKTOK_RESPOND_CAPTURED_DATA', {
          detail: {
            targetId,
            item,
            allItems,
            allUserStats,
            comments: targetComments,
            allComments
          }
        })
      );
    } catch (_) {}
  });
})();
