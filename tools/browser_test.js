#!/usr/bin/env node
// browser_test.js v3 — GATE 2: deploy bootstrap. Runs the ACTUAL public/index.html in jsdom
// (runScripts:"dangerously"), attaches local React/ReactDOM as pre-parse globals (mirrors CDN
// UMD precondition), strips CDN <script> tags, mocks fetch("data.json") with the real on-disk
// file, lets fetch->inject->render flush, then asserts real-data markers.
const fs = require("fs");
const { JSDOM } = require("jsdom");

const html = fs.readFileSync("public/index.html", "utf8")
  .replace(/<script crossorigin src="https:\/\/unpkg\.com[^"]*"><\/script>/g, "")
  .replace(/<link[^>]*fonts[^>]*>/g, "");
const data = fs.readFileSync("public/data.json", "utf8");
const parsed = JSON.parse(data);

const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://dashboard.test/",
  beforeParse(window) {
    global.window = window; global.document = window.document; global.navigator = window.navigator;
    window.React = require("react");
    window.ReactDOM = require("react-dom/client");
    window.ReactDOM.createRoot = require("react-dom/client").createRoot;
    window.fetch = (u) => u.indexOf("data.json") !== -1
      ? Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(data)) })
      : Promise.reject(new Error("unexpected fetch " + u));
    window.requestAnimationFrame = cb => setTimeout(cb, 0);
  }});

setTimeout(() => {
  const root = dom.window.document.getElementById("root");
  const text = root.textContent || "";
  const spend = parsed.summary.totalSpend.toLocaleString("en-US", { minimumFractionDigits: 2 });
  const asserts = [
    ["root grew (>800 chars)", text.length > 800],
    ["no failure text", text.indexOf("Failed to load") === -1],
    ["no boot text", text.indexOf("Loading Level") === -1],
    ["Overview tab label", text.includes("Overview")],
    ["Leaderboard tab label", text.includes("Leaderboard")],
    ["All Users tab label", text.includes("All Users")],
    ["Trends tab label", text.includes("Trends")],
    ["Enablement tab label", text.includes("Enablement")],
    ["Team Trends tab label", text.includes("Team Trends")],
    ["Flags & Alerts tab label", text.includes("Flags & Alerts")],
    ["Breakdowns tab label", text.includes("Breakdowns")],
    ["NO Slack Actions on Vercel", !text.includes("Slack Actions")],
    ["real spend figure " + spend, text.includes(spend)],
    ["week label " + parsed.summary.weekOf, text.includes(parsed.summary.weekOf)],
    ["cache hit figure", text.includes(parsed.summary.cacheHitRate + "%")],
  ];
  let fails = 0;
  for (const [name, ok] of asserts) { console.log((ok ? "  ok: " : "  FAIL: ") + name); if (!ok) fails++; }
  console.log("  root text length:", text.length);
  if (fails) { console.error("BROWSER GATE FAILED (" + fails + ")"); process.exit(1); }
  console.log("BROWSER GATE PASS");
  process.exit(0);
}, 1200);
