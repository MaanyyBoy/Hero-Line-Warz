# Hero Line Warz — Multiplayer Server (backend only)

⚠️ **The playable game is the Unity project `HellbourneWars`**
(`C:\Users\emanu\HellbourneWars`). This repo now keeps **only the authoritative
multiplayer server** (`server/`), which the Unity client connects to (deployed on Render).

The old **web client** (`main.js` / `index.html`) was **retired 2026-06-17** — it is fully
superseded by the Unity port. A full reference copy is preserved at
`HellbourneWars/Legacy/` (and in this repo's git history).

## Do NOT edit gameplay or UI here
Those changes belong in the Unity project. Only the server is live:

- `server/game-engine.js` — authoritative simulation (all 3 modes)
- `server/server.js` — WebSocket relay / rooms
- `server/package.json` — `npm start` → `node server.js`

`assets/` is kept as a source-asset backup (already imported into Unity).
