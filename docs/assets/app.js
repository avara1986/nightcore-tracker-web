/*
 * Nightcore Tracker: date switching and entrance motion.
 *
 * The prerendered page is complete without this script. Snapshot data is
 * only ever written with textContent and checked URLs; never as markup.
 * The card markup and number formats mirror templates/index.html.j2 and
 * build.py, so keep the three in sync.
 *
 * The pure logic (formatting, chart definitions, snapshot checks, card stats
 * and summary lines) has no DOM dependency and is exported for the Node tests
 * in tests/js/.
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

  var IMAGE_HOSTS = ["i.ytimg.com", "yt3.ggpht.com", "yt3.googleusercontent.com"];
  var LINK_HOSTS = ["www.youtube.com"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var FILE_RE = /^data\/\d{4}-\d{2}-\d{2}\.json$/;
  var SWAP_MS = 180;

  // Charts in page order. "growth" mode leads with the percentage, "gain"
  // mode with the absolute gain. Optional charts may be missing from
  // snapshots published before they existed.
  var SECTIONS = [
    { name: "growth", title: "Breakout songs", kind: "song", mode: "growth", lead: true, optional: false },
    { name: "rising_channels", title: "Rising channels", kind: "channel", mode: "growth", lead: false, optional: true },
    { name: "songs", title: "Top songs", kind: "song", mode: "gain", lead: false, optional: false },
    { name: "channels", title: "Top channels", kind: "channel", mode: "gain", lead: false, optional: false }
  ];

  var SECTION_TITLES = {};
  SECTIONS.forEach(function (section) { SECTION_TITLES[section.name] = section.title; });

  /* --- Formatting (mirrors build.py) ----------------------------------- */

  function groupDigits(value, decimals) {
    return Math.abs(value).toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }

  function fmtNum(value) {
    return typeof value === "number" ? (value < 0 ? "-" : "") + groupDigits(value, 0) : "-";
  }

  function fmtGain(value) {
    return typeof value === "number" ? (value < 0 ? "-" : "+") + groupDigits(value, 0) : "-";
  }

  function fmtPct(value) {
    return typeof value === "number" ? (value < 0 ? "-" : "+") + groupDigits(value, 1) + "%" : "n/a";
  }

  function dateParts(text) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(text));
    if (!m) {
      return null;
    }
    var y = Number(m[1]);
    var mo = Number(m[2]);
    var d = Number(m[3]);
    return { y: y, m: mo, d: d, weekday: new Date(Date.UTC(y, mo - 1, d)).getUTCDay() };
  }

  function fmtShortDate(text) {
    var p = dateParts(text);
    return p ? p.d + " " + MONTHS[p.m - 1] : String(text);
  }

  function fmtDate(text) {
    var p = dateParts(text);
    return p ? WEEKDAYS[p.weekday] + " " + p.d + " " + MONTHS[p.m - 1] + " " + p.y : String(text);
  }

  function fmtTimestamp(text) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):\d{2}Z$/.exec(String(text));
    if (!m) {
      return String(text);
    }
    return Number(m[3]) + " " + MONTHS[Number(m[2]) - 1] + " " + m[1] + ", " + m[4] + ":" + m[5] + " UTC";
  }

  var FORMATS = {
    num: fmtNum,
    date: fmtDate,
    timestamp: fmtTimestamp,
    hours: function (v) { return Number(v).toFixed(1); },
    run: function (v) { return v || "unverified"; }
  };

  function movementView(entry, topN) {
    var mv = entry.movement || {};
    var prev = mv.previous_rank;
    var rank = entry.rank;
    switch (mv.kind) {
      case "up":
        return {
          symbol: "▲" + (prev - rank),
          cls: "up",
          text: prev > topN
            ? "Entered the top " + topN + " from #" + prev
            : "Up " + (prev - rank) + " from #" + prev + " yesterday"
        };
      case "down":
        return { symbol: "▼" + (rank - prev), cls: "down", text: "Down " + (rank - prev) + " from #" + prev + " yesterday" };
      case "same":
        return { symbol: "=", cls: "same", text: "Same position as yesterday" };
      case "new_upload":
        return { symbol: "NEW", cls: "new", text: "New upload, first full week tracked" };
      case "entry":
        return { symbol: "IN", cls: "entry", text: "Not ranked yesterday" };
      default:
        return { symbol: "·", cls: "none", text: "No comparison available" };
    }
  }

  /* --- Pure chart logic ---------------------------------------------------- */

  function lookup(obj, path) {
    return path.split(".").reduce(function (acc, key) {
      return acc && typeof acc === "object" ? acc[key] : undefined;
    }, obj);
  }

  // Card statistics for one entry; the first one is the dominant metric.
  function cardStats(entry, mode) {
    var stats = mode === "growth"
      ? [
        { label: "7-day growth", value: fmtPct(entry.growth_pct), accent: true },
        { label: "7-day gain", value: fmtGain(entry.views_gained), accent: false }
      ]
      : [
        { label: "7-day gain", value: fmtGain(entry.views_gained), accent: true },
        { label: "Growth", value: fmtPct(entry.growth_pct), accent: false }
      ];
    stats.push({ label: "Total views", value: fmtNum(entry.views), accent: false });
    return stats;
  }

  // DOM key of a card: the same song or channel can appear in two charts.
  function cardKey(sectionName, entry) {
    var id = entry.video_id !== undefined ? entry.video_id : entry.channel_id;
    return sectionName + ":" + String(id);
  }

  // "ok" with entries, "empty" for a calculated ranking with no entries, and
  // "unavailable" when the snapshot predates the chart (key absent) or had no
  // observations for it (null).
  function sectionState(snap, sectionName) {
    var entries = snap.rankings[sectionName];
    if (!Array.isArray(entries)) {
      return "unavailable";
    }
    return entries.length ? "ok" : "empty";
  }

  // Whether text tied to a snapshot value (and optionally to one chart) must be
  // hidden: the value is missing, or the chart is unavailable for this date.
  // Mirrors the hidden attributes in templates/index.html.j2.
  function dependentHidden(snap, requiresPath, sectionName) {
    if (lookup(snap, requiresPath) === undefined) {
      return true;
    }
    return Boolean(sectionName) && sectionState(snap, sectionName) === "unavailable";
  }

  function looksValid(snap, date) {
    if (!snap || typeof snap !== "object" || snap.ranking_date !== date || !snap.rankings ||
        typeof snap.rankings !== "object" || !snap.summary || !snap.summary.entered) {
      return false;
    }
    return SECTIONS.every(function (section) {
      var entries = snap.rankings[section.name];
      if ((entries === undefined || entries === null) && section.optional) {
        return true;
      }
      return Array.isArray(entries);
    });
  }

  // Closing summary in page order. Each line is either plain text or a
  // label, a highlighted value and the rest of the sentence.
  function summaryLines(snap, topN) {
    var entered = snap.summary.entered;
    var lines;
    if (typeof entered.songs !== "number") {
      lines = [{ text: "No comparison with the previous day is available for this date." }];
    } else {
      lines = SECTIONS.map(function (section, index) {
        var label = section.title + ": ";
        if (sectionState(snap, section.name) === "unavailable") {
          return { text: label + "not available for this date" };
        }
        if (typeof entered[section.name] !== "number") {
          return { text: label + "no comparison with the previous day" };
        }
        var rest = " new to the top " + topN + (index === 0 ? " since yesterday" : "");
        return { label: label, value: String(entered[section.name]), rest: rest };
      });
    }
    var climber = snap.summary.biggest_climber;
    if (climber) {
      var chart = SECTION_TITLES[climber.section] || String(climber.section);
      lines.push({
        label: "Biggest climber: ",
        value: String(climber.name),
        rest: " in " + chart + ", #" + climber.from_rank + " to #" + climber.to_rank
      });
    }
    return lines;
  }

  function safeUrl(value, hosts) {
    if (typeof value !== "string") {
      return null;
    }
    var url;
    try {
      url = new URL(value);
    } catch (err) {
      return null;
    }
    if (url.protocol !== "https:" || hosts.indexOf(url.hostname) === -1 || url.username) {
      return null;
    }
    return url.href;
  }

  /* --- Image sources (mirror public_site/images.py) ------------------------ */

  var VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
  var AVATAR_HOSTS = ["yt3.ggpht.com", "yt3.googleusercontent.com"];
  var THUMB_SIZES = "(min-width: 48rem) 9rem, 7.5rem";
  var LEAD_THUMB_SIZES = "(min-width: 72rem) 38rem, (min-width: 48rem) 52vw, calc(100vw - 3.5rem)";
  var CARD_AVATAR_SIZES = [88, 176];

  function ytThumb(videoId, variant) {
    return "https://i.ytimg.com/vi/" + videoId + "/" + variant + ".jpg";
  }

  // Song card thumbnail: mqdefault (320 x 180) for cards, hqdefault for the
  // lead, with both in srcset. Unknown IDs fall back to the snapshot URL.
  function thumbnailSources(entry, lead) {
    if (typeof entry.video_id !== "string" || !VIDEO_ID_RE.test(entry.video_id)) {
      return { src: entry.thumbnail_url, srcset: null, sizes: null };
    }
    var small = ytThumb(entry.video_id, "mqdefault");
    var large = ytThumb(entry.video_id, "hqdefault");
    return {
      src: lead ? large : small,
      srcset: small + " 320w, " + large + " 480w",
      sizes: lead ? LEAD_THUMB_SIZES : THUMB_SIZES
    };
  }

  // The same avatar at size x size, never larger than the stored size; null
  // when the URL is not a resizable avatar URL.
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
    if (url.protocol !== "https:" || AVATAR_HOSTS.indexOf(url.hostname) === -1 || url.username ||
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

  function avatarSources(value) {
    var one = sizedAvatarUrl(value, CARD_AVATAR_SIZES[0]);
    var two = sizedAvatarUrl(value, CARD_AVATAR_SIZES[1]);
    if (!one || !two) {
      return { src: value, srcset: null, sizes: null };
    }
    if (one === two) {
      return { src: one, srcset: null, sizes: null };
    }
    return { src: one, srcset: one + " 1x, " + two + " 2x", sizes: null };
  }

  /* --- Page ------------------------------------------------------------------ */

  function boot(win) {
    var document = win.document;
    var main = document.getElementById("main");
    var picker = document.querySelector(".date-picker");
    if (!main) {
      return;
    }
    var topN = Number(main.getAttribute("data-top-n")) || 10;
    var live = document.getElementById("live-status");
    var motionQuery = win.matchMedia ? win.matchMedia("(prefers-reduced-motion: reduce)") : null;
    var cache = {};
    var current = main.getAttribute("data-ranking-date");
    var busy = false;
    var observer = null;

    function reducedMotion() {
      return Boolean(motionQuery && motionQuery.matches);
    }

    /* --- DOM builders ---------------------------------------------------- */

    function el(tag, className, text) {
      var node = document.createElement(tag);
      if (className) {
        node.className = className;
      }
      if (text !== undefined && text !== null) {
        node.textContent = String(text);
      }
      return node;
    }

    function externalLink(href, className) {
      var a = el("a", className);
      var safe = safeUrl(href, LINK_HOSTS);
      if (safe) {
        a.href = safe;
      }
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      return a;
    }

    function image(sources, width, height, priority) {
      var safe = safeUrl(sources.src, IMAGE_HOSTS);
      if (!safe) {
        return null;
      }
      var img = el("img");
      img.alt = "";
      img.width = width;
      img.height = height;
      img.decoding = "async";
      if (priority) {
        img.setAttribute("fetchpriority", "high");
      } else {
        img.loading = "lazy";
      }
      // srcset candidates are derived from checked URLs on the same hosts.
      if (sources.srcset) {
        if (sources.sizes) {
          img.sizes = sources.sizes;
        }
        img.srcset = sources.srcset;
      }
      img.src = safe;
      return img;
    }

    function stat(spec) {
      var wrap = el("div", spec.accent ? "stat stat--accent" : "stat");
      wrap.appendChild(el("dt", null, spec.label));
      wrap.appendChild(el("dd", null, spec.value));
      return wrap;
    }

    function movementBadge(entry) {
      var view = movementView(entry, topN);
      var p = el("p", "move move--" + view.cls);
      p.title = view.text;
      var symbol = el("span", null, view.symbol);
      symbol.setAttribute("aria-hidden", "true");
      p.appendChild(symbol);
      p.appendChild(el("span", "sr-only", view.text));
      return p;
    }

    function cardShell(entry, className, section) {
      var li = el("li", className);
      li.style.setProperty("--i", String(entry.rank - 1));
      li.setAttribute("data-id", cardKey(section.name, entry));
      return li;
    }

    function cardBody(entry, name, sub, section) {
      var body = el("div", "card-body");
      var title = el("h3", "card-title");
      title.appendChild(el("span", "sr-only", "Rank " + entry.rank + ": "));
      var link = externalLink(entry.url);
      link.textContent = String(name);
      title.appendChild(link);
      body.appendChild(title);
      body.appendChild(el("p", "card-sub", sub));
      var dl = el("dl", "stats");
      cardStats(entry, section.mode).forEach(function (spec) { dl.appendChild(stat(spec)); });
      body.appendChild(dl);
      body.appendChild(movementBadge(entry));
      return body;
    }

    function rankBadge(entry) {
      var rank = el("span", "rank", entry.rank);
      rank.setAttribute("aria-hidden", "true");
      return rank;
    }

    function songCard(entry, section, index) {
      var lead = section.lead && index === 0;
      var li = cardShell(entry, "card card--song" + (lead ? " card--lead" : ""), section);
      var thumb = externalLink(entry.url, "card-thumb");
      thumb.tabIndex = -1;
      thumb.setAttribute("aria-hidden", "true");
      var img = image(thumbnailSources(entry, lead), 320, 180, lead);
      if (img) {
        thumb.appendChild(img);
      }
      li.appendChild(thumb);
      li.appendChild(rankBadge(entry));
      li.appendChild(cardBody(entry, entry.title, entry.channel_name, section));
      return li;
    }

    function channelCard(entry, section) {
      var li = cardShell(entry, "card card--channel", section);
      var avatar = el("span", "avatar");
      var img = image(avatarSources(entry.avatar_url), 88, 88, false);
      if (img) {
        avatar.appendChild(img);
      } else {
        var fallback = el("span", "avatar-fallback", String(entry.name || "?").charAt(0));
        fallback.setAttribute("aria-hidden", "true");
        avatar.appendChild(fallback);
      }
      li.appendChild(avatar);
      li.appendChild(rankBadge(entry));
      var sub = typeof entry.subscribers === "number" ? fmtNum(entry.subscribers) + " subscribers" : "YouTube channel";
      li.appendChild(cardBody(entry, entry.name, sub, section));
      return li;
    }

    function summaryItem(line) {
      if (line.text !== undefined) {
        return el("li", null, line.text);
      }
      var li = el("li", null, line.label);
      li.appendChild(el("strong", null, line.value));
      li.appendChild(document.createTextNode(line.rest));
      return li;
    }

    /* --- Rendering ------------------------------------------------------- */

    function replaceChildren(parent, children) {
      while (parent.firstChild) {
        parent.removeChild(parent.firstChild);
      }
      var fragment = document.createDocumentFragment();
      children.forEach(function (child) { fragment.appendChild(child); });
      parent.appendChild(fragment);
    }

    function renderList(section, snap) {
      var list = main.querySelector('[data-list="' + section.name + '"]');
      if (!list) {
        return [];
      }
      var state = sectionState(snap, section.name);
      // Unavailable charts are cleared too, so no card of another date stays.
      var entries = state === "unavailable" ? [] : snap.rankings[section.name];
      var cards = entries.map(function (entry, index) {
        return section.kind === "channel" ? channelCard(entry, section) : songCard(entry, section, index);
      });
      replaceChildren(list, cards);
      var board = list.parentNode;
      var empty = board.querySelector("[data-empty]");
      if (empty) {
        empty.hidden = state !== "empty";
      }
      var unavailable = board.querySelector("[data-unavailable]");
      if (unavailable) {
        unavailable.hidden = state !== "unavailable";
      }
      return cards;
    }

    function renderSummary(snap) {
      var list = main.querySelector("[data-summary]");
      if (!list) {
        return;
      }
      replaceChildren(list, summaryLines(snap, topN).map(summaryItem));
    }

    function render(snap) {
      var warning = document.querySelector("[data-collection-warning]");
      if (warning) {
        warning.hidden = Boolean(snap.collection_run && snap.collection_run.verified);
      }
      var bound = document.querySelectorAll("[data-bind]");
      Array.prototype.forEach.call(bound, function (node) {
        var value = lookup(snap, node.getAttribute("data-bind"));
        var format = FORMATS[node.getAttribute("data-format")];
        node.textContent = format ? format(value) : String(value === undefined || value === null ? "" : value);
        if (node.tagName === "TIME" && typeof value === "string") {
          node.setAttribute("datetime", value);
        }
      });
      // Text that only makes sense when the snapshot carries the bound value.
      var dependent = document.querySelectorAll("[data-requires]");
      Array.prototype.forEach.call(dependent, function (node) {
        node.hidden = dependentHidden(
          snap,
          node.getAttribute("data-requires"),
          node.getAttribute("data-requires-section")
        );
      });
      var cards = [];
      SECTIONS.forEach(function (section) {
        cards = cards.concat(renderList(section, snap));
      });
      renderSummary(snap);
      main.setAttribute("data-ranking-date", snap.ranking_date);
      prepareReveal(cards);
    }

    /* --- Entrance motion ------------------------------------------------- */

    function prepareReveal(cards) {
      if (reducedMotion() || !("IntersectionObserver" in win)) {
        return;
      }
      if (!observer) {
        observer = new win.IntersectionObserver(function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting) {
              entry.target.classList.add("reveal-in");
              entry.target.classList.remove("reveal-pending");
              observer.unobserve(entry.target);
            }
          });
        }, { rootMargin: "0px 0px -6% 0px", threshold: 0.05 });
      }
      var fold = win.innerHeight || document.documentElement.clientHeight;
      cards.forEach(function (card) {
        // Only cards below the fold start hidden, so nothing visible flickers
        // and the leading song is shown immediately.
        if (card.getBoundingClientRect().top > fold) {
          card.classList.add("reveal-pending");
          observer.observe(card);
        }
      });
    }

    /* --- Date switching -------------------------------------------------- */

    function announce(message) {
      if (live) {
        live.textContent = message;
      }
    }

    function buttons() {
      return picker ? Array.prototype.slice.call(picker.querySelectorAll(".date-btn")) : [];
    }

    function markSelected(date) {
      buttons().forEach(function (button) {
        button.setAttribute("aria-pressed", button.getAttribute("data-date") === date ? "true" : "false");
      });
    }

    function load(file) {
      if (!cache[file]) {
        cache[file] = win.fetch(file, { cache: "no-cache", credentials: "same-origin" }).then(function (response) {
          if (!response.ok) {
            throw new Error("HTTP " + response.status);
          }
          return response.json();
        });
        cache[file].catch(function () { delete cache[file]; });
      }
      return cache[file];
    }

    function wait(ms) {
      return new Promise(function (resolve) { win.setTimeout(resolve, ms); });
    }

    function swap(snap) {
      var animate = !reducedMotion();
      var before = animate ? (main.classList.add("is-swapping"), wait(SWAP_MS)) : Promise.resolve();
      return before.then(function () {
        var x = win.scrollX;
        var y = win.scrollY;
        render(snap);
        win.scrollTo(x, y);
        if (animate) {
          win.requestAnimationFrame(function () { main.classList.remove("is-swapping"); });
        }
      });
    }

    function select(button) {
      var date = button.getAttribute("data-date");
      if (button.getAttribute("aria-disabled") === "true") {
        announce(fmtDate(date) + " is unavailable. " + (button.title || ""));
        return;
      }
      var file = button.getAttribute("data-file");
      // One switch at a time: a slower response can never overwrite a newer date.
      if (busy || date === current || !FILE_RE.test(file || "")) {
        return;
      }
      busy = true;
      button.setAttribute("aria-busy", "true");
      load(file).then(function (snap) {
        if (!looksValid(snap, date)) {
          throw new Error("unexpected snapshot");
        }
        return swap(snap).then(function () {
          current = date;
          markSelected(date);
          announce("Showing rankings for " + fmtDate(date) + ".");
        });
      }).catch(function () {
        main.classList.remove("is-swapping");
        markSelected(current);
        announce("Could not load " + fmtDate(date) + ". Still showing " + fmtDate(current) + ".");
      }).then(function () {
        busy = false;
        button.removeAttribute("aria-busy");
      });
    }

    function onKeydown(event) {
      var list = buttons();
      var index = list.indexOf(document.activeElement);
      if (index === -1) {
        return;
      }
      var next = null;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        next = list[(index + 1) % list.length];
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        next = list[(index - 1 + list.length) % list.length];
      } else if (event.key === "Home") {
        next = list[0];
      } else if (event.key === "End") {
        next = list[list.length - 1];
      }
      if (next) {
        event.preventDefault();
        next.focus();
      }
    }

    if (picker && win.fetch && win.Promise) {
      buttons().forEach(function (button) {
        button.addEventListener("click", function () { select(button); });
      });
      picker.addEventListener("keydown", onKeydown);
      picker.hidden = false;
    }

    prepareReveal(Array.prototype.slice.call(main.querySelectorAll(".card")));
  }

  return {
    SECTIONS: SECTIONS,
    SECTION_TITLES: SECTION_TITLES,
    fmtNum: fmtNum,
    fmtGain: fmtGain,
    fmtPct: fmtPct,
    fmtShortDate: fmtShortDate,
    fmtDate: fmtDate,
    fmtTimestamp: fmtTimestamp,
    movementView: movementView,
    lookup: lookup,
    cardStats: cardStats,
    cardKey: cardKey,
    sectionState: sectionState,
    dependentHidden: dependentHidden,
    looksValid: looksValid,
    summaryLines: summaryLines,
    safeUrl: safeUrl,
    thumbnailSources: thumbnailSources,
    sizedAvatarUrl: sizedAvatarUrl,
    avatarSources: avatarSources,
    boot: boot
  };
});
