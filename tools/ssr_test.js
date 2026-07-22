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
vm.runInContext(compiled + "\n;__EXPORTS__ = { Dashboard, OverviewTab, LeaderboardTab, AllUsersTab, TrendsTab, EnablementTab, TeamTrendsTab, FlagsTab, BreakdownTab, UserDetailRow };", ctx);
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
check("AllUsersTab", React.createElement(X.AllUsersTab));
check("TrendsTab", React.createElement(X.TrendsTab), ["Org spend by model family"]);
check("EnablementTab", React.createElement(X.EnablementTab), ["Non-adopters", "Narrative"]);
check("TeamTrendsTab", React.createElement(X.TeamTrendsTab), ["Small multiples"]);
check("FlagsTab", React.createElement(X.FlagsTab), ["Engagement, not cost"]);
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
