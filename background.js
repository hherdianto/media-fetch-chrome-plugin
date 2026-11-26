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

  const url1 = (p1.webVideoUrl || '').replace(/\/+$/, '');
  const url2 = (p2.webVideoUrl || '').replace(/\/+$/, '');
  if (url1 && url2 && url1 === url2) return true;

  return false;
}

/**
 * Check if two Threads post objects represent the same post
 */
function isSameThreadsPost(p1, p2) {
  if (!p1 || !p2) return false;

  if (p1.shortcode && p2.shortcode && p1.shortcode === p2.shortcode) return true;
  if (p1.id && p2.id && String(p1.id) === String(p2.id)) return true;

  const url1 = (p1.url || '').replace(/\/+$/, '');
  const url2 = (p2.url || '').replace(/\/+$/, '');
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
      const postData = request.postData;

      if (!postData) {
        throw new Error('Invalid post data.');
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
      const posts = res[STORAGE_KEY_THREADS] || [];
      if (posts.length === 0) {
        throw new Error('No Threads data saved to download.');
      }
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
      const posts = res[STORAGE_KEY_X] || [];
      if (posts.length === 0) {
        throw new Error('No X/Twitter data saved to download.');
      }
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
      const posts = res[config.storageKey] || [];
      if (posts.length === 0) {
        const platformDisplay = platform === 'threads' ? 'Threads' : (platform === 'tiktok' ? 'TikTok' : (platform === 'x' ? 'X' : 'Instagram'));
        throw new Error(`No ${platformDisplay} data saved to download.`);
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
      const posts = res[config.storageKey] || [];
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
          if (!item.id && !item.shortcode && !item.url) continue;
        } else if (platform === 'x') {
          if (!item.id && !item.url) continue;
        } else {
          if (!item.url && !item.canonicalUrl && !item.data?.url) continue;
        }

        const idx = currentPosts.findIndex((p) => config.isSameFn(p, item));
        if (idx >= 0) {
          currentPosts[idx] = item;
          updatedCount++;
        } else {
          currentPosts.push(item);
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
