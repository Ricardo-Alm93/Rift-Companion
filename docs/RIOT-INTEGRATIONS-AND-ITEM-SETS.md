# Integraciones, Item Sets y ARAM Mayhem

## Riot Web API diagnostic

The diagnostic sends `GET https://{platform}.api.riotgames.com/lol/status/v4/platform-data` with `X-Riot-Token`. A successful response verifies that Riot accepted the configured key for that platform route and endpoint. A 401 is reported as an expired or invalid key; 403 as access rejected; 429 honors `Retry-After` and blocks further calls for the affected method and application region. Riot Web API is a public HTTPS service. Its key is read in Electron main only from local `RIOT_API_KEY` configuration; no key is returned through IPC or written to logs. Developer keys can expire; expiry is detected from Riot's 401 response and the user must replace the value in the local configuration using the Developer Portal. The app does not attempt key renewal.

The optional own-match query uses:

- `GET https://{regional-route}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/{gameName}/{tagLine}` to resolve the user-entered Riot ID.
- `GET https://{regional-route}.api.riotgames.com/lol/match/v5/matches/by-puuid/{puuid}/ids` to list the account's match IDs.
- `GET https://{regional-route}.api.riotgames.com/lol/match/v5/matches/{matchId}` to retrieve those matches.

The UI only returns the user's champion, lane, queue, duration, timestamp and item IDs. PUUID and other participants are not persisted or returned.

## Local LCU draft reader (experimental, opt-in)

Riot Web API, LCU, and Live Client Data are distinct interfaces. Rift Companion has an opt-in, Windows-only local LCU reader that is disabled until the user enables it in Services. It does not use `RIOT_API_KEY`. It discovers `LeagueClientUx.exe`, reads its adjacent ephemeral lockfile credential in Electron main, and connects only to `127.0.0.1` over HTTPS with the Riot certificate bundled from Riot's official docs and TLS verification enabled. The credential and raw payload are never returned through IPC, saved, or logged. The renderer receives only a normalized, sanitized roster DTO.

The only LCU requests are:

- `GET /lol-gameflow/v1/gameflow-phase` — poll the current phase and stop reading champ-select data outside `ChampSelect`.
- `GET /lol-champ-select/v1/session` — read the champ-select session only during `ChampSelect`. The adapter uses `localPlayerCellId`, team cell IDs, visible champion IDs, `championPickIntent` only for allies as an unconfirmed intent, the player's own `assignedPosition`, and completed pick actions to distinguish hovered from locked picks. Enemy picks without a completed visible pick action remain blank; enemy intents, roles and lane opponent are never inferred.

Polling is bounded to one request sequence at a time, backs off after errors, and clears roster state when the client or draft changes. The Ranked page shows client/LCU state, phase, own pick, confirmed ally/enemy counts, last update time and a sanitized error code. Manual champion/role selection remains available as fallback; screenshot/OCR detection has been removed. No LCU mutations, game inputs, hidden picks, player names, Riot IDs, rank, chat, memory inspection, or TAB interception are used. LCU is not officially supported; this private prototype has not been reviewed or approved by Riot. Do not distribute it before registering the product and disclosing the endpoints and exact use to Riot. Verify policy and the actual client contract before relying on the integration.

### Draft LCU disclosure for the Riot Developer Portal

> Rift Companion is a private desktop guide for League of Legends. The optional experimental Windows integration reads only the local League Client Update API during champion select, using `GET /lol-gameflow/v1/gameflow-phase` to detect the phase and `GET /lol-champ-select/v1/session` while that phase is active. It displays the local player's selection and champion picks already revealed in the client's ally/enemy roster. It does not expose hidden picks or player identities, infer enemy roles, scout other players, access match data for scouting, inspect process memory, or send client/game actions. The integration is user-enabled, read-only, stops outside champion select, and can be disabled at any time. Credentials remain in the local Electron main process and are not logged, persisted, or sent to a server. Recommendations are educational and do not automate purchases, runes, champion selection, or gameplay.

## Live Client Data (experimental, local, read-only)

When the LCU phase reaches `InProgress`, Rift Companion makes a bounded snapshot request to `GET https://127.0.0.1:2999/liveclientdata/activeplayername` and `GET https://127.0.0.1:2999/liveclientdata/playerlist` (plus optional game mode metadata). It identifies the active player by name and resolves ORDER/CHAOS membership only when the mapping is unambiguous; otherwise it asks for manual confirmation. The service uses HTTPS with Riot CA verification enabled, loopback-only allowlisted GET endpoints, response size limits and sanitized errors. One roster snapshot is retained; the app does not continuously inspect live game events. If started while the LCU already reports `InProgress`, the same snapshot path is attempted. This local API does not require the Riot Web API key. The integration remains experimental and has not been validated during a real ChampSelect; review the endpoint use with Riot before public distribution. No memory inspection, game input, action automation, or TAB interception is used.

## Manual Item Set export/import

The app exports a JSON Item Set file to a user-selected location. Its four blocks are Inicio, Núcleo, Componentes, and Opciones situacionales. Export uses exclusive file creation and refuses to overwrite an existing file. Import opens a user-selected JSON file, validates item IDs against the bundled Data Dragon catalog, and loads those blocks into the guide editor. It does not change the League account, game installation, or saved sets; pressing “Guardar guía” is a separate action that stores the imported build in this app only.

The structure follows the historical Item Set JSON fields used by the League client (`title`, `type`, `map`, `mode`, `associatedChampions`, and `blocks`). Riot's current public support page describes creating/importing personal item sets but does not publish a current machine-readable schema. Therefore actual import compatibility must be verified manually in the Windows League client before treating export as confirmed. ARAM uses the Howling Abyss `HA` / `ARAM` identifiers; Mayhem-specific client import behavior is unverified.

References:

- [Riot Support: Item Sets](https://support.riotgames.com/en-us/league-of-legends/gameplay/item-sets/)
- [Riot Developer Portal](https://developer.riotgames.com/docs/portal)
- [Historical Item Set JSON field reference (community archive)](https://github.com/CommunityDragon/HexDocs/blob/master/lol/misc/itemsets.md)

## Manual ARAM augment evaluator

The evaluator runs only on user-selected options. It compares explicit editorial tags for the champion, the user's saved build item tags, and up to three previously confirmed augment selections. It returns reasons, tradeoffs, or “insufficient profile”; it has no win-rate field and does not make in-game choices. The included profiles are initial examples, not a complete champion/augment knowledge base. Unknowns stay unknown.
