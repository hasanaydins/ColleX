// Twitter/X bookmark sync via the internal GraphQL API.
// Captures bearer token + queryId dynamically via Electron session interception.
const https = require("https");
const fs = require("fs");
const path = require("path");
const { loadCredentials } = require("./credentials");

// Fallback bearer token (public, embedded in Twitter's JS bundle)
const FALLBACK_BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

// Claimed Chrome major version for UA + client-hint headers. Using stable-1
// (one behind current stable) so the UA matches the largest real-user slice
// and avoids bleeding-edge fingerprint mismatches. Bump periodically.
const CHROME_MAJOR = 146;

// Feature flags required by X's GraphQL API
const GRAPHQL_FEATURES = {
  rweb_video_screen_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_jetfuel_frame: true,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_annotations_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  content_disclosure_indicator_enabled: true,
  content_disclosure_ai_generated_indicator_enabled: true,
  responsive_web_grok_show_grok_translated_post: true,
  responsive_web_grok_analysis_button_from_backend: true,
  post_ctas_fetch_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: false,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  responsive_web_enhance_cards_enabled: false,
};

function makeHeaders({ bearerToken, ct0, authToken }) {
  const bearer = bearerToken.startsWith("Bearer ") ? bearerToken : `Bearer ${bearerToken}`;
  return {
    authorization: bearer,
    "x-csrf-token": ct0,
    "x-twitter-auth-type": "OAuth2Session",
    "x-twitter-active-user": "yes",
    "x-twitter-client-language": "en",
    cookie: `auth_token=${authToken}; ct0=${ct0}`,
    "user-agent":
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
    "content-type": "application/json",
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    referer: "https://x.com/i/bookmarks",
    origin: "https://x.com",
    "sec-ch-ua": `"Google Chrome";v="${CHROME_MAJOR}", "Chromium";v="${CHROME_MAJOR}", "Not?A_Brand";v="24"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
  };
}

// Folder endpoint queryIds — X rotates these occasionally. If they expire,
// folder enrichment fails gracefully and the main sync still completes.
const FOLDERS_SLICE_QUERY_ID = "i78YDd0Tza-dV4SYs58kRg";
const FOLDER_TIMELINE_QUERY_ID = "LML09uXDwh87F1zd7pbf2w";
// TweetDetail queryId — rotates too. Failure bubbles to /thread as a 502 and
// the UI hides the "Show thread" state.
const TWEET_DETAIL_QUERY_ID = "nBS-WpgA6ZG0CyNHD517JQ";

function fetchGraphQL(creds, queryId, operation, variables) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      variables: JSON.stringify(variables),
      features: JSON.stringify(GRAPHQL_FEATURES),
    });
    const url = `https://x.com/i/api/graphql/${queryId}/${operation}?${params}`;
    const headers = makeHeaders(creds);

    const req = https.get(url, { headers, timeout: 30000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        if (res.statusCode === 429) {
          reject(Object.assign(new Error("Rate limited"), { status: 429 }));
          return;
        }
        if (res.statusCode === 401 || res.statusCode === 403) {
          reject(Object.assign(new Error("Authentication expired — please re-login"), { status: res.statusCode }));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse failed (${res.statusCode}): ${body.slice(0, 300)}`)); }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
  });
}

const fetchPage = (creds, variables) =>
  fetchGraphQL(creds, creds.queryId, "Bookmarks", variables);

// Pull a normalized { title, description, url, image } out of X's card
// binding_values (link preview). Card shapes vary (summary / summary_large_image /
// player / unified_card) — we probe common keys and return null if nothing useful.
function parseCard(tweet) {
  const card = tweet?.card?.legacy;
  if (!card) return null;

  const bindings = card.binding_values || [];
  const get = (key) => bindings.find((b) => b.key === key)?.value;
  const getString = (key) => get(key)?.string_value || null;
  const getImage = (key) => {
    const v = get(key)?.image_value;
    return v && v.url ? { url: v.url, width: v.width || 0, height: v.height || 0 } : null;
  };

  const image =
    getImage("thumbnail_image_large") ||
    getImage("thumbnail_image_original") ||
    getImage("thumbnail_image") ||
    getImage("photo_image_full_size_large") ||
    getImage("photo_image_full_size_original") ||
    getImage("summary_photo_image_large") ||
    getImage("summary_photo_image_original") ||
    null;

  const title = getString("title");
  const description = getString("description");
  const vanityUrl = getString("vanity_url");
  const cardUrl = card.url || getString("card_url");

  if (!title && !description && !image) return null;
  return { title, description, url: cardUrl, vanityUrl, image };
}

function parseTweet(tweetResult) {
  const tweet = tweetResult?.tweet ?? tweetResult;
  const legacy = tweet?.legacy;
  if (!legacy) return null;

  const tweetId = legacy.id_str ?? tweet?.rest_id;
  if (!tweetId) return null;

  // Twitter migrated user fields from `legacy.*` to `core.*` / `avatar.*` — check both
  const userResult = tweet?.core?.user_results?.result;
  const authorHandle =
    userResult?.core?.screen_name ??
    userResult?.legacy?.screen_name ??
    "";
  const authorName =
    userResult?.core?.name ??
    userResult?.legacy?.name ??
    "";
  const authorProfileImageUrl =
    userResult?.avatar?.image_url ??
    userResult?.legacy?.profile_image_url_https ??
    "";

  const mediaEntities = legacy.extended_entities?.media ?? legacy.entities?.media ?? [];
  const mediaObjects = mediaEntities.map((m) => ({
    type: m.type,
    url: m.media_url_https,
    width: m.original_info?.width ?? m.sizes?.large?.w,
    height: m.original_info?.height ?? m.sizes?.large?.h,
    videoVariants: m.video_info?.variants?.filter((v) => v.content_type === "video/mp4") ?? [],
  }));

  // Longform note tweets carry the untruncated body in note_tweet — legacy.full_text
  // is cut off at ~280 chars for these. Prefer note_tweet when present.
  const noteTweet = tweet?.note_tweet?.note_tweet_results?.result;
  const text = noteTweet?.text ?? legacy.full_text ?? "";

  // URL entities — note_tweet has its own entity_set aligned with the longform text
  const urlEntities =
    noteTweet?.entity_set?.urls ??
    legacy.entities?.urls ??
    [];
  // Longform detection: X injects a "read more" self-URL into entities when
  // full_text is truncated. If note_tweet came back, we already have the full
  // body. If not, the UI can lazy-fetch via TweetDetail to unfurl it.
  const selfUrlMarker = urlEntities.some(
    (u) => typeof u.expanded_url === "string" && u.expanded_url.includes(`/status/${tweetId}`)
  );
  const isLongForm = !!noteTweet || selfUrlMarker;
  const textIsTruncated = isLongForm && !noteTweet;

  const urls = urlEntities
    .filter(
      (u) =>
        u.expanded_url &&
        // Strip the "show more" self-URL marker so it doesn't show up as a user-facing chip
        !u.expanded_url.includes(`/status/${tweetId}`)
    )
    .map((u) => ({
      tco: u.url || "",
      expanded: u.expanded_url,
      display: u.display_url || u.expanded_url,
    }));

  // Quoted tweet — recurse through parseTweet. Wrapper handling (TweetWithVisibilityResults,
  // { tweet: … }) is done at the top of parseTweet, so passing the raw result is safe.
  const quotedResult = tweet?.quoted_status_result?.result;
  const quotedTweet = quotedResult ? parseTweet(quotedResult) : null;

  return {
    tweetId,
    text,
    url: `https://x.com/${authorHandle}/status/${tweetId}`,
    authorHandle: authorHandle ?? "",
    authorName: authorName ?? "",
    authorProfileImageUrl: authorProfileImageUrl ?? "",
    postedAt: legacy.created_at ?? "",
    mediaObjects,
    urls,
    card: parseCard(tweet),
    quotedTweet,
    isLongForm,
    textIsTruncated,
    lang: legacy.lang || "",
    conversationId: legacy.conversation_id_str || null,
    inReplyToStatusId: legacy.in_reply_to_status_id_str || null,
    inReplyToScreenName: legacy.in_reply_to_screen_name || null,
    engagement: {
      likeCount: legacy.favorite_count ?? 0,
      repostCount: legacy.retweet_count ?? 0,
      replyCount: legacy.reply_count ?? 0,
      quoteCount: legacy.quote_count ?? 0,
      bookmarkCount: legacy.bookmark_count ?? 0,
      viewCount: parseInt(tweet?.views?.count, 10) || 0,
    },
  };
}

function parseTimelineInstructions(instructions) {
  const tweets = [];
  let cursor = null;

  for (const instruction of instructions) {
    for (const entry of instruction.entries ?? []) {
      const result = entry.content?.itemContent?.tweet_results?.result;
      if (result) {
        const parsed =
          result.__typename === "TweetWithVisibilityResults"
            ? parseTweet(result.tweet)
            : parseTweet(result);
        if (parsed) tweets.push(parsed);
      }
      // Extract bottom cursor for pagination
      if (
        entry.content?.cursorType === "Bottom" ||
        entry.entryId?.startsWith("cursor-bottom")
      ) {
        cursor = entry.content?.value ?? null;
      }
    }
  }

  return { tweets, cursor };
}

function extractImages(mediaObjects) {
  const filtered = (mediaObjects || []).filter(
    (m) => (m.type === "photo" || m.type === "video" || m.type === "animated_gif") && m.url
  );
  return filtered.map((m) => {
    const entry = {
      url: m.url,
      width: m.width || 1,
      height: m.height || 1,
      type: m.type || "photo",
    };
    if ((m.type === "video" || m.type === "animated_gif") && m.videoVariants?.length) {
      const mp4s = m.videoVariants
        .filter((v) => v.url && v.url.includes(".mp4"))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (mp4s.length > 0) entry.videoUrl = mp4s[0].url;
    }
    return entry;
  });
}

// Lighter shape for embedded quoted tweets — no folders, no engagement counts,
// just what the UI needs to render a compact preview.
function transformQuoted(raw) {
  if (!raw) return null;
  return {
    id: raw.tweetId,
    text: raw.text || "",
    url: raw.url || `https://x.com/${raw.authorHandle}/status/${raw.tweetId}`,
    authorHandle: raw.authorHandle || "",
    authorName: raw.authorName || "",
    authorAvatar: raw.authorProfileImageUrl || "",
    postedAt: raw.postedAt || "",
    images: extractImages(raw.mediaObjects),
    urls: raw.urls || [],
  };
}

// Transform raw tweet (from parseTweet) → app bookmark format
function transformBookmark(raw) {
  const images = extractImages(raw.mediaObjects);

  return {
    id: raw.tweetId,
    text: raw.text || "",
    url: raw.url || `https://x.com/${raw.authorHandle}/status/${raw.tweetId}`,
    authorHandle: raw.authorHandle || "",
    authorName: raw.authorName || "",
    authorAvatar: raw.authorProfileImageUrl || "",
    postedAt: raw.postedAt || "",
    images,
    mediaCount: images.length,
    likeCount: raw.engagement?.likeCount ?? 0,
    repostCount: raw.engagement?.repostCount ?? 0,
    replyCount: raw.engagement?.replyCount ?? 0,
    quoteCount: raw.engagement?.quoteCount ?? 0,
    viewCount: raw.engagement?.viewCount ?? 0,
    bookmarkCount: raw.engagement?.bookmarkCount ?? 0,
    urls: raw.urls || [],
    card: raw.card || null,
    quotedTweet: transformQuoted(raw.quotedTweet),
    isLongForm: !!raw.isLongForm,
    textIsTruncated: !!raw.textIsTruncated,
    lang: raw.lang || "",
    conversationId: raw.conversationId || null,
    inReplyTo: raw.inReplyToScreenName
      ? { screenName: raw.inReplyToScreenName, statusId: raw.inReplyToStatusId }
      : null,
    folders: [],
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => min + Math.floor(Math.random() * (max - min));

async function fetchAllPages(creds, onProgress) {
  let cursor = null;
  let page = 0;
  const all = [];

  while (true) {
    page++;
    const variables = {
      count: 100,
      includePromotedContent: false,
      withClientEventToken: false,
      withBirdwatchNotes: false,
      withVoice: true,
      withV2Timeline: true,
    };
    if (cursor) variables.cursor = cursor;

    onProgress({ type: "progress", message: `Fetching page ${page}…`, count: all.length });

    let json;
    let attempts = 0;
    while (attempts < 3) {
      try {
        json = await fetchPage(creds, variables);
        break;
      } catch (err) {
        if (err.status === 429 && attempts < 2) {
          const waitMs = 30000 * Math.pow(2, attempts) + jitter(0, 10000);
          onProgress({ type: "progress", message: `Rate limited — waiting ${Math.round(waitMs / 1000)}s…`, count: all.length });
          await sleep(waitMs);
          attempts++;
        } else {
          throw err;
        }
      }
    }

    const instructions =
      json?.data?.bookmark_timeline_v2?.timeline?.instructions ?? [];
    const { tweets, cursor: nextCursor } = parseTimelineInstructions(instructions);

    all.push(...tweets);

    if (!nextCursor || tweets.length === 0) break;
    cursor = nextCursor;
    await sleep(jitter(800, 2000));
  }

  return all;
}

async function fetchFolderList(creds) {
  const json = await fetchGraphQL(creds, FOLDERS_SLICE_QUERY_ID, "BookmarkFoldersSlice", {});
  const items =
    json?.data?.viewer?.user_results?.result?.bookmark_collections_slice?.items ?? [];
  return items.map((f) => ({ id: f.id, name: f.name }));
}

async function fetchFolderTweetIds(creds, folderId, folderName, onProgress) {
  const ids = [];
  let cursor = null;
  let page = 0;

  while (true) {
    page++;
    const variables = { bookmark_collection_id: folderId, includePromotedContent: true };
    if (cursor) variables.cursor = cursor;

    onProgress({
      type: "progress",
      message: `Fetching folder "${folderName}" (page ${page})…`,
      count: ids.length,
    });

    const json = await fetchGraphQL(creds, FOLDER_TIMELINE_QUERY_ID, "BookmarkFolderTimeline", variables);
    const instructions =
      json?.data?.bookmark_collection_timeline?.timeline?.instructions ?? [];
    const { tweets, cursor: nextCursor } = parseTimelineInstructions(instructions);

    for (const t of tweets) if (t.tweetId) ids.push(t.tweetId);

    if (!nextCursor || tweets.length === 0) break;
    cursor = nextCursor;
    await sleep(jitter(700, 1800));
  }

  return ids;
}

// Attaches folder names to each bookmark in-place and returns the folder list.
// Never throws — folder endpoints rotate queryIds, so failure degrades to "no folders"
// rather than breaking the whole sync.
async function enrichWithFolders(creds, bookmarks, onProgress) {
  try {
    const folders = await fetchFolderList(creds);
    if (folders.length === 0) return [];

    const bookmarkById = new Map(bookmarks.map((b) => [b.id, b]));

    let firstFolder = true;
    for (const folder of folders) {
      // Space out folder requests so we don't burst-enumerate the whole list.
      if (!firstFolder) await sleep(jitter(2000, 5000));
      firstFolder = false;

      let tweetIds;
      try {
        tweetIds = await fetchFolderTweetIds(creds, folder.id, folder.name, onProgress);
      } catch (e) {
        onProgress({
          type: "progress",
          message: `Folder "${folder.name}" fetch failed: ${e.message}`,
          count: 0,
        });
        continue;
      }
      for (const tid of tweetIds) {
        const bm = bookmarkById.get(tid);
        if (!bm) continue;
        if (!bm.folders.includes(folder.name)) bm.folders.push(folder.name);
      }
    }

    return folders;
  } catch (e) {
    onProgress({
      type: "progress",
      message: `Folder sync skipped: ${e.message}`,
      count: 0,
    });
    return [];
  }
}

async function syncBookmarks(dataDir, onProgress) {
  const creds = loadCredentials(dataDir);
  if (!creds) {
    throw new Error("Not authenticated — please re-login through the app");
  }

  // Use fallback bearer if captured one is missing
  if (!creds.bearerToken) creds.bearerToken = FALLBACK_BEARER;

  const rawTweets = await fetchAllPages(creds, onProgress);
  const bookmarks = rawTweets.map(transformBookmark);

  // Sort by most recent first
  bookmarks.sort((a, b) => new Date(b.postedAt) - new Date(a.postedAt));

  // Pause before switching to folder enumeration so the two phases don't look
  // like one continuous burst.
  await sleep(jitter(3000, 6000));

  // Tag bookmarks with folder names (best-effort — folders stay empty on failure)
  const folders = await enrichWithFolders(creds, bookmarks, onProgress);

  const output = { bookmarks, folders };
  const outPath = path.join(dataDir, "bookmarks-data.json");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf8");

  onProgress({ type: "done", total: bookmarks.length });
}

// Fetches the full threaded conversation around `tweetId` via TweetDetail GraphQL.
// Returns an array of bookmark-shaped tweets in conversation order (ancestors first,
// focal tweet in the middle, replies after). No pagination — first page only, which
// already covers the visible thread for most tweets.
async function fetchThread(creds, tweetId) {
  if (!creds.bearerToken) creds.bearerToken = FALLBACK_BEARER;

  const variables = {
    focalTweetId: String(tweetId),
    with_rux_injections: false,
    includePromotedContent: false,
    withCommunity: true,
    withQuickPromoteEligibilityTweetFields: true,
    withBirdwatchNotes: true,
    withVoice: true,
    withV2Timeline: true,
  };

  const json = await fetchGraphQL(creds, TWEET_DETAIL_QUERY_ID, "TweetDetail", variables);
  const instructions =
    json?.data?.threaded_conversation_with_injections_v2?.instructions ?? [];

  const tweets = [];
  const seen = new Set();
  const push = (result) => {
    const parsed = parseTweet(result);
    if (!parsed || seen.has(parsed.tweetId)) return;
    seen.add(parsed.tweetId);
    tweets.push(transformBookmark(parsed));
  };

  for (const instruction of instructions) {
    if (instruction.type !== "TimelineAddEntries") continue;
    for (const entry of instruction.entries ?? []) {
      const direct = entry.content?.itemContent?.tweet_results?.result;
      if (direct) { push(direct); continue; }
      // Module-style entries (conversationthread-<id>) wrap multiple reply tweets
      const items = entry.content?.items;
      if (Array.isArray(items)) {
        for (const it of items) {
          const r = it.item?.itemContent?.tweet_results?.result;
          if (r) push(r);
        }
      }
    }
  }

  return tweets;
}

function fetchUserInfo(creds) {
  return new Promise((resolve) => {
    const headers = makeHeaders(creds);
    const req = https.get(
      "https://x.com/i/api/1.1/account/verify_credentials.json",
      { headers, timeout: 10000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try {
            const d = JSON.parse(body);
            resolve({
              userHandle: d.screen_name || null,
              userName: d.name || null,
              userAvatar: d.profile_image_url_https?.replace("_normal", "_bigger") || null,
            });
          } catch { resolve({}); }
        });
      }
    );
    req.on("error", () => resolve({}));
    req.on("timeout", () => { req.destroy(); resolve({}); });
  });
}

module.exports = { syncBookmarks, fetchUserInfo, fetchThread };
