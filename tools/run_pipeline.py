#!/usr/bin/env python3
"""
run_pipeline.py — weekly Claude usage pipeline (v3, enablement-aware)
Inputs : claude-usage-YYYY-MM-DD.csv, history.json, roster.json (from Airtable MCP pull)
Outputs: staging/data.json, staging/history.json  (promoted only if validate_data.py passes)

v3 changes vs v2 (2026-06/07 toolchain):
- roster.json is a REQUIRED input; every user is joined to org attributes (dept/team/mgr/MOR/subLead)
- new data.json keys: roster, enablement (orgUnits per dimension w/ weekly series, nonUsers, narratives)
- rebuild mode: if the CSV's week already exists in history, do NOT append; regenerate data.json
  against existing history and require exact tie-out to the stored week aggregates.
- cache efficiency retained (org + per-user cacheHitRate); token-density flag remains retired.
- legacy flag RETIRED (2026-08-24); model usage is reported by version, and history.weeks[]
  now carries per-version modelSpend for deprecation scoping.
"""
import csv, json, sys, os, re
from collections import defaultdict
from datetime import date, timedelta

SKIP_LIST = {f"{u}@level.agency" for u in ("matt.rose","dave.brong","bill.buchanan","patrick.patterson")}

# is_legacy() retired 2026-08-24 (TMR). A version-number rule cannot answer the only
# question that mattered — deprecation exposure — and it was never computed against price.
# Model usage is REPORTED by exact version (data.models, Breakdowns tab) and now accrues
# per-version in history.weeks[].modelSpend, so a retirement announcement can be scoped
# from data instead of nudged weekly. Migration is an event-driven project, not a flag.

def bucket(model_norm):
    if "_opus_"   in model_norm or model_norm.endswith("_opus"):   return "opus"
    if "_sonnet_" in model_norm or model_norm.endswith("_sonnet"): return "sonnet"
    if "_haiku_"  in model_norm or model_norm.endswith("_haiku"):  return "haiku"
    if "_fable_"  in model_norm or model_norm.endswith("_fable"):  return "fable"
    return "other"   # mythos / unknown

def week_label(iso):
    d0 = date.fromisoformat(iso); d1 = d0 + timedelta(days=6)
    M = ["January","February","March","April","May","June","July","August","September","October","November","December"]
    if d0.month == d1.month: return f"{M[d0.month-1]} {d0.day}\u2013{d1.day}, {d0.year}"
    return f"{M[d0.month-1]} {d0.day}\u2013{M[d1.month-1]} {d1.day}, {d0.year}"

def main(csv_path, history_path, roster_path, outdir="staging"):
    iso = re.search(r"(\d{4}-\d{2}-\d{2})", os.path.basename(csv_path)).group(1)
    assert date.fromisoformat(iso).weekday() == 3, f"{iso} is not a Thursday"
    os.makedirs(outdir, exist_ok=True)

    roster_doc = json.load(open(roster_path)); ROSTER = roster_doc["employees"]
    # Identity join (2026-08-18): Airtable now carries "Claude Enterprise Login"
    # (fldrgqmVLODFmOgT6) — the immutable Claude billing address. Usage rows join on
    # login FIRST, primary email as fallback; a person counts as active if EITHER
    # address appears in usage. Supersedes the standalone email_aliases.json bridge.
    LOGIN2PRIMARY = {}
    for pe, rec in ROSTER.items():
        login = (rec.get("claudeLogin") or pe).strip().lower()
        if login in LOGIN2PRIMARY:
            raise SystemExit(f"FATAL: duplicate Claude Enterprise Login {login} in roster")
        LOGIN2PRIMARY[login] = pe
    def roster_for(usage_email):
        pe = LOGIN2PRIMARY.get(usage_email.strip().lower())
        if pe: return ROSTER[pe]
        return ROSTER.get(usage_email)
    def is_active_person(primary_email, users):
        rec = ROSTER[primary_email]
        return primary_email in users or (rec.get("claudeLogin") or primary_email) in users
    # ---------- people_overrides: classification for non-roster accounts ----------
    # Airtable is the system of record for EMPLOYEES. This file is the system of record
    # for everyone else who legitimately appears in Claude billing (contractors, departed
    # accounts with residual usage, leave, service buckets). It never overrides a person
    # who is Active in Airtable — that direction is a hard fail.
    ov_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "people_overrides.json")
    OVERRIDES = json.load(open(ov_path))["people"] if os.path.exists(ov_path) else {}
    today = date.today().isoformat()
    for oe, o in OVERRIDES.items():
        if o["classification"] in ("departed", "leave") and oe in ROSTER:
            raise SystemExit(f"FATAL: {oe} is classified '{o['classification']}' in people_overrides.json "
                             f"but is ACTIVE in the Airtable roster. Resolve before running.")
        if o.get("reviewBy") and o["reviewBy"] < today:
            print(f"[warn] people_overrides: {oe} ({o['classification']}) passed reviewBy {o['reviewBy']} — confirm still accurate")

    history = json.load(open(history_path))
    rows = list(csv.DictReader(open(csv_path)))

    # ---------- per-user aggregation ----------
    users = {}
    for r in rows:
        e = r["user_email"]
        u = users.setdefault(e, {"email": e, "spend": 0.0, "requests": 0, "promptTokens": 0,
                                 "completionTokens": 0, "cacheRead": 0,
                                 "products": defaultdict(float), "models": defaultdict(float),
                                 "modelDetail": defaultdict(float),
                                 "pm": defaultdict(lambda: defaultdict(float)),
                                 "opusChat": 0.0, "chat": 0.0, "coworkOpus": 0.0})
        spend = float(r["total_net_spend_usd"]); req = int(r["total_requests"] or 0)
        pt = int(r["total_prompt_tokens"] or 0); ct = int(r["total_completion_tokens"] or 0)
        cr = int(r.get("total_cache_read_tokens") or 0)
        prod = r["product"]; model = r["model"].replace("-", "_"); b = bucket(model)
        u["spend"] += spend; u["requests"] += req; u["promptTokens"] += pt
        u["completionTokens"] += ct; u["cacheRead"] += cr
        u["products"][prod] += spend; u["models"][b] += spend; u["modelDetail"][model] += spend
        u["pm"][prod][b] += spend
        if prod == "Chat":
            u["chat"] += spend
            if b == "opus": u["opusChat"] += spend
        if prod == "Cowork" and b == "opus": u["coworkOpus"] += spend

    # roster join + display name (roster wins; else derive from email)
    def derived_name(e):
        base = e.split("@")[0]
        return " ".join(w.capitalize() for w in re.split(r"[._-]+", base))
    for e, u in users.items():
        R = roster_for(e)
        O = OVERRIDES.get(e)
        u["name"] = (R["name"] if R else (O["name"] if O else
                     ("Org service usage" if "@" not in e else derived_name(e))))
        u["org"] = {k: (R[k] if R else None) for k in ("department","team","managerEmail","morEmail","subDeptLeadEmail")}
        if not R and O:
            # classified non-roster account: route to its own named org unit instead of "Unmapped"
            u["org"]["department"] = O.get("department") or "Unmapped"
            u["org"]["team"] = O.get("team") or "Unmapped"
        u["mapped"] = bool(R)
        u["classification"] = "employee" if R else (O["classification"] if O else "unclassified")
        # dmEligible is a hard gate on EVERY DM category, applied on top of skip list + thresholds
        u["dmEligible"] = bool(O.get("dmEligible", False)) if (O and not R) else (
            e not in SKIP_LIST and LOGIN2PRIMARY.get(e.strip().lower(), e) not in SKIP_LIST and "@" in e)

    total = round(sum(u["spend"] for u in users.values()), 2)
    n = len(users)
    tot_pt = sum(u["promptTokens"] for u in users.values())
    tot_cr = sum(u["cacheRead"] for u in users.values())
    org_cache = round(100 * tot_cr / tot_pt, 1) if tot_pt else 0.0

    # ---------- flags ----------
    def s(u): return round(u["spend"], 2)
    maxPlan   = [u for u in users.values() if u["spend"] > 200]
    coworkOp  = [u for u in users.values() if u["coworkOpus"] > 0]
    opusHeavy = [u for u in users.values() if u["chat"] > 0 and u["opusChat"]/u["chat"] >= 0.30]
    lowEng    = [u for u in users.values() if u["spend"] < 10]
    # power users are published as org efficiency benchmarks, so their $/req must be
    # REAL: exclude anyone with a $0.00-metered surface (Cowork/Claude Tag/Research
    # can report zero net spend against real request volume) and any non-person row.
    def fully_metered(u):
        return "@" in u["email"] and all(v > 0 for v in u["products"].values())
    power     = sorted([u for u in users.values()
                        if u["spend"] > 0 and u["requests"] >= 500 and fully_metered(u)
                        and u["models"].get("opus",0)/max(u["spend"],1e-9) < 0.15
                        and u["spend"]/max(u["requests"],1) < 0.10],
                       key=lambda x: -x["requests"])[:10]

    uw = history["userWeeks"]
    def streak(e):
        c = 0
        for w in reversed(uw.get(e, [])):
            if w["spend"] < 10: c += 1
            else: break
        return c

    def flags_for(u):
        f = []
        if u["spend"] > 200: f.append("max-plan")
        if u["coworkOpus"] > 0: f.append("cowork-opus")
        if u["chat"] > 0 and u["opusChat"]/u["chat"] >= 0.30: f.append("opus")
        if u["spend"] < 10: f.append("low-engagement")
        return f

    # ---------- rebuild vs append ----------
    existing = next((w for w in history["weeks"] if w["weekStartISO"] == iso), None)
    mode = "rebuild" if existing else "append"
    label = existing["weekOf"] if existing else week_label(iso)

    week_summary = {
        "weekOf": label, "weekStartISO": iso,
        "totalSpend": total, "activeUsers": n, "avgSpend": round(total/n, 2),
        "opusSpend": round(sum(u["models"].get("opus",0) for u in users.values()),2),
        "sonnetSpend": round(sum(u["models"].get("sonnet",0) for u in users.values()),2),
        "haikuSpend": round(sum(u["models"].get("haiku",0) for u in users.values()),2),
        "fableSpend": round(sum(u["models"].get("fable",0) for u in users.values()),2),
        "otherSpend": round(sum(u["models"].get("other",0) for u in users.values()),2),
        "cacheHitRate": org_cache,
        # per-version model spend (added 2026-08-24). Family buckets above are kept for
        # continuity with the prior 23 weeks; this accrues version-level trend going forward.
        "modelSpend": {},
        "flagCounts": {"maxPlan": len(maxPlan), "coworkOpus": len(coworkOp), "opusHeavy": len(opusHeavy),
                       "lowEngagement": len(lowEng)},
        "productSpend": {}
    }
    verS = defaultdict(float)
    for r in rows:
        verS[r["model"].replace("-","_")] += float(r["total_net_spend_usd"])
    week_summary["modelSpend"] = {m: round(v,2) for m, v in sorted(verS.items(), key=lambda x:-x[1])}
    prodS = defaultdict(float)
    for u in users.values():
        for p, v in u["products"].items(): prodS[p] += v
    week_summary["productSpend"] = {p: round(v,2) for p, v in sorted(prodS.items(), key=lambda x:-x[1])}

    if mode == "rebuild":
        for k in ("totalSpend","activeUsers"):
            assert abs((existing[k] if isinstance(existing[k],(int,float)) else 0) - week_summary[k]) < 0.01, \
                f"rebuild tie-out FAILED on {k}: history={existing[k]} recomputed={week_summary[k]}"
        print(f"[rebuild] week {iso} already in history — tie-out OK (${total:,.2f} / {n}); no append")
    else:
        history["weeks"].append(week_summary)
        for e, u in users.items():
            uw.setdefault(e, []).append({"weekOf": label, "weekStartISO": iso, "spend": s(u),
                "requests": u["requests"],
                "opusPct": round(100*u["models"].get("opus",0)/u["spend"]) if u["spend"] else 0,
                "avgPromptTokens": round(u["promptTokens"]/u["requests"]) if u["requests"] else 0})
        print(f"[append] week {iso} appended")

    # ---------- allUsers ----------
    def mix(d): 
        t = sum(d.values()) or 1
        return [{"name": k, "spend": round(v,2), "pct": round(100*v/t)} for k,v in sorted(d.items(), key=lambda x:-x[1])]
    allUsers = []
    for e, u in sorted(users.items(), key=lambda kv: -kv[1]["spend"]):
        prods = sorted(u["pm"].keys()); buckets = ["opus","sonnet","haiku","fable","other"]
        matrix = {"products": prods, "models": buckets,
                  "cells": [[round(u["pm"][p].get(b,0),2) for b in buckets] for p in prods],
                  "rowTotals": [round(sum(u["pm"][p].values()),2) for p in prods],
                  "colTotals": [round(sum(u["pm"][p].get(b,0) for p in prods),2) for b in buckets]}
        allUsers.append({
            "name": u["name"], "email": e, "spend": s(u), "requests": u["requests"],
            "cpr": round(u["spend"]/u["requests"], 4) if u["requests"] else 0,
            "avgPromptTokens": round(u["promptTokens"]/u["requests"]) if u["requests"] else 0,
            "cacheHitRate": round(100*u["cacheRead"]/u["promptTokens"],1) if u["promptTokens"] else 0,
            "opusPct": round(100*u["models"].get("opus",0)/u["spend"]) if u["spend"] else 0,
            "products": {k: round(v,2) for k,v in u["products"].items()},
            "models": {k: round(v,2) for k,v in u["models"].items()},
            "productMix": mix(u["products"]), "modelMix": mix(u["models"]),
            "productModelMatrix": matrix,
            "sparkline": [w["spend"] for w in uw.get(e, [])] or [s(u)],
            "flags": flags_for(u),
            "org": u["org"], "mapped": u["mapped"],
            "classification": u["classification"], "dmEligible": u["dmEligible"],
        })

    # ---------- enablement layer ----------
    def unit_key(u, dim):
        o = u["org"]
        v = {"department": o["department"], "team": o["team"],
             "manager": o["managerEmail"], "mor": o["morEmail"], "subDeptLead": o["subDeptLeadEmail"]}[dim]
        return v if v else "Unmapped"
    email2unit = {dim: {e: unit_key(u, dim) for e, u in users.items()} for dim in
                  ("department","team","manager","mor","subDeptLead")}
    # roster-wide membership (incl. non-users) for filters + non-adopter counts
    roster_units = defaultdict(lambda: defaultdict(list))
    for e, R in ROSTER.items():
        roster_units["department"][R["department"]].append(e)
        roster_units["team"][R["team"]].append(e)
        if R["managerEmail"]: roster_units["manager"][R["managerEmail"]].append(e)
        if R["morEmail"]: roster_units["mor"][R["morEmail"]].append(e)
        if R["subDeptLeadEmail"]: roster_units["subDeptLead"][R["subDeptLeadEmail"]].append(e)

    weeks_meta = [{"weekOf": w["weekOf"], "weekStartISO": w["weekStartISO"]} for w in history["weeks"]]
    def unit_series(members):
        out = []
        for wm in weeks_meta:
            iso_w = wm["weekStartISO"]; sp = 0.0; rq = 0; act = 0
            for m in members:
                for w in uw.get(m, []):
                    if w["weekStartISO"] == iso_w:
                        sp += w["spend"]; rq += w["requests"]; act += 1; break
            out.append({"weekStartISO": iso_w, "spend": round(sp,2), "requests": rq, "activeUsers": act})
        return out

    enablement = {"dimensions": {}, "weeks": weeks_meta, "nonUsers": [], "narratives": {}}
    for dim in ("department","team","manager","mor","subDeptLead"):
        units = {}
        names = set(roster_units[dim]) | set(email2unit[dim].values())
        for uname in sorted(names):
            members_roster = roster_units[dim].get(uname, [])
            members_usage = [e for e, v in email2unit[dim].items() if v == uname]
            members_all = sorted(set(members_roster) | set(members_usage))
            cur_sp = round(sum(users[e]["spend"] for e in members_usage), 2)
            cur_rq = sum(users[e]["requests"] for e in members_usage)
            pt = sum(users[e]["promptTokens"] for e in members_usage)
            cr = sum(users[e]["cacheRead"] for e in members_usage)
            mm = defaultdict(float); pm = defaultdict(float)
            for e in members_usage:
                for k, v in users[e]["models"].items(): mm[k] += v
                for k, v in users[e]["products"].items(): pm[k] += v
            label_n = ROSTER[uname]["name"] if uname in ROSTER else uname
            units[uname] = {
                "label": label_n, "rosterCount": len(members_roster),
                "activeUsers": len(members_usage),
                "nonAdopters": len([e for e in members_roster if not is_active_person(e, users)]),
                "spend": cur_sp, "requests": cur_rq,
                "cacheHitRate": round(100*cr/pt,1) if pt else 0,
                "models": {k: round(v,2) for k,v in mm.items()},
                "products": {k: round(v,2) for k,v in sorted(pm.items(), key=lambda x:-x[1])},
                "members": members_all,
                "series": unit_series(members_all),
            }
        enablement["dimensions"][dim] = units

    enablement["nonUsers"] = sorted([
        {"email": e, "name": R["name"], "department": R["department"], "team": R["team"],
         "managerEmail": R["managerEmail"]}
        for e, R in ROSTER.items() if not is_active_person(e, users)], key=lambda x: (x["department"], x["name"]))

    # deterministic template narratives per department (richer prose layered in at artifact time)
    for dname, unit in enablement["dimensions"]["department"].items():
        srs = [w for w in unit["series"]]
        cur = srs[-1]["spend"] if srs else 0
        prev = srs[-2]["spend"] if len(srs) > 1 else None
        delta = (f"{'up' if cur>=prev else 'down'} {abs(cur-prev)/prev*100:.0f}% week over week" 
                 if prev and prev > 0 else "first tracked week")
        top_prod = next(iter(unit["products"]), None)
        adoption = f"{unit['activeUsers']} of {unit['rosterCount']} team members active" if unit["rosterCount"] else f"{unit['activeUsers']} active users"
        parts = [f"{dname} spent ${cur:,.2f} this week ({delta}).", f"{adoption}."]
        if top_prod: parts.append(f"Top surface: {top_prod} (${unit['products'][top_prod]:,.2f}).")
        if unit["nonAdopters"] > 0: parts.append(f"{unit['nonAdopters']} team members had no Claude usage this week.")
        if unit["cacheHitRate"]: parts.append(f"Cache hit rate: {unit['cacheHitRate']}%.")
        enablement["narratives"][dname] = " ".join(parts)

    # ---------- top-level data ----------
    leaderboard = allUsers[:30]
    models_detail = defaultdict(lambda: {"spend":0.0,"requests":0})
    for r in rows:
        m = r["model"].replace("-","_")
        models_detail[m]["spend"] += float(r["total_net_spend_usd"]); models_detail[m]["requests"] += int(r["total_requests"] or 0)
    data = {
        "summary": {"totalSpend": total, "activeUsers": n, "avgSpend": round(total/n,2),
                    "top10Spend": round(sum(u["spend"] for u in allUsers[:10]),2),
                    "top10Pct": round(100*sum(u["spend"] for u in allUsers[:10])/total),
                    "cacheHitRate": org_cache, "weekOf": label, "weekStartISO": iso},
        "leaderboard": leaderboard, "allUsers": allUsers,
        "maxPlan": [{"email": u["email"], "name": u["name"], "weeklySpend": s(u), "projectedMonthly": round(u["spend"]*4.33,2)} for u in sorted(maxPlan,key=lambda x:-x["spend"])],
        "coworkOpus": [{"email": u["email"], "name": u["name"], "spend": round(u["coworkOpus"],2), "requests": u["requests"]} for u in sorted(coworkOp,key=lambda x:-x["coworkOpus"])],
        "opusHeavy": [{"email": u["email"], "name": u["name"], "opusSpend": round(u["opusChat"],2), "chatSpend": round(u["chat"],2), "opusPct": round(100*u["opusChat"]/u["chat"])} for u in sorted(opusHeavy,key=lambda x:-x["opusChat"])],
        "powerUsers": [{"email": u["email"], "name": u["name"], "requests": u["requests"], "spend": s(u), "cpr": round(u["spend"]/u["requests"],4), "opusPct": round(100*u["models"].get("opus",0)/u["spend"]) if u["spend"] else 0} for u in power],
        "lowEngagement": [{"email": u["email"], "name": u["name"], "spend": s(u), "requests": u["requests"], "opusPct": round(100*u["models"].get("opus",0)/u["spend"]) if u["spend"] else 0, "consecutiveLowWeeks": streak(u["email"]), "dmEligible": streak(u["email"])>=2 and u["dmEligible"], "classification": u["classification"]} for u in sorted(lowEng,key=lambda x:x["spend"])],
        "classifications": {c: {"users": sum(1 for u in users.values() if u["classification"]==c),
                               "spend": round(sum(u["spend"] for u in users.values() if u["classification"]==c),2)}
                            for c in sorted({u["classification"] for u in users.values()})},
        "overrides": {e: {k: o.get(k) for k in ("classification","reason","reviewBy")} for e, o in OVERRIDES.items()},
        "products": [{"name": p, "spend": round(v,2)} for p,v in sorted(prodS.items(), key=lambda x:-x[1])],
        "models": [{"name": m, "spend": round(v["spend"],2), "requests": v["requests"]} for m,v in sorted(models_detail.items(), key=lambda x:-x[1]["spend"])],
        "roster": {e: {"name": R["name"], "department": R["department"], "team": R["team"],
                       "managerEmail": R["managerEmail"], "morEmail": R["morEmail"],
                       "subDeptLeadEmail": R["subDeptLeadEmail"],
                       "claudeLogin": R.get("claudeLogin") or e} for e, R in ROSTER.items()},
        "enablement": enablement,
        "history": history,
    }
    json.dump(data, open(f"{outdir}/data.json","w"))
    json.dump(history, open(f"{outdir}/history.json","w"), indent=1)
    print(f"staged: {outdir}/data.json ({os.path.getsize(outdir+'/data.json')//1024} KB), history.json ({len(history['weeks'])} weeks)")
    return 0

if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:4]))
