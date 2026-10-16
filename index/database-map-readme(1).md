# Chess Review - Database Compression Map
To save space in IndexedDB, `analysis.js` minifies the move objects before saving. 
When retrieving games for the UI, they are automatically expanded back to their full names.

## Move Object Keys
| Full Key Name     | Minified DB Key | Data Type                  |
|-------------------|-----------------|----------------------------|
| ply               | p               | Number (e.g., 1, 2, 3...)  |
| moveNum           | mn              | Number (e.g., 1, 2, 3...)  |
| san               | s               | String (e.g., "Nf3")       |
| color             | c               | String ("w" or "b")        |
| from              | f               | String (e.g., "g1")        |
| to                | t               | String (e.g., "f3")        |
| piece             | pc              | String (e.g., "n")         |
| fenBefore         | fb              | String (FEN)               |
| fenAfter          | fa              | String (FEN)               |
| eval              | e               | Number (e.g., 1.45)        |
| winPercent        | wp              | Number (e.g., 52.4)        |
| best1             | b1              | String (e.g., "e2e4")      |
| followup1         | f1              | String (Engine PV line)    |
| best1Eval         | b1e             | Number (e.g., 1.50)        |
| best1WinPct       | b1w             | Number (e.g., 54.2)        |
| best2             | b2              | String (e.g., "d2d4")      |
| followup2         | f2              | String (Engine PV line)    |
| best2Eval         | b2e             | Number (e.g., 0.90)        |
| best2WinPct       | b2w             | Number (e.g., 40.1)        |
| targetDepth       | td              | Number (e.g., 16)          |
| isBook            | ib              | Boolean (true/false)       |
| classification    | cl              | Number (Mapped ID 0-9)     |

## Classification IDs (Stored in `cl` and used for local Images)
We store a single integer to represent the move type. Your UI also uses these numbers to fetch the offline images from `pieces/mc/`.
* 1 = brilliant
* 2 = great
* 3 = best
* 4 = excellent
* 5 = good
* 6 = book
* 7 = inaccuracy
* 8 = mistake
* 9 = miss
* 0 = blunder
