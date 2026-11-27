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

    // Modal check exclusively within dialog containers to avoid feed false-positives
    const modalContainer = document.querySelector('div[role="dialog"], [aria-modal="true"]');
    if (modalContainer) {
      const modalLinks = Array.from(modalContainer.querySelectorAll('a[href*="/post/"]'));
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
   * Strategy 1: Find post & replies in embedded Relay/JSON tree
   * Specifically targets direct_replies.edges[].node.posts.edges[] from Barcelona query
   */
  function findAllThreadDataInObject(rootObj, shortcode, mediaId = null) {
    let mainPost = null;
    let fallbackMainPost = null;
    const directRepliesMap = new Map();
    const fallbackRepliesMap = new Map();

    const targetMediaId = mediaId || (shortcode ? shortcodeToMediaId(shortcode) : null);

    function traverse(obj) {
      if (!obj || typeof obj !== 'object') return;

      // 0. Primary modern Threads Relay schema: direct_replies.edges[].node.posts.edges[]
      const dr = obj.direct_replies || obj.text_post_app_info?.direct_replies;
      if (dr && Array.isArray(dr.edges)) {
        for (const edge of dr.edges) {
          const postsEdges = edge?.node?.posts?.edges;
          if (Array.isArray(postsEdges)) {
            for (const postEdge of postsEdges) {
              const p = postEdge?.node;
              if (p) {
                const pCode = p.code || p.shortcode || '';
                const pPk = String(p.pk || (p.id ? String(p.id).split('_')[0] : ''));
                if (pCode !== shortcode && (!targetMediaId || pPk !== String(targetMediaId)) && (p.caption || p.text || p.user)) {
                  const pId = String(p.pk || (pCode ? shortcodeToMediaId(pCode) : '') || p.id || pCode || '');
                  if (pId && !directRepliesMap.has(pId)) {
                    directRepliesMap.set(pId, p);
                  }
                }
              }
            }
          }
        }
      }

      // 1. Direct posts.edges within node
      if (obj.posts && Array.isArray(obj.posts.edges) && obj.fetch_token) {
        for (const postEdge of obj.posts.edges) {
          const p = postEdge?.node;
          if (p) {
            const pCode = p.code || p.shortcode || '';
            const pPk = String(p.pk || (p.id ? String(p.id).split('_')[0] : ''));
            if (pCode !== shortcode && (!targetMediaId || pPk !== String(targetMediaId)) && (p.caption || p.text || p.user)) {
              const pId = String(p.pk || (pCode ? shortcodeToMediaId(pCode) : '') || p.id || pCode || '');
              if (pId && !directRepliesMap.has(pId)) {
                directRepliesMap.set(pId, p);
              }
            }
          }
        }
      }

      // 2. Identify main root post
      if (obj.media && typeof obj.media === 'object') {
        const m = obj.media;
        const mPk = String(m.pk || (m.id ? String(m.id).split('_')[0] : ''));
        if (m.code === shortcode || m.shortcode === shortcode || (targetMediaId && mPk === String(targetMediaId))) {
          if (!mainPost || (!mainPost.text_post_app_info && m.text_post_app_info)) {
            if (m.caption || m.text || m.user) mainPost = m;
          }
        } else if (!fallbackMainPost && m.text_post_app_info?.direct_replies && (!shortcode && !targetMediaId)) {
          fallbackMainPost = m;
        }
      }

      const objPk = String(obj.pk || (obj.id ? String(obj.id).split('_')[0] : ''));
      if (obj.code === shortcode || obj.shortcode === shortcode || (targetMediaId && objPk === String(targetMediaId))) {
        if (!mainPost || (!mainPost.text_post_app_info && obj.text_post_app_info)) {
          if (obj.caption || obj.text || obj.user) {
            mainPost = obj;
          }
        }
      }

      // 3. Legacy reply_threads array (fallback if direct_replies not found)
      if (Array.isArray(obj.reply_threads)) {
        for (const rt of obj.reply_threads) {
          if (rt && Array.isArray(rt.thread_items)) {
            for (const item of rt.thread_items) {
              if (item?.post && item.post.code !== shortcode && item.post.shortcode !== shortcode && (!targetMediaId || String(item.post.pk) !== String(targetMediaId))) {
                const pId = String(item.post.pk || item.post.id || item.post.code || item.post.shortcode || '');
                if (pId && !fallbackRepliesMap.has(pId)) {
                  fallbackRepliesMap.set(pId, item.post);
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

    const replies = directRepliesMap.size > 0
      ? Array.from(directRepliesMap.values())
      : Array.from(fallbackRepliesMap.values());

    const resolvedMainPost = mainPost || fallbackMainPost;
    if (resolvedMainPost || replies.length > 0) {
      return { mainPost: resolvedMainPost, replies };
    }
    return null;
  }

  /**
   * Find post & replies in embedded script tags
   */
  function extractFromEmbeddedScripts(shortcode) {
    try {
      const mediaId = shortcodeToMediaId(shortcode) || '';
      const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
      let bestResult = null;

      for (const script of scripts) {
        let text = script.textContent;
        if (!text) continue;
        const hasRelevantContent =
          text.includes('direct_replies') ||
          text.includes('BarcelonaPostPage') ||
          text.includes(shortcode) ||
          (mediaId && text.includes(mediaId)) ||
          text.includes('reply_threads');
        if (!hasRelevantContent) continue;

        try {
          text = text.replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/, '');
          const json = JSON.parse(text);
          const found = findAllThreadDataInObject(json, shortcode, mediaId);
          if (found) {
            if (!bestResult) {
              bestResult = found;
            } else {
              if (!bestResult.mainPost && found.mainPost) bestResult.mainPost = found.mainPost;
              if (Array.isArray(found.replies)) {
                const existingIds = new Set(bestResult.replies.map(r => String(r.pk || (r.code ? shortcodeToMediaId(r.code) : '') || r.id || '')));
                for (const r of found.replies) {
                  const rId = String(r.pk || (r.code ? shortcodeToMediaId(r.code) : '') || r.id || '');
                  if (rId && !existingIds.has(rId)) {
                    existingIds.add(rId);
                    bestResult.replies.push(r);
                  }
                }
              }
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
   * Helper: Normalize comment node into { id, userId, username, profilePicUrl, isVerified, takenAt, text, likeCount, replyCount, url, is_reply, reply_to_username, reply_to_user_id, reply_to_post_id }
   */
  function normalizeComment(c, parentContext = null) {
    if (!c) return null;
    const user = c.user || c.owner || {};
    const code = c.code || c.shortcode || '';
    const pk = String(c.pk || (code ? shortcodeToMediaId(code) : '') || (c.id && !String(c.id).includes('_') ? c.id : '') || (c.id ? String(c.id).split('_')[0] : '') || '');
    const id = pk || (code ? shortcodeToMediaId(code) : '') || code || '';
    const userId = String(user.pk || user.id || c.userId || '');
    const username = user.username || c.username || '';
    const profilePicUrl = user.profile_pic_url || c.profilePicUrl || '';
    const isVerified = Boolean(user.is_verified ?? c.isVerified);

    const epoch = c.taken_at || c.takenAt || c.created_at || c.created_at_utc || 0;
    const takenAt = epoch > 0 ? (epoch > 1e11 ? Math.floor(epoch / 1000) : epoch) : Math.floor(Date.now() / 1000);

    const text = (typeof c.text === 'string' ? c.text : '') ||
                 (typeof c.caption?.text === 'string' ? c.caption.text : '') ||
                 (typeof c.caption === 'string' ? c.caption : '') || '';
    const textPostAppInfo = c.text_post_app_info || {};
    const likeCount = parseAccurateNumber(c.like_count ?? c.likeCount ?? c.comment_like_count ?? 0);
    const replyCount = parseAccurateNumber(textPostAppInfo.direct_reply_count ?? c.reply_count ?? c.replyCount ?? 0);

    const postDomain = (typeof window !== 'undefined' && window.location?.hostname?.includes('threads.com'))
      ? 'https://www.threads.com'
      : 'https://www.threads.net';

    const url = username && code
      ? `${postDomain}/@${username}/post/${code}`
      : (c.permalink || c.url || (code ? `${postDomain}/post/${code}` : ''));

    // Extract reply_to info from reply_to_author and reply_to_post_id
    const rta = textPostAppInfo.reply_to_author || c.reply_to_author || {};
    const hasReplyIndicators = Boolean(rta.username || rta.pk || rta.id || c.reply_to_username || textPostAppInfo.reply_to_post_id || c.reply_to_post_id || parentContext);
    const isReply = Boolean(c.is_reply ?? textPostAppInfo.is_reply ?? hasReplyIndicators);

    let replyToUsername = rta.username || c.reply_to_username || '';
    let replyToUserId = String(rta.pk || rta.id || c.reply_to_user_id || '');
    let rawReplyToPost = textPostAppInfo.reply_to_post_id || c.reply_to_post_id || c.reply_to_post || '';
    let replyToPostId = typeof rawReplyToPost === 'object' && rawReplyToPost !== null
      ? String(rawReplyToPost.pk || (rawReplyToPost.id ? String(rawReplyToPost.id).split('_')[0] : '') || '')
      : String(rawReplyToPost || '').split('_')[0];

    if (isReply && parentContext) {
      if (!replyToUsername) {
        replyToUsername = parentContext.username || '';
        if (!replyToUserId && parentContext.userId) replyToUserId = parentContext.userId;
        if (!replyToPostId && parentContext.id) replyToPostId = parentContext.id;
      } else if (parentContext.username && replyToUsername.toLowerCase() === parentContext.username.toLowerCase()) {
        if (!replyToUserId && parentContext.userId) replyToUserId = parentContext.userId;
        if (!replyToPostId && parentContext.id) replyToPostId = parentContext.id;
      }
    }

    return {
      id,
      userId,
      username,
      profilePicUrl,
      isVerified,
      takenAt,
      text,
      likeCount,
      replyCount,
      url,
      is_reply: isReply,
      reply_to_username: isReply ? (replyToUsername || null) : null,
      reply_to_user_id: isReply ? (replyToUserId || null) : null,
      reply_to_post_id: isReply ? (replyToPostId || null) : null
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
      if (art.querySelector(`a[href*="/post/${shortcode}"]`)) {
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
    const isVerified = Boolean(mainArticle.querySelector('svg[aria-label*="Verified"], svg[aria-label*="Terverifikasi"]'));

    // 3. Main Post Text
    let captionText = extractReplyCardText(mainArticle, username);

    // 4. Main Post Metrics
    const mainEngagement = extractReplyCardEngagement(mainArticle);
    let likeCount = mainEngagement.likeCount;
    let directReplyCount = mainEngagement.replyCount;
    let repostCount = mainEngagement.repostCount;
    let quoteCount = 0;
    let viewCount = 0;

    // View count / quote count if available
    const quotesEl = (mainArticle || mainArea).querySelector('[aria-label*="quote"], [aria-label*="kutipan"]');
    if (quotesEl) {
      const qNum = parseAccurateNumber(quotesEl.textContent || quotesEl.getAttribute('aria-label'));
      if (qNum > 0) quoteCount = qNum;
    }

    const viewCandidates = Array.from(mainArticle.querySelectorAll('span, div[aria-label]'));
    for (const el of viewCandidates) {
      if (el.closest('button, [role="button"], a[href*="/post/"]')) continue;
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const text = (el.textContent || '').trim().toLowerCase();
      const combined = aria + ' ' + text;
      if (combined.includes('reply') || combined.includes('balas') || combined.includes('comment') || combined.includes('komentar')) continue;

      const viewMatch = combined.match(/\b([\d.,]+)\s*(?:jt|juta|m|rb|ribu|k|b|miliar)?\s*(?:views?|tayangan)\b/i);
      if (viewMatch) {
        const num = parseAccurateNumber(viewMatch[0]);
        if (num > 0) {
          viewCount = num;
          break;
        }
      }
    }

    // 5. Main Post Images
    let imageUrl = '';
    let thumbnailUrl = '';
    const postImgs = Array.from(mainArticle.querySelectorAll('img')).filter((img) => {
      if (img === avatarImg) return false;
      if (img.closest('header, [role="button"]')) return false;
      const src = img.src || '';
      return src.startsWith('http') && (img.clientWidth > 80 || img.naturalWidth > 80 || /cdninstagram|threads/i.test(src));
    });
    if (postImgs.length > 0) {
      imageUrl = postImgs[0].src;
      thumbnailUrl = postImgs[postImgs.length - 1].src;
    }

    // 6. Main Post Timestamp
    let takenAt = Math.floor(Date.now() / 1000);
    const timeEl = mainArticle.querySelector('time[datetime]');
    if (timeEl) {
      const dt = timeEl.getAttribute('datetime');
      if (dt) {
        try {
          takenAt = Math.floor(new Date(dt).getTime() / 1000);
        } catch (_) {}
      }
    }

    const postId = shortcodeToMediaId(shortcode) || shortcode || '';
    const userId = '';

    const postDomain = window.location.hostname.includes('threads.com') ? 'https://www.threads.com' : 'https://www.threads.net';
    const postUrl = username
      ? `${postDomain}/@${username}/post/${shortcode}`
      : window.location.href.split('?')[0];

    // 7. Extract Reply Comments
    const replies = [];
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
      if (mainArticle && mainArticle !== mainArea && typeof mainArticle.compareDocumentPosition === 'function') {
        const pos = mainArticle.compareDocumentPosition(cardEl);
        if (!(pos & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      }
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

      const replyPk = replyShortcode ? (shortcodeToMediaId(replyShortcode) || replyShortcode) : '';

      const rAvatarImg = cardEl.querySelector('img[alt*="profile"], header img, img');
      const rAvatar = rAvatarImg ? rAvatarImg.src : '';
      const isRVerified = Boolean(cardEl.querySelector('svg[aria-label*="Verified"], svg[aria-label*="Terverifikasi"]'));

      // Timestamp
      let rTakenAt = Math.floor(Date.now() / 1000);
      const rTimeEl = cardEl.querySelector('time[datetime]');
      if (rTimeEl) {
        const dt = rTimeEl.getAttribute('datetime');
        if (dt) {
          try {
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
        replyUrl = `${postDomain}/@${rUsername}/post/${replyShortcode}`;
      } else if (permalinkHref) {
        replyUrl = permalinkHref.startsWith('http') ? permalinkHref : `${postDomain}${permalinkHref}`;
      }

      const replyId = replyPk || (replyShortcode ? shortcodeToMediaId(replyShortcode) : '') || replyShortcode;

      replies.push({
        id: replyId,
        userId: '',
        username: rUsername,
        profilePicUrl: rAvatar,
        isVerified: isRVerified,
        takenAt: rTakenAt,
        text: rText,
        likeCount: rEngagement.likeCount,
        replyCount: rEngagement.replyCount,
        url: replyUrl,
        is_reply: true,
        reply_to_username: username || null,
        reply_to_user_id: userId || null,
        reply_to_post_id: postId || null
      });
    }

    return {
      root_post: {
        id: postId,
        userId,
        username,
        profilePicUrl,
        isVerified,
        shortcode,
        takenAt,
        text: captionText,
        likeCount,
        replyCount: directReplyCount > 0 ? directReplyCount : (directReplyCount === 0 ? 0 : replies.length),
        quoteCount,
        repostCount,
        viewCount,
        url: postUrl,
        is_reply: false,
        reply_to_username: null,
        reply_to_user_id: null,
        reply_to_post_id: null
      },
      comments: replies
    };
  }

  /**
   * Normalize Threads Data from API / Relay to Target Schema
   */
  function normalizeToThreadsSchema(apiData, scriptData, shortcode, defaultUsername) {
    const mediaItem = apiData?.infoData?.items?.[0] || scriptData?.mainPost || null;
    const scriptReplies = scriptData?.replies || [];
    const apiComments = apiData?.commentsData?.comments || [];

    if (!mediaItem) {
      return extractFromThreadsDom(shortcode, defaultUsername);
    }

    const postId = String(mediaItem.pk || (mediaItem.id ? String(mediaItem.id).split('_')[0] : '') || shortcodeToMediaId(shortcode) || '');
    const authorObj = mediaItem.user || mediaItem.owner || {};
    const userId = String(authorObj.pk || authorObj.id || '');
    const username = authorObj.username || defaultUsername || '';
    let profilePicUrl = authorObj.profile_pic_url || '';
    const isVerified = Boolean(authorObj.is_verified);
    const text = (typeof mediaItem.caption?.text === 'string' ? mediaItem.caption.text : '') ||
                 (typeof mediaItem.caption === 'string' ? mediaItem.caption : '') ||
                 (typeof mediaItem.text === 'string' ? mediaItem.text : '') || '';

    const postDomain = window.location.hostname.includes('threads.com') ? 'https://www.threads.com' : 'https://www.threads.net';
    const postUrl = username && shortcode
      ? `${postDomain}/@${username}/post/${shortcode}`
      : `${postDomain}/post/${shortcode}`;

    const epoch = mediaItem.taken_at || mediaItem.created_at || mediaItem.created_at_utc || 0;
    let takenAt = epoch > 0 ? (epoch > 1e11 ? Math.floor(epoch / 1000) : epoch) : Math.floor(Date.now() / 1000);

    const textPostAppInfo = mediaItem.text_post_app_info || {};
    const likeCount = parseAccurateNumber(mediaItem.like_count ?? 0);
    const repostCount = parseAccurateNumber(textPostAppInfo.repost_count ?? mediaItem.repost_count ?? 0);
    const quoteCount = parseAccurateNumber(textPostAppInfo.quote_count ?? mediaItem.quote_count ?? 0);
    let viewCount = parseAccurateNumber(
      mediaItem.view_count ??
      mediaItem.views ??
      mediaItem.views_count ??
      textPostAppInfo.view_count ??
      textPostAppInfo.views_count ??
      0
    );

    const rootRta = textPostAppInfo.reply_to_author || mediaItem.reply_to_author || {};
    const rootHasReplyIndicators = Boolean(rootRta.username || rootRta.pk || rootRta.id || mediaItem.reply_to_username || textPostAppInfo.reply_to_post_id || mediaItem.reply_to_post_id);
    const isReply = Boolean(mediaItem.is_reply ?? textPostAppInfo.is_reply ?? (rootHasReplyIndicators ? true : false));
    const replyToUsername = isReply ? (rootRta.username || mediaItem.reply_to_username || null) : null;
    const replyToUserId = isReply ? (String(rootRta.pk || rootRta.id || mediaItem.reply_to_user_id || '') || null) : null;
    let rawRootReplyToPost = textPostAppInfo.reply_to_post_id || mediaItem.reply_to_post_id || '';
    let rootReplyToPostStr = typeof rawRootReplyToPost === 'object' && rawRootReplyToPost !== null
      ? String(rawRootReplyToPost.pk || (rawRootReplyToPost.id ? String(rawRootReplyToPost.id).split('_')[0] : '') || '')
      : String(rawRootReplyToPost || '').split('_')[0];
    const replyToPostId = isReply ? (rootReplyToPostStr || null) : null;

    // Helper: clean identifier for comment matching
    const getCleanId = (c) => {
      if (!c) return '';
      const code = c.code || c.shortcode || '';
      const pk = String(c.pk || (c.id ? String(c.id).split('_')[0] : '') || (code ? shortcodeToMediaId(code) : '') || '');
      return pk || (code ? shortcodeToMediaId(code) : '') || code;
    };
    const getCleanReplyTo = (c) => {
      if (!c) return '';
      const raw = c.text_post_app_info?.reply_to_post_id || c.reply_to_post_id || c.reply_to_post || '';
      if (typeof raw === 'object' && raw !== null) {
        return String(raw.pk || (raw.id ? String(raw.id).split('_')[0] : '') || '');
      }
      return String(raw).split('_')[0];
    };

    // Normalizing comments (merge embedded script replies & API comments)
    let normalizedComments = [];
    const commentMap = new Map();
    for (const c of [...(scriptReplies || []), ...(apiComments || [])]) {
      const key = getCleanId(c);
      if (key && !commentMap.has(key)) {
        commentMap.set(key, c);
      }
    }
    const candidateComments = Array.from(commentMap.values());

    // Filter comments to only include genuine replies belonging to root_post
    // If root_post is a reply itself, exclude ancestor posts that came before root_post
    let filteredComments = candidateComments;
    if (postId) {
      const descendantIds = new Set([postId]);
      // First pass: direct replies to postId
      for (const c of candidateComments) {
        const cReplyTo = getCleanReplyTo(c);
        if (cReplyTo && cReplyTo === postId) {
          const cId = getCleanId(c);
          if (cId) descendantIds.add(cId);
        }
      }
      // Iterative pass: nested replies to descendants
      let added = true;
      while (added) {
        added = false;
        for (const c of candidateComments) {
          const cId = getCleanId(c);
          if (cId && !descendantIds.has(cId)) {
            const cReplyTo = getCleanReplyTo(c);
            if (cReplyTo && descendantIds.has(cReplyTo)) {
              descendantIds.add(cId);
              added = true;
            }
          }
        }
      }

      // Filter: strictly exclude root_post itself and ancestor posts
      filteredComments = candidateComments.filter(c => {
        const cId = getCleanId(c);
        if (cId === postId || (c.code && c.code === shortcode)) return false;
        if (replyToPostId && cId === replyToPostId) return false;
        if (descendantIds.has(cId)) return true;
        const cTakenAt = c.taken_at || c.takenAt || 0;
        if (cTakenAt > 0 && takenAt > 0 && cTakenAt < takenAt) return false;
        if (c.is_reply === false && !descendantIds.has(cId)) return false;
        if (isReply) return descendantIds.has(cId);
        return true;
      });
    }

    const rootContext = { id: postId, userId, username };
    if (filteredComments.length > 0) {
      normalizedComments = filteredComments.map(c => normalizeComment(c, rootContext)).filter(Boolean);
    }

    const directReplyCountRaw = textPostAppInfo.direct_reply_count ?? mediaItem.comment_count ?? mediaItem.reply_count;
    const expectedReplyCount = (directReplyCountRaw !== undefined && directReplyCountRaw !== null && directReplyCountRaw !== '')
      ? parseAccurateNumber(directReplyCountRaw)
      : null;

    // Only fallback to DOM comments if script and API extraction returned 0 comments
    // AND server metadata didn't explicitly confirm the post has 0 replies
    if (normalizedComments.length === 0 && expectedReplyCount !== 0) {
      const domData = extractFromThreadsDom(shortcode, defaultUsername);
      if (domData?.comments?.length > 0) {
        normalizedComments = domData.comments.map(dc => {
          if (dc && userId && !dc.reply_to_user_id && dc.reply_to_username && username && dc.reply_to_username.toLowerCase() === username.toLowerCase()) {
            return { ...dc, reply_to_user_id: userId };
          }
          return dc;
        });
      }
      if (viewCount === 0 && domData?.root_post?.viewCount) {
        viewCount = domData.root_post.viewCount;
      }
      if (!profilePicUrl && domData?.root_post?.profilePicUrl) {
        profilePicUrl = domData.root_post.profilePicUrl;
      }
    }

    const replyCount = expectedReplyCount !== null
      ? expectedReplyCount
      : normalizedComments.length;

    return {
      root_post: {
        id: postId,
        userId,
        username,
        profilePicUrl,
        isVerified,
        shortcode,
        takenAt,
        text,
        likeCount,
        replyCount,
        quoteCount,
        repostCount,
        viewCount,
        url: postUrl,
        is_reply: isReply,
        reply_to_username: replyToUsername,
        reply_to_user_id: replyToUserId,
        reply_to_post_id: replyToPostId
      },
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
              const root = normalizedData.root_post;
              showToast({
                title: isUpdated ? 'Threads Data Updated!' : 'Threads Post Saved!',
                message: `Post by @${root.username || 'unknown'} saved to database. Click 'Download threads.json' in popup to export.`,
                type: 'success',
                badge: `Total: ${response.totalCount} posts`,
                meta: `❤️ ${root.likeCount.toLocaleString('en-US')} • 💬 ${root.replyCount.toLocaleString('en-US')} (${(normalizedData.comments?.length || 0).toLocaleString('en-US')} comments)`
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
