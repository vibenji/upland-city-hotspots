# Wibenji Upland city hotspot experiments

Feasibility benchmarks for Wibenji’s Upland Toolbox. No daily schedule or extension integration is enabled yet.

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
