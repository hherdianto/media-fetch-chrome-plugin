// Content Script for TikTok Video & Comment Data Extractor (v1.2.0)
(function () {
  'use strict';

  if (window.__tiktokExtractorLoaded) return;
  window.__tiktokExtractorLoaded = true;

  let isExtracting = false;

  // In-memory cache for items & comments captured by tiktok-interceptor.js (max 60 entries)
  const MAX_CACHE_ENTRIES = 60;
  const interceptedItems = new Map();
  const interceptedComments = new Map();
  const cachedUserStats = new Map();

  function cacheSet(map, key, value) {
    if (map.has(key)) {
      map.delete(key);
    } else if (map.size >= MAX_CACHE_ENTRIES) {
      const firstKey = map.keys().next().value;
      if (firstKey !== undefined) map.delete(firstKey);
    }
    map.set(key, value);
  }

  window.addEventListener('TIKTOK_INTERCEPTED_DATA', (e) => {
    try {
      const { type, payload } = e?.detail || {};
      if (type === 'item' && payload) {
        const id = String(payload.id || payload.awemeId || '');
        if (id) cacheSet(interceptedItems, id, payload);
      } else if (type === 'user' && payload?.uniqueId) {
        cacheSet(cachedUserStats, payload.uniqueId.toLowerCase(), payload);
      } else if (type === 'comments' && payload) {
        const { awemeId, comments } = payload;
        if (awemeId && Array.isArray(comments)) {
          const normalized = comments.map(normalizeTikTokComment).filter(Boolean);
          const sId = String(awemeId);
          const existing = interceptedComments.get(sId) || [];
          const existingIds = new Set(existing.map((c) => c.id));
          const merged = [...existing];
          for (const c of normalized) {
            if (c && c.id && !existingIds.has(c.id)) {
              merged.push(c);
              existingIds.add(c.id);
            }
          }
          cacheSet(interceptedComments, sId, merged);
        }
      }
    } catch (_) {}
  });

  // Dynamically inject in-page interceptor if not yet present
  (function injectInterceptor() {
    try {
      if (document.getElementById('__tt_interceptor__')) return;
      const script = document.createElement('script');
      script.id = '__tt_interceptor__';
      script.src = chrome.runtime.getURL('tiktok-interceptor.js');
      (document.head || document.documentElement).appendChild(script);
    } catch (_) {}
  })();

  /**
   * Helper: Request captured data from MAIN world (tiktok-interceptor.js)
   */
  async function fetchInterceptedDataFromMainWorld(videoId) {
    if (!videoId) return null;
    const sId = String(videoId);
    if (interceptedItems.has(sId)) {
      return interceptedItems.get(sId);
    }

    return new Promise((resolve) => {
      let resolved = false;
      const onResponse = (e) => {
        if (!resolved) {
          resolved = true;
          window.removeEventListener('TIKTOK_RESPOND_CAPTURED_DATA', onResponse);
          const { item, allItems, allUserStats, comments, allComments } = e.detail || {};
          if (allUserStats && typeof allUserStats === 'object') {
            for (const [k, v] of Object.entries(allUserStats)) {
              if (v && v.uniqueId) cacheSet(cachedUserStats, k.toLowerCase(), v);
            }
          }
          if (Array.isArray(allItems)) {
            for (const it of allItems) {
              const itId = String(it.id || it.awemeId || it.aweme_id || it.itemId || it.item_id || '');
              if (itId) cacheSet(interceptedItems, itId, it);
            }
          }
          if (allComments && typeof allComments === 'object') {
            for (const [cId, cList] of Object.entries(allComments)) {
              if (Array.isArray(cList) && cList.length > 0) {
                const normalized = cList.map(normalizeTikTokComment).filter(Boolean);
                cacheSet(interceptedComments, cId, normalized);
              }
            }
          }
          if (Array.isArray(comments) && comments.length > 0) {
            const normalized = comments.map(normalizeTikTokComment).filter(Boolean);
            cacheSet(interceptedComments, sId, normalized);
          }
          if (item) {
            cacheSet(interceptedItems, sId, item);
            resolve(item);
          } else {
            resolve(interceptedItems.get(sId) || null);
          }
        }
      };

      window.addEventListener('TIKTOK_RESPOND_CAPTURED_DATA', onResponse);
      window.dispatchEvent(new CustomEvent('TIKTOK_REQUEST_CAPTURED_DATA', { detail: { videoId: sId } }));

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          window.removeEventListener('TIKTOK_RESPOND_CAPTURED_DATA', onResponse);
          resolve(interceptedItems.get(sId) || null);
        }
      }, 350);
    });
  }

  /**
   * Helper: Safely extract caption text without toggle buttons ("more", "less", etc.)
   */
  function getCleanCaptionText(el) {
    if (!el) return '';
    try {
      // If there is an expandable "more" button, attempt to click it to expand text
      const moreBtn = el.querySelector('button, [role="button"], span[class*="More"], span[class*="more"], [data-e2e="video-desc-more"]');
      if (moreBtn && typeof moreBtn.click === 'function') {
        try { moreBtn.click(); } catch (_) {}
      }
      const clone = el.cloneNode(true);
      const buttons = clone.querySelectorAll('button, [role="button"], span[class*="More"], span[class*="more"], span[class*="Expand"], [data-e2e="video-desc-more"]');
      buttons.forEach((b) => b.remove());
      let t = clone.textContent.trim();
      return t.replace(/\s*(?:\.{3}|…)?\s*(?:less|more|selengkapnya|lebih sedikit)\s*$/i, '').trim();
    } catch (_) {
      return el.textContent.trim().replace(/\s*(?:\.{3}|…)?\s*(?:less|more|selengkapnya|lebih sedikit)\s*$/i, '').trim();
    }
  }

  /**
   * Helper: Parse formatted number strings accurately to integer.
   * Handles: "14.2K", "1.5M", "2B", "14,2 rb", etc.
   */
  function parseAccurateNumber(rawStr) {
    if (typeof rawStr === 'number') return Math.round(rawStr);
    if (!rawStr || typeof rawStr !== 'string') return 0;

    const trimmed = rawStr.trim();
    if (!trimmed) return 0;

    const suffixPatterns = [
      { regex: /([\d.,]+)\s*(?:jt|juta|m(?:illion)?)\b/i, multiplier: 1_000_000 },
      { regex: /([\d.,]+)\s*(?:rb|ribu|k)\b/i, multiplier: 1_000 },
      { regex: /([\d.,]+)\s*(?:miliar|mil|b(?:illion)?)\b/i, multiplier: 1_000_000_000 }
    ];

    for (const { regex, multiplier } of suffixPatterns) {
      const match = trimmed.match(regex);
      if (match) {
        const numStr = match[1].replace(/,/g, '.');
        const val = parseFloat(numStr);
        if (!isNaN(val)) return Math.round(val * multiplier);
      }
    }

    const cleanDigits = trimmed.replace(/[^\d]/g, '');
    if (cleanDigits) {
      const parsed = parseInt(cleanDigits, 10);
      return isNaN(parsed) ? 0 : parsed;
    }

    return 0;
  }

  /**
   * Helper: Toast notifications on TikTok page
   */
  function showToast({ title, message, type = 'info', badge = '', meta = '' }) {
    let container = document.querySelector('.ig-extractor-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'ig-extractor-toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `ig-extractor-toast ${type}`;

    const iconMap = {
      success: '✓',
      info: 'ℹ',
      warning: '⚠',
      error: '✕'
    };

    const iconDiv = document.createElement('div');
    iconDiv.className = 'ig-extractor-icon';
    iconDiv.textContent = iconMap[type] || 'ℹ';
    toast.appendChild(iconDiv);

    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'ig-extractor-body';

    const titleDiv = document.createElement('div');
    titleDiv.className = 'ig-extractor-title';

    const titleSpan = document.createElement('span');
    titleSpan.textContent = title;
    titleDiv.appendChild(titleSpan);

    if (badge) {
      const badgeSpan = document.createElement('span');
      badgeSpan.className = 'ig-extractor-badge';
      badgeSpan.textContent = badge;
      titleDiv.appendChild(badgeSpan);
    }
    bodyDiv.appendChild(titleDiv);

    const descDiv = document.createElement('div');
    descDiv.className = 'ig-extractor-desc';
    descDiv.textContent = message;
    bodyDiv.appendChild(descDiv);

    if (meta) {
      const metaDiv = document.createElement('div');
      metaDiv.className = 'ig-extractor-meta';
      const metaSpan = document.createElement('span');
      metaSpan.textContent = meta;
      metaDiv.appendChild(metaSpan);
      bodyDiv.appendChild(metaDiv);
    }

    toast.appendChild(bodyDiv);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ig-extractor-close';
    closeBtn.title = 'Close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 250);
    });
    toast.appendChild(closeBtn);

    container.appendChild(toast);

    setTimeout(() => {
      if (toast.parentElement) {
        toast.classList.add('fade-out');
        setTimeout(() => toast.remove(), 250);
      }
    }, 4500);
  }

  /**
   * Helper: Eagerly populate cachedUserStats from __UNIVERSAL_DATA_FOR_REHYDRATION__
   */
  function populateUserStatsFromUniversalData() {
    try {
      const script = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
      if (script && script.textContent) {
        const json = JSON.parse(script.textContent);
        const defaultScope = json['__DEFAULT_SCOPE__'] || {};
        if (defaultScope['webapp.user-detail']?.userInfo) {
          const u = defaultScope['webapp.user-detail'].userInfo.user || {};
          const s = defaultScope['webapp.user-detail'].userInfo.stats || {};
          const name = (u.uniqueId || u.unique_id || '').toLowerCase();
          if (name) {
            cacheSet(cachedUserStats, name, {
              id: u.id || '',
              uniqueId: u.uniqueId || u.unique_id || '',
              nickname: u.nickname || '',
              avatar: u.avatarLarger || u.avatarMedium || u.avatarThumb || '',
              verified: Boolean(u.verified),
              signature: u.signature || '',
              followerCount: s.followerCount || s.fans || 0,
              followingCount: s.followingCount || s.following || 0,
              heartCount: s.heartCount || s.heart || 0,
              videoCount: s.videoCount || s.video || 0
            });
          }
        }
      }
    } catch (_) {}
  }

  // Eagerly populate user stats on content script load
  populateUserStatsFromUniversalData();

  /**
   * Helper: Extract author profile statistics from DOM header (useful on profile pages like /@username)
   */
  function getProfileDomUserStats(targetUsername = '') {
    try {
      const headerContainer = document.querySelector('[data-e2e="user-header"], div[class*="DivShareLayoutHeader"], div[class*="ShareHeader"], header');
      const scopeEl = headerContainer || document;

      const followEl = scopeEl.querySelector('[data-e2e="user-follow-count"], [data-e2e="following-count"], [title="Following"], [title="Mengikuti"]');
      const fansEl = scopeEl.querySelector('[data-e2e="user-fans"], [data-e2e="followers-count"], [title="Followers"], [title="Pengikut"]');
      const likesEl = scopeEl.querySelector('[data-e2e="user-likes"], [data-e2e="likes-count"], [title="Likes"], [title="Suka"]');
      const titleEl = scopeEl.querySelector('[data-e2e="user-title"], [data-e2e="user-subtitle"], h1, h2');
      const bioEl = scopeEl.querySelector('[data-e2e="user-bio"], [data-e2e="user-signature"]');
      const avatarEl = scopeEl.querySelector('[data-e2e="user-avatar"] img, img[class*="ImgAvatar"]');

      if (fansEl || followEl || likesEl) {
        const usernameMatch = headerContainer?.querySelector('[data-e2e="user-title"]')?.textContent.trim().replace(/^@/, '') || '';
        if (!usernameMatch || !targetUsername || usernameMatch.toLowerCase() !== targetUsername.replace(/^@/, '').toLowerCase()) {
          return null;
        }
        const stats = {
          uniqueId: usernameMatch,
          nickname: titleEl ? titleEl.textContent.trim() : usernameMatch,
          avatar: avatarEl ? avatarEl.src : '',
          verified: Boolean(scopeEl.querySelector('[data-e2e="user-title"] svg, [data-e2e="user-subtitle"] svg, svg[class*="VerifiedBadge"]')),
          signature: bioEl ? bioEl.textContent.trim() : '',
          followerCount: parseAccurateNumber(fansEl?.textContent || '0'),
          followingCount: parseAccurateNumber(followEl?.textContent || '0'),
          heartCount: parseAccurateNumber(likesEl?.textContent || '0'),
          videoCount: 0
        };
        if (usernameMatch) {
          cacheSet(cachedUserStats, usernameMatch.toLowerCase(), stats);
        }
        return stats;
      }
    } catch (_) {}
    return null;
  }

  /**
   * Helper: Locate active post container in DOM (supports modal dialogs, mouse scroll in feeds, search & explore)
   */
  function getActivePostContainer(targetVideoId = null) {
    // 1. Check for open modal / browse-mode dialog FIRST (visible full-screen or popup view)
    const modals = Array.from(document.querySelectorAll(
      '[data-e2e="browse-mode-container"], ' +
      '[data-e2e="video-detail-container"], ' +
      '[data-e2e="photo-detail-container"], ' +
      'div[class*="DivDetailContainer"], ' +
      'div[class*="DivBrowseModeContainer"], ' +
      'div[class*="DivModalContainer"], ' +
      'div[role="dialog"]'
    ));

    for (const m of modals) {
      if (m.offsetParent !== null || (window.getComputedStyle(m).display !== 'none' && window.getComputedStyle(m).visibility !== 'hidden')) {
        if (m.querySelector('video, [data-e2e="browse-video-desc"], [data-e2e="photo-desc"], [data-e2e="video-desc"], div[class*="DivPhotoPlayer"], div[class*="DivSlideContainer"], [data-e2e="image-player"], [data-e2e="browse-like-count"]')) {
          return m;
        }
      }
    }

    // 2. Check if there is an actively playing video in feed
    const playingVideo = Array.from(document.querySelectorAll('video')).find(v => !v.paused && v.duration > 0);
    if (playingVideo) {
      const parentCard = playingVideo.closest(
        '[data-e2e="recommend-list-item-container"], ' +
        '[data-e2e="feed-item"], ' +
        'div[class*="DivItemContainer"], ' +
        'div[class*="DivVideoWrapper"], ' +
        'article, section'
      );
      if (parentCard) return parentCard;
    }

    // 3. Viewport proximity check (for mouse scroll navigation in feed, explore, search)
    const candidateCards = Array.from(document.querySelectorAll(
      '[data-e2e="recommend-list-item-container"], ' +
      '[data-e2e="feed-item"], ' +
      'div[class*="DivItemContainer"], ' +
      'div[class*="DivVideoWrapper"], ' +
      '[data-e2e="search-card-container"], ' +
      'article, section'
    ));

    const windowCenter = window.innerHeight / 2;
    let closestCard = null;
    let minDistance = Infinity;

    for (const card of candidateCards) {
      const rect = card.getBoundingClientRect();
      if (rect.height < 100 || rect.height > window.innerHeight * 1.5 || rect.bottom <= 50 || rect.top >= window.innerHeight - 50) {
        continue;
      }
      const cardCenter = rect.top + rect.height / 2;
      const distance = Math.abs(cardCenter - windowCenter);
      if (distance < minDistance) {
        minDistance = distance;
        closestCard = card;
      }
    }

    if (closestCard) return closestCard;

    // 4. If targetVideoId is specified and no modal/viewport match, find card containing that link
    if (targetVideoId) {
      const specificLink = document.querySelector(`a[href*="/video/${targetVideoId}"], a[href*="/photo/${targetVideoId}"]`);
      if (specificLink) {
        const parentCard = specificLink.closest(
          '[data-e2e="recommend-list-item-container"], ' +
          '[data-e2e="feed-item"], ' +
          'div[class*="DivItemContainer"], ' +
          'div[class*="DivVideoWrapper"], ' +
          '[data-e2e="search-card-container"], ' +
          'article, section'
        );
        if (parentCard) return parentCard;
      }
    }

    return document.body;
  }

  /**
   * Helper: Detect TikTok Video ID and Author from URL, active modal, or viewport-centered post
   */
  function getTikTokIdentifier(passedUrl = null) {
    const candidates = [passedUrl, window.location.href, window.location.pathname, document.URL].filter(Boolean);

    for (const urlStr of candidates) {
      const match = urlStr.match(/(?:@([\w.-]+)\/)?(?:video|photo)\/(\d+)/i);
      if (match) {
        return {
          videoId: match[2],
          username: match[1] || '',
          activeElement: getActivePostContainer(match[2])
        };
      }

      // Check /v/<videoId>
      const matchShort = urlStr.match(/\/v\/(\d+)/i);
      if (matchShort) {
        return {
          videoId: matchShort[1],
          username: '',
          activeElement: getActivePostContainer(matchShort[1])
        };
      }
    }

    // Viewport or active container post detection (handles mouse scroll in feed, search, explore)
    const activeEl = getActivePostContainer();
    if (activeEl) {
      const activeLinks = Array.from(activeEl.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]'));
      for (const link of activeLinks) {
        const href = link.getAttribute('href') || '';
        const m = href.match(/(?:@([\w.-]+)\/)?(?:video|photo)\/(\d+)/i);
        if (m) {
          return {
            videoId: m[2],
            username: m[1] || '',
            activeElement: activeEl
          };
        }
      }
    }

    // Fallback: search all video/photo links in document
    const anyLink = document.querySelector('a[href*="/video/"], a[href*="/photo/"]');
    if (anyLink) {
      const href = anyLink.getAttribute('href') || '';
      const m = href.match(/(?:@([\w.-]+)\/)?(?:video|photo)\/(\d+)/i);
      if (m) {
        return {
          videoId: m[2],
          username: m[1] || '',
          activeElement: anyLink.closest('article, section, div[class*="DivItemContainer"]') || document.body
        };
      }
    }

    return null;
  }

  /**
   * Recursively search for itemStruct object in JSON tree
   */
  function findItemStructInObject(obj, targetId = null, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 20) return null;

    if (obj.itemStruct && typeof obj.itemStruct === 'object') {
      const sId = String(obj.itemStruct.id || obj.itemStruct.awemeId || obj.itemStruct.aweme_id || obj.itemStruct.itemId || obj.itemStruct.item_id || '');
      if (!targetId || sId === String(targetId)) {
        return obj.itemStruct;
      }
    }

    const currentId = String(obj.id || obj.awemeId || obj.aweme_id || obj.itemId || obj.item_id || '');
    if (currentId && (!targetId || currentId === String(targetId))) {
      if (obj.author || obj.authorStats || obj.stats || obj.imagePost || obj.video || (obj.desc !== undefined && obj.desc !== '')) {
        return obj;
      }
    }

    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        const found = findItemStructInObject(obj[key], targetId, depth + 1);
        if (found) return found;
      }
    }

    return null;
  }

  /**
   * Helper: Enrich an item with author profile and stats if missing
   */
  function enrichItemWithUserStats(item) {
    if (!item) return null;
    const authorName = (typeof item.author === 'string' ? item.author : (item.author?.uniqueId || item.author?.unique_id || '')).toLowerCase();
    const statsObj = cachedUserStats.get(authorName) || getProfileDomUserStats(authorName) || null;

    if (statsObj) {
      if (typeof item.author === 'string' || !item.author?.id) {
        item.author = {
          id: item.author?.id || '',
          uniqueId: statsObj.uniqueId || authorName,
          nickname: item.author?.nickname || statsObj.nickname || authorName,
          avatarLarger: item.author?.avatarLarger || statsObj.avatar || '',
          signature: item.author?.signature || statsObj.signature || '',
          verified: Boolean(item.author?.verified || statsObj.verified)
        };
      }
      if (!item.authorStats || (!item.authorStats.followerCount && !item.authorStats.heartCount)) {
        item.authorStats = {
          followerCount: statsObj.followerCount || 0,
          followingCount: statsObj.followingCount || 0,
          heartCount: statsObj.heartCount || 0,
          videoCount: statsObj.videoCount || 0
        };
      }
    }
    return item;
  }

  /**
   * Strategy 1: Read __UNIVERSAL_DATA_FOR_REHYDRATION__ script tag
   */
  function extractFromUniversalData(videoId) {
    try {
      const script = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
      if (script && script.textContent) {
        const json = JSON.parse(script.textContent);
        const defaultScope = json['__DEFAULT_SCOPE__'] || {};

        // Cache user detail from webapp.user-detail if available
        if (defaultScope['webapp.user-detail']?.userInfo) {
          const u = defaultScope['webapp.user-detail'].userInfo.user || {};
          const s = defaultScope['webapp.user-detail'].userInfo.stats || {};
          const name = (u.uniqueId || u.unique_id || '').toLowerCase();
          if (name) {
            cachedUserStats.set(name, {
              uniqueId: u.uniqueId || u.unique_id || '',
              nickname: u.nickname || '',
              avatar: u.avatarLarger || u.avatarMedium || u.avatarThumb || '',
              verified: Boolean(u.verified),
              signature: u.signature || '',
              followerCount: s.followerCount || s.fans || 0,
              followingCount: s.followingCount || s.following || 0,
              heartCount: s.heartCount || s.heart || 0,
              videoCount: s.videoCount || s.video || 0
            });
          }
        }

        for (const scopeKey of Object.keys(defaultScope)) {
          const scopeObj = defaultScope[scopeKey];
          if (!scopeObj || typeof scopeObj !== 'object') continue;

          if (scopeObj?.itemInfo?.itemStruct) {
            const item = scopeObj.itemInfo.itemStruct;
            const itemId = String(item.id || item.awemeId || item.aweme_id || item.itemId || item.item_id || '');
            if (!videoId || itemId === String(videoId)) {
              return enrichItemWithUserStats(item);
            }
          }
          if (scopeObj?.itemStruct) {
            const item = scopeObj.itemStruct;
            const itemId = String(item.id || item.awemeId || item.aweme_id || item.itemId || item.item_id || '');
            if (!videoId || itemId === String(videoId)) {
              return enrichItemWithUserStats(item);
            }
          }
          // Check itemList / items in user-post-list, explore, etc.
          const rawItems = scopeObj?.itemList || scopeObj?.items || scopeObj?.postList || scopeObj?.data;
          if (Array.isArray(rawItems)) {
            for (const entry of rawItems) {
              const it = entry?.itemStruct || entry;
              if (it && typeof it === 'object') {
                const itId = String(it.id || it.awemeId || it.aweme_id || it.itemId || it.item_id || '');
                if (!videoId || itId === String(videoId)) {
                  return enrichItemWithUserStats(it);
                }
              }
            }
          }
        }

        const itemAny = findItemStructInObject(json, videoId);
        if (itemAny) return enrichItemWithUserStats(itemAny);
      }
    } catch (e) {
      console.warn('[TikTok Extractor] __UNIVERSAL_DATA_FOR_REHYDRATION__ parse failed:', e);
    }
    return null;
  }

  /**
   * Strategy 2: Read SIGI_STATE script tag
   */
  function extractFromSigiState(videoId) {
    try {
      const script = document.getElementById('SIGI_STATE');
      if (script && script.textContent) {
        const json = JSON.parse(script.textContent);
        if (json.ItemModule) {
          let item = null;
          if (videoId) {
            if (json.ItemModule[videoId]) {
              item = json.ItemModule[videoId];
            }
          } else {
            const keys = Object.keys(json.ItemModule);
            if (keys.length > 0) item = json.ItemModule[keys[0]];
          }

          if (item) {
            // Resolve author from UserModule if author is string handle
            if (typeof item.author === 'string' && json.UserModule && json.UserModule[item.author]) {
              const u = json.UserModule[item.author];
              item.author = {
                id: u.id || '',
                uniqueId: u.uniqueId || item.author,
                nickname: u.nickname || u.uniqueId || item.author,
                avatarLarger: u.avatarLarger || u.avatarMedium || u.avatarThumb || '',
                signature: u.signature || '',
                verified: Boolean(u.verified)
              };
              if (u.fans !== undefined || u.following !== undefined) {
                item.authorStats = {
                  followerCount: u.fans || 0,
                  followingCount: u.following || 0,
                  heartCount: u.heart || 0,
                  videoCount: u.video || 0
                };
              }
            }
            return item;
          }
        }
      }
    } catch (e) {
      console.warn('[TikTok Extractor] SIGI_STATE parse failed:', e);
    }
    return null;
  }

  /**
   * Strategy 3: Read __NEXT_DATA__ script tag
   */
  function extractFromNextData(videoId) {
    try {
      const script = document.getElementById('__NEXT_DATA__');
      if (script && script.textContent) {
        const json = JSON.parse(script.textContent);
        const item = json.props?.pageProps?.itemInfo?.itemStruct;
        if (item && (!videoId || String(item.id || item.awemeId) === String(videoId))) {
          return item;
        }
        const found = findItemStructInObject(json, videoId);
        if (found) return found;
      }
    } catch (e) {
      console.warn('[TikTok Extractor] __NEXT_DATA__ parse failed:', e);
    }
    return null;
  }

  /**
   * Strategy 4: Fetch item detail from TikTok Web API
   */
  async function fetchFromTikTokApi(videoId) {
    if (!videoId) return null;
    try {
      const url = `https://www.tiktok.com/api/item/detail/?aid=1988&app_name=tiktok_web&device_platform=web_pc&coverFormat=2&itemId=${videoId}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json, text/plain, */*'
        },
        credentials: 'include'
      });
      if (!res.ok) return null;
      const text = await res.text();
      if (!text || !text.trim()) return null;
      let data = null;
      try {
        data = JSON.parse(text);
      } catch (_) {
        return null;
      }
      return data?.itemInfo?.itemStruct || null;
    } catch (e) {
      console.warn('[TikTok Extractor] API item detail fetch failed:', e);
      return null;
    }
  }

  /**
   * Helper: Format Unix timestamp (seconds) into ISO 8601 with +00:00 timezone offset
   * e.g. 1794456199 -> "2026-11-12T04:03:19+00:00"
   */
  function formatIsoWithOffset(timestampSeconds) {
    if (!timestampSeconds) {
      return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
    }
    try {
      const d = new Date(timestampSeconds * 1000);
      return d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
    } catch (_) {
      return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
    }
  }

  /**
   * Strategy 5: Extract from DOM & Meta tags (Supports both Video and Photo slides, modal and feed scroll)
   */
  function extractFromTikTokDom(videoId, username, activeContainer = null) {
    const container = activeContainer || getActivePostContainer(videoId);

    const isPhoto = window.location.pathname.includes('/photo/') ||
                    Boolean(container?.querySelector('div[class*="DivPhotoPlayer"], div[class*="DivSlideContainer"], [data-e2e="image-player"], picture img'));

    const isModalOrBody = !container || container === document.body || (typeof container.matches === 'function' && container.matches('[data-e2e*="container"], [class*="Container"], [role="dialog"]'));

    const descCandidates = [
      container?.querySelector('[data-e2e="browse-video-desc"]'),
      container?.querySelector('[data-e2e="photo-desc"]'),
      container?.querySelector('[data-e2e="video-desc"]'),
      container?.querySelector('h1[data-e2e="browse-video-desc"]'),
      container?.querySelector('div[class*="DivDescriptionContentWrapper"]'),
      container?.querySelector('div[class*="DivTextWrapper"]'),
      container?.querySelector('div[class*="DivDescription"]'),
      isModalOrBody ? document.querySelector('[data-e2e="browse-video-desc"]') : null,
      isModalOrBody ? document.querySelector('[data-e2e="photo-desc"]') : null,
      isModalOrBody ? document.querySelector('[data-e2e="video-desc"]') : null
    ].filter(Boolean);

    let text = descCandidates[0] ? getCleanCaptionText(descCandidates[0]) : '';

    const authorEl = container.querySelector('[data-e2e="browse-username"], [data-e2e="video-author-uniqueid"], [data-e2e="user-title"], a[href*="/@"]') ||
                     document.querySelector('[data-e2e="browse-username"], [data-e2e="video-author-uniqueid"], [data-e2e="user-title"]');
    const hrefMatch = authorEl?.getAttribute('href')?.match(/@([^/?#]+)/);
    const resolvedUsername = hrefMatch ? hrefMatch[1] : (authorEl ? authorEl.textContent.trim().replace(/^@/, '') : (username || ''));

    const nicknameEl = container.querySelector('[data-e2e="browse-user-nickname"], [data-e2e="user-subtitle"]') ||
                       document.querySelector('[data-e2e="browse-user-nickname"]');
    const resolvedNickname = nicknameEl ? nicknameEl.textContent.trim() : resolvedUsername;

    const avatarEl = container.querySelector('[data-e2e="browse-user-avatar"] img, [data-e2e="user-avatar"] img, img[class*="ImgAvatar"]') ||
                     document.querySelector('[data-e2e="browse-user-avatar"] img, [data-e2e="user-avatar"] img');
    const avatarUrl = avatarEl ? avatarEl.src : '';

    const domVideo = container.querySelector('video') || document.querySelector('video');
    const domPoster = domVideo?.getAttribute('poster') ||
                      container.querySelector('img[class*="ImgPoster"], [data-e2e="video-cover"] img')?.src ||
                      document.querySelector('img[class*="ImgPoster"], [data-e2e="video-cover"] img')?.src || '';

    // Collect photo slide images if present
    const domImages = [];
    if (isPhoto) {
      const imgElements = Array.from(container.querySelectorAll('div[class*="DivPhotoPlayer"] img, div[class*="DivSlideContainer"] img, [data-e2e="image-player"] img, div[class*="DivImageWrapper"] img, picture img'));
      for (const img of imgElements) {
        const src = img.src || img.getAttribute('data-src') || '';
        if (src && src.startsWith('http') && !src.includes('avatar') && !domImages.includes(src)) {
          domImages.push(src);
        }
      }
    }

    const likeEl = container.querySelector('[data-e2e="like-count"], [data-e2e="browse-like-count"], strong[data-e2e="like-count"], [data-e2e="visual-like-count"]') ||
                   (isModalOrBody ? document.querySelector('[data-e2e="browse-like-count"]') : null);
    const commentEl = container.querySelector('[data-e2e="comment-count"], [data-e2e="browse-comment-count"], strong[data-e2e="comment-count"]') ||
                      (isModalOrBody ? document.querySelector('[data-e2e="browse-comment-count"]') : null);
    const shareEl = container.querySelector('[data-e2e="share-count"], [data-e2e="browse-share-count"], strong[data-e2e="share-count"]') ||
                    (isModalOrBody ? document.querySelector('[data-e2e="browse-share-count"]') : null);
    const collectEl = container.querySelector('[data-e2e="bookmark-count"], [data-e2e="browse-bookmark-count"], [data-e2e="collect-count"], [data-e2e="undefined-count"], strong[data-e2e="bookmark-count"]') ||
                      (isModalOrBody ? document.querySelector('[data-e2e="browse-bookmark-count"], [data-e2e="collect-count"]') : null);

    // Author stats from cached stats or profile header DOM
    const lowerUser = resolvedUsername.toLowerCase();
    const userStats = cachedUserStats.get(lowerUser) || getProfileDomUserStats(resolvedUsername) || {};

    return {
      id: videoId || '',
      desc: text,
      createTime: Math.floor(Date.now() / 1000),
      isPhoto,
      author: {
        id: '',
        uniqueId: resolvedUsername,
        nickname: resolvedNickname,
        avatarLarger: avatarUrl || userStats.avatar || '',
        signature: userStats.signature || '',
        verified: Boolean(userStats.verified || container.querySelector('[data-e2e="browse-user-nickname"] svg, [data-e2e="user-title"] svg, svg[class*="VerifiedBadge"]'))
      },
      authorStats: {
        followerCount: userStats.followerCount || 0,
        followingCount: userStats.followingCount || 0,
        heartCount: userStats.heartCount || 0,
        videoCount: userStats.videoCount || 0
      },
      video: {
        height: domVideo?.videoHeight || 1024,
        width: domVideo?.videoWidth || 576,
        duration: domVideo?.duration ? Math.round(domVideo.duration * 1000) : 0,
        cover: domPoster || domImages[0] || '',
        originCover: domPoster || domImages[0] || '',
        dynamicCover: domPoster || domImages[0] || '',
        definition: isPhoto ? 'photo' : '540p',
        format: isPhoto ? 'image' : '',
        playAddr: domVideo?.src || ''
      },
      imagePost: isPhoto && domImages.length > 0 ? {
        images: domImages.map((u) => ({
          imageURL: { urlList: [u] }
        })),
        cover: { urlList: [domImages[0]] }
      } : null,
      stats: {
        diggCount: parseAccurateNumber(likeEl?.textContent || '0'),
        shareCount: parseAccurateNumber(shareEl?.textContent || '0'),
        playCount: 0,
        commentCount: parseAccurateNumber(commentEl?.textContent || '0'),
        collectCount: parseAccurateNumber(collectEl?.textContent || '0')
      },
      challenges: [],
      isAd: false
    };
  }

  /**
   * Normalize raw TikTok comment node
   */
  function normalizeTikTokComment(raw) {
    if (!raw) return null;
    const user = raw.user || {};
    const createTime = parseInt(raw.create_time || raw.createTime || 0, 10);
    const createTimeISO = formatIsoWithOffset(createTime);

    const avatar = user.avatar_thumb?.url_list?.[0] ||
                   user.avatar_larger?.url_list?.[0] ||
                   user.avatar_medium?.url_list?.[0] ||
                   user.avatar ||
                   user.avatarThumb ||
                   '';

    return {
      id: String(raw.cid || raw.id || ''),
      text: String(raw.text || ''),
      createTime,
      createTimeISO,
      diggCount: parseInt(raw.digg_count || raw.diggCount || 0, 10),
      replyCommentTotal: parseInt(raw.reply_comment_total || raw.replyCommentTotal || 0, 10),
      authorMeta: {
        id: String(user.uid || user.id || ''),
        name: user.unique_id || user.uniqueId || user.username || '',
        nickName: user.nickname || user.nickName || '',
        avatar: avatar,
        verified: Boolean(user.custom_verify || user.verified)
      }
    };
  }

  /**
   * Fetch comments from TikTok Web API
   * Endpoint: https://www.tiktok.com/api/comment/list/?aid=1988&aweme_id=<videoId>&count=50&cursor=0
   */
  async function fetchTikTokComments(videoId) {
    if (!videoId) return [];
    try {
      const url = `https://www.tiktok.com/api/comment/list/?aid=1988&aweme_id=${videoId}&count=50&cursor=0`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json, text/plain, */*'
        },
        credentials: 'include'
      });

      if (!res.ok) return [];
      const text = await res.text();
      if (!text || !text.trim()) return [];
      let data = null;
      try {
        data = JSON.parse(text);
      } catch (_) {
        return [];
      }
      if (data && Array.isArray(data.comments)) {
        return data.comments.map(normalizeTikTokComment).filter(Boolean);
      }
    } catch (e) {
      console.warn('[TikTok Extractor] Comments API fetch failed:', e);
    }
    return [];
  }

  /**
   * Extract comments from DOM as fallback
   */
  function extractCommentsFromTikTokDom() {
    const comments = [];
    try {
      const commentItems = Array.from(document.querySelectorAll('[data-e2e="comment-item"], div[class*="DivCommentItemContainer"]'));
      for (const item of commentItems) {
        const userLink = item.querySelector('a[data-e2e="comment-username"], a[href*="/@"]');
        const href = userLink?.getAttribute('href') || '';
        const match = href.match(/@([^/?#]+)/);
        const username = match ? match[1] : (userLink ? userLink.textContent.trim().replace(/^@/, '') : '');
        const nickname = userLink ? userLink.textContent.trim().replace(/^@/, '') : username;

        const avatarImg = item.querySelector('[data-e2e="comment-avatar"] img, img');
        const avatar = avatarImg ? avatarImg.src : '';

        const textEl = item.querySelector('[data-e2e="comment-level-1"] p, p[data-e2e="comment-text"], span[class*="SpanCommentText"]');
        const text = textEl ? textEl.textContent.trim() : '';

        const likeEl = item.querySelector('[data-e2e="comment-like-count"]');
        const diggCount = likeEl ? parseAccurateNumber(likeEl.textContent) : 0;

        if (text) {
          const createTime = Math.floor(Date.now() / 1000);
          comments.push({
            id: '',
            text,
            createTime,
            createTimeISO: formatIsoWithOffset(createTime),
            diggCount,
            replyCommentTotal: 0,
            authorMeta: {
              id: '',
              name: username,
              nickName: nickname,
              avatar,
              verified: false
            }
          });
        }
      }
    } catch (e) {
      console.warn('[TikTok Extractor] DOM comment extraction error:', e);
    }
    return comments;
  }

  /**
   * Normalize extracted raw data into the required TikTok JSON Schema
   */
  function normalizeToTikTokSchema(item, commentsList, videoId, username, activeContainer = null) {
    const id = String(item.id || videoId || '');
    const container = activeContainer || getActivePostContainer(id);
    const isModalOrBody = !container || container === document.body || (typeof container.matches === 'function' && container.matches('[data-e2e*="container"], [class*="Container"], [role="dialog"]'));

    let text = String(item.desc || item.text || '');
    if (!text || text === 'Just watched' || text === 'Baru saja ditonton') {
      const descCandidates = [
        container?.querySelector('[data-e2e="browse-video-desc"]'),
        container?.querySelector('[data-e2e="photo-desc"]'),
        container?.querySelector('[data-e2e="video-desc"]'),
        container?.querySelector('h1[data-e2e="browse-video-desc"]'),
        container?.querySelector('div[class*="DivDescriptionContentWrapper"]'),
        container?.querySelector('div[class*="DivTextWrapper"]'),
        container?.querySelector('div[class*="DivDescription"]'),
        isModalOrBody ? document.querySelector('[data-e2e="browse-video-desc"]') : null,
        isModalOrBody ? document.querySelector('[data-e2e="photo-desc"]') : null,
        isModalOrBody ? document.querySelector('[data-e2e="video-desc"]') : null
      ].filter(Boolean);

      if (descCandidates.length > 0) {
        text = getCleanCaptionText(descCandidates[0]);
      }
    }

    const createTime = parseInt(item.createTime || item.create_time || Math.floor(Date.now() / 1000), 10);
    const createTimeISO = formatIsoWithOffset(createTime);

    const author = (typeof item.author === 'object' && item.author !== null) ? item.author : {};
    const authorStats = item.authorStats || {};
    const authorStatsV2 = item.authorStatsV2 || {};
    const stats = {};
    for (const key of ['diggCount', 'shareCount', 'playCount', 'commentCount', 'collectCount']) {
      const snakeKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      stats[key] = [
        item.stats?.[key], item.stats?.[snakeKey],
        item.statsV2?.[key], item.statsV2?.[snakeKey]
      ].map(parseAccurateNumber).find((value) => value > 0) || 0;
    }
    const videoObj = item.video || {};

    const getMediaUrlString = (val) => {
      if (typeof val === 'string') return val;
      if (val && typeof val === 'object') {
        return val.url_list?.[0] || val.urlList?.[0] || val.UrlList?.[0] || '';
      }
      return '';
    };

    const authorName = author.uniqueId || author.unique_id || author.name || (typeof item.author === 'string' ? item.author : '') || username || '';
    const authorNick = author.nickname || author.nickName || authorName;

    // Fallback author stats from cachedUserStats or profile DOM header
    const resolvedUsername = authorName.toLowerCase();
    const userFallback = cachedUserStats.get(resolvedUsername) || getProfileDomUserStats(resolvedUsername) || {};

    const authorAvatar = getMediaUrlString(author.avatarLarger) ||
                         getMediaUrlString(author.avatarMedium) ||
                         getMediaUrlString(author.avatarThumb) ||
                         getMediaUrlString(author.avatar_larger) ||
                         getMediaUrlString(author.avatar_thumb) ||
                         getMediaUrlString(author.avatar) ||
                         userFallback.avatar ||
                         '';

    const verified = Boolean(author.verified || author.custom_verify || userFallback.verified);
    const signature = author.signature || userFallback.signature || '';
    const fans = parseAccurateNumber((authorStats.followerCount || authorStats.fans || authorStatsV2.followerCount) ?? userFallback.followerCount ?? 0);
    const following = parseAccurateNumber((authorStats.followingCount || authorStats.following || authorStatsV2.followingCount) ?? userFallback.followingCount ?? 0);
    const heart = parseAccurateNumber((authorStats.heartCount || authorStats.heart || authorStatsV2.heartCount) ?? userFallback.heartCount ?? 0);
    const video = parseAccurateNumber((authorStats.videoCount || authorStats.video || authorStatsV2.videoCount) ?? userFallback.videoCount ?? 0);

    // Inspect DOM video as fallback/supplement (scoped to active card/modal)
    const domVideo = container ? container.querySelector('video') : document.querySelector('video');
    const domPoster = domVideo?.getAttribute('poster') ||
                      container?.querySelector('img[class*="ImgPoster"], [data-e2e="video-cover"] img')?.src ||
                      document.querySelector('img[class*="ImgPoster"], [data-e2e="video-cover"] img')?.src || '';

    // Image post extraction (for TikTok photo carousels/slides)
    const imagePost = item.imagePost || item.image_post;
    const isPhotoPost = Boolean(imagePost || item.isPhoto || window.location.pathname.includes('/photo/'));

    // Height & Width
    const firstPhotoImg = imagePost?.images?.[0];
    const photoWidth = parseInt(firstPhotoImg?.imageWidth || 1080, 10);
    const photoHeight = parseInt(firstPhotoImg?.imageHeight || 1920, 10);

    let height = parseInt(videoObj.height || (isPhotoPost ? photoHeight : domVideo?.videoHeight) || 1024, 10);
    let width = parseInt(videoObj.width || (isPhotoPost ? photoWidth : domVideo?.videoWidth) || 576, 10);
    if (isNaN(height) || height <= 0) height = 1024;
    if (isNaN(width) || width <= 0) width = 576;

    // Duration (in milliseconds, e.g. 31200)
    let rawDuration = videoObj.duration !== undefined ? Number(videoObj.duration) : (domVideo?.duration ? domVideo.duration : 0);
    if (isNaN(rawDuration) || rawDuration < 0) rawDuration = 0;
    let duration = rawDuration;
    if (rawDuration > 0 && rawDuration < 3600) {
      duration = Math.round(rawDuration * 1000);
    } else {
      duration = Math.round(rawDuration);
    }
    if (isPhotoPost) {
      duration = 0;
    }

    const photoCover = getMediaUrlString(imagePost?.cover) || getMediaUrlString(imagePost?.shareCover) || '';
    const coverUrl = photoCover || getMediaUrlString(videoObj.cover) || getMediaUrlString(videoObj.coverUrl) || domPoster || '';
    const originalCoverUrl = photoCover || getMediaUrlString(videoObj.originCover) || getMediaUrlString(videoObj.originalCoverUrl) || coverUrl;
    const dynamicCoverUrl = getMediaUrlString(videoObj.dynamicCover) || getMediaUrlString(videoObj.dynamic_cover) || originalCoverUrl;

    const definition = String(isPhotoPost ? 'photo' : (videoObj.definition || (videoObj.ratio ? `${videoObj.ratio}p` : '540p')));
    const format = String(isPhotoPost ? 'image' : (videoObj.format || ''));

    const videoMeta = {
      height,
      width,
      duration,
      coverUrl,
      originalCoverUrl,
      definition,
      format
    };

    // Metric counts: merge stats with DOM counts if stats are 0
    function resolveMetric(apiVal1, apiVal2, domEl) {
      const apiVal = parseAccurateNumber(apiVal1 ?? apiVal2 ?? 0);
      if (apiVal > 0) return apiVal;
      if (domEl) {
        const domVal = parseAccurateNumber(domEl.textContent);
        if (domVal > 0) return domVal;
      }
      return apiVal;
    }

    const domLike = container?.querySelector('[data-e2e="like-count"], [data-e2e="browse-like-count"], strong[data-e2e="like-count"], [data-e2e="visual-like-count"]') ||
                    (isModalOrBody ? document.querySelector('[data-e2e="browse-like-count"]') : null);
    const domShare = container?.querySelector('[data-e2e="share-count"], [data-e2e="browse-share-count"], strong[data-e2e="share-count"]') ||
                     (isModalOrBody ? document.querySelector('[data-e2e="browse-share-count"]') : null);
    const domComment = container?.querySelector('[data-e2e="comment-count"], [data-e2e="browse-comment-count"], strong[data-e2e="comment-count"]') ||
                       (isModalOrBody ? document.querySelector('[data-e2e="browse-comment-count"]') : null);
    const domCollect = container?.querySelector('[data-e2e="bookmark-count"], [data-e2e="browse-bookmark-count"], [data-e2e="collect-count"], [data-e2e="undefined-count"], strong[data-e2e="bookmark-count"]') ||
                       (isModalOrBody ? document.querySelector('[data-e2e="browse-bookmark-count"], [data-e2e="collect-count"]') : null);

    const diggCount = resolveMetric(stats.diggCount, stats.digg_count, domLike);
    const shareCount = resolveMetric(stats.shareCount, stats.share_count, domShare);
    const playCount = parseAccurateNumber(stats.playCount ?? stats.play_count ?? 0);
    const rawCommentCount = resolveMetric(stats.commentCount, stats.comment_count, domComment);
    const commentCount = Math.max(rawCommentCount, (commentsList || []).length);
    const commentsDetail = commentsList || [];
    const collectCount = resolveMetric(stats.collectCount, stats.collect_count, domCollect);

    const postType = isPhotoPost ? 'photo' : 'video';
    const webVideoUrl = authorName && id
      ? `https://www.tiktok.com/@${authorName}/${postType}/${id}`
      : (window.location.href.split('?')[0]);

    // Media URLs extraction (video stream URLs & photo image URLs)
    const mediaUrlSet = new Set();
    const addUrlIfValid = (u) => {
      if (typeof u === 'string' && u.trim().startsWith('http')) {
        mediaUrlSet.add(u.trim());
      }
    };

    // 1. Photos from imagePost
    if (imagePost && Array.isArray(imagePost.images)) {
      for (const img of imagePost.images) {
        const u = getMediaUrlString(img.imageURL) || getMediaUrlString(img.displayImage) || getMediaUrlString(img.url) || '';
        if (u) addUrlIfValid(u);
      }
    }

    // 2. Video streams (only for video posts)
    if (!isPhotoPost) {
      if (typeof videoObj.playAddr === 'string') addUrlIfValid(videoObj.playAddr);
      if (Array.isArray(videoObj.playAddr?.urlList)) videoObj.playAddr.urlList.forEach(addUrlIfValid);
      if (Array.isArray(videoObj.playAddr?.UrlList)) videoObj.playAddr.UrlList.forEach(addUrlIfValid);

      if (typeof videoObj.downloadAddr === 'string') addUrlIfValid(videoObj.downloadAddr);
      if (Array.isArray(videoObj.downloadAddr?.urlList)) videoObj.downloadAddr.urlList.forEach(addUrlIfValid);
      if (Array.isArray(videoObj.downloadAddr?.UrlList)) videoObj.downloadAddr.UrlList.forEach(addUrlIfValid);

      if (Array.isArray(videoObj.bitrateInfo)) {
        for (const b of videoObj.bitrateInfo) {
          const playObj = b?.PlayAddr || b?.playAddr || b?.play_addr;
          const list = playObj?.UrlList || playObj?.urlList || playObj?.url_list;
          if (Array.isArray(list)) list.forEach(addUrlIfValid);
          if (typeof playObj?.UrlKey === 'string') addUrlIfValid(playObj.UrlKey);
        }
      }

      if (domVideo) {
        if (domVideo.src) addUrlIfValid(domVideo.src);
        domVideo.querySelectorAll('source').forEach((s) => {
          if (s.src) addUrlIfValid(s.src);
        });
      }
    }

    // 3. Fallback for photo slides from DOM if still empty
    if (isPhotoPost && mediaUrlSet.size === 0) {
      const domImages = container.querySelectorAll('div[class*="DivPhotoPlayer"] img, div[class*="DivSlideContainer"] img, [data-e2e="image-player"] img, div[class*="DivImageWrapper"] img, picture img');
      for (const img of domImages) {
        const src = img.src || img.getAttribute('data-src') || '';
        if (src && src.startsWith('http') && !src.includes('avatar')) {
          addUrlIfValid(src);
        }
      }
    }

    const mediaUrls = Array.from(mediaUrlSet);

    // Covers
    const covers = {
      default: coverUrl,
      dynamic: dynamicCoverUrl
    };

    // Hashtags: Parse words starting with '#' directly from caption text ("text")
    const hashtagMap = new Map();
    if (Array.isArray(item.challenges)) {
      for (const ch of item.challenges) {
        const name = String(ch.title || ch.name || '').replace(/^#/, '').trim().toLowerCase();
        if (name && ch.id) hashtagMap.set(name, String(ch.id));
      }
    }
    const extras = item.textExtra || item.text_extra;
    if (Array.isArray(extras)) {
      for (const te of extras) {
        const name = String(te.hashtagName || te.hashtag_name || '').replace(/^#/, '').trim().toLowerCase();
        const id = te.hashtagId || te.hashtag_id;
        if (name && id && !hashtagMap.has(name)) {
          hashtagMap.set(name, String(id));
        }
      }
    }

    let hashtags = [];
    const seenTags = new Set();
    const hashtagRegex = /(?<![\p{L}\p{N}\p{M}])#+([\p{L}\p{N}\p{M}_]+)/gu;
    let match;

    while ((match = hashtagRegex.exec(text)) !== null) {
      const cleanTag = match[1];
      const lowerTag = cleanTag.toLowerCase();
      if (!seenTags.has(lowerTag)) {
        seenTags.add(lowerTag);
        hashtags.push({
          id: hashtagMap.get(lowerTag) || '',
          name: cleanTag,
          title: cleanTag
        });
      }
    }

    const isAd = Boolean(item.isAd || item.is_ad);

    // Exact Schema requested:
    return {
      id,
      text,
      createTime,
      createTimeISO,
      authorMeta: {
        id: String(author.id || userFallback.id || ''),
        name: authorName,
        nickName: authorNick,
        verified,
        signature,
        avatar: authorAvatar || userFallback.avatar || '',
        fans,
        following,
        heart,
        video
      },
      videoMeta,
      diggCount,
      shareCount,
      playCount,
      commentCount,
      comments: commentsDetail,
      commentsDetail,
      collectCount,
      webVideoUrl,
      mediaUrls,
      covers,
      hashtags,
      isAd
    };
  }

  /**
   * Main Trigger Function for TikTok extraction
   */
  async function triggerTikTokExtraction(providedInfo = null) {
    if (isExtracting) {
      return { success: false, error: 'TikTok extraction already in progress.' };
    }

    populateUserStatsFromUniversalData();

    const target = providedInfo || getTikTokIdentifier();
    if (!target || !target.videoId) {
      showToast({
        title: 'Not a TikTok Video',
        message: 'Please open a TikTok video before scraping data.',
        type: 'warning'
      });
      return { success: false, error: 'Not a TikTok video page.' };
    }

    // Ensure activeElement is resolved if not passed across chrome messages
    const activeEl = target.activeElement || getActivePostContainer(target.videoId);

    isExtracting = true;
    showToast({
      title: 'Scraping TikTok Data...',
      message: `Extracting video [${target.videoId}]`,
      type: 'info'
    });

    try {
      // 1. Fetch item detail & comments in parallel
      const [itemPromise, commentsPromise] = [
        (async () => {
          // Strategy 0: In-page intercepted item (from tiktok-interceptor.js)
          let item = interceptedItems.get(String(target.videoId));
          if (!item) item = await fetchInterceptedDataFromMainWorld(target.videoId);
          if (!item) item = extractFromUniversalData(target.videoId);
          if (!item) item = extractFromSigiState(target.videoId);
          if (!item) item = extractFromNextData(target.videoId);
          if (!item) item = await fetchFromTikTokApi(target.videoId);
          if (!item) item = extractFromTikTokDom(target.videoId, target.username, activeEl);
          return item;
        })(),
        (async () => {
          // Strategy 0: In-page intercepted comments
          let list = interceptedComments.get(String(target.videoId));
          if (!list || list.length === 0) {
            list = await fetchTikTokComments(target.videoId);
          }
          if (!list || list.length === 0) {
            list = extractCommentsFromTikTokDom();
          }
          return list;
        })()
      ];

      const [itemResult, commentsResult] = await Promise.all([itemPromise, commentsPromise]);

      if (!itemResult) {
        throw new Error('Failed to extract TikTok video metadata.');
      }

      const normalizedData = normalizeToTikTokSchema(itemResult, commentsResult || [], target.videoId, target.username, activeEl);

      // 2. Send to background service worker to save into TikTok storage (tiktok_posts)
      return await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            action: 'save_post',
            platform: 'tiktok',
            postData: normalizedData
          },
          (response) => {
            if (chrome.runtime.lastError) {
              console.error('[TikTok Extractor] Message error:', chrome.runtime.lastError);
              showToast({
                title: 'Storage Error',
                message: chrome.runtime.lastError.message || 'Failed to communicate with background script.',
                type: 'error'
              });
              isExtracting = false;
              resolve({ success: false, error: chrome.runtime.lastError.message });
              return;
            }

            if (response && response.success) {
              const isUpdated = response.isUpdate;
              showToast({
                title: isUpdated ? 'TikTok Data Updated!' : 'TikTok Video Saved!',
                message: `Video by @${normalizedData.authorMeta?.name || 'unknown'} saved to database. Click 'Download tiktok.json' in popup to export.`,
                type: 'success',
                badge: `Total: ${response.totalCount} videos`,
                meta: `❤️ ${normalizedData.diggCount.toLocaleString('en-US')} • 💬 ${normalizedData.commentCount.toLocaleString('en-US')} (${(normalizedData.commentsDetail?.length || 0).toLocaleString('en-US')} comments) • 🔁 ${normalizedData.shareCount.toLocaleString('en-US')}`
              });
              resolve({ success: true, post: normalizedData, totalCount: response.totalCount });
            } else {
              showToast({
                title: 'Save Failed',
                message: response?.error || 'An error occurred while saving data.',
                type: 'error'
              });
              resolve({ success: false, error: response?.error });
            }
            isExtracting = false;
          }
        );
      });
    } catch (err) {
      console.error('[TikTok Extractor] Extraction error:', err);
      showToast({
        title: 'Scraping Failed',
        message: err.message || 'An issue occurred while reading TikTok video data.',
        type: 'error'
      });
      isExtracting = false;
      return { success: false, error: err.message };
    }
  }

  /**
   * Listen for runtime messages from popup and shortcut
   */
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'extract_current_tiktok' || request.action === 'extract_current_post') {
      const target = request.postInfo || getTikTokIdentifier(request.tabUrl);
      triggerTikTokExtraction(target).then((res) => {
        sendResponse(res || { success: true });
      }).catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
      return true;
    } else if (request.action === 'check_status') {
      const target = getTikTokIdentifier(request.tabUrl);
      sendResponse({
        isPostPage: Boolean(target && target.videoId),
        platform: 'tiktok',
        postInfo: target ? { videoId: target.videoId, username: target.username } : null
      });
    }
  });

  console.log('[TikTok Extractor] Content script ready.');
})();
