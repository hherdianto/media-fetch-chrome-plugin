// Content Script for Instagram Post & Reel Data Extractor (v1.1.0)
(function () {
  'use strict';

  // Prevent duplicate injection
  if (window.__igExtractorLoaded) return;
  window.__igExtractorLoaded = true;

  const IG_APP_ID = '936619743392459';
  let isExtracting = false;

  /**
   * Helper: Parse formatted number strings accurately to integer.
   * Handles:
   * - Raw digits with separators: "14.253", "14,253", "1 000"
   * - Suffixes (ID & EN): "14,2 rb", "14.2k", "1,5 jt", "1.5M", "2 miliar", "2B"
   */
  function parseAccurateNumber(rawStr) {
    if (typeof rawStr === 'number') return Math.round(rawStr);
    if (!rawStr || typeof rawStr !== 'string') return 0;

    const trimmed = rawStr.trim();
    if (!trimmed) return 0;

    // Check for suffix multipliers
    const suffixPatterns = [
      { regex: /([\d.,]+)\s*(?:jt|juta|m(?:illion)?)\b/i, multiplier: 1_000_000 },
      { regex: /([\d.,]+)\s*(?:rb|ribu|k)\b/i, multiplier: 1_000 },
      { regex: /([\d.,]+)\s*(?:miliar|mil|b(?:illion)?)\b/i, multiplier: 1_000_000_000 }
    ];

    for (const { regex, multiplier } of suffixPatterns) {
      const match = trimmed.match(regex);
      if (match) {
        // Replace comma with dot if used as decimal
        const numStr = match[1].replace(/,/g, '.');
        const val = parseFloat(numStr);
        if (!isNaN(val)) {
          return Math.round(val * multiplier);
        }
      }
    }

    // Direct number with thousand separators:
    // e.g. "14.253" (ID/EU) or "14,253" (US)
    const cleanDigits = trimmed.replace(/[^\d]/g, '');
    if (cleanDigits) {
      const parsed = parseInt(cleanDigits, 10);
      return isNaN(parsed) ? 0 : parsed;
    }

    return 0;
  }

  /**
   * Helper: Show Toast Notification on Instagram page (Safe DOM, No innerHTML XSS)
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
    closeBtn.addEventListener('click', () => removeToast(toast));
    toast.appendChild(closeBtn);

    container.appendChild(toast);

    setTimeout(() => {
      removeToast(toast);
    }, 4500);
  }

  function removeToast(toast) {
    if (!toast || toast.classList.contains('fade-out')) return;
    toast.classList.add('fade-out');
    setTimeout(() => {
      toast.remove();
    }, 250);
  }

  /**
   * Helper: Check if string is a valid shortcode (not audio or system paths)
   */
  function isValidShortcode(sc) {
    if (!sc || typeof sc !== 'string') return false;
    const lower = sc.toLowerCase();
    return !['audio', 'explore', 'reels', 'p', 'reel', 'stories', 'direct', 'search'].includes(lower);
  }

  /**
   * Helper: Find the active DOM container for a given post/modal
   */
  function findActivePostContainer(shortcode) {
    // 1. Look inside open modal/dialog wrappers (prioritize top/latest dialog)
    const dialogs = Array.from(document.querySelectorAll('div[role="dialog"], [aria-modal="true"]')).reverse();
    for (const d of dialogs) {
      if (shortcode && d.querySelector(`a[href*="/${shortcode}"]`)) {
        return d.querySelector('article') || d;
      }
      const art = d.querySelector('article');
      if (art) return art;
    }

    // 2. Look for an article specifically matching this shortcode
    const articles = Array.from(document.querySelectorAll('article'));
    if (shortcode) {
      for (const art of articles) {
        if (art.querySelector(`a[href*="/${shortcode}"]`)) {
          return art;
        }
      }
    }

    // 3. If there is only one article on the entire page, it's the target post
    if (articles.length === 1) {
      return articles[0];
    }

    return null;
  }

  /**
   * Helper: Detect post/reel shortcode and active container
   * Supports: Direct URLs, feed modals, explore/search modals, and passed URLs.
   */
  function getPostIdentifier(passedUrl = null) {
    // Pattern 1: Check passed URL (e.g. from popup tab.url or command)
    if (passedUrl && typeof passedUrl === 'string') {
      const matchPassed = passedUrl.match(/\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/);
      if (matchPassed && isValidShortcode(matchPassed[1])) {
        const type = matchPassed[0].includes('/reel') ? 'reel' : 'p';
        const activeContainer = findActivePostContainer(matchPassed[1]);
        return { shortcode: matchPassed[1], type, container: activeContainer };
      }
    }

    // Pattern 2: Direct post or reel URLs from browser location / document.URL
    const urlCandidates = [window.location.pathname, window.location.href, document.URL];
    for (const urlStr of urlCandidates) {
      if (!urlStr) continue;
      const matchDirect = urlStr.match(/\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/);
      if (matchDirect && isValidShortcode(matchDirect[1])) {
        const type = matchDirect[0].includes('/reel') ? 'reel' : 'p';
        const activeContainer = findActivePostContainer(matchDirect[1]);
        return { shortcode: matchDirect[1], type, container: activeContainer };
      }
    }

    // Pattern 3: Search query params (e.g. ?media_id=...)
    try {
      const searchParams = new URLSearchParams(window.location.search);
      const mediaCode = searchParams.get('media_id') || searchParams.get('p') || searchParams.get('post_id');
      if (mediaCode && isValidShortcode(mediaCode) && /^[A-Za-z0-9_-]+$/.test(mediaCode)) {
        const activeContainer = findActivePostContainer(mediaCode);
        return { shortcode: mediaCode, type: 'p', container: activeContainer };
      }
    } catch (_) {}

    // Pattern 4: Modal overlay detection (Explore, Search, Profile Grid, Feed popup)
    // Prioritize active dialogs (topmost first), then standalone articles
    const modalContainers = [
      ...Array.from(document.querySelectorAll('div[role="dialog"], [aria-modal="true"]')).reverse(),
      ...Array.from(document.querySelectorAll('article'))
    ];

    for (const container of modalContainers) {
      // 1. Check time element inside container first (post's own permalink timestamp)
      const times = Array.from(container.querySelectorAll('time'));
      for (const time of times) {
        const timeLink = time.closest('a');
        if (timeLink) {
          const href = timeLink.getAttribute('href') || '';
          const matchModal = href.match(/\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/);
          if (matchModal && isValidShortcode(matchModal[1])) {
            const type = matchModal[0].includes('/reel') ? 'reel' : 'p';
            const article = container.querySelector('article') || (container.tagName === 'ARTICLE' ? container : container);
            return { shortcode: matchModal[1], type, container: article };
          }
        }
      }

      // 2. Then check direct post/reel links inside this container
      const links = Array.from(container.querySelectorAll('a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"]'));
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const matchModal = href.match(/\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/);
        if (matchModal && isValidShortcode(matchModal[1])) {
          const type = matchModal[0].includes('/reel') ? 'reel' : 'p';
          const article = container.querySelector('article') || (container.tagName === 'ARTICLE' ? container : container);
          return { shortcode: matchModal[1], type, container: article };
        }
      }
    }

    return null;
  }

  /**
   * Helper: Convert Instagram shortcode (base64) to numeric Media ID (BigInt)
   * Example: "Df6mzc3tRzS" -> "4033707077723823314"
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
   * Strategy 0.1: Fetch raw comments & caption directly from Instagram's comments API (Network/XHR)
   * Endpoint: https://www.instagram.com/api/v1/media/<media_id>/comments/?can_support_threading=true&permalink_enabled=false
   */
  async function fetchFromApiV1Comments(mediaId) {
    if (!mediaId) return null;
    try {
      const url = `https://www.instagram.com/api/v1/media/${mediaId}/comments/?can_support_threading=true&permalink_enabled=false`;
      const headers = {
        'X-IG-App-ID': IG_APP_ID,
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': '*/*'
      };
      const csrf = getCsrfToken();
      if (csrf) headers['X-CSRFToken'] = csrf;

      const response = await fetch(url, {
        method: 'GET',
        headers,
        credentials: 'include'
      });

      if (!response.ok) return null;
      return await response.json();
    } catch (err) {
      console.warn('[IG Extractor] API v1 comments fetch failed:', err);
      return null;
    }
  }

  /**
   * Strategy 0.2: Fetch post media info (likes, timestamp, location, etc.) from Instagram's media info API
   * Endpoint: https://www.instagram.com/api/v1/media/<media_id>/info/
   */
  async function fetchFromApiV1MediaInfo(mediaId) {
    if (!mediaId) return null;
    try {
      const url = `https://www.instagram.com/api/v1/media/${mediaId}/info/`;
      const headers = {
        'X-IG-App-ID': IG_APP_ID,
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': '*/*'
      };
      const csrf = getCsrfToken();
      if (csrf) headers['X-CSRFToken'] = csrf;

      const response = await fetch(url, {
        method: 'GET',
        headers,
        credentials: 'include'
      });

      if (!response.ok) return null;
      return await response.json();
    } catch (err) {
      console.warn('[IG Extractor] API v1 media info fetch failed:', err);
      return null;
    }
  }

  /**
   * Strategy 0: Fetch from Instagram Internal Web API v1 (Network/XHR endpoints)
   * Fetches comments, caption, and media info in parallel.
   */
  async function fetchNetworkApiV1(shortcode, type, container) {
    const mediaId = shortcodeToMediaId(shortcode);
    if (!mediaId) return null;

    try {
      const [commentsSettled, mediaInfoSettled] = await Promise.allSettled([
        fetchFromApiV1Comments(mediaId),
        fetchFromApiV1MediaInfo(mediaId)
      ]);

      const commentsData = commentsSettled.status === 'fulfilled' ? commentsSettled.value : null;
      const mediaInfoData = mediaInfoSettled.status === 'fulfilled' ? mediaInfoSettled.value : null;

      if (!commentsData && !mediaInfoData) {
        return null;
      }

      return normalizeFromApiV1(commentsData, mediaInfoData, shortcode, type, container);
    } catch (err) {
      console.warn('[IG Extractor] fetchNetworkApiV1 failed:', err);
      return null;
    }
  }

  /**
   * Normalizer for Network API v1 data
   */
  function normalizeFromApiV1(commentsData, mediaInfoData, shortcode, type, container) {
    const postUrl = `https://www.instagram.com/p/${shortcode}/`;
    const mediaItem = (mediaInfoData && mediaInfoData.items && mediaInfoData.items[0]) ? mediaInfoData.items[0] : null;

    // Lazy DOM extractor fallback cache
    let cachedDomData = null;
    function getDomData() {
      if (!cachedDomData) {
        cachedDomData = extractFromDom(shortcode, type, container) || {};
      }
      return cachedDomData;
    }

    // 1. Author User Info
    const authorUser = (mediaItem && (mediaItem.user || mediaItem.owner)) ||
                       (commentsData && commentsData.caption && commentsData.caption.user) ||
                       {};
    let ownerUsername = authorUser.username || '';
    let ownerFullName = authorUser.full_name || ownerUsername;

    // 2. Caption (Primary from commentsData.caption.text because it preserves raw newlines & emojis unclipped)
    let caption = '';
    if (commentsData && commentsData.caption && commentsData.caption.text) {
      caption = commentsData.caption.text;
    } else if (mediaItem) {
      if (typeof mediaItem.caption === 'object' && mediaItem.caption !== null) {
        caption = mediaItem.caption.text || '';
      } else if (typeof mediaItem.caption === 'string') {
        caption = mediaItem.caption;
      }
    }

    // 3. Fallback to DOM for missing author/caption if needed
    if (!ownerUsername || !caption || isInvalidCaptionText(caption, ownerUsername)) {
      const dom = getDomData();
      if (!ownerUsername && dom.ownerUsername) {
        ownerUsername = dom.ownerUsername;
        if (!ownerFullName) ownerFullName = dom.ownerFullName;
      }
      if (!caption || isInvalidCaptionText(caption, ownerUsername)) {
        if (dom.caption && !isInvalidCaptionText(dom.caption, ownerUsername)) {
          caption = dom.caption;
        }
      }
    }

    // 4. Comments List
    let commentsList = [];
    if (commentsData && Array.isArray(commentsData.comments) && commentsData.comments.length > 0) {
      commentsList = commentsData.comments.map(normalizeCommentNode).filter(Boolean);
    } else if (mediaItem && Array.isArray(mediaItem.comments) && mediaItem.comments.length > 0) {
      commentsList = mediaItem.comments.map(normalizeCommentNode).filter(Boolean);
    } else if (mediaItem && Array.isArray(mediaItem.preview_comments) && mediaItem.preview_comments.length > 0) {
      commentsList = mediaItem.preview_comments.map(normalizeCommentNode).filter(Boolean);
    }

    // If API provided 0 comments but page DOM shows comments, extract from DOM
    if (commentsList.length === 0) {
      commentsList = extractCommentsFromDom(container, ownerUsername, caption);
    }

    // 5. Comments Count
    let commentsCount = 0;
    if (commentsData && commentsData.comment_count !== undefined) {
      commentsCount = parseAccurateNumber(commentsData.comment_count);
    } else if (mediaItem && mediaItem.comment_count !== undefined) {
      commentsCount = parseAccurateNumber(mediaItem.comment_count);
    }
    commentsCount = Math.max(commentsCount, commentsList.length);

    // 6. Likes Count
    let likesCount = 0;
    if (mediaItem && mediaItem.like_count !== undefined) {
      likesCount = parseAccurateNumber(mediaItem.like_count);
    } else if (mediaItem && mediaItem.edge_media_preview_like) {
      likesCount = parseAccurateNumber(mediaItem.edge_media_preview_like.count);
    }
    if (likesCount === 0) {
      const dom = getDomData();
      if (dom.likesCount > 0) {
        likesCount = dom.likesCount;
      }
    }

    // 7. Timestamp
    let timestamp = new Date().toISOString();
    const epoch = (mediaItem && mediaItem.taken_at) ||
                  (commentsData && commentsData.caption && (commentsData.caption.created_at_utc || commentsData.caption.created_at));
    if (epoch) {
      try {
        const ms = epoch > 1e11 ? epoch : epoch * 1000;
        timestamp = new Date(ms).toISOString();
      } catch (_) {}
    } else {
      const dom = getDomData();
      if (dom.timestamp) {
        timestamp = dom.timestamp;
      }
    }

    // 8. User Object
    let profilePic = authorUser.profile_pic_url || authorUser.profile_image_uri || '';
    if (!profilePic) {
      const dom = getDomData();
      profilePic = dom.user?.profile_pic_url || '';
    }
    const userPk = String(authorUser.pk || authorUser.id || '');
    const userId = String(authorUser.id || authorUser.pk || '');

    const userObj = {
      pk: userPk,
      username: ownerUsername,
      profile_pic_url: profilePic,
      seo_canonical_url: authorUser.seo_canonical_url || null,
      id: userId,
      is_unpublished: Boolean(authorUser.is_unpublished),
      full_name: ownerFullName,
      is_verified: Boolean(authorUser.is_verified),
      is_private: Boolean(authorUser.is_private),
      __typename: authorUser.__typename || "User",
      profile_image_uri: profilePic
    };

    // 9. Location
    let location = null;
    if (mediaItem && mediaItem.location) {
      location = {
        __typename: mediaItem.location.__typename || "XDTLocationDict",
        pk: mediaItem.location.pk || mediaItem.location.id || 0,
        lat: mediaItem.location.lat !== undefined ? mediaItem.location.lat : null,
        lng: mediaItem.location.lng !== undefined ? mediaItem.location.lng : null,
        name: mediaItem.location.name || "",
        profile_pic_url: mediaItem.location.profile_pic_url || null
      };
    } else {
      const dom = getDomData();
      location = dom.location || null;
    }

    // 10. Usertags
    let usertags = { in: [] };
    if (mediaItem && mediaItem.usertags && Array.isArray(mediaItem.usertags.in)) {
      usertags = mediaItem.usertags;
    }

    // 11. View Count & Repost Count
    const rawViewCount = mediaItem ? (mediaItem.view_count ?? mediaItem.play_count ?? null) : null;
    const viewCount = rawViewCount !== null && rawViewCount !== undefined ? parseAccurateNumber(rawViewCount) : null;
    const mediaRepostCount = mediaItem ? (mediaItem.media_repost_count ?? null) : null;

    const canonicalUrl = ownerUsername
      ? `https://www.instagram.com/${ownerUsername}/p/${shortcode}/`
      : postUrl;

    return {
      caption,
      ownerFullName,
      ownerUsername,
      url: postUrl,
      canonicalUrl,
      commentsCount,
      likesCount,
      timestamp,
      user: userObj,
      preview_comments: (mediaItem && mediaItem.preview_comments) || null,
      comments: commentsList,
      usertags,
      location,
      view_count: viewCount,
      media_repost_count: mediaRepostCount,
      data: {
        url: postUrl
      }
    };
  }

  /**
   * Strategy 1: Fetch post data via Instagram internal Web API (?__a=1&__d=dis)
   * This provides EXACT raw numbers (like_count, comment_count, view_count, play_count).
   */
  async function fetchFromIgApi(shortcode, type) {
    try {
      const endpointType = type === 'reel' ? 'reel' : 'p';
      const url = `https://www.instagram.com/${endpointType}/${shortcode}/?__a=1&__d=dis`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'X-IG-App-ID': IG_APP_ID,
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json'
        },
        credentials: 'include'
      });

      if (!response.ok) return null;
      const data = await response.json();
      return data;
    } catch (err) {
      console.warn('[IG Extractor] API fetch failed:', err);
      return null;
    }
  }

  /**
   * Strategy 2: Extract from page embedded JSON script tags (Relay store)
   * Also contains exact integer counts.
   */
  function extractFromEmbeddedScripts(shortcode) {
    try {
      const scriptTags = Array.from(document.querySelectorAll('script[type="application/json"]'));
      for (const script of scriptTags) {
        const content = script.textContent;
        if (!content || !content.includes(shortcode)) continue;

        try {
          const parsed = JSON.parse(content);
          const found = findMediaObjectInJson(parsed, shortcode);
          if (found) return found;
        } catch (_) {}
      }

      if (window._sharedData && typeof window._sharedData === 'object') {
        const found = findMediaObjectInJson(window._sharedData, shortcode);
        if (found) return found;
      }
    } catch (err) {
      console.warn('[IG Extractor] Script tag parsing failed:', err);
    }
    return null;
  }

  function findMediaObjectInJson(obj, shortcode) {
    if (!obj || typeof obj !== 'object') return null;

    if (obj.code === shortcode || obj.shortcode === shortcode) {
      return obj;
    }

    if (obj.items && Array.isArray(obj.items)) {
      for (const item of obj.items) {
        if (item.code === shortcode || item.shortcode === shortcode) return item;
      }
    }

    if (obj.xdt_shortcode_media && (obj.xdt_shortcode_media.shortcode === shortcode || obj.xdt_shortcode_media.code === shortcode)) {
      return obj.xdt_shortcode_media;
    }

    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        const res = findMediaObjectInJson(obj[key], shortcode);
        if (res) return res;
      }
    }

    return null;
  }

  /**
   * Helper: Check if string is a co-author header (e.g. "debora_jingga and 2 others")
   */
  function isCoauthorHeader(text) {
    if (!text) return false;
    const low = text.toLowerCase().trim();
    return (low.includes('and ') || low.includes('dan ')) && (low.includes('others') || low.includes('lainnya'));
  }

  /**
   * Helper: Check if string is an action button text or composite action line
   */
  function isActionString(str) {
    if (!str) return false;
    const low = str.toLowerCase().replace(/\s+/g, ' ').trim();
    if (/^\d+[smhdw]$/i.test(low)) return true;
    if (low.includes('comment options') || low.includes('opsi komentar')) return true;
    if (low.includes('reply') && (low.includes('see translation') || low.includes('options') || low.includes('translation'))) return true;
    if (low.includes('balas') && (low.includes('terjemahan') || low.includes('opsi'))) return true;
    if (low === 'reply' || low === 'balas' || low === 'see translation' || low === 'lihat terjemahan') return true;
    if (low.includes('view replies') || low.includes('lihat balasan') || low.includes('hide replies') || low.includes('sembunyikan balasan')) return true;
    return false;
  }

  /**
   * Helper: Check if string is NOT a valid caption candidate
   */
  function isInvalidCaptionText(text, ownerUsername) {
    if (!text || typeof text !== 'string') return true;
    const t = text.trim();
    if (!t) return true;

    // Reject pure bullet points, dots, punctuation, separators (e.g. "•", "·", "|", "-", "…")
    if (/^[\s•·|–—\-.,;:_~#*+=\\/…]+$/.test(t)) return true;

    // Reject standalone punctuation symbols (allow emojis and alphanumeric)
    if (/^[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~•·|–—…]+$/.test(t)) return true;

    // Reject if it's just the owner username
    if (ownerUsername && t.toLowerCase() === ownerUsername.toLowerCase()) return true;

    // Check coauthor header & action string only on short candidate text to prevent false rejections of real long captions
    if (t.length < 80) {
      if (isCoauthorHeader(t)) return true;
      if (isActionString(t)) return true;
    }

    // Reject standalone relative timestamp text anchored with $ (e.g. "4w", "2d", "10 minggu", "5 hari lalu")
    if (/^\d+\s*(?:s|m|h|d|w|y|detik|menit|jam|hari|minggu|bulan|tahun)(?:\s+(?:ago|lalu|yang lalu))?$/i.test(t)) return true;

    // Reject reserved UI text (case-insensitive exact match)
    const lower = t.toLowerCase();
    if (['instagram', 'follow', 'following', 'ikuti', 'mengikuti', 'verified', 'terverifikasi', 'edited', 'diedit', 'original audio', 'audio asli', 'paid partnership'].includes(lower)) return true;

    return false;
  }

  /**
   * Helper: Extract clean text from an element, preserving line breaks from <br>
   */
  function getCleanElementText(el) {
    if (!el) return '';
    if (typeof el.innerText === 'string' && el.innerText.trim()) {
      return el.innerText.trim();
    }
    return (el.textContent || '').trim();
  }

  /**
   * Helper: Strip author username prefix safely without removing partial words
   */
  function stripUsernamePrefix(text, ownerUsername) {
    if (!text || !ownerUsername) return text || '';
    const escaped = ownerUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp('^' + escaped + '(?:\\s*•\\s*|:\\s*|\\s+)', 'i'), '').trim();
  }

  /**
   * Strategy 3: Extract from active DOM & Meta tags
   */
  function extractFromDom(shortcode, type, container) {
    const postUrl = `https://www.instagram.com/p/${shortcode}/`;
    const resolvedContainer = (container instanceof Element) ? container : findActivePostContainer(shortcode);
    const root = resolvedContainer || document.querySelector('article') || document;

    // Read meta tags and document.title directly (fallback-safe)
    const ogDescTag = document.querySelector('meta[property="og:description"], meta[name="description"]');
    const ogTitleTag = document.querySelector('meta[property="og:title"]');
    const ogDescRaw = ogDescTag ? (ogDescTag.getAttribute('content') || '') : '';
    const ogTitleRaw = ogTitleTag ? (ogTitleTag.getAttribute('content') || '') : '';
    const docTitleRaw = document.title || '';

    // Verify if page meta tags match this specific post (they will NOT match if on explore / search modal)
    const metaUrlTag = document.querySelector('meta[property="og:url"]');
    const metaUrl = metaUrlTag ? (metaUrlTag.getAttribute('content') || '') : '';
    const isMetaForCurrentPost = (metaUrl && metaUrl.includes(shortcode)) ||
                                 (ogDescRaw && ogDescRaw.includes(shortcode));

    const ogDesc = isMetaForCurrentPost ? ogDescRaw : '';
    const ogTitle = isMetaForCurrentPost ? ogTitleRaw : '';
    const docTitle = isMetaForCurrentPost ? docTitleRaw : '';

    // 1. Owner Username & Full Name
    let ownerUsername = '';
    let ownerFullName = '';

    const titleToParse = ogTitle || docTitle;
    if (titleToParse) {
      const matchWithAt = titleToParse.match(/^(.*?)\s*\(@([a-zA-Z0-9._]+)\)\s+on\s+Instagram/i);
      if (matchWithAt) {
        ownerFullName = matchWithAt[1].trim();
        ownerUsername = matchWithAt[2].trim();
      } else {
        const matchPlain = titleToParse.match(/^([a-zA-Z0-9._]+)\s+on\s+Instagram/i);
        if (matchPlain && matchPlain[1] && !['explore', 'search'].includes(matchPlain[1].toLowerCase())) {
          ownerFullName = matchPlain[1].trim();
          ownerUsername = matchPlain[1].trim();
        }
      }
    }

    if (!ownerUsername && ogDesc) {
      // In ogDesc: "65 likes, 4 comments - jawatimurparktiga on November 19, 2026: ..."
      const matchDesc = ogDesc.match(/-\s+([a-zA-Z0-9._]+)\s+on\s+/i);
      if (matchDesc) {
        ownerUsername = matchDesc[1].trim();
        if (!ownerFullName) ownerFullName = ownerUsername;
      }
    }

    // DOM fallback for Username: query header links first before falling back to generic links
    if (!ownerUsername) {
      const headerLinks = Array.from(root.querySelectorAll('header a[href^="/"]'));
      for (const link of headerLinks) {
        const href = link.getAttribute('href') || '';
        const match = href.match(/^\/([a-zA-Z0-9._]+)\/?(?:\?.*)?$/);
        if (match && match[1]) {
          const u = match[1];
          if (!['explore', 'reels', 'direct', 'stories', 'p', 'reel', 'accounts', 'search'].includes(u.toLowerCase())) {
            ownerUsername = u;
            ownerFullName = link.textContent.trim() || ownerUsername;
            break;
          }
        }
      }
    }

    if (!ownerUsername) {
      const allLinks = Array.from(root.querySelectorAll('a[role="link"][href^="/"], div[role="button"] ~ div a, h2 a, h3 a, a[href^="/"]'));
      for (const link of allLinks) {
        const href = link.getAttribute('href') || '';
        const match = href.match(/^\/([a-zA-Z0-9._]+)\/?(?:\?.*)?$/);
        if (match && match[1]) {
          const u = match[1];
          if (!['explore', 'reels', 'direct', 'stories', 'p', 'reel', 'accounts', 'search'].includes(u.toLowerCase())) {
            ownerUsername = u;
            ownerFullName = link.textContent.trim() || ownerUsername;
            break;
          }
        }
      }
    }

    if (!ownerFullName) {
      ownerFullName = ownerUsername;
    }

    // 2. Caption
    let caption = '';

    // Strategy A: From og:description quote (only if ogDesc is verified for this post)
    if (ogDesc) {
      const quoteMatch = ogDesc.match(/:\s*["“](.*?)(?:["”]\s*$|$)/s);
      if (quoteMatch && quoteMatch[1]) {
        const candidate = quoteMatch[1].trim();
        if (!isInvalidCaptionText(candidate, ownerUsername)) {
          caption = candidate;
        }
      }
    }

    // Strategy B: From document.title quote (only if docTitle is verified for this post)
    if (!caption && docTitle) {
      const titleQuoteMatch = docTitle.match(/:\s*["“](.*?)(?:["”]\s*$|$)/s);
      if (titleQuoteMatch && titleQuoteMatch[1]) {
        const candidate = titleQuoteMatch[1].trim();
        if (!isInvalidCaptionText(candidate, ownerUsername)) {
          caption = candidate;
        }
      }
    }

    // Strategy C: From <h1> element (Instagram's dedicated heading for post caption)
    if (!caption) {
      const h1Candidates = Array.from(root.querySelectorAll('h1'));
      for (const h1 of h1Candidates) {
        if (h1.closest('header, nav, button, [role="button"]')) continue;
        let h1Text = getCleanElementText(h1);
        if (ownerUsername) {
          h1Text = stripUsernamePrefix(h1Text, ownerUsername);
        }
        if (!isInvalidCaptionText(h1Text, ownerUsername)) {
          caption = h1Text;
          break;
        }
      }
    }

    // Strategy D: From author's caption block in comments list
    if (!caption) {
      const candidateRows = Array.from(root.querySelectorAll('ul > li, ul > div, div[role="presentation"]'));
      for (const row of candidateRows) {
        if (row.closest('header, nav, form')) continue;
        const authorLink = ownerUsername ? row.querySelector(`a[href*="/${ownerUsername}/"]`) : null;
        if (authorLink) {
          const spans = Array.from(row.querySelectorAll('span[dir="auto"]'));
          for (const span of spans) {
            if (span.closest('header, nav, button, [role="button"], time, form, a[href^="/"]')) continue;
            let t = getCleanElementText(span);
            if (ownerUsername) {
              t = stripUsernamePrefix(t, ownerUsername);
            }
            if (!isInvalidCaptionText(t, ownerUsername)) {
              caption = t;
              break;
            }
          }
          if (caption) break;
        }
      }
    }

    // Strategy E: General scan of span[dir="auto"], STRICTLY EXCLUDING header, nav, button, time, form, action links
    if (!caption) {
      const captionCandidates = Array.from(root.querySelectorAll('span[dir="auto"]'));
      for (const el of captionCandidates) {
        if (el.closest('header, nav, button, [role="button"], time, form, a[href^="/"], a[href*="/liked_by/"]')) {
          continue;
        }

        let t = getCleanElementText(el);
        if (ownerUsername) {
          t = stripUsernamePrefix(t, ownerUsername);
        }

        if (!isInvalidCaptionText(t, ownerUsername)) {
          caption = t;
          break;
        }
      }
    }

    // Clean trailing "... selengkapnya" or "... more"
    if (caption) {
      caption = caption.replace(/\s*(?:(?:\.\.\.|…)\s*(?:selengkapnya|more)|selengkapnya)\s*$/i, '').trim();
    }

    // 3. Exact Likes Count
    let likesCount = 0;
    if (ogDesc) {
      const likesMatch = ogDesc.match(/([\d.,]+\s*(?:rb|ribu|k|jt|juta|m|b)?)\s+(?:likes|suka)/i);
      if (likesMatch) {
        likesCount = parseAccurateNumber(likesMatch[1]);
      }
    }

    if (likesCount === 0) {
      const candidateLikeElements = Array.from(root.querySelectorAll('section span, section a, section button, article span, article a, a[href*="/liked_by/"], button[aria-label*="suka"], button[aria-label*="like"]'));
      for (const el of candidateLikeElements) {
        // Prioritize unrounded exact integer in title attribute (e.g. title="14.253" inside liked_by)
        const innerWithTitle = el.querySelector('[title]') || (el.hasAttribute('title') ? el : null);
        if (innerWithTitle) {
          const tVal = (innerWithTitle.getAttribute('title') || '').trim();
          if (/^[\d.,]+$/.test(tVal)) {
            const parsedExact = parseAccurateNumber(tVal);
            if (parsedExact > 0) {
              likesCount = parsedExact;
              break;
            }
          }
        }

        const titleAttr = el.getAttribute('title') || '';
        const ariaAttr = el.getAttribute('aria-label') || '';
        const textContent = el.textContent || '';
        const combined = `${titleAttr} ${ariaAttr} ${textContent}`;

        const match = combined.match(/([\d.,]+\s*(?:rb|ribu|k|jt|juta|m)?)\s+(?:likes?|suka)\b/i);
        if (match) {
          const parsed = parseAccurateNumber(match[1]);
          if (parsed > 0) {
            likesCount = parsed;
            break;
          }
        }
      }
    }

    // 4. Exact Comments Count
    let commentsCount = 0;
    if (ogDesc) {
      const commentsMatch = ogDesc.match(/([\d.,]+\s*(?:rb|ribu|k|jt|juta|m)?)\s+(?:comments|komentar)/i);
      if (commentsMatch) {
        commentsCount = parseAccurateNumber(commentsMatch[1]);
      }
    }

    if (commentsCount === 0) {
      const commentNodes = Array.from(root.querySelectorAll('button, span, a'));
      for (const node of commentNodes) {
        const text = node.textContent || '';
        const match = text.match(/(?:lihat|view)\s+(?:semua\s+)?([\d.,]+\s*(?:rb|ribu|k|jt|juta|m)?)\s+(?:komentar|comments)/i);
        if (match) {
          commentsCount = parseAccurateNumber(match[1]);
          break;
        }
      }
    }

    // 5. Timestamp
    let timestamp = new Date().toISOString();
    const timeElem = root.querySelector('section time[datetime]') ||
                     root.querySelector('time[datetime]');
    if (timeElem) {
      const dt = timeElem.getAttribute('datetime');
      if (dt) {
        try {
          timestamp = new Date(dt).toISOString();
        } catch (_) {}
      }
    } else if (ogDesc) {
      // In ogDesc: "... on November 19, 2026: ..."
      const matchDate = ogDesc.match(/on\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
      if (matchDate && matchDate[1]) {
        try {
          timestamp = new Date(matchDate[1]).toISOString();
        } catch (_) {}
      }
    }

    // 6. User Profile Pic
    let profilePicUrl = '';
    const profileImg = root.querySelector('header img, div[role="button"] img, article header img, article img');
    if (profileImg && profileImg.src) {
      profilePicUrl = profileImg.src;
    }

    // 7. Location
    let location = null;
    const locLink = root.querySelector('a[href*="/explore/locations/"]');
    if (locLink && locLink.textContent.trim()) {
      const locName = locLink.textContent.trim();
      const locMatch = locLink.getAttribute('href').match(/\/locations\/(\d+)/);
      location = {
        __typename: "XDTLocationDict",
        pk: locMatch ? parseInt(locMatch[1], 10) : 0,
        lat: null,
        lng: null,
        name: locName,
        profile_pic_url: null
      };
    }

    // 8. Extract Comments from DOM
    const comments = extractCommentsFromDom(root, ownerUsername, caption);
    commentsCount = Math.max(commentsCount, comments.length);

    return {
      caption,
      ownerFullName,
      ownerUsername,
      url: postUrl,
      canonicalUrl: ownerUsername ? `https://www.instagram.com/${ownerUsername}/p/${shortcode}/` : postUrl,
      commentsCount,
      likesCount,
      timestamp,
      user: {
        pk: "",
        username: ownerUsername,
        profile_pic_url: profilePicUrl,
        seo_canonical_url: null,
        id: "",
        is_unpublished: false,
        full_name: ownerFullName,
        is_verified: false,
        is_private: false,
        __typename: "User",
        profile_image_uri: profilePicUrl
      },
      preview_comments: null,
      comments,
      usertags: { in: [] },
      location,
      view_count: null,
      media_repost_count: null,
      data: { url: postUrl }
    };
  }

  /**
   * Helper: Extract comments along with engagement metrics from active DOM
   * Multi-strategy: searches via <time> elements, "Reply" buttons, and <li> rows.
   */
  function extractCommentsFromDom(container, postOwnerUsername, captionText) {
    const root = (container instanceof Element) ? container : (document.querySelector('article') || document);
    const comments = [];
    const visited = new Set();

    try {
      const candidateRows = [];

      // Strategy A: Find all elements containing "Reply" or "Balas" button
      const allButtons = Array.from(root.querySelectorAll('button, span[role="button"], span'));
      for (const btn of allButtons) {
        const text = (btn.textContent || '').trim().toLowerCase();
        if (text === 'reply' || text === 'balas' || text === 'responder') {
          const row = btn.closest('li') || btn.closest('ul > div') || btn.closest('div[role="presentation"]') || btn.parentElement?.parentElement;
          if (row && !candidateRows.includes(row) && row !== root && row !== document.body) {
            candidateRows.push(row);
          }
        }
      }

      // Strategy B: Find all <li> elements inside <ul> (excluding nav/header)
      const allLis = Array.from(root.querySelectorAll('ul li'));
      for (const li of allLis) {
        if (!candidateRows.includes(li) && !li.closest('nav') && !li.closest('header')) {
          if (li.querySelector('time') || li.querySelector('a[href^="/"]')) {
            candidateRows.push(li);
          }
        }
      }

      // Parse each candidate row
      for (const row of candidateRows) {
        // 1. Extract Username
        const userLinks = Array.from(row.querySelectorAll('a[href^="/"]'));
        let username = '';

        for (const link of userLinks) {
          const href = link.getAttribute('href') || '';
          if (href.startsWith('/explore') || href.startsWith('/p/') || href.startsWith('/reel/') || href.startsWith('/stories/')) {
            continue;
          }
          const match = href.match(/^\/([a-zA-Z0-9._]+)\/?(?:\?.*)?$/);
          if (match && match[1]) {
            username = match[1];
            break;
          }
        }

        if (!username) continue;

        // 2. Extract Comment Text (specifically span[dir="auto"])
        let commentText = '';
        const dirSpans = Array.from(row.querySelectorAll('span[dir="auto"]'));
        for (const span of dirSpans) {
          if (span.closest('a[href^="/"], button, [role="button"], time')) continue;
          const rawText = getCleanElementText(span);
          if (!rawText || rawText.toLowerCase() === username.toLowerCase()) continue;
          if (isActionString(rawText) || isCoauthorHeader(rawText)) continue;
          if (/^[\s•·|–—\-.,;:_~#*+=\\/]+$/.test(rawText)) continue;

          commentText = rawText;
          break;
        }

        // Must have non-empty text to be a valid comment
        if (!commentText) continue;

        // 3. Skip caption row if this is the author's caption block
        const cleanCaption = (captionText || '').replace(/\s*(?:(?:\.\.\.|…)\s*(?:selengkapnya|more)|selengkapnya)\s*$/i, '').trim();
        const hasReplyBtn = Boolean(row.querySelector('button, span[role="button"]'));

        if (username.toLowerCase() === (postOwnerUsername || '').toLowerCase()) {
          const normComment = commentText.replace(/\s+/g, ' ').trim().toLowerCase();
          const normCaption = (cleanCaption || '').replace(/\s+/g, ' ').trim().toLowerCase();
          if (!hasReplyBtn || normComment === normCaption ||
              (normCaption && (normComment.startsWith(normCaption) || normCaption.startsWith(normComment)))) {
            // This is the author's post caption!
            continue;
          }
        }

        // Deduplicate
        const uniqueKey = `${username.toLowerCase()}___${commentText}`;
        if (visited.has(uniqueKey)) continue;
        visited.add(uniqueKey);

        // 4. Avatar
        const img = row.querySelector('img');
        const profilePicUrl = img ? (img.src || '') : '';

        // 5. Timestamp
        let timestamp = new Date().toISOString();
        const timeEl = row.querySelector('time[datetime]');
        if (timeEl) {
          const dt = timeEl.getAttribute('datetime');
          if (dt) {
            try { timestamp = new Date(dt).toISOString(); } catch (_) {}
          }
        }

        // 6. Likes on comment
        let likesCount = 0;
        const allSpansAndBtns = Array.from(row.querySelectorAll('button, span, a'));
        for (const el of allSpansAndBtns) {
          const text = el.textContent || '';
          const aria = el.getAttribute('aria-label') || '';
          const title = el.getAttribute('title') || '';
          const combined = `${text} ${aria} ${title}`;

          const match = combined.match(/([\d.,]+\s*(?:rb|ribu|k|jt|juta|m)?)\s+(?:likes?|suka)\b/i);
          if (match) {
            likesCount = parseAccurateNumber(match[1]);
            break;
          }
        }

        // 7. Reply count on comment
        let replyCount = 0;
        const checkElements = [...allSpansAndBtns];
        if (row.nextElementSibling) {
          checkElements.push(...Array.from(row.nextElementSibling.querySelectorAll('button, span')));
        }

        for (const el of checkElements) {
          const text = el.textContent || '';
          const replyMatch = text.match(/(?:view|lihat)\s+(?:semua\s+|all\s+)?(?:repl(?:y|ies)|balasan)\s*\(?([\d.,]+)\)?/i) ||
                             text.match(/([\d.,]+)\s+(?:repl(?:y|ies)|balasan)\b/i);
          if (replyMatch) {
            const raw = replyMatch[1];
            if (raw) {
              replyCount = parseAccurateNumber(raw);
              break;
            }
          }
        }

        // 8. Comment ID
        const commentLink = row.querySelector('a[href*="/c/"]');
        let commentId = '';
        if (commentLink) {
          const cMatch = commentLink.getAttribute('href').match(/\/c\/(\d+)/);
          if (cMatch) commentId = cMatch[1];
        }

        comments.push({
          id: commentId,
          text: commentText,
          ownerUsername: username,
          ownerFullName: username,
          likesCount,
          replyCount,
          timestamp,
          user: {
            pk: '',
            id: '',
            username,
            full_name: username,
            profile_pic_url: profilePicUrl,
            is_verified: Boolean(row.querySelector('svg[aria-label*="Terverifikasi"], svg[aria-label*="Verified"], svg[title*="Verified"]'))
          }
        });
      }
    } catch (err) {
      console.warn('[IG Extractor] Comment extraction error:', err);
    }

    return comments;
  }

  /**
   * Helper: Normalize a single comment object/node from API or Relay store
   */
  function normalizeCommentNode(rawNode) {
    if (!rawNode) return null;
    const node = rawNode.node || rawNode;

    const id = String(node.id || node.pk || '');
    const text = node.text || '';

    const u = node.user || node.owner || {};
    const username = u.username || '';
    const fullName = u.full_name || username;
    const profilePic = u.profile_pic_url || u.profile_image_uri || '';
    const userPk = String(u.pk || u.id || '');
    const isVerified = Boolean(u.is_verified);

    // Engagement (Likes & Replies)
    const likesCount = node.like_count !== undefined
      ? parseAccurateNumber(node.like_count)
      : (node.comment_like_count !== undefined
        ? parseAccurateNumber(node.comment_like_count)
        : (node.edge_liked_by ? parseAccurateNumber(node.edge_liked_by.count) : 0));

    const replyCount = node.child_comment_count !== undefined
      ? parseAccurateNumber(node.child_comment_count)
      : (node.edge_threaded_comments ? parseAccurateNumber(node.edge_threaded_comments.count) : 0);

    let timestamp = new Date().toISOString();
    const epoch = node.created_at || node.created_at_utc || node.taken_at || node.created_at_timestamp;
    if (epoch) {
      try {
        const ms = epoch > 1e11 ? epoch : epoch * 1000;
        timestamp = new Date(ms).toISOString();
      } catch (_) {}
    }

    return {
      id,
      text,
      ownerUsername: username,
      ownerFullName: fullName,
      likesCount,
      replyCount,
      timestamp,
      user: {
        pk: userPk,
        id: userPk,
        username,
        full_name: fullName,
        profile_pic_url: profilePic,
        is_verified: isVerified
      }
    };
  }

  /**
   * Normalize any extracted object to exact requested schema
   */
  function normalizeToSchema(raw, shortcode, type = 'p', container = null) {
    const postUrl = `https://www.instagram.com/p/${shortcode}/`;

    if (raw.canonicalUrl && raw.data && raw.user && raw.caption !== undefined) {
      return raw;
    }

    const candidateItem = raw.items ? raw.items[0] : (raw.graphql ? raw.graphql.shortcode_media : (raw.data?.xdt_shortcode_media || raw));
    const item = candidateItem || raw;
    const hasSubstantiveData = item && (
      item.user || item.owner || item.caption !== undefined || item.edge_media_to_caption ||
      item.like_count !== undefined || item.edge_media_preview_like || item.comment_count !== undefined
    );
    if (!hasSubstantiveData) {
      return null;
    }

    let caption = '';
    if (item.caption && typeof item.caption === 'object') {
      caption = item.caption.text || '';
    } else if (typeof item.caption === 'string') {
      caption = item.caption;
    } else if (item.edge_media_to_caption && item.edge_media_to_caption.edges && item.edge_media_to_caption.edges[0]) {
      caption = item.edge_media_to_caption.edges[0].node.text || '';
    }

    const u = item.user || item.owner || {};
    const ownerUsername = u.username || '';
    const ownerFullName = u.full_name || ownerUsername;

    // Fallback if API caption is empty or invalid
    if (!caption || isInvalidCaptionText(caption, ownerUsername)) {
      const domData = extractFromDom(shortcode, type, container);
      if (domData && domData.caption && !isInvalidCaptionText(domData.caption, ownerUsername)) {
        caption = domData.caption;
      } else {
        caption = '';
      }
    }
    const profilePic = u.profile_pic_url || u.profile_image_uri || '';
    const userPk = String(u.pk || u.id || '');
    const userId = String(u.id || u.pk || '');

    const userObj = {
      pk: userPk,
      username: ownerUsername,
      profile_pic_url: profilePic,
      seo_canonical_url: u.seo_canonical_url || null,
      id: userId,
      is_unpublished: Boolean(u.is_unpublished),
      full_name: ownerFullName,
      is_verified: Boolean(u.is_verified),
      is_private: Boolean(u.is_private),
      __typename: u.__typename || "User",
      profile_image_uri: profilePic
    };

    // Exact raw numbers directly from API/Relay
    const likesCount = item.like_count !== undefined
      ? parseAccurateNumber(item.like_count)
      : (item.edge_media_preview_like ? parseAccurateNumber(item.edge_media_preview_like.count) : 0);

    const commentsCount = item.comment_count !== undefined
      ? parseAccurateNumber(item.comment_count)
      : (item.edge_media_to_comment ? parseAccurateNumber(item.edge_media_to_comment.count) : 0);

    let timestamp = new Date().toISOString();
    const epoch = item.taken_at || item.taken_at_timestamp || item.device_timestamp;
    if (epoch) {
      try {
        const ms = epoch > 1e11 ? epoch : epoch * 1000;
        timestamp = new Date(ms).toISOString();
      } catch (_) {}
    }

    let location = null;
    if (item.location) {
      location = {
        __typename: item.location.__typename || "XDTLocationDict",
        pk: item.location.pk || item.location.id || 0,
        lat: item.location.lat !== undefined ? item.location.lat : null,
        lng: item.location.lng !== undefined ? item.location.lng : null,
        name: item.location.name || "",
        profile_pic_url: item.location.profile_pic_url || null
      };
    }

    let usertags = { in: [] };
    if (item.usertags && Array.isArray(item.usertags.in)) {
      usertags = item.usertags;
    } else if (item.edge_media_to_tagged_user && Array.isArray(item.edge_media_to_tagged_user.edges)) {
      usertags = {
        in: item.edge_media_to_tagged_user.edges.map(e => ({
          user: {
            pk: String(e.node?.user?.id || ''),
            username: e.node?.user?.username || '',
            full_name: e.node?.user?.full_name || '',
            profile_pic_url: e.node?.user?.profile_pic_url || ''
          },
          x: e.node?.x,
          y: e.node?.y
        }))
      };
    }

    const canonicalUrl = ownerUsername
      ? `https://www.instagram.com/${ownerUsername}/p/${shortcode}/`
      : postUrl;

    const rawViewCount = item.view_count ?? item.play_count ?? null;
    const viewCount = rawViewCount !== null && rawViewCount !== undefined ? parseAccurateNumber(rawViewCount) : null;
    const mediaRepostCount = item.media_repost_count ?? null;

    // Extract & normalize comments with engagement
    let commentsList = [];
    const rawComments = item.edge_media_to_parent_comment?.edges ||
      item.edge_media_to_comment?.edges ||
      item.edge_media_preview_comment?.edges ||
      (Array.isArray(item.comments) ? item.comments : null) ||
      item.preview_comments;

    if (Array.isArray(rawComments) && rawComments.length > 0) {
      commentsList = rawComments
        .map(normalizeCommentNode)
        .filter(Boolean);
    }

    // Fallback to DOM if API/Relay had no comments but page displays them
    if (commentsList.length === 0) {
      commentsList = extractCommentsFromDom(container, ownerUsername, caption);
    }

    return {
      caption,
      ownerFullName,
      ownerUsername,
      url: postUrl,
      canonicalUrl,
      commentsCount: Math.max(commentsCount, commentsList.length),
      likesCount,
      timestamp,
      user: userObj,
      preview_comments: item.preview_comments || null,
      comments: commentsList,
      usertags,
      location,
      view_count: viewCount,
      media_repost_count: mediaRepostCount,
      data: {
        url: postUrl
      }
    };
  }

  /**
   * Main Trigger Function
   */
  async function triggerExtraction(providedPostInfo = null) {
    if (isExtracting) {
      return { success: false, error: 'Extraction already in progress.' };
    }

    let postInfo = providedPostInfo || getPostIdentifier();
    if (!postInfo) {
      showToast({
        title: 'Not a Post/Reel Page',
        message: 'Please open an Instagram post or reel before scraping data.',
        type: 'warning'
      });
      return { success: false, error: 'Not an Instagram post or reel page.' };
    }

    if (!postInfo.container || !(postInfo.container instanceof Element)) {
      postInfo.container = findActivePostContainer(postInfo.shortcode);
    }

    isExtracting = true;
    showToast({
      title: 'Scraping Data...',
      message: `Extracting data from post [${postInfo.shortcode}]`,
      type: 'info'
    });

    try {
      let extractedData = null;

      // 0. Try direct Network API v1 (/api/v1/media/<media_id>/comments/ + /info/)
      // This is the most accurate source: provides raw caption text, unrounded engagement, and direct comment objects
      try {
        const networkResult = await fetchNetworkApiV1(postInfo.shortcode, postInfo.type, postInfo.container);
        if (networkResult) {
          extractedData = networkResult;
        }
      } catch (e) {
        console.warn('[IG Extractor] Network API v1 strategy failed:', e);
      }

      // 1. Try legacy Web API fetch (?__a=1&__d=dis)
      if (!extractedData) {
        const apiResult = await fetchFromIgApi(postInfo.shortcode, postInfo.type);
        if (apiResult) {
          extractedData = normalizeToSchema(apiResult, postInfo.shortcode, postInfo.type, postInfo.container);
        }
      }

      // 2. Try embedded scripts (exact integers in Relay store)
      if (!extractedData) {
        const scriptResult = extractFromEmbeddedScripts(postInfo.shortcode);
        if (scriptResult) {
          extractedData = normalizeToSchema(scriptResult, postInfo.shortcode, postInfo.type, postInfo.container);
        }
      }

      // 3. Fallback to DOM extraction with accurate attribute parsing
      if (!extractedData) {
        extractedData = extractFromDom(postInfo.shortcode, postInfo.type, postInfo.container);
      }

      if (!extractedData) {
        throw new Error('Failed to extract data from this page.');
      }

      // Send to background service worker to save & append to storage
      return await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            action: 'save_post',
            postData: extractedData
          },
          (response) => {
            if (chrome.runtime.lastError) {
              console.error('[IG Extractor] Message error:', chrome.runtime.lastError);
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
                title: isUpdated ? 'Data Updated!' : 'Data Saved Successfully!',
                message: `Post by @${extractedData.ownerUsername || 'unknown'} saved to database. Click 'Download ig.json' in popup to export.`,
                type: 'success',
                badge: `Total: ${response.totalCount} posts`,
                meta: `❤️ ${extractedData.likesCount.toLocaleString('en-US')} • 💬 ${extractedData.commentsCount.toLocaleString('en-US')} (${(extractedData.comments?.length || 0).toLocaleString('en-US')} comments)`
              });
              resolve({ success: true, post: extractedData, totalCount: response.totalCount });
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
      console.error('[IG Extractor] Extraction error:', err);
      showToast({
        title: 'Scraping Failed',
        message: err.message || 'An issue occurred while reading post data.',
        type: 'error'
      });
      isExtracting = false;
      return { success: false, error: err.message };
    }
  }

  /**
   * Listen for messages from background script (triggered by chrome.commands shortcut or popup)
   */
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'extract_current_post') {
      const explicitInfo = request.postInfo || (request.tabUrl ? getPostIdentifier(request.tabUrl) : null);
      triggerExtraction(explicitInfo).then((res) => {
        sendResponse(res || { success: true });
      }).catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
      return true; // Keep channel open for async sendResponse!
    } else if (request.action === 'check_status') {
      const postInfo = getPostIdentifier(request.tabUrl);
      sendResponse({
        isPostPage: Boolean(postInfo),
        postInfo: postInfo ? { shortcode: postInfo.shortcode, type: postInfo.type } : null
      });
    }
  });

  console.log('[Instagram Post Extractor] Content script ready.');
})();
