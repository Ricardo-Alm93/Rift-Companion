# ARAM Mayhem Overwolf GEP proof of concept

This folder is deliberately isolated from Rift Companion's standard Electron startup. Nothing in `src/main.js`, `src/app.js`, `src/preload.js`, or the production package configuration loads it.

## Feasibility

Overwolf's [League GEP event reference](https://dev.overwolf.com/ow-electron/live-game-data-gep/supported-games/league-of-legends/) lists the `augments` feature, introduced in GEP 299.0. Its `augments` info update provides the available augment names and `picked_augment` provides the last selected augment name. `matchState` exposes `matchStarted`, `matchId`, and `queueId`. Riot's [queue catalog](https://static.developer.riotgames.com/docs/lol/queues.json) identifies queue 2400 as ARAM: Mayhem. These fields are enough for a no-OCR event path when GEP is available.

Overwolf Electron is not a package that can be added to this app's current stock Electron binary. It is an Overwolf Electron runtime/fork with the GEP package. A real integration requires Overwolf developer access, an OW-Electron development setup, GEP package configuration, and confirmation that League GEP is enabled for the app's environment. Overwolf documents [per-game rollout](https://dev.overwolf.com/ow-electron/live-game-data-gep/live-game-data-gep-intro/), a DEV channel for games not yet moved to PROD, and contacting DevRel to move a game to PROD. Its current [app approval terms](https://dev.overwolf.com/ow-electron/monetization/overview/) also require Overwolf monetization and Appstore listing; it says personal/private-only apps are not approved. This is a material constraint for Rift Companion's local-only goal.

Live Client Data remains a separate HTTPS loopback interface. The PoC uses its existing strict TLS request helper to identify the local player and read their purchased item IDs. GEP does not document a Headliner field, so the live path leaves Headliner unknown. GEP updates are not an event history: after a reconnect, `getInfo()` can recover current offers and the latest picked augment, but cannot reconstruct earlier picks that were missed. The session therefore marks history incomplete instead of inventing selections.

## Isolated runtime

- `mayhem-runtime.cjs` normalizes GEP offer/pick updates, scopes selections to provider game + Riot match ID, deduplicates repeated notifications within an offer round, preserves a repeat if it appears in a later offer round, calls the existing qualitative evaluator/build adapter/item validator, and publishes one shared DTO through `onState` for main UI/overlay consumers.
- `ow-electron-bridge.cjs` subscribes to `game-detected`, `new-info-update`, `new-game-event`, `game-exit`, and error/elevation events; enables the League provider, requests only `matchState` and `augments`, reads current GEP state on reconnect, and polls Live Client Data for the active player's champion and inventory while the Mayhem session is live.
- The runtime uses Riot queue ID 2400 for mode confirmation. It does not query Riot Web API, inspect memory, capture screenshots, or automate inputs.

## Local checks vs real provider test

`tests/overwolf-aram-mayhem-poc.test.cjs` uses a fake GEP EventEmitter and fake Live Client Data responses. It checks Jinx's offers and three picks, deduplication/repeated legitimate choices, unknown augment rejection, a new match, reconnect gaps, automatic inventory refresh, and the shared main/overlay state callback. These are contract simulations only; they do not prove GEP is installed or that a real League match emits these events.

Before connecting this code to the application, the developer must obtain OW-Electron development access and confirm League's GEP package availability for that account/environment. The required acceptance test remains a real ARAM Mayhem game in Overwolf Electron: confirm current queue/match IDs, observe three offers, pick an augment in-game, confirm `picked_augment`, see the build state update in both windows, then repeat and test reconnect/end. Until that happens, automatic in-game detection is **not available in the shipped Rift Companion app**.
