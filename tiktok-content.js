// Content Script for TikTok Video & Comment Data Extractor (v1.2.0)
(function () {
  'use strict';

  if (window.__tiktokExtractorLoaded) return;
  window.__tiktokExtractorLoaded = true;

  let isExtracting = false;

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
   * Helper: Detect TikTok Video ID and Author from URL or Page DOM
   */
  function getTikTokIdentifier(passedUrl = null) {
    const candidates = [passedUrl, window.location.href, window.location.pathname, document.URL].filter(Boolean);

    for (const urlStr of candidates) {
      const match = urlStr.match(/(?:@([\w.-]+)\/)?(?:video|photo)\/(\d+)/i);
      if (match) {
        return {
          videoId: match[2],
          username: match[1] || ''
        };
      }

      // Check /v/<videoId>
      const matchShort = urlStr.match(/\/v\/(\d+)/i);
      if (matchShort) {
        return {
          videoId: matchShort[1],
          username: ''
        };
      }
    }

    // Modal or Feed detection in DOM
    const modalLinks = Array.from(document.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]'));
    for (const link of modalLinks) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/(?:@([\w.-]+)\/)?(?:video|photo)\/(\d+)/i);
      if (match) {
        const isInsideActiveModal = Boolean(link.closest('[data-e2e="video-detail-container"], div[class*="DivDetailContainer"]'));
        if (isInsideActiveModal) {
          return {
            videoId: match[2],
            username: match[1] || ''
          };
        }
      }
    }

    // If there's an open video detail container with video ID in data attributes
    const detailContainer = document.querySelector('[data-e2e="video-detail-container"], div[class*="DivDetailContainer"]');
    if (detailContainer) {
      const anyLink = detailContainer.querySelector('a[href*="/video/"], a[href*="/photo/"]');
      if (anyLink) {
        const href = anyLink.getAttribute('href') || '';
        const m = href.match(/(?:@([\w.-]+)\/)?(?:video|photo)\/(\d+)/i);
        if (m) return { videoId: m[2], username: m[1] || '' };
      }
    }

    return null;
  }

  /**
   * Recursively search for itemStruct object in JSON tree
   */
  function findItemStructInObject(obj, targetId = null) {
    if (!obj || typeof obj !== 'object') return null;

    if (obj.itemStruct && typeof obj.itemStruct === 'object') {
      if (!targetId || String(obj.itemStruct.id) === String(targetId)) {
        return obj.itemStruct;
      }
    }

    if (obj.id && obj.desc !== undefined && obj.author) {
      if (!targetId || String(obj.id) === String(targetId)) {
        return obj;
      }
    }

    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        const found = findItemStructInObject(obj[key], targetId);
        if (found) return found;
      }
    }

    return null;
  }

  /**
   * Strategy 1: Read __UNIVERSAL_DATA_FOR_REHYDRATION__ script tag
   */
  function extractFromUniversalData(videoId) {
    try {
      const script = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
      if (script && script.textContent) {
        const json = JSON.parse(script.textContent);
        const videoDetail = json['__DEFAULT_SCOPE__']?.['webapp.video-detail'];
        if (videoDetail?.itemInfo?.itemStruct) {
          const item = videoDetail.itemInfo.itemStruct;
          if (!videoId || String(item.id) === String(videoId)) {
            return item;
          }
        }
        const itemAny = findItemStructInObject(json, videoId);
        if (itemAny) return itemAny;
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
          if (videoId && json.ItemModule[videoId]) {
            item = json.ItemModule[videoId];
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
        if (item && (!videoId || String(item.id) === String(videoId))) {
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
      const url = `https://www.tiktok.com/api/item/detail/?aid=1988&itemId=${videoId}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json, text/plain, */*'
        },
        credentials: 'include'
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.itemInfo?.itemStruct || null;
    } catch (e) {
      console.warn('[TikTok Extractor] API item detail fetch failed:', e);
      return null;
    }
  }

  /**
   * Strategy 5: Extract from DOM & Meta tags
   */
  function extractFromTikTokDom(videoId, username) {
    const descEl = document.querySelector('[data-e2e="browse-video-desc"], h1[data-e2e="browse-video-desc"], [data-e2e="video-desc"], span[class*="SpanText"]');
    const text = descEl ? descEl.textContent.trim() : '';

    const authorEl = document.querySelector('[data-e2e="browse-username"], [data-e2e="video-author-uniqueid"]');
    const resolvedUsername = authorEl ? authorEl.textContent.trim() : (username || '');

    const nicknameEl = document.querySelector('[data-e2e="browse-user-nickname"]');
    const resolvedNickname = nicknameEl ? nicknameEl.textContent.trim() : resolvedUsername;

    const avatarEl = document.querySelector('[data-e2e="browse-user-avatar"] img, img[class*="ImgAvatar"]');
    const avatarUrl = avatarEl ? avatarEl.src : '';

    const likeEl = document.querySelector('[data-e2e="like-count"]');
    const commentEl = document.querySelector('[data-e2e="comment-count"]');
    const shareEl = document.querySelector('[data-e2e="share-count"]');
    const collectEl = document.querySelector('[data-e2e="bookmark-count"], [data-e2e="undefined-count"]');

    return {
      id: videoId || '',
      desc: text,
      createTime: Math.floor(Date.now() / 1000),
      author: {
        id: '',
        uniqueId: resolvedUsername,
        nickname: resolvedNickname,
        avatarLarger: avatarUrl,
        signature: '',
        verified: false
      },
      authorStats: {
        followerCount: 0,
        followingCount: 0,
        heartCount: 0,
        videoCount: 0
      },
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
    let createTimeISO = new Date().toISOString();
    if (createTime > 0) {
      try {
        createTimeISO = new Date(createTime * 1000).toISOString();
      } catch (_) {}
    }

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
      const data = await res.json();
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
          comments.push({
            id: '',
            text,
            createTime: Math.floor(Date.now() / 1000),
            createTimeISO: new Date().toISOString(),
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
   * Normalize extracted raw data into the exact required TikTok JSON Schema
   */
  function normalizeToTikTokSchema(item, commentsList, videoId, username) {
    const id = String(item.id || videoId || '');
    const text = String(item.desc || item.text || '');

    const createTime = parseInt(item.createTime || item.create_time || Math.floor(Date.now() / 1000), 10);
    let createTimeISO = new Date().toISOString();
    if (createTime > 0) {
      try {
        createTimeISO = new Date(createTime * 1000).toISOString();
      } catch (_) {}
    }

    const author = item.author || {};
    const authorStats = item.authorStats || {};
    const stats = item.stats || item.statsV2 || {};

    const authorName = author.uniqueId || author.unique_id || author.name || username || '';
    const authorNick = author.nickname || author.nickName || authorName;
    const authorAvatar = author.avatarLarger || author.avatarMedium || author.avatarThumb || author.avatar || '';

    // Hashtags extraction
    let hashtags = [];
    if (Array.isArray(item.challenges) && item.challenges.length > 0) {
      hashtags = item.challenges.map((ch) => ({
        id: String(ch.id || ''),
        name: String(ch.title || ch.name || ''),
        title: String(ch.title || ch.name || '')
      }));
    } else {
      // Regex fallback from caption text
      const matches = text.match(/#([^\s#]+)/g) || [];
      hashtags = matches.map((tagWithHash, idx) => {
        const cleanTag = tagWithHash.replace(/^#/, '');
        return {
          id: String(idx + 1),
          name: cleanTag,
          title: cleanTag
        };
      });
    }

    const webVideoUrl = authorName && id
      ? `https://www.tiktok.com/@${authorName}/video/${id}`
      : (window.location.href.split('?')[0]);

    const rawCommentCount = parseAccurateNumber(stats.commentCount ?? stats.comment_count ?? 0);
    const commentCount = Math.max(rawCommentCount, commentsList.length);

    // Exact Schema requested by the user:
    // id, text, createTime, createTimeISO, authorMeta, diggCount, shareCount, playCount, commentCount, comments, collectCount, webVideoUrl, hashtags, isAd
    return {
      id,
      text,
      createTime,
      createTimeISO,
      authorMeta: {
        id: String(author.id || ''),
        name: authorName,
        nickName: authorNick,
        verified: Boolean(author.verified || author.custom_verify),
        signature: author.signature || '',
        avatar: authorAvatar,
        fans: parseAccurateNumber(authorStats.followerCount ?? authorStats.fans ?? 0),
        following: parseAccurateNumber(authorStats.followingCount ?? authorStats.following ?? 0),
        heart: parseAccurateNumber(authorStats.heartCount ?? authorStats.heart ?? 0),
        video: parseAccurateNumber(authorStats.videoCount ?? authorStats.video ?? 0)
      },
      diggCount: parseAccurateNumber(stats.diggCount ?? stats.digg_count ?? 0),
      shareCount: parseAccurateNumber(stats.shareCount ?? stats.share_count ?? 0),
      playCount: parseAccurateNumber(stats.playCount ?? stats.play_count ?? 0),
      commentCount,
      comments: commentsList, // Placed directly under commentCount as requested!
      collectCount: parseAccurateNumber(stats.collectCount ?? stats.collect_count ?? 0),
      webVideoUrl,
      hashtags,
      isAd: Boolean(item.isAd || item.is_ad)
    };
  }

  /**
   * Main Trigger Function for TikTok extraction
   */
  async function triggerTikTokExtraction(providedInfo = null) {
    if (isExtracting) {
      return { success: false, error: 'TikTok extraction already in progress.' };
    }

    const target = providedInfo || getTikTokIdentifier();
    if (!target || !target.videoId) {
      showToast({
        title: 'Not a TikTok Video',
        message: 'Please open a TikTok video before scraping data.',
        type: 'warning'
      });
      return { success: false, error: 'Not a TikTok video page.' };
    }

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
          let item = extractFromUniversalData(target.videoId);
          if (!item) item = extractFromSigiState(target.videoId);
          if (!item) item = extractFromNextData(target.videoId);
          if (!item) item = await fetchFromTikTokApi(target.videoId);
          if (!item) item = extractFromTikTokDom(target.videoId, target.username);
          return item;
        })(),
        (async () => {
          let list = await fetchTikTokComments(target.videoId);
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

      const normalizedData = normalizeToTikTokSchema(itemResult, commentsResult || [], target.videoId, target.username);

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
                meta: `❤️ ${normalizedData.diggCount.toLocaleString('en-US')} • 💬 ${normalizedData.commentCount.toLocaleString('en-US')} (${(normalizedData.comments?.length || 0).toLocaleString('en-US')} comments)`
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
