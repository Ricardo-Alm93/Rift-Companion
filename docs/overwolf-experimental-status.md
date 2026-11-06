# Overwolf prototype status

Overwolf migration is stopped. Rift Companion's target remains free, personal, non-commercial, and based on standard Electron. Keep `src/experimental/overwolf-aram/` isolated as research code; do not import it into the product runtime, register/submit an app, or contact Overwolf automatically.

Overwolf's current OW-Electron requirements do not fit this project. As documented on 2026-11-05, access requires proposal approval/whitelisting; private apps are not approved; apps must be listed and distributed through Overwolf Appstore; and, effective 2026-11-01, apps must integrate Overwolf ads, Tebex subscriptions, or both to be approved. Those requirements conflict with the project's personal, noncommercial, standard-Electron goal. Current documentation reviewed 2026-11-05:

- [Overwolf project roadmap / app proposal](https://dev.overwolf.com/ow-electron/getting-started/project-roadmap/)
- [Overwolf development access](https://dev.overwolf.com/ow-electron/getting-started/develop-your-idea/)
- [GEP introduction](https://dev.overwolf.com/ow-electron/live-game-data-gep/live-game-data-gep-intro/)
- [Monetization overview](https://dev.overwolf.com/ow-electron/monetization/overview/)

The prototype's simulated event tests are not evidence of access to real GEP events, permission from Overwolf/Riot, or a viable distribution route. If project direction changes, first review the current terms manually; no external request or application has been sent by this project work.

## Current Mayhem state

Live Client Data worked during a real Mayhem match, but the observed documented local payloads did not identify the selected augment. Automatic adaptation stays disabled. The provider-neutral event contract and study mode remain separate and reusable if a permitted source is confirmed later.
