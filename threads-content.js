// Content Script for Threads Post & Reply Data Extractor (v1.3.1)
(function () {
  'use strict';

  if (window.__threadsExtractorLoaded) return;
  window.__threadsExtractorLoaded = true;

  const THREADS_APP_ID = '238260118697367'; // Official Threads Web App ID
  let isExtracting = false;

  /**
   * Helper: Parse formatted number strings accurately to integer.
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
   * Helper: Convert Threads/Instagram shortcode (base64) to numeric Media ID (BigInt)
   * Example: "DgFCogFAfFi" -> "4036644220323361122"
   */
  function shortcodeToMediaId(shortcode) {
    if (!shortcode || typeof shortcode !== 'string') return null;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let id = 0n;
    for (let i = 0; i < shortcode.length; i++) {
      const char = shortcode[i];
      const val = BigInt(alphabet.indexOf(char));
      if (val < 0n) return null;
      id = id * 64n + val;
    }
    return id > 0n ? id.toString() : null;
  }

  /**
   * Helper: Retrieve csrftoken cookie value if present
   */
  function getCsrfToken() {
    try {
      const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
      return match ? match[1] : '';
    } catch (_) {
      return '';
    }
  }

  /**
   * Toast notification on Threads page
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
   * Helper: Detect Threads Post Identifier from URL or DOM
   */
  function getThreadsIdentifier(passedUrl = null) {
    const candidates = [passedUrl, window.location.href, window.location.pathname, document.URL].filter(Boolean);

    for (const urlStr of candidates) {
      const match = urlStr.match(/(?:@([\w.-]+)\/)?post\/([A-Za-z0-9_-]+)/i);
      if (match) {
        return {
          shortcode: match[2],
          username: match[1] || ''
        };
      }
    }

    // Modal or Feed check
    const modalLinks = Array.from(document.querySelectorAll('a[href*="/post/"]'));
    for (const link of modalLinks) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/(?:@([\w.-]+)\/)?post\/([A-Za-z0-9_-]+)/i);
      if (match) {
        return {
          shortcode: match[2],
          username: match[1] || ''
        };
      }
    }

    return null;
  }

  /**
   * Strategy 0: Fetch from Threads internal Web API
   */
  async function fetchThreadsApi(mediaId) {
    if (!mediaId) return null;
    const origin = window.location.origin.includes('threads.com') ? 'https://www.threads.com' : 'https://www.threads.net';

    const headers = {
      'X-IG-App-ID': THREADS_APP_ID,
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': '*/*'
    };
    const csrf = getCsrfToken();
    if (csrf) headers['X-CSRFToken'] = csrf;

    const [infoRes, commentsRes] = await Promise.allSettled([
      fetch(`${origin}/api/v1/media/${mediaId}/info/`, { method: 'GET', headers, credentials: 'include' }),
      fetch(`${origin}/api/v1/media/${mediaId}/comments/?can_support_threading=true&permalink_enabled=false`, { method: 'GET', headers, credentials: 'include' })
    ]);

    let infoData = null;
    let commentsData = null;

    if (infoRes.status === 'fulfilled' && infoRes.value.ok) {
      try { infoData = await infoRes.value.json(); } catch (_) {}
    }
    if (commentsRes.status === 'fulfilled' && commentsRes.value.ok) {
      try { commentsData = await commentsRes.value.json(); } catch (_) {}
    }

    if (!infoData && !commentsData) return null;
    return { infoData, commentsData };
  }

  /**
   * Strategy 1: Find post & replies recursively in embedded Relay/JSON tree
   */
  function findAllThreadDataInObject(rootObj, shortcode) {
    let mainPost = null;
    const repliesMap = new Map();

    function traverse(obj) {
      if (!obj || typeof obj !== 'object') return;

      // 1. Direct post match for main post
      if (obj.code === shortcode || obj.shortcode === shortcode) {
        if (!mainPost && (obj.caption || obj.text || obj.user)) {
          mainPost = obj;
        }
      }

      // 2. Containing thread items
      if (obj.containing_thread && Array.isArray(obj.containing_thread.thread_items)) {
        for (const item of obj.containing_thread.thread_items) {
          if (item?.post && (item.post.code === shortcode || item.post.shortcode === shortcode)) {
            mainPost = item.post;
          }
        }
      }

      // 3. Reply threads array (where Threads Relay store nests all comments/replies)
      if (Array.isArray(obj.reply_threads)) {
        for (const rt of obj.reply_threads) {
          if (rt && Array.isArray(rt.thread_items)) {
            for (const item of rt.thread_items) {
              if (item?.post && item.post.code !== shortcode && item.post.shortcode !== shortcode) {
                const pId = String(item.post.pk || item.post.id || item.post.code || item.post.shortcode || '');
                if (pId && !repliesMap.has(pId)) {
                  repliesMap.set(pId, item.post);
                }
              }
            }
          }
        }
      }

      // 4. Thread items array
      if (Array.isArray(obj.thread_items)) {
        for (const item of obj.thread_items) {
          if (item?.post) {
            if (item.post.code === shortcode || item.post.shortcode === shortcode) {
              if (!mainPost) mainPost = item.post;
            } else {
              const pId = String(item.post.pk || item.post.id || item.post.code || '');
              if (pId && !repliesMap.has(pId)) {
                repliesMap.set(pId, item.post);
              }
            }
          }
        }
      }

      // 5. Edge-based arrays (GraphQL edges)
      if (Array.isArray(obj.edges)) {
        for (const edge of obj.edges) {
          const node = edge?.node;
          if (node?.thread_items && Array.isArray(node.thread_items)) {
            for (const item of node.thread_items) {
              if (item?.post && item.post.code !== shortcode && item.post.shortcode !== shortcode) {
                const pId = String(item.post.pk || item.post.id || item.post.code || item.post.shortcode || '');
                if (pId && !repliesMap.has(pId)) {
                  repliesMap.set(pId, item.post);
                }
              }
            }
          }
        }
      }

      for (const k of Object.keys(obj)) {
        if (typeof obj[k] === 'object' && obj[k] !== null) {
          traverse(obj[k]);
        }
      }
    }

    traverse(rootObj);

    if (mainPost || repliesMap.size > 0) {
      return { mainPost, replies: Array.from(repliesMap.values()) };
    }
    return null;
  }

  /**
   * Find post & replies in embedded script tags
   */
  function extractFromEmbeddedScripts(shortcode) {
    try {
      const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
      let bestResult = null;

      for (const script of scripts) {
        let text = script.textContent;
        if (!text) continue;
        if (!text.includes(shortcode) && !text.includes('thread_items') && !text.includes('reply_threads')) continue;

        try {
          text = text.replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/, '');
          const json = JSON.parse(text);
          const found = findAllThreadDataInObject(json, shortcode);
          if (found) {
            if (!bestResult) {
              bestResult = found;
            } else {
              if (!bestResult.mainPost && found.mainPost) bestResult.mainPost = found.mainPost;
              if (found.replies.length > bestResult.replies.length) bestResult.replies = found.replies;
            }
            if (bestResult.mainPost && bestResult.replies.length > 0) {
              return bestResult;
            }
          }
        } catch (_) {}
      }

      if (bestResult) return bestResult;
    } catch (e) {
      console.warn('[Threads Extractor] Script tag parsing failed:', e);
    }
    return null;
  }

  /**
   * Helper: Normalize comment node
   */
  function normalizeThreadComment(c) {
    if (!c) return null;
    const authorObj = c.user || c.owner || {};
    const text = c.text || c.caption?.text || '';
    const epoch = c.taken_at || c.created_at || c.created_at_utc || 0;
    let publishedAt = new Date().toISOString();
    if (epoch > 0) {
      try {
        const ms = epoch > 1e11 ? epoch : epoch * 1000;
        publishedAt = new Date(ms).toISOString();
      } catch (_) {}
    }

    const likeCount = c.like_count !== undefined
      ? parseAccurateNumber(c.like_count)
      : (c.comment_like_count !== undefined ? parseAccurateNumber(c.comment_like_count) : 0);

    const replyCountRaw = c.text_post_app_info?.direct_reply_count ?? c.child_comment_count ?? c.reply_count;
    const replyCount = replyCountRaw !== undefined ? parseAccurateNumber(replyCountRaw) : 0;

    const authorUsername = authorObj.username || '';
    const commentShortcode = c.code || c.shortcode || '';
    let commentUrl = '';
    if (authorUsername && commentShortcode) {
      commentUrl = `https://www.threads.net/@${authorUsername}/post/${commentShortcode}`;
    }

    return {
      id: String(c.pk || c.id || (c.code ? shortcodeToMediaId(c.code) : '') || ''),
      text,
      url: commentUrl,
      publishedAt,
      takenAt: epoch > 0 ? (epoch > 1e11 ? Math.floor(epoch / 1000) : epoch) : Math.floor(Date.now() / 1000),
      author: {
        id: String(authorObj.pk || authorObj.id || ''),
        username: authorObj.username || '',
        fullName: authorObj.full_name || authorObj.username || '',
        profilePicUrl: authorObj.profile_pic_url || '',
        isVerified: Boolean(authorObj.is_verified)
      },
      likeCount,
      replyCount
    };
  }

  /**
   * Helper: Extract clean comment text from a Threads reply card
   * Excludes timestamps (e.g. "2d"), usernames, action buttons, "Translate", etc.
   */
  function extractReplyCardText(cardEl, authorUsername) {
    if (!cardEl) return '';

    const candidates = Array.from(cardEl.querySelectorAll('span[dir="auto"], div[dir="auto"], p'));
    const validParagraphs = [];

    for (const el of candidates) {
      // Exclude buttons, svgs, header, author links, timestamp links, time elements
      if (el.closest('button, [role="button"], a[href^="/@"], a[href*="/@"], a[href*="/post/"], time, svg, nav, aside, header')) {
        continue;
      }

      const t = (el.innerText || el.textContent || '').trim();
      if (!t) continue;

      const lower = t.toLowerCase();

      // Reject if it is author username
      if (authorUsername && lower === authorUsername.toLowerCase()) continue;

      // Reject standalone relative timestamp text (e.g. "2d", "4w", "10m", "1h", "2 hari lalu", "5m lalu")
      if (/^\d+\s*(?:s|m|h|d|w|y|detik|menit|jam|hari|minggu|bulan|tahun)(?:\s+(?:ago|lalu|yang lalu))?$/i.test(t)) continue;

      // Reject UI strings
      if (['translate', 'terjemahkan', 'show replies', 'hide replies', 'reply', 'balas', 'view replies', 'lihat balasan', 'likes', 'suka', 'top'].includes(lower)) continue;

      // Reject pure punctuation, dots, or bullets
      if (/^[\s•·|–—\-.,;:_~#*+=\\/…]+$/.test(t)) continue;

      // Reject standalone numbers (action counts)
      if (/^\d+([.,]\d+)?\s*(?:rb|k|jt|m|b)?$/i.test(t)) continue;

      // Prevent duplicate substrings if parent and child both matched
      const isDuplicate = validParagraphs.some(vp => vp === t || vp.includes(t));
      if (!isDuplicate) {
        validParagraphs.push(t);
      }
    }

    let result = validParagraphs.join('\n\n').trim();
    // Strip trailing Translate
    result = result.replace(/\s*(?:translate|terjemahkan)\s*$/i, '').trim();
    return result;
  }

  /**
   * Helper: Extract engagement counts (like, reply, repost) from a card container
   */
  function extractReplyCardEngagement(cardEl) {
    let likeCount = 0;
    let replyCount = 0;
    let repostCount = 0;

    if (!cardEl) return { likeCount, replyCount, repostCount };

    const interactive = Array.from(cardEl.querySelectorAll('button, [role="button"], div[aria-label]'));
    for (const btn of interactive) {
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      const btnText = (btn.textContent || '').trim();
      let num = parseAccurateNumber(btnText);

      // If button has no text, look at next element (count badge)
      if (num === 0 && btn.nextElementSibling) {
        const nextText = (btn.nextElementSibling.textContent || '').trim();
        num = parseAccurateNumber(nextText);
      }

      if (aria.includes('like') || aria.includes('suka') || btn.querySelector('svg[aria-label*="Like"], svg[aria-label*="Suka"]')) {
        if (num > 0) likeCount = num;
      } else if (aria.includes('reply') || aria.includes('balas') || btn.querySelector('svg[aria-label*="Reply"], svg[aria-label*="Balas"]')) {
        if (num > 0) replyCount = num;
      } else if (aria.includes('repost') || btn.querySelector('svg[aria-label*="Repost"]')) {
        if (num > 0) repostCount = num;
      }
    }

    // Fallback: search SVG elements directly
    if (likeCount === 0 && replyCount === 0) {
      const svgs = Array.from(cardEl.querySelectorAll('svg'));
      for (const svg of svgs) {
        const parent = svg.closest('button, [role="button"], div');
        const combinedAria = ((svg.getAttribute('aria-label') || '') + ' ' + (parent?.getAttribute('aria-label') || '')).toLowerCase();
        const text = parent ? parent.textContent.trim() : '';
        const num = parseAccurateNumber(text);
        if (num > 0) {
          if (combinedAria.includes('like') || combinedAria.includes('suka')) likeCount = num;
          else if (combinedAria.includes('reply') || combinedAria.includes('balas')) replyCount = num;
          else if (combinedAria.includes('repost')) repostCount = num;
        }
      }
    }

    return { likeCount, replyCount, repostCount };
  }

  /**
   * Strategy 2: Extract Post & Comments from DOM
   * Scopes strictly to main feed area, completely excluding sidebars and suggestions.
   */
  function extractFromThreadsDom(shortcode, defaultUsername) {
    const mainArea = document.querySelector('main, [role="main"]') || document.body;

    // 1. Locate Main Post Article
    let mainArticle = null;
    const articles = Array.from(mainArea.querySelectorAll('article'));
    for (const art of articles) {
      if (art.querySelector(`a[href*="/${shortcode}"]`)) {
        mainArticle = art;
        break;
      }
    }
    if (!mainArticle && articles.length > 0) {
      mainArticle = articles[0];
    }
    if (!mainArticle) {
      mainArticle = mainArea;
    }

    // 2. Author Info of Main Post
    const authorLink = mainArticle.querySelector('a[href^="/@"], a[href*="/@"]');
    let username = defaultUsername || '';
    if (authorLink) {
      const match = (authorLink.getAttribute('href') || '').match(/@([^/?#]+)/);
      if (match) username = match[1];
    }

    let fullName = username;
    const headerTitleEl = mainArticle.querySelector('h2, header a span, a span');
    if (headerTitleEl && headerTitleEl.textContent.trim()) {
      fullName = headerTitleEl.textContent.trim();
    }

    const avatarImg = mainArticle.querySelector('img[alt*="profile"], header img, img');
    const profilePicUrl = avatarImg ? avatarImg.src : '';

    // 3. Main Post Text
    let postText = extractReplyCardText(mainArticle, username);

    // 4. Main Post Metrics
    const mainEngagement = extractReplyCardEngagement(mainArticle);
    let likeCount = mainEngagement.likeCount;
    let replyCount = mainEngagement.replyCount;
    let repostCount = mainEngagement.repostCount;
    let viewCount = 0;

    // View count from thread header (e.g. "14.4K views")
    const viewsEl = mainArea.querySelector('[aria-label*="view"], [aria-label*="tayangan"]') ||
                    Array.from(mainArea.querySelectorAll('span, div')).find(el => /\d+([.,]\d+)?\s*(?:k|rb|m|jt)?\s*(?:views|tayangan)/i.test(el.textContent));
    if (viewsEl) {
      const vMatch = viewsEl.textContent.match(/([\d.,]+\s*(?:k|rb|m|jt)?)\s*(?:views|tayangan)/i);
      if (vMatch) viewCount = parseAccurateNumber(vMatch[1]);
    }

    // 5. Main Post Timestamp
    let publishedAt = new Date().toISOString();
    let takenAt = Math.floor(Date.now() / 1000);
    const timeEl = mainArticle.querySelector('time[datetime]');
    if (timeEl) {
      const dt = timeEl.getAttribute('datetime');
      if (dt) {
        try {
          publishedAt = new Date(dt).toISOString();
          takenAt = Math.floor(new Date(dt).getTime() / 1000);
        } catch (_) {}
      }
    }

    // 6. Extract Reply Comments
    const comments = [];
    const visitedPermalinks = new Set();
    const visitedCards = new Set();

    const replyAuthorLinks = Array.from(mainArea.querySelectorAll('a[href^="/@"], a[href*="/@"]'));

    for (const aLink of replyAuthorLinks) {
      // Exclude navigation, sidebar, aside
      if (aLink.closest('nav, aside, [role="navigation"]')) continue;
      // Exclude main article author header
      if (mainArticle && mainArticle.contains(aLink) && aLink.closest('header, h2')) continue;

      const mUser = (aLink.getAttribute('href') || '').match(/@([^/?#]+)/);
      const rUsername = mUser ? mUser[1] : '';
      if (!rUsername) continue;

      // Find enclosing reply card container
      let cardEl = aLink.closest('article');
      if (!cardEl) {
        let p = aLink.parentElement;
        while (p && p !== mainArea && p.tagName !== 'MAIN') {
          if (p.querySelector('time') && p.querySelector('svg')) {
            cardEl = p;
            break;
          }
          p = p.parentElement;
        }
      }

      if (!cardEl || visitedCards.has(cardEl)) continue;
      if (cardEl === mainArticle || (mainArticle && cardEl.contains(mainArticle))) continue;
      visitedCards.add(cardEl);

      // Check permalink to get reply shortcode and media ID
      const postLink = cardEl.querySelector('a[href*="/post/"]');
      const permalinkHref = postLink ? (postLink.getAttribute('href') || '') : '';
      const permalinkMatch = permalinkHref.match(/\/post\/([A-Za-z0-9_-]+)/);

      // Do not re-add main post as reply comment
      if (permalinkMatch && permalinkMatch[1] === shortcode) continue;

      const replyShortcode = permalinkMatch ? permalinkMatch[1] : '';
      if (replyShortcode && visitedPermalinks.has(replyShortcode)) continue;
      if (replyShortcode) visitedPermalinks.add(replyShortcode);

      const replyId = replyShortcode ? (shortcodeToMediaId(replyShortcode) || replyShortcode) : '';

      // Full Name & Avatar
      let rFullName = rUsername;
      const rNameEl = cardEl.querySelector('header a span, h2, a span, [data-pressable-container="true"] span');
      if (rNameEl && rNameEl.textContent.trim()) {
        const nameCandidate = rNameEl.textContent.trim();
        if (nameCandidate.toLowerCase() !== rUsername.toLowerCase()) {
          rFullName = nameCandidate;
        }
      }

      const rAvatarImg = cardEl.querySelector('img[alt*="profile"], header img, img');
      const rAvatar = rAvatarImg ? rAvatarImg.src : '';

      // Timestamp
      let rPublishedAt = new Date().toISOString();
      let rTakenAt = Math.floor(Date.now() / 1000);
      const rTimeEl = cardEl.querySelector('time[datetime]');
      if (rTimeEl) {
        const dt = rTimeEl.getAttribute('datetime');
        if (dt) {
          try {
            rPublishedAt = new Date(dt).toISOString();
            rTakenAt = Math.floor(new Date(dt).getTime() / 1000);
          } catch (_) {}
        }
      }

      // Comment Text
      const rText = extractReplyCardText(cardEl, rUsername);
      if (!rText) continue;

      // Engagement
      const rEngagement = extractReplyCardEngagement(cardEl);

      let replyUrl = '';
      if (rUsername && replyShortcode) {
        replyUrl = `https://www.threads.net/@${rUsername}/post/${replyShortcode}`;
      } else if (permalinkHref) {
        replyUrl = permalinkHref.startsWith('http') ? permalinkHref : `https://www.threads.net${permalinkHref}`;
      }

      comments.push({
        id: replyId,
        text: rText,
        url: replyUrl,
        publishedAt: rPublishedAt,
        takenAt: rTakenAt,
        author: {
          id: '',
          username: rUsername,
          fullName: rFullName,
          profilePicUrl: rAvatar,
          isVerified: Boolean(cardEl.querySelector('svg[aria-label*="Verified"], svg[aria-label*="Terverifikasi"]'))
        },
        likeCount: rEngagement.likeCount,
        replyCount: rEngagement.replyCount
      });
    }

    const postUrl = username
      ? `https://www.threads.net/@${username}/post/${shortcode}`
      : window.location.href.split('?')[0];

    return {
      id: shortcodeToMediaId(shortcode) || '',
      shortcode,
      text: postText,
      url: postUrl,
      publishedAt,
      takenAt,
      author: {
        id: '',
        username,
        fullName,
        profilePicUrl,
        isVerified: Boolean(mainArticle.querySelector('svg[aria-label*="Verified"], svg[aria-label*="Terverifikasi"]'))
      },
      likeCount,
      replyCount: Math.max(replyCount, comments.length),
      repostCount,
      quoteCount: 0,
      viewCount,
      comments
    };
  }

  /**
   * Normalize Threads Data from API / Relay to Target Schema
   */
  function normalizeToThreadsSchema(apiData, scriptData, shortcode, defaultUsername) {
    const mediaItem = apiData?.infoData?.items?.[0] || scriptData?.mainPost || null;
    const scriptReplies = scriptData?.replies || [];
    const apiComments = apiData?.commentsData?.comments || [];

    // Fallback to DOM
    const domData = extractFromThreadsDom(shortcode, defaultUsername);

    if (!mediaItem) {
      return domData;
    }

    const id = String(mediaItem.pk || mediaItem.id || shortcodeToMediaId(shortcode) || '');
    const text = mediaItem.caption?.text || mediaItem.text || domData.text || '';

    const authorObj = mediaItem.user || mediaItem.owner || {};
    const username = authorObj.username || defaultUsername || domData.author.username || '';
    const fullName = authorObj.full_name || username || domData.author.fullName || '';
    const profilePicUrl = authorObj.profile_pic_url || domData.author.profilePicUrl || '';
    const isVerified = Boolean(authorObj.is_verified || domData.author.isVerified);

    const postUrl = username
      ? `https://www.threads.net/@${username}/post/${shortcode}`
      : `https://www.threads.net/post/${shortcode}`;

    const epoch = mediaItem.taken_at || mediaItem.created_at || domData.takenAt;
    let publishedAt = domData.publishedAt;
    if (epoch > 0) {
      try {
        const ms = epoch > 1e11 ? epoch : epoch * 1000;
        publishedAt = new Date(ms).toISOString();
      } catch (_) {}
    }

    const likeCount = mediaItem.like_count !== undefined
      ? parseAccurateNumber(mediaItem.like_count)
      : domData.likeCount;

    const textPostAppInfo = mediaItem.text_post_app_info || {};
    const replyCountRaw = textPostAppInfo.direct_reply_count ?? mediaItem.comment_count ?? mediaItem.reply_count;
    const repostCountRaw = textPostAppInfo.repost_count ?? textPostAppInfo.reshare_count ?? mediaItem.repost_count;
    const quoteCountRaw = textPostAppInfo.quote_count ?? mediaItem.quote_count;

    // Normalizing comments: prioritize script replies or API comments, fallback to DOM
    let normalizedComments = [];
    const candidateComments = scriptReplies.length > 0 ? scriptReplies : apiComments;
    if (Array.isArray(candidateComments) && candidateComments.length > 0) {
      normalizedComments = candidateComments.map(normalizeThreadComment).filter(Boolean);
    }

    // If script had no comments or fewer comments than rendered on DOM, use DOM comments!
    if (domData.comments.length > 0) {
      if (normalizedComments.length === 0) {
        normalizedComments = domData.comments;
      } else {
        // Merge any comments from DOM that weren't in script by username or text
        for (const domC of domData.comments) {
          const matchedItem = normalizedComments.find(nc =>
            (nc.id && domC.id && nc.id === domC.id) ||
            (nc.author?.username?.toLowerCase() === domC.author?.username?.toLowerCase() &&
             nc.text.trim().toLowerCase() === domC.text.trim().toLowerCase())
          );
          if (matchedItem) {
            if (!matchedItem.url && domC.url) {
              matchedItem.url = domC.url;
            }
          } else {
            normalizedComments.push(domC);
          }
        }
      }
    }

    const replyCount = replyCountRaw !== undefined
      ? Math.max(parseAccurateNumber(replyCountRaw), normalizedComments.length)
      : Math.max(domData.replyCount, normalizedComments.length);

    const repostCount = repostCountRaw !== undefined
      ? parseAccurateNumber(repostCountRaw)
      : domData.repostCount;

    const quoteCount = quoteCountRaw !== undefined
      ? parseAccurateNumber(quoteCountRaw)
      : domData.quoteCount;

    const viewCount = mediaItem.view_count !== undefined
      ? parseAccurateNumber(mediaItem.view_count)
      : domData.viewCount;

    return {
      id,
      shortcode,
      text,
      url: postUrl,
      publishedAt,
      takenAt: epoch > 0 ? (epoch > 1e11 ? Math.floor(epoch / 1000) : epoch) : domData.takenAt,
      author: {
        id: String(authorObj.pk || authorObj.id || ''),
        username,
        fullName,
        profilePicUrl,
        isVerified
      },
      likeCount,
      replyCount,
      repostCount,
      quoteCount,
      viewCount,
      comments: normalizedComments
    };
  }

  /**
   * Main Trigger Function for Threads Extraction
   */
  async function triggerThreadsExtraction(providedInfo = null) {
    if (isExtracting) {
      return { success: false, error: 'Threads extraction already in progress.' };
    }

    const target = providedInfo || getThreadsIdentifier();
    if (!target || !target.shortcode) {
      showToast({
        title: 'Not a Threads Post',
        message: 'Please open a Threads post before scraping data.',
        type: 'warning'
      });
      return { success: false, error: 'Not a Threads post page.' };
    }

    isExtracting = true;
    showToast({
      title: 'Scraping Threads Data...',
      message: `Extracting post [${target.shortcode}]`,
      type: 'info'
    });

    try {
      const mediaId = shortcodeToMediaId(target.shortcode);

      // Strategy 0: Internal Web API
      const apiPromise = mediaId ? fetchThreadsApi(mediaId) : Promise.resolve(null);

      // Strategy 1: Embedded Script Relay Store
      const scriptResult = extractFromEmbeddedScripts(target.shortcode);

      const apiResult = await apiPromise;

      const normalizedData = normalizeToThreadsSchema(apiResult, scriptResult, target.shortcode, target.username);

      if (!normalizedData) {
        throw new Error('Failed to extract Threads post data.');
      }

      // Send to background service worker to save into Threads storage
      return await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            action: 'save_post',
            platform: 'threads',
            postData: normalizedData
          },
          (response) => {
            if (chrome.runtime.lastError) {
              console.error('[Threads Extractor] Message error:', chrome.runtime.lastError);
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
                title: isUpdated ? 'Threads Data Updated!' : 'Threads Post Saved!',
                message: `Post by @${normalizedData.author?.username || 'unknown'} saved to database. Click 'Download threads.json' in popup to export.`,
                type: 'success',
                badge: `Total: ${response.totalCount} posts`,
                meta: `❤️ ${normalizedData.likeCount.toLocaleString('en-US')} • 💬 ${normalizedData.replyCount.toLocaleString('en-US')} (${(normalizedData.comments?.length || 0).toLocaleString('en-US')} replies)`
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
      console.error('[Threads Extractor] Extraction error:', err);
      showToast({
        title: 'Scraping Failed',
        message: err.message || 'An issue occurred while reading Threads post data.',
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
    if (request.action === 'extract_current_threads' || request.action === 'extract_current_post') {
      const target = request.postInfo || getThreadsIdentifier(request.tabUrl);
      triggerThreadsExtraction(target).then((res) => {
        sendResponse(res || { success: true });
      }).catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
      return true;
    } else if (request.action === 'check_status') {
      const target = getThreadsIdentifier(request.tabUrl);
      sendResponse({
        isPostPage: Boolean(target && target.shortcode),
        platform: 'threads',
        postInfo: target ? { shortcode: target.shortcode, username: target.username } : null
      });
    }
  });

  console.log('[Threads Extractor] Content script ready.');
})();
