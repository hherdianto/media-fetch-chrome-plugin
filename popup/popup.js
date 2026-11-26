// Popup UI Logic for Instagram, TikTok, Threads & X (v1.4.1)
document.addEventListener('DOMContentLoaded', async () => {
  // DOM Elements
  const tabInstagram = document.getElementById('tabInstagram');
  const tabTikTok = document.getElementById('tabTikTok');
  const tabThreads = document.getElementById('tabThreads');
  const tabX = document.getElementById('tabX');
  const logoIcon = document.getElementById('logoIcon');
  const headerTitle = document.getElementById('headerTitle');
  const headerSubtitle = document.getElementById('headerSubtitle');

  const pageStatus = document.getElementById('pageStatus');
  const pageStatusText = document.getElementById('pageStatusText');
  const btnExtractCurrent = document.getElementById('btnExtractCurrent');
  const btnExtractText = document.getElementById('btnExtractText');
  const detectedPostInfo = document.getElementById('detectedPostInfo');
  const detectedShortcode = document.getElementById('detectedShortcode');
  const btnManageShortcut = document.getElementById('btnManageShortcut');
  const shortcutKeysContainer = document.getElementById('shortcutKeysContainer');

  const totalPostsCount = document.getElementById('totalPostsCount');
  const statLabel = document.getElementById('statLabel');
  const btnDownloadJson = document.getElementById('btnDownloadJson');
  const btnDownloadText = document.getElementById('btnDownloadText');
  const btnCopyJson = document.getElementById('btnCopyJson');
  const btnImportJson = document.getElementById('btnImportJson');
  const importFileInput = document.getElementById('importFileInput');
  const btnClearAll = document.getElementById('btnClearAll');

  const listTitle = document.getElementById('listTitle');
  const postList = document.getElementById('postList');
  const emptyState = document.getElementById('emptyState');
  const emptyText = document.getElementById('emptyText');
  const emptySubtext = document.getElementById('emptySubtext');
  const msgBanner = document.getElementById('msgBanner');
  const footerText = document.getElementById('footerText');

  // State
  let currentPlatform = 'instagram'; // 'instagram' | 'tiktok' | 'threads' | 'x'
  let activeTabId = null;
  let activeTabUrl = '';
  let activeTabPlatform = null; // 'instagram' | 'tiktok' | 'threads' | 'x' | null
  let isCurrentTabTarget = false;
  let currentPostInfo = null;
  let cachedPosts = [];

  const DEFAULT_AVATAR = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="%23333333"/><circle cx="12" cy="9" r="4" fill="%23888888"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6" fill="%23888888"/></svg>';

  let bannerTimer = null;
  function showBanner(message, type = 'success') {
    if (bannerTimer) clearTimeout(bannerTimer);
    msgBanner.textContent = message;
    msgBanner.className = `msg-banner ${type}`;
    msgBanner.style.display = 'block';
    bannerTimer = setTimeout(() => {
      msgBanner.style.display = 'none';
      bannerTimer = null;
    }, 3500);
  }

  // 1. Load active shortcut dynamically from chrome.commands
  try {
    const commands = await chrome.commands.getAll();
    const extractCmd = commands.find((c) => c.name === 'extract_ig_post');
    if (extractCmd && extractCmd.shortcut) {
      shortcutKeysContainer.innerHTML = '';
      const parts = extractCmd.shortcut.split('+');
      parts.forEach((p, idx) => {
        const kbd = document.createElement('kbd');
        kbd.textContent = p.trim();
        shortcutKeysContainer.appendChild(kbd);
        if (idx < parts.length - 1) {
          shortcutKeysContainer.appendChild(document.createTextNode(' + '));
        }
      });
    }
  } catch (err) {
    console.warn('Could not read chrome commands:', err);
  }

  // 2. Open chrome shortcut management
  btnManageShortcut.addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  // 3. Platform Switcher UI updates
  function setPlatform(platform) {
    currentPlatform = platform;

    tabInstagram.classList.toggle('active', currentPlatform === 'instagram');
    tabTikTok.classList.toggle('active', currentPlatform === 'tiktok');
    tabThreads.classList.toggle('active', currentPlatform === 'threads');
    if (tabX) tabX.classList.toggle('active', currentPlatform === 'x');

    if (currentPlatform === 'tiktok') {
      logoIcon.textContent = '🎵';
      logoIcon.style.background = 'linear-gradient(135deg, #00f2fe 0%, #4facfe 50%, #fe0979 100%)';
      headerTitle.textContent = 'TikTok Data Extractor';
      headerSubtitle.textContent = 'Video & Comment Scraper';
      statLabel.textContent = 'Saved Videos';
      btnDownloadText.textContent = '📥 Download tiktok.json';
      listTitle.textContent = 'Collected TikTok Videos';
      emptyText.textContent = 'No TikTok videos collected yet.';
      emptySubtext.textContent = 'Open a TikTok video and press the shortcut or click Scrape TikTok Video.';
      footerText.innerHTML = 'TikTok data is saved separately in <b>tiktok.json</b>.';
    } else if (currentPlatform === 'threads') {
      logoIcon.textContent = '🧵';
      logoIcon.style.background = 'linear-gradient(135deg, #111111 0%, #222222 50%, #000000 100%)';
      headerTitle.textContent = 'Threads Data Extractor';
      headerSubtitle.textContent = 'Post & Reply Scraper';
      statLabel.textContent = 'Saved Posts';
      btnDownloadText.textContent = '📥 Download threads.json';
      listTitle.textContent = 'Collected Threads Posts';
      emptyText.textContent = 'No Threads posts collected yet.';
      emptySubtext.textContent = 'Open a Threads post and press the shortcut or click Scrape Threads Post.';
      footerText.innerHTML = 'Threads data is saved separately in <b>threads.json</b>.';
    } else if (currentPlatform === 'x') {
      logoIcon.textContent = '𝕏';
      logoIcon.style.background = 'linear-gradient(135deg, #000000 0%, #15202b 100%)';
      headerTitle.textContent = 'X Data Extractor';
      headerSubtitle.textContent = 'Tweet & Reply Scraper';
      statLabel.textContent = 'Saved Tweets';
      btnDownloadText.textContent = '📥 Download x.json';
      listTitle.textContent = 'Collected X Tweets';
      emptyText.textContent = 'No X tweets collected yet.';
      emptySubtext.textContent = 'Open a tweet on x.com or twitter.com and press the shortcut or click Scrape X Tweet.';
      footerText.innerHTML = 'X data is saved separately in <b>x.json</b>.';
    } else {
      logoIcon.textContent = '📸';
      logoIcon.style.background = 'linear-gradient(135deg, #f09433, #e6683c 25%, #dc2743 50%, #cc2366 75%, #bc1888 100%)';
      headerTitle.textContent = 'IG Data Extractor';
      headerSubtitle.textContent = 'Post & Reel Scraper';
      statLabel.textContent = 'Saved Posts';
      btnDownloadText.textContent = '📥 Download ig.json';
      listTitle.textContent = 'Collected Instagram Posts';
      emptyText.textContent = 'No Instagram posts collected yet.';
      emptySubtext.textContent = 'Open an Instagram post/reel and press the shortcut or click Scrape Current Page.';
      footerText.innerHTML = 'Instagram data is saved separately in <b>ig.json</b>.';
    }

    updateActiveTabStatus();
    loadSavedPosts();
  }

  tabInstagram.addEventListener('click', () => setPlatform('instagram'));
  tabTikTok.addEventListener('click', () => setPlatform('tiktok'));
  tabThreads.addEventListener('click', () => setPlatform('threads'));
  if (tabX) tabX.addEventListener('click', () => setPlatform('x'));

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

  // 4. Check active tab and auto-select matching platform tab
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      activeTabId = tab.id;
      activeTabUrl = tab.url || '';
      activeTabPlatform = getPlatformFromUrl(activeTabUrl);
      if (activeTabPlatform) {
        currentPlatform = activeTabPlatform;
      }
    }
  } catch (err) {
    console.warn('Initial tab check error:', err);
  }

  // 5. Update UI status for current tab based on active platform
  function updateActiveTabStatus() {
    if (!activeTabId || !activeTabUrl) {
      pageStatus.className = 'status-pill';
      pageStatusText.textContent = 'Tab Inactive';
      btnExtractCurrent.disabled = true;
      btnExtractText.textContent = 'Open Website First';
      detectedPostInfo.style.display = 'none';
      return;
    }

    const matchesPlatform = (currentPlatform === 'tiktok' && activeTabPlatform === 'tiktok') ||
                            (currentPlatform === 'threads' && activeTabPlatform === 'threads') ||
                            (currentPlatform === 'x' && activeTabPlatform === 'x') ||
                            (currentPlatform === 'instagram' && activeTabPlatform === 'instagram');

    if (!matchesPlatform) {
      const platformName = currentPlatform === 'tiktok' ? 'TikTok' : (currentPlatform === 'threads' ? 'Threads' : (currentPlatform === 'x' ? 'X' : 'Instagram'));
      pageStatus.className = 'status-pill';
      pageStatusText.textContent = `Not ${platformName}`;
      btnExtractCurrent.disabled = true;
      btnExtractText.textContent = `Open ${platformName} First`;
      detectedPostInfo.style.display = 'none';
      isCurrentTabTarget = false;
      return;
    }

    // Tab matches selected platform! Check content script status
    chrome.tabs.sendMessage(activeTabId, { action: 'check_status', tabUrl: activeTabUrl }, (response) => {
      if (chrome.runtime.lastError) {
        // Tab content script not injected yet or tab unrefreshed (suppress error)
      }
      let postInfo = response?.postInfo;
      let isTarget = Boolean(response?.isPostPage && postInfo);

      if (currentPlatform === 'tiktok') {
        const m = activeTabUrl.match(/(?:@([\w.-]+)\/)?(?:video|photo)\/(\d+)/i) || activeTabUrl.match(/\/v\/(\d+)/i);
        if (!isTarget && m) {
          isTarget = true;
          const isShort = activeTabUrl.includes('/v/');
          postInfo = {
            videoId: isShort ? m[1] : (m[2] || m[1]),
            username: isShort ? '' : (m[1] || '')
          };
        }

        if (isTarget && postInfo) {
          isCurrentTabTarget = true;
          currentPostInfo = postInfo;
          pageStatus.className = 'status-pill active';
          pageStatusText.textContent = 'TikTok Video Ready';
          btnExtractCurrent.disabled = false;
          btnExtractText.textContent = 'Scrape TikTok Video';
          detectedPostInfo.style.display = 'block';
          detectedShortcode.textContent = `VIDEO: ${postInfo.videoId || 'Active'}`;
        } else {
          isCurrentTabTarget = false;
          currentPostInfo = null;
          pageStatus.className = 'status-pill';
          pageStatusText.textContent = 'Open TikTok Video';
          btnExtractCurrent.disabled = true;
          btnExtractText.textContent = 'Select Video in Tab';
          detectedPostInfo.style.display = 'none';
        }
      } else if (currentPlatform === 'threads') {
        const m = activeTabUrl.match(/(?:@([\w.-]+)\/)?post\/([A-Za-z0-9_-]+)/i);
        if (!isTarget && m) {
          isTarget = true;
          postInfo = {
            shortcode: m[2],
            username: m[1] || ''
          };
        }

        if (isTarget && postInfo) {
          isCurrentTabTarget = true;
          currentPostInfo = postInfo;
          pageStatus.className = 'status-pill active';
          pageStatusText.textContent = 'Threads Post Ready';
          btnExtractCurrent.disabled = false;
          btnExtractText.textContent = 'Scrape Threads Post';
          detectedPostInfo.style.display = 'block';
          detectedShortcode.textContent = `THREAD: ${postInfo.shortcode}`;
        } else {
          isCurrentTabTarget = false;
          currentPostInfo = null;
          pageStatus.className = 'status-pill';
          pageStatusText.textContent = 'Open Threads Post';
          btnExtractCurrent.disabled = true;
          btnExtractText.textContent = 'Select Post in Tab';
          detectedPostInfo.style.display = 'none';
        }
      } else if (currentPlatform === 'x') {
        const m = activeTabUrl.match(/(?:x\.com|twitter\.com)\/(?:#!\/)?([A-Za-z0-9_]+)\/status\/(\d+)/i);
        if (!isTarget && m) {
          isTarget = true;
          postInfo = {
            statusId: m[2],
            username: m[1] || ''
          };
        }

        if (isTarget && postInfo) {
          isCurrentTabTarget = true;
          currentPostInfo = postInfo;
          pageStatus.className = 'status-pill active';
          pageStatusText.textContent = 'X Tweet Ready';
          btnExtractCurrent.disabled = false;
          btnExtractText.textContent = 'Scrape X Tweet';
          detectedPostInfo.style.display = 'block';
          detectedShortcode.textContent = `TWEET: ${postInfo.statusId}`;
        } else {
          isCurrentTabTarget = false;
          currentPostInfo = null;
          pageStatus.className = 'status-pill';
          pageStatusText.textContent = 'Open X Tweet';
          btnExtractCurrent.disabled = true;
          btnExtractText.textContent = 'Select Tweet in Tab';
          detectedPostInfo.style.display = 'none';
        }
      } else {
        // Instagram
        const rawShortcodeMatch = activeTabUrl.match(/\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/);
        const tabShortcodeMatch = rawShortcodeMatch && !['audio', 'explore', 'reels', 'p', 'reel', 'stories', 'direct', 'search'].includes(rawShortcodeMatch[1].toLowerCase()) ? rawShortcodeMatch : null;

        if (!isTarget && tabShortcodeMatch && tabShortcodeMatch[1]) {
          isTarget = true;
          postInfo = {
            shortcode: tabShortcodeMatch[1],
            type: activeTabUrl.includes('/reel') ? 'reel' : 'p'
          };
        }

        if (isTarget && postInfo) {
          isCurrentTabTarget = true;
          currentPostInfo = postInfo;
          pageStatus.className = 'status-pill active';
          pageStatusText.textContent = 'Post/Reel Ready';
          btnExtractCurrent.disabled = false;
          btnExtractText.textContent = 'Scrape Current Page';
          detectedPostInfo.style.display = 'block';
          detectedShortcode.textContent = `${postInfo.type?.toUpperCase() || 'POST'}: ${postInfo.shortcode}`;
        } else {
          isCurrentTabTarget = false;
          currentPostInfo = null;
          pageStatus.className = 'status-pill';
          pageStatusText.textContent = 'Open Post/Reel';
          btnExtractCurrent.disabled = true;
          btnExtractText.textContent = 'Select Post/Reel in Tab';
          detectedPostInfo.style.display = 'none';
        }
      }
    });
  }

  // 6. Trigger Extract from current tab button
  btnExtractCurrent.addEventListener('click', async () => {
    if (!activeTabId || !isCurrentTabTarget) return;

    btnExtractCurrent.disabled = true;
    btnExtractText.textContent = 'Scraping...';

    let action = 'extract_current_post';
    if (currentPlatform === 'tiktok') {
      action = 'extract_current_tiktok';
    } else if (currentPlatform === 'threads') {
      action = 'extract_current_threads';
    } else if (currentPlatform === 'x') {
      action = 'extract_current_x';
    }

    const scriptFilesMap = {
      instagram: 'content.js',
      tiktok: 'tiktok-content.js',
      threads: 'threads-content.js',
      x: 'x-content.js'
    };

    const sendExtractMessage = () => {
      chrome.tabs.sendMessage(
        activeTabId,
        {
          action,
          postInfo: currentPostInfo,
          tabUrl: activeTabUrl
        },
        (res) => {
          btnExtractCurrent.disabled = false;
          if (currentPlatform === 'tiktok') {
            btnExtractText.textContent = 'Scrape TikTok Video';
          } else if (currentPlatform === 'threads') {
            btnExtractText.textContent = 'Scrape Threads Post';
          } else if (currentPlatform === 'x') {
            btnExtractText.textContent = 'Scrape X Tweet';
          } else {
            btnExtractText.textContent = 'Scrape Current Page';
          }

          if (chrome.runtime.lastError) {
            const platformDisplay = currentPlatform === 'threads' ? 'Threads' : (currentPlatform === 'tiktok' ? 'TikTok' : (currentPlatform === 'x' ? 'X' : 'Instagram'));
            showBanner(`Failed to connect to ${platformDisplay} tab. Please refresh the tab.`, 'error');
            return;
          }

          if (res && res.success) {
            let authorTag = 'post';
            if (currentPlatform === 'tiktok') {
              authorTag = `@${res.post?.authorMeta?.name || 'video'}`;
            } else if (currentPlatform === 'threads') {
              authorTag = `@${res.post?.author?.username || 'threads'}`;
            } else if (currentPlatform === 'x') {
              authorTag = `@${res.post?.author?.username || 'tweet'}`;
            } else {
              authorTag = `@${res.post?.ownerUsername || 'post'}`;
            }
            showBanner(`Data for ${authorTag} saved successfully!`, 'success');
          } else if (res && !res.success) {
            showBanner(res.error || 'Failed to scrape data.', 'error');
          }
        }
      );
    };

    const targetScript = scriptFilesMap[currentPlatform];
    if (targetScript && chrome.scripting) {
      chrome.scripting.insertCSS(
        {
          target: { tabId: activeTabId },
          files: ['content.css']
        },
        () => {
          if (chrome.runtime.lastError) { /* ignore */ }
          chrome.scripting.executeScript(
            {
              target: { tabId: activeTabId },
              files: [targetScript]
            },
            () => {
              if (chrome.runtime.lastError) { /* ignore */ }
              sendExtractMessage();
            }
          );
        }
      );
    } else {
      sendExtractMessage();
    }
  });

  // 7. Load and render saved posts safely (no innerHTML XSS)
  function renderPostList(posts) {
    cachedPosts = posts || [];
    totalPostsCount.textContent = cachedPosts.length.toLocaleString('en-US');

    if (cachedPosts.length === 0) {
      postList.innerHTML = '';
      postList.appendChild(emptyState);
      emptyState.style.display = 'block';
      return;
    }

    emptyState.style.display = 'none';
    postList.innerHTML = '';

    // Render posts (newest first)
    cachedPosts.slice().reverse().forEach((item, revIdx) => {
      const actualIdx = cachedPosts.length - 1 - revIdx;
      const card = document.createElement('div');
      card.className = 'post-card';

      let username = '';
      let avatar = DEFAULT_AVATAR;
      let caption = '';
      let likes = '0';
      let comments = '0';
      let postUrl = '';

      if (currentPlatform === 'tiktok') {
        const author = item.authorMeta || {};
        username = author.name || 'unknown';
        avatar = author.avatar || DEFAULT_AVATAR;
        caption = item.text || 'No caption';
        likes = typeof item.diggCount === 'number' ? item.diggCount.toLocaleString('en-US') : '0';
        comments = typeof item.commentCount === 'number' ? item.commentCount.toLocaleString('en-US') : '0';
        postUrl = item.webVideoUrl || '';
      } else if (currentPlatform === 'threads') {
        const author = item.author || {};
        username = author.username || 'unknown';
        avatar = author.profilePicUrl || DEFAULT_AVATAR;
        caption = item.text || 'No caption';
        likes = typeof item.likeCount === 'number' ? item.likeCount.toLocaleString('en-US') : '0';
        comments = typeof item.replyCount === 'number' ? item.replyCount.toLocaleString('en-US') : '0';
        postUrl = item.url || '';
      } else if (currentPlatform === 'x') {
        const author = item.author || {};
        username = author.username || 'unknown';
        avatar = author.avatar || DEFAULT_AVATAR;
        caption = item.text || 'No caption';
        likes = typeof item.likeCount === 'number' ? item.likeCount.toLocaleString('en-US') : '0';
        comments = typeof item.commentCount === 'number' ? item.commentCount.toLocaleString('en-US') : (typeof item.replyCount === 'number' ? item.replyCount.toLocaleString('en-US') : '0');
        postUrl = item.url || '';
      } else {
        const user = item.user || {};
        username = item.ownerUsername || user.username || 'unknown';
        avatar = user.profile_pic_url || DEFAULT_AVATAR;
        caption = item.caption || 'No caption';
        likes = typeof item.likesCount === 'number' ? item.likesCount.toLocaleString('en-US') : '0';
        comments = typeof item.commentsCount === 'number' ? item.commentsCount.toLocaleString('en-US') : '0';
        postUrl = item.url || '';
      }

      // Avatar
      const img = document.createElement('img');
      img.className = 'post-card-avatar';
      img.src = avatar;
      img.addEventListener('error', () => {
        img.src = DEFAULT_AVATAR;
      }, { once: true });
      card.appendChild(img);

      // Content container
      const contentDiv = document.createElement('div');
      contentDiv.className = 'post-card-content';

      const userDiv = document.createElement('div');
      userDiv.className = 'post-card-user';
      if (currentPlatform === 'tiktok' && item.authorMeta?.nickName && item.authorMeta.nickName !== username) {
        userDiv.textContent = `@${username} (${item.authorMeta.nickName})`;
      } else if (currentPlatform === 'threads' && item.author?.fullName && item.author.fullName !== username) {
        userDiv.textContent = `@${username} (${item.author.fullName})`;
      } else if (currentPlatform === 'x' && item.author?.name && item.author.name !== username) {
        userDiv.textContent = `@${username} (${item.author.name})`;
      } else {
        userDiv.textContent = `@${username}`;
      }
      contentDiv.appendChild(userDiv);

      const captionDiv = document.createElement('div');
      captionDiv.className = 'post-card-caption';
      captionDiv.title = caption;
      captionDiv.textContent = caption;
      contentDiv.appendChild(captionDiv);

      const metaDiv = document.createElement('div');
      metaDiv.className = 'post-card-meta';

      const likeSpan = document.createElement('span');
      likeSpan.textContent = `❤️ ${likes}`;
      metaDiv.appendChild(likeSpan);

      const commentSpan = document.createElement('span');
      commentSpan.textContent = `💬 ${comments}`;
      metaDiv.appendChild(commentSpan);

      if (currentPlatform === 'threads' && item.repostCount > 0) {
        const repostSpan = document.createElement('span');
        repostSpan.textContent = `🔁 ${item.repostCount.toLocaleString('en-US')}`;
        metaDiv.appendChild(repostSpan);
      } else if (currentPlatform === 'x') {
        if (item.retweetCount > 0) {
          const rtSpan = document.createElement('span');
          rtSpan.textContent = `🔁 ${item.retweetCount.toLocaleString('en-US')}`;
          metaDiv.appendChild(rtSpan);
        }
        if (item.viewCount > 0) {
          const viewSpan = document.createElement('span');
          viewSpan.textContent = `👁️ ${item.viewCount.toLocaleString('en-US')}`;
          metaDiv.appendChild(viewSpan);
        }
      }

      if (postUrl) {
        const urlSpan = document.createElement('span');
        const shortUrl = postUrl.replace(/^https:\/\/(?:www\.)?(?:instagram\.com|tiktok\.com|threads\.net|threads\.com|x\.com|twitter\.com)/i, '');
        urlSpan.textContent = `🔗 ${shortUrl}`;
        metaDiv.appendChild(urlSpan);
      }
      contentDiv.appendChild(metaDiv);
      card.appendChild(contentDiv);

      // Delete button
      const delBtn = document.createElement('button');
      delBtn.className = 'post-card-del';
      delBtn.title = 'Delete from history';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deletePostByIndex(actualIdx);
      });
      card.appendChild(delBtn);

      // Click card to open post safely in new tab
      card.addEventListener('click', () => {
        if (postUrl && /^https:\/\/(?:www\.)?(?:instagram\.com|tiktok\.com|threads\.net|threads\.com|x\.com|twitter\.com)\//i.test(postUrl)) {
          chrome.tabs.create({ url: postUrl });
        }
      });

      postList.appendChild(card);
    });
  }

  function loadSavedPosts() {
    chrome.runtime.sendMessage({ action: 'get_all_posts', platform: currentPlatform }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      renderPostList(response.posts || []);
    });
  }

  // 8. Automatically react to storage changes
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
      if (currentPlatform === 'instagram' && changes.ig_posts) {
        renderPostList(changes.ig_posts.newValue || []);
      } else if (currentPlatform === 'tiktok' && changes.tiktok_posts) {
        renderPostList(changes.tiktok_posts.newValue || []);
      } else if (currentPlatform === 'threads' && changes.threads_posts) {
        renderPostList(changes.threads_posts.newValue || []);
      } else if (currentPlatform === 'x' && changes.x_posts) {
        renderPostList(changes.x_posts.newValue || []);
      }
    }
  });

  // 9. Delete single post
  function deletePostByIndex(index) {
    chrome.runtime.sendMessage({ action: 'delete_post_by_index', platform: currentPlatform, index }, (res) => {
      if (res && res.success) {
        showBanner('Data deleted successfully.', 'success');
      } else {
        showBanner(res?.error || 'Failed to delete data.', 'error');
      }
    });
  }

  // 10. Download / Save to Downloads (ig.json, tiktok.json, threads.json, x.json)
  btnDownloadJson.addEventListener('click', () => {
    if (cachedPosts.length === 0) {
      const pName = currentPlatform === 'threads' ? 'Threads' : (currentPlatform === 'tiktok' ? 'TikTok' : (currentPlatform === 'x' ? 'X' : 'Instagram'));
      showBanner(`No ${pName} data saved to download.`, 'error');
      return;
    }

    let action = 'export_ig_json';
    let targetFile = 'ig.json';
    if (currentPlatform === 'tiktok') {
      action = 'export_tiktok_json';
      targetFile = 'tiktok.json';
    } else if (currentPlatform === 'threads') {
      action = 'export_threads_json';
      targetFile = 'threads.json';
    } else if (currentPlatform === 'x') {
      action = 'export_x_json';
      targetFile = 'x.json';
    }

    chrome.runtime.sendMessage({ action }, (res) => {
      if (res && res.success) {
        showBanner(`✓ File ${targetFile} saved to Downloads folder successfully!`, 'success');
      } else {
        showBanner(res?.error || `Failed to save ${targetFile}.`, 'error');
      }
    });
  });

  // 11. Copy JSON to Clipboard
  btnCopyJson.addEventListener('click', async () => {
    if (cachedPosts.length === 0) {
      showBanner('No saved data to copy.', 'error');
      return;
    }

    try {
      const jsonStr = JSON.stringify(cachedPosts, null, 2);
      await navigator.clipboard.writeText(jsonStr);
      const countText = cachedPosts.length === 1 ? '1 item' : `${cachedPosts.length.toLocaleString('en-US')} items`;
      showBanner(`✓ Copied ${countText} to clipboard successfully!`, 'success');
    } catch (err) {
      showBanner('Failed to copy to clipboard: ' + err.message, 'error');
    }
  });

  // 12. Clear all posts for current platform
  btnClearAll.addEventListener('click', () => {
    const platformName = currentPlatform === 'threads' ? 'Threads' : (currentPlatform === 'tiktok' ? 'TikTok' : (currentPlatform === 'x' ? 'X' : 'Instagram'));
    if (confirm(`Are you sure you want to clear all saved ${platformName} data?`)) {
      chrome.runtime.sendMessage({ action: 'clear_all_posts', platform: currentPlatform }, (res) => {
        if (res && res.success) {
          showBanner(`All ${platformName} data has been cleared.`, 'success');
        }
      });
    }
  });

  // 13. Import & Merge external JSON
  btnImportJson.addEventListener('click', () => {
    importFileInput.value = '';
    importFileInput.click();
  });

  importFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target.result);
        if (!Array.isArray(parsed)) {
          showBanner('File must contain a JSON array [...]!', 'error');
          return;
        }

        chrome.runtime.sendMessage({ action: 'import_posts', platform: currentPlatform, posts: parsed }, (res) => {
          if (res && res.success) {
            showBanner(`Merge successful! +${res.addedCount} new, ${res.updatedCount} updated.`, 'success');
          } else {
            showBanner(res?.error || 'Failed to merge JSON file.', 'error');
          }
        });
      } catch (err) {
        showBanner('Failed to read JSON file: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
  });

  // Initial setup
  setPlatform(currentPlatform);
});
