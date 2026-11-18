# Wibenji Upland city hotspots

Daily public city snapshots and additional hotspot preselection lists for Wibenji’s Upland Toolbox. The extension integration is the next step; this repository does not change user settings.

## Scan order and schedule

Each run starts **Bakersfield (9) → Los Angeles (32) → Las Vegas (35)**. All other cities returned by Upland’s published neighborhood boundaries follow. Cities without published boundaries are listed separately in the discovery plan rather than reported as successfully scanned.

The first all-city run is already active: [live scan](https://github.com/vibenji/upland-city-hotspots/actions/runs/44219802095). Automatic runs start daily at **01:17 UTC** (02:17 German winter time / 03:17 summer time); manual starts are available in Actions. GitHub may delay scheduled starts. One workflow and one city scanner run at a time. Remaining cities are split into sequential batches of six to stay within runner time limits. An individual failed city keeps its last complete public snapshot; other cities are still attempted.

## Public download contract

- [Current index](https://github.com/vibenji/upland-city-hotspots/releases/download/current-data/index.json)
- [Recovery index](https://github.com/vibenji/upland-city-hotspots/releases/download/current-data/index-backup.json)
- [Current discovery plan](https://github.com/vibenji/upland-city-hotspots/releases/download/current-data/plan.json)
- [Data releases](https://github.com/vibenji/upland-city-hotspots/releases)

Read index.json and select its city record. GitHub may cache the asset redirect: refresh the mutable index with cache disabled and a changing query parameter, while immutable city/ranking URLs can be cached. A rankings status of pending has no download URL yet; keep using the last valid local data. A complete city has a dataset.url pointing to an immutable gzip JSON asset, with decoded and compressed SHA-256 checksums, scan timestamp and counts. Download, decompress and validate it before replacing the locally cached dataset. Follow exact URLs in the index; data releases are grouped by date. The initial rollout also has files in current-data. Old snapshots are retained. No large daily datasets are committed to Git history.

If the current index is temporarily unavailable during asset replacement, retry or read index-backup.json and retain local cached data. The writer saves the last valid index before replacing the current one, recovers from that backup, and refuses to initialize an empty catalog after established data disappears. Failed or in-progress attempts are recorded separately from the last successful city snapshot. A missing city is not evidence that its sources have ceased to exist.

## Complete data and three additional lists

The full city file retains every source parcel and route-eligible landing found inside the published neighborhood boundaries, including parcels outside the general toplists. Source IDs, model identifiers, coordinates, available geometry and public facts remain available for a later full-city **Starred Troves** search. Do not restrict that search to the precomputed lists. Personal timers, finds, inventory and collections are not included; placeholder scan readyAt values are not evidence of a player’s cooldown or discovery.

A city record’s rankings.url supplies three separate lists, normally 250 primary destinations plus 250 reserves:

| Mode | Existing Toolbox rule |
| --- | --- |
| maximum-coverage | Highest weighted source coverage; cheaper sends break ties |
| balanced | Coverage divided by the square root of the send fee |
| lowest-fees | Lowest verified send fee among productive candidates |

Defaults are 50 plants per structure and a 60-metre preselection radius. These are **preselection lists**, not native-arrival validation or personalized routes. The extension must still apply personal cooldowns, chosen Trove targets and native reachability. It can search the complete source data before choosing a route shortlist.

The anonymous map API supplies no send fees, and anonymous bulk details return 401. The processor therefore reads public property details sequentially, at least 250 ms apart, reuses one-day fee facts and currently checks up to **1,000 highest-coverage candidates per city per run**, with a ten-minute enrichment budget. Unknown fees are never zero. feeCoverage, feeScope and status: partial-fees explicitly show the limitation: Lowest Fees is not a guarantee of the globally cheapest productive parcel in the entire city. Three lists can still be provided while this coverage is partial. Rate limits honor Retry-After; transient failures back off and stop after six consecutive failures.

Raw city data is published first. During the initial rollout the running scanner loads the owner’s latest public build-lists.mjs after each city and logs its SHA-256, allowing list processing to be completed without restarting scans. Cities that finished before that file existed stay rankings: pending until the automatic backfill workflow runs after the all-city scan. Backfill downloads the verified full dataset and builds lists without repeating map scans; it shares the scan publication lock.

## Validation and implementation limits

Run node --test queue.test.mjs rankings.test.mjs. GitHub also runs this suite on pushes and before scheduled scans. Tests cover ordering, complete-data retention, index recovery, per-mode comparisons, unknown fees, fee cache reuse and rate-limit/backoff behavior. The list generator was additionally checked offline against the complete Los Angeles benchmark dataset.

The verified scanner uses sequential requests, tile subdivision, timeouts and Retry-After/backoff. Each city stops after 45 minutes or 2,000 map attempts and is reported incomplete, preserving previous public data. This is an in-memory journal adapter, so it does not benchmark Chrome disk latency. Bundled type-name enrichment is disabled; public source IDs and models remain present for client-side resolution. Coverage follows published neighborhood boundaries, not an independently verified census of every Upland parcel. No account tokens or personal history are published.

Original scanner code and ideas by **Wibenji**. Preserve attribution when reusing.

## Full Los Angeles scan — 18 November 2026

[Successful GitHub Actions run](https://github.com/vibenji/upland-city-hotspots/actions/runs/44217037680)

| Measurement | Result |
| --- | ---: |
| City ID | 32 (Los Angeles) |
| Complete published-neighborhood coverage | 134 / 134 map tiles |
| Scan time | 370.338 seconds |
| Scan, hotspot calculation and export | 376.594 seconds |
| Hotspot calculation | 3.799 seconds |
| HTTP requests | 135 (134 map + 1 neighborhood) |
| HTTP status | 200 for all 135 requests |
| Rate limits / timeouts / retries | 0 / 0 / 0 |
| Unique parcels | 540,048 |
| Parcels with sources | 8,400 |
| Plant instances | 48,926 |
| Service structure instances | 10,598 |
| Ranked hotspot candidate parcels | 60,101 |
| Decoded API response bytes | 767,901,682 |
| City JSON bytes | 100,862,944 |
| Compressed artifact bytes (including measurements) | 14,693,428 |

The longest map response took 22.3 seconds; the median took 1.763 seconds and the 95th percentile 5.855 seconds. The run made no retry attempts and needed no additional tile subdivision.

The workflow artifact contains city-32.json, metrics.json and requests.json, with three-day retention. After download, the city JSON checksum, unique parcel count, source count, and all request results were verified.

City JSON SHA-256: 2486eeaa3546c09184e596bfb4a0c6ef672eaaff4875fd57527b83c951ca2aab

## Scope and limitations

The script bundles the Toolbox 3.1.7 scanner, boundary geometry, subdivision, chunk journal and retry rules. Requests are sequential, separated by at least 250ms; rate-limit replies honor Retry-After and backoff. Six consecutive failures, 45 minutes or 2,000 requests stop the experiment and report an incomplete result.

The journal uses an in-memory structured-clone storage adapter, so Chrome disk latency is excluded. Bundled source type-name enrichment is disabled; source IDs, models, coordinates and source counts are retained. No personal history, account tokens or user cooldowns are included. Coverage is defined by Upland’s published neighborhood boundaries, not an independently verified city parcel census. This single-city result does not establish timing or request limits for scanning every city.

For daily distribution, use a compressed file per city rather than committing large uncompressed daily snapshots to Git history.

Original scanner code and ideas by Wibenji. Preserve attribution when reusing.

### Recovery of incomplete city data

The backfill workflow retries failed, incomplete cities before generating all pending three-mode lists from existing full snapshots. It shares the daily scan concurrency group, so publication cannot race the active all-city run. Successful maps are not scanned again for missing lists. The scan worker retries truncated neighborhood responses with bounded backoff. Explicit unpublished neighborhood placeholders (no geometry, area, center or residents, such as New Orleans AIRPORT) are ignored; malformed published geometry and cities with no published boundaries still fail validation. Complete data means all parcels within the published neighborhood boundaries.

### One named job per city

Daily scans run as separate Bakersfield, Los Angeles and Las Vegas jobs in that order, followed by one named matrix job per remaining city. Failed-map recovery and missing-list backfill also use a separate named job per affected city. Each city has its own logs, status and measurements artifact; only one city runs at a time. Already running workflows retain their original job graph; the new layout applies to subsequent runs.
