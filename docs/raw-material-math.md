# Raw Material — the formulas

Every calculation behind the **Raw Material Required** strip and the **Raw
Material Allotment** tally on Assign Production
(`/labels/production/assign/:id`).

This is the formula sheet only. For where each formula came from — which cell
of `raw material formula.xlsx`, and which steps are ours rather than the
sheet's — see [`raw-material-formula.md`](./raw-material-formula.md).

| | |
|---|---|
| Implementation | `utils/rawMaterialNeed.js` — `computeRawMaterialNeed()`, `kgToSqMetres()` |
| Page | `views/inventory/orders/assignProduction.ejs` — `reelSqMtrs()`, `updateRawNeed()` |
| Unit shown | kilograms and running metres, with square metres alongside |
| Unit stored | kilograms — unchanged by any of this |

---

## Inputs

| Symbol | Meaning | Source |
|---|---|---|
| `w` | the one width budgeted, mm | `max(deckleSize, widest deckleLayout[].deckleSize)` |
| `Lᵢ` | length of web *i*, m | `deckleLayout[i].deckleRunningMeter`, else `deckleRunningMeters` |
| `nᵢ` | how many webs of *i* | `deckleLayout[i].count`, else `noOfRolls` |
| `G` | layer GSM (g/m²) | recipe: `facestockGsm`, `adhesiveGsm`, `releaseLinerGsm` |
| `kg` | what a reel/drum holds | `reelMtrs` on the raw pools — really kilograms |
| `g` | a reel's own GSM | `gsm` on the reel |

A batch with no `deckleLayout` falls back to its single web:
`w = deckleSize`, `L = deckleRunningMeters`, `n = noOfRolls`.

---

## Constants

| Constant | Value | Where |
|---|---|---|
| `WASTAGE_PCT` | 1 | `utils/rawMaterialNeed.js` |
| `ADHESIVE_SOLIDS_PCT` | 60 | `utils/rawMaterialNeed.js` |

```
waste = 1 + WASTAGE_PCT / 100          = 1.01
```

> `WASTAGE_PCT` is the single place the allowance lives — change it there and
> every figure on the page follows. The source spreadsheet says 3, but applies
> it to the *rate* as a costing adder; as a quantity this is set to 1.

---

## 1 · Area the deckle laminates

```
area  =  Σᵢ  (w / 1000) × Lᵢ × nᵢ           m²
```

**`w` is ONE width for the whole job** — the batch's `deckleSize`, or the widest
layout where some layout is wider than that. A mixed-web plan stores a width per
layout, but that is a *slitting* decision: the laminator mounts one facestock
reel and runs the lot off it, which is also all Assign Production can allot
against. Taking the widest is what stops a plan whose odd web is wider than the
headline from under-budgeting the facestock.

Run lengths are still summed per layout, so a batch mixing them is handled;
layouts that end up sharing a width *and* a length are merged into one row.

---

## 2 · What each layer needs

Every layer covers the whole deckle, so the requirement is the area plus
wastage — the same for every layer, and independent of GSM:

```
needMetres  =  Σᵢ (Lᵢ × nᵢ) × waste          m     same for every layer
need (area) =  area × waste                  m²    same for every layer
```

The per-layer **weight** is §4; it is the only one of the three that depends on
the layer's own GSM.

> Because no GSM is involved in either figure above, a layer recorded in
> microns — which cannot be weighed at all — still has a requirement.

---

## 3 · Wet adhesive

The recipe's adhesive GSM is the **dry** coat. A drum holds wet adhesive:

```
G_wet  =  G / ADHESIVE_SOLIDS_PCT × 100     g/m²
```

---

## 4 · Weights (shown in grey beside the area)

```
kg_dry  =  area × G     / 1000 × waste      kg
kg_wet  =  area × G_wet / 1000 × waste      kg      (adhesive only)
```

The figure a layer is pulled at — `kg_wet` for adhesive, `kg_dry` for the rest —
is what `totalKg` sums.

---

## 5 · What a reel holds

Two figures, because the requirement states two: the **weight** the store issues
and the **length** the machine runs.

```
kg      =  reelMtrs                          as stocked, nothing converted
metres  =  kg × 1e6 / (gsm × widthMm)
```

`reelMtrs` on every raw pool is really kilograms despite its name, so the kg
side needs no conversion at all.

Which GSM and which width:

| Layer | GSM | Width |
|---|---|---|
| Facestock, Release Liner | the reel's own, falling back to the recipe's | the **reel's own** — its true length however wide it is |
| Adhesive | the recipe's **wet** GSM (§3) | **this job's web** — a drum has no width, it coats whatever runs |

The GSM fallback is safe because the pools are filtered to this recipe's spec,
so a reel offered for a layer is the same material the recipe describes. For
adhesive the recipe's is the only source: no drum records a coat weight.

A length is only comparable because §1 pins the job to one width — metres of a
510 mm reel and metres of a 660 mm one are not the same material.

**Unmeasurable:** no GSM, or no width ⇒ metres unknown. The cell reads `—`, the
reel counts on the kg side only, and the tally says how many such reels are
ticked.

**Too narrow:** a web reel narrower than the job's web cannot be mounted on it
however many metres it holds — metres alone would read "covered" off a reel that
will not physically fit. Those rows are flagged amber with the reason on hover.
They are not dropped from the tally: the Size column and its filter are where
the choice is made, and a narrow reel can have legitimate uses.

### Area (shown, not tallied)

```
area  =  kg × 1000 / gsm                     m²
```

Still shown on the requirement line as a third figure. Width does not enter into
it, so it is the width-blind view of the same quantity.

---

## 6 · The allotment tally

Every layer is tallied against **its own pool** — facestock against the
facestock reels, adhesive against the adhesive drums — on **both** sides:

| | Needs | Each ticked reel contributes |
|---|---|---|
| **Kg** | `kg_wet` for adhesive, `kg_dry` otherwise (§4) | its kg, as stocked |
| **Mtrs** | `needMetres` (§2) | its metres (§5) |

Per layer, over the ticked reels, for each of the two:

```
picked  =  Σ  contribution(reel)
short   =  need − picked
covered      when short ≤ 0
```

The bar fills on **whichever side is further behind**:

```
bar fill (%) =  min( picked_kg / need_kg , picked_m / need_m ) × 100    capped at 100
```

so it only goes green when both are covered — enough weight but not enough
length, or the other way round, is still short.

A reel whose metres cannot be worked out counts on the kg side only and is
called out by name in the line.

---

## Worked example — batch `6aa4f3e8…` (C001WB)

Deckle: 3 webs, 1,000 m each. The plan slits two to a 660 mm layout and one
to a 635 mm layout, so the budget width is **660 mm** — the widest.
Recipe: facestock 80, adhesive 20 (dry), release liner 67 GSM.

**1 · Area**

| Width | Length | Deckle Count | m² |
|---|---|---|---|
| 660 mm | 1,000 m | 3 | 1,980 |
| | | **area** | **1,980** |

**2 · Need** — `3 × 1,000 × 1.01 =` **3,030 m** and `1,980 × 1.01 =` **1,999.80 m²**,
both the same for all three layers.

**3 · Wet adhesive** — `20 / 60 × 100 =` **33.33 GSM**

**4 · Weights**

| Layer | GSM | kg |
|---|---|---|
| Facestock | 80 | `1,980 × 80 / 1000 × 1.01` = **159.98** |
| Adhesive (dry) | 20 | `1,980 × 20 / 1000 × 1.01` = **40.00** |
| Adhesive (wet) | 33.33 | `1,980 × 33.33 / 1000 × 1.01` = **66.65** |
| Release liner | 67 | `1,980 × 67 / 1000 × 1.01` = **133.99** |

**5 · Stock** — `metres = kg × 1e6 / (gsm × width)`

| Reel | kg | GSM | Width | Metres | (area) |
|---|---|---|---|---|---|
| Facestock | 428 | 80 | 510 mm | **10,490.20** | 5,350.00 m² |
| Facestock | 516 | 80 | 510 mm | **12,647.06** | 6,450.00 m² |
| Release liner | 70.5 | 60 | 510 mm | **2,303.92** | 1,175.00 m² |
| Adhesive drum | 50 | 33.33 wet | 660 mm (the job's) | **2,272.95** | 1,500.15 m² |

The three web reels above are 510 mm against a 660 mm job — flagged amber as
too narrow, and a good illustration of why metres alone are not enough.

**6 · Tally**

Release liner — ticking the 70.5 kg / 2,303.92 m reel:

```
kg     70.50 of 133.99   ->  63.49 short
mtrs 2,303.92 of  3,030   -> 726.08 short
bar  min(52.6%, 76.0%)   =  52.6%   amber
"63.49 kg short  ·  726.08 mtrs short"
```

Adhesive — ticking one 50 kg drum:

```
kg      50.00 of  66.65   ->  16.65 short
mtrs 2,272.95 of  3,030   -> 757.05 short
```

A 428 kg / 10,490.2 m facestock reel covers both sides, so its bar goes green.


---

## Consistency checks

Every conversion is lossless, and the adhesive closes the loop:

```
kg → m  → kg        428 kg, 80 gsm, 510 mm  → 10,490.20 m → 428 kg    ✓
                   70.5 kg, 60 gsm, 510 mm  →  2,303.92 m → 70.5 kg   ✓
                     50 kg, 33.33,  660 mm  →  2,272.95 m → 50 kg     ✓

kg → m² → kg        428 kg @ 80 gsm  →  5,350.00 m²  →  428 kg      ✓
                   70.5 kg @ 60 gsm  →  1,175.00 m²  →  70.5 kg     ✓

need → kg → m²      1,999.80 m² → 66.65 kg wet → 1,999.70 m²        ✓
                    (the 0.10 is round-to-2dp on the kilograms; this
                     round trip is informational only — adhesive is
                     tallied in kilograms and never converted)
```

---

## What these formulas do *not* answer

Neither kilograms nor metres say whether a reel will **fit** the web — a 510 mm
reel cannot run a 660 mm deckle however much it holds. Those rows are flagged
amber (§5) but still count, because the Size column and its filter — pre-filled
with the deckle size — are where that choice is made.
