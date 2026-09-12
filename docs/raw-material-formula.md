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

| Width | Deckle R.M. | Webs | m² |
|---|---|---|---|
| 660 mm | 1,000 m | 3 | 1,980 |
| 635 mm | 1,000 m | 8 | 5,080 |
| 510 mm | 1,000 m | 2 | 1,020 |
| | | **area** | **8,080 m²** |

Widths / lengths / webs come from the batch's `deckleLayout` — per layout, so
mixed webs are handled. A row saved without layouts falls back to
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
| FACESTOCK | 80 | 8,080 × 80 ÷ 1000 = 646.40 | **652.86 kg** |
| ADHESIVE (dry) | 20 | 8,080 × 20 ÷ 1000 = 161.60 | **163.22 kg** |
| RELEASE | 67 | 8,080 × 67 ÷ 1000 = 541.36 | **546.77 kg** |

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
| 0 | 646.40 kg | 161.60 kg | 541.36 kg |
| **1** (current) | **652.86 kg** | **163.22 kg** | **546.77 kg** |
| 3 (the sheet's) | 665.79 kg | 166.45 kg | 557.60 kg |

---

## 3. Adhesive, wet

The recipe's 20 GSM is the **dry** coat. Cell `L3 = K3/60*100`, sitting under
the sheet's `DRY` (`H2`) / `WET` (`L4`) pair, converts a dry coat weight to the
wet weight at 60% solids (the sheet's own example: 22 dry -> 36.67 wet):

```
wet GSM = dry GSM ÷ 60 × 100   =  20 ÷ 60 × 100 = 33.33 GSM
wet kg  = area × wet GSM ÷ 1000 × 1.01
        = 8,080 × 33.33 ÷ 1000 = 269.31 × 1.01 = 272.00 kg
```

The wet figure is the one actually pulled from the drum, so it is what the
allotment tally counts against for the adhesive layer.

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

## 4. Square metres — what the page actually shows

Assign Production states the requirement, and tallies the reels ticked against
it, in **square metres**. Kilograms still ride alongside in grey, because the
store issues against weight and stock is held in weight; nothing about how raw
material is received or deducted changed.

Area, not running metres: a lamination consumes area, and area is the only unit
that compares reels of different widths. 2,300 m of 510 mm web is *less*
material than 2,000 m of 660 mm — running metres gets that backwards.

### The requirement

Every layer covers the whole deckle, so what a layer needs is the job's own
area (§1) plus wastage — no GSM involved:

```
need (m²) = area × 1.01
```

| Batch | Area (§1) | Need |
|---|---|---|
| `6aa4f3e8…` (2 × 660 mm + 1 × 635 mm, 1,000 m each) | 1,955 m² | **1,974.55 m²** |
| `6aa3c6b1…` (3 × 660 + 8 × 635 + 2 × 510) | 8,080 m² | **8,160.80 m²** |

— the same figure for facestock, adhesive and release liner alike.

A useful consequence: a layer recorded in **microns** has no weight (§2 reports
it as "no GSM") but still has a knowable area requirement, so the strip states a
number where it used to show a dash.

### Converting stock

Stock is kilograms. `kgToSqMetres()` is the exact inverse of
`kg = area × gsm / 1000`:

```
area (m²) = kg × 1000 ÷ gsm
```

No width enters into it — which is the point: a reel's area is what it covers
however it is slit, so every reel carrying a GSM converts, including an adhesive
drum, which has no width to offer.

The GSM is the **reel's own** where it has one. Where it does not, the recipe's
is used (the pools are filtered to this recipe's spec, so it is the same
material). For **adhesive** the recipe's is the only source — no drum records a
coat weight — and it is the **wet** figure of §3, since that is what the drum
holds and what it spreads at.

Worked examples, all round-tripping to the kilograms they came from:

| Reel | kg | GSM | Sq.Mtrs |
|---|---|---|---|
| Facestock | 428 | 80 | 5,350.00 |
| Facestock | 516 | 80 | 6,450.00 |
| Release liner | 70.5 | 60 | 1,175.00 |
| Adhesive drum | 50 | 33.33 (wet) | 1,500.15 |

The adhesive stays self-consistent end to end: the 65.81 kg §3 works out for
batch `6aa4f3e8…` converts back to 1,974.50 m², the same area the other layers
need (the 0.05 is `round2` on the kilograms).

A reel with no GSM and no recipe GSM to fall back on cannot be measured: its
Sq.Mtrs cell reads "—", it counts as nothing in the tally, and the tally says
how many such reels are ticked rather than quietly running short. The cell's
hover still carries the kilograms, and for a web reel the length that area works
out to at its own width (`5,350 m² → 10,490.20 m at 510 mm`).

### What area does *not* check

Area says whether there is enough material, not whether it will fit the web: a
510 mm reel cannot run a 660 mm deckle however many square metres it holds. The
Size column and its filter — pre-filled with the deckle size — remain how that
is judged.

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
