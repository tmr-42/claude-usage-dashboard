#!/usr/bin/env node
// build_artifact.js v3 — assembles the Claude.ai artifact JSX:
// import header + embedded DATA + core + actions module + default export.
const fs = require("fs");
const core = fs.readFileSync("dashboard_core.jsx", "utf8");
const actions = fs.readFileSync("artifact_actions.jsx", "utf8");
const data = fs.readFileSync("public/data.json", "utf8");

const BINDING = "const DATA = window.__APP_DATA__; // __DATA_BINDING__";
if (!core.includes(BINDING)) { console.error("FAIL: data binding marker missing"); process.exit(1); }
const bound = core.replace(BINDING, "const DATA = " + data + ";");

const out = 'import React, { useState, useMemo, useEffect, useRef, useCallback } from "react";\n' +
  bound + "\n" + actions + "\nexport default Dashboard;\n";
const file = "claude-usage-dashboard-2026-07-09-enablement.jsx";
fs.writeFileSync(file, out);
console.log("built", file, "(" + Math.round(out.length / 1024) + " KB)");
