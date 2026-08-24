# Level Agency · Claude usage dashboard — runbook v3 (enablement + brand)

## What changed in v3 (2026-07-22)
- Full Level brand alignment on BOTH surfaces: Inter Tight headings (sentence case),
  DM Sans body, black primary background, grey #D9DEF0 structure, secondary colors
  (#86D5F4 / #FD6EF8 / #8EE34D / #FFAA53) as data accents only — never as font colors,
  black text on colored pills (WCAG rule from brand guide p.12).
- Two new tabs on both surfaces: **Enablement** (dept → team → sub-dept → manager → MOR
  cascade, custom people groups, week-range filter, narrative panel, non-adopter tracking)
  and **Team Trends** (small multiples / overlay / heatmap across any org dimension).
- Architecture change: NO regex-stripping of Slack code anymore. `dashboard_core.jsx`
  contains zero messaging code by construction; `artifact_actions.jsx` is appended only
  in the artifact build. The Vercel guard fails the build if any messaging token appears in core.
- roster.json is a new REQUIRED weekly input (see step 1).
- CSV schema has grown (cache-token columns, web-search count, slack_channel_id):
  cache columns feed cache-efficiency metrics; the rest are ignored.

## Weekly flow
1. **Roster pull (in-session, via Airtable MCP):** Employees table
   `appIiNgRw8PojBJ51 / tblykviXbbb0cVdag`, filter Status = Active
   (choice `selFcUzg8No5LA2br`). Fields: Email address (Level), Preferred First Name,
   First Name, Last Name, Department, Team, Reports to Email, Manager Once Removed Email,
   Sub-Dept Lead Email address (Level) (from Team), **Claude Enterprise Login
   (`fldrgqmVLODFmOgT6`)** — the immutable Claude billing address, HR-maintained.
   Write `roster.json` with `claudeLogin` on every employee record.
   IDENTITY JOIN (2026-08-18): usage rows join on Claude Enterprise Login FIRST,
   primary email as fallback; a person counts as active/adopter if EITHER address
   appears in usage. DM delivery and skip-list checks resolve login -> primary
   email (Slack lives on the primary). Pipeline hard-fails on duplicate logins.
   Supersedes the standalone email_aliases.json bridge — divergent billing
   addresses are now HR-owned in Airtable, not pipeline-owned in the repo.
   (api.airtable.com is NOT in the container network allowlist — the MCP pull is the
   supported path. Alternative if ever needed: n8n webhook proxy, since
   levelagency.app.n8n.cloud IS allowlisted.)
2. `python3 run_pipeline.py claude-usage-YYYY-MM-DD.csv history.json roster.json`
   - append mode for a new week; rebuild mode (tie-out enforced, no append) if the week
     already exists in history.
3. `python3 validate_data.py staging/data.json`  ← HARD GATE (non-zero exit = stop)
4. Normal week: push `public/data.json` only. Shell-change week: `node build_vercel.js`
   then push `public/index.html` too.
5. Gates before ANY delivery/deploy of a rebuilt shell — BOTH must pass:
   - `node ssr_test.js`        (component logic: every tab + every UserDetailRow)
   - `node browser_test.js`    (deploy bootstrap: real index.html in jsdom, real data.json)
6. Artifact: `node build_artifact.js` then `node ssr_test_artifact.js`
   (DM rules: skip list, automated opener, no questions, no max-plan, section order,
   channel-summary compliance).

## Repo hygiene (do this once)
Commit the whole toolchain to a `tools/` folder in tmr-42/claude-usage-dashboard:
run_pipeline.py, validate_data.py, build_vercel.js, build_artifact.js, ssr_test.js,
ssr_test_artifact.js, browser_test.js, dashboard_core.jsx, artifact_actions.jsx, RUNBOOK.md.
GitHub is the durable home — chat download links expire with sessions.
(Vercel only serves `public/`; `tools/` is inert for deploys.)

## Data notes
- Roster join keys on EMAIL only (name fields in Airtable can be stale).
- Usage emails absent from roster → "Unmapped" unit; totals must still tie (gated).
- History re-attribution: org-unit weekly series apply TODAY'S org structure to past
  weeks (standard practice; re-orgs shift historical unit lines, org totals never change).
- Sub-dept dimension currently proxies by sub-dept LEAD (no sub-dept name field exists
  in Airtable). It is ~degenerate with Department today; lights up if a name field is added.
- Known Airtable data-quality items: `jon.krasnoff @level.agency` (stray space, normalized
  at pull), `erin.ferranto@level.agency` referenced as manager but not Active.
