// Content Script for X / Twitter Tweet & Reply Data Extractor (v1.4.1)
(function () {
  'use strict';

  let isExtracting = false;

  // In-memory cache for tweets & threads captured by x-interceptor.js
  const interceptedTweets = new Map();
  const interceptedThreads = new Map();
  const MAX_INTERCEPT_CACHE = 100;

  function cacheSet(map, key, value) {
    if (map.size >= MAX_INTERCEPT_CACHE) {
      const oldestKey = map.keys().next().value;
      map.delete(oldestKey);
    }
    map.set(key, value);
  }

  // Listen for real-time broadcasts from x-interceptor.js (MAIN world)
  window.addEventListener('X_INTERCEPTED_DATA', (e) => {
    try {
      const { type, payload } = e.detail || {};
      if (type === 'thread' && payload) {
        if (payload.rootId && payload.thread) {
          cacheSet(interceptedThreads, String(payload.rootId), payload.thread);
        }
        if (payload.rootTweet && payload.rootTweet.id) {
          cacheSet(interceptedTweets, String(payload.rootTweet.id), payload.rootTweet);
        }
        if (Array.isArray(payload.thread)) {
          for (const t of payload.thread) {
            if (t && t.id) cacheSet(interceptedTweets, String(t.id), t);
          }
        }
      } else if (type === 'tweets' && Array.isArray(payload)) {
        for (const t of payload) {
          if (t && t.id) cacheSet(interceptedTweets, String(t.id), t);
        }
      }
    } catch (_) {}
  });

  /**
   * Helper to retrieve intercepted GraphQL data with request fallback
   */
  async function getInterceptedDataForStatus(targetStatusId) {
    if (!targetStatusId) return null;
    const strId = String(targetStatusId);

    // 1. Direct thread match
    if (interceptedThreads.has(strId)) {
      const thread = interceptedThreads.get(strId);
      const match = thread.find((t) => t.id === strId) || interceptedTweets.get(strId) || thread[0];
      return {
        thread,
        mainPost: match
      };
    }

    // 2. Search through all cached threads to see if strId is a reply within any thread
    for (const thread of interceptedThreads.values()) {
      if (Array.isArray(thread)) {
        const match = thread.find((t) => t.id === strId);
        if (match) {
          return {
            thread,
            mainPost: match
          };
        }
      }
    }

    // 3. Fallback to single tweet in cache
    if (interceptedTweets.has(strId)) {
      return {
        thread: [interceptedTweets.get(strId)],
        mainPost: interceptedTweets.get(strId)
      };
    }

    // 4. Ask x-interceptor.js in MAIN world via CustomEvent
    return new Promise((resolve) => {
      let resolved = false;
      const onResponse = (e) => {
        if (String(e.detail?.targetId) === strId) {
          window.removeEventListener('X_RESPOND_CAPTURED_DATA', onResponse);
          resolved = true;
          const { tweet, thread } = e.detail || {};
          if (thread && Array.isArray(thread) && thread.length > 0) {
            cacheSet(interceptedThreads, strId, thread);
            for (const t of thread) if (t && t.id) cacheSet(interceptedTweets, String(t.id), t);
            const focalMatch = thread.find((t) => t.id === strId) || tweet || thread[0];
            resolve({ thread, mainPost: focalMatch });
          } else if (tweet) {
            cacheSet(interceptedTweets, strId, tweet);
            resolve({ thread: [tweet], mainPost: tweet });
          } else {
            resolve(null);
          }
        }
      };

      window.addEventListener('X_RESPOND_CAPTURED_DATA', onResponse);
      try {
        window.dispatchEvent(new CustomEvent('X_REQUEST_CAPTURED_DATA', { detail: { targetId: strId } }));
      } catch (_) {}

      setTimeout(() => {
        if (!resolved) {
          window.removeEventListener('X_RESPOND_CAPTURED_DATA', onResponse);
          resolve(null);
        }
      }, 300);
    });
  }

  /**
   * Helper: Parse formatted number strings accurately to integer.
   * Handles English (1.2K, 1.5M, 2B, 1,245) and Indonesian (1,2 rb, 1,5 jt, 1.245) formats.
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
   * Extract metric count from button, link, or container element.
   * Inspects aria-label, nested spans, and transition containers.
   */
  function parseMetricFromElement(el) {
    if (!el) return 0;

    // 1. Check aria-label first, ensuring digits are explicitly attached to metric keywords
    // (Prevents false positives from username digits, e.g. "Reply to @user123")
    const ariaLabel = el.getAttribute('aria-label') || '';
    if (ariaLabel) {
      const numMatch = ariaLabel.match(/([\d.,]+(?:\s*(?:k|m|b|rb|jt|ribu|juta))?)\s*(?:likes?|suka|reposts?|retweets?|repl(?:y|ies)|balasan|views?|tayangan|bookmarks?|markah)\b/i)
        || ariaLabel.match(/(?:likes?|suka|reposts?|retweets?|repl(?:y|ies)|balasan|views?|tayangan|bookmarks?|markah)\s*:\s*([\d.,]+)/i);
      if (numMatch) {
        const parsed = parseAccurateNumber(numMatch[1]);
        if (parsed > 0) return parsed;
      }
    }

    // 2. Check inner text or transition containers
    const textContainer = el.querySelector('[data-testid="app-text-transition-container"]') || el;
    const text = textContainer.innerText || textContainer.textContent || '';
    if (text) {
      const textMatch = text.match(/([\d.,]+(?:\s*(?:k|m|b|rb|jt|ribu|juta))?)/i);
      if (textMatch) {
        const parsed = parseAccurateNumber(textMatch[1]);
        if (parsed > 0) return parsed;
      }
    }

    return 0;
  }

  /**
   * Toast notification on X page
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

    if (message) {
      const msgDiv = document.createElement('div');
      msgDiv.className = 'ig-extractor-desc';
      msgDiv.textContent = message;
      bodyDiv.appendChild(msgDiv);
    }

    if (meta) {
      const metaDiv = document.createElement('div');
      metaDiv.className = 'ig-extractor-meta';
      metaDiv.textContent = meta;
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
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 300);
    }, 4500);
  }

  /**
   * Helper: Parse Tweet Identifier from URL or current window
   */
  function getXPostIdentifier(passedUrl) {
    const targetUrl = passedUrl || window.location.href;
    const match = targetUrl.match(/(?:x\.com|twitter\.com)\/(?:#!\/)?([A-Za-z0-9_]+)\/status\/(\d+)/i);
    if (match) {
      return {
        username: match[1],
        statusId: match[2],
        url: `https://x.com/${match[1]}/status/${match[2]}`
      };
    }
    return null;
  }

  /**
   * Extract author information (displayName, handle, isVerified, isBlueVerified, avatarUrl, coverPicture, etc.)
   */
  function extractAuthorInfo(articleEl, targetUsername) {
    let displayName = '';
    let handle = '';
    let isVerified = false;
    let isBlueVerified = false;
    let avatarUrl = '';
    let coverPicture = '';
    let description = '';
    let location = '';

    // 1. Avatar
    const avatarImg = articleEl.querySelector('div[data-testid*="Avatar" i] img, img[src*="profile_images"]');
    if (avatarImg) {
      avatarUrl = avatarImg.src || avatarImg.getAttribute('src') || '';
    }

    // 2. User Name Container (scoped strictly to author header)
    const userNameContainer = articleEl.querySelector('[data-testid="User-Name"], [data-testid*="user" i][data-testid*="name" i]');
    if (userNameContainer) {
      // Scope verified status strictly to author container first (avoids quote tweet verified leakage)
      const verifiedSvg = userNameContainer.querySelector('[data-testid="icon-verified"], svg[aria-label*="Verified" i], svg[aria-label*="Terverifikasi" i], svg[data-testid*="verified" i]');
      isVerified = Boolean(verifiedSvg);
      isBlueVerified = isVerified;

      // Search profile link inside userNameContainer to get handle accurately from href
      const userLink = Array.from(userNameContainer.querySelectorAll('a[href^="/"]')).find((a) => {
        const h = (a.getAttribute('href') || '').toLowerCase();
        return /^\/[a-z0-9_]+$/i.test(h) && !['/home', '/explore', '/notifications', '/messages', '/search', '/settings', '/i'].includes(h);
      });
      if (userLink) {
        handle = (userLink.getAttribute('href') || '').slice(1);
      }

      const allText = userNameContainer.innerText || '';
      if (!handle) {
        const handleMatch = allText.match(/@([A-Za-z0-9_]+)/);
        if (handleMatch) handle = handleMatch[1];
      }
      const atIndex = allText.indexOf('@');
      if (atIndex > 0) {
        displayName = allText.slice(0, atIndex).replace(/[\r\n\t]+/g, ' ').trim();
      }
    } else {
      const verifiedSvg = articleEl.querySelector('[data-testid="icon-verified"], svg[aria-label*="Verified" i], svg[aria-label*="Terverifikasi" i], svg[data-testid*="verified" i]');
      isVerified = Boolean(verifiedSvg);
      isBlueVerified = isVerified;
    }

    // 3. Scan profile links (a[href^="/"]) for display name and handle
    if (!displayName || !handle) {
      const profileLinks = Array.from(articleEl.querySelectorAll('a[href^="/"]')).filter((a) => {
        const h = (a.getAttribute('href') || '').toLowerCase();
        return /^\/[a-z0-9_]+$/i.test(h) && !['/home', '/explore', '/notifications', '/messages', '/search', '/settings', '/i'].includes(h);
      });

      for (const a of profileLinks) {
        const t = a.innerText?.trim() || '';
        if (t.includes('@')) {
          const parts = t.split('@');
          const namePart = parts[0].trim();
          const handlePart = parts[1].trim().split(/[\s\r\n]+/)[0];
          if (namePart && !displayName) displayName = namePart;
          if (handlePart && !handle) handle = handlePart;
        } else if (t && !displayName) {
          displayName = t;
        }
      }
    }

    // 4. Text fallback for handle
    if (!handle) {
      const handleMatch = articleEl.innerText?.match(/@([A-Za-z0-9_]+)/);
      if (handleMatch) {
        handle = handleMatch[1];
      }
    }

    // 5. Text fallback for displayName from header area before @handle
    if (!displayName && handle) {
      const fullText = articleEl.innerText || '';
      const atIndex = fullText.indexOf('@' + handle);
      if (atIndex > 0) {
        const beforeAt = fullText.slice(0, atIndex).trim();
        const lines = beforeAt.split(/[\r\n]+/);
        const lastLine = lines[lines.length - 1]?.trim();
        if (lastLine && lastLine.length < 50 && !lastLine.startsWith('·')) {
          displayName = lastLine;
        }
      }
    }

    if (!handle && targetUsername) handle = targetUsername;
    if (!displayName) displayName = handle || targetUsername || 'X User';

    // Optional page-level details if on profile page
    const bannerImg = document.querySelector('img[src*="profile_banners"]');
    if (bannerImg) coverPicture = bannerImg.src || bannerImg.getAttribute('src') || '';

    const bioEl = document.querySelector('[data-testid="UserDescription"]');
    if (bioEl) description = bioEl.innerText?.trim() || '';

    const locEl = document.querySelector('[data-testid="UserLocation"]');
    if (locEl) location = locEl.innerText?.trim() || '';

    return {
      displayName,
      handle,
      isVerified,
      isBlueVerified,
      avatarUrl,
      coverPicture,
      description,
      location
    };
  }

  /**
   * Helper: Clean Twitter translation banners and UI artifacts from tweet text.
   */
  function cleanTweetText(rawText) {
    if (!rawText) return '';
    return rawText
      .replace(/^translated from[^\n]*\n?/im, '')
      .replace(/^diterjemahkan dari[^\n]*\n?/im, '')
      .replace(/^[^\n]*show original[^\n]*$/gim, '')
      .replace(/^[^\n]*tampilkan yang asli[^\n]*$/gim, '')
      .replace(/^[^\n]*rate this translation:?.*$/gim, '')
      .replace(/^[^\n]*beri nilai terjemahan ini:?.*$/gim, '')
      .trim();
  }

  /**
   * Extract tweet body text cleanly, avoiding author names and UI banners.
   */
  function extractBodyText(articleEl, displayName, handle) {
    if (!articleEl) return '';

    // 1. Explicit tweetText testid (if present)
    const tweetTextEl = articleEl.querySelector('[data-testid="tweetText"]');
    if (tweetTextEl && tweetTextEl.innerText?.trim()) {
      const t = cleanTweetText(tweetTextEl.innerText);
      if (t && t !== displayName && t !== handle && t !== `@${handle}`) {
        return t;
      }
    }

    // 2. Elements with lang attribute (Twitter sets lang on tweet body text)
    const langEls = Array.from(articleEl.querySelectorAll('[lang]'));
    for (const el of langEls) {
      if (el.closest('[role="group"], button, [role="button"], time, a[href*="/analytics"], [data-testid="User-Name"], [data-testid="socialContext"], [data-testid*="quote" i]')) continue;
      const t = cleanTweetText(el.innerText || '');
      if (
        t &&
        t !== displayName &&
        t !== handle &&
        t !== `@${handle}` &&
        !t.startsWith('@') &&
        t.length > 2 &&
        !/^translated from/i.test(t) &&
        !/^diterjemahkan/i.test(t)
      ) {
        return t;
      }
    }

    // 3. Fallback: find the most substantive text block excluding headers and UI noise
    const candidates = Array.from(articleEl.querySelectorAll('div[dir="auto"], span[dir="auto"], p'));
    const validBlocks = [];

    for (const node of candidates) {
      // Skip if inside interactive buttons, footer time/analytics, user headers, or quotes
      if (node.closest('[role="group"], button, [role="button"], time, a[href*="/analytics"], [data-testid="User-Name"], [data-testid="socialContext"], [data-testid*="quote" i]')) continue;

      const text = cleanTweetText(node.innerText || '');
      if (!text) continue;

      // Filter out known UI labels, author headers, and banners
      if (
        text === displayName ||
        text === handle ||
        text === `@${handle}` ||
        text.startsWith('@') ||
        /^translated from/i.test(text) ||
        /^diterjemahkan dari/i.test(text) ||
        /^rate this translation/i.test(text) ||
        /^beri nilai terjemahan/i.test(text) ||
        /^show original/i.test(text) ||
        /^tampilkan yang asli/i.test(text) ||
        /^show more/i.test(text) ||
        /^replying to/i.test(text) ||
        /^membalas/i.test(text) ||
        /^\d{1,2}[:.]\d{2}(?:\s*(?:AM|PM))?/i.test(text) ||
        /^\d+[\d.,]*\s*(?:views|tayangan)/i.test(text) ||
        node.querySelector('img[src*="profile_images"]')
      ) {
        continue;
      }

      // Check if this node is an ancestor/child of an already added block
      let isDuplicate = false;
      for (const b of validBlocks) {
        if (b.node.contains(node)) {
          isDuplicate = true;
          break;
        }
      }
      if (!isDuplicate) {
        validBlocks.push({ node, text });
      }
    }

    if (validBlocks.length > 0) {
      // Pick the longest substantive text block (the actual tweet body)
      validBlocks.sort((a, b) => b.text.length - a.text.length);
      return cleanTweetText(validBlocks[0].text);
    }

    return '';
  }

  /**
   * Extract tweet engagement metrics from action toolbar [role="group"] or article footer
   */
  function extractMetrics(articleEl) {
    let replyCount = 0;
    let retweetCount = 0;
    let likeCount = 0;
    let bookmarkCount = 0;
    let viewCount = 0;

    const actionGroup = articleEl.querySelector('[role="group"]');
    if (actionGroup) {
      const items = Array.from(actionGroup.querySelectorAll('button, a'));
      for (const el of items) {
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        const href = (el.getAttribute('href') || '').toLowerCase();
        const count = parseMetricFromElement(el);

        if (label.includes('reply') || label.includes('balas')) {
          replyCount = count;
        } else if (label.includes('repost') || label.includes('retweet') || label.includes('kirim ulang')) {
          retweetCount = count;
        } else if (label.includes('like') || label.includes('suka')) {
          likeCount = count;
        } else if (label.includes('bookmark') || label.includes('markah')) {
          bookmarkCount = count;
        } else if (label.includes('view') || label.includes('tayangan') || href.includes('/analytics')) {
          viewCount = count;
        }
      }

      // Positional fallback only if standard action labels were completely absent
      const hadAnyLabel = items.some((el) => {
        const lbl = (el.getAttribute('aria-label') || '').toLowerCase();
        return lbl.includes('reply') || lbl.includes('balas') || lbl.includes('like') || lbl.includes('suka') || lbl.includes('repost');
      });
      if (!hadAnyLabel) {
        if (replyCount === 0 && items[0]) replyCount = parseMetricFromElement(items[0]);
        if (retweetCount === 0 && items[1]) retweetCount = parseMetricFromElement(items[1]);
        if (likeCount === 0 && items[2]) likeCount = parseMetricFromElement(items[2]);
        if (bookmarkCount === 0 && items[3]) bookmarkCount = parseMetricFromElement(items[3]);
        if (viewCount === 0 && items[4]) viewCount = parseMetricFromElement(items[4]);
      }
    }

    // Detail view fallbacks: stat links in tweet footer
    if (likeCount === 0) {
      const likesLink = articleEl.querySelector('a[href*="/likes"]');
      if (likesLink) likeCount = parseMetricFromElement(likesLink);
    }
    if (retweetCount === 0) {
      const retweetsLink = articleEl.querySelector('a[href*="/retweets"], a[href*="/quotes"]');
      if (retweetsLink) retweetCount = parseMetricFromElement(retweetsLink);
    }
    if (viewCount === 0) {
      const articleText = articleEl.innerText || '';
      const viewMatch = articleText.match(/([\d.,]+(?:\s*(?:k|m|b|rb|jt|ribu|juta))?)\s*(?:views|tayangan|view)\b/i);
      if (viewMatch) {
        viewCount = parseAccurateNumber(viewMatch[1]);
      }
    }

    return { replyCount, retweetCount, likeCount, bookmarkCount, viewCount };
  }

  /**
   * Extract tweet photos and videos
   */
  function extractMedia(articleEl) {
    const media = [];
    const photoEls = articleEl.querySelectorAll('div[data-testid="tweetPhoto"] img, img[src*="media/"], img[src*="twimg.com/media/"]');
    photoEls.forEach((img) => {
      let src = img.src || img.getAttribute('src');
      if (src && !src.includes('profile_images') && !src.includes('emoji') && !src.includes('twemoji')) {
        src = src.replace(/&name=\w+/, '&name=large');
        if (!media.some((m) => m.url === src)) {
          media.push({ type: 'photo', url: src });
        }
      }
    });

    const videoEl = articleEl.querySelector('video');
    if (videoEl) {
      const videoSrc = videoEl.src || videoEl.querySelector('source')?.src || '';
      media.push({
        type: 'video',
        url: videoSrc,
        poster: videoEl.poster || ''
      });
    }

    return media;
  }

  /**
   * Helper: Format Date or ISO timestamp into Twitter format (Fri Oct 30 03:40:00 +0000 2026)
   */
  function formatTwitterDate(dateInput) {
    if (!dateInput) {
      dateInput = new Date();
    }
    if (typeof dateInput === 'string' && /^[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{2}\s+\d{2}:\d{2}:\d{2}\s+[+-]\d{4}\s+\d{4}$/.test(dateInput.trim())) {
      return dateInput.trim();
    }
    const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const targetDate = isNaN(d.getTime()) ? new Date() : d;

    const dayName = days[targetDate.getUTCDay()];
    const monthName = months[targetDate.getUTCMonth()];
    const dateNum = String(targetDate.getUTCDate()).padStart(2, '0');
    const hours = String(targetDate.getUTCHours()).padStart(2, '0');
    const minutes = String(targetDate.getUTCMinutes()).padStart(2, '0');
    const seconds = String(targetDate.getUTCSeconds()).padStart(2, '0');
    const year = targetDate.getUTCFullYear();

    return `${dayName} ${monthName} ${dateNum} ${hours}:${minutes}:${seconds} +0000 ${year}`;
  }

  /**
   * Extract Twitter Card link preview (summary_large_image, summary, etc.)
   */
  function extractCard(articleEl) {
    if (!articleEl) return null;

    const cardWrapper = articleEl.querySelector('[data-testid="card.wrapper"], [data-testid*="card" i]');
    if (!cardWrapper) return null;

    const cardLink = cardWrapper.closest('a') || cardWrapper.querySelector('a') || articleEl.querySelector('a[href*="t.co"]');
    const cardUrl = cardLink?.href || '';
    if (!cardUrl && !cardWrapper.innerText?.trim()) return null;

    const cardImgEl = cardWrapper.querySelector('img');
    const cardImgUrl = cardImgEl?.src || cardImgEl?.getAttribute('src') || '';

    let cardTitle = '';
    let cardDesc = '';
    let cardDomain = '';

    const textNodes = Array.from(cardWrapper.querySelectorAll('span, div[dir="auto"], div[dir="ltr"]'))
      .map((el) => el.innerText?.trim())
      .filter((t) => t && t.length > 0 && !t.includes('\n'));

    // Deduplicate
    const uniqueTexts = [];
    textNodes.forEach((t) => {
      if (!uniqueTexts.includes(t)) uniqueTexts.push(t);
    });

    for (const t of uniqueTexts) {
      if (/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/i.test(t)) {
        if (!cardDomain) cardDomain = t;
      } else if (!cardTitle) {
        cardTitle = t;
      } else if (!cardDesc && t !== cardTitle && t !== cardDomain) {
        cardDesc = t;
      }
    }

    if (!cardDomain && cardUrl) {
      try {
        cardDomain = new URL(cardUrl).hostname.replace(/^www\./, '');
      } catch (_) {}
    }

    const bindingValues = [];

    if (cardImgUrl) {
      bindingValues.push({
        key: 'photo_image_full_size_large',
        value: {
          image_value: { height: 340, url: cardImgUrl, width: 650 },
          type: 'IMAGE'
        }
      });
      bindingValues.push({
        key: 'thumbnail_image',
        value: {
          image_value: { height: 150, url: cardImgUrl, width: 266 },
          type: 'IMAGE'
        }
      });
    }

    if (cardDesc) {
      bindingValues.push({
        key: 'description',
        value: {
          string_value: cardDesc,
          type: 'STRING'
        }
      });
    }

    if (cardDomain) {
      bindingValues.push({
        key: 'domain',
        value: {
          string_value: cardDomain,
          type: 'STRING'
        }
      });
    }

    if (cardImgUrl) {
      bindingValues.push({
        key: 'thumbnail_image_large',
        value: {
          image_value: { height: 320, url: cardImgUrl, width: 568 },
          type: 'IMAGE'
        }
      });
      bindingValues.push({
        key: 'summary_photo_image_small',
        value: {
          image_value: { height: 202, url: cardImgUrl, width: 386 },
          type: 'IMAGE'
        }
      });
      bindingValues.push({
        key: 'thumbnail_image_original',
        value: {
          image_value: { height: 366, url: cardImgUrl, width: 650 },
          type: 'IMAGE'
        }
      });
      bindingValues.push({
        key: 'photo_image_full_size_small',
        value: {
          image_value: { height: 202, url: cardImgUrl, width: 386 },
          type: 'IMAGE'
        }
      });
      bindingValues.push({
        key: 'summary_photo_image_large',
        value: {
          image_value: { height: 340, url: cardImgUrl, width: 650 },
          type: 'IMAGE'
        }
      });
      bindingValues.push({
        key: 'thumbnail_image_small',
        value: {
          image_value: { height: 81, url: cardImgUrl, width: 144 },
          type: 'IMAGE'
        }
      });
      bindingValues.push({
        key: 'thumbnail_image_x_large',
        value: {
          image_value: { height: 366, url: cardImgUrl, width: 650 },
          type: 'IMAGE'
        }
      });
      bindingValues.push({
        key: 'photo_image_full_size_original',
        value: {
          image_value: { height: 366, url: cardImgUrl, width: 650 },
          type: 'IMAGE'
        }
      });
    }

    if (cardDomain) {
      bindingValues.push({
        key: 'vanity_url',
        value: {
          scribe_key: 'vanity_url',
          string_value: cardDomain,
          type: 'STRING'
        }
      });
    }

    if (cardImgUrl) {
      bindingValues.push({
        key: 'photo_image_full_size',
        value: {
          image_value: { height: 314, url: cardImgUrl, width: 600 },
          type: 'IMAGE'
        }
      });
    }

    if (cardTitle) {
      bindingValues.push({
        key: 'title',
        value: {
          string_value: cardTitle,
          type: 'STRING'
        }
      });
    }

    if (cardImgUrl) {
      bindingValues.push({
        key: 'summary_photo_image_x_large',
        value: {
          image_value: { height: 366, url: cardImgUrl, width: 650 },
          type: 'IMAGE'
        }
      });
      bindingValues.push({
        key: 'summary_photo_image',
        value: {
          image_value: { height: 314, url: cardImgUrl, width: 600 },
          type: 'IMAGE'
        }
      });
    }

    if (cardUrl) {
      bindingValues.push({
        key: 'card_url',
        value: {
          scribe_key: 'card_url',
          string_value: cardUrl,
          type: 'STRING'
        }
      });
    }

    if (cardImgUrl) {
      bindingValues.push({
        key: 'summary_photo_image_original',
        value: {
          image_value: { height: 366, url: cardImgUrl, width: 650 },
          type: 'IMAGE'
        }
      });
    }

    return {
      binding_values: bindingValues,
      card_platform: {
        platform: {
          audience: { name: 'production' },
          device: { name: 'Swift', version: '12' }
        }
      },
      name: 'summary_large_image',
      url: cardUrl,
      user_refs_results: []
    };
  }

  /**
   * Extract tweet entities (URLs)
   */
  function extractEntities(articleEl, tweetText) {
    const urls = [];
    const linkEls = articleEl.querySelectorAll('[data-testid="tweetText"] a, a[href*="t.co"]');
    linkEls.forEach((a) => {
      const rawHref = a.getAttribute('href') || a.href || '';
      const fullHref = a.href || rawHref;
      const displayText = a.innerText?.trim() || '';
      if (!displayText || displayText.startsWith('@') || displayText.startsWith('#')) return;

      let expanded = a.getAttribute('title') || fullHref;
      if (expanded.startsWith('/')) {
        expanded = `https://x.com${expanded}`;
      }
      const tCoMatch = fullHref.match(/https?:\/\/t\.co\/[A-Za-z0-9]+/);
      const tCoUrl = tCoMatch ? tCoMatch[0] : (fullHref.startsWith('http') ? fullHref : `https://t.co/${displayText}`);

      let startIdx = tweetText.indexOf(tCoUrl);
      if (startIdx === -1) startIdx = tweetText.indexOf(displayText);
      if (startIdx === -1) startIdx = 0;
      const endIdx = startIdx > 0 ? startIdx + (tCoMatch ? tCoUrl.length : displayText.length) : 0;

      if (!urls.some((u) => u.url === tCoUrl)) {
        urls.push({
          display_url: displayText,
          expanded_url: expanded,
          indices: [startIdx, endIdx],
          url: tCoUrl
        });
      }
    });

    return { urls };
  }

  /**
   * Normalize any extracted tweet object to exact x.json schema
   */
  function normalizeToXSchema(data, opts = {}) {
    const {
      isReply = false,
      inReplyToId = null,
      conversationId = null,
      inReplyToUserId = null,
      inReplyToUsername = null
    } = opts;

    const id = String(data.id || '');
    const userName = String(data.author?.userName || data.author?.username || data.author?.handle || '').replace(/^@/, '');
    const name = String(data.author?.name || data.author?.displayName || userName || 'X User');
    const url = data.url || (userName && id ? `https://x.com/${userName}/status/${id}` : (id ? `https://x.com/i/status/${id}` : ''));
    const twitterUrl = data.twitterUrl || (userName && id ? `https://twitter.com/${userName}/status/${id}` : (id ? `https://twitter.com/i/status/${id}` : ''));

    const effectiveConvId = conversationId || (isReply && inReplyToId ? inReplyToId : id);

    const author = {
      type: 'user',
      userName,
      url: userName ? `https://x.com/${userName}` : '',
      twitterUrl: userName ? `https://twitter.com/${userName}` : '',
      id: String(data.author?.id || ''),
      name,
      isVerified: Boolean(data.author?.isVerified ?? data.author?.verified),
      isBlueVerified: Boolean(data.author?.isBlueVerified ?? data.author?.isVerified ?? data.author?.verified),
      profilePicture: data.author?.profilePicture || data.author?.avatarUrl || data.author?.avatar || '',
      coverPicture: data.author?.coverPicture || '',
      description: data.author?.description || '',
      location: data.author?.location || '',
      followers: Number(data.author?.followers ?? 0),
      following: Number(data.author?.following ?? 0),
      status: data.author?.status || '',
      canDm: Boolean(data.author?.canDm ?? false),
      canMediaTag: Boolean(data.author?.canMediaTag ?? false),
      createdAt: data.author?.createdAt ? (typeof data.author.createdAt === 'string' && /^[A-Z][a-z]{2}\s/.test(data.author.createdAt) ? data.author.createdAt : formatTwitterDate(data.author.createdAt)) : '',
      entities: data.author?.entities || {
        description: { urls: [] },
        url: { urls: [] }
      },
      fastFollowersCount: Number(data.author?.fastFollowersCount ?? 0),
      favouritesCount: Number(data.author?.favouritesCount ?? 0),
      hasCustomTimelines: Boolean(data.author?.hasCustomTimelines ?? true),
      isTranslator: Boolean(data.author?.isTranslator ?? false),
      mediaCount: Number(data.author?.mediaCount ?? 0),
      statusesCount: Number(data.author?.statusesCount ?? 0),
      withheldInCountries: Array.isArray(data.author?.withheldInCountries) ? data.author.withheldInCountries : [],
      affiliatesHighlightedLabel: data.author?.affiliatesHighlightedLabel || {},
      possiblySensitive: Boolean(data.author?.possiblySensitive ?? false),
      pinnedTweetIds: Array.isArray(data.author?.pinnedTweetIds) ? data.author.pinnedTweetIds : [],
      profile_bio: data.author?.profile_bio || {},
      isAutomated: Boolean(data.author?.isAutomated ?? false),
      automatedBy: data.author?.automatedBy ?? null
    };

    const extendedEntities = data.extendedEntities || (Array.isArray(data.media) && data.media.length > 0 ? { media: data.media } : {});
    const card = data.card !== undefined ? data.card : null;
    const place = data.place || {};
    const entities = data.entities || { urls: [] };

    return {
      type: 'tweet',
      id,
      url,
      twitterUrl,
      text: data.text || '',
      source: data.source || '',
      retweetCount: Number(data.retweetCount ?? data.metrics?.retweetCount ?? 0),
      replyCount: Number(data.replyCount ?? data.metrics?.replyCount ?? 0),
      likeCount: Number(data.likeCount ?? data.metrics?.likeCount ?? 0),
      quoteCount: Number(data.quoteCount ?? 0),
      viewCount: Number(data.viewCount ?? data.metrics?.viewCount ?? 0),
      createdAt: formatTwitterDate(data.createdAt),
      lang: String(data.lang || 'in'),
      bookmarkCount: Number(data.bookmarkCount ?? data.metrics?.bookmarkCount ?? 0),
      isReply,
      inReplyToId,
      conversationId: effectiveConvId,
      inReplyToUserId,
      inReplyToUsername,
      isPinned: Boolean(data.isPinned ?? false),
      author,
      extendedEntities,
      card,
      place,
      entities,
      reply_to_user_results: data.reply_to_user_results ?? null,
      quoted_tweet_results: data.quoted_tweet_results ?? null,
      quoted_tweet: data.quoted_tweet ?? null,
      retweeted_tweet: data.retweeted_tweet ?? null,
      isConversationControlled: Boolean(data.isConversationControlled ?? false)
    };
  }

  /**
   * Extract tweet detail from a single tweet container element.
   */
  function extractTweetArticle(articleEl, targetStatusId = null, opts = {}) {
    if (!articleEl) return null;

    // 1. Time element & permalink
    const timeEl = articleEl.querySelector('time');
    const timeLink = timeEl ? timeEl.closest('a') : null;
    let permalink = timeLink ? timeLink.getAttribute('href') : null;

    if (!permalink) {
      const statusLinks = articleEl.querySelectorAll('a[href*="/status/"]');
      for (const a of statusLinks) {
        const h = a.getAttribute('href');
        if (h && /\/status\/\d+/.test(h)) {
          permalink = h;
          break;
        }
      }
    }

    let statusId = targetStatusId || null;
    let urlUsername = '';
    if (permalink) {
      const match = permalink.match(/(?:^|\/)([A-Za-z0-9_]+)\/status\/(\d+)/);
      if (match) {
        urlUsername = match[1];
        if (!statusId) statusId = match[2];
      }
    }

    if (!statusId) {
      const anyStatusLink = articleEl.querySelector('a[href*="/status/"]');
      if (anyStatusLink) {
        const m = anyStatusLink.getAttribute('href').match(/\/status\/(\d+)/);
        if (m) statusId = m[1];
      }
    }

    // 2. Author extraction
    const author = extractAuthorInfo(articleEl, urlUsername);

    // 3. Text content
    let tweetText = extractBodyText(articleEl, author.displayName, author.handle);

    // 4. Timestamp
    let createdAt = timeEl ? timeEl.getAttribute('datetime') : null;
    if (!createdAt && timeEl) {
      createdAt = timeEl.innerText.trim();
    }
    if (!createdAt) {
      const textMatch = articleEl.innerText?.match(/\b\d{1,2}:\d{2}\s*(?:AM|PM)\s*·\s*[A-Za-z]{3}\s*\d{1,2},\s*\d{4}/i);
      if (textMatch) {
        createdAt = textMatch[0].replace(/·/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }

    // 5. Full URL
    const fullUrl = author.handle && statusId
      ? `https://x.com/${author.handle}/status/${statusId}`
      : (permalink ? (permalink.startsWith('http') ? permalink : `https://x.com${permalink}`) : window.location.href);

    // 6. Metrics extraction
    const metrics = extractMetrics(articleEl);

    // 7. Media items (photos / videos)
    const media = extractMedia(articleEl);

    // 8. Card extraction
    const card = extractCard(articleEl);
    if (card && card.url && !tweetText.includes(card.url)) {
      tweetText = tweetText ? `${tweetText}\n${card.url}` : card.url;
    }

    // 9. Entities extraction
    const entities = extractEntities(articleEl, tweetText);

    // 10. Language
    const tweetTextEl = articleEl.querySelector('[data-testid="tweetText"]');
    const lang = tweetTextEl?.getAttribute('lang') || articleEl.querySelector('[lang]')?.getAttribute('lang') || 'in';

    const rawData = {
      id: statusId || targetStatusId || '',
      url: fullUrl,
      text: tweetText,
      createdAt: createdAt || new Date().toISOString(),
      lang,
      author: {
        name: author.displayName,
        userName: author.handle,
        profilePicture: author.avatarUrl,
        isVerified: author.isVerified,
        isBlueVerified: author.isBlueVerified,
        coverPicture: author.coverPicture,
        description: author.description,
        location: author.location
      },
      metrics,
      likeCount: metrics.likeCount,
      retweetCount: metrics.retweetCount,
      replyCount: metrics.replyCount,
      bookmarkCount: metrics.bookmarkCount,
      viewCount: metrics.viewCount,
      quoteCount: 0,
      media,
      card,
      entities
    };

    return normalizeToXSchema(rawData, opts);
  }

  /**
   * Find all tweet containers on the page.
   * Highly resilient across all X Web variations:
   * 1. Checks dedicated focalTweet testids
   * 2. Checks all <article> elements (every article on X is a tweet card)
   * 3. Checks candidate testids: [data-testid="tweet"], [data-testid="cellInnerDiv"]
   * 4. Ultimate fallback: resolves via targetStatusId / targetUsername anchors in the DOM
   */
  function findAllTweetElements(targetStatusId, targetUsername) {
    const list = [];
    const seen = new Set();

    function addElement(el) {
      if (!el || seen.has(el)) return;
      seen.add(el);
      list.push(el);
    }

    // 1. Dedicated focal tweet container on status page
    const focalTweet = document.querySelector(
      '[data-testid="focalTweet"], [data-testid="focaltweet" i], [data-testid*="focal" i]'
    );
    if (focalTweet) {
      const container = focalTweet.closest('article') || focalTweet;
      addElement(container);
    }

    // 2. Query all <article> elements
    const articles = document.querySelectorAll('article, [role="article"]');
    articles.forEach((art) => {
      // Exclude sidebar elements (e.g. "Relevant people", "What's happening")
      if (art.closest('aside, [data-testid="sidebarColumn"]')) return;

      const hasContent = Boolean(
        art.innerText?.trim() ||
        art.querySelector('img') ||
        art.querySelector('a')
      );
      if (hasContent) {
        let isChild = false;
        for (const existing of list) {
          if (existing.contains(art) && existing !== art) {
            isChild = true;
            break;
          }
        }
        if (!isChild) {
          addElement(art);
        }
      }
    });

    // 3. Candidate containers with data-testid attributes
    const testIdCandidates = document.querySelectorAll(
      '[data-testid="tweet"], [data-testid="tweet" i], [data-testid="cellInnerDiv"], [data-testid*="tweet" i]'
    );
    testIdCandidates.forEach((el) => {
      if (el.closest('aside, [data-testid="sidebarColumn"]')) return;

      // Filter out non-tweet cellInnerDiv (e.g. UserCell / Who to follow)
      if (el.getAttribute('data-testid') === 'cellInnerDiv' && !el.querySelector('article, a[href*="/status/"]')) {
        return;
      }

      const isTweetCard = Boolean(
        el.querySelector('img[src*="profile_images"]') ||
        el.querySelector('a[href*="/status/"]') ||
        el.innerText?.includes('@')
      );
      if (isTweetCard) {
        const artWrapper = el.closest('article') || el;
        if (artWrapper.closest('aside, [data-testid="sidebarColumn"]')) return;

        let isChild = false;
        for (const existing of list) {
          if ((existing.contains(artWrapper) && existing !== artWrapper) || (artWrapper.contains(existing) && artWrapper !== existing)) {
            isChild = true;
            break;
          }
        }
        if (!isChild) {
          addElement(artWrapper);
        }
      }
    });

    // 4. Ultimate Fallback: Match container via statusId or username link
    if (list.length === 0) {
      if (targetStatusId) {
        const linkWithId = document.querySelector(`a[href*="${targetStatusId}"]`);
        if (linkWithId) {
          const container = linkWithId.closest('article, [role="article"], div[data-testid="cellInnerDiv"]') || linkWithId.parentElement?.parentElement?.parentElement;
          if (container) addElement(container);
        }
      }

      if (list.length === 0 && targetUsername) {
        const linksWithUser = document.querySelectorAll(`a[href="/${targetUsername}" i], a[href*="/${targetUsername}/status" i]`);
        for (const a of linksWithUser) {
          const container = a.closest('article, [role="article"], div[data-testid="cellInnerDiv"]');
          if (container) {
            addElement(container);
            break;
          }
        }
      }

      if (list.length === 0) {
        const main = document.querySelector('main[role="main"], [data-testid="primaryColumn"], section');
        if (main) {
          const avatar = main.querySelector('img[src*="profile_images"]');
          if (avatar) {
            const block = avatar.closest('article, [role="article"], div[data-testid="cellInnerDiv"]') || avatar.parentElement?.parentElement?.parentElement?.parentElement;
            if (block) addElement(block);
          }
        }
      }
    }

    return list;
  }

  /**
   * Helper: Check if article is a promoted advertisement tweet
   */
  function isPromotedTweet(articleEl) {
    if (!articleEl) return false;
    const hasTime = Boolean(articleEl.querySelector('time'));
    const text = articleEl.innerText || '';
    if (!hasTime && (/\b(?:Ad|Promoted|Dipromosikan)\b/i.test(text) || articleEl.querySelector('[data-testid="placementTracking"]'))) {
      return true;
    }
    return false;
  }

  /**
   * Helper: Locate "Discover more" / recommendation heading in main timeline
   */
  function getDiscoverHeading() {
    const mainCol = document.querySelector('main[role="main"], [data-testid="primaryColumn"]') || document.body;
    const headings = Array.from(mainCol.querySelectorAll('h2, [role="heading"]'));
    return headings.find((h) => {
      const t = (h.innerText || '').trim().toLowerCase();
      return (
        t === 'discover more' ||
        t === 'more posts' ||
        t === 'more tweets' ||
        t === 'temukan lebih banyak' ||
        t === 'postingan lainnya' ||
        t === 'tweet lainnya' ||
        t === 'rekomendasi' ||
        t === 'recommended'
      );
    });
  }

  /**
   * Extract main tweet and its replies from the DOM
   */
  async function extractXPostFromDom(targetStatusId, targetUsername) {
    // Retry loop with delay to handle client-side React hydration
    let tweetElements = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      tweetElements = findAllTweetElements(targetStatusId, targetUsername);
      if (tweetElements.length > 0) break;
      await new Promise((r) => setTimeout(r, 350));
    }

    if (tweetElements.length === 0) {
      throw new Error('No tweet element found on this page. Please ensure the tweet page has fully loaded.');
    }

    // 1. Locate the main tweet article
    let mainArticle = null;

    // Priority A: explicit focalTweet
    const focalEl = document.querySelector(
      '[data-testid="focalTweet"], [data-testid="focaltweet" i], [data-testid*="focal" i]'
    );
    if (focalEl) {
      mainArticle = focalEl.closest('article') || focalEl;
    }

    // Priority B1: matching by targetStatusId in explicit time permalinks
    if (!mainArticle && targetStatusId) {
      mainArticle = tweetElements.find((art) => {
        const timeEl = art.querySelector('time');
        const timeLink = timeEl ? timeEl.closest('a') : null;
        return Boolean(timeLink && timeLink.getAttribute('href')?.includes(targetStatusId));
      });
    }

    // Priority B2: matching by targetStatusId anywhere
    if (!mainArticle && targetStatusId) {
      mainArticle = tweetElements.find((art) => {
        const anyLink = art.querySelector(`a[href*="/status/${targetStatusId}"]`);
        return Boolean(anyLink);
      });
    }

    // Priority C: matching by author username
    if (!mainArticle && targetUsername) {
      mainArticle = tweetElements.find((art) => {
        const userContainer = art.querySelector('[data-testid="User-Name"], [data-testid*="user" i]');
        return userContainer && userContainer.innerText.toLowerCase().includes(`@${targetUsername.toLowerCase()}`);
      });
    }

    // Priority D: first tweet element found
    if (!mainArticle && tweetElements.length > 0) {
      mainArticle = tweetElements[0];
    }

    const mainPost = extractTweetArticle(mainArticle, targetStatusId, { isReply: false });
    if (!mainPost) {
      throw new Error('Failed to parse main tweet element.');
    }
    if (!mainPost.text && (!mainPost.extendedEntities || !mainPost.extendedEntities.media)) {
      if (!mainPost.id) mainPost.id = targetStatusId || 'unknown';
    }

    if (targetUsername && (!mainPost.author.userName || mainPost.author.userName === 'X User')) {
      mainPost.author.userName = targetUsername;
      mainPost.author.url = `https://x.com/${targetUsername}`;
      mainPost.author.twitterUrl = `https://twitter.com/${targetUsername}`;
    }

    // 2. Extract reply comments from subsequent articles
    const comments = [];
    const seenCommentIds = new Set();
    if (mainPost.id) seenCommentIds.add(mainPost.id);
    if (mainPost.url) seenCommentIds.add(mainPost.url);

    // Look for comments if mainPost.replyCount > 0 or additional tweet elements exist on page
    if (mainPost.replyCount > 0 || tweetElements.length > 1) {
      // Find where "Discover more" or recommendations begin to prevent scraping recommended feed
      let discoverHeading = getDiscoverHeading();

      tweetElements.forEach((art) => {
        if (art === mainArticle || art.contains(mainArticle) || mainArticle.contains(art)) return;
        if (isPromotedTweet(art)) return;

        // Skip if positioned after "Discover more"
        if (discoverHeading) {
          if ((discoverHeading.compareDocumentPosition(art) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) {
            return;
          }
        }

        const isFollowing = (mainArticle.compareDocumentPosition(art) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        if (!isFollowing) return;

        const replyData = extractTweetArticle(art, null, {
          isReply: true,
          inReplyToId: mainPost.id,
          conversationId: mainPost.id,
          inReplyToUsername: mainPost.author.userName,
          inReplyToUserId: mainPost.author.id || null
        });
        if (!replyData) return;

        const replyId = replyData.id || replyData.url;
        if (replyId && !seenCommentIds.has(replyId)) {
          seenCommentIds.add(replyId);
          if (replyData.url) seenCommentIds.add(replyData.url);
          comments.push(replyData);
        }
      });

      // Peek scroll ONLY if replies were expected (> 0) but not yet rendered in DOM
      if (comments.length === 0 && mainPost.replyCount > 0) {
        const scrollYBefore = window.scrollY;
        window.scrollBy({ top: 500, behavior: 'instant' });
        await new Promise((r) => setTimeout(r, 500));

        // Re-query discoverHeading in case it loaded after scrolling!
        discoverHeading = getDiscoverHeading();

        const updatedElements = findAllTweetElements(targetStatusId, targetUsername);
        updatedElements.forEach((art) => {
          if (art === mainArticle || art.contains(mainArticle) || mainArticle.contains(art)) return;
          if (isPromotedTweet(art)) return;
          if (discoverHeading && (discoverHeading.compareDocumentPosition(art) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return;

          const isFollowing = (mainArticle.compareDocumentPosition(art) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
          if (!isFollowing) return;

          const replyData = extractTweetArticle(art, null, {
            isReply: true,
            inReplyToId: mainPost.id,
            conversationId: mainPost.id,
            inReplyToUsername: mainPost.author.userName,
            inReplyToUserId: mainPost.author.id || null
          });
          if (!replyData) return;

          const replyId = replyData.id || replyData.url;
          if (replyId && !seenCommentIds.has(replyId)) {
            seenCommentIds.add(replyId);
            if (replyData.url) seenCommentIds.add(replyData.url);
            comments.push(replyData);
          }
        });

        window.scrollTo({ top: scrollYBefore, behavior: 'instant' });
      }
    }

    const allPosts = [mainPost, ...comments];

    return { mainPost, comments, allPosts };
  }

  /**
   * Main handler to extract current X post
   */
  async function handleExtractCurrentX(tabUrl) {
    if (window.__xIsExtracting) {
      showToast({
        title: 'Please wait',
        message: 'Scraping X tweet...',
        type: 'warning'
      });
      return { success: false, error: 'Scraping already in progress.' };
    }

    window.__xIsExtracting = true;

    try {
      const identifier = getXPostIdentifier(tabUrl || window.location.href);
      if (!identifier || !identifier.statusId) {
        showToast({
          title: 'Not an X Tweet Page',
          message: 'Please open an X/Twitter tweet before scraping data.',
          type: 'warning'
        });
        return { success: false, error: 'Not an X/Twitter tweet page.' };
      }
      const targetStatusId = identifier.statusId;
      const targetUsername = identifier.username;

      showToast({
        title: 'Extracting X Tweet...',
        message: targetUsername ? `@${targetUsername}` : 'Reading content...',
        type: 'info'
      });

      // Quick delay to allow in-flight GraphQL responses to arrive if recently navigated
      await new Promise((r) => setTimeout(r, 200));

      let mainPost = null;
      let allPosts = [];

      // 1. Run DOM extraction in parallel to have visible rendered text & comments ready
      let domResult = null;
      try {
        domResult = await extractXPostFromDom(targetStatusId, targetUsername);
      } catch (domErr) {
        console.warn('[X Extractor] DOM extraction error (will rely on interceptor):', domErr);
      }

      // 2. Check intercepted GraphQL TweetDetail payload (from x-interceptor.js)
      let intercepted = await getInterceptedDataForStatus(targetStatusId);

      // If not yet present, wait a short moment and check again
      if (!intercepted) {
        await new Promise((r) => setTimeout(r, 200));
        intercepted = await getInterceptedDataForStatus(targetStatusId);
      }

      if (intercepted && intercepted.mainPost) {
        console.log('[X Extractor] Successfully using intercepted GraphQL TweetDetail for ID:', targetStatusId);
        mainPost = intercepted.mainPost;
        allPosts = Array.isArray(intercepted.thread) && intercepted.thread.length > 0
          ? [...intercepted.thread]
          : [mainPost];

        // 3. Reconcile with DOM: if text or metrics are missing in GraphQL payload, backfill from DOM!
        if (domResult) {
          const domMap = new Map();
          if (domResult.mainPost && domResult.mainPost.id) {
            domMap.set(domResult.mainPost.id, domResult.mainPost);
          }
          if (Array.isArray(domResult.comments)) {
            for (const c of domResult.comments) {
              if (c && c.id) domMap.set(c.id, c);
            }
          }

          // Backfill mainPost text if GraphQL text was empty
          const domMain = domMap.get(mainPost.id) || domResult.mainPost;
          if (domMain && domMain.text && (!mainPost.text || !mainPost.text.trim())) {
            console.log('[X Extractor] Backfilling mainPost text from DOM:', domMain.text.slice(0, 50));
            mainPost.text = domMain.text;
          }
          if (domMain && (!mainPost.createdAt || mainPost.createdAt.length < 5) && domMain.createdAt) {
            mainPost.createdAt = domMain.createdAt;
          }
          if (domMain && mainPost.likeCount === 0 && domMain.likeCount > 0) {
            mainPost.likeCount = domMain.likeCount;
            mainPost.replyCount = domMain.replyCount || mainPost.replyCount;
            mainPost.retweetCount = domMain.retweetCount || mainPost.retweetCount;
            mainPost.viewCount = domMain.viewCount || mainPost.viewCount;
          }

          // Backfill every post in allPosts if its text or timestamp is empty
          const existingIds = new Set(allPosts.map((p) => p.id));
          for (const p of allPosts) {
            const domItem = domMap.get(p.id);
            if (domItem) {
              if (domItem.text && (!p.text || !p.text.trim())) {
                p.text = domItem.text;
              }
              if (domItem.createdAt && (!p.createdAt || p.createdAt.length < 5)) {
                p.createdAt = domItem.createdAt;
              }
              if (p.likeCount === 0 && domItem.likeCount > 0) {
                p.likeCount = domItem.likeCount;
              }
            }
          }

          // Also append any extra DOM comments not yet in intercepted thread
          if (Array.isArray(domResult.comments)) {
            for (const c of domResult.comments) {
              if (c && c.id && !existingIds.has(c.id)) {
                allPosts.push(c);
                existingIds.add(c.id);
              }
            }
          }
        }
      } else if (domResult && domResult.mainPost) {
        console.log('[X Extractor] Intercepted data not found, using full DOM extraction...');
        mainPost = domResult.mainPost;
        allPosts = domResult.allPosts;
      } else {
        throw new Error('Failed to extract tweet from either GraphQL interceptor or page DOM.');
      }

      // Save to background storage (x_posts -> x.json)
      const saveResponse = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            action: 'save_post',
            platform: 'x',
            postData: allPosts
          },
          (res) => {
            if (chrome.runtime.lastError) {
              resolve({ success: false, error: chrome.runtime.lastError.message });
            } else {
              resolve(res || { success: true });
            }
          }
        );
      });

      if (!saveResponse.success) {
        throw new Error(saveResponse.error || 'Failed to save to extension storage.');
      }

      showToast({
        title: saveResponse.isUpdate ? 'X Tweet Updated!' : 'X Tweet Saved!',
        message: mainPost.text ? (mainPost.text.length > 60 ? mainPost.text.slice(0, 60) + '...' : mainPost.text) : `@${mainPost.author.userName}`,
        type: 'success',
        badge: `Total: ${saveResponse.totalCount.toLocaleString('en-US')} tweets`,
        meta: `❤️ ${mainPost.likeCount.toLocaleString('en-US')} • 💬 ${mainPost.replyCount.toLocaleString('en-US')} replies`
      });

      return {
        success: true,
        post: mainPost,
        allPosts,
        isUpdate: saveResponse.isUpdate,
        totalCount: saveResponse.totalCount
      };
    } catch (err) {
      console.error('[X Extractor] Error:', err);
      showToast({
        title: 'Scraping Failed',
        message: err.message || 'An error occurred while reading X tweet data.',
        type: 'error'
      });
      return { success: false, error: err.message };
    } finally {
      window.__xIsExtracting = false;
      isExtracting = false;
    }
  }

  // Bind to global handler so re-injected scripts cleanly update the active logic
  window.__xExtractorHandler = handleExtractCurrentX;

  /**
   * Listen for messages from background / popup
   */
  if (!window.__xMessageListenerAttached) {
    window.__xMessageListenerAttached = true;
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'check_status') {
        const identifier = getXPostIdentifier(request.tabUrl || window.location.href);
        const isPostPage = Boolean(identifier);
        sendResponse({
          isPostPage,
          postInfo: identifier
        });
        return true;
      }

      if (request.action === 'extract_current_x') {
        if (typeof window.__xExtractorHandler === 'function') {
          window.__xExtractorHandler(request.tabUrl)
            .then((result) => sendResponse(result))
            .catch((err) => sendResponse({ success: false, error: err.message }));
        } else {
          sendResponse({ success: false, error: 'X handler not ready.' });
        }
        return true;
      }
    });
  }

  console.log('[X Extractor] Content script v1.4.1 loaded successfully.');
})();
