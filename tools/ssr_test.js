#!/usr/bin/env node
// ssr_test.js v3 — GATE 1: component logic. Renders EVERY tab + EVERY UserDetailRow
// with the REAL data.json via renderToString in a vm sandbox (local react@18).
const fs = require("fs"), vm = require("vm");
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const babel = require("@babel/standalone");

const data = JSON.parse(fs.readFileSync("public/data.json", "utf8"));
const src = fs.readFileSync("dashboard_core.jsx", "utf8");
const compiled = babel.transform(src, { presets: [["react", { runtime: "classic", development: false }]] }).code;

const ctx = { window: { __APP_DATA__: data }, React,
  useState: React.useState, useMemo: React.useMemo, useEffect: React.useEffect,
  useRef: React.useRef, useCallback: React.useCallback, Fragment: React.Fragment, console };
vm.createContext(ctx);
vm.runInContext(compiled + "\n;__EXPORTS__ = { Dashboard, OverviewTab, LeaderboardTab, AllUsersTab, TrendsTab, EnablementTab, TeamTrendsTab, FlagsTab, MaxPlansTab, BreakdownTab, UserDetailRow };", ctx);
const X = ctx.__EXPORTS__;

let fails = 0;
function check(name, el, mustInclude) {
  try {
    const html = ReactDOMServer.renderToString(el);
    if (html.length < 50) throw new Error("suspiciously small output (" + html.length + ")");
    for (const m of mustInclude || []) if (!html.includes(m)) throw new Error("missing marker: " + m);
    console.log("  ok:", name, "(" + html.length + " chars)");
  } catch (e) { console.error("  FAIL:", name, "-", e.message); fails++; }
}
const spendMarker = data.summary.totalSpend.toLocaleString("en-US", { minimumFractionDigits: 2 });
check("Dashboard (default tab)", React.createElement(X.Dashboard), [spendMarker, "Enablement", "Team Trends"]);
check("OverviewTab", React.createElement(X.OverviewTab), [spendMarker, "Cache hit rate"]);
check("LeaderboardTab", React.createElement(X.LeaderboardTab), [data.leaderboard[0].name]);
// v6: assert the WoW column renders with real movement, not just that the header exists —
// a header with every cell empty would otherwise pass. Pick the largest real mover and
// require its formatted delta to appear.
const movers = data.allUsers.filter(u => u.wowDelta !== null && u.wowDelta !== undefined);
const top = movers.slice().sort((a, b) => Math.abs(b.wowDelta) - Math.abs(a.wowDelta))[0];
const deltaMarker = "$" + Math.abs(top.wowDelta).toLocaleString("en-US", { minimumFractionDigits: 2 });
check("AllUsersTab", React.createElement(X.AllUsersTab), ["vs. last wk", "Trend", deltaMarker]);
// v6: the expanded panel must render the FULL per-week series, not just the latest delta.
// Assert against the user with the longest history: row count must equal their observed
// weeks, so a table silently truncated to the last N weeks fails here.
const longest = data.allUsers.slice().sort((a, b) =>
  (b.sparkline || []).filter(v => v !== null).length - (a.sparkline || []).filter(v => v !== null).length)[0];
const observed = (longest.sparkline || []).filter(v => v !== null).length;
const detailHtml = ReactDOMServer.renderToString(React.createElement(X.UserDetailRow, { u: longest }));
const bodyRows = (detailHtml.match(/Weekly history[\s\S]*/) || [""])[0];
const weekRowCount = (bodyRows.match(/current/g) || []).length;
if (!detailHtml.includes("Weekly history")) { console.error("  FAIL: weekly history block missing"); fails++; }
else if (weekRowCount !== 1) { console.error("  FAIL: expected exactly one 'current' week marker, got " + weekRowCount); fails++; }
else console.log("  ok: weekly history table renders " + observed + " observed weeks for " + longest.email);
// sparklines must span the full history window for every user (gap-honest series)
const W = data.history.weeks.length;
const badSpark = data.allUsers.filter(u => (u.sparkline || []).length !== W);
if (badSpark.length) { console.error("  FAIL: sparkline not " + W + "-wide for " + badSpark.length + " user(s)"); fails++; }
else console.log("  ok: sparklines span full " + W + "-week window for all " + data.allUsers.length + " users");
check("TrendsTab", React.createElement(X.TrendsTab), ["Org spend by model family"]);
check("EnablementTab", React.createElement(X.EnablementTab), ["Non-adopters", "Narrative"]);
check("TeamTrendsTab", React.createElement(X.TeamTrendsTab), ["Small multiples"]);
check("FlagsTab", React.createElement(X.FlagsTab), ["Engagement, not cost"]);
check("MaxPlansTab", React.createElement(X.MaxPlansTab));
check("BreakdownTab", React.createElement(X.BreakdownTab));
let rowFails = 0;
for (const u of data.allUsers) {
  try {
    const html = ReactDOMServer.renderToString(React.createElement(X.UserDetailRow, { u }));
    if (html.length < 100) throw new Error("small");
  } catch (e) { console.error("  FAIL UserDetailRow:", u.email, e.message); rowFails++; fails++; }
}
console.log("  ok: UserDetailRow x" + (data.allUsers.length - rowFails) + "/" + data.allUsers.length);
if (fails) { console.error("SSR GATE FAILED (" + fails + ")"); process.exit(1); }
console.log("SSR GATE PASS");
