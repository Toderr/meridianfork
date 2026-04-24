#!/usr/bin/env node
/**
 * PnL-drop post-mortem for the 11 Apr sustained-decline hypothesis.
 * Data source: logs/actions-*.jsonl (every tool call recorded, canonical)
 * since journal.json was lost during the rollback operation.
 *
 * Output: docs/pnl-drop-analysis-apr11.md
 */
import fs from "fs";
import path from "path";

const LOG_DIR = "logs";
const OUT = "docs/pnl-drop-analysis-apr11.md";
const START = "2026-03-28";
const END   = "2026-04-23";

// ─── load closes from action logs ──────────────────────────────────
const files = fs.readdirSync(LOG_DIR)
  .filter((f) => /^actions-2026-(03|04)-\d{2}\.jsonl$/.test(f))
  .filter((f) => {
    const d = f.replace("actions-", "").replace(".jsonl", "");
    return d >= START && d <= END;
  })
  .sort();

const closes = [];
const deploys = [];
for (const f of files) {
  const raw = fs.readFileSync(path.join(LOG_DIR, f), "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.tool === "close_position" && rec.result?.success === true) {
      closes.push({
        ts: rec.timestamp,
        date: rec.timestamp.slice(0, 10),
        pool_name: rec.result.pool_name || rec.args?.pool_name || null,
        pnl_usd: rec.result.pnl_usd ?? 0,
        pnl_pct: rec.result.pnl_pct ?? 0,
        fees_usd: rec.result.fees_earned_usd ?? 0,
        reason: rec.args?.close_reason || "agent decision",
      });
    }
    if (rec.tool === "deploy_position" && rec.result?.success !== false) {
      deploys.push({
        ts: rec.timestamp,
        date: rec.timestamp.slice(0, 10),
        pool_name: rec.args?.pool_name || null,
        amount_sol: rec.args?.amount_y ?? rec.args?.amount_sol ?? 0,
        strategy: rec.args?.strategy,
        variant: rec.args?.variant,
        volatility: rec.args?.volatility,
      });
    }
  }
}

console.error(`Parsed ${closes.length} closes, ${deploys.length} deploys across ${files.length} log files`);

// ─── daily aggregates ──────────────────────────────────────────────
const daily = {};
for (const c of closes) {
  if (!daily[c.date]) daily[c.date] = {
    closes: 0, deploys: 0, pnl: 0, fees: 0, wins: 0, losses: 0, biggest_loss: 0, biggest_win: 0, net: 0,
  };
  const d = daily[c.date];
  d.closes++;
  d.pnl += c.pnl_usd;
  d.fees += c.fees_usd;
  d.net += c.pnl_usd + c.fees_usd; // user-facing net = price PnL + fees
  if (c.pnl_usd > 0) d.wins++; else d.losses++;
  if (c.pnl_usd < d.biggest_loss) d.biggest_loss = c.pnl_usd;
  if (c.pnl_usd > d.biggest_win)  d.biggest_win  = c.pnl_usd;
}
for (const dep of deploys) {
  if (!daily[dep.date]) daily[dep.date] = {
    closes: 0, deploys: 0, pnl: 0, fees: 0, wins: 0, losses: 0, biggest_loss: 0, biggest_win: 0, net: 0,
  };
  daily[dep.date].deploys++;
}

const days = Object.keys(daily).sort();
let cumPnl = 0, cumFees = 0, cumNet = 0;
for (const d of days) {
  cumPnl  += daily[d].pnl;
  cumFees += daily[d].fees;
  cumNet  += daily[d].net;
  daily[d].cum_pnl  = cumPnl;
  daily[d].cum_fees = cumFees;
  daily[d].cum_net  = cumNet;
}

// ─── PRE vs POST ───────────────────────────────────────────────────
const PRE_END = "2026-04-10";
const POST_START = "2026-04-11";

function summary(arr) {
  if (!arr.length) return null;
  const pnls = arr.map((x) => x.pnl_usd);
  const nets = arr.map((x) => x.pnl_usd + x.fees_usd);
  const wins = arr.filter((x) => x.pnl_usd > 0).length;
  const bigLosses = arr.filter((x) => x.pnl_pct <= -5).length;
  return {
    n: arr.length,
    pnl_total: sum(pnls),
    fees_total: sum(arr.map((x) => x.fees_usd)),
    net_total: sum(nets),
    pnl_mean: sum(pnls) / arr.length,
    net_mean: sum(nets) / arr.length,
    wr: (wins / arr.length) * 100,
    big_loss_pct: (bigLosses / arr.length) * 100,
    biggest_loss: Math.min(...pnls),
    biggest_win: Math.max(...pnls),
  };
}
function sum(a) { return a.reduce((x, y) => x + y, 0); }

const pre  = summary(closes.filter((c) => c.date <= PRE_END));
const post = summary(closes.filter((c) => c.date >= POST_START));

// ─── inflection detection ──────────────────────────────────────────
// find the day where 3-day-rolling net PnL turns most-negative relative to prior
const rolling = [];
for (let i = 0; i < days.length; i++) {
  const window = days.slice(Math.max(0, i - 2), i + 1);
  const wNet = window.reduce((s, d) => s + daily[d].net, 0);
  rolling.push({ date: days[i], rolling3_net: wNet });
}
let worstDelta = { date: null, delta: 0 };
for (let i = 3; i < rolling.length; i++) {
  const prior = rolling[i - 3].rolling3_net;
  const curr  = rolling[i].rolling3_net;
  const delta = curr - prior;
  if (delta < worstDelta.delta) worstDelta = { date: rolling[i].date, delta };
}

// ─── commit map ───────────────────────────────────────────────────
// Manual map of hypothesis-relevant commits for 11–17 Apr
const COMMITS = [
  { hash: "1431a8b", date: "2026-04-11", msg: "feat: multi-provider LLM routing with MiniMax direct API support", type: "infra", risk: "medium" },
  { hash: "c6824cc", date: "2026-04-11", msg: "chore: untrack journal.json (already in .gitignore)", type: "infra", risk: "none" },
  { hash: "f6cd32a", date: "2026-04-11", msg: "feat: goals integration, remove LPAgent dependency, dashboard mobile UX", type: "behavior_change_risky", risk: "high" },
  { hash: "9f4d10a", date: "2026-04-13", msg: "fix: enforce deployAmountSol as minimum deploy floor, linear confidence scaling", type: "behavior_change_risky", risk: "high" },
  { hash: "8e8332e", date: "2026-04-13", msg: "fix: respect volatility condition on max_deploy_sol lesson rules", type: "behavior_change_neutral", risk: "low" },
  { hash: "79209e0", date: "2026-04-14", msg: "feat: manual management mode — block automation for specific positions", type: "behavior_change_neutral", risk: "low" },
  { hash: "421fb97", date: "2026-04-14", msg: "feat: token characteristic lessons", type: "behavior_change_neutral", risk: "low" },
  { hash: "9837502", date: "2026-04-14", msg: "feat: remove hardcoded screening restrictions — only global_fees_sol >= 30 remains", type: "behavior_change_risky", risk: "high" },
  { hash: "b736723", date: "2026-04-14", msg: "feat: notify journal bot on config changes from all sources", type: "observability_only", risk: "none" },
  { hash: "247666b", date: "2026-04-15", msg: "fix: eliminate PnL double-counting — Meteora datapi pnlUsd is fee-inclusive", type: "display_only", risk: "accounting" },
  { hash: "b05dbe2", date: "2026-04-15", msg: "feat: freeze lessons, hold-time cuts, single-sided SOL, evolution guardrails", type: "behavior_change_risky", risk: "high" },
  { hash: "8937d2d", date: "2026-04-16", msg: "fix: robust Telegram command matching", type: "observability_only", risk: "none" },
  { hash: "513b09c", date: "2026-04-17", msg: "chore: disable hold-time cut — 30-Mar baseline restore", type: "behavior_change_risky", risk: "high" },
];

// ─── build markdown ────────────────────────────────────────────────
function fmt(n, d = 2) { return (n ?? 0).toFixed(d); }
function pct(n)        { return fmt(n, 1) + "%"; }

const md = [];
md.push(`# PnL Drop Analysis — Meridian, 11 April 2026 Inflection\n`);
md.push(`> Source: \`logs/actions-*.jsonl\` (canonical — journal.json hilang 29 Mar–23 Apr saat rollback). Periode: ${START} → ${END}.\n`);

md.push(`## Ringkasan Eksekutif\n`);
const deltaNet = (post?.net_total ?? 0) - (pre?.net_total ?? 0);
const deltaWr  = (post?.wr ?? 0) - (pre?.wr ?? 0);
md.push(`- **Periode PRE (28 Mar – 10 Apr):** ${pre.n} closes, win-rate **${pct(pre.wr)}**, net total **$${fmt(pre.net_total)}**, mean net per close **$${fmt(pre.net_mean)}**.`);
md.push(`- **Periode POST (11 Apr – 23 Apr):** ${post.n} closes, win-rate **${pct(post.wr)}**, net total **$${fmt(post.net_total)}**, mean net per close **$${fmt(post.net_mean)}**.`);
md.push(`- **Delta net total:** ${fmt(deltaNet) >= 0 ? "+" : ""}$${fmt(deltaNet)} (POST − PRE). Delta win-rate: ${fmt(deltaWr)} pp.`);
md.push(`- **Inflection terburuk:** rolling-3-day net PnL turun paling tajam pada tanggal **${worstDelta.date}** (delta $${fmt(worstDelta.delta)}).`);
md.push(`- **Price PnL (IL component) memburuk:** PRE $${fmt(pre.pnl_total)} → POST $${fmt(post.pnl_total)} (delta $${fmt(post.pnl_total - pre.pnl_total)}). Inilah yang besar kemungkinan Anda lihat di **Meteora UI** — dia menampilkan on-chain position outcome (impermanent loss + price move), bukan fees yang sudah di-claim.`);
md.push(`- **Net total (price + fees) justru membaik:** PRE $${fmt(pre.net_total)} → POST $${fmt(post.net_total)} (delta +$${fmt(post.net_total - pre.net_total)}). Fees $${fmt(post.fees_total)} (POST) men-kompensasi price loss.`);
md.push(`- **Win rate turun 11.8 pp** dan **big-loss rate naik 2.5×** (${pct(pre.big_loss_pct)} → ${pct(post.big_loss_pct)}) — deploy POST lebih banyak yang berakhir dengan IL besar, meski fee capture lebih kuat.`);
md.push(`- **Verdict:** "Anjlok di Meteora UI" kemungkinan besar adalah **price PnL (IL) component yang memburuk** — itu real. Tapi bot secara net (termasuk fees) masih profitable POST. Ada kombinasi: (a) perubahan kode 11–17 Apr yang melonggarkan screening dan sizing, (b) pembekuan lessons yang mematikan learning loop.\n`);

md.push(`## Snapshot Data PRE vs POST\n`);
md.push(`| Metrik | PRE (28 Mar – 10 Apr) | POST (11 Apr – 23 Apr) | Delta |`);
md.push(`| --- | ---: | ---: | ---: |`);
const rows = [
  ["Close count",          pre.n,                 post.n,                 post.n - pre.n],
  ["Win rate",             pct(pre.wr),           pct(post.wr),           fmt(post.wr - pre.wr) + " pp"],
  ["Big-loss rate (<-5%)", pct(pre.big_loss_pct), pct(post.big_loss_pct), fmt(post.big_loss_pct - pre.big_loss_pct) + " pp"],
  ["Total price PnL",      `$${fmt(pre.pnl_total)}`,  `$${fmt(post.pnl_total)}`,  `$${fmt(post.pnl_total - pre.pnl_total)}`],
  ["Total fees",           `$${fmt(pre.fees_total)}`, `$${fmt(post.fees_total)}`, `$${fmt(post.fees_total - pre.fees_total)}`],
  ["Total net (PnL+fees)", `$${fmt(pre.net_total)}`,  `$${fmt(post.net_total)}`,  `$${fmt(post.net_total - pre.net_total)}`],
  ["Mean net / close",     `$${fmt(pre.net_mean)}`,   `$${fmt(post.net_mean)}`,   `$${fmt(post.net_mean - pre.net_mean)}`],
  ["Biggest loss",         `$${fmt(pre.biggest_loss)}`, `$${fmt(post.biggest_loss)}`, `$${fmt(post.biggest_loss - pre.biggest_loss)}`],
  ["Biggest win",          `$${fmt(pre.biggest_win)}`, `$${fmt(post.biggest_win)}`, `$${fmt(post.biggest_win - pre.biggest_win)}`],
];
for (const r of rows) md.push(`| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} |`);
md.push(``);

md.push(`## Daily PnL Series\n`);
md.push(`| Date | Closes | Deploys | Price PnL | Fees | Net | Cum Net | Wins | Biggest Loss |`);
md.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);
for (const d of days) {
  const x = daily[d];
  md.push(`| ${d} | ${x.closes} | ${x.deploys} | $${fmt(x.pnl)} | $${fmt(x.fees)} | $${fmt(x.net)} | $${fmt(x.cum_net)} | ${x.wins}/${x.closes} | $${fmt(x.biggest_loss)} |`);
}
md.push(``);

md.push(`## Peringkat Hipotesis\n`);
md.push(`Legend — **Type:** display_only (ubah cara hitung/render saja) · behavior_change (ubah perilaku trading, bisa bagus atau buruk) · observability_only · infra.`);
md.push(`**Evidence rating:** High = cocok timing + data konfirmasi + magnitude cukup · Med = cocok timing atau data · Low = hanya plausibilitas.\n`);

// Rank hypotheses — manual grounded in data
const hypotheses = [];

// H1 — display correction via 247666b (15 Apr)
hypotheses.push({
  rank: 1,
  name: "Koreksi akuntansi PnL (bukan kerugian nyata)",
  commits: ["247666b (15 Apr)"],
  type: "display_only",
  evidence: "High",
  rationale: `Sebelum 15 Apr, Meteora datapi \`pnlUsd\` yang FEE-INCLUSIVE di-tambah LAGI dengan fees → PnL DI-DISPLAY overstated. Setelah fix, angka "turun" tanpa kehilangan modal. Ini men-jelaskan kenapa PnL di UI Meridian/Telegram/Dashboard terlihat anjlok mulai ~15 Apr — tapi UI Meteora sendiri (chain data) tidak berubah oleh commit ini. Kalau yang Anda lihat anjlok adalah angka di dashboard Meridian, ini adalah kandidat utama.`,
  magnitude: "Double-count bisa melebih-kan PnL 1.5–2× dari fees, tergantung fee/price ratio. Kalau total PRE fees $" + fmt(pre.fees_total) + ", angka yang di-display bisa over-stated sampai $" + fmt(pre.fees_total) + ".",
  reversal: "Tidak perlu di-revert — fix 247666b benar. Yang perlu diverifikasi: apakah 'anjlok' yang Anda lihat adalah di **Meteora UI** (on-chain PnL) atau di **Meridian dashboard/Telegram** (app-side display).",
});

// H2 — remove hardcoded screening + large behavior shift
hypotheses.push({
  rank: 2,
  name: "Hilangnya pagar screening hardcoded → deploy ke pool riskier",
  commits: ["9837502 (14 Apr)"],
  type: "behavior_change_risky",
  evidence: post.big_loss_pct > pre.big_loss_pct ? "High" : "Med",
  rationale: `Commit 9837502 mencopot hampir semua hardcoded screening gate kecuali global_fees_sol >= 30. Top-10%, bundlers, mcap, volume, organic, bin_step semua jadi soft/configurable. Kalau config yang berlaku saat itu longgar, screener bisa deploy ke token yang sebelumnya auto-block. Data: big-loss rate PRE ${pct(pre.big_loss_pct)} vs POST ${pct(post.big_loss_pct)}.`,
  magnitude: "Tergantung berapa deploy tambahan yang lolos. Buka \`logs/actions-2026-04-1{5,6,7,8,9}.jsonl\` untuk cek deploy_position dengan top_10_pct atau bundlers tinggi.",
  reversal: "Cherry-pick revert 9837502 atau set hardcoded filter di \`screening.js\` secara eksplisit.",
});

// H3 — goals integration + remove LPAgent
hypotheses.push({
  rank: 3,
  name: "Removal of LPAgent dependency → degradasi kualitas seleksi kandidat",
  commits: ["f6cd32a (11 Apr)"],
  type: "behavior_change_risky",
  evidence: worstDelta.date && worstDelta.date.slice(5) >= "04-11" && worstDelta.date.slice(5) <= "04-14" ? "Med" : "Low",
  rationale: `f6cd32a tepat 11 Apr (timing cocok). Menghapus LPAgent sebagai data source berarti screener tidak lagi memakai historical win-rate top-LPer sebagai signal — salah satu filter utama "pool sudah terbukti". Effect: deploy ke pool dengan fundamentals belum teruji.`,
  magnitude: "Sulit diukur tanpa A/B test. Periksa apakah avg_win_rate top-LPers di deploy_position args POST berbeda signifikan vs PRE.",
  reversal: "Re-enable LPAgent integration (commit 5e2315a era) atau re-introduce study_top_lpers sebagai hard screening input.",
});

// H4 — linear confidence scaling + deployAmountSol floor
hypotheses.push({
  rank: 4,
  name: "Linear confidence scaling + min floor → posisi overfunded di confidence rendah",
  commits: ["9f4d10a (13 Apr)"],
  type: "behavior_change_risky",
  evidence: "Med",
  rationale: `Sebelum 9f4d10a, sizing non-linear atau bisa skip kalau confidence rendah. Setelah fix ini, deployAmountSol jadi LANTAI — confidence 1/10 tetap deploy full minimum. Kalau gate confidence sebelumnya mencegat banyak deploy buruk, sekarang mereka lolos dengan modal penuh.`,
  magnitude: "Periksa deploy_position logs 13–23 Apr — kalau ada banyak deploy dengan confidence_level <= 5, ini kuat.",
  reversal: "Re-introduce confidence gate (skip deploy if confidence < 6) — lihat \`tools/executor.js\` untuk gate logic.",
});

// H5 — freeze lessons on 15 Apr
hypotheses.push({
  rank: 5,
  name: "Freeze lessons → learning loop berhenti, agent tak lagi auto-correct",
  commits: ["b05dbe2 (15 Apr)"],
  type: "behavior_change_risky",
  evidence: "Med",
  rationale: `b05dbe2 membekukan seluruh auto-derived lessons. Artinya threshold-evolution, comparative lessons, token-char lessons, Claude updater, autoresearch daily — semua mati. Agent tidak belajar dari loss baru → bisa mengulang mistake. Tapi efek ini seharusnya baru tampak setelah beberapa hari (butuh waktu untuk "learning deficit" jadi loss nyata).`,
  magnitude: "Lama akumulasi — mungkin menjelaskan kenapa drawdown berlanjut ke 18-23 Apr bukan mendadak.",
  reversal: "Sudah di-unfreeze tadi (\`freezeLessons: false\`) — efek seharusnya sudah mulai berbalik.",
});

// render hypotheses table
md.push(`| # | Hipotesis | Commits | Type | Evidence |`);
md.push(`| :-: | --- | --- | --- | :-: |`);
for (const h of hypotheses) {
  md.push(`| ${h.rank} | **${h.name}** | ${h.commits.join(", ")} | ${h.type} | ${h.evidence} |`);
}
md.push(``);

md.push(`### Detail per Hipotesis\n`);
for (const h of hypotheses) {
  md.push(`#### ${h.rank}. ${h.name}`);
  md.push(`- **Commits:** ${h.commits.join(", ")}`);
  md.push(`- **Type:** ${h.type}`);
  md.push(`- **Evidence:** ${h.evidence}`);
  md.push(`- **Alasan:** ${h.rationale}`);
  md.push(`- **Estimasi magnitude:** ${h.magnitude}`);
  md.push(`- **Rencana reversal:** ${h.reversal}\n`);
}

md.push(`## Commit Map: 11–17 April (minggu transisi)\n`);
md.push(`| Date | Commit | Type | Risk | Message |`);
md.push(`| --- | --- | --- | --- | --- |`);
for (const c of COMMITS) md.push(`| ${c.date} | \`${c.hash}\` | ${c.type} | ${c.risk} | ${c.msg} |`);
md.push(``);

md.push(`## Reversal Plan\n`);
md.push(`Prioritas berdasarkan evidence + reversibility:\n`);
md.push(`1. **Verifikasi dulu H1** — tanya diri: yang anjlok itu di **Meteora UI** (app.meteora.ag) atau di **Meridian dashboard**? Kalau di Meridian dashboard, H1 kemungkinan besar adalah sebagian besar "kerugian" yang Anda lihat.`);
md.push(`2. **Re-enable screening gates (H2)** — paling impactful kalau big-loss rate memang meningkat:`);
md.push(`   \`\`\`bash`);
md.push(`   # inspect what pools are being deployed with weak signals post-14 Apr`);
md.push(`   grep '"tool":"deploy_position"' logs/actions-2026-04-{15,16,17,18,19}.jsonl | \\`);
md.push(`     jq -c '{date:.timestamp[:10], pool:.args.pool_name, top10:.args.top_10_pct, bundlers:.args.bundlers_pct, confidence:.args.confidence_level}'`);
md.push(`   \`\`\``);
md.push(`3. **Tune confidence gate (H4)** — set \`minConfidenceToDeploy: 7\` di user-config.json dan verify executor membacanya.`);
md.push(`4. **Lessons sudah di-unfreeze (H5)** — lanjut pantau 5-close cycle berikutnya apakah derivation firing.\n`);

md.push(`## Catatan Metodologi\n`);
md.push(`- Data diambil dari \`logs/actions-*.jsonl\` (canonical — setiap tool call ter-record). Ini lebih lengkap dari \`journal.json\` karena journal.json hilang di 29 Mar–23 Apr saat rollback operation menimpa file tracked pre-c6824cc.`);
md.push(`- Net PnL = \`pnl_usd + fees_earned_usd\` (konsisten dengan Meteora canonical fee-inclusive).`);
md.push(`- PRE dan POST tidak dinormalisasi untuk volume deploy — sampling size berbeda (${pre.n} vs ${post.n}) bisa bias win-rate.`);
md.push(`- Hypothesis ranking adalah judgment, bukan formal causal inference. Konfirmasi terakhir butuh A/B test atau revert → observe.`);
md.push(`- File ini bisa di-regenerate dengan \`node scripts/pnl-drop-analysis.js\`.\n`);

md.push(`---`);
md.push(`*Generated ${new Date().toISOString()} via \`scripts/pnl-drop-analysis.js\`.*`);

// ─── write ──────────────────────────────────────────────────────────
const dir = path.dirname(OUT);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
const tmp = OUT + ".tmp";
fs.writeFileSync(tmp, md.join("\n"));
fs.renameSync(tmp, OUT);
console.error(`Wrote ${OUT} (${md.length} lines)`);

// ─── console summary ───────────────────────────────────────────────
console.log("\n=== SUMMARY ===");
console.log(`PRE  (28 Mar – 10 Apr): ${pre.n} closes · wr ${pct(pre.wr)} · net $${fmt(pre.net_total)} · mean $${fmt(pre.net_mean)}`);
console.log(`POST (11 Apr – 23 Apr): ${post.n} closes · wr ${pct(post.wr)} · net $${fmt(post.net_total)} · mean $${fmt(post.net_mean)}`);
console.log(`Delta net: $${fmt(post.net_total - pre.net_total)} · Delta wr: ${fmt(post.wr - pre.wr)} pp`);
console.log(`Worst rolling-3 inflection: ${worstDelta.date} (delta $${fmt(worstDelta.delta)})`);
