/**
 * X (Twitter) In-Page Network Interceptor (Runs in MAIN world)
 * Intercepts internal X GraphQL fetch & XHR responses (TweetDetail, TweetResultByRestId, SearchTimeline, etc.)
 * Extracts raw tweet objects with complete relationship_counts (followers, following),
 * cards, media, and thread replies, and relays them to the isolated content script.
 */
(function() {
  if (window.__X_INTERCEPTOR_INSTALLED__) return;
  window.__X_INTERCEPTOR_INSTALLED__ = true;

  window.__X_CAPTURED_TWEETS__ = window.__X_CAPTURED_TWEETS__ || {};
  window.__X_CAPTURED_THREADS__ = window.__X_CAPTURED_THREADS__ || {};

  const MAX_CACHE_ENTRIES = 100;
  const tweetKeys = [];
  const threadKeys = [];

  function saveTweet(id, tweetObj) {
    if (!id || !tweetObj) return;
    const strId = String(id);
    const existing = window.__X_CAPTURED_TWEETS__[strId];
    if (existing) {
      // If new tweetObj has empty text, but existing had text, preserve it!
      if (existing.text && (!tweetObj.text || !tweetObj.text.trim())) {
        tweetObj.text = existing.text;
      }
      // If new tweetObj has default createdAt, but existing had a real timestamp, preserve it!
      if (existing.createdAt && (!tweetObj.createdAt || tweetObj.createdAt.length < 5)) {
        tweetObj.createdAt = existing.createdAt;
      }
    }
    if (!window.__X_CAPTURED_TWEETS__[strId]) {
      tweetKeys.push(strId);
      if (tweetKeys.length > MAX_CACHE_ENTRIES) {
        const oldest = tweetKeys.shift();
        delete window.__X_CAPTURED_TWEETS__[oldest];
      }
    }
    window.__X_CAPTURED_TWEETS__[strId] = tweetObj;
  }

  function saveThread(keyId, allTweets) {
    if (!keyId || !Array.isArray(allTweets) || allTweets.length === 0) return;
    const strId = String(keyId);
    if (!window.__X_CAPTURED_THREADS__[strId]) {
      threadKeys.push(strId);
      if (threadKeys.length > MAX_CACHE_ENTRIES) {
        const oldest = threadKeys.shift();
        delete window.__X_CAPTURED_THREADS__[oldest];
      }
    }

    // Merge if thread already exists to prevent pagination fragmentation
    if (window.__X_CAPTURED_THREADS__[strId]) {
      const existing = window.__X_CAPTURED_THREADS__[strId];
      const seen = new Set(existing.map(t => t.id));
      for (const t of allTweets) {
        if (t && t.id && !seen.has(t.id)) {
          existing.push(t);
          seen.add(t.id);
        }
      }
    } else {
      window.__X_CAPTURED_THREADS__[strId] = allTweets;
    }
  }

  function broadcastData(type, payload) {
    try {
      window.dispatchEvent(
        new CustomEvent('X_INTERCEPTED_DATA', {
          detail: { type, payload }
        })
      );
    } catch (_) {}
  }

  /**
   * Helper to unwrap Tweet result from GraphQL
   */
  function unwrapTweetResult(result) {
    if (!result || typeof result !== 'object') return null;
    if (result.result && typeof result.result === 'object') {
      result = result.result;
    }
    if (result.tweet && typeof result.tweet === 'object') {
      return result.tweet;
    }
    if (result.__typename === 'TweetWithVisibilityResults' && result.tweet) {
      return result.tweet;
    }
    if (result.__typename === 'Tweet' || result.rest_id || result.legacy) {
      return result;
    }
    return null;
  }

  /**
   * Helper to unwrap User result from GraphQL
   */
  function unwrapUserResult(result) {
    if (!result || typeof result !== 'object') return null;
    if (result.result && typeof result.result === 'object') {
      result = result.result;
    }
    if (result.user && typeof result.user === 'object') {
      return result.user;
    }
    if (result.__typename === 'UserWithVisibilityResults' && result.user) {
      return result.user;
    }
    if (result.__typename === 'User' || result.rest_id || result.legacy) {
      return result;
    }
    return null;
  }

  /**
   * Transform raw GraphQL tweet result into the standardized 30-field schema
   */
  function transformGraphQLTweet(rawTweet) {
    const tweet = unwrapTweetResult(rawTweet);
    if (!tweet) return null;

    const id = String(tweet.rest_id || tweet.legacy?.id_str || rawTweet?.rest_id || '');
    if (!id) return null;

    const rawUser = tweet.core?.user_results?.result || rawTweet?.core?.user_results?.result;
    const user = unwrapUserResult(rawUser) || {};
    const legacyUser = user.legacy || rawUser?.legacy || rawUser?.user?.legacy || {};
    const legacyTweet = tweet.legacy || rawTweet?.legacy || rawTweet?.tweet?.legacy || tweet?.tweet?.legacy || {};

    // Username & Name
    const userName = String(user.core?.screen_name || legacyUser.screen_name || '').replace(/^@/, '');
    const name = String(user.core?.name || legacyUser.name || userName || 'X User');

    // Followers & Following (relationship_counts takes priority)
    const followers = Number(
      user.relationship_counts?.followers ??
      legacyUser.followers_count ??
      0
    );
    const following = Number(
      user.relationship_counts?.following ??
      legacyUser.friends_count ??
      0
    );

    // Profile & Cover images
    const profilePicture = user.avatar?.image_url || legacyUser.profile_image_url_https || '';
    const coverPicture = user.banner?.image_url || legacyUser.profile_banner_url || '';

    // Description & Location
    const description = user.profile_bio?.description || legacyUser.description || '';
    const location = user.location?.location || legacyUser.location || '';

    // Text: support long note tweets, legacy full_text, grok translation, and raw_text
    const fullText = (
      tweet.note_tweet?.note_tweet_results?.result?.text ||
      legacyTweet.full_text ||
      tweet.legacy?.full_text ||
      tweet.text ||
      tweet.full_text ||
      tweet.raw_text?.text ||
      tweet.grok_translated_post_with_availability?.data?.translation ||
      rawTweet?.legacy?.full_text ||
      rawTweet?.tweet?.legacy?.full_text ||
      rawTweet?.text ||
      ''
    );

    // Conversation & Reply status
    const inReplyToId = legacyTweet.in_reply_to_status_id_str || tweet.in_reply_to_status_id_str || null;
    const isReply = Boolean(inReplyToId);
    const conversationId = legacyTweet.conversation_id_str || tweet.conversation_id_str || id;
    const inReplyToUserId = legacyTweet.in_reply_to_user_id_str || tweet.in_reply_to_user_id_str || null;
    const inReplyToUsername = legacyTweet.in_reply_to_screen_name || tweet.in_reply_to_screen_name || null;

    // Dates
    const createdAt = legacyTweet.created_at || tweet.created_at || '';
    const userCreatedAt = user.core?.created_at || legacyUser.created_at || '';

    // Verified
    const isBlueVerified = Boolean(user.is_blue_verified ?? legacyUser.is_blue_verified ?? legacyUser.verified);
    const isVerified = Boolean(legacyUser.verified ?? false);

    // Entities & Card
    const card = tweet.card?.legacy || tweet.card || rawTweet?.card?.legacy || rawTweet?.card || null;
    const extendedEntities = legacyTweet.extended_entities || tweet.extended_entities || {};
    const entities = legacyTweet.entities || tweet.entities || { urls: [] };

    const author = {
      type: 'user',
      userName,
      url: userName ? `https://x.com/${userName}` : '',
      twitterUrl: userName ? `https://twitter.com/${userName}` : '',
      id: String(user.rest_id || legacyUser.id_str || ''),
      name,
      isVerified,
      isBlueVerified,
      profilePicture,
      coverPicture,
      description,
      location,
      followers: Number.isFinite(followers) ? followers : 0,
      following: Number.isFinite(following) ? following : 0,
      status: legacyUser.status || '',
      canDm: Boolean(legacyUser.can_dm ?? false),
      canMediaTag: Boolean(user.media_permissions?.can_media_tag ?? legacyUser.can_media_tag ?? false),
      createdAt: userCreatedAt,
      entities: user.profile_bio?.entities || legacyUser.entities || {
        description: { urls: [] },
        url: { urls: [] }
      },
      fastFollowersCount: Number(legacyUser.fast_followers_count ?? 0),
      favouritesCount: Number(user.action_counts?.favorites_count ?? legacyUser.favourites_count ?? 0),
      hasCustomTimelines: Boolean(legacyUser.has_custom_timelines ?? true),
      isTranslator: Boolean(legacyUser.is_translator ?? false),
      mediaCount: Number(legacyUser.media_count ?? 0),
      statusesCount: Number(legacyUser.statuses_count ?? 0),
      withheldInCountries: Array.isArray(legacyUser.withheld_in_countries) ? legacyUser.withheld_in_countries : [],
      affiliatesHighlightedLabel: user.affiliates_highlighted_label || {},
      possiblySensitive: Boolean(user.possibly_sensitive ?? legacyUser.possibly_sensitive ?? false),
      pinnedTweetIds: Array.isArray(legacyUser.pinned_tweet_ids_str) ? legacyUser.pinned_tweet_ids_str : [],
      profile_bio: user.profile_bio || {},
      isAutomated: Boolean(user.automated ?? false),
      automatedBy: user.automated_by ?? null
    };

    return {
      type: 'tweet',
      id,
      url: userName ? `https://x.com/${userName}/status/${id}` : `https://x.com/i/status/${id}`,
      twitterUrl: userName ? `https://twitter.com/${userName}/status/${id}` : `https://twitter.com/i/status/${id}`,
      text: fullText,
      source: tweet.source || legacyTweet.source || rawTweet?.source || '',
      retweetCount: Number(legacyTweet.retweet_count ?? tweet.retweet_count ?? rawTweet?.legacy?.retweet_count ?? 0),
      replyCount: Number(legacyTweet.reply_count ?? tweet.reply_count ?? rawTweet?.legacy?.reply_count ?? 0),
      likeCount: Number(legacyTweet.favorite_count ?? tweet.favorite_count ?? rawTweet?.legacy?.favorite_count ?? 0),
      quoteCount: Number(legacyTweet.quote_count ?? tweet.quote_count ?? rawTweet?.legacy?.quote_count ?? 0),
      viewCount: Number(tweet.views?.count ?? rawTweet?.views?.count ?? 0),
      createdAt,
      lang: String(legacyTweet.lang || tweet.lang || 'in'),
      bookmarkCount: Number(legacyTweet.bookmark_count ?? tweet.bookmark_count ?? 0),
      isReply,
      inReplyToId,
      conversationId,
      inReplyToUserId,
      inReplyToUsername,
      isPinned: false,
      author,
      extendedEntities,
      card,
      place: legacyTweet.place || {},
      entities,
      reply_to_user_results: tweet.reply_to_user_results || null,
      quoted_tweet_results: tweet.quoted_status_result || null,
      quoted_tweet: tweet.quoted_status_result ? transformGraphQLTweet(tweet.quoted_status_result) : null,
      retweeted_tweet: tweet.retweeted_status_result ? transformGraphQLTweet(tweet.retweeted_status_result) : null,
      isConversationControlled: Boolean(tweet.is_conversation_controlled ?? false)
    };
  }

  /**
   * Recursively collect all tweet_results from GraphQL json payload with deduplication
   */
  function extractTweetsFromGraphQLPayload(json) {
    const extracted = [];
    const seenIds = new Set();
    if (!json || typeof json !== 'object') return extracted;

    function walk(obj) {
      if (!obj || typeof obj !== 'object') return;

      if (obj.tweet_results && obj.tweet_results.result) {
        const transformed = transformGraphQLTweet(obj.tweet_results.result);
        if (transformed && transformed.id && !seenIds.has(transformed.id)) {
          seenIds.add(transformed.id);
          extracted.push(transformed);
        }
        return; // Avoid descending into transformed tweet node
      } else if (obj.__typename === 'Tweet' && obj.rest_id && obj.legacy) {
        const transformed = transformGraphQLTweet(obj);
        if (transformed && transformed.id && !seenIds.has(transformed.id)) {
          seenIds.add(transformed.id);
          extracted.push(transformed);
        }
        return; // Avoid descending into transformed tweet node
      }

      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
          walk(obj[i]);
        }
      } else {
        const keys = Object.keys(obj);
        for (let i = 0; i < keys.length; i++) {
          walk(obj[keys[i]]);
        }
      }
    }

    try {
      walk(json);
    } catch (_) {}

    return extracted;
  }

  /**
   * Process a captured GraphQL response
   */
  function processGraphQLResponse(url, json) {
    if (!json || typeof json !== 'object') return;

    const isTweetDetail = url.includes('TweetDetail');
    const tweets = extractTweetsFromGraphQLPayload(json);
    if (!tweets || tweets.length === 0) return;

    // Save individual tweets
    for (const t of tweets) {
      saveTweet(t.id, t);
    }

    if (isTweetDetail) {
      // Find focal/root tweet
      let rootTweet = tweets.find(t => !t.isReply);
      if (!rootTweet) {
        rootTweet = tweets[0];
      }
      const rootId = rootTweet.id;
      const convId = rootTweet.conversationId || rootId;

      const threadTweets = tweets.filter(t => t.id === rootId || t.conversationId === convId || t.inReplyToId === rootId);
      const effectiveThread = threadTweets.length > 0 ? threadTweets : tweets;

      // Index under rootId, conversationId, and member IDs so reply tweets find their thread
      saveThread(rootId, effectiveThread);
      if (convId !== rootId) {
        saveThread(convId, effectiveThread);
      }
      for (const t of effectiveThread) {
        if (t.id && !window.__X_CAPTURED_THREADS__[t.id]) {
          saveThread(t.id, effectiveThread);
        }
      }

      broadcastData('thread', {
        rootId,
        conversationId: convId,
        rootTweet,
        thread: effectiveThread
      });
    } else {
      broadcastData('tweets', tweets);
    }
  }

  // 1. Intercept window.fetch
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function(...args) {
      const response = await originalFetch.apply(this, args);
      try {
        let url = '';
        if (typeof args[0] === 'string') {
          url = args[0];
        } else if (args[0] && typeof args[0] === 'object') {
          url = args[0].url || args[0].href || String(args[0]);
        }

        if (url.includes('/i/api/graphql/') || url.includes('/graphql/')) {
          const clone = response.clone();
          clone.text().then(text => {
            if (!text || !text.trim()) return;
            try {
              const json = JSON.parse(text);
              processGraphQLResponse(url, json);
            } catch (_) {}
          }).catch(() => {});
        }
      } catch (_) {}
      return response;
    };
  }

  // 2. Intercept XMLHttpRequest
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    if (typeof url === 'string') {
      this._xInterceptUrl = url;
    } else if (url && typeof url === 'object') {
      this._xInterceptUrl = url.href || url.url || String(url);
    } else {
      this._xInterceptUrl = String(url || '');
    }
    return originalXhrOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', function() {
      try {
        const url = this._xInterceptUrl || '';
        if (url.includes('/i/api/graphql/') || url.includes('/graphql/')) {
          let json = null;
          if (this.responseType === 'json' && this.response) {
            json = this.response;
          } else if (this.responseType === '' || this.responseType === 'text') {
            const text = this.responseText;
            if (!text || !text.trim()) return;
            json = JSON.parse(text);
          }
          if (json && typeof json === 'object') {
            processGraphQLResponse(url, json);
          }
        }
      } catch (_) {}
    });
    return originalXhrSend.apply(this, args);
  };

  // 3. Listen for requests from content script
  window.addEventListener('X_REQUEST_CAPTURED_DATA', (e) => {
    try {
      const targetId = e.detail?.targetId;
      if (!targetId) return;
      const strId = String(targetId);

      let thread = window.__X_CAPTURED_THREADS__[strId] || null;
      if (!thread) {
        // Search through all threads to see if targetId is a member
        for (const th of Object.values(window.__X_CAPTURED_THREADS__)) {
          if (Array.isArray(th) && th.some(t => t.id === strId)) {
            thread = th;
            break;
          }
        }
      }

      const tweet = window.__X_CAPTURED_TWEETS__[strId] || (thread ? thread.find(t => t.id === strId) : null);
      window.dispatchEvent(
        new CustomEvent('X_RESPOND_CAPTURED_DATA', {
          detail: { targetId: strId, tweet, thread }
        })
      );
    } catch (_) {}
  });

  console.log('[X Interceptor] Installed in MAIN world for Twitter/X GraphQL interception.');
})();
