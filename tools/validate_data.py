#!/usr/bin/env python3
"""validate_data.py v3 — hard gate before deploy. Non-zero exit = do not promote/deploy."""
import json, sys

def fail(msg): print("FAIL:", msg); sys.exit(1)
def ok(msg): print("  ok:", msg)

d = json.load(open(sys.argv[1] if len(sys.argv)>1 else "staging/data.json"))

# 1. required keys
req = ["summary","leaderboard","allUsers","maxPlan","coworkOpus","opusHeavy","powerUsers",
       "legacyModels","lowEngagement","products","models","roster","enablement","history"]
missing = [k for k in req if k not in d]
if missing: fail(f"missing keys: {missing}")
ok("all required keys present (incl. roster, enablement)")

# 2. no DM/Slack leakage into Vercel data
leaks = [k for k in ("costDMs","lowDMs","channelSummary") if k in d]
if leaks: fail(f"DM payload leaked into data.json: {leaks}")
blob = json.dumps(d.get("enablement",{})) 
for bad in ("sendPrompt","C0ANHN34VEC","slack_send_message"):
    if bad in blob: fail(f"forbidden token in enablement: {bad}")
ok("no DM/Slack leakage")

# 3. core tie-outs
s = d["summary"]
if len(d["allUsers"]) != s["activeUsers"]: fail("allUsers count != activeUsers")
tot = round(sum(u["spend"] for u in d["allUsers"]), 2)
if abs(tot - s["totalSpend"]) > 0.05: fail(f"sum(allUsers.spend)={tot} != totalSpend={s['totalSpend']}")
ok(f"user tie-out: {s['activeUsers']} users, ${tot:,.2f}")

# 4. per-user matrix col totals == user spend
for u in d["allUsers"]:
    if abs(sum(u["productModelMatrix"]["colTotals"]) - u["spend"]) > 0.05:
        fail(f"matrix tie-out failed for {u['email']}")
ok("productModelMatrix colTotals tie out for all users")

# 5. enablement reconciliation: each dimension's unit spends sum to org total
for dim, units in d["enablement"]["dimensions"].items():
    ds = round(sum(v["spend"] for v in units.values()), 2)
    if abs(ds - s["totalSpend"]) > 0.05: fail(f"enablement[{dim}] spend {ds} != {s['totalSpend']}")
ok(f"enablement dimensions reconcile to totalSpend across {len(d['enablement']['dimensions'])} dimensions")

# 6. every allUsers entry carries org attrs + cacheHitRate; unmapped users flagged
un = [u["email"] for u in d["allUsers"] if not u.get("mapped")]
if any("org" not in u or "cacheHitRate" not in u for u in d["allUsers"]): fail("missing org/cacheHitRate on allUsers")
ok(f"org join present on all users ({len(un)} unmapped -> Unmapped bucket: {un[:3]}{'...' if len(un)>3 else ''})")

# 7. non-users consistency: roster - active users (match primary email OR Claude Enterprise Login)
active_emails = {u["email"] for u in d["allUsers"]}
def _active(e): return e in active_emails or d["roster"][e].get("claudeLogin", e) in active_emails
expected = len(d["roster"]) - sum(1 for e in d["roster"] if _active(e))
if len(d["enablement"]["nonUsers"]) != expected: fail(f"nonUsers {len(d['enablement']['nonUsers'])} != expected {expected}")
ok(f"nonUsers = {len(d['enablement']['nonUsers'])} (roster {len(d['roster'])} - mapped active)")

# 8. history shape + week alignment
h = d["history"]
if h["weeks"][-1]["weekStartISO"] != s["weekStartISO"]: fail("history last week != summary week")
isos = [w["weekStartISO"] for w in h["weeks"]]
if len(isos) != len(set(isos)): fail("duplicate weeks in history")
if [w["weekStartISO"] for w in d["enablement"]["weeks"]] != isos: fail("enablement weeks != history weeks")
ok(f"history aligned: {len(isos)} weeks, latest {isos[-1]}")

# 9. narratives exist for every department
depts = set(d["enablement"]["dimensions"]["department"])
if not depts.issubset(set(d["enablement"]["narratives"])): fail("missing department narratives")
ok(f"narratives present for {len(depts)} departments")

# 10. identity-join integrity: claudeLogin present on every roster record; no login
#     maps to two people; anyone whose usage email matches a claudeLogin is mapped
logins = {}
for e, r in d["roster"].items():
    L = r.get("claudeLogin")
    if not L: fail(f"roster record missing claudeLogin: {e}")
    if L in logins: fail(f"duplicate claudeLogin {L}: {logins[L]} and {e}")
    logins[L] = e
mism = [u["email"] for u in d["allUsers"] if u["email"] in logins and not u.get("mapped")]
if mism: fail(f"users with a roster claudeLogin left unmapped: {mism}")
ok(f"identity join: {len(logins)} logins unique; login-joined users all mapped")

print("PASS — data.json is valid for promotion")
