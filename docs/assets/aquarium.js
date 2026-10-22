/*
 * Nightcore Tracker: channel aquarium (channels.html).
 *
 * Loads data/channels.json, preloads every avatar (or prepares its initials
 * fallback), packs all channels into one finite virtual world and only then
 * reveals the scene: avatars drift on a slow current, collide softly through
 * d3-force and can be explored with a d3-zoom camera.
 *
 * The page has one scene per channel group (active, then inactive); boot()
 * starts the same controller once per stage, each drawing only its group.
 *
 * The pure logic (radius scale, world size, seeding, image queue, pinning,
 * JSON checks, tooltip placement) has no DOM dependency and is exported for
 * the Node tests in tests/js/. Channel data is only ever written with
 * textContent or as attribute values of checked URLs, never as markup.
 *
 * Load order: assets/d3.min.js, then this file, both deferred.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else if (root && root.document) {
    api.boot(root);
  }
})(typeof window !== "undefined" ? window : this, function () {
  "use strict";

  /* --- Tunable constants ------------------------------------------------ */

  // Loading. Durations are milliseconds and go through an injectable clock.
  var LOADER = {
    dataTimeoutMs: 15000,
    imageConcurrency: 16,
    imageTimeoutMs: 8000,
    imageBudgetMs: 45000
  };

  // Virtual world, in world units (pixels at zoom 1). Radius bounds come from
  // the page (data-min-radius / data-max-radius, rendered from Python).
  var WORLD = {
    occupancy: 0.35,
    aspect: 1.6,
    marginRadii: 2,
    seedAttempts: 24
  };

  var PHYSICS = {
    gap: 4,
    collideStrength: 0.6,
    collideIterations: 2,
    velocityDecay: 0.03,
    drift: 0.45,
    steer: 0.05,
    maxSpeed: 1.2,
    maxAccel: 0.08,
    wallStrength: 0.004,
    stepMs: 1000 / 60,
    maxStepsPerFrame: 2,
    packTicks: 160,
    packChunk: 20
  };

  var CAMERA = {
    maxZoom: 3,
    minZoomOfFit: 0.85,
    zoomStep: 1.5,
    clickDistance: 6
  };

  // Avatar files requested per drawn diameter at zoom 1 (world units = CSS
  // px): small avatars no longer download the stored 240 px image. With a
  // full selection the initial fitted view is well below zoom 1, so these
  // stay sharp there on 2x screens; only close zooms soften small avatars.
  // Sizes are yt3 =sNN tokens; see sizedAvatarUrl().
  var AVATAR_PIXELS = [88, 176, 240];
  var AVATAR_HOSTS = ["yt3.ggpht.com", "yt3.googleusercontent.com"];

  var SVG_NS = "http://www.w3.org/2000/svg";
  var IMAGE_HOSTS = ["i.ytimg.com", "yt3.ggpht.com", "yt3.googleusercontent.com"];
  var CHANNEL_URL_PREFIX = "https://www.youtube.com/channel/";
  var CHANNEL_ID_RE = /^[A-Za-z0-9_-]{2,64}$/;
  var CHANNEL_KEYS = ["avatar_url", "channel_id", "name", "subscribers", "url", "views", "views_date"];
  // Channel groups of data/channels.json, in page order.
  var GROUPS = ["active", "inactive"];
  var DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
  var PIN_REASONS = ["hover", "focus", "select"];

  /* --- Radius scale and world ------------------------------------------ */

  // Logarithmic subscriber scale with a 1,000-subscriber knee;
  // mirrors channel_aquarium.log_radius().
  function radiusFor(subscribers, maxSubscribers, minRadius, maxRadius) {
    if (subscribers === null || subscribers === undefined || !(maxSubscribers > 0)) {
      return minRadius;
    }
    var weight = Math.log1p(Math.max(0, subscribers) / 1000) / Math.log1p(maxSubscribers / 1000);
    weight = Math.min(1, Math.max(0, weight));
    return minRadius + (maxRadius - minRadius) * weight;
  }

  function maxKnownSubscribers(channels) {
    var max = 0;
    for (var i = 0; i < channels.length; i++) {
      var s = channels[i].subscribers;
      if (typeof s === "number" && s > max) {
        max = s;
      }
    }
    return max;
  }

  function computeRadii(channels, minRadius, maxRadius) {
    var max = maxKnownSubscribers(channels);
    return channels.map(function (channel) {
      return radiusFor(channel.subscribers, max, minRadius, maxRadius);
    });
  }

  // World area from the final radii at the target occupancy and viewport aspect, plus a
  // margin of a few maximum radii so edge avatars have room to drift.
  function worldSize(radii, maxRadius, viewportAspect) {
    var aspect = viewportAspect > 0 && Number.isFinite(viewportAspect) ? viewportAspect : WORLD.aspect;
    var area = 0;
    for (var i = 0; i < radii.length; i++) {
      area += Math.PI * radii[i] * radii[i];
    }
    area /= WORLD.occupancy;
    var width = Math.max(Math.sqrt(area * aspect), 4 * maxRadius);
    var height = Math.max(area / width, 4 * maxRadius);
    var margin = WORLD.marginRadii * maxRadius;
    return {
      width: Math.ceil(width + 2 * margin),
      height: Math.ceil(height + 2 * margin),
      margin: margin
    };
  }

  /* --- Deterministic seeding ------------------------------------------- */

  function hashString(text) {
    var hash = 0x811c9dc5;
    var str = String(text);
    for (var i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  // mulberry32: small, fast, deterministic PRNG returning [0, 1).
  function createRng(seed) {
    var state = seed >>> 0;
    return function () {
      state = (state + 0x6d2b79f5) >>> 0;
      var t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Place nodes (largest first) at seeded positions, preferring spots that do
  // not overlap already placed circles. Mutates and returns nodes.
  function seedPositions(nodes, world, seedText) {
    var rng = createRng(hashString(seedText));
    var order = nodes.slice().sort(function (a, b) {
      return b.radius - a.radius || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
    var placed = [];
    order.forEach(function (node) {
      var best = null;
      var bestClearance = -Infinity;
      var lo = world.margin * 0.5 + node.radius;
      var spanX = Math.max(0, world.width - 2 * lo);
      var spanY = Math.max(0, world.height - 2 * lo);
      for (var attempt = 0; attempt < WORLD.seedAttempts; attempt++) {
        var x = lo + rng() * spanX;
        var y = lo + rng() * spanY;
        var clearance = Infinity;
        for (var j = 0; j < placed.length; j++) {
          var other = placed[j];
          var d = Math.hypot(other.x - x, other.y - y) - other.radius - node.radius - PHYSICS.gap;
          if (d < clearance) {
            clearance = d;
          }
        }
        if (clearance > bestClearance) {
          bestClearance = clearance;
          best = { x: x, y: y };
        }
        if (clearance >= 0) {
          break;
        }
      }
      node.x = best.x;
      node.y = best.y;
      node.vx = 0;
      node.vy = 0;
      node.phase = (hashString(node.id + "|" + seedText) / 4294967296) * Math.PI * 2;
      placed.push(node);
    });
    return nodes;
  }

  function maxOverlap(nodes, gap) {
    var worst = 0;
    for (var i = 0; i < nodes.length; i++) {
      for (var j = i + 1; j < nodes.length; j++) {
        var a = nodes[i];
        var b = nodes[j];
        var overlap = a.radius + b.radius + gap - Math.hypot(a.x - b.x, a.y - b.y);
        if (overlap > worst) {
          worst = overlap;
        }
      }
    }
    return worst;
  }

  /* --- Pinning ---------------------------------------------------------- */

  // A node stays fixed while any reason (hover, focus, select) holds it.
  function pin(node, reason) {
    if (PIN_REASONS.indexOf(reason) < 0) {
      throw new Error("unknown pin reason " + reason);
    }
    node.pins = node.pins || {};
    if (!isPinned(node)) {
      node.fx = node.x;
      node.fy = node.y;
      node.vx = 0;
      node.vy = 0;
    }
    node.pins[reason] = true;
  }

  function unpin(node, reason) {
    if (node.pins) {
      delete node.pins[reason];
    }
    if (!isPinned(node)) {
      node.fx = null;
      node.fy = null;
    }
  }

  function isPinned(node) {
    return Boolean(node.pins) && Object.keys(node.pins).length > 0;
  }

  /* --- Data checks (mirror public_site/validate.py) ---------------------- */

  function isCount(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
  }

  function allowedImageUrl(value) {
    if (typeof value !== "string") {
      return false;
    }
    try {
      var url = new URL(value);
      return url.protocol === "https:" && IMAGE_HOSTS.indexOf(url.hostname) >= 0 && !url.username;
    } catch (err) {
      return false;
    }
  }

  // Problems of one group's channels; prefix names it in the messages.
  function validateGroup(group, name, data, limit, seen) {
    var errors = [];
    var prefix = name + ".";
    if (!group || typeof group !== "object" || Array.isArray(group)) {
      return [name + " is missing"];
    }
    if (!isCount(group.eligible_count)) {
      errors.push(prefix + "eligible_count is invalid");
    }
    var channels = group.channels;
    if (!Array.isArray(channels)) {
      return errors.concat([prefix + "channels is not a list"]);
    }
    if (isCount(limit) && channels.length !== Math.min(limit, group.eligible_count)) {
      errors.push(prefix + "channels length does not match the selection");
    }
    for (var i = 0; i < channels.length; i++) {
      var c = channels[i];
      var where = prefix + "channels[" + i + "]";
      if (!c || typeof c !== "object" || Object.keys(c).sort().join() !== CHANNEL_KEYS.join()) {
        errors.push(where + " has unexpected fields");
        continue;
      }
      if (typeof c.channel_id !== "string" || !CHANNEL_ID_RE.test(c.channel_id)) {
        errors.push(where + " has an invalid channel_id");
        continue;
      }
      if (seen[c.channel_id]) {
        errors.push(where + " duplicates " + c.channel_id);
      }
      seen[c.channel_id] = true;
      if (c.url !== CHANNEL_URL_PREFIX + c.channel_id) {
        errors.push(where + " has an unexpected url");
      }
      if (typeof c.name !== "string" || !c.name.trim()) {
        errors.push(where + " has no name");
      }
      if (c.avatar_url !== null && !allowedImageUrl(c.avatar_url)) {
        errors.push(where + " has a disallowed avatar_url");
      }
      if (!isCount(c.views)) {
        errors.push(where + " views must be a non-negative integer");
      }
      // Active channels are counted on the data date; inactive ones up to it.
      var dateOk = typeof c.views_date === "string" && DATE_RE.test(c.views_date) &&
        (name === "active" ? c.views_date === data.snapshot_date : c.views_date <= data.snapshot_date);
      if (!dateOk) {
        errors.push(where + " has an invalid views_date");
      }
      if (c.subscribers !== null && !isCount(c.subscribers)) {
        errors.push(where + " subscribers must be null or a non-negative integer");
      }
      var prev = i > 0 ? channels[i - 1] : null;
      if (prev && typeof prev === "object" && isCount(prev.views) && isCount(c.views)) {
        if (prev.views < c.views || (prev.views === c.views && prev.channel_id >= c.channel_id)) {
          errors.push(where + " is out of order");
        }
      }
    }
    return errors;
  }

  // Return a list of problems; expected holds the page's group, date, limit
  // and count. Both groups are checked, so a channel can never be in both.
  function validatePayload(data, expected) {
    var errors = [];
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return ["the channel data is not an object"];
    }
    if (data.schema_version !== 2) {
      errors.push("unsupported schema_version");
    }
    if (data.snapshot_date !== expected.date) {
      errors.push("snapshot_date " + data.snapshot_date + " does not match " + expected.date);
    }
    if (GROUPS.indexOf(expected.group) < 0) {
      errors.push("unknown channel group " + expected.group);
    }
    var sel = data.selection;
    if (!sel || typeof sel !== "object") {
      return errors.concat(["selection is missing"]);
    }
    if (sel.limit !== expected.limit || !isCount(sel.limit) || sel.limit < 1) {
      errors.push("selection.limit does not match the page");
    }
    if (!isCount(sel.activity_window_days) || sel.activity_window_days < 1) {
      errors.push("selection.activity_window_days is invalid");
    }
    var seen = {};
    GROUPS.forEach(function (name) {
      errors = errors.concat(validateGroup(data[name], name, data, sel.limit, seen));
    });
    var own = data[expected.group];
    if (own && Array.isArray(own.channels) && own.channels.length !== expected.count) {
      errors.push(expected.group + ".channels length does not match the page");
    }
    return errors;
  }

  // What one scene draws from a validated payload: its group's channels.
  function groupView(data, group) {
    return { snapshot_date: data.snapshot_date, channels: data[group].channels };
  }

  /* --- Avatar sizing (mirrors public_site/images.py) -------------------- */

  // Smallest listed size covering the avatar's diameter at zoom 1.
  function avatarPixels(radius) {
    var needed = Math.ceil(2 * radius);
    for (var i = 0; i < AVATAR_PIXELS.length; i++) {
      if (AVATAR_PIXELS[i] >= needed) {
        return AVATAR_PIXELS[i];
      }
    }
    return AVATAR_PIXELS[AVATAR_PIXELS.length - 1];
  }

  // The same avatar at size x size, never larger than the stored size; null
  // when the URL is not a resizable avatar URL (the caller keeps it as is).
  function sizedAvatarUrl(value, size) {
    if (typeof value !== "string" || /[\s,]/.test(value)) {
      return null;
    }
    var url;
    try {
      url = new URL(value);
    } catch (err) {
      return null;
    }
    if (url.protocol !== "https:" || AVATAR_HOSTS.indexOf(url.hostname) < 0 || url.username ||
        url.search || url.hash) {
      return null;
    }
    var path = url.pathname;
    var cut = path.lastIndexOf("=");
    var m = cut >= 0 ? /^=s(\d{1,4})(?=-|$)/.exec(path.slice(cut)) : null;
    if (!m) {
      return null;
    }
    var stored = Number(m[1]);
    var target = stored > 0 ? Math.min(size, stored) : size;
    url.pathname = path.slice(0, cut) + "=s" + target + path.slice(cut + m[0].length);
    return url.href;
  }

  // Per-channel image URL to load: a smaller variant of a checked avatar URL
  // on the same host, the original when it cannot be resized, null without one.
  function avatarLoadUrls(channels, radii) {
    return channels.map(function (channel, index) {
      if (!channel.avatar_url) {
        return null;
      }
      var sized = sizedAvatarUrl(channel.avatar_url, avatarPixels(radii[index]));
      return sized && allowedImageUrl(sized) ? sized : channel.avatar_url;
    });
  }

  // Whether motion is paused after the reduced-motion preference changes: an
  // explicit Pause/Resume by the visitor wins, otherwise the preference does.
  function pausedForPreference(scene, reduced) {
    return scene.userToggled ? scene.userPaused : Boolean(reduced);
  }

  /* --- Clock, data download and image queue ---------------------------- */

  var realClock = {
    now: function () {
      return Date.now();
    },
    setTimeout: function (fn, ms) {
      return setTimeout(fn, ms);
    },
    clearTimeout: function (id) {
      clearTimeout(id);
    }
  };

  // Fetch JSON with a timeout; rejects on HTTP errors and invalid JSON.
  function fetchJson(url, options) {
    var clock = options.clock || realClock;
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    return new Promise(function (resolve, reject) {
      var finished = false;
      var timer = clock.setTimeout(function () {
        if (finished) {
          return;
        }
        finished = true;
        if (controller) {
          controller.abort();
        }
        reject(new Error("timeout"));
      }, options.timeoutMs);
      function done(fn, value) {
        if (finished) {
          return;
        }
        finished = true;
        clock.clearTimeout(timer);
        fn(value);
      }
      options
        .fetchImpl(url, { signal: controller ? controller.signal : undefined, credentials: "omit" })
        .then(function (response) {
          if (!response.ok) {
            throw new Error("HTTP " + response.status);
          }
          return response.json().catch(function () {
            // Retrying the same hashed URL cannot fix a malformed file.
            var invalid = new Error("invalid JSON");
            invalid.invalidJson = true;
            throw invalid;
          });
        })
        .then(
          function (data) {
            done(resolve, data);
          },
          function (err) {
            done(reject, err);
          }
        );
    });
  }

  /*
   * Preload unique image URLs with bounded concurrency. Every URL settles
   * exactly once, as loaded (load event plus decode) or failed (error, decode
   * rejection, per-URL timeout from its own start, or the overall budget), so
   * the returned promise behaves like Promise.allSettled and never rejects.
   * cancel() clears every timer and silences later callbacks.
   */
  function loadImages(urls, options) {
    var clock = options.clock || realClock;
    var concurrency = options.concurrency || LOADER.imageConcurrency;
    var queue = urls.slice();
    var active = {};
    var activeCount = 0;
    var results = {};
    var settledCount = 0;
    var expired = false;
    var cancelled = false;
    var budgetTimer = null;
    var resolveAll;
    var promise = new Promise(function (resolve) {
      resolveAll = resolve;
    });

    function detach(img, abort) {
      img.onload = null;
      img.onerror = null;
      if (abort) {
        // Stops a download that is no longer wanted.
        img.src = "";
      }
    }

    function settle(url, ok, img) {
      if (cancelled || Object.prototype.hasOwnProperty.call(results, url)) {
        return;
      }
      var entry = active[url];
      if (entry) {
        clock.clearTimeout(entry.timer);
        detach(entry.img, !ok);
        delete active[url];
        activeCount--;
      }
      results[url] = { ok: ok, image: ok ? img : null };
      settledCount++;
      if (options.onSettle) {
        options.onSettle(url, ok);
      }
      if (settledCount === urls.length) {
        clock.clearTimeout(budgetTimer);
        resolveAll(results);
      } else {
        pump();
      }
    }

    function start(url) {
      var img = options.createImage();
      var entry = { img: img, timer: null };
      active[url] = entry;
      activeCount++;
      entry.timer = clock.setTimeout(function () {
        settle(url, false);
      }, options.timeoutMs || LOADER.imageTimeoutMs);
      img.onload = function () {
        if (typeof img.decode === "function") {
          img.decode().then(
            function () {
              settle(url, true, img);
            },
            function () {
              settle(url, false);
            }
          );
        } else {
          settle(url, true, img);
        }
      };
      img.onerror = function () {
        settle(url, false);
      };
      img.decoding = "async";
      img.src = url;
    }

    function pump() {
      while (!expired && !cancelled && activeCount < concurrency && queue.length) {
        start(queue.shift());
      }
    }

    function expire() {
      expired = true;
      Object.keys(active).forEach(function (url) {
        settle(url, false);
      });
      queue.splice(0).forEach(function (url) {
        settle(url, false);
      });
    }

    if (!urls.length) {
      resolveAll(results);
    } else {
      budgetTimer = clock.setTimeout(expire, options.budgetMs || LOADER.imageBudgetMs);
      pump();
    }

    return {
      promise: promise,
      cancel: function () {
        if (cancelled) {
          return;
        }
        cancelled = true;
        clock.clearTimeout(budgetTimer);
        Object.keys(active).forEach(function (url) {
          clock.clearTimeout(active[url].timer);
          detach(active[url].img, true);
        });
        active = {};
        queue = [];
      }
    };
  }

  // Track per-channel preparation: duplicate URLs load once and count for
  // every channel using them; null avatars count at once (fallback ready).
  // options.urls optionally holds the URL to load per channel (same order).
  function prepareChannels(channels, options) {
    var byUrl = {};
    var urls = [];
    var prepared = 0;
    var total = channels.length;
    channels.forEach(function (channel, index) {
      var url = options.urls ? options.urls[index] : channel.avatar_url;
      if (!url) {
        prepared++;
        return;
      }
      if (!byUrl[url]) {
        byUrl[url] = 0;
        urls.push(url);
      }
      byUrl[url]++;
    });
    if (options.onProgress) {
      options.onProgress(prepared, total);
    }
    var loader = loadImages(urls, {
      clock: options.clock,
      concurrency: options.concurrency,
      timeoutMs: options.timeoutMs,
      budgetMs: options.budgetMs,
      createImage: options.createImage,
      onSettle: function (url) {
        prepared += byUrl[url];
        if (options.onProgress) {
          options.onProgress(prepared, total);
        }
      }
    });
    return {
      urls: urls,
      promise: loader.promise.then(function (results) {
        return { images: results, prepared: prepared, total: total };
      }),
      cancel: loader.cancel
    };
  }

  // How a failed data download is recovered: a malformed file needs a fresh
  // page ("invalid"), anything else can simply be downloaded again.
  function loadErrorKind(err) {
    return err && err.invalidJson ? "invalid" : "network";
  }

  /*
   * Run onData on the downloaded payload and guarantee that every failure
   * reaches onFail(kind) instead of becoming an unhandled rejection: "invalid"
   * and "network" for download failures (see loadErrorKind), "code" for any
   * exception thrown while handling the data. The returned promise never
   * rejects.
   */
  function settleDataLoad(download, onData, onFail) {
    var failedDownload = false;
    return download
      .then(
        function (data) {
          return onData(data);
        },
        function (err) {
          failedDownload = true;
          onFail(loadErrorKind(err), err);
        }
      )
      .catch(function (err) {
        if (!failedDownload) {
          onFail("code", err);
        }
      });
  }

  /*
   * One download per data URL shared by every stage on the page. get() starts
   * it on first use; a rejected download is forgotten so the next start()
   * fetches again, and drop() forgets a download explicitly (Try again).
   */
  function sharedDownloads() {
    var cache = {};
    function drop(url, promise) {
      if (cache[url] === promise) {
        delete cache[url];
      }
    }
    return {
      get: function (url, startDownload) {
        if (!cache[url]) {
          var promise = startDownload();
          cache[url] = promise;
          promise.then(null, function () {
            drop(url, promise);
          });
        }
        return cache[url];
      },
      drop: drop
    };
  }

  // Whether Escape acts on a scene: always when the key event comes from its
  // own stage, never when it comes from another aquarium stage, and otherwise
  // (focus elsewhere on the page) only when the scene shows a tooltip or panel.
  function escapeApplies(ownStage, otherStage, showsDetail) {
    if (ownStage) {
      return true;
    }
    if (otherStage) {
      return false;
    }
    return showsDetail;
  }

  /* --- Formatting and layout helpers ----------------------------------- */

  function fmtNum(value) {
    return typeof value === "number" ? value.toLocaleString("en-US") : "-";
  }

  function initials(name) {
    var words = String(name).trim().split(/\s+/).filter(Boolean);
    var text = words
      .slice(0, 2)
      .map(function (word) {
        return Array.from(word)[0];
      })
      .join("");
    return text.toUpperCase() || "?";
  }

  function describe(channel) {
    var subs =
      channel.subscribers === null
        ? "subscribers unavailable"
        : fmtNum(channel.subscribers) + " subscribers";
    return channel.name + ": " + subs + ", " + fmtNum(channel.views) + " total views";
  }

  // Place a box of size next to a circle (screen units), inside bounds and
  // clear of the circle whenever there is room on any side.
  function placeTooltip(anchor, size, bounds, gap) {
    var pad = 8;
    var reach = anchor.r + gap;
    var candidates = [
      { left: anchor.x + reach, top: anchor.y - size.h / 2 },
      { left: anchor.x - reach - size.w, top: anchor.y - size.h / 2 },
      { left: anchor.x - size.w / 2, top: anchor.y + reach },
      { left: anchor.x - size.w / 2, top: anchor.y - reach - size.h }
    ];
    function clamp(pos) {
      return {
        left: Math.max(pad, Math.min(pos.left, bounds.w - size.w - pad)),
        top: Math.max(pad, Math.min(pos.top, bounds.h - size.h - pad))
      };
    }
    function clear(pos) {
      var nx = Math.max(pos.left, Math.min(anchor.x, pos.left + size.w));
      var ny = Math.max(pos.top, Math.min(anchor.y, pos.top + size.h));
      return Math.hypot(nx - anchor.x, ny - anchor.y) >= anchor.r;
    }
    for (var i = 0; i < candidates.length; i++) {
      var pos = clamp(candidates[i]);
      if (clear(pos)) {
        return pos;
      }
    }
    return clamp(candidates[0]);
  }

  function fitTransform(world, view) {
    var k = Math.min(view.width / world.width, view.height / world.height);
    return {
      k: k,
      x: (view.width - world.width * k) / 2,
      y: (view.height - world.height * k) / 2
    };
  }

  // Every screen starts with all selected channels in view.
  function initialTransform(world, view) {
    return fitTransform(world, view);
  }

  function flowAngle(x, y, t, phase) {
    return (
      phase +
      1.3 * Math.sin(x * 0.0021 + t * 0.11) +
      1.1 * Math.cos(y * 0.0027 - t * 0.07) +
      0.6 * Math.sin((x + y) * 0.0013 + t * 0.05 + phase)
    );
  }

  /* --- Input classification ------------------------------------------- */

  // Hover details follow mouse and pen pointers; touch uses tap selection.
  function hoverPointer(pointerType) {
    return pointerType !== "touch";
  }

  // Whether a click on an avatar came from a touch tap (select, do not
  // navigate). Keyboard activation (detail 0) always navigates. Browsers that
  // expose pointerType on click are trusted; otherwise the last pointerdown
  // decides, but only if it happened just before.
  function clickIsTouch(click, lastPointer, now) {
    if (!click.detail) {
      return false;
    }
    if (typeof click.pointerType === "string" && click.pointerType) {
      return click.pointerType === "touch";
    }
    return Boolean(lastPointer) && lastPointer.type === "touch" && now - lastPointer.time < 1000;
  }

  // Focus pins and shows details only when it comes from the keyboard, so a
  // mouse click that focuses the link does not leave a pinned tooltip behind.
  function keyboardFocus(el) {
    try {
      return el.matches(":focus-visible");
    } catch (err) {
      return true;
    }
  }

  // What the detail box shows: the touch selection as a panel, otherwise the
  // hover/focus target as a tooltip unless Escape dismissed it. Dismissing
  // only hides content; pins are untouched.
  function detailTarget(state) {
    if (state.selected) {
      return { mode: "panel", node: state.selected };
    }
    if (state.tooltip && state.tooltip !== state.dismissed) {
      return { mode: "tooltip", node: state.tooltip };
    }
    return { mode: "none", node: null };
  }

  /* --- Simulation (d3-force) -------------------------------------------- */

  // The collision body is exactly the drawn avatar radius plus a small gap.
  function collisionRadius(node) {
    return node.radius + PHYSICS.gap;
  }

  // Simulation for the initial packing: strong collisions, no current. It is
  // driven manually with tick(), never by D3's own timer.
  function createSimulation(d3, nodes, world, seedText) {
    return d3
      .forceSimulation(nodes)
      .stop()
      .randomSource(createRng(hashString(seedText)))
      .alpha(1)
      .alphaMin(0)
      .alphaDecay(0)
      .velocityDecay(0.4)
      .force("collide", d3.forceCollide(collisionRadius).strength(1).iterations(3))
      .force("bounds", boundsForce(world));
  }

  // Switch a packed simulation to the continuous drift. None of these forces
  // depends on alpha, so the simulation never cools down to a stop.
  function startMotion(d3, sim, world, minRadius, simTimeMs) {
    sim.nodes().forEach(function (node) {
      node.vx = 0;
      node.vy = 0;
    });
    // Re-added in order: the hard world clamp in bounds must run last.
    return sim
      .force("collide", null)
      .force("bounds", null)
      .velocityDecay(PHYSICS.velocityDecay)
      .force(
        "collide",
        d3
          .forceCollide(collisionRadius)
          .strength(PHYSICS.collideStrength)
          .iterations(PHYSICS.collideIterations)
      )
      .force("current", currentForce(minRadius, simTimeMs))
      .force("limit", limitForce())
      .force("bounds", boundsForce(world));
  }

  function currentForce(minRadius, simTimeMs) {
    var list;
    function force() {
      var t = simTimeMs() / 1000;
      for (var i = 0; i < list.length; i++) {
        var n = list[i];
        if (n.fx !== null && n.fx !== undefined) {
          continue;
        }
        var angle = flowAngle(n.x, n.y, t, n.phase);
        // Larger avatars drift slightly more slowly.
        var speed = PHYSICS.drift * Math.sqrt(minRadius / n.radius);
        n.vx += (Math.cos(angle) * speed - n.vx) * PHYSICS.steer;
        n.vy += (Math.sin(angle) * speed - n.vy) * PHYSICS.steer;
      }
    }
    force.initialize = function (ns) {
      list = ns;
    };
    return force;
  }

  // Soft walls near the world edge plus a hard clamp at the edge itself.
  function boundsForce(w) {
    var list;
    var soft = w.margin * 0.5;
    function force() {
      for (var i = 0; i < list.length; i++) {
        var n = list[i];
        var minX = soft + n.radius;
        var maxX = w.width - soft - n.radius;
        var minY = soft + n.radius;
        var maxY = w.height - soft - n.radius;
        if (n.x < minX) {
          n.vx += (minX - n.x) * PHYSICS.wallStrength;
        } else if (n.x > maxX) {
          n.vx += (maxX - n.x) * PHYSICS.wallStrength;
        }
        if (n.y < minY) {
          n.vy += (minY - n.y) * PHYSICS.wallStrength;
        } else if (n.y > maxY) {
          n.vy += (maxY - n.y) * PHYSICS.wallStrength;
        }
        var nx = n.x + n.vx;
        var ny = n.y + n.vy;
        if (nx < n.radius || nx > w.width - n.radius) {
          n.vx = Math.max(n.radius, Math.min(w.width - n.radius, nx)) - n.x;
        }
        if (ny < n.radius || ny > w.height - n.radius) {
          n.vy = Math.max(n.radius, Math.min(w.height - n.radius, ny)) - n.y;
        }
      }
    }
    force.initialize = function (ns) {
      list = ns;
    };
    return force;
  }

  // Cap acceleration and speed so collisions never look like bouncing.
  function limitForce() {
    var list;
    function force() {
      for (var i = 0; i < list.length; i++) {
        var n = list[i];
        var px = n.pvx || 0;
        var py = n.pvy || 0;
        var ax = n.vx - px;
        var ay = n.vy - py;
        var accel = Math.hypot(ax, ay);
        if (accel > PHYSICS.maxAccel) {
          n.vx = px + (ax / accel) * PHYSICS.maxAccel;
          n.vy = py + (ay / accel) * PHYSICS.maxAccel;
        }
        var speed = Math.hypot(n.vx, n.vy);
        if (speed > PHYSICS.maxSpeed) {
          n.vx = (n.vx / speed) * PHYSICS.maxSpeed;
          n.vy = (n.vy / speed) * PHYSICS.maxSpeed;
        }
        n.pvx = n.vx;
        n.pvy = n.vy;
      }
    }
    force.initialize = function (ns) {
      list = ns;
    };
    return force;
  }

  /* --- Browser controller ---------------------------------------------- */

  // Start one controller per aquarium stage on the page.
  function boot(win) {
    var stages = win.document.querySelectorAll(".aquarium-stage[data-group]");
    var downloads = sharedDownloads();
    for (var i = 0; i < stages.length; i++) {
      bootStage(win, stages[i], downloads);
    }
  }

  function bootStage(win, stage, downloads) {
    var doc = win.document;
    stage.setAttribute("data-js", "");

    function part(role) {
      return stage.querySelector('[data-role="' + role + '"]');
    }

    var ui = {
      viewport: part("viewport"),
      controls: part("controls"),
      detail: part("detail"),
      detailActions: part("detail-actions"),
      loader: part("loader"),
      spinner: part("spinner"),
      loaderText: part("loader-text"),
      progress: part("progress"),
      error: part("error"),
      errorText: stage.querySelector('[data-field="error-text"]'),
      empty: part("empty"),
      status: part("status"),
      pause: stage.querySelector('[data-action="pause"]'),
      retry: stage.querySelector('[data-action="retry"]')
    };
    var group = stage.getAttribute("data-group");
    var expected = {
      group: group,
      date: stage.getAttribute("data-snapshot-date"),
      limit: Number(stage.getAttribute("data-limit")),
      count: Number(stage.getAttribute("data-count"))
    };
    var minRadius = Number(stage.getAttribute("data-min-radius"));
    var maxRadius = Number(stage.getAttribute("data-max-radius"));
    var dataSrc = stage.getAttribute("data-channels-src");
    var motionQuery = win.matchMedia ? win.matchMedia("(prefers-reduced-motion: reduce)") : null;

    var generation = 0;
    var loader = null;
    var scene = null;
    var hidden = doc.hidden;
    var inView = true;
    var lastAnnounced = -1;

    function reducedMotion() {
      return Boolean(motionQuery && motionQuery.matches);
    }

    /* State machine: loading-data -> loading-images -> preparing-scene ->
       ready, or error / empty. */
    function setState(state, message, reloadAction) {
      stage.setAttribute("data-state", state);
      var busy = state === "loading-data" || state === "loading-images" || state === "preparing-scene";
      stage.setAttribute("aria-busy", busy ? "true" : "false");
      ui.loader.hidden = state === "ready";
      ui.viewport.hidden = state !== "ready";
      ui.controls.hidden = state !== "ready";
      ui.spinner.hidden = !busy;
      ui.loaderText.hidden = !busy;
      ui.progress.hidden = state !== "loading-images" && state !== "preparing-scene";
      ui.error.hidden = state !== "error";
      ui.empty.hidden = state !== "empty";
      if (state === "error") {
        ui.errorText.textContent = message;
        // A stale page cannot recover by downloading the data again.
        ui.retry.setAttribute("data-action", reloadAction ? "reload" : "retry");
        ui.retry.textContent = reloadAction ? "Reload page" : "Try again";
      }
      if (state !== "ready") {
        hideDetail();
      }
    }

    function announce(text) {
      ui.status.textContent = text;
    }

    function fail(gen, message, reloadAction) {
      if (gen !== generation) {
        return;
      }
      teardown();
      setState("error", message, reloadAction);
      announce(message);
    }

    function onProgress(prepared, total) {
      ui.progress.max = Math.max(1, total);
      ui.progress.value = prepared;
      ui.loaderText.textContent = "Loading channels… " + prepared + " / " + total;
      // Announce phase quarters, not every channel.
      var quarter = total ? Math.floor((prepared / total) * 4) : 4;
      if (quarter !== lastAnnounced && quarter < 4) {
        lastAnnounced = quarter;
        announce("Loading channels: " + prepared + " of " + total + " prepared");
      }
    }

    function teardown() {
      if (loader) {
        loader.cancel();
        loader = null;
      }
      if (scene) {
        scene.destroy();
        scene = null;
      }
      // Drop anything a failed scene creation may have left behind.
      while (ui.viewport.firstChild) {
        ui.viewport.removeChild(ui.viewport.firstChild);
      }
    }

    // The shared download this stage last used, dropped by Try again.
    var lastDownload = null;

    function start() {
      generation++;
      var gen = generation;
      teardown();
      lastAnnounced = -1;
      setState("loading-data");
      ui.loaderText.textContent = "Loading channels…";
      announce("Loading channel data");

      var d3 = win.d3;
      if (!d3 || typeof d3.forceSimulation !== "function" || typeof d3.zoom !== "function") {
        fail(gen, "The animation library did not load. Check your connection and try again.");
        return;
      }
      if (typeof win.fetch !== "function") {
        fail(gen, "This browser cannot load the channels.");
        return;
      }
      var download = downloads.get(dataSrc, function () {
        return fetchJson(dataSrc, {
          timeoutMs: LOADER.dataTimeoutMs,
          fetchImpl: win.fetch.bind(win)
        });
      });
      lastDownload = download;
      settleDataLoad(
        download,
        function (data) {
          if (gen !== generation) {
            return;
          }
          if (validatePayload(data, expected).length) {
            failWith(gen, "invalid");
            return;
          }
          var view = groupView(data, group);
          if (!view.channels.length) {
            setState("empty");
            announce(ui.empty.textContent);
            return;
          }
          loadAvatars(gen, view);
        },
        function (kind) {
          failWith(gen, kind);
        }
      );
    }

    var FAILURES = {
      invalid: [
        "The channel data does not match this page. Reload the page to get the latest version.",
        true
      ],
      network: ["The channel data could not be loaded.", false],
      code: ["The channel view could not be prepared.", false]
    };

    function failWith(gen, kind) {
      var failure = FAILURES[kind] || FAILURES.code;
      fail(gen, failure[0], failure[1]);
    }

    function loadAvatars(gen, data) {
      setState("loading-images");
      announce("Loading " + data.channels.length + " channel avatars");
      var radii = computeRadii(data.channels, minRadius, maxRadius);
      var urls = avatarLoadUrls(data.channels, radii);
      loader = prepareChannels(data.channels, {
        urls: urls,
        createImage: function () {
          return new win.Image();
        },
        onProgress: function (prepared, total) {
          if (gen === generation) {
            onProgress(prepared, total);
          }
        }
      });
      loader.promise.then(function (outcome) {
        if (gen !== generation) {
          return;
        }
        loader = null;
        setState("preparing-scene");
        ui.loaderText.textContent = "Preparing channels…";
        announce("Preparing channels");
        scene = createScene(gen, data, outcome.images, urls);
      })
        .catch(function () {
          failWith(gen, "code");
        });
    }

    /* --- Scene -------------------------------------------------------- */

    function createScene(gen, data, images, imageUrls) {
      var d3 = win.d3;
      var channels = data.channels;
      var radii = computeRadii(channels, minRadius, maxRadius);
      var nodes = channels.map(function (channel, index) {
        return {
          id: channel.channel_id,
          channel: channel,
          radius: radii[index],
          index: index,
          imageUrl: imageUrls[index]
        };
      });
      var world = worldSize(radii, maxRadius, stage.clientWidth / stage.clientHeight);
      seedPositions(nodes, world, data.snapshot_date);

      var svg = doc.createElementNS(SVG_NS, "svg");
      svg.setAttribute("class", "aquarium-svg");
      svg.setAttribute("role", "group");
      svg.setAttribute("aria-label", group === "inactive"
        ? "Inactive Nightcore channels: " + nodes.length + " channels"
        : "Active Nightcore channels: " + nodes.length + " channels");
      // Tab goes straight to the avatar links, not to the drawing itself.
      svg.setAttribute("tabindex", "-1");
      var defs = doc.createElementNS(SVG_NS, "defs");
      var clip = doc.createElementNS(SVG_NS, "clipPath");
      // One clip per stage: element IDs must stay unique with two scenes.
      var clipId = stage.id + "-clip";
      clip.setAttribute("id", clipId);
      clip.setAttribute("clipPathUnits", "objectBoundingBox");
      var clipCircle = doc.createElementNS(SVG_NS, "circle");
      clipCircle.setAttribute("cx", "0.5");
      clipCircle.setAttribute("cy", "0.5");
      clipCircle.setAttribute("r", "0.5");
      clip.appendChild(clipCircle);
      defs.appendChild(clip);
      svg.appendChild(defs);

      var layer = doc.createElementNS(SVG_NS, "g");
      layer.setAttribute("class", "aquarium-layer");
      var bounds = doc.createElementNS(SVG_NS, "rect");
      bounds.setAttribute("class", "aquarium-world");
      bounds.setAttribute("width", world.width);
      bounds.setAttribute("height", world.height);
      bounds.setAttribute("rx", maxRadius);
      layer.appendChild(bounds);
      nodes.forEach(function (node) {
        node.el = buildNode(node, images);
        layer.appendChild(node.el);
      });
      svg.appendChild(layer);

      var sim = createSimulation(d3, nodes, world, data.snapshot_date);
      ui.viewport.appendChild(svg);

      var self = {
        nodes: nodes,
        world: world,
        sim: sim,
        svg: svg,
        layer: layer,
        simTime: 0,
        userPaused: reducedMotion(),
        userToggled: false,
        ready: false,
        raf: 0,
        lastTs: 0,
        acc: 0,
        timers: [],
        transform: d3.zoomIdentity,
        zoom: null,
        hovered: null,
        focused: null,
        recent: null,
        dismissed: null,
        selected: null,
        destroy: destroy
      };

      // Initial packing, in chunks so the loader stays responsive.
      var ticks = 0;
      function packChunk() {
        if (gen !== generation) {
          return;
        }
        try {
          for (var i = 0; i < PHYSICS.packChunk && ticks < PHYSICS.packTicks; i++, ticks++) {
            sim.tick();
          }
          if (ticks < PHYSICS.packTicks && maxOverlap(nodes, 0) > 0.5) {
            self.timers.push(win.setTimeout(packChunk, 0));
            return;
          }
          reveal();
        } catch (err) {
          fail(gen, "The channel view could not be prepared.");
        }
      }
      self.timers.push(win.setTimeout(packChunk, 0));

      function reveal() {
        startMotion(d3, sim, world, minRadius, function () {
          return self.simTime;
        });
        paint();
        setupCamera();
        setupInteraction();
        self.ready = true;
        setState("ready");
        announce("Channels ready: " + nodes.length + " channels");
        updatePauseButton();
        updateRunning();
      }

      function buildNode(node, imageResults) {
        var c = node.channel;
        var r = node.radius.toFixed(2);
        var a = doc.createElementNS(SVG_NS, "a");
        a.setAttribute("class", "aquarium-node");
        a.setAttribute("href", c.url);
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
        a.setAttribute("aria-label", describe(c) + ". Opens YouTube in a new tab.");
        var fallback = doc.createElementNS(SVG_NS, "circle");
        fallback.setAttribute("class", "aquarium-fallback");
        fallback.setAttribute("r", r);
        a.appendChild(fallback);
        var text = doc.createElementNS(SVG_NS, "text");
        text.setAttribute("class", "aquarium-initials");
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("dy", "0.35em");
        text.setAttribute("font-size", (node.radius * 0.72).toFixed(1));
        text.textContent = initials(c.name);
        a.appendChild(text);
        var src = node.imageUrl;
        var loaded = src && imageResults[src] && imageResults[src].ok;
        if (loaded) {
          var image = doc.createElementNS(SVG_NS, "image");
          image.setAttribute("class", "aquarium-avatar");
          image.setAttribute("x", (-node.radius).toFixed(2));
          image.setAttribute("y", (-node.radius).toFixed(2));
          image.setAttribute("width", (node.radius * 2).toFixed(2));
          image.setAttribute("height", (node.radius * 2).toFixed(2));
          image.setAttribute("preserveAspectRatio", "xMidYMid slice");
          image.setAttribute("clip-path", "url(#" + clipId + ")");
          image.addEventListener("error", function () {
            // Keep the initials fallback if the image fails after mounting.
            if (image.parentNode) {
              image.parentNode.removeChild(image);
            }
          });
          image.setAttribute("href", src);
          a.appendChild(image);
        }
        var ring = doc.createElementNS(SVG_NS, "circle");
        ring.setAttribute("class", "aquarium-ring");
        ring.setAttribute("r", r);
        a.appendChild(ring);
        a.__node = node;
        return a;
      }

      /* Painting and the single animation loop. */

      function paint() {
        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          var x = Math.round(n.x * 10) / 10;
          var y = Math.round(n.y * 10) / 10;
          if (x !== n.px || y !== n.py) {
            n.px = x;
            n.py = y;
            n.el.setAttribute("transform", "translate(" + x + "," + y + ")");
          }
        }
        if (tooltipNode()) {
          positionTooltip();
        }
      }

      function running() {
        return self.ready && !self.userPaused && !hidden && inView;
      }

      function frame(ts) {
        self.raf = 0;
        if (!running()) {
          return;
        }
        // Clamp elapsed time so a stalled frame never integrates a jump.
        var dt = self.lastTs ? Math.min(ts - self.lastTs, 100) : PHYSICS.stepMs;
        self.lastTs = ts;
        self.acc += dt;
        var steps = 0;
        while (self.acc >= PHYSICS.stepMs && steps < PHYSICS.maxStepsPerFrame) {
          self.simTime += PHYSICS.stepMs;
          sim.tick();
          self.acc -= PHYSICS.stepMs;
          steps++;
        }
        if (steps === PHYSICS.maxStepsPerFrame) {
          self.acc = 0;
        }
        paint();
        self.raf = win.requestAnimationFrame(frame);
      }

      function updateRunning() {
        if (running()) {
          if (!self.raf) {
            self.lastTs = 0;
            self.acc = 0;
            self.raf = win.requestAnimationFrame(frame);
          }
        } else if (self.raf) {
          win.cancelAnimationFrame(self.raf);
          self.raf = 0;
        }
      }
      self.updateRunning = updateRunning;

      function updatePauseButton() {
        ui.pause.textContent = self.userPaused ? "Resume" : "Pause";
        ui.pause.setAttribute("aria-pressed", self.userPaused ? "true" : "false");
      }

      /* Camera. */

      function viewSize() {
        return { width: stage.clientWidth || 1, height: stage.clientHeight || 1 };
      }

      function setupCamera() {
        var zoom = d3
          .zoom()
          .clickDistance(CAMERA.clickDistance)
          .filter(function (event) {
            // Plain wheel scrolls the page; Ctrl/Cmd + wheel (and trackpad
            // pinch, which sets ctrlKey) zooms the aquarium.
            if (event.type === "wheel") {
              return event.ctrlKey || event.metaKey;
            }
            if (event.type === "dblclick") {
              return false;
            }
            return !event.button;
          })
          .on("zoom", function (event) {
            self.transform = event.transform;
            layer.setAttribute("transform", event.transform.toString());
            if (tooltipNode()) {
              positionTooltip();
            }
          });
        self.zoom = zoom;
        applyExtents();
        var start = initialTransform(world, viewSize());
        d3.select(svg).call(zoom);
        d3.select(svg).call(zoom.transform, d3.zoomIdentity.translate(start.x, start.y).scale(start.k));
      }

      function applyExtents() {
        var view = viewSize();
        var fit = fitTransform(world, view);
        var pad = world.margin;
        self.zoom
          .extent([
            [0, 0],
            [view.width, view.height]
          ])
          .scaleExtent([
            fit.k * CAMERA.minZoomOfFit,
            Math.max(CAMERA.maxZoom, fit.k)
          ])
          .translateExtent([
            [-pad, -pad],
            [world.width + pad, world.height + pad]
          ]);
      }

      function resize() {
        if (!self.zoom) {
          return;
        }
        applyExtents();
        // Refit automatically when the viewport changes (including rotation).
        fitAll();
        if (self.selected) {
          showPanel(self.selected);
        }
      }
      self.resize = resize;

      function zoomBy(factor) {
        d3.select(svg).call(self.zoom.scaleBy, factor);
      }

      function fitAll() {
        var t = fitTransform(world, viewSize());
        d3.select(svg).call(self.zoom.transform, d3.zoomIdentity.translate(t.x, t.y).scale(t.k));
      }

      function ensureVisible(node) {
        var t = self.transform;
        var view = viewSize();
        var x = t.applyX(node.x);
        var y = t.applyY(node.y);
        var r = node.radius * t.k;
        if (x - r < 0 || y - r < 0 || x + r > view.width || y + r > view.height) {
          d3.select(svg).call(self.zoom.translateTo, node.x, node.y);
        }
      }

      /* Details: hover/focus tooltip, or a docked panel for touch selection. */

      function screenAnchor(node) {
        var t = self.transform;
        return { x: t.applyX(node.x), y: t.applyY(node.y), r: node.radius * t.k };
      }

      function fillDetail(node) {
        var c = node.channel;
        ui.detail.querySelector('[data-field="name"]').textContent = c.name;
        ui.detail.querySelector('[data-field="subscribers"]').textContent =
          c.subscribers === null ? "Subscribers unavailable" : fmtNum(c.subscribers);
        ui.detail.querySelector('[data-field="views"]').textContent = fmtNum(c.views);
        ui.detail.querySelector('[data-field="link"]').setAttribute("href", c.url);
      }

      // The most recent hover or focus wins while it lasts, so a mouse resting
      // over the scene does not hide the details of a keyboard-focused avatar.
      function tooltipNode() {
        var recent = self.recent;
        if (recent && (recent === self.hovered || recent === self.focused)) {
          return recent;
        }
        return self.hovered || self.focused;
      }

      function currentDetail() {
        return detailTarget({
          selected: self.selected,
          tooltip: tooltipNode(),
          dismissed: self.dismissed
        });
      }

      function positionTooltip() {
        var target = currentDetail();
        if (target.mode !== "tooltip") {
          return;
        }
        var node = target.node;
        var view = viewSize();
        var size = { w: ui.detail.offsetWidth, h: ui.detail.offsetHeight };
        var pos = placeTooltip(screenAnchor(node), size, { w: view.width, h: view.height }, 10);
        ui.detail.style.left = Math.round(pos.left) + "px";
        ui.detail.style.top = Math.round(pos.top) + "px";
      }

      function showTooltip(node) {
        if (self.selected) {
          return;
        }
        fillDetail(node);
        ui.detail.className = "aquarium-detail aquarium-detail--tooltip";
        ui.detailActions.hidden = true;
        ui.detail.hidden = false;
        positionTooltip();
      }

      function showPanel(node) {
        fillDetail(node);
        var anchor = screenAnchor(node);
        var low = anchor.y > viewSize().height / 2;
        ui.detail.className =
          "aquarium-detail aquarium-detail--panel " +
          (low ? "aquarium-detail--top" : "aquarium-detail--bottom");
        ui.detail.style.left = "";
        ui.detail.style.top = "";
        ui.detailActions.hidden = false;
        ui.detail.hidden = false;
      }

      function refreshDetail() {
        var target = currentDetail();
        if (target.mode === "panel") {
          showPanel(target.node);
        } else if (target.mode === "tooltip") {
          showTooltip(target.node);
        } else {
          hideDetail();
        }
      }

      // Escape closes the selection panel, or dismisses the current tooltip
      // until the next hover or focus change.
      function escape() {
        if (self.selected) {
          deselect();
        } else if (tooltipNode()) {
          self.dismissed = tooltipNode();
          refreshDetail();
        }
      }

      function setHighlight(node, on) {
        if (node && node.el) {
          node.el.classList.toggle("is-active", on);
        }
      }

      function select(node) {
        if (self.selected && self.selected !== node) {
          deselect();
        }
        self.selected = node;
        pin(node, "select");
        setHighlight(node, true);
        refreshDetail();
      }

      function deselect() {
        var node = self.selected;
        if (!node) {
          return;
        }
        self.selected = null;
        unpin(node, "select");
        setHighlight(node, isPinned(node));
        refreshDetail();
      }

      function nodeFrom(target) {
        var el = target && target.closest ? target.closest(".aquarium-node") : null;
        return el ? el.__node : null;
      }

      function setupInteraction() {
        svg.addEventListener("pointerover", function (event) {
          var node = nodeFrom(event.target);
          if (!node || !hoverPointer(event.pointerType) || self.hovered === node) {
            return;
          }
          if (self.hovered) {
            unpin(self.hovered, "hover");
            setHighlight(self.hovered, isPinned(self.hovered));
          }
          self.hovered = node;
          self.recent = node;
          self.dismissed = null;
          pin(node, "hover");
          setHighlight(node, true);
          refreshDetail();
        });
        svg.addEventListener("pointerout", function (event) {
          var node = nodeFrom(event.target);
          if (!node || node !== self.hovered || nodeFrom(event.relatedTarget) === node) {
            return;
          }
          self.hovered = null;
          unpin(node, "hover");
          setHighlight(node, isPinned(node));
          refreshDetail();
        });
        svg.addEventListener("focusin", function (event) {
          var node = nodeFrom(event.target);
          if (!node || !keyboardFocus(event.target.closest(".aquarium-node"))) {
            return;
          }
          self.focused = node;
          self.recent = node;
          self.dismissed = null;
          pin(node, "focus");
          setHighlight(node, true);
          ensureVisible(node);
          refreshDetail();
        });
        svg.addEventListener("focusout", function (event) {
          var node = nodeFrom(event.target);
          if (!node || node !== self.focused) {
            return;
          }
          self.focused = null;
          unpin(node, "focus");
          setHighlight(node, isPinned(node));
          refreshDetail();
        });
        svg.addEventListener("click", function (event) {
          var node = nodeFrom(event.target);
          var touch = clickIsTouch(event, lastPointer, Date.now());
          lastPointer = null;
          if (!node) {
            // Background click or tap (drags never produce clicks).
            deselect();
            return;
          }
          if (touch) {
            // The first tap selects; the panel's link navigates explicitly.
            event.preventDefault();
            select(node);
          }
        });
      }

      function destroy() {
        self.ready = false;
        self.timers.forEach(function (id) {
          win.clearTimeout(id);
        });
        if (self.raf) {
          win.cancelAnimationFrame(self.raf);
          self.raf = 0;
        }
        sim.stop();
        sim.on("tick", null);
        if (svg.parentNode) {
          svg.parentNode.removeChild(svg);
        }
        hideDetail();
      }

      self.togglePause = function () {
        self.userPaused = !self.userPaused;
        self.userToggled = true;
        updatePauseButton();
        updateRunning();
      };
      self.followMotionPreference = function (reduced) {
        self.userPaused = pausedForPreference(self, reduced);
        updatePauseButton();
        updateRunning();
      };
      self.zoomBy = zoomBy;
      self.fitAll = fitAll;
      self.deselect = deselect;
      self.escape = escape;
      self.showsDetail = function () {
        return currentDetail().mode !== "none";
      };
      return self;
    }

    function hideDetail() {
      ui.detail.hidden = true;
    }

    /* Listeners registered once; they act on whichever scene is current. */

    // Fallback for browsers whose click events carry no pointerType.
    var lastPointer = null;
    stage.addEventListener("pointerdown", function (event) {
      lastPointer = { type: event.pointerType || "mouse", time: Date.now() };
    });
    // On the document so a hover tooltip can be dismissed wherever focus is.
    doc.addEventListener("keydown", function (event) {
      if (event.target && stage.contains(event.target)) {
        lastPointer = null;
      }
      if (event.key === "Escape" && scene && scene.ready) {
        var owner = event.target && event.target.closest ? event.target.closest(".aquarium-stage") : null;
        if (escapeApplies(owner === stage, Boolean(owner) && owner !== stage, scene.showsDetail())) {
          scene.escape();
        }
      }
    });

    stage.addEventListener("click", function (event) {
      var button = event.target.closest ? event.target.closest("[data-action]") : null;
      if (!button) {
        return;
      }
      var action = button.getAttribute("data-action");
      if (action === "retry") {
        downloads.drop(dataSrc, lastDownload);
        start();
        return;
      }
      if (action === "reload") {
        win.location.reload();
        return;
      }
      if (!scene || !scene.ready) {
        return;
      }
      if (action === "pause") {
        scene.togglePause();
      } else if (action === "zoom-in") {
        scene.zoomBy(CAMERA.zoomStep);
      } else if (action === "zoom-out") {
        scene.zoomBy(1 / CAMERA.zoomStep);
      } else if (action === "fit") {
        scene.fitAll();
      } else if (action === "close") {
        scene.deselect();
      }
    });

    // Focusing an avatar must move the camera, not scroll the stage box.
    [stage, ui.viewport].forEach(function (el) {
      el.addEventListener("scroll", function () {
        el.scrollTop = 0;
        el.scrollLeft = 0;
      });
    });

    // Follow a reduced-motion change made while the page is open.
    if (motionQuery) {
      var onMotionChange = function () {
        if (scene && scene.ready) {
          scene.followMotionPreference(reducedMotion());
        }
      };
      if (typeof motionQuery.addEventListener === "function") {
        motionQuery.addEventListener("change", onMotionChange);
      } else if (typeof motionQuery.addListener === "function") {
        motionQuery.addListener(onMotionChange);
      }
    }

    doc.addEventListener("visibilitychange", function () {
      hidden = doc.hidden;
      if (scene && scene.ready) {
        scene.updateRunning();
      }
    });

    if (typeof win.IntersectionObserver === "function") {
      new win.IntersectionObserver(function (entries) {
        inView = entries[entries.length - 1].isIntersecting;
        if (scene && scene.ready) {
          scene.updateRunning();
        }
      }).observe(stage);
    }

    if (typeof win.ResizeObserver === "function") {
      new win.ResizeObserver(function () {
        if (scene && scene.ready) {
          scene.resize();
        }
      }).observe(stage);
    }

    win.addEventListener("pagehide", function () {
      generation++;
      teardown();
    });
    win.addEventListener("pageshow", function (event) {
      // Restored from the back/forward cache after pagehide tore it down.
      if (event.persisted) {
        start();
      }
    });

    start();
  }

  return {
    LOADER: LOADER,
    WORLD: WORLD,
    PHYSICS: PHYSICS,
    CAMERA: CAMERA,
    radiusFor: radiusFor,
    maxKnownSubscribers: maxKnownSubscribers,
    computeRadii: computeRadii,
    worldSize: worldSize,
    hashString: hashString,
    createRng: createRng,
    seedPositions: seedPositions,
    maxOverlap: maxOverlap,
    pin: pin,
    unpin: unpin,
    isPinned: isPinned,
    GROUPS: GROUPS,
    validatePayload: validatePayload,
    groupView: groupView,
    AVATAR_PIXELS: AVATAR_PIXELS,
    avatarPixels: avatarPixels,
    sizedAvatarUrl: sizedAvatarUrl,
    avatarLoadUrls: avatarLoadUrls,
    pausedForPreference: pausedForPreference,
    fetchJson: fetchJson,
    loadImages: loadImages,
    prepareChannels: prepareChannels,
    fmtNum: fmtNum,
    initials: initials,
    describe: describe,
    placeTooltip: placeTooltip,
    fitTransform: fitTransform,
    initialTransform: initialTransform,
    flowAngle: flowAngle,
    hoverPointer: hoverPointer,
    clickIsTouch: clickIsTouch,
    keyboardFocus: keyboardFocus,
    detailTarget: detailTarget,
    loadErrorKind: loadErrorKind,
    settleDataLoad: settleDataLoad,
    sharedDownloads: sharedDownloads,
    escapeApplies: escapeApplies,
    collisionRadius: collisionRadius,
    createSimulation: createSimulation,
    startMotion: startMotion,
    boot: boot
  };
});
