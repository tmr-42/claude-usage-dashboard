#!/usr/bin/env node
// build_shell.js v1 — regenerates public/index.html from dashboard_core.jsx.
//
// The shell (head, CDN tags, #root, bootstrap IIFE) is FROZEN: this script splices a
// freshly compiled component into the <script type="text/plain" id="appsrc"> block and
// touches nothing else. Every past blank-page incident came from regenerating the whole
// file, so the wrapper is preserved byte-for-byte and diffed to prove it.
//
// Compile settings are load-bearing, not stylistic:
//   runtime:"classic"    -> React.createElement, NOT jsx-runtime imports
//   development:false    -> no _jsxDEV
// Output is then scanned for module syntax, which cannot execute inside a UMD <script>.
const fs = require("fs");
const babel = require("@babel/standalone");

const OPEN = '<script type="text/plain" id="appsrc">';
const CLOSE = "</script>";
const shellPath = "public/index.html";

const existing = fs.readFileSync(shellPath, "utf8");
const start = existing.indexOf(OPEN);
if (start === -1) { console.error("FAIL: appsrc block not found in " + shellPath); process.exit(1); }
const bodyStart = start + OPEN.length;
const bodyEnd = existing.indexOf(CLOSE, bodyStart);
if (bodyEnd === -1) { console.error("FAIL: appsrc block unterminated"); process.exit(1); }

const src = fs.readFileSync("dashboard_core.jsx", "utf8")
  .split("\n").filter(l => !/^\s*import\s/.test(l)).join("\n");
const compiled = babel.transform(src, {
  presets: [["react", { runtime: "classic", development: false }]]
}).code;

// Statement-anchored: a bare substring scan trips on the CSS "@import url(...)" inside
// FONT_CSS, which is a string literal and perfectly safe. What actually breaks a UMD
// <script> is module syntax at statement position.
const BANNED = [
  [/^\s*import\s/m, "import statement"],
  [/^\s*export\s/m, "export statement"],
  [/\brequire\s*\(/, "require() call"],
  [/_jsxDEV/, "_jsxDEV (dev runtime)"],
  [/jsx-runtime/, "jsx-runtime (automatic runtime)"],
  [/from\s+["']react["']/, 'from "react"'],
];
for (const [re, label] of BANNED) {
  if (re.test(compiled)) { console.error("FAIL: compiled output contains " + label); process.exit(1); }
}
if (!compiled.includes("function Dashboard")) { console.error("FAIL: Dashboard missing from compiled output"); process.exit(1); }

const out = existing.slice(0, bodyStart) + "\n" + compiled + "\n" + existing.slice(bodyEnd);

// prove the wrapper is untouched: everything outside the appsrc block must be identical
const wrapperBefore = existing.slice(0, bodyStart) + existing.slice(bodyEnd);
const wrapperAfter = out.slice(0, bodyStart) + out.slice(out.indexOf(CLOSE, bodyStart));
if (wrapperBefore !== wrapperAfter) { console.error("FAIL: shell wrapper changed — refusing to write"); process.exit(1); }

fs.writeFileSync(shellPath, out);
console.log("rebuilt " + shellPath + " (" + Math.round(out.length / 1024) + " KB, component " +
  Math.round(compiled.length / 1024) + " KB); wrapper unchanged");
