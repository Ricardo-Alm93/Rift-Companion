# Source license proposal (not a license grant)

No root `LICENSE` file is added by this proposal. The repository combines original software with Riot game data/assets, CC BY data, and runtime dependencies. A single file at the repository root could be misread as licensing content the project author does not own.

## Possible boundary for later review

MIT could be considered for the code written specifically for Rift Companion, after authorship and embedded-content review. The scope would need to identify original source paths, for example `src/` excluding vendored/third-party material, project-authored `scripts/`, and project-authored tests. It would not license other material merely because it is present in the same tree.

Explicit exclusions from any project-code MIT grant should include:

- `data/dragon/**` and Riot champion/item/rune data and artwork; these remain Riot-derived content governed by Riot's policies and notices.
- `data/aram-mayhem/**` where files carry the source's CC BY 4.0 dataset; retain the source attribution and license metadata.
- `docs/assets/screenshots/**` where Riot champion/item/augment art is visible; screenshots are documentation artifacts, not project-owned game artwork.
- `node_modules/**`; each dependency keeps its own license and notices.
- Any future externally sourced dataset, cached service response, font, icon, or binary until its terms and redistribution rights are verified.

`THIRD_PARTY_NOTICES.md` and `docs/DATA_SOURCES.md` remain the provenance index. Before adding `LICENSE`, the maintainer should review every candidate file, mark owned code scope clearly, keep exclusions explicit, and decide how the GitHub license label will avoid implying a license over third-party data. This proposal is not legal advice and grants no rights by itself.
