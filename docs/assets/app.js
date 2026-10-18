/*
 * Nightcore Tracker: date switching and entrance motion.
 *
 * The prerendered page is complete without this script. Snapshot data is
 * only ever written with textContent and checked URLs; never as markup.
 * The card markup and number formats mirror templates/index.html.j2 and
 * build.py, so keep the three in sync.
 */
(function () {
  "use strict";

  var IMAGE_HOSTS = ["i.ytimg.com", "yt3.ggpht.com", "yt3.googleusercontent.com"];
  var LINK_HOSTS = ["www.youtube.com"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var FILE_RE = /^data\/\d{4}-\d{2}-\d{2}\.json$/;
  var SWAP_MS = 180;

  var main = document.getElementById("main");
  var picker = document.querySelector(".date-picker");
  if (!main) {
    return;
  }
  var topN = Number(main.getAttribute("data-top-n")) || 10;
  var live = document.getElementById("live-status");
  var motionQuery = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var cache = {};
  var current = main.getAttribute("data-ranking-date");
  var busy = false;
  var observer = null;

  function reducedMotion() {
    return Boolean(motionQuery && motionQuery.matches);
  }

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

  function movementView(entry) {
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

  /* --- DOM builders ------------------------------------------------------ */

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

  function image(src, width, height, eager) {
    var safe = safeUrl(src, IMAGE_HOSTS);
    if (!safe) {
      return null;
    }
    var img = el("img");
    img.alt = "";
    img.width = width;
    img.height = height;
    img.decoding = "async";
    if (!eager) {
      img.loading = "lazy";
    }
    img.src = safe;
    return img;
  }

  function stat(label, value, accent) {
    var wrap = el("div", accent ? "stat stat--accent" : "stat");
    wrap.appendChild(el("dt", null, label));
    wrap.appendChild(el("dd", null, value));
    return wrap;
  }

  function movementBadge(entry) {
    var view = movementView(entry);
    var p = el("p", "move move--" + view.cls);
    p.title = view.text;
    var symbol = el("span", null, view.symbol);
    symbol.setAttribute("aria-hidden", "true");
    p.appendChild(symbol);
    p.appendChild(el("span", "sr-only", view.text));
    return p;
  }

  function cardShell(entry, className, id) {
    var li = el("li", className);
    li.style.setProperty("--i", String(entry.rank - 1));
    li.setAttribute("data-id", String(id));
    return li;
  }

  function cardBody(entry, name, sub, stats) {
    var body = el("div", "card-body");
    var title = el("h3", "card-title");
    title.appendChild(el("span", "sr-only", "Rank " + entry.rank + ": "));
    var link = externalLink(entry.url);
    link.textContent = String(name);
    title.appendChild(link);
    body.appendChild(title);
    body.appendChild(el("p", "card-sub", sub));
    var dl = el("dl", "stats");
    stats.forEach(function (s) { dl.appendChild(s); });
    body.appendChild(dl);
    body.appendChild(movementBadge(entry));
    return body;
  }

  function rankBadge(entry) {
    var rank = el("span", "rank", entry.rank);
    rank.setAttribute("aria-hidden", "true");
    return rank;
  }

  function songCard(entry, section, lead) {
    var li = cardShell(entry, "card card--song" + (lead ? " card--lead" : ""), entry.video_id);
    var thumb = externalLink(entry.url, "card-thumb");
    thumb.tabIndex = -1;
    thumb.setAttribute("aria-hidden", "true");
    var img = image(entry.thumbnail_url, 480, 360, section === "songs" && entry.rank <= 2);
    if (img) {
      thumb.appendChild(img);
    }
    li.appendChild(thumb);
    li.appendChild(rankBadge(entry));
    var stats = section === "growth"
      ? [stat("7-day growth", fmtPct(entry.growth_pct), true), stat("7-day gain", fmtGain(entry.views_gained))]
      : [stat("7-day gain", fmtGain(entry.views_gained), true), stat("Growth", fmtPct(entry.growth_pct))];
    stats.push(stat("Total views", fmtNum(entry.views)));
    li.appendChild(cardBody(entry, entry.title, entry.channel_name, stats));
    return li;
  }

  function channelCard(entry) {
    var li = cardShell(entry, "card card--channel", entry.channel_id);
    var avatar = el("span", "avatar");
    var img = image(entry.avatar_url, 88, 88, false);
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
    li.appendChild(cardBody(entry, entry.name, sub, [
      stat("7-day gain", fmtGain(entry.views_gained), true),
      stat("Growth", fmtPct(entry.growth_pct)),
      stat("Total views", fmtNum(entry.views))
    ]));
    return li;
  }

  function summaryItem(label, value, rest) {
    var li = el("li", null, label);
    li.appendChild(el("strong", null, value));
    li.appendChild(document.createTextNode(rest));
    return li;
  }

  /* --- Rendering --------------------------------------------------------- */

  function lookup(obj, path) {
    return path.split(".").reduce(function (acc, key) {
      return acc && typeof acc === "object" ? acc[key] : undefined;
    }, obj);
  }

  function replaceChildren(parent, children) {
    while (parent.firstChild) {
      parent.removeChild(parent.firstChild);
    }
    var fragment = document.createDocumentFragment();
    children.forEach(function (child) { fragment.appendChild(child); });
    parent.appendChild(fragment);
  }

  function renderList(name, entries) {
    var list = main.querySelector('[data-list="' + name + '"]');
    if (!list) {
      return [];
    }
    var cards = entries.map(function (entry, index) {
      if (name === "channels") {
        return channelCard(entry);
      }
      return songCard(entry, name, name === "songs" && index === 0);
    });
    replaceChildren(list, cards);
    var empty = list.parentNode.querySelector("[data-empty]");
    if (empty) {
      empty.hidden = entries.length > 0;
    }
    return cards;
  }

  function renderSummary(snap) {
    var list = main.querySelector("[data-summary]");
    if (!list) {
      return;
    }
    var entered = snap.summary.entered;
    var items = typeof entered.songs !== "number"
      ? [el("li", null, "No comparison with the previous day is available for this date.")]
      : [
        summaryItem("Top songs: ", entered.songs, " new to the top " + topN + " since yesterday"),
        summaryItem("Rising channels: ", entered.channels, " new to the top " + topN),
        summaryItem("Breakout songs: ", entered.growth, " new to the top " + topN)
      ];
    var climber = snap.summary.biggest_climber;
    if (climber) {
      items.push(summaryItem("Biggest climber: ", climber.name, ", #" + climber.from_rank + " to #" + climber.to_rank));
    }
    replaceChildren(list, items);
  }

  function render(snap) {
    var bound = document.querySelectorAll("[data-bind]");
    Array.prototype.forEach.call(bound, function (node) {
      var value = lookup(snap, node.getAttribute("data-bind"));
      var format = FORMATS[node.getAttribute("data-format")];
      node.textContent = format ? format(value) : String(value === undefined || value === null ? "" : value);
      if (node.tagName === "TIME" && typeof value === "string") {
        node.setAttribute("datetime", value);
      }
    });
    var cards = [];
    ["songs", "channels", "growth"].forEach(function (name) {
      cards = cards.concat(renderList(name, snap.rankings[name]));
    });
    renderSummary(snap);
    main.setAttribute("data-ranking-date", snap.ranking_date);
    prepareReveal(cards);
  }

  function looksValid(snap, date) {
    return Boolean(
      snap && typeof snap === "object" && snap.ranking_date === date && snap.rankings &&
      Array.isArray(snap.rankings.songs) && Array.isArray(snap.rankings.channels) &&
      Array.isArray(snap.rankings.growth) && snap.summary && snap.summary.entered
    );
  }

  /* --- Entrance motion ------------------------------------------------------ */

  function prepareReveal(cards) {
    if (reducedMotion() || !("IntersectionObserver" in window)) {
      return;
    }
    if (!observer) {
      observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("reveal-in");
            entry.target.classList.remove("reveal-pending");
            observer.unobserve(entry.target);
          }
        });
      }, { rootMargin: "0px 0px -6% 0px", threshold: 0.05 });
    }
    var fold = window.innerHeight || document.documentElement.clientHeight;
    cards.forEach(function (card) {
      // Only cards below the fold start hidden, so nothing visible flickers
      // and the leading song is shown immediately.
      if (card.getBoundingClientRect().top > fold) {
        card.classList.add("reveal-pending");
        observer.observe(card);
      }
    });
  }

  /* --- Date switching -------------------------------------------------------- */

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
      cache[file] = fetch(file, { cache: "no-cache", credentials: "same-origin" }).then(function (response) {
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
    return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
  }

  function swap(snap) {
    var animate = !reducedMotion();
    var before = animate ? (main.classList.add("is-swapping"), wait(SWAP_MS)) : Promise.resolve();
    return before.then(function () {
      var x = window.scrollX;
      var y = window.scrollY;
      render(snap);
      window.scrollTo(x, y);
      if (animate) {
        window.requestAnimationFrame(function () { main.classList.remove("is-swapping"); });
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

  if (picker && window.fetch && window.Promise) {
    buttons().forEach(function (button) {
      button.addEventListener("click", function () { select(button); });
    });
    picker.addEventListener("keydown", onKeydown);
    picker.hidden = false;
  }

  prepareReveal(Array.prototype.slice.call(main.querySelectorAll(".card")));
})();
