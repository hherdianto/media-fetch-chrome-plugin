// Background Service Worker for Social Media Data Extractor (Instagram, TikTok, Threads & X) v1.4.1
const STORAGE_KEY_IG = 'ig_posts';
const STORAGE_KEY_TIKTOK = 'tiktok_posts';
const STORAGE_KEY_THREADS = 'threads_posts';
const STORAGE_KEY_X = 'x_posts';

/**
 * Helper: Save posts array automatically to Downloads/<filename>
 * Uses safe UTF-8 Base64 data URL with byte chunking to prevent memory issues.
 */
async function downloadJsonFile(data, filename) {
  try {
    const jsonContent = JSON.stringify(data, null, 2);
    const bytes = new TextEncoder().encode(jsonContent);
    let binary = '';
    const len = bytes.byteLength;
    const chunkSize = 8192;
    for (let i = 0; i < len; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunkSize, len)));
    }
    const base64 = btoa(binary);
    const dataUrl = 'data:application/json;base64,' + base64;

    return new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url: dataUrl,
          filename: filename,
          conflictAction: 'overwrite',
          saveAs: false
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            console.error(`[Background] Download error (${filename}):`, chrome.runtime.lastError);
            reject(chrome.runtime.lastError);
          } else {
            resolve(downloadId);
          }
        }
      );
    });
  } catch (err) {
    console.error(`[Background] Failed to generate ${filename} download:`, err);
    throw err;
  }
}

/**
 * Promise-based Sequential Queue to prevent storage race conditions.
 */
let queuePromise = Promise.resolve();

function runInQueue(operation) {
  const currentOp = queuePromise.then(() => operation());

  // Ensure queuePromise recovers so future operations in the queue always run
  queuePromise = currentOp.catch((err) => {
    console.warn('[Storage Queue] Operation failed, queue recovered:', err.message || err);
  });

  return currentOp;
}

/**
 * Helper: Safely identify platform from URL hostname
 */
function getPlatformFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    if (/(?:^|\.)tiktok\.com$/.test(host)) return 'tiktok';
    if (/(?:^|\.)threads\.(?:net|com)$/.test(host)) return 'threads';
    if (/(?:^|\.)(?:x\.com|twitter\.com)$/.test(host)) return 'x';
    if (/(?:^|\.)instagram\.com$/.test(host)) return 'instagram';
  } catch {}
  return null;
}

/**
 * Handle shortcut commands defined in manifest.json (chrome.commands)
 * Automatically detects whether active tab is Instagram, TikTok, Threads, or X
 */
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'extract_ig_post') {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab && activeTab.id) {
        const tabUrl = activeTab.url || '';
        const platform = getPlatformFromUrl(tabUrl);
        if (!platform) {
          console.log('[Background] Active tab is not a supported social platform:', tabUrl);
          return;
        }

        let action = 'extract_current_post';
        let scriptFile = 'content.js';

        if (platform === 'tiktok') {
          action = 'extract_current_tiktok';
          scriptFile = 'tiktok-content.js';
        } else if (platform === 'threads') {
          action = 'extract_current_threads';
          scriptFile = 'threads-content.js';
        } else if (platform === 'x') {
          action = 'extract_current_x';
          scriptFile = 'x-content.js';
        }

        const dispatch = () => {
          chrome.tabs.sendMessage(
            activeTab.id,
            { action, tabUrl },
            (res) => {
              if (chrome.runtime.lastError) {
                console.log('[Background] Tab not active or unsupported platform:', chrome.runtime.lastError.message);
              }
            }
          );
        };

        if (chrome.scripting) {
          chrome.scripting.insertCSS({ target: { tabId: activeTab.id }, files: ['content.css'] }, () => {
            if (chrome.runtime.lastError) { /* ignore */ }
            chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: [scriptFile] }, () => {
              if (chrome.runtime.lastError) { /* ignore */ }
              dispatch();
            });
          });
        } else {
          dispatch();
        }
      }
    } catch (err) {
      console.error('[Background] Command error:', err);
    }
  }
});

/**
 * Helper: Extract shortcode from Instagram URL for reliable comparison
 */
function extractShortcodeFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/**
 * Check if two Instagram post objects represent the same media
 */
function isSameInstagramPost(p1, p2) {
  if (!p1 || !p2) return false;

  const sc1 = extractShortcodeFromUrl(p1.url) || extractShortcodeFromUrl(p1.canonicalUrl) || extractShortcodeFromUrl(p1.data?.url);
  const sc2 = extractShortcodeFromUrl(p2.url) || extractShortcodeFromUrl(p2.canonicalUrl) || extractShortcodeFromUrl(p2.data?.url);
  if (sc1 && sc2 && sc1 === sc2) return true;

  const url1 = p1.url || p1.data?.url || p1.canonicalUrl;
  const url2 = p2.url || p2.data?.url || p2.canonicalUrl;
  if (url1 && url2 && url1.replace(/\/+$/, '') === url2.replace(/\/+$/, '')) return true;

  return false;
}

/**
 * Check if two TikTok video objects represent the same video
 */
function isSameTikTokPost(p1, p2) {
  if (!p1 || !p2) return false;

  if (p1.id && p2.id && String(p1.id) === String(p2.id)) return true;

  const url1 = (p1.webVideoUrl || '').split('?')[0].replace(/\/+$/, '');
  const url2 = (p2.webVideoUrl || '').split('?')[0].replace(/\/+$/, '');
  if (url1 && url2 && url1 === url2) return true;

  return false;
}

/**
 * Helper: Convert Threads/Instagram shortcode (base64) to numeric Media ID (BigInt)
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
 * Helper: Format Threads post data to ensure standard { root_post, comments } schema
 */
function formatThreadsPost(p) {
  if (!p) return null;

  const root = p.root_post || p;
  const author = root.author || {};
  const user = root.user || {};
  const shortcode = root.shortcode || (root.postUrl ? (root.postUrl.match(/\/post\/([A-Za-z0-9_-]+)/) || [])[1] : (root.url ? (root.url.match(/\/post\/([A-Za-z0-9_-]+)/) || [])[1] : '')) || '';
  const postId = String(root.id || root.postId || root.pk || (shortcode ? shortcodeToMediaId(shortcode) : '') || '');

  let takenAt = 0;
  if (typeof root.takenAt === 'number') {
    takenAt = root.takenAt;
  } else if (root.takenAtISO) {
    try { takenAt = Math.floor(new Date(root.takenAtISO).getTime() / 1000); } catch (_) {}
  } else if (root.taken_at) {
    takenAt = root.taken_at > 1e11 ? Math.floor(root.taken_at / 1000) : root.taken_at;
  }

  const rootText = (typeof root.text === 'string' ? root.text : '') ||
                   (typeof root.captionText === 'string' ? root.captionText : '') ||
                   (typeof root.caption?.text === 'string' ? root.caption.text : '') ||
                   (typeof root.caption === 'string' ? root.caption : '') || '';

  const rootTextPostAppInfo = root.text_post_app_info || {};
  const rootRta = rootTextPostAppInfo.reply_to_author || root.reply_to_author || {};
  const rootHasReplyIndicators = Boolean(root.reply_to_username || rootRta.username || rootRta.pk || rootRta.id || root.reply_to_post_id || rootTextPostAppInfo.reply_to_post_id);
  const rootIsReply = Boolean(root.is_reply ?? rootTextPostAppInfo.is_reply ?? (rootHasReplyIndicators ? true : false));
  const rootReplyToUsername = rootIsReply ? (root.reply_to_username || rootRta.username || null) : null;
  const rootReplyToUserId = rootIsReply ? (String(root.reply_to_user_id || rootRta.pk || rootRta.id || '') || null) : null;
  let rawRootReplyToPost = root.reply_to_post_id || rootTextPostAppInfo.reply_to_post_id || '';
  let rootReplyToPostStr = typeof rawRootReplyToPost === 'object' && rawRootReplyToPost !== null
    ? String(rawRootReplyToPost.pk || (rawRootReplyToPost.id ? String(rawRootReplyToPost.id).split('_')[0] : '') || '')
    : String(rawRootReplyToPost || '').split('_')[0];
  const rootReplyToPostId = rootIsReply ? (rootReplyToPostStr || null) : null;

  const rootPost = {
    id: postId,
    userId: String(root.userId || author.id || user.id || ''),
    username: root.username || author.username || user.username || '',
    profilePicUrl: root.profilePicUrl || root.thumbnailUrl || root.imageUrl || author.profilePicUrl || user.profile_pic_url || '',
    isVerified: Boolean(root.isVerified ?? author.isVerified ?? user.is_verified),
    shortcode,
    takenAt,
    text: rootText,
    likeCount: Number.isFinite(Number(root.likeCount ?? root.likesCount)) ? Number(root.likeCount ?? root.likesCount) : 0,
    replyCount: Number.isFinite(Number(root.replyCount ?? root.directReplyCount ?? root.commentsCount)) ? Number(root.replyCount ?? root.directReplyCount ?? root.commentsCount) : 0,
    quoteCount: Number.isFinite(Number(root.quoteCount)) ? Number(root.quoteCount) : 0,
    repostCount: Number.isFinite(Number(root.repostCount)) ? Number(root.repostCount) : 0,
    viewCount: Number.isFinite(Number(root.viewCount)) ? Number(root.viewCount) : 0,
    url: root.url || root.postUrl || '',
    is_reply: rootIsReply,
    reply_to_username: rootReplyToUsername,
    reply_to_user_id: rootReplyToUserId,
    reply_to_post_id: rootReplyToPostId
  };

  const rawReplies = Array.isArray(p.comments) ? p.comments : (Array.isArray(p.replies) ? p.replies : []);
  const comments = rawReplies.map((r) => {
    if (!r || typeof r !== 'object') return null;
    const c = r.comment || r;
    if (!c || typeof c !== 'object') return null;
    const cu = c.author || c.user || c.owner || {};
    const cCode = c.shortcode || c.code || (c.url ? (c.url.match(/\/post\/([A-Za-z0-9_-]+)/) || [])[1] : '') || '';
    const cId = String(c.id || c.pk || (cCode ? shortcodeToMediaId(cCode) : '') || '');
    let cTakenAt = 0;
    if (typeof c.takenAt === 'number' && Number.isFinite(c.takenAt)) {
      cTakenAt = c.takenAt;
    } else if (c.taken_at) {
      const parsedEpoch = Number(c.taken_at);
      if (Number.isFinite(parsedEpoch)) {
        cTakenAt = parsedEpoch > 1e11 ? Math.floor(parsedEpoch / 1000) : parsedEpoch;
      }
    }
    const cText = (typeof c.text === 'string' ? c.text : '') ||
                  (typeof c.caption?.text === 'string' ? c.caption.text : '') ||
                  (typeof c.caption === 'string' ? c.caption : '') || '';

    const cTextPostAppInfo = c.text_post_app_info || {};
    const cRta = cTextPostAppInfo.reply_to_author || c.reply_to_author || {};
    const cHasReplyIndicators = Boolean(cRta.username || cRta.pk || cRta.id || c.reply_to_username || cTextPostAppInfo.reply_to_post_id || c.reply_to_post_id);
    const cIsReply = Boolean(c.is_reply ?? cTextPostAppInfo.is_reply ?? (cHasReplyIndicators ? true : true));
    let cReplyToUsername = c.reply_to_username || cRta.username || '';
    let cReplyToUserId = String(c.reply_to_user_id || cRta.pk || cRta.id || '');
    let rawCReplyToPost = c.reply_to_post_id || cTextPostAppInfo.reply_to_post_id || c.reply_to_post || '';
    let cReplyToPostId = typeof rawCReplyToPost === 'object' && rawCReplyToPost !== null
      ? String(rawCReplyToPost.pk || (rawCReplyToPost.id ? String(rawCReplyToPost.id).split('_')[0] : '') || '')
      : String(rawCReplyToPost || '').split('_')[0];

    if (cIsReply) {
      if (!cReplyToUsername) {
        cReplyToUsername = rootPost.username || '';
        if (!cReplyToUserId && rootPost.userId) cReplyToUserId = rootPost.userId;
        if (!cReplyToPostId && rootPost.id) cReplyToPostId = rootPost.id;
      } else if (rootPost.username && cReplyToUsername.toLowerCase() === rootPost.username.toLowerCase()) {
        if (!cReplyToUserId && rootPost.userId) cReplyToUserId = rootPost.userId;
        if (!cReplyToPostId && rootPost.id) cReplyToPostId = rootPost.id;
      }
    }

    const postDomain = (c.url && c.url.includes('threads.com')) ? 'https://www.threads.com' : 'https://www.threads.net';

    return {
      id: cId,
      userId: String(cu.id || cu.pk || c.userId || ''),
      username: cu.username || c.username || '',
      profilePicUrl: cu.profilePicUrl || cu.profile_pic_url || c.profilePicUrl || c.avatar || '',
      isVerified: Boolean(cu.isVerified ?? cu.is_verified ?? c.isVerified),
      takenAt: cTakenAt,
      text: cText,
      likeCount: Number.isFinite(Number(c.likeCount ?? c.like_count)) ? Number(c.likeCount ?? c.like_count) : 0,
      replyCount: Number.isFinite(Number(c.replyCount ?? c.direct_reply_count ?? c.reply_count)) ? Number(c.replyCount ?? c.direct_reply_count ?? c.reply_count) : 0,
      url: c.url || (cu.username && cCode ? `${postDomain}/@${cu.username}/post/${cCode}` : ''),
      is_reply: cIsReply,
      reply_to_username: cIsReply ? (cReplyToUsername || null) : null,
      reply_to_user_id: cIsReply ? (cReplyToUserId || null) : null,
      reply_to_post_id: cIsReply ? (cReplyToPostId || null) : null
    };
  }).filter(Boolean);

  return {
    root_post: rootPost,
    comments
  };
}

/**
 * Check if two Threads post objects represent the same post
 */
function isSameThreadsPost(p1, p2) {
  if (!p1 || !p2) return false;

  const id1 = p1.root_post?.id || p1.postId || p1.id;
  const id2 = p2.root_post?.id || p2.postId || p2.id;
  if (id1 && id2 && String(id1) === String(id2)) return true;

  const extractShortcode = (u) => {
    if (!u || typeof u !== 'string') return null;
    const m = u.match(/\/post\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  };

  const sc1 = p1.root_post?.shortcode || p1.shortcode || extractShortcode(p1.root_post?.url || p1.postUrl || p1.url);
  const sc2 = p2.root_post?.shortcode || p2.shortcode || extractShortcode(p2.root_post?.url || p2.postUrl || p2.url);
  if (sc1 && sc2 && sc1 === sc2) return true;

  const url1 = (p1.root_post?.url || p1.postUrl || p1.url || '').split('?')[0].replace(/\/+$/, '');
  const url2 = (p2.root_post?.url || p2.postUrl || p2.url || '').split('?')[0].replace(/\/+$/, '');
  if (url1 && url2 && url1 === url2) return true;

  return false;
}

/**
 * Helper: Extract status ID from X / Twitter URL
 */
function extractXStatusId(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/(?:x\.com|twitter\.com)\/(?:#!\/)?\w+\/status\/(\d+)/i);
  return m ? m[1] : null;
}

/**
 * Helper: Format Date or ISO timestamp into standard Twitter date string
 * e.g. "Fri Oct 30 03:40:00 +0000 2026"
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
 * Helper: Format X / Twitter tweet data to exact x.json schema
 */
function formatXPost(p) {
  if (!p) return null;

  const rawAuthor = p.author || {};
  const rawMetrics = p.metrics || {};

  const id = String(p.id || p.statusId || (p.url ? (p.url.match(/\/status\/(\d+)/) || [])[1] : '') || '');
  const userName = String(
    rawAuthor.userName || rawAuthor.username || rawAuthor.screen_name || rawAuthor.handle ||
    (p.url ? (p.url.match(/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]+)\/status/) || [])[1] : '') ||
    ''
  ).replace(/^@/, '');
  const name = String(rawAuthor.name || rawAuthor.displayName || userName || 'X User');

  const url = p.url || (userName && id ? `https://x.com/${userName}/status/${id}` : (id ? `https://x.com/i/status/${id}` : ''));
  const twitterUrl = p.twitterUrl || (userName && id ? `https://twitter.com/${userName}/status/${id}` : (id ? `https://twitter.com/i/status/${id}` : ''));

  const text = typeof p.text === 'string' ? p.text : (typeof p.full_text === 'string' ? p.full_text : '');

  const retweetCount = Number(p.retweetCount ?? rawMetrics.retweetCount ?? p.retweet_count ?? 0);
  const replyCount = Number(p.replyCount ?? rawMetrics.replyCount ?? p.reply_count ?? p.commentCount ?? (Array.isArray(p.comments) ? p.comments.length : 0));
  const likeCount = Number(p.likeCount ?? rawMetrics.likeCount ?? p.favorite_count ?? p.favoriteCount ?? 0);
  const quoteCount = Number(p.quoteCount ?? rawMetrics.quoteCount ?? p.quote_count ?? 0);
  const viewCount = Number(p.viewCount ?? rawMetrics.viewCount ?? p.views_count ?? 0);
  const bookmarkCount = Number(p.bookmarkCount ?? rawMetrics.bookmarkCount ?? p.bookmark_count ?? 0);

  const createdAt = formatTwitterDate(p.createdAt || p.created_at || new Date());
  const lang = String(p.lang || 'in');

  const isReply = Boolean(p.isReply ?? (p.inReplyToId || p.in_reply_to_status_id_str));
  const inReplyToId = p.inReplyToId ? String(p.inReplyToId) : (p.in_reply_to_status_id_str ? String(p.in_reply_to_status_id_str) : null);
  const conversationId = String(p.conversationId || p.conversation_id_str || (isReply && inReplyToId ? inReplyToId : id));
  const inReplyToUserId = p.inReplyToUserId ? String(p.inReplyToUserId) : (p.in_reply_to_user_id_str ? String(p.in_reply_to_user_id_str) : null);
  const inReplyToUsername = p.inReplyToUsername ? String(p.inReplyToUsername) : (p.in_reply_to_screen_name ? String(p.in_reply_to_screen_name) : null);

  const isPinned = Boolean(p.isPinned ?? false);

  // Author normalization
  const author = {
    type: 'user',
    userName,
    url: userName ? `https://x.com/${userName}` : '',
    twitterUrl: userName ? `https://twitter.com/${userName}` : '',
    id: String(rawAuthor.id || rawAuthor.id_str || rawAuthor.rest_id || ''),
    name,
    isVerified: Boolean(rawAuthor.isVerified ?? rawAuthor.verified),
    isBlueVerified: Boolean(rawAuthor.isBlueVerified ?? rawAuthor.is_blue_verified ?? rawAuthor.isVerified ?? rawAuthor.verified),
    profilePicture: rawAuthor.profilePicture || rawAuthor.avatar || rawAuthor.profile_image_url_https || rawAuthor.profile_image_url || '',
    coverPicture: rawAuthor.coverPicture || rawAuthor.profile_banner_url || '',
    description: rawAuthor.description || '',
    location: rawAuthor.location || '',
    followers: Number(rawAuthor.relationship_counts?.followers ?? rawAuthor.followers ?? rawAuthor.followersCount ?? rawAuthor.followers_count ?? 0),
    following: Number(rawAuthor.relationship_counts?.following ?? rawAuthor.following ?? rawAuthor.followingCount ?? rawAuthor.friends_count ?? 0),
    status: rawAuthor.status || '',
    canDm: Boolean(rawAuthor.canDm ?? false),
    canMediaTag: Boolean(rawAuthor.canMediaTag ?? false),
    createdAt: rawAuthor.createdAt ? (typeof rawAuthor.createdAt === 'string' && /^[A-Z][a-z]{2}\s/.test(rawAuthor.createdAt) ? rawAuthor.createdAt : formatTwitterDate(rawAuthor.createdAt)) : '',
    entities: rawAuthor.entities || {
      description: { urls: [] },
      url: { urls: [] }
    },
    fastFollowersCount: Number(rawAuthor.fastFollowersCount ?? 0),
    favouritesCount: Number(rawAuthor.favouritesCount ?? rawAuthor.favourites_count ?? 0),
    hasCustomTimelines: Boolean(rawAuthor.hasCustomTimelines ?? true),
    isTranslator: Boolean(rawAuthor.isTranslator ?? false),
    mediaCount: Number(rawAuthor.mediaCount ?? rawAuthor.media_count ?? 0),
    statusesCount: Number(rawAuthor.statusesCount ?? rawAuthor.statuses_count ?? 0),
    withheldInCountries: Array.isArray(rawAuthor.withheldInCountries) ? rawAuthor.withheldInCountries : [],
    affiliatesHighlightedLabel: rawAuthor.affiliatesHighlightedLabel || {},
    possiblySensitive: Boolean(rawAuthor.possiblySensitive ?? false),
    pinnedTweetIds: Array.isArray(rawAuthor.pinnedTweetIds) ? rawAuthor.pinnedTweetIds : [],
    profile_bio: rawAuthor.profile_bio || {},
    isAutomated: Boolean(rawAuthor.isAutomated ?? false),
    automatedBy: rawAuthor.automatedBy ?? null
  };

  const extendedEntities = p.extendedEntities || (Array.isArray(p.media) && p.media.length > 0 ? { media: p.media } : {});
  const card = p.card !== undefined ? p.card : null;
  const place = p.place || {};
  const entities = p.entities || { urls: [] };

  return {
    type: 'tweet',
    id,
    url,
    twitterUrl,
    text,
    source: p.source || '',
    retweetCount,
    replyCount,
    likeCount,
    quoteCount,
    viewCount,
    createdAt,
    lang,
    bookmarkCount,
    isReply,
    inReplyToId,
    conversationId,
    inReplyToUserId,
    inReplyToUsername,
    isPinned,
    author,
    extendedEntities,
    card,
    place,
    entities,
    reply_to_user_results: p.reply_to_user_results ?? null,
    quoted_tweet_results: p.quoted_tweet_results ?? null,
    quoted_tweet: p.quoted_tweet ?? null,
    retweeted_tweet: p.retweeted_tweet ?? null,
    isConversationControlled: Boolean(p.isConversationControlled ?? false),
    ...(Array.isArray(p.comments) ? { comments: p.comments } : {})
  };
}

/**
 * Check if two X / Twitter tweet objects represent the same tweet
 */
function isSameXPost(p1, p2) {
  if (!p1 || !p2) return false;

  if (p1.id && p2.id && String(p1.id) === String(p2.id)) return true;

  const sid1 = extractXStatusId(p1.url) || p1.id;
  const sid2 = extractXStatusId(p2.url) || p2.id;
  if (sid1 && sid2 && String(sid1) === String(sid2)) return true;

  const url1 = (p1.url || '').replace(/\/+$/, '');
  const url2 = (p2.url || '').replace(/\/+$/, '');
  if (url1 && url2 && url1 === url2) return true;

  return false;
}

/**
 * Helper to get the correct storage key & comparison function for a given platform
 */
function getPlatformConfig(platform) {
  if (platform === 'tiktok') {
    return {
      storageKey: STORAGE_KEY_TIKTOK,
      defaultFilename: 'tiktok.json',
      isSameFn: isSameTikTokPost
    };
  } else if (platform === 'threads') {
    return {
      storageKey: STORAGE_KEY_THREADS,
      defaultFilename: 'threads.json',
      isSameFn: isSameThreadsPost
    };
  } else if (platform === 'x') {
    return {
      storageKey: STORAGE_KEY_X,
      defaultFilename: 'x.json',
      isSameFn: isSameXPost
    };
  } else {
    return {
      storageKey: STORAGE_KEY_IG,
      defaultFilename: 'ig.json',
      isSameFn: isSameInstagramPost
    };
  }
}

/**
 * Listen for messages from content script & popup
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Action: Save & Append post/video
  if (request.action === 'save_post') {
    runInQueue(async () => {
      const platform = request.platform || 'instagram';
      const config = getPlatformConfig(platform);
      let postData = request.postData;

      if (!postData) {
        throw new Error('Invalid post data.');
      }

      if (platform === 'threads') {
        postData = formatThreadsPost(postData);
      } else if (platform === 'x') {
        const items = Array.isArray(postData) ? postData : [postData];
        const result = await chrome.storage.local.get([config.storageKey]);
        let posts = result[config.storageKey] || [];
        let hasUpdate = false;
        for (const rawItem of items) {
          const item = formatXPost(rawItem);
          if (!item || (!item.id && !item.url)) continue;
          const existingIndex = posts.findIndex((p) => config.isSameFn(p, item));
          if (existingIndex >= 0) {
            posts[existingIndex] = item;
            hasUpdate = true;
          } else {
            posts.push(item);
          }
        }
        await chrome.storage.local.set({ [config.storageKey]: posts });
        return {
          success: true,
          isUpdate: hasUpdate,
          totalCount: posts.length,
          platform
        };
      }

      const result = await chrome.storage.local.get([config.storageKey]);
      let posts = result[config.storageKey] || [];

      const existingIndex = posts.findIndex((p) => config.isSameFn(p, postData));

      let isUpdate = false;
      if (existingIndex >= 0) {
        posts[existingIndex] = postData;
        isUpdate = true;
      } else {
        posts.push(postData);
      }

      await chrome.storage.local.set({ [config.storageKey]: posts });

      return {
        success: true,
        isUpdate,
        totalCount: posts.length,
        platform
      };
    })
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ success: false, error: err.message }));

    return true; // Keep channel open for async response
  }

  // Action: Export/Download ig.json
  if (request.action === 'export_ig_json') {
    runInQueue(async () => {
      const res = await chrome.storage.local.get([STORAGE_KEY_IG]);
      const posts = res[STORAGE_KEY_IG] || [];
      if (posts.length === 0) {
        throw new Error('No Instagram data saved to download.');
      }
      const dlId = await downloadJsonFile(posts, 'ig.json');
      return { success: true, downloadId: dlId, totalCount: posts.length };
    })
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ success: false, error: err.message }));

    return true;
  }

  // Action: Export/Download tiktok.json
  if (request.action === 'export_tiktok_json') {
    runInQueue(async () => {
      const res = await chrome.storage.local.get([STORAGE_KEY_TIKTOK]);
      const posts = res[STORAGE_KEY_TIKTOK] || [];
      if (posts.length === 0) {
        throw new Error('No TikTok data saved to download.');
      }
      const dlId = await downloadJsonFile(posts, 'tiktok.json');
      return { success: true, downloadId: dlId, totalCount: posts.length };
    })
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ success: false, error: err.message }));

    return true;
  }

  // Action: Export/Download threads.json
  if (request.action === 'export_threads_json') {
    runInQueue(async () => {
      const res = await chrome.storage.local.get([STORAGE_KEY_THREADS]);
      let posts = res[STORAGE_KEY_THREADS] || [];
      if (posts.length === 0) {
        throw new Error('No Threads data saved to download.');
      }
      posts = posts.map(formatThreadsPost);
      const dlId = await downloadJsonFile(posts, 'threads.json');
      return { success: true, downloadId: dlId, totalCount: posts.length };
    })
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ success: false, error: err.message }));

    return true;
  }

  // Action: Export/Download x.json
  if (request.action === 'export_x_json') {
    runInQueue(async () => {
      const res = await chrome.storage.local.get([STORAGE_KEY_X]);
      let posts = res[STORAGE_KEY_X] || [];
      if (posts.length === 0) {
        throw new Error('No X/Twitter data saved to download.');
      }
      posts = posts.map(formatXPost);
      const dlId = await downloadJsonFile(posts, 'x.json');
      return { success: true, downloadId: dlId, totalCount: posts.length };
    })
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ success: false, error: err.message }));

    return true;
  }

  // Action: Export generic with specified platform
  if (request.action === 'export_json') {
    runInQueue(async () => {
      const platform = request.platform || 'instagram';
      const config = getPlatformConfig(platform);
      const res = await chrome.storage.local.get([config.storageKey]);
      let posts = res[config.storageKey] || [];
      if (posts.length === 0) {
        const platformDisplay = platform === 'threads' ? 'Threads' : (platform === 'tiktok' ? 'TikTok' : (platform === 'x' ? 'X' : 'Instagram'));
        throw new Error(`No ${platformDisplay} data saved to download.`);
      }
      if (platform === 'threads') {
        posts = posts.map(formatThreadsPost);
      } else if (platform === 'x') {
        posts = posts.map(formatXPost);
      }
      const dlId = await downloadJsonFile(posts, config.defaultFilename);
      return { success: true, downloadId: dlId, totalCount: posts.length, filename: config.defaultFilename };
    })
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ success: false, error: err.message }));

    return true;
  }

  // Action: Get saved posts by platform
  if (request.action === 'get_all_posts') {
    const platform = request.platform || 'instagram';
    const config = getPlatformConfig(platform);
    chrome.storage.local.get([config.storageKey], (res) => {
      let posts = res[config.storageKey] || [];
      if (platform === 'threads') {
        posts = posts.map(formatThreadsPost);
      } else if (platform === 'x') {
        posts = posts.map(formatXPost);
      }
      sendResponse({ posts, totalCount: posts.length, platform });
    });
    return true;
  }

  // Action: Clear all saved posts for platform
  if (request.action === 'clear_all_posts') {
    runInQueue(async () => {
      const platform = request.platform || 'instagram';
      const config = getPlatformConfig(platform);
      await chrome.storage.local.set({ [config.storageKey]: [] });
      return { success: true, platform };
    })
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ success: false, error: err.message }));

    return true;
  }

  // Action: Delete single post by index for platform
  if (request.action === 'delete_post_by_index') {
    runInQueue(async () => {
      const platform = request.platform || 'instagram';
      const config = getPlatformConfig(platform);
      const res = await chrome.storage.local.get([config.storageKey]);
      let posts = res[config.storageKey] || [];
      if (request.index >= 0 && request.index < posts.length) {
        posts.splice(request.index, 1);
        await chrome.storage.local.set({ [config.storageKey]: posts });
        return { success: true, totalCount: posts.length, platform };
      } else {
        throw new Error('Index not found.');
      }
    })
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ success: false, error: err.message }));

    return true;
  }

  // Action: Import and merge external JSON array
  if (request.action === 'import_posts') {
    runInQueue(async () => {
      const platform = request.platform || 'instagram';
      const config = getPlatformConfig(platform);
      const importedArray = request.posts;
      if (!Array.isArray(importedArray)) {
        throw new Error('File format must be a JSON array.');
      }

      const res = await chrome.storage.local.get([config.storageKey]);
      let currentPosts = res[config.storageKey] || [];

      let addedCount = 0;
      let updatedCount = 0;

      for (const item of importedArray) {
        if (!item) continue;
        if (platform === 'tiktok') {
          if (!item.id && !item.webVideoUrl) continue;
        } else if (platform === 'threads') {
          if (!item.root_post && !item.id && !item.shortcode && !item.url && !item.postId) continue;
        } else if (platform === 'x') {
          if (!item.id && !item.url) continue;
        } else {
          if (!item.url && !item.canonicalUrl && !item.data?.url) continue;
        }

        const savedItem = platform === 'threads' ? formatThreadsPost(item) : (platform === 'x' ? formatXPost(item) : item);
        const idx = currentPosts.findIndex((p) => config.isSameFn(p, savedItem));
        if (idx >= 0) {
          currentPosts[idx] = savedItem;
          updatedCount++;
        } else {
          currentPosts.push(savedItem);
          addedCount++;
        }
      }

      await chrome.storage.local.set({ [config.storageKey]: currentPosts });

      return {
        success: true,
        addedCount,
        updatedCount,
        totalCount: currentPosts.length,
        platform
      };
    })
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ success: false, error: err.message }));

    return true;
  }
});
