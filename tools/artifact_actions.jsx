// =============================================================================
// ARTIFACT-ONLY module — Slack Actions tab, DM builders, channel summary,
// AI narrative hook. This file is NEVER included in the Vercel build.
// =============================================================================
const SKIP_LIST = ["matt.rose@level.agency", "dave.brong@level.agency", "bill.buchanan@level.agency", "patrick.patterson@level.agency"];
const AUTOMATED_OPENER = "Quick automated note from the weekly Claude usage report \u2014 this goes out to everyone whose usage matched a few optimization patterns this week; nobody is monitoring your individual activity in real time.";
const CLOSER = "That\u2019s everything \u2014 no reply needed. These notes are generated automatically each week so everyone gets the most value out of the org\u2019s Claude setup.";

// Usage emails are Claude Enterprise Logins; Slack lives on the primary HR email.
// Resolve login -> primary for all Slack delivery and skip-list checks.
const LOGIN2PRIMARY = (() => {
  const m = {};
  Object.entries(DATA.roster || {}).forEach(([primary, r]) => { m[(r.claudeLogin || primary).toLowerCase()] = primary; });
  return m;
})();
function primaryFor(email) { return LOGIN2PRIMARY[(email || "").toLowerCase()] || email; }
function dmFirstName(email) {
  const pr = DATA.roster[primaryFor(email)];
  if (pr) return pr.name.split(" ")[0];
  const r = DATA.roster[email];
  if (r) return r.name.split(" ")[0];
  const u = DATA.allUsers.find(x => x.email === email);
  return u ? u.name.split(" ")[0] : email.split("@")[0].split(".")[0];
}
function sectionCowork(c) {
  return "*Cowork \u2192 Opus routing*\nYour Cowork automations ran " + fmt(c.spend) +
    " on Opus models this week. Try setting your Cowork default model to Sonnet 5 for routine automated tasks \u2014 it delivers the same outcomes on most workflows at a fraction of the cost, and Opus stays available for runs that genuinely need deeper reasoning. One default-model change usually covers it.";
}
function sectionOpus(o) {
  return "*Opus in Chat*\n" + o.opusPct + "% of your Chat spend this week (" + fmt(o.opusSpend) + " of " + fmt(o.chatSpend) +
    ") ran on Opus models. For everyday drafting, research, and analysis, Sonnet 5 is tuned to deliver the same quality faster and at much lower cost \u2014 the model picker in the chat composer switches it per conversation. Opus earns its premium on long, multi-step reasoning work.";
}
function sectionLegacy(l) {
  return "*Legacy models*\nYou spent " + fmt(l.spend) + " on deprecated model versions (" + l.models.map(formatModel).join(", ") +
    "). Switching to the current lineup (Sonnet 5 / Opus 5) gets you measurably better quality at the same or lower price \u2014 usually just a default-model update wherever these are configured.";
}
function buildConsolidatedDMs() {
  const byEmail = {};
  const ensure = (email) => byEmail[email] || (byEmail[email] = { email, sections: {} });
  DATA.coworkOpus.forEach(c => { ensure(c.email).sections.cowork = sectionCowork(c); });
  DATA.opusHeavy.forEach(o => { if (o.opusSpend >= 10) ensure(o.email).sections.opus = sectionOpus(o); });
  DATA.legacyModels.forEach(l => { if (l.spend >= 5) ensure(l.email).sections.legacy = sectionLegacy(l); });
  const spendOf = e => { const u = DATA.allUsers.find(x => x.email === e); return u ? u.spend : 0; };
  const costDMs = Object.values(byEmail)
    .filter(d => spendOf(d.email) >= 100 && !SKIP_LIST.includes(primaryFor(d.email)) && Object.keys(d.sections).length > 0)
    .map(d => ({
      email: d.email, slackEmail: primaryFor(d.email), name: dmFirstName(d.email), spend: spendOf(d.email),
      flags: Object.keys(d.sections),
      body: "Hey " + dmFirstName(d.email) + ",\n\n" + AUTOMATED_OPENER + "\n\n" +
        ["cowork", "opus", "legacy"].filter(k => d.sections[k]).map(k => d.sections[k]).join("\n\n") +
        "\n\n" + CLOSER,
    }))
    .sort((a, b) => b.spend - a.spend);
  const hasZeroMeteredSurface = (email) => {
    const u = DATA.allUsers.find(x => x.email === email);
    if (!u) return false;
    if (email.indexOf("@") === -1) return true; // org service account, never a person
    return Object.values(u.products || {}).some(v => v === 0);
  };
  const lowEligible = DATA.lowEngagement.filter(u => u.dmEligible);
  const heldMetering = lowEligible.filter(u => hasZeroMeteredSurface(u.email)).map(u => {
    const a = DATA.allUsers.find(x => x.email === u.email) || {};
    const zero = Object.entries(a.products || {}).filter(([, v]) => v === 0).map(([p]) => p);
    return { email: u.email, weeks: u.consecutiveLowWeeks, requests: a.requests || 0,
             spend: u.spend, surfaces: zero.length ? zero : ["service account"] };
  });
  const lowDMs = lowEligible
    .filter(u => !hasZeroMeteredSurface(u.email) && !SKIP_LIST.includes(primaryFor(u.email)))
    .map(u => ({
      email: u.email, slackEmail: primaryFor(u.email), name: dmFirstName(u.email), weeks: u.consecutiveLowWeeks,
      body: "Hey " + dmFirstName(u.email) + ",\n\n" + AUTOMATED_OPENER + "\n\nThis is your " + u.consecutiveLowWeeks +
        (u.consecutiveLowWeeks === 2 ? "nd" : u.consecutiveLowWeeks === 3 ? "rd" : "th") +
        " consecutive week under $10 of Claude usage. If Claude hasn\u2019t clicked for your workflow yet, the fastest wins for most roles are Chat for drafting and research, and Cowork for repetitive multi-step work \u2014 the enablement guides in #claude-utilization cover both in about ten minutes.\n\n" + CLOSER,
    }));
  return { costDMs, lowDMs, heldMetering };
}
function generateChannelSummary() {
  const s = DATA.summary;
  const w = DATA.history.weeks[DATA.history.weeks.length - 1];
  const fc = w.flagCounts;
  const mm = [["Sonnet", w.sonnetSpend], ["Opus", w.opusSpend], ["Fable", w.fableSpend || 0], ["Haiku", w.haikuSpend], ["Other", w.otherSpend || 0]]
    .filter(x => x[1] > 0).map(x => x[0] + " " + fmt(x[1]) + " (" + Math.round(100 * x[1] / s.totalSpend) + "%)").join(" \u00b7 ");
  const prods = Object.entries(w.productSpend).slice(0, 4).map(([p, v]) => p + " " + fmt(v)).join(" \u00b7 ");
  const power = DATA.powerUsers.slice(0, 5).map(u => u.name + " ($" + u.cpr.toFixed(3) + "/req at " + u.requests.toLocaleString() + " req)").join(", ");
  return ":bar_chart: *Claude usage \u2014 " + s.weekOf + "*\n" +
    "*Spend:* " + fmt(s.totalSpend) + " across " + s.activeUsers + " active users (avg " + fmt(s.avgSpend) + "/user). Top 10 users = " + s.top10Pct + "% of spend.\n" +
    "*Model mix:* " + mm + "\n" +
    "*Surfaces:* " + prods + "\n" +
    "*Cache efficiency:* org-wide prompt-cache hit rate " + s.cacheHitRate + "%\n" +
    "*Flags this week:* " + fc.coworkOpus + " Cowork\u2192Opus \u00b7 " + fc.opusHeavy + " Opus-heavy Chat \u00b7 " + fc.legacy + " legacy \u00b7 " + fc.lowEngagement + " low engagement\n" +
    "*Power user benchmarks:* " + power;
}

function ActionsTab() {
  const { costDMs, lowDMs, heldMetering } = useMemo(() => buildConsolidatedDMs(), []);
  const summary = useMemo(() => generateChannelSummary(), []);
  const [status, setStatus] = useState({});
  const fire = (key, prompt, body) => {
    if (typeof window.sendPrompt === "function") { window.sendPrompt(prompt); setStatus({ ...status, [key]: "sent to chat \u2014 confirm the tool call" }); }
    else if (navigator.clipboard) { navigator.clipboard.writeText(body); setStatus({ ...status, [key]: "copied to clipboard" }); }
  };
  const dmCard = (d, i, manual) => (
    <Card key={d.email} style={{ marginBottom: 10, borderLeft: `3px solid ${manual ? C.blue : C.orange}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div>
          <span style={{ fontFamily: HEAD, fontWeight: 800, fontSize: 14, color: C.text }}>{d.slackEmail || d.email}{d.slackEmail && d.slackEmail !== d.email ? " (usage: " + d.email + ")" : ""}</span>
          <span style={{ marginLeft: 10 }}>{manual
            ? <span style={{ background: C.blue, color: "#000", fontFamily: BODY, fontWeight: 700, fontSize: 10, borderRadius: 4, padding: "2px 7px" }}>manual send only \u00b7 {d.weeks} low weeks</span>
            : d.flags.map(f => <span key={f} style={{ background: C.orange, color: "#000", fontFamily: BODY, fontWeight: 700, fontSize: 10, borderRadius: 4, padding: "2px 7px", marginRight: 4 }}>{f}</span>)}
          </span>
        </div>
        <button onClick={() => fire(d.email, "Send a Slack DM to " + (d.slackEmail || d.email) + ": " + d.body, d.body)}
          style={{ background: manual ? "transparent" : C.green, color: manual ? C.muted : "#000", border: manual ? `1px solid ${C.borderLight}` : "none",
            borderRadius: 7, padding: "7px 13px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: BODY }}>
          {manual ? "Send (manual)" : "Send DM"}
        </button>
      </div>
      <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, color: C.muted, fontFamily: BODY, margin: 0, lineHeight: 1.55 }}>{d.body}</pre>
      {status[d.email] && <Sub style={{ marginTop: 6, color: C.green }}>{status[d.email]}</Sub>}
    </Card>
  );
  return (
    <div>
      <Card style={{ marginBottom: 14, borderTop: `3px solid ${C.grey}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <Head size={15}>Channel summary \u2014 #claude-utilization</Head>
          <button onClick={() => fire("channel", "Send a Slack message to channel C0ANHN34VEC: " + summary, summary)}
            style={{ background: C.blue, color: "#000", border: "none", borderRadius: 7, padding: "7px 13px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: BODY }}>
            Post to channel
          </button>
        </div>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, color: C.muted, fontFamily: BODY, margin: 0, lineHeight: 1.55 }}>{summary}</pre>
        {status["channel"] && <Sub style={{ marginTop: 6, color: C.green }}>{status["channel"]}</Sub>}
      </Card>
      <Head size={16} style={{ margin: "6px 0 10px" }}>Consolidated cost DMs ({costDMs.length})</Head>
      <Sub style={{ marginBottom: 10 }}>One DM per user \u00b7 \u2265$100 weekly spend + qualifying flag \u00b7 skip list applied \u00b7 section order cowork \u2192 opus \u2192 legacy</Sub>
      {costDMs.map((d, i) => dmCard(d, i, false))}
      <Head size={16} style={{ margin: "18px 0 10px" }}>Low-engagement drafts ({lowDMs.length}) \u2014 never bulk-sent</Head>
      {lowDMs.map((d, i) => dmCard(d, i, true))}
      <Head size={16} style={{ margin: "18px 0 6px" }}>Held \u2014 $0.00 metering gap ({heldMetering.length})</Head>
      <Sub style={{ marginBottom: 10 }}>Flagged low-engagement but excluded from all send lists: real request volume landed on a surface reporting $0.00 net spend, so the engagement signal is understated. No DM drafted.</Sub>
      {heldMetering.map(h => (
        <Card key={h.email} style={{ marginBottom: 8, borderLeft: `3px solid ${C.grey}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontFamily: HEAD, fontWeight: 800, fontSize: 13.5, color: C.text }}>{h.email}</span>
            <span style={{ fontFamily: BODY, fontSize: 11.5, color: C.muted }}>
              {h.requests.toLocaleString()} req \u00b7 {fmt(h.spend)} \u00b7 {h.weeks} low weeks \u00b7 unmetered: {h.surfaces.join(", ")}
            </span>
          </div>
        </Card>
      ))}
    </div>
  );
}

// AI narrative hook for the Enablement tab (artifact only)
window.__AI_NARRATIVE__ = async function (payload) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6", max_tokens: 1000,
      messages: [{ role: "user", content:
        "You are writing a short enablement narrative for a Level Agency Claude-usage dashboard. " +
        "Data for the filtered group: " + JSON.stringify(payload) + ". " +
        "Write 4-6 sentences of plain prose (no markdown, no lists): what the trend shows, adoption depth, one concrete enablement opportunity. " +
        "Tone: factual, constructive, enabling — never punitive about spend. Respond with the narrative text only." }],
    }),
  });
  const data = await resp.json();
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
};
window.__EXTRA_TABS__ = [{ id: "actions", label: "Slack Actions", C: ActionsTab }];
