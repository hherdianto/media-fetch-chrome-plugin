// Content Script for X / Twitter Tweet & Reply Data Extractor (v1.4.1)
(function () {
  'use strict';

  let isExtracting = false;

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
   * Extract author information (displayName, handle, isVerified, avatarUrl)
   */
  function extractAuthorInfo(articleEl, targetUsername) {
    let displayName = '';
    let handle = '';
    let isVerified = false;
    let avatarUrl = '';

    // 1. Avatar
    const avatarImg = articleEl.querySelector('div[data-testid*="Avatar" i] img, img[src*="profile_images"]');
    if (avatarImg) {
      avatarUrl = avatarImg.src || avatarImg.getAttribute('src') || '';
    }

    // 2. User Name Container (scoped strictly to author header)
    const userNameContainer = articleEl.querySelector('[data-testid="User-Name"], [data-testid*="user" i][data-testid*="name" i]');
    if (userNameContainer) {
      // Scope verified status strictly to author container first (avoids quote tweet verified leakage)
      isVerified = Boolean(
        userNameContainer.querySelector('[data-testid="icon-verified"], svg[aria-label*="Verified" i], svg[aria-label*="Terverifikasi" i], svg[data-testid*="verified" i]')
      );

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
      isVerified = Boolean(
        articleEl.querySelector('[data-testid="icon-verified"], svg[aria-label*="Verified" i], svg[aria-label*="Terverifikasi" i], svg[data-testid*="verified" i]')
      );
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

    return { displayName, handle, isVerified, avatarUrl };
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
   * Extract tweet detail from a single tweet container element.
   */
  function extractTweetArticle(articleEl, targetStatusId = null) {
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
    const tweetText = extractBodyText(articleEl, author.displayName, author.handle);

    // 4. Timestamp
    let createdAt = timeEl ? timeEl.getAttribute('datetime') : null;
    if (!createdAt && timeEl) {
      createdAt = timeEl.innerText.trim();
    }
    if (!createdAt) {
      const textMatch = articleEl.innerText?.match(/\b\d{1,2}:\d{2}\s*(?:AM|PM)\s*·\s*[A-Za-z]{3}\s*\d{1,2},\s*\d{4}/i);
      if (textMatch) {
        createdAt = textMatch[0];
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

    return {
      id: statusId || targetStatusId || '',
      url: fullUrl,
      text: tweetText,
      createdAt: createdAt || new Date().toISOString(),
      author: {
        name: author.displayName,
        username: author.handle,
        avatar: author.avatarUrl,
        verified: author.isVerified,
        isVerified: author.isVerified
      },
      metrics,
      likeCount: metrics.likeCount,
      retweetCount: metrics.retweetCount,
      replyCount: metrics.replyCount,
      bookmarkCount: metrics.bookmarkCount,
      viewCount: metrics.viewCount,
      media: media.length > 0 ? media : undefined
    };
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

    const mainPost = extractTweetArticle(mainArticle, targetStatusId);
    if (mainPost && (!mainPost.text && !mainPost.media)) {
      if (!mainPost.id) mainPost.id = targetStatusId || 'unknown';
    }

    if (targetUsername && (!mainPost.author.username || mainPost.author.username === 'X User')) {
      mainPost.author.username = targetUsername;
    }

    // 2. Extract reply comments from subsequent articles
    const comments = [];
    const seenCommentIds = new Set();
    if (mainPost.id) seenCommentIds.add(mainPost.id);
    if (mainPost.url) seenCommentIds.add(mainPost.url);

    // Only look for comments if mainPost.replyCount > 0
    if (mainPost.replyCount > 0) {
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

        const replyData = extractTweetArticle(art);
        if (!replyData) return;

        const replyId = replyData.id || replyData.url;
        if (replyId && !seenCommentIds.has(replyId)) {
          seenCommentIds.add(replyId);
          if (replyData.url) seenCommentIds.add(replyData.url);
          comments.push({
            id: replyData.id,
            url: replyData.url,
            text: replyData.text,
            createdAt: replyData.createdAt,
            author: replyData.author,
            likeCount: replyData.likeCount,
            retweetCount: replyData.retweetCount,
            replyCount: replyData.replyCount,
            media: replyData.media
          });
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

          const replyData = extractTweetArticle(art);
          if (!replyData) return;

          const replyId = replyData.id || replyData.url;
          if (replyId && !seenCommentIds.has(replyId)) {
            seenCommentIds.add(replyId);
            if (replyData.url) seenCommentIds.add(replyData.url);
            comments.push({
              id: replyData.id,
              url: replyData.url,
              text: replyData.text,
              createdAt: replyData.createdAt,
              author: replyData.author,
              likeCount: replyData.likeCount,
              retweetCount: replyData.retweetCount,
              replyCount: replyData.replyCount,
              media: replyData.media
            });
          }
        });

        window.scrollTo({ top: scrollYBefore, behavior: 'instant' });
      }
    }

    mainPost.comments = comments;
    mainPost.commentCount = Math.max(mainPost.replyCount || 0, comments.length);

    return mainPost;
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
        title: 'Scraping X Tweet...',
        message: targetUsername ? `@${targetUsername}` : 'Reading content...',
        type: 'info'
      });

      // Quick delay to ensure client rendering if recently navigated
      await new Promise((r) => setTimeout(r, 350));

      const postData = await extractXPostFromDom(targetStatusId, targetUsername);

      // Save to background storage (x_posts -> x.json)
      const saveResponse = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            action: 'save_post',
            platform: 'x',
            postData
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
        message: postData.text ? (postData.text.length > 60 ? postData.text.slice(0, 60) + '...' : postData.text) : `@${postData.author.username}`,
        type: 'success',
        badge: `Total: ${saveResponse.totalCount.toLocaleString('en-US')} tweets`,
        meta: `❤️ ${postData.likeCount.toLocaleString('en-US')} • 💬 ${(postData.comments?.length || 0).toLocaleString('en-US')} comments`
      });

      return {
        success: true,
        post: postData,
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
