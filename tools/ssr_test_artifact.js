#!/usr/bin/env node
// GATE 1b — artifact variant: compiles the assembled artifact (import line stripped,
// export converted) and SSR-renders Dashboard with the actions tab registered,
// plus ActionsTab itself, verifying DM/channel content rules hold.
const fs = require("fs"), vm = require("vm");
const React = require("react");
const RDS = require("react-dom/server");
const babel = require("@babel/standalone");
const ART = process.argv[2] || fs.readdirSync(".").filter(f => /^claude-usage-dashboard-\d{4}-\d{2}-\d{2}\.jsx$/.test(f)).sort().pop();
if (!ART) { console.error("FAIL: no built artifact found"); process.exit(1); }
console.log("  artifact:", ART);
let src = fs.readFileSync(ART, "utf8")
  .replace(/^import[^\n]*\n/, "")
  .replace("export default Dashboard;", "");
const compiled = babel.transform(src, { presets: [["react", { runtime: "classic", development: false }]] }).code;
const win = { fetch: () => Promise.reject(new Error("no net in gate")), sendPrompt: undefined };
const ctx = { window: win, navigator: {}, React, useState: React.useState, useMemo: React.useMemo,
  useEffect: React.useEffect, useRef: React.useRef, useCallback: React.useCallback, Fragment: React.Fragment, console };
vm.createContext(ctx);
vm.runInContext(compiled + "\n;__X__={Dashboard,ActionsTab,buildConsolidatedDMs,generateChannelSummary};", ctx);
const X = ctx.__X__;
let fails = 0;
const assert = (name, cond) => { console.log((cond ? "  ok: " : "  FAIL: ") + name); if (!cond) fails++; };

const dash = RDS.renderToString(React.createElement(X.Dashboard));
assert("artifact Dashboard renders w/ Slack Actions tab", dash.includes("Slack Actions") && dash.includes("Enablement"));
const at = RDS.renderToString(React.createElement(X.ActionsTab));
assert("ActionsTab renders", at.length > 2000);
const { costDMs, lowDMs } = X.buildConsolidatedDMs();
const SKIP = ["matt.rose@level.agency","dave.brong@level.agency","bill.buchanan@level.agency","patrick.patterson@level.agency"];
assert("skip list enforced (cost)", costDMs.every(d => !SKIP.includes(d.email)));
assert("skip list enforced (low)", lowDMs.every(d => !SKIP.includes(d.email)));
assert("cost DMs: >=1 exists, all >=$100 spenders", costDMs.length > 0 && costDMs.every(d => d.spend >= 100));
assert("all DMs identify as automated", costDMs.concat(lowDMs).every(d => d.body.includes("automated note")));
assert("no questions in any DM", costDMs.concat(lowDMs).every(d => !d.body.includes("?")));
assert("no max-plan messaging in DMs", costDMs.concat(lowDMs).every(d => !/max plan/i.test(d.body)));
assert("closer: no reply needed", costDMs.concat(lowDMs).every(d => d.body.includes("no reply needed")));
assert("section order cowork->opus->legacy", costDMs.every(d => {
  const i = ["Cowork \u2192 Opus", "Opus in Chat", "Legacy models"].map(s => d.body.indexOf(s)).filter(x => x >= 0);
  return i.every((v, j) => j === 0 || v > i[j - 1]);
}));
assert("low DMs all streak >=2", lowDMs.every(d => d.weeks >= 2));
const cs = X.generateChannelSummary();
assert("channel summary: no DM language", !/\bDM\b|direct message|drafted|manual/i.test(cs));
assert("channel summary: no max-plan mention", !/max.?plan/i.test(cs));
assert("channel summary: cache line present", cs.includes("Cache efficiency"));
assert("channel summary: flag counts line", cs.includes("Flags this week"));
const maxPlanNames = (ctx.window.__APP_DATA__, null); // names checked via data below
const data = JSON.parse(fs.readFileSync("public/data.json","utf8"));
assert("channel summary: no max-plan candidate names", data.maxPlan.every(u => !cs.includes(u.name) || data.powerUsers.some(p => p.name === u.name)));
console.log("  costDMs:", costDMs.length, "| lowDMs:", lowDMs.length);
if (fails) { console.error("ARTIFACT GATE FAILED (" + fails + ")"); process.exit(1); }
console.log("ARTIFACT GATE PASS");
