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
| Unit shown | square metres (kilograms alongside, in grey) |
| Unit stored | kilograms — unchanged by any of this |

---

## Inputs

| Symbol | Meaning | Source |
|---|---|---|
| `wᵢ` | width of web *i*, mm | `deckleLayout[i].deckleSize`, else `deckleSize` |
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

Summed per layout, so mixed webs are handled:

```
area  =  Σᵢ  (wᵢ / 1000) × Lᵢ × nᵢ          m²
```

---

## 2 · What each layer needs

Every layer covers the whole deckle, so the requirement is the area plus
wastage — the same for every layer, and independent of GSM:

```
need  =  area × waste                       m²
```

> Because no GSM is involved, a layer recorded in microns — which cannot be
> weighed at all — still has a requirement.

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

## 5 · Stock: kilograms → square metres

The exact inverse of `kg = area × gsm / 1000`:

```
area  =  kg × 1000 / gsm                    m²
```

No width enters into it. A reel's area is what it covers however it is slit, so
reels of different widths compare directly — and an adhesive drum, which has no
width at all, converts on the same footing.

Which GSM:

| Layer | GSM used |
|---|---|
| Facestock, Release Liner | the reel's own `g`, falling back to the recipe's `G` |
| Adhesive | always the recipe's `G_wet` — no drum records a coat weight |

The fallback is safe because the pools are filtered to this recipe's spec, so a
reel offered for a layer is the same material as the recipe describes.

**Unmeasurable:** no `g` and no `G` ⇒ area unknown. The cell reads `—`, the reel
counts as zero in the tally, and the tally states how many such reels are
ticked.

### Reel length (hover only)

For a web reel, shown on hover beside the kilograms:

```
length  =  area / (size / 1000)             m
```

---

## 6 · The allotment tally

Per layer, over the ticked reels:

```
picked  =  Σ  area(reel)
short   =  need − picked

covered      when short ≤ 0
bar fill (%) =  min(100, picked / need × 100)
```

---

## Worked example — batch `6aa4f3e8…` (C001WB)

Deckle: 2 webs × 660 mm and 1 web × 635 mm, each 1,000 m.
Recipe: facestock 80, adhesive 20 (dry), release liner 67 GSM.

**1 · Area**

| Width | Length | Webs | m² |
|---|---|---|---|
| 660 mm | 1,000 m | 2 | 1,320 |
| 635 mm | 1,000 m | 1 | 635 |
| | | **area** | **1,955** |

**2 · Need** — `1,955 × 1.01 =` **1,974.55 m²**, for all three layers.

**3 · Wet adhesive** — `20 / 60 × 100 =` **33.33 GSM**

**4 · Weights**

| Layer | GSM | kg |
|---|---|---|
| Facestock | 80 | `1,955 × 80 / 1000 × 1.01` = **157.96** |
| Adhesive (dry) | 20 | `1,955 × 20 / 1000 × 1.01` = **39.49** |
| Adhesive (wet) | 33.33 | `1,955 × 33.33 / 1000 × 1.01` = **65.81** |
| Release liner | 67 | `1,955 × 67 / 1000 × 1.01` = **132.29** |

**5 · Stock**

| Reel | kg | GSM | m² |
|---|---|---|---|
| Facestock | 428 | 80 | `428 × 1000 / 80` = **5,350.00** |
| Facestock | 516 | 80 | **6,450.00** |
| Release liner | 70.5 | 60 | **1,175.00** |
| Adhesive drum | 50 | 33.33 (wet) | **1,500.15** |

**6 · Tally** — ticking the 70.5 kg release reel against a 1,974.55 m² need:

```
picked = 1,175.00      short =  799.55      bar = 59.5%
"799.55 sq.mtrs still needed · 1,175 of 1,974.55 sq.mtrs"
```

---

## Consistency checks

Every conversion is lossless, and the adhesive closes the loop:

```
kg → m² → kg        428 kg @ 80 gsm  →  5,350.00 m²  →  428 kg      ✓
                   70.5 kg @ 60 gsm  →  1,175.00 m²  →  70.5 kg     ✓
                     50 kg @ 33.33   →  1,500.15 m²  →  50 kg       ✓

need → kg → m²      1,974.55 m² → 65.81 kg wet → 1,974.50 m²        ✓
                    (the 0.05 is round-to-2dp on the kilograms)
```

---

## What these formulas do *not* answer

Area says whether there is **enough** material, not whether it will **fit** the
web — a 510 mm reel cannot run a 660 mm deckle however many square metres it
holds. That is judged by the Size column and its filter, pre-filled with the
deckle size.
