# Raw Material Required — formulas

How the **Raw Material Required** strip on Assign Production
(`/labels/production/assign/:id`) gets its numbers.

Source of the formulas: `raw material formula.xlsx` (Sheet1).
Implementation: `utils/rawMaterialNeed.js` (`computeRawMaterialNeed`).
Worked example below is batch `6aa3c6b1…` (C001WB).

---

## 1. Area the deckle laminates

```
area (m²) = Σ over layouts:  width(mm)/1000 × deckle R.M.(m) × webs
```

| Width | Deckle R.M. | Deckle Count | m² |
|---|---|---|---|
| 660 mm | 1,000 m | 13 | 8,580 |
| | | **area** | **8,580 m²** |

**One width for the whole job.** A mixed-web plan stores a width per layout
(this batch slits to 660, 635 and 510 mm layouts), but that is a *slitting*
decision — the laminator mounts one facestock reel and runs the lot off it. The
width taken is the batch's `deckleSize`, or the widest layout where some layout
is wider than that, so a plan whose odd web is wider than the headline cannot
under-budget the facestock. Run lengths and counts still come from
`deckleLayout`; a row saved without layouts falls back to
`deckleSize × deckleRunningMeters × noOfRolls`.

---

## 2. Kilograms per layer

Column F of the sheet is `SQ.MTR / KG = 1000 / GSM` (cell `F2 = 1000/C2`).
Inverted, that is the weight of a given area:

```
theoretical kg = area × GSM ÷ 1000
```

| Layer | GSM | Theoretical kg | + 1% = what we pull |
|---|---|---|---|
| FACESTOCK | 80 | 8,580 × 80 ÷ 1000 = 686.40 | **693.26 kg** |
| ADHESIVE (dry) | 20 | 8,580 × 20 ÷ 1000 = 171.60 | **173.32 kg** |
| RELEASE | 67 | 8,580 × 67 ÷ 1000 = 574.86 | **580.61 kg** |

GSMs are the recipe's own — `facestockGsm`, `adhesiveGsm`, `releaseLinerGsm`
on the Label Stock (not the sheet's sample 100/45/67).

### The wastage multiplier — read this

`waste = 1 + WASTAGE_PCT / 100`. The sheet's own `WASTAGE %` column (`D2`,
`D3`, `D4`) is `3`, **but `WASTAGE_PCT` in the code is set to `1`** — see the
note at the end of this section.

**The sheet applies its 3% to the rate, not to the weight**, because the sheet
is a costing sheet — it never computes kilograms at all:

```
E2 = B2/100*D2          Rs/kg × 3%      -> 78 × 3% = 2.34 Rs/kg of wastage
G2 = C2*(B2+E2)/1000    GSM × (rate + wastage rate) / 1000  -> Rs per m²
```

Moving that percentage from the price onto the quantity is **our** step, not
the sheet's. As a quantity it reads the way the shopfloor means it: pull a
little over theoretical to cover trim, start-up and splice loss.

**The percentage itself is ours too.** The sheet's 3 is a costing adder, so it
does not have to be the right allowance for a quantity; `WASTAGE_PCT` is
currently **1**, and the tables in this doc are figured at ×1.01. It lives in
one place — `utils/rawMaterialNeed.js` — and every figure on Assign Production
follows it:

| `WASTAGE_PCT` | Facestock | Adhesive (dry) | Release |
|---|---|---|---|
| 0 | 686.40 kg | 171.60 kg | 574.86 kg |
| **1** (current) | **693.26 kg** | **173.32 kg** | **580.61 kg** |
| 3 (the sheet's) | 706.99 kg | 176.75 kg | 592.11 kg |

---

## 3. Adhesive, wet

The recipe's 20 GSM is the **dry** coat. Cell `L3 = K3/60*100`, sitting under
the sheet's `DRY` (`H2`) / `WET` (`L4`) pair, converts a dry coat weight to the
wet weight at 60% solids (the sheet's own example: 22 dry -> 36.67 wet):

```
wet GSM = dry GSM ÷ 60 × 100   =  20 ÷ 60 × 100 = 33.33 GSM
wet kg  = area × wet GSM ÷ 1000 × 1.01
        = 8,580 × 33.33 ÷ 1000 = 285.97 × 1.01 = 288.83 kg
```

The wet figure is the one actually pulled from the drum, so it is what the
allotment tally counts against for the adhesive layer — **in kilograms**, the
unit a drum is held and issued in. Adhesive is the one layer not tallied in
square metres; see §4.

---

## Where each piece comes from

| Piece | Sheet cell | Ours? |
|---|---|---|
| `kg = area × GSM ÷ 1000` | `F2 = 1000/C2` (`SQ.MTR / KG`), inverted | straight from the sheet |
| `WASTAGE %` | `D2`/`D3`/`D4` say 3 | **ours** — set to 1, and applied to the quantity |
| `× waste` **on the weight** | — (sheet puts its % on Rs/kg: `E2 = B2/100*D2`) | our interpretation |
| `wet = dry ÷ 60 × 100` | `L3 = K3/60*100`, labelled `DRY`/`WET` | straight from the sheet |
| Area from `deckleLayout` | — | ours; the sheet has no deckle |

The sheet's `B` (Rs/kg), `G` (Rs/m²), `A7:B9` (expenses, delivery, margin) and
`H7:J12` (tape calculator, sale rate, costing) columns are **costing, not
quantity**, and are deliberately not modelled.

---

## 4. Kilograms and running metres — what the page shows

Assign Production states the requirement, and tallies the reels ticked against
it, in **kilograms and running metres** — both sides of the same material: the
weight the store issues, and the length the machine runs. The square metres it
works out to ride alongside as a third figure.

### The requirement

Every layer covers the whole deckle and runs the full length of every web:

```
metres = Σ (deckle R.M. × deckle count) × 1.01      same for every layer
area   = area (§1) × 1.01                            same for every layer
kg     = area × GSM ÷ 1000 × 1.01                    per layer — §2, §3
```

| Batch | Metres | Area | Facestock kg | Adhesive kg (wet) | Release kg |
|---|---|---|---|---|---|
| `6aa4f3e8…` 3 deckles × 1,000 m | 3,030 | 1,999.80 m² | 159.98 | 66.65 | 133.99 |
| `6aa3c6b1…` 13 deckles × 1,000 m | 13,130 | 8,665.80 m² | 693.26 | 288.83 | 580.61 |

A layer recorded in **microns** has no weight (§2 reports it as "no GSM") but
still has a metres and an area requirement.

### Converting stock

Raw stock is held in kilograms — `reelMtrs` on every pool is really kg — so the
weight side converts nothing. The length side is:

```
metres = kg × 1e6 ÷ (GSM × widthMm)
```

| Layer | GSM | Width |
|---|---|---|
| Facestock, Release Liner | the reel's own, falling back to the recipe's | the reel's own |
| Adhesive | the recipe's **wet** GSM (§3) | this job's web — a drum has none of its own |

Worked examples, all round-tripping to the kilograms they came from:

| Reel | kg | GSM | Width | Metres |
|---|---|---|---|---|
| Facestock | 428 | 80 | 510 mm | 10,490.20 |
| Release liner | 70.5 | 60 | 510 mm | 2,303.92 |
| Adhesive drum | 50 | 33.33 wet | 660 mm | 2,272.95 |

### The tally

Each layer against its own pool, on both sides. The bar fills on whichever side
is further behind, so it only goes green when both are covered.

A reel whose metres cannot be worked out (no GSM, or no width) counts on the kg
side only and is named in the line. A web reel **narrower than the job's web** is
flagged amber — it cannot be mounted however much it holds — but still counts,
since the Size column and its filter are where that choice is made.

---

## Notes

- Weights are in **kilograms**. The raw pools' `reelMtrs` field really holds kg
  (see `routes/stock/semiFinishedStock.js`), as does every usage figure on a
  job card. Assign Production converts to square metres for display and
  tallying only (§4) — the stored unit is unchanged.
- Constants live in `utils/rawMaterialNeed.js`: `WASTAGE_PCT = 1`,
  `ADHESIVE_SOLIDS_PCT = 60`. Every figure here and on the page follows them.
- The step-by-step working for whichever batch is open is shown on the page
  itself, under "How this was worked out" in the Raw Material Required card.
- A layer described in microns instead of GSM cannot be weighed, so it is
  reported as "no GSM" rather than guessed at, and the total is flagged
  `incomplete`.
