# PnL Drop Analysis — Meridian, 11 April 2026 Inflection

> Source: `logs/actions-*.jsonl` (canonical — journal.json hilang 29 Mar–23 Apr saat rollback). Periode: 2026-03-28 → 2026-04-23.

## Ringkasan Eksekutif

- **Periode PRE (28 Mar – 10 Apr):** 1040 closes, win-rate **64.1%**, net total **$99.19**, mean net per close **$0.10**.
- **Periode POST (11 Apr – 23 Apr):** 724 closes, win-rate **52.3%**, net total **$312.10**, mean net per close **$0.43**.
- **Delta net total:** +$212.91 (POST − PRE). Delta win-rate: -11.79 pp.
- **Inflection terburuk:** rolling-3-day net PnL turun paling tajam pada tanggal **2026-03-31** (delta $-287.95).
- **Price PnL (IL component) memburuk:** PRE $-206.67 → POST $-508.03 (delta $-301.36). Inilah yang besar kemungkinan Anda lihat di **Meteora UI** — dia menampilkan on-chain position outcome (impermanent loss + price move), bukan fees yang sudah di-claim.
- **Net total (price + fees) justru membaik:** PRE $99.19 → POST $312.10 (delta +$212.91). Fees $820.13 (POST) men-kompensasi price loss.
- **Win rate turun 11.8 pp** dan **big-loss rate naik 2.5×** (2.2% → 5.4%) — deploy POST lebih banyak yang berakhir dengan IL besar, meski fee capture lebih kuat.
- **Verdict:** "Anjlok di Meteora UI" kemungkinan besar adalah **price PnL (IL) component yang memburuk** — itu real. Tapi bot secara net (termasuk fees) masih profitable POST. Ada kombinasi: (a) perubahan kode 11–17 Apr yang melonggarkan screening dan sizing, (b) pembekuan lessons yang mematikan learning loop.

## Snapshot Data PRE vs POST

| Metrik | PRE (28 Mar – 10 Apr) | POST (11 Apr – 23 Apr) | Delta |
| --- | ---: | ---: | ---: |
| Close count | 1040 | 724 | -316 |
| Win rate | 64.1% | 52.3% | -11.79 pp |
| Big-loss rate (<-5%) | 2.2% | 5.4% | 3.18 pp |
| Total price PnL | $-206.67 | $-508.03 | $-301.36 |
| Total fees | $305.86 | $820.13 | $514.27 |
| Total net (PnL+fees) | $99.19 | $312.10 | $212.91 |
| Mean net / close | $0.10 | $0.43 | $0.34 |
| Biggest loss | $-153.04 | $-61.29 | $91.75 |
| Biggest win | $36.17 | $9.25 | $-26.92 |

## Daily PnL Series

| Date | Closes | Deploys | Price PnL | Fees | Net | Cum Net | Wins | Biggest Loss |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2026-03-28 | 93 | 98 | $49.50 | $0.00 | $49.50 | $49.50 | 66/93 | $-6.14 |
| 2026-03-29 | 84 | 87 | $-246.94 | $0.00 | $-246.94 | $-197.44 | 52/84 | $-148.53 |
| 2026-03-30 | 68 | 66 | $14.25 | $0.00 | $14.25 | $-183.19 | 42/68 | $-18.20 |
| 2026-03-31 | 42 | 51 | $-5.76 | $0.00 | $-5.76 | $-188.95 | 24/42 | $-28.05 |
| 2026-04-01 | 78 | 77 | $-128.24 | $0.00 | $-128.24 | $-317.19 | 43/78 | $-153.04 |
| 2026-04-02 | 52 | 57 | $-139.84 | $0.00 | $-139.84 | $-457.02 | 23/52 | $-145.46 |
| 2026-04-03 | 94 | 91 | $108.47 | $0.00 | $108.47 | $-348.55 | 68/94 | $-3.18 |
| 2026-04-04 | 77 | 75 | $37.53 | $26.16 | $63.69 | $-284.86 | 58/77 | $-18.71 |
| 2026-04-05 | 98 | 99 | $8.57 | $66.19 | $74.76 | $-210.10 | 59/98 | $-68.48 |
| 2026-04-06 | 100 | 102 | $18.35 | $38.09 | $56.44 | $-153.66 | 54/100 | $-5.90 |
| 2026-04-07 | 96 | 98 | $13.86 | $26.90 | $40.76 | $-112.90 | 56/96 | $-7.81 |
| 2026-04-08 | 49 | 51 | $54.45 | $79.08 | $133.53 | $20.63 | 38/49 | $-10.38 |
| 2026-04-09 | 51 | 57 | $-2.80 | $32.79 | $29.99 | $50.62 | 40/51 | $-35.09 |
| 2026-04-10 | 58 | 59 | $11.92 | $36.65 | $48.57 | $99.19 | 44/58 | $-5.46 |
| 2026-04-11 | 79 | 78 | $0.10 | $34.71 | $34.81 | $134.00 | 46/79 | $-6.97 |
| 2026-04-12 | 101 | 105 | $-18.24 | $102.36 | $84.12 | $218.12 | 64/101 | $-32.20 |
| 2026-04-13 | 96 | 98 | $-46.73 | $150.46 | $103.73 | $321.85 | 67/96 | $-61.29 |
| 2026-04-14 | 43 | 45 | $-3.48 | $25.77 | $22.29 | $344.14 | 26/43 | $-8.65 |
| 2026-04-15 | 61 | 62 | $-40.39 | $63.52 | $23.13 | $367.27 | 32/61 | $-17.66 |
| 2026-04-16 | 54 | 59 | $-21.82 | $21.37 | $-0.45 | $366.82 | 25/54 | $-10.19 |
| 2026-04-17 | 51 | 52 | $-34.09 | $52.98 | $18.89 | $385.71 | 24/51 | $-11.80 |
| 2026-04-18 | 16 | 17 | $-13.90 | $30.01 | $16.11 | $401.82 | 4/16 | $-6.15 |
| 2026-04-19 | 26 | 25 | $-27.67 | $26.90 | $-0.77 | $401.05 | 10/26 | $-7.11 |
| 2026-04-20 | 49 | 49 | $-124.12 | $105.43 | $-18.69 | $382.36 | 20/49 | $-31.12 |
| 2026-04-21 | 57 | 55 | $-75.07 | $113.76 | $38.69 | $421.05 | 28/57 | $-36.96 |
| 2026-04-22 | 60 | 65 | $-61.62 | $71.61 | $9.99 | $431.04 | 23/60 | $-14.22 |
| 2026-04-23 | 31 | 30 | $-41.00 | $21.25 | $-19.75 | $411.29 | 10/31 | $-11.88 |

## Peringkat Hipotesis

Legend — **Type:** display_only (ubah cara hitung/render saja) · behavior_change (ubah perilaku trading, bisa bagus atau buruk) · observability_only · infra.
**Evidence rating:** High = cocok timing + data konfirmasi + magnitude cukup · Med = cocok timing atau data · Low = hanya plausibilitas.

| # | Hipotesis | Commits | Type | Evidence |
| :-: | --- | --- | --- | :-: |
| 1 | **Koreksi akuntansi PnL (bukan kerugian nyata)** | 247666b (15 Apr) | display_only | High |
| 2 | **Hilangnya pagar screening hardcoded → deploy ke pool riskier** | 9837502 (14 Apr) | behavior_change_risky | High |
| 3 | **Removal of LPAgent dependency → degradasi kualitas seleksi kandidat** | f6cd32a (11 Apr) | behavior_change_risky | Low |
| 4 | **Linear confidence scaling + min floor → posisi overfunded di confidence rendah** | 9f4d10a (13 Apr) | behavior_change_risky | Med |
| 5 | **Freeze lessons → learning loop berhenti, agent tak lagi auto-correct** | b05dbe2 (15 Apr) | behavior_change_risky | Med |

### Detail per Hipotesis

#### 1. Koreksi akuntansi PnL (bukan kerugian nyata)
- **Commits:** 247666b (15 Apr)
- **Type:** display_only
- **Evidence:** High
- **Alasan:** Sebelum 15 Apr, Meteora datapi `pnlUsd` yang FEE-INCLUSIVE di-tambah LAGI dengan fees → PnL DI-DISPLAY overstated. Setelah fix, angka "turun" tanpa kehilangan modal. Ini men-jelaskan kenapa PnL di UI Meridian/Telegram/Dashboard terlihat anjlok mulai ~15 Apr — tapi UI Meteora sendiri (chain data) tidak berubah oleh commit ini. Kalau yang Anda lihat anjlok adalah angka di dashboard Meridian, ini adalah kandidat utama.
- **Estimasi magnitude:** Double-count bisa melebih-kan PnL 1.5–2× dari fees, tergantung fee/price ratio. Kalau total PRE fees $305.86, angka yang di-display bisa over-stated sampai $305.86.
- **Rencana reversal:** Tidak perlu di-revert — fix 247666b benar. Yang perlu diverifikasi: apakah 'anjlok' yang Anda lihat adalah di **Meteora UI** (on-chain PnL) atau di **Meridian dashboard/Telegram** (app-side display).

#### 2. Hilangnya pagar screening hardcoded → deploy ke pool riskier
- **Commits:** 9837502 (14 Apr)
- **Type:** behavior_change_risky
- **Evidence:** High
- **Alasan:** Commit 9837502 mencopot hampir semua hardcoded screening gate kecuali global_fees_sol >= 30. Top-10%, bundlers, mcap, volume, organic, bin_step semua jadi soft/configurable. Kalau config yang berlaku saat itu longgar, screener bisa deploy ke token yang sebelumnya auto-block. Data: big-loss rate PRE 2.2% vs POST 5.4%.
- **Estimasi magnitude:** Tergantung berapa deploy tambahan yang lolos. Buka `logs/actions-2026-04-1{5,6,7,8,9}.jsonl` untuk cek deploy_position dengan top_10_pct atau bundlers tinggi.
- **Rencana reversal:** Cherry-pick revert 9837502 atau set hardcoded filter di `screening.js` secara eksplisit.

#### 3. Removal of LPAgent dependency → degradasi kualitas seleksi kandidat
- **Commits:** f6cd32a (11 Apr)
- **Type:** behavior_change_risky
- **Evidence:** Low
- **Alasan:** f6cd32a tepat 11 Apr (timing cocok). Menghapus LPAgent sebagai data source berarti screener tidak lagi memakai historical win-rate top-LPer sebagai signal — salah satu filter utama "pool sudah terbukti". Effect: deploy ke pool dengan fundamentals belum teruji.
- **Estimasi magnitude:** Sulit diukur tanpa A/B test. Periksa apakah avg_win_rate top-LPers di deploy_position args POST berbeda signifikan vs PRE.
- **Rencana reversal:** Re-enable LPAgent integration (commit 5e2315a era) atau re-introduce study_top_lpers sebagai hard screening input.

#### 4. Linear confidence scaling + min floor → posisi overfunded di confidence rendah
- **Commits:** 9f4d10a (13 Apr)
- **Type:** behavior_change_risky
- **Evidence:** Med
- **Alasan:** Sebelum 9f4d10a, sizing non-linear atau bisa skip kalau confidence rendah. Setelah fix ini, deployAmountSol jadi LANTAI — confidence 1/10 tetap deploy full minimum. Kalau gate confidence sebelumnya mencegat banyak deploy buruk, sekarang mereka lolos dengan modal penuh.
- **Estimasi magnitude:** Periksa deploy_position logs 13–23 Apr — kalau ada banyak deploy dengan confidence_level <= 5, ini kuat.
- **Rencana reversal:** Re-introduce confidence gate (skip deploy if confidence < 6) — lihat `tools/executor.js` untuk gate logic.

#### 5. Freeze lessons → learning loop berhenti, agent tak lagi auto-correct
- **Commits:** b05dbe2 (15 Apr)
- **Type:** behavior_change_risky
- **Evidence:** Med
- **Alasan:** b05dbe2 membekukan seluruh auto-derived lessons. Artinya threshold-evolution, comparative lessons, token-char lessons, Claude updater, autoresearch daily — semua mati. Agent tidak belajar dari loss baru → bisa mengulang mistake. Tapi efek ini seharusnya baru tampak setelah beberapa hari (butuh waktu untuk "learning deficit" jadi loss nyata).
- **Estimasi magnitude:** Lama akumulasi — mungkin menjelaskan kenapa drawdown berlanjut ke 18-23 Apr bukan mendadak.
- **Rencana reversal:** Sudah di-unfreeze tadi (`freezeLessons: false`) — efek seharusnya sudah mulai berbalik.

## Commit Map: 11–17 April (minggu transisi)

| Date | Commit | Type | Risk | Message |
| --- | --- | --- | --- | --- |
| 2026-04-11 | `1431a8b` | infra | medium | feat: multi-provider LLM routing with MiniMax direct API support |
| 2026-04-11 | `c6824cc` | infra | none | chore: untrack journal.json (already in .gitignore) |
| 2026-04-11 | `f6cd32a` | behavior_change_risky | high | feat: goals integration, remove LPAgent dependency, dashboard mobile UX |
| 2026-04-13 | `9f4d10a` | behavior_change_risky | high | fix: enforce deployAmountSol as minimum deploy floor, linear confidence scaling |
| 2026-04-13 | `8e8332e` | behavior_change_neutral | low | fix: respect volatility condition on max_deploy_sol lesson rules |
| 2026-04-14 | `79209e0` | behavior_change_neutral | low | feat: manual management mode — block automation for specific positions |
| 2026-04-14 | `421fb97` | behavior_change_neutral | low | feat: token characteristic lessons |
| 2026-04-14 | `9837502` | behavior_change_risky | high | feat: remove hardcoded screening restrictions — only global_fees_sol >= 30 remains |
| 2026-04-14 | `b736723` | observability_only | none | feat: notify journal bot on config changes from all sources |
| 2026-04-15 | `247666b` | display_only | accounting | fix: eliminate PnL double-counting — Meteora datapi pnlUsd is fee-inclusive |
| 2026-04-15 | `b05dbe2` | behavior_change_risky | high | feat: freeze lessons, hold-time cuts, single-sided SOL, evolution guardrails |
| 2026-04-16 | `8937d2d` | observability_only | none | fix: robust Telegram command matching |
| 2026-04-17 | `513b09c` | behavior_change_risky | high | chore: disable hold-time cut — 30-Mar baseline restore |

## Reversal Plan

Prioritas berdasarkan evidence + reversibility:

1. **Verifikasi dulu H1** — tanya diri: yang anjlok itu di **Meteora UI** (app.meteora.ag) atau di **Meridian dashboard**? Kalau di Meridian dashboard, H1 kemungkinan besar adalah sebagian besar "kerugian" yang Anda lihat.
2. **Re-enable screening gates (H2)** — paling impactful kalau big-loss rate memang meningkat:
   ```bash
   # inspect what pools are being deployed with weak signals post-14 Apr
   grep '"tool":"deploy_position"' logs/actions-2026-04-{15,16,17,18,19}.jsonl | \
     jq -c '{date:.timestamp[:10], pool:.args.pool_name, top10:.args.top_10_pct, bundlers:.args.bundlers_pct, confidence:.args.confidence_level}'
   ```
3. **Tune confidence gate (H4)** — set `minConfidenceToDeploy: 7` di user-config.json dan verify executor membacanya.
4. **Lessons sudah di-unfreeze (H5)** — lanjut pantau 5-close cycle berikutnya apakah derivation firing.

## Catatan Metodologi

- Data diambil dari `logs/actions-*.jsonl` (canonical — setiap tool call ter-record). Ini lebih lengkap dari `journal.json` karena journal.json hilang di 29 Mar–23 Apr saat rollback operation menimpa file tracked pre-c6824cc.
- Net PnL = `pnl_usd + fees_earned_usd` (konsisten dengan Meteora canonical fee-inclusive).
- PRE dan POST tidak dinormalisasi untuk volume deploy — sampling size berbeda (1040 vs 724) bisa bias win-rate.
- Hypothesis ranking adalah judgment, bukan formal causal inference. Konfirmasi terakhir butuh A/B test atau revert → observe.
- File ini bisa di-regenerate dengan `node scripts/pnl-drop-analysis.js`.

---
*Generated 2026-04-24T05:06:33.427Z via `scripts/pnl-drop-analysis.js`.*