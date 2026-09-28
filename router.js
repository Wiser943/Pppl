/*
 * router.js – browser Back/Forward support for the single-page UI.
 *
 * It does NOT change how script.js shows/hides pages. Instead it watches which
 * "view" (auth form or page) is visible, records each change in the browser
 * history (state only, so the URL and #ref=... links stay untouched), and
 * re-shows the right view when the user presses Back/Forward.
 */
(function () {
  "use strict";

  var AUTH = { "auth:login": "loginContainer", "auth:signup": "signupContainer" };
  var PAGE_IDS = [
    "dashboard", "profilePage", "bankPage", "rechargePage", "rechargeConfirmPage",
    "payPage", "productPage", "invitePage", "teamPage", "myInvestmentPage",
    "earningsPage", "recordsPage", "withdrawPage",
  ];
  // Pages whose content is loaded by a button click; re-click it if we land on
  // the page without having opened it in this session (e.g. after a reload).
  var OPENERS = {
    withdrawPage: "withdrawBtn", recordsPage: "myRecordsBtn",
    earningsPage: "earningsBtn", myInvestmentPage: "investmentRecordsBtn",
  };
  var SAVEABLE = PAGE_IDS.filter(function (id) { return id !== "payPage" && id !== "rechargeConfirmPage"; });

  var body = document.body;
  var $ = function (id) { return document.getElementById(id); };
  var pageEls = PAGE_IDS.map($).filter(Boolean);
  var authEls = Object.keys(AUTH).map(function (k) { return $(AUTH[k]); }).filter(Boolean);
  var visited = {};
  var lastShown = null;
  var restoring = false;
  var replaceNext = false;
  var bootUntil = Date.now() + 1500; // ignore transient states while the app boots
  var timer = null;

  function isShown(el) { return el && getComputedStyle(el).display !== "none"; }
  function loggedIn() { return body.classList.contains("logged-in"); }

  function currentView() {
    var els = loggedIn() ? pageEls : authEls;
    var shown = els.filter(isShown);
    if (!shown.length) return null;
    var el = shown.indexOf(lastShown) > -1 ? lastShown : shown[shown.length - 1];
    if (!loggedIn()) return el.id === "signupContainer" ? "auth:signup" : "auth:login";
    return el.id;
  }

  function nav() { return $("bottomNav"); }

  function showView(view, navDisplay) {
    restoring = true;
    if (AUTH[view]) {
      Object.keys(AUTH).forEach(function (k) {
        var el = $(AUTH[k]);
        if (el) el.style.setProperty("display", k === view ? "block" : "none", "important");
      });
    } else {
      var target = $(view);
      if (!target) { restoring = false; return; }
      var opener = OPENERS[view] && !visited[view] ? $(OPENERS[view]) : null;
      pageEls.forEach(function (p) { p.style.display = "none"; });
      if (opener) {
        opener.click();
      } else {
        target.style.display = view === "invitePage" ? "flex" : "block";
        if (view === "invitePage") target.style.flexDirection = "column";
      }
      var bn = nav();
      if (bn && navDisplay != null && !opener) bn.style.display = navDisplay;
      if (SAVEABLE.indexOf(view) > -1) localStorage.setItem("lastPage", view);
      visited[view] = true;
      lastShown = target;
    }
    setTimeout(function () { restoring = false; }, 600); // nav loader delays some views ~300ms
  }

  function stateFor(view, prev) {
    var bn = nav();
    return { view: view, prev: prev || null, nav: bn ? bn.style.display : null };
  }

  function sync() {
    if (restoring) return;
    var view = currentView();
    if (!view) return;
    visited[view] = true;
    var st = history.state;
    if (st && st.view === view) return;

    if (!st || Date.now() < bootUntil || replaceNext) {
      history.replaceState(stateFor(view, null), "");
      replaceNext = false;
    } else if (st.prev === view) {
      // The app "navigated" to the page we came from (e.g. its own Back button):
      // step back in history instead of stacking a duplicate entry.
      restoring = true;
      history.back();
      setTimeout(function () { restoring = false; }, 600);
    } else {
      history.pushState(stateFor(view, st.view), "");
    }
  }

  function schedule() { clearTimeout(timer); timer = setTimeout(sync, 80); }

  var mo = new MutationObserver(function (records) {
    records.forEach(function (r) {
      if (r.target === body) return;
      if (isShown(r.target)) lastShown = r.target;
    });
    schedule();
  });
  pageEls.concat(authEls).forEach(function (el) {
    mo.observe(el, { attributes: true, attributeFilter: ["style", "class"] });
  });

  // Logging in/out replaces the current entry so Back never lands on the login form
  // (or on a page the signed-out user can't see).
  new MutationObserver(function () {
    replaceNext = true;
    bootUntil = Math.max(bootUntil, Date.now() + 800);
    schedule();
  }).observe(body, { attributes: true, attributeFilter: ["class"] });

  window.addEventListener("popstate", function (e) {
    var st = e.state;
    if (!st || !st.view) { schedule(); return; }
    var isAuthView = !!AUTH[st.view];
    if (loggedIn() === isAuthView) {
      // Entry doesn't match the session (logged in → auth form, or the reverse):
      // show the correct default view and rewrite this entry to match.
      var fallback = loggedIn() ? (currentView() || "dashboard") : "auth:login";
      showView(fallback, null);
      history.replaceState(stateFor(fallback, null), "");
      return;
    }
    showView(st.view, st.nav);
  });

  // Initial entry once the app has drawn its first view.
  setTimeout(sync, 400);
})();
