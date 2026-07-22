#!/usr/bin/env node
// build_vercel.js v3 — builds the frozen public/index.html from dashboard_core.jsx.
// Guards: (1) module-syntax sweep, (2) forbidden Slack/DM symbol sweep,
// (3) no </script> in compiled output, (4) gates run separately (ssr_test.js + browser_test.js)
// Bootstrap = 2026-07-21 permanent pattern: NO eval. fetch data.json -> set window.__APP_DATA__
// -> inject component via a REAL <script> element (true global scope) with hook aliases prepended
// -> render window.__Dashboard via explicit handle. CSP-safe (no unsafe-eval dependency).
const fs = require("fs");
const babel = require("@babel/standalone");

const src = fs.readFileSync("dashboard_core.jsx", "utf8");

// Guard 2 (pre): core must contain zero Slack/DM machinery
const FORBIDDEN = ["sendPrompt", "slack", "Slack", "C0ANHN34VEC", "costDMs", "lowDMs", "channelSummary", "buildConsolidatedDM", "api.anthropic.com"];
for (const t of FORBIDDEN) if (src.includes(t)) { console.error("GUARD FAIL: forbidden token in core source:", t); process.exit(1); }

const compiled = babel.transform(src, { presets: [["react", { runtime: "classic", development: false }]] }).code;

// Guard 1: module-syntax sweep on compiled output
// import/export anchored to line start (CSS @import inside strings is legitimate)
if (/^\s*import\s/m.test(compiled) || /^\s*export\s/m.test(compiled)) { console.error("GUARD FAIL: module import/export statement in compiled output"); process.exit(1); }
const BANNED = ["require(", "_jsxDEV", "jsx-runtime", 'from "react"'];
for (const t of BANNED) if (compiled.includes(t)) { console.error("GUARD FAIL: banned token in compiled output:", JSON.stringify(t)); process.exit(1); }
// Guard 3: script-embedding safety
if (compiled.includes("</script>")) { console.error("GUARD FAIL: compiled output contains </script>"); process.exit(1); }

const HOOK_ALIASES = "var useState=React.useState,useMemo=React.useMemo,useEffect=React.useEffect,useRef=React.useRef,useCallback=React.useCallback,Fragment=React.Fragment;\n";

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Level Agency — Claude usage</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@600;700;800;900&family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
<script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<style>html,body{margin:0;background:#000;color:#fff;font-family:'DM Sans',system-ui,sans-serif}</style>
</head>
<body>
<div id="root"><div style="padding:40px;color:#8a8aa0;font-family:system-ui">Loading Level Claude usage dashboard…</div></div>
<script type="text/plain" id="appsrc">
${compiled}
</script>
<script>
(function () {
  function showError(msg) {
    document.getElementById("root").innerHTML =
      '<div style="padding:40px;color:#FFAA53;font-family:system-ui;white-space:pre-wrap">Failed to load dashboard: ' +
      String(msg).replace(/</g, "&lt;") + "</div>";
  }
  window.addEventListener("error", function (e) {
    if (!window.__RENDERED__) showError(e.message || "script error");
  });
  fetch("data.json")
    .then(function (r) { if (!r.ok) throw new Error("data.json HTTP " + r.status); return r.json(); })
    .then(function (data) {
      window.__APP_DATA__ = data;
      var hookAliases = ${JSON.stringify(HOOK_ALIASES)};
      var appsrc = document.getElementById("appsrc").textContent;
      var s = document.createElement("script"); // real script element = true global scope, no eval
      s.textContent = hookAliases + appsrc + "\\nwindow.__Dashboard = Dashboard;";
      document.body.appendChild(s);
      if (typeof window.__Dashboard !== "function") throw new Error("component did not register");
      var root = ReactDOM.createRoot(document.getElementById("root"));
      root.render(React.createElement(window.__Dashboard));
      window.__RENDERED__ = true;
      setTimeout(function () { // post-render self-check
        var t = document.getElementById("root").textContent || "";
        if (t.length < 200 || t.indexOf("Loading Level") !== -1) showError("render self-check failed (empty output)");
      }, 300);
    })
    .catch(function (e) { showError(e && e.message ? e.message : e); });
})();
</script>
</body>
</html>`;

fs.mkdirSync("public", { recursive: true });
fs.writeFileSync("public/index.html", html);
console.log("built public/index.html (" + Math.round(html.length / 1024) + " KB) — guards 1–3 passed");
