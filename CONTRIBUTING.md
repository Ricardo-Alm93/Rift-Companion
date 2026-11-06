# Contributing

Thanks for considering a contribution. Rift Companion is currently a personal, non-commercial Electron project. Contributions should keep the app local-first, preserve user control, and keep Ranked and ARAM Mayhem study modes distinct.

## Development setup

1. Install Node.js 22.12+ and npm.
2. Clone the repository and run `npm ci`.
3. Run `npm start` to open the desktop app.
4. A Riot Web API key is optional; do not add one to a patch or issue. See `.env.example` for the local-only configuration.

## Before submitting a change

Run the relevant checks:

```powershell
npm run check
npm test
npm run validate:data
npm run validate:aram-mayhem
npm run test:electron
npm run test:ci
```

The default test suite uses authored synthetic fixtures and must not require ignored audit snapshots. If you have the local OP.GG audit files and are authorized to use them, run the separate `npm run test:opgg:integration` suite; never add those files to a contribution.

Describe what changed, how it was verified, and which behavior still needs a real Windows/League check. Never describe a fixture or simulated provider test as real-game validation.

## Data and safety requirements

- Keep the source, patch/version, retrieval date, and evidence status for externally sourced game knowledge.
- Keep observed builds distinct from generated educational proposals. Never attach an observed win rate to a modified/generated set.
- Do not add Riot IDs, account history, LCU credentials, API keys, personal caches, raw logs, or local snapshots to a change.
- Do not add OP.GG response data or derivative audit reports unless its redistribution terms are confirmed.
- Keep `data/aram-mayhem/` attribution and CC BY 4.0 metadata intact.
- Do not add process-memory access, injection, screenshots/OCR for live game state, hidden-opponent data, or automated game inputs.
- Do not add a paid service, ads, a subscription, or an Overwolf dependency.
- Keep `src/experimental/overwolf-aram/` isolated from the standard Electron runtime.

## Pull requests

Small, focused changes are easier to review. Include tests for behavior changes, note any Data Dragon patch assumptions, and do not bundle generated output, `node_modules`, `work/`, `outputs/`, `.env.local`, or screenshots containing account/personal information.

The project does not yet have a final repository-wide source license. Until one is selected and third-party content boundaries are reviewed, do not assume that every file is available for reuse under a single license.
