# Geography provenance

`geometry.generated.js` is generated from the U.S. Census Bureau's 2025 1:20m
cartographic-boundary KML archive. The build script verifies the pinned archive
SHA-256, keeps exactly the 50 state postal codes, applies a lower-48 Albers
equal-area conic projection, fits Alaska and Hawaii into fixed insets, and rounds
all output coordinates to two decimals. The generated module contains all map
geometry needed at runtime; the site never fetches map assets.

- Source: https://www2.census.gov/geo/tiger/GENZ2025/kml/cb_2025_us_state_20m.zip
- SHA-256: `efddd884f1442ef233b1ba9c12dddbd66b6fdf94da6a373e1556aefe3dbc5751`
- Generator: `field-atlas-geometry/1.0.0`

Rebuild from the repository root with:

```sh
node scripts/build-atlas-geometry.mjs /tmp/cb_2025_us_state_20m.zip
```
