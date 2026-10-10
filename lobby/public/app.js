/* Family Arcade lobby: reads /api/status and fills in the page. */
(function () {
  "use strict";

  var POLL_MS = 30000;
  var config = {};
  var firstLoad = true;
  var timer = null;
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // The marquee lights sweep for ~1.3s on load; tokens light after it.
  var signReady = new Promise(function (resolve) {
    if (reduceMotion) return resolve();
    setTimeout(resolve, 1150);
  });

  var CABINET_COLORS = [
    ["var(--pink)", "var(--dark-on-color)"],
    ["var(--teal)", "var(--dark-on-color)"],
    ["var(--orange)", "var(--dark-on-color)"],
    ["var(--grape)", "#ffffff"],
    ["var(--sun)", "var(--dark-on-color)"]
  ];
  var STUB_COLORS = ["var(--orange)", "var(--pink)", "var(--teal)", "var(--sun)"];

  // ---------- helpers ----------

  function get(obj, path) {
    return path.split(".").reduce(function (o, k) {
      return o == null ? undefined : o[k];
    }, obj);
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ---------- config → page ----------

  // Chat mode from the live status: "moderated" (Chat Guard running) or "off".
  // Config items can carry "when": "moderated" | "off"; plain strings always show.
  var chatMode = "off";
  function fits(item) {
    return !(item && typeof item === "object" && item.when) || item.when === chatMode;
  }
  function textOf(item) {
    return item && typeof item === "object" ? (item.text || "") : item;
  }
  function setChatMode(mc) {
    var mode = mc && mc.chat === "moderated" ? "moderated" : "off";
    var changed = mode !== chatMode;
    chatMode = mode;
    document.documentElement.dataset.chat = mode;
    return changed;
  }

  function applyConfig(cfg) {
    config = cfg || {};

    document.querySelectorAll("[data-bind]").forEach(function (node) {
      var value = get(config, node.getAttribute("data-bind"));
      if (value === undefined || value === null || value === "") return;
      node.textContent = String(value);
      node.hidden = false;
    });

    document.querySelectorAll("[data-copy-bind]").forEach(function (node) {
      var value = get(config, node.getAttribute("data-copy-bind"));
      if (value !== undefined && value !== null && value !== "") {
        node.setAttribute("data-copy", String(value));
      }
    });

    if (config.site_name) document.title = config.site_name;

    renderCabinets(get(config, "arcade.systems") || [], get(config, "arcade.games") || []);
    renderNights(config.game_nights || []);
    renderRules(config.rules || []);
    renderRulebook(config.rulebook || {});
    applySeason(config.season || "auto");
    renderEvents(config.events || []);
    renderShowcase(config.showcase || []);
    renderTournament(config.tournament || null, config.hall_of_champions || []);
  }

  var CHAPTER_COLORS = ["var(--teal)", "var(--pink)", "var(--orange)", "var(--grape)", "var(--sun)"];

  function renderRulebook(book) {
    var wrap = document.getElementById("rulebook");
    var chapters = document.getElementById("rule-chapters");
    var ladder = document.getElementById("rule-ladder");
    var mistakes = document.getElementById("rule-mistakes");
    clear(chapters);
    clear(ladder);

    (book.chapters || []).filter(fits).forEach(function (ch, i) {
      var art = el("article", "chapter");
      art.style.setProperty("--chapter", CHAPTER_COLORS[i % CHAPTER_COLORS.length]);
      art.appendChild(el("h3", null, ch.title || ""));
      var ul = el("ul");
      (ch.items || []).filter(fits).forEach(function (item) { ul.appendChild(el("li", null, textOf(item))); });
      art.appendChild(ul);
      chapters.appendChild(art);
    });

    var steps = (book.ladder || []).filter(fits);
    ladder.parentNode.hidden = !steps.length;
    steps.forEach(function (step) {
      var li = el("li");
      li.appendChild(el("p", "ladder-title", step.title || ""));
      if (step.text) li.appendChild(el("p", "ladder-text", step.text));
      ladder.appendChild(li);
    });

    var note = book.mistakes && typeof book.mistakes === "object" ? book.mistakes[chatMode] : book.mistakes;
    mistakes.textContent = note || "";
    mistakes.hidden = !note;
    wrap.hidden = !(book.chapters && book.chapters.length) && !(book.ladder && book.ladder.length);
  }

  function renderCabinets(systems, games) {
    var wrap = document.getElementById("cabinets");
    clear(wrap);

    // Order: systems as listed in config, then any system only named on a game.
    var order = [];
    var byId = {};
    systems.forEach(function (s) {
      if (!s || !s.id) return;
      byId[s.id] = s;
      order.push(s.id);
    });
    games.forEach(function (g) {
      var id = g.system || "other";
      if (!byId[id]) {
        byId[id] = { id: id, name: id, status: "ready" };
        order.push(id);
      }
    });

    var shown = 0;
    order.forEach(function (id, i) {
      var sys = byId[id];
      var list = games.filter(function (g) { return (g.system || "other") === id; });
      if (sys.status === "hidden") return;
      if (!list.length && sys.status !== "soon") return;

      var cab = el("article", "cabinet");
      var soon = sys.status === "soon";
      cab.setAttribute("data-status", soon ? "soon" : "ready");
      var colors = CABINET_COLORS[shown % CABINET_COLORS.length];
      cab.style.setProperty("--cab", colors[0]);
      cab.style.setProperty("--cab-ink", colors[1]);

      var top = el("div", "cabinet-top");
      var name = el("h4", null, sys.name || id);
      top.appendChild(name);
      top.appendChild(el("span", "cabinet-flag", soon ? "Coming soon" : (sys.max_players ? "Up to " + sys.max_players + " players" : "Ready")));
      cab.appendChild(top);

      var ul = el("ul", "cabinet-games");
      if (!list.length) {
        ul.appendChild(el("li", "empty", "Games coming soon."));
      }
      list.forEach(function (g) {
        var li = el("li");
        li.appendChild(el("span", "game-title", g.title || ""));
        if (g.players) {
          var solo = String(g.players).trim() === "1";
          li.appendChild(el("span", "game-players" + (solo ? " is-turns" : ""), solo ? "Take turns" : g.players + " players"));
        }
        if (g.note) li.appendChild(el("span", "game-note", g.note));
        ul.appendChild(li);
      });
      cab.appendChild(ul);
      wrap.appendChild(cab);
      shown++;
    });

    if (!shown) wrap.appendChild(el("p", "empty", "The game list is coming soon."));
  }

  function upcomingNights(nights) {
    var now = Date.now();
    return nights
      .map(function (n) {
        var start = new Date(n.start);
        var end = n.end ? new Date(n.end) : new Date(start.getTime() + 2 * 3600 * 1000);
        return { start: start, end: end, title: n.title, plan: n.plan };
      })
      .filter(function (n) { return !isNaN(n.start) && n.end.getTime() > now; })
      .sort(function (a, b) { return a.start - b.start; });
  }

  var fmtDay = new Intl.DateTimeFormat(undefined, { day: "numeric" });
  var fmtMonth = new Intl.DateTimeFormat(undefined, { month: "short" });
  var fmtWeekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  var fmtDate = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
  var fmtShortDate = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
  var fmtTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  var fmtTimeZone = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  var fmtDay2 = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

  // ---------- seasons ----------

  function applySeason(setting) {
    var season = setting;
    if (setting === "auto") {
      var d = new Date(), m = d.getMonth(), day = d.getDate();
      season = m === 9 ? "halloween" : (m === 11 || (m === 0 && day <= 6)) ? "winter" : "none";
    }
    if (season === "none") delete document.documentElement.dataset.season;
    else document.documentElement.dataset.season = season;
  }

  // ---------- events ----------

  function liveEvents(events) {
    var now = Date.now();
    return events.map(function (e) {
      return { title: e.title, details: e.details, start: new Date(e.start), end: new Date(e.end) };
    }).filter(function (e) { return !isNaN(e.start) && !isNaN(e.end) && e.end.getTime() > now; })
      .sort(function (a, b) { return a.start - b.start; });
  }

  function renderEvents(events) {
    var wrap = document.getElementById("events");
    var banner = document.getElementById("event-banner");
    clear(wrap);
    var list = liveEvents(events).slice(0, 3);
    var now = Date.now();
    var current = list.filter(function (e) { return e.start.getTime() <= now; })[0];
    if (current) {
      banner.textContent = "Happening now: " + current.title + ". Ends " + fmtDay2.format(current.end) + ".";
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
    list.forEach(function (e) {
      var art = el("article", "event");
      var h = el("h3", null, e.title || "Event");
      if (e.start.getTime() <= now) h.appendChild(el("span", "ticket-now", "Happening now"));
      art.appendChild(h);
      art.appendChild(el("p", "event-when", fmtDay2.format(e.start) + " to " + fmtDay2.format(e.end)));
      if (e.details) art.appendChild(el("p", "event-details", e.details));
      wrap.appendChild(art);
    });
    wrap.hidden = !list.length;
  }

  function renderShowcase(items) {
    var wrap = document.getElementById("showcase-wrap");
    var list = document.getElementById("showcase");
    clear(list);
    items.forEach(function (it) {
      if (!it || !it.image) return;
      var li = el("li");
      var fig = el("figure");
      var img = el("img");
      img.src = "/gallery/" + encodeURIComponent(it.image);
      img.alt = it.title || "A build from the world";
      img.loading = "lazy";
      fig.appendChild(img);
      var cap = el("figcaption");
      cap.appendChild(el("span", "show-title", it.title || ""));
      var meta = [it.by ? "by " + it.by : "", it.event || ""].filter(Boolean).join(", ");
      if (meta) cap.appendChild(el("span", "show-meta", meta));
      fig.appendChild(cap);
      li.appendChild(fig);
      list.appendChild(li);
    });
    wrap.hidden = !list.children.length;
  }

  // ---------- tournament ----------

  function standings(t) {
    var points = t.points || [9, 6, 3, 1];
    var table = {};
    function row(name) {
      if (!table[name]) table[name] = { name: name, points: 0, wins: 0 };
      return table[name];
    }
    (t.players || []).forEach(row);
    (t.races || []).forEach(function (r) {
      (r.results || []).forEach(function (name, i) {
        var rr = row(name);
        rr.points += points[i] || 0;
        if (i === 0) rr.wins += 1;
      });
    });
    return Object.keys(table).map(function (k) { return table[k]; }).sort(function (a, b) {
      return b.points - a.points || b.wins - a.wins || a.name.localeCompare(b.name);
    });
  }

  function renderTournament(t, hall) {
    var box = document.getElementById("cup");
    var hallBox = document.getElementById("hall");
    var hallList = document.getElementById("hall-list");
    clear(hallList);
    hall.forEach(function (h) {
      var li = el("li");
      li.appendChild(el("span", "hall-name", h.champion || ""));
      li.appendChild(el("span", "hall-event", [h.event, h.date].filter(Boolean).join(", ")));
      hallList.appendChild(li);
    });
    hallBox.hidden = !hall.length;

    if (!t || !t.title) { box.hidden = !hall.length; return; }
    box.hidden = false;
    document.getElementById("cup-title").textContent = t.title;
    var date = t.date ? new Date(t.date) : null;
    var races = (t.races || []).length;
    var status = t.status || "upcoming";
    var meta = document.getElementById("cup-meta");
    if (status === "upcoming") {
      meta.textContent = (date && !isNaN(date) ? "Starts " + fmtShortDate.format(date) + " at " + fmtTimeZone.format(date) + ". " : "") +
        "Sign up in #game-night on Discord.";
    } else if (status === "live") {
      meta.textContent = "Live now. " + races + (races === 1 ? " race" : " races") + " so far.";
    } else {
      meta.textContent = "Final standings after " + races + (races === 1 ? " race." : " races.");
    }

    var rows = standings(t);
    var tbody = document.getElementById("cup-rows");
    clear(tbody);
    rows.forEach(function (r, i) {
      var tr = el("tr");
      if (i === 0 && races) tr.className = "leader";
      tr.appendChild(el("td", "place", String(i + 1)));
      tr.appendChild(el("td", null, r.name));
      tr.appendChild(el("td", "num", String(r.points)));
      tr.appendChild(el("td", "num", String(r.wins)));
      tbody.appendChild(tr);
    });
    document.getElementById("cup-table-wrap").hidden = !(rows.length && races);
    var empty = document.getElementById("cup-empty");
    empty.hidden = !!(rows.length && races);
    empty.textContent = rows.length ? "Standings appear after the first race." : "Racers sign up on Discord before the night.";

    var champ = document.getElementById("cup-champion");
    var winner = t.champion || (status === "done" && rows.length ? rows[0].name : "");
    champ.hidden = !(status === "done" && winner);
    champ.textContent = winner ? "Champion: " + winner : "";
  }

  // ---------- maintenance + map ----------

  var maintenance = { active: false };

  function showMaintenance(m) {
    maintenance = m || { active: false };
    var b = document.getElementById("maint-banner");
    b.hidden = !maintenance.active;
    b.textContent = maintenance.active ? (maintenance.message || "The Minecraft world is updating. Back in a few minutes.") : "";
  }

  function showMap(m) {
    document.getElementById("map-link").hidden = !(m && m.available);
  }

  function renderNights(nights) {
    var list = document.getElementById("nights-list");
    clear(list);
    var upcoming = upcomingNights(nights).slice(0, 4);
    if (!upcoming.length) {
      list.appendChild(el("li", "empty",
        "No game night is planned yet. " + (config.host_name || "Eric") + " will post the next one here."));
      return;
    }
    var now = Date.now();
    upcoming.forEach(function (n, i) {
      var li = el("li", "ticket");
      var stub = el("div", "ticket-stub");
      stub.style.setProperty("--stub-color", STUB_COLORS[i % STUB_COLORS.length]);
      stub.appendChild(el("span", "ticket-month", fmtMonth.format(n.start)));
      stub.appendChild(el("span", "ticket-day", fmtDay.format(n.start)));
      stub.appendChild(el("span", "ticket-weekday", fmtWeekday.format(n.start)));
      li.appendChild(stub);

      var body = el("div", "ticket-body");
      var title = el("p", "ticket-title", n.title || "Game night");
      if (n.start.getTime() <= now) title.appendChild(el("span", "ticket-now", "Happening now"));
      body.appendChild(title);
      body.appendChild(el("p", "ticket-when",
        fmtDate.format(n.start) + ", " + fmtTime.format(n.start) + " to " + fmtTimeZone.format(n.end)));
      if (n.plan) body.appendChild(el("p", "ticket-plan", n.plan));
      li.appendChild(body);
      list.appendChild(li);
    });
  }

  function renderRules(rules) {
    var list = document.getElementById("rules-list");
    clear(list);
    rules.filter(fits).forEach(function (r) { list.appendChild(el("li", null, textOf(r))); });
  }

  // ---------- live status ----------

  function setStation(id, on, state, detail) {
    var station = document.getElementById(id);
    station.setAttribute("data-state", "ready");
    station.setAttribute("data-on", on ? "true" : "false");
    station.querySelector(".state").textContent = state;
    station.querySelector(".detail").textContent = detail;
  }

  function contactSentence() {
    var c = config.contact_note || "Text " + (config.host_name || "Eric");
    return c.charAt(0).toLowerCase() + c.slice(1);
  }

  function showMinecraft(mc) {
    if (!(mc && mc.online) && maintenance.active) {
      setStation("station-mc", false, "Updating", "Nightly backup and update. Back in a few minutes.");
      return;
    }
    if (mc && mc.online) {
      var playing = mc.players === 0
        ? "Nobody is playing right now."
        : mc.players + (mc.players === 1 ? " person is" : " people are") + " playing" +
          (mc.max_players ? " (room for " + mc.max_players + ")." : ".");
      var chat = mc.chat === "moderated" ? " Chat is moderated."
        : mc.chat === "off" ? " Chat is off; building together works as usual." : "";
      setStation("station-mc", true, "Open now", playing + chat);
    } else {
      setStation("station-mc", false, "Offline right now",
        "It may be restarting, which takes a minute. If it's still off in an hour, " + contactSentence() + ".");
    }
  }

  function showArcade(arcade) {
    var host = config.host_name || "Eric";
    if (arcade && arcade.open) {
      setStation("station-arcade", true, "Open now",
        "Join #" + (get(config, "arcade.discord_voice_channel") || "game-night") + " on Discord, then connect to " +
        (get(config, "arcade.parsec_computer_name") || host + "'s computer") + " in Parsec.");
      return;
    }
    var next = upcomingNights(config.game_nights || [])[0];
    var detail = next
      ? "Next game night: " + fmtShortDate.format(next.start) + " at " + fmtTimeZone.format(next.start) + "."
      : host + " opens it on game nights.";
    setStation("station-arcade", false, "Closed", detail);
  }

  function showUnreachable() {
    ["station-mc", "station-arcade"].forEach(function (id) {
      setStation(id, false, "Status unavailable",
        "This page couldn't check right now. It tries again every 30 seconds.");
    });
  }

  function refresh() {
    fetch("/api/status", { cache: "no-store", headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        var modeChanged = setChatMode(data.minecraft);
        if (firstLoad || modeChanged || JSON.stringify(data.config) !== JSON.stringify(config)) {
          applyConfig(data.config || {});
        }
        firstLoad = false;
        return signReady.then(function () {
          showMaintenance(data.maintenance);
          showMap(data.map);
          showMinecraft(data.minecraft);
          showArcade(data.arcade);
        });
      })
      .catch(function () {
        if (firstLoad) {
          renderNights([]);
          var cab = document.getElementById("cabinets");
          clear(cab);
          cab.appendChild(el("p", "empty", "The game list couldn't load. Refresh the page to try again."));
        }
        showUnreachable();
      });
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(function () {
      if (!document.hidden) refresh();
    }, POLL_MS);
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) refresh();
  });

  // ---------- copy buttons ----------

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var area = el("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.className = "visually-offscreen";
      document.body.appendChild(area);
      area.select();
      try { document.execCommand("copy") ? resolve() : reject(); } catch (e) { reject(e); }
      document.body.removeChild(area);
    });
  }

  document.addEventListener("click", function (event) {
    var button = event.target.closest(".copy");
    if (!button) return;
    var label = button.querySelector(".copy-label");
    copyText(button.getAttribute("data-copy")).then(function () {
      button.setAttribute("data-copied", "true");
      label.textContent = "Copied";
      setTimeout(function () {
        button.removeAttribute("data-copied");
        label.textContent = "Copy";
      }, 1800);
    }, function () {
      label.textContent = "Select it";
    });
  });

  // ---------- start ----------

  refresh();
  schedule();
})();
