# Data sources and redistribution notes

This project mixes original software with game data and external service responses. A source-code license does not automatically cover those datasets, images, trademarks, or service responses.

| Source | Use in the app | Network/key | Local/public-repository treatment |
|---|---|---|---|
| Riot Data Dragon | Champion/item/rune data and static images | Internet for refresh/CDN; no Riot Web API key | Bundled JSON is Riot-derived game-specific static data, not project-authored code. Images are loaded from Riot CDN. Keep the attribution/non-affiliation notice; check current Riot terms before release. |
| OP.GG MCP | On-demand Ranked statistical analysis/builds | Internet; no Riot key | The app caches responses under Electron userData. Live response snapshots and generated reports embedding them are ignored by Git pending confirmation of redistribution rights. |
| arammayhem.com/data | Bundled ARAM Mayhem pick-rate/catalog snapshot | Internet to refresh; no Riot key | Snapshot self-identifies CC BY 4.0. Preserve `Data: arammayhem.com` attribution, link, and embedded metadata. |
| Meraki Analytics | Optional champion knowledge lookup/cache | Internet; no Riot key | Upstream software declares MIT and asks for credit to Meraki and League of Legends Wiki. The underlying ability content has its own provenance; no response snapshot is bundled. |
| CommunityDragon | Adapter available, ingestion disabled | None while disabled | No CommunityDragon extracted dataset is bundled. Reuse terms for extracted game data were not verified. |
| Riot Web API | Optional Riot service diagnostics and player's own recent matches | Internet and user's own Riot API key | Key is read in Electron main process from environment / `.env.local`; never bundle it. Not used by build matching or draft autodetection. |
| LCU / Live Client Data | Optional local roster/client state | Local League process; no Riot Web API key | Experimental and read-only. Not officially supported as a third-party API. Do not publish credentials, lockfile or unredacted diagnostics. |
| README demo screenshots | UI-only captures rendered from project-authored test fixtures | Generated locally by `npm run capture:readme-screenshots` | They contain no player/account data. Champion and item artwork visible in captures remains Riot IP; screenshots are not covered by an eventual source-code license. |

## Policy links reviewed on 2026-11-05

- [Riot Developer API Policy](https://developer.riotgames.com/docs/lol#developer-api-policy)
- [Riot General Policy](https://developer.riotgames.com/policies/general)
- [Riot Legal Jibber Jabber](https://www.riotgames.com/en/legal)
- [Riot Data Dragon documentation](https://developer.riotgames.com/docs/lol#data-dragon)
- [ARAM Mayhem data license/attribution](https://arammayhem.com/data/)
- [OP.GG MCP repository](https://github.com/opgginc/opgg-mcp)
- [OP.GG Help Center: use of OP.GG data](https://help.op.gg/hc/en-us/articles/31091405109401-Can-I-use-OP-GG-data)
- [OP.GG Terms of Use](https://op.gg/lol/policies/agreement)
- [Meraki Analytics static-data repository](https://github.com/meraki-analytics/lolstaticdata)

Riot's developer docs permit game-specific static data and require product registration for player-facing products. Riot's Legal Jibber Jabber also contains IP/app language. This repository does not resolve the interaction between those documents; a public release should preserve required notices and receive a careful policy review. Open source code does not grant rights to Riot IP.

OP.GG's Help Center says crawling/use is generally not prohibited with proper attribution and reasonable requests, while the OP.GG Terms of Use prohibit reproducing/distributing site/service content without express written consent and prohibit scraping/data mining. Because the wording is not fully aligned for a source snapshot embedded in a public repo, the repo excludes OP.GG response snapshots, source-derived pilot profiles, and reports that embed those records. Runtime on-demand requests remain a separate use and should still be rechecked against current terms and Riot policies before release.

## Recommended publication boundary

The repository's MIT license applies only to original source code authored for Rift Companion. Keep it separate from Riot-derived datasets, CC BY data, and remote-source snapshots. Do not commit OP.GG response captures or derivative reports unless OP.GG's terms clearly permit republication. The repository license does not relicense third-party data or assets.
