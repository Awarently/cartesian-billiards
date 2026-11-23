# Cartesian Billiards

Every position has a number. Every shot has a solution.

A bank and kick shot calculator for pool. Place the balls, tap a pocket, and the app gives the cushion aim point as one number, for example `T4.64` (top rail, 4.64 diamonds from the left corner).

Bank, kick and kick-to-pocket shots off 1, 2 or 3 cushions, with every valid route listed and ranked. Ghost ball, cut angle, obstruction check. Each route also shows a rule you can do in your head (weighted average, equal steps, around the corner), and a kick drill trains you to use them. Installable on iPhone, iPad and Android. Works offline after the first load.

## User guide

The step-by-step guide, including how the numbers work, is inside the app: tap **Guide** at the top right, or open [guide.html](https://awarently.github.io/cartesian-billiards/guide.html). It is cached for offline use.

## Install on iPhone or iPad

1. Open the GitHub Pages URL of this repo in **Safari**.
2. Tap **Share**, then **Add to Home Screen**.
3. Open it once while online. After that it works with no connection.

On Android, open the URL in Chrome and tap **Install app**.

## Coordinate system

| Item | Value |
|---|---|
| Surface | x 0 to 8 (long side), y 0 to 4 (short side) |
| Origin | Bottom-left corner |
| Unit | One diamond interval |
| Rails | B (y = 0), T (y = 4), L (x = 0), R (x = 8) |
| Pockets | BL (0,0), BM (4,0), BR (8,0), TL (0,4), TM (4,4), TR (8,4) |
| Aim point | Rail letter + position along that rail, e.g. `L1.80` |

Rotating the table on screen changes only the drawing. All numbers stay in table coordinates.

## How the solver works

Mirror (unfolding) method. To bank off a rail, reflect the pocket across the rail and draw a straight line from the ball to the image. Where that line crosses the rail is the contact. More rails: reflect across each rail in reverse order. The engine (`solvePath`) supports any cushion sequence; the interface offers 1, 2 or 3 cushions and checks every sequence (4, 12 and 36 of them).

With real ball size on, the reflection line moves in by one ball radius (the ball centre turns there, not at the cushion nose). Each contact has three values:

- **Aim point**: the incoming line extended to the cushion nose. This is the number shown.
- **Ball contact**: where the ball touches the cushion.
- **Centre**: the ball-centre position at contact.

Point-ball mode (uncheck *Real ball size*) reproduces the spec reference test: ball (2, 1) to pocket (8, 0) off the top rail gives `T4.57` (32/7).

## Head-math rules

`headMath()` in `solver.js` expresses a route as arithmetic on the rail numbers. S is where the first ball line, extended backward, crosses the rail opposite the first cushion.

| Rule | Route | Formula |
|---|---|---|
| Weighted average | 1 cushion | Aim = (b·d₂ + t·d₁) ÷ (d₁ + d₂) |
| Equal steps | Alternating parallel rails (T-B-T…) | Contact k = Aim + k·(Aim − S) |
| Around the corner | Long-short-long or short-long-short | Counted from the middle cushion: Land = S − 2·Aim |

These are exact for a point ball (unit tests). With ball size the solver can differ by up to ~0.3 diamond; the app shows the difference.

## Assumptions and limits

- Ideal geometry: equal angle in and out. No spin, throw, or cushion compression.
- Speed budget: each route gets an estimated cue speed (soft / medium / firm / hard), worked backward from the pocket through cloth, cushion and cut losses. Routes that need more than a hard stroke (7.5 m/s), or are too fast for their cut angle, are rejected as not playable. Constants are textbook estimates in `tableConfig().speed`, not measured. A real table plays different from these numbers. Use them as a reference, then adjust.
- Diamonds are treated as on the cushion nose line. Real diamonds sit on the rail top, behind the nose.
- Table sizes use playing-surface dimensions: 7 ft 78 x 39 in, 8 ft 88 x 44 in, 9 ft 100 x 50 in. Ball 2.25 in.
- Pocket jaw and mouth sizes are approximations (corner jaw 3.4 in, side half-mouth 2.7 in). They set which routes are rejected near pockets. Change them in `tableConfig()` in `solver.js`.
- "Auto" picks the valid route with the lowest heuristic score: travel distance + 1.5 per extra cushion + a cut penalty that rises steeply past 30° + 1 per warning. Classes: under 9 Easy, under 13 Moderate, under 17 Difficult, else Advanced. It is not a make probability.
- Layout and settings are saved in the browser on each device. They do not sync.

## Files

| File | Purpose |
|---|---|
| `solver.js` | Geometry engine. No DOM. Runs in the browser and in Node. |
| `app.js` | SVG table, input, instruction panel. |
| `index.html`, `styles.css`, `fonts.css` | Page and styles. Fonts are self-hosted. |
| `guide.html` | Player guide. Self-contained, linked from the app header. |
| `sw.js` | Service worker for offline use. |
| `manifest.webmanifest`, `icons/` | Home-screen install. |
| `tests/solver.test.js` | Solver unit tests. |

## Develop

No build step and no dependencies.

```
npm test          # runs the solver tests (Node 18+)
npm start         # serves on http://localhost:8080
```

When you change any file, bump `VERSION` in `sw.js`. Installed copies then fetch the new files on next open.

## Licence

Fonts: IBM Plex Sans, IBM Plex Mono, Barlow Condensed, SIL Open Font License 1.1.
