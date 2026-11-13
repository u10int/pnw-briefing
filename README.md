# PNW weather briefing

A daily, automated forecast briefing for **Western Washington and Northwest Oregon**. It compares
precipitation totals across regional, blended and global models and flags weather impacts from
precipitation, snow, temperature and wind. It runs on GitHub Actions each morning and publishes a
static page to GitHub Pages, with a dated archive.

It has two parts:

- **`briefing/` (Python)** fetches the models, runs the analysis, draws the maps and writes
  `briefing.json`.
- **`web/` (React + [shadcn/ui](https://ui.shadcn.com))** renders that JSON with shadcn's Card,
  Table, Badge, Tabs, Select, Tooltip, Progress, Separator and Chart (Recharts) components.

## Models

GRIB2 is the primary source. Herbie reads each file's `.idx` sidecar and downloads only the
messages it needs (precipitation, snowfall, 2 m temperature, gust), so each model costs MBs, not GBs.

| Tier | Model | Source | Range used |
|---|---|---|---|
| Regional | HRRR | NOAA NODD | 2 days |
| Regional | RRFS | NOAA NODD | 3 days |
| Regional | NAM 3 km nest | NOAA NODD | 2 days |
| Blend | NBM | NOAA NODD | 11 days |
| Global | GFS | NOAA NODD | 14 days |
| Global | ECMWF IFS | ECMWF open data | 9 days (10-day run from 00Z) |
| Global | ECMWF AIFS | ECMWF open data | 14 days |
| Ensemble | GEFS (31 members) | NOAA NODD | 14 days |
| Ensemble | ECMWF ENS (51 members) | ECMWF open data | 14 days |

**Optional supplement.** Models with no public GRIB feed (HRDPS, GEM, ICON, UKMO, Météo-France,
JMA and the GEPS ensemble) come from Open-Meteo. They're marked * on the page. Turn them off
with `supplement.enabled: false`. The free tier is for non-commercial use. For work use, take
their commercial tier or swap in Xweather points in `briefing/points.py`.

### How models are compared fairly

- **One day definition.** Every model, GRIB or not, is summed over the same **12Z–12Z days**
  starting today at 12Z (4 AM PST). That lets 00Z globals and 12Z regionals line up exactly.
- **Windows.** Totals are compared over the next 48 hours, 7 days and 14 days. A model appears
  only in windows it fully covers, so a 2-day HRRR is never set against a 14-day GFS.
- **Grids.** Regional models stay on their native projected grids for their own maps. For the
  multi-model mean and spread, every model is resampled by nearest neighbour onto a common
  0.05° grid.

## What's on the page

The page opens with an **overview**: the headline and run status, a summary card per hazard tab
(precip, flooding, wind, snow and mountains, temperature; each flags how notable the forecast is
and opens its tab), NWS alerts, the impacts table and agreement grid, what changed since
yesterday, and what NWS forecasters are saying. Below it, **tabs** group the
detail by hazard: *Precip* (how much, when and where), *Flooding* (how wet it's been, landslide
threshold, atmospheric rivers, ensemble heavy-rain odds), *Wind*, *Snow & mountains*, *Temperature*, *Map* (the
interactive map, loaded when first opened) and *Locations*. The tab bar sticks to the top while
scrolling, the selected tab is kept in the URL (`#wind`, `#map`, …) so links open it directly,
and "on the map" buttons in each hazard tab open the Map tab on the matching layer. The sections
below are described in that order of content, not page order.

- **Headline.** Built from the same summaries as the hazard cards: it leads with the most notable
  hazard, lists any others worth watching, then gives the 14-day regional totals and the wettest
  stretch. A briefing with nothing notable says so.
- **Run status.** One line ("16 of 16 model runs") that opens the per-model list, with an amber
  badge naming any model that's missing.
- **Window cards** (Precip tab). The 48 h, 7 d and 14 d medians per region, with the model range
  drawn as a bar, percent of normal, and the change since yesterday's briefing.
- **Since yesterday.** The overview's timeline shows each impact on the forecast's day axis, marked
  new, upgraded, downgraded or moved; yesterday's dates for anything that moved, and impacts that
  dropped out, sit in a muted, dashed row beneath. Events are matched one to one by hazard,
  overlapping dates first and then within a day, so a move isn't reported as dropped plus new.
  Region totals now and in yesterday's briefing, compared over the *same dates* (today's 14-day
  window overlaps yesterday's for 13 days), sit in the Precip tab.
- **Alerts.** Active NWS watches, warnings and advisories for the U.S. locations and Environment
  Canada's for the B.C. ones (coloured by its yellow, orange and red risk levels), beside the
  automated flags. The list is captured at build time and refreshed live in the browser.
- **Impacts.** Heavy rain (24 h and 72 h), snow, hard freeze, possible icy precipitation, strong
  gusts and heat. Each shows *Likely* or *Possible* confidence, the share of models agreeing,
  and the peak value per location, followed by a hazard-by-day agreement grid.
- **Flood and landslide setup.**
  - *How wet it's been:* observed precipitation over the past 7 and 30 days from NOAA's MRMS
    radar-and-gauge analysis (Pass 2, 24-hour totals ending 12Z), with percent of PRISM normal for
    regions and locations, and a map.
  - *Atmospheric rivers:* integrated vapor transport (IVT) at the coastal locations from GFS and
    ECMWF AIFS, computed from specific humidity and wind at 1000, 925, 850, 700, 500 and 300 hPa,
    and ranked on the CW3E AR scale (Ralph et al. 2019): the peak IVT sets the category (250, 500,
    750, 1000, 1250 kg m⁻¹ s⁻¹), 48 hours or longer adds a step, under 24 hours removes one.
    ECMWF IFS open data has no pressure-level fields here, so AIFS stands in for ECMWF.
  - *Landslide threshold:* the USGS cumulative rainfall threshold for the Seattle area
    (Chleborad, Baum and Godt, OFR 2006-1064): landslides become likely once the last 3 days' rain
    reaches 3.5 in − 0.67 × the 15 days before. The index P3 + 0.67·P15 runs from observed MRMS
    rain into each model's forecast at the locations under `landslide` (Everett, Seattle, Tacoma),
    with the 3-day rain from today that would reach the threshold, a timeline of days where models
    reach it (or come within 20%), and a per-model chart.
  - *Ensemble odds:* the share of GEFS and ECMWF ENS members (pooled) reaching each location's
    impact thresholds for 24-hour rain, 72-hour rain and 24-hour snow (ECMWF ENS snowfall at 10:1;
    GEFS has no snowfall field), by day.
- **What NWS forecasters say.** The key messages (or, when an office writes none, the synopsis's
  opening paragraph) from the latest Area Forecast Discussion of each office in `nws_offices`
  (Seattle and Portland), with a toggle for the full synopsis and hydrology notes and links to
  the full text; WPC's Excessive Rainfall Outlook for days
  1–5 at each location; and CPC's 6–10 and 8–14 day temperature and precipitation outlooks
  (most common category per region, with its probability). Outlooks come from NOAA's public map
  services, one query per layer and point-in-polygon locally.
- **Wind and snow.**
  - *Pressure gradients:* sea-level pressure differences from each model for Olympia − Bellingham
    (Puget Sound south wind), Eugene − Portland (Willamette Valley south wind), The Dalles −
    Troutdale (Gorge east wind), Seattle − Yakima (onshore push or offshore flow) and Bellingham −
    Williams Lake (Fraser outflow), with rule-of-thumb thresholds. Pairs, station codes and
    thresholds are in `config.yaml` under `gradients`. A station outside the map area (Williams
    Lake) is read from each model's full pressure grid before cropping, so it costs no extra
    downloads; models whose grid doesn't reach it (HRRR, NAM) are left out of that pair.
    A timeline above the charts shows, for each pair, when any model passes a threshold (amber for
    the first, red for the second), shaded by how many models agree, with each model's peak on hover.
  - *Snow level at the passes:* each model's freezing level minus 1,000 ft
    (`snow_level_offset_ft`) at Snoqualmie, Stevens, White Pass and Government Camp, against the
    pass elevation (`elev_ft` on each point).
  - *Snowpack:* SNOTEL snow water equivalent from the USDA NRCS AWDB API for stations within
    `radius_km` of each area under `snowpack` (Mt Baker, Olympics, the passes, Rainier, Mt Hood,
    Santiam), against each station's median for the date, with depth and the 7-day change. The
    area percent is total SWE over total median SWE, NRCS style, and stays blank until the median
    reaches `min_median_in`, since early-season medians near zero make percentages meaningless.
  - *Avalanche danger:* Northwest Avalanche Center ratings for each zone from avalanche.org's
    public API: danger by elevation band for today and tomorrow, avalanche problems, the bottom
    line and any warning. Before the forecast season starts, the card shows NWAC's early-season
    travel advice and when the summary ends.
- **Interactive map.** MapLibre map with two modes. *Summary* shows every gridded model, the
  multi-model mean, spread and percent of normal for each window, plus highest and lowest
  temperature, strongest wind and strongest gust over each window. *Hourly* steps through
  the forecast with a time slider and play button: simulated radar coloured by precipitation type
  (rain, snow, mix, freezing rain, sleet), 2 m temperature with the 32°F line, gusts, wind, and
  freezing level, water vapor transport (IVT, GFS and ECMWF AIFS) on the atmospheric-river
  scale, and pressure-gradient strength (hPa per 100 km from the smoothed sea-level pressure, with
  mountain cells left blank because sea-level pressure there is extrapolated). Overlays: isobars
  every 2 hPa (labelled every 4, with H and L at pressure centres); the gradient station pairs as
  lines coloured by each pair's thresholds, labelled with the model's difference and with
  arrowheads from high to low pressure; and animated particles that follow the wind, or the
  moisture flow on the IVT layer. A *Terrain* switch shades the
  relief over the grids (AWS Terrain Tiles, with everything below sea level flattened so sea-floor
  relief doesn't show through the ocean grids). Both modes hover for values, compare two models
  side by side, and link each grid for download.

  Grids are drawn by custom WebGL layers from their raw values: each band is uploaded as a float
  texture, and the fragment shader finds every screen pixel's exact lat/lon (inverse Web
  Mercator), samples the grid (nearest cell, or clamped Catmull-Rom bicubic with *Smooth*), blends
  two forecast steps during playback, and colours the result through the ramp. Precipitation type
  is a category, so it's never interpolated. Wind particles are advected on the GPU through the
  time-blended 10 m wind with fading trails. Isobars, the 32°F line and wind arrows are contoured
  on the CPU as vector layers. Needs WebGL2; particles also need `EXT_color_buffer_float`.
- **Next 48 hours.** Small-multiple maps from every model (regional, blend and global), the
  mean and spread, snowfall, and the window's highest and lowest temperature, strongest wind
  and strongest gust.
- **Totals by model.** Region totals for each window, a model × location table with window and
  inches / % of normal switches and a since-yesterday row, and GRIB area means over every grid cell inside each region.
- **Day by day.** *Rain by day:* each location's multi-model median for each 12Z–12Z day
  (liquid equivalent, or snowfall), shaded by amount, with region rows, a 14-day total and the
  model range and the day's normal on hover.
  *Temperatures vs normal:* each location's multi-model median daily high and low against its
  PRISM 1991–2020 normal for the date, as a location × day table (highs or lows, colored blue to
  red) with a window average and region rows, plus a one-line summary per region. The
  interactive map's Summary mode has the gridded version ("Temperature vs normal").
- **Through day 14.** Full-range maps of precipitation and the same four extremes, 7-day
  snowfall, and the running total at each location.
- **Ensembles.** GEFS and ECMWF ENS (plus GEPS from the supplement) medians and 10–90% plumes.
- **Day by day.** Precipitation, high and low, and gust per location, with the model range.

## Gridded products (Cloud-Optimized GeoTIFFs)

Every run publishes its grids under `data/cogs/` next to the page:

| File | Contents |
|---|---|
| `<model>_precip_<N>d.tif` | Each GRIB model's precipitation over the next N days (2, 7, 14), inches |
| `<model>_snow_<N>d.tif` | Snowfall where the model has a snow field, inches |
| `mean_precip_<N>d.tif`, `spread_precip_<N>d.tif` | Multi-model mean and max − min, inches |
| `pctnormal_precip_<N>d.tif` | Model mean as percent of the 1991–2020 normal |
| `<model>_tmax_<N>d.tif`, `<model>_tmin_<N>d.tif` | Highest and lowest 2 m temperature over the window, °F |
| `<model>_wind_<N>d.tif`, `<model>_gust_<N>d.tif` | Strongest sustained 10 m wind and strongest gust over the window, mph |
| `mean_<tmax\|tmin\|wind\|gust>_<N>d.tif` | Multi-model mean of those extremes |
| `odds_p24_<N>d.tif`, `odds_p72_<N>d.tif` | Chance (% of pooled GEFS + ECMWF ENS members) of 1" or more in a day, or 3" or more in 3 days, within the window (`odds_map` in config) |
| `observed_obs_<N>d.tif`, `observed_obspct_<N>d.tif` | MRMS observed precipitation over the past 7 or 30 days (in) and percent of normal |
| `departure_tmax_<N>d.tif`, `departure_tmin_<N>d.tif` | Model-mean departure of the daily high or low from the 1991–2020 normal, averaged over the window, °F |

Extremes, and the daily highs, lows and peak gusts at the forecast locations, are read at each
model's native output steps, using the max/min-since-the-previous-output records wherever the
model publishes them, so a peak between output times isn't missed:

| Model | Highs and lows | Strongest wind | Gusts |
|---|---|---|---|
| HRRR | hourly 2 m temperature (no max/min records) | hourly max 10 m wind | hourly |
| RRFS | hourly 2 m max/min | hourly max 10 m wind | hourly |
| NAM 3 km | hourly 2 m max/min | hourly max wind (MAXUW/MAXVW components) | hourly |
| NBM | 12-hour daytime max / overnight min | 10 m speed, hourly → 3-hourly → 6-hourly | same steps |
| GFS | 2 m max/min per 6-hour bucket (3-hour after day 5) | from u/v every 3 h | every 3 h |
| ECMWF IFS | mx2t3/mn2t3 to day 6, then mx2t6/mn2t6 | from u/v every 3 h, then 6 h | max since the previous step |
| ECMWF AIFS | 6-hourly 2 m temperature | from u/v every 6 h | none published |

The schedule for each model is its `extremes` block in `config.yaml`. NCEP gusts are values at
the output time, so a gust between outputs can still be missed.

All are single-band float32, EPSG:4326, DEFLATE-compressed with tiled overviews, and NaN where
there is no data. Global models keep their native 0.25° grid; HRRR, RRFS, NAM and NBM are
resampled by nearest neighbour from their projected grids to 0.03°. The `cogs` list in
`briefing.json` describes each file (model, tier, run, window, units). They load directly in
QGIS, rio-tiler or TiTiler, geotiff.js, or a custom Mapbox GL / WebGL layer. The archive keeps
GeoTIFFs for the last 14 days.

### Time-stepped fields

The latest briefing also publishes `data/fields/<model>_<var>.tif`, one multi-band COG per model
and variable, with one band per forecast time (band descriptions are the valid times, UTC).
Values are int16 with a scale factor recorded in the file, so GIS tools read physical units;
`data/fields.json` lists each file with its times, units, scale and nodata.

| Variable | Units | Models | Step |
|---|---|---|---|
| `refc` simulated composite reflectivity | dBZ | HRRR, RRFS, NAM | hourly, 48 h |
| `ptype` precipitation type (0 none, 1 rain, 2 snow, 3 freezing rain, 4 sleet, 5 mix) | | HRRR, RRFS, NAM hourly; GFS, ECMWF every 6 h | |
| `ivtu`, `ivtv` water vapor transport components | kg m⁻¹ s⁻¹ | GFS, ECMWF AIFS | every 6 h |
| `t2m` temperature at 2 m | °F | all GRIB models | hourly for 48 h for HRRR, RRFS, NAM (then 3 h); 6 h others |
| `gust`, `u10`, `v10` | mph | all but AIFS (no gust field) | same |
| `mslp` sea-level pressure | hPa | all but NBM | same |
| `frz` freezing level above sea level | ft | HRRR, RRFS, NAM, GFS | same |

Temperature and gusts reuse downloads the briefing already makes; the rest add a few hundred
GRIB messages per regional model, fetched in parallel. Which fields each model provides is set
under `fields` in `config.yaml`. Hourly fields are kept only for the latest briefing, not the
archive.

## Publishing and storage

Each run rebuilds the site from the current `gh-pages` contents and publishes it as a single fresh
commit (`scripts/assemble_site.sh`, `scripts/publish_site.sh`), so the branch never accumulates
daily binary files in its history. The site holds the latest briefing, 60 days of archived pages,
GeoTIFFs for the last 14 of them, and hourly fields for the latest only. That keeps it well under
GitHub Pages' 1 GB limit. To keep hourly fields in the archive or add many more layers, move the
grids to object storage such as Cloudflare R2; only the publish step changes.

## The map page

`map.html` is the interactive map on a page of its own (built as a second Vite entry,
`src/MapPage.tsx`): the map fills the window under a narrow header, the controls sit in a side
panel that folds away (over the map on a phone), and the legend, timeline, cross-section and
profile float over the map. Its settings live in the address: the mode, layer and model, the window or
the time, the overlays, the 3D view and its options, and the camera (`c=lon,lat,zoom,pitch,bearing`),
updated as you change them, so the address is always a link to the view on screen. "Copy link"
copies it; the briefing's map card has an "Open map page" link that carries its current settings
over. On a phone the map and its timeline come first, with the controls under them.

## The 3D view

Presets set up a field, its options and a camera in one go (atmospheric river, jet stream, snow
levels, upper low, clouds and precipitation, mountain lift). **Profile** shows the column over a
clicked point as a simple sounding: temperature and dewpoint (from the humidity) by height with
the freezing line, cloud down the left edge, wind arrows and speeds down the right and the ground
at the bottom. The timeline marks each Pacific day and now, steps with its arrows, and on the map
page and in full screen takes ← → (step) and space (play).

The interactive map's **3D** switch (under "Hourly") tilts the map and draws a model's
forecast through the depth of the atmosphere over it, following the time slider. The volumes
come from their own workflow (`.github/workflows/volume.yml`), which starts when a briefing run
succeeds, so the edition never waits on these downloads: it builds them for the published
edition's cycle (`python -m briefing.volume --cycle …`) and adds them to gh-pages with
`scripts/publish_volume.sh`, which pushes only if gh-pages hasn't moved meanwhile and stops if a
newer edition is already out. Until then the page keeps the previous volumes (labelled with their
model run); `assemble_site.sh` carries them over. `volume.py`
reads GFS and ECMWF IFS on pressure levels (1000 – 200 hPa) every 3 hours for the first 48
(config `volume` on each model), resamples each column onto a fixed height grid (0 – 12 km every
500 m) with the levels' geopotential heights, and packs each variable into one byte per point:
`data/volume/<model>_<var>.bin.gz` with a manifest in `data/volume.json` (about 1 – 2 MB per
edition). Variables: clouds (GFS cloud cover; estimated from humidity for ECMWF), liquid water
(cloud water plus rain) and ice and snow (cloud ice, snow and graupel), both GFS only, relative
humidity, temperature and wind speed, both drawn as lit surfaces at set values (isotherms at 50,
32, 0 and −40°F; isotachs at 50, 80, 110 and 140 mph), and the freezing level on its own as a
solid surface coloured by height in the 2D map's 1,000 ft bands. u and v (m/s) drive animated wind
particles at 850, 700, 500, 300 and 250 hPa (the model's average heights), on by default with the
wind view and switchable with any field.
Potential vorticity (PVU, Ertel's on pressure levels from the wind and temperature) is drawn as
its 2 PVU surface, the dynamic tropopause, coloured by height; the heights of 850, 700, 500 and
300 hPa are stored per level (as departures from each level's mean) for the level maps. Two views
are worked out in the page from the others: the snow growth zone (humidity between 10 and 0°F)
and icing (liquid water between 32 and −4°F, GFS only).

A **render mode** sets how a volume draws: see-through (**Volume**), lit white like real cloud
(**Cloud**), the strongest value along each line of sight like a composite radar (**Max**), or as
**Points**, dots scattered through each cell in proportion to its opacity (kept in place as time
moves, at most about 120k); an **opacity** multiplier and a **show from** threshold hide the thin
parts. A **scan** cuts a slice across the box (at one height, west to east or south to north) in
the field's own colours with the rest faded, and can sweep back and forth.

Any view can also be drawn as a **solid** surface at a chosen value (the jet at 100 kt, the
tropopause at 2 PVU), opaque or partly see-through, with lighting and self-shadowing; volumes and solids can be **coloured** by
height or by another field (humidity shaped, coloured by wind speed); solids and lit fields cast
**shadows** on the ground. A **level map** draws a pressure level's height contours (in decametres)
and wind arrows inside the box, and **trajectories** trace the air arriving over each forecast
location at about 1.5 and 3 km back 24 hours through the model's u, v and w (RK2, 15-minute steps).

On the page, `lib/gl/volume-layer.ts` is a MapLibre custom layer (WebGL2): each pixel casts a
ray through the box, samples the 3D textures of the two time steps either side of the clock,
looks up colour and extinction in a per-variable transfer table and composites front to back;
clouds, water, ice and humidity are lit from the south-west by a short march towards the light
through the same field (so undersides go gray), and a second march from the ground point under each
pixel towards the light gives the shadows. Surfaces are found where the
field crosses a value between two samples (so they stay crisp at any step size) and lit by the
field's gradient. The wind particles are advected on the CPU from the same grids (trilinear,
blended in time) and drawn as fading trails each frame over the cached volume image. The result is cached in an
offscreen image and only redrawn when the view, time or data change. Archive copies drop the
volumes, like the hourly fields.

## Normals, alerts and yesterday's briefing

- **Normals.** PRISM 1991–2020 monthly precipitation normals at 4 km, spread into daily values
  by interpolating between mid-month rates, so windows that cross a month boundary are handled.
  Region normals are averaged over the same forecast locations as the region totals, so the
  percentages compare like with like. Normal daily highs and lows come from PRISM's monthly
  `tmax` and `tmin` normals, interpolated linearly between mid-month values. PRISM's grids stop
  at the border, so B.C. uses ClimateNA's 1991–2020 monthly normals (1 km, from AdaptWest), which
  are built on PCIC's B.C. PRISM: each 4 km cell the US grid leaves empty gets the average of the
  ClimateNA cells in it, read as a small window straight out of the published zip. Grids are
  cached (`.cache/prism`, kept by the workflow).
- **Alerts.** Each location is resolved once to its NWS forecast zone, county and fire-weather
  zone (`api.weather.gov/points`). One `alerts/active?area=WA,OR` request is then matched by
  zone. NWS asks for an identifying User-Agent; it defaults to your GitHub repository name, or
  set `nws_user_agent` in the config. Locations marked `country: CA` skip the NWS lookup and take
  Environment Canada's alerts instead: one request to MSC GeoMet
  (`api.weather.gc.ca/collections/weather-alerts/items`, a box around those locations), matched
  to each location by the alert regions' polygons, with an alert's regions joined into one row.
- **Yesterday.** The workflow reads the current `data/briefing.json` from the `gh-pages` branch
  before building, and passes it to `--previous`. The first run has nothing to compare with, so
  the "What changed since yesterday" card says so until the second day.

## Setup (about 5 minutes)

1. Create a GitHub repository and push this folder:
   ```bash
   git init && git add -A && git commit -m "PNW briefing"
   git branch -M main
   git remote add origin git@github.com:<you>/pnw-briefing.git
   git push -u origin main
   ```
2. In **Settings → Actions → General → Workflow permissions**, choose **Read and write permissions**.
3. Go to **Actions → Daily forecast briefing → Run workflow**. Tick **demo** for a quick layout
   check, or leave it unticked for a live run. The first live run takes 20–40 minutes while the
   conda environment builds and every model downloads; later runs reuse the cached environment.
   The first run also installs the Node packages for the page (cached after that).
4. After the first run creates the `gh-pages` branch, go to **Settings → Pages** and choose
   **Deploy from a branch → `gh-pages` / root**. The page is then at `https://<you>.github.io/pnw-briefing/`.

It runs daily at 15:13 UTC (7:13 AM PST, 8:13 AM PDT), after the 12Z regional runs finish.

To pick up page changes (a merged front-end PR, or a label or threshold tweak in `config.yaml`)
without downloading everything again, run the workflow with **page only** ticked. It takes the
data already published on `gh-pages`, re-applies the labels that come straight from
`config.yaml` (pressure-gradient names, codes, meanings and thresholds), rebuilds the page and
republishes it, both at the root and in that day's archive, in a few minutes. Anything computed
from model data (new fields, a changed domain or new locations) still needs a full run.
GitHub pauses scheduled workflows in repos with no activity for 60 days and emails you; one
click re-enables it.

## Tuning (`config.yaml`)

- **`grib_models` / `grib_ensembles`**: add, drop or `enabled: false` a model. `herbie` is passed
  straight to `herbie.Herbie()`, so any model Herbie supports can be added. `cycles` lists the
  runs to consider, `range_days` caps the days used, `sample_hours` spaces the temperature and gust
  samples, and `chain_step` is the bucket length when a file has no running total (1 h for
  HRRR, RRFS and NAM).
- **`windows`**: the comparison windows.
- **`points`**: locations. `kind` (lowland, coast or pass) picks the thresholds, and `plume: true`
  adds a location to the ensemble chart.
- **`regions`**: the W WA and NW OR polygons, west of the Cascade crest and inside the coastline.
- **`impacts`**: thresholds (in, °F, mph) and `min_agreement` (default 30%; 60% or more shows as *Likely*).

A late, renamed or incomplete model is skipped and listed as missing in the run-status panel; it
never fails the run.

## Running locally

```bash
# data: live (optionally against a previous briefing.json), or synthetic with --demo
micromamba env create -f environment.yml && micromamba activate pnw-briefing
python -m briefing.main --out web/public/data --demo
python -m briefing.main --out web/public/data --previous path/to/yesterday/briefing.json

# page
cd web && npm install && npm run dev      # http://localhost:5173
npm run build                             # static site in web/dist
```

Tests: `PYTHONPATH=. python tests/test_grib_accum.py` and `PYTHONPATH=. python tests/test_products.py`.

For a single self-contained file (maps, GeoTIFFs and the map worker all embedded; opens from
disk or as an email attachment):

```bash
cd web && npm run build:single && cd ..
python -m briefing.standalone web/public/data web/dist-single/index.html briefing.html
```

The page reads `data/briefing.json` next to itself, so the same build works at the site root
and in each `archive/<date>/` copy.

## Front end

The components in `web/src/components/ui/` are the official shadcn/ui sources (new-york v4
style), copied from the shadcn-ui repository and owned by this project, as shadcn intends.
Add more with `npx shadcn@latest add <component>` from `web/`; `components.json` is set up
for that. Two project-specific additions:

- **Badge variants** `likely`, `possible`, `regional`, `blend` and `global` in `badge.tsx`.
- **Theme tokens** in `src/index.css`: shadcn's neutral theme, plus `--chart-1..3` set to a
  colorblind-checked blue, orange and aqua, and status colors for hazards.

Sections live in `web/src/sections/`, and the data contract is `web/src/types.ts`.

## Notes and limits

- **RRFS naming.** RRFS file naming on NODD has changed during its rollout. If RRFS shows as missing,
  check Herbie's RRFS template against the bucket, and update the `herbie` block in `config.yaml`
  or upgrade Herbie.
- **NAM.** The NAM nest is slated for retirement as RRFS takes over. When it stops publishing, it
  will show as missing; set `enabled: false`.
- **Daily extremes.** Highs, lows and peak gusts come from 3-hourly (regional) or 6-hourly
  (global) samples, so true extremes can sit a degree or a few mph beyond them. AIFS publishes
  no gust field, so it's left out of the wind check.
- **Snow.** Snowfall uses each model's own field: `ASNOW` for NOAA models, and ECMWF `sf` water
  equivalent at 10:1. Models without one are left out of the snow maps.
- **The icy-precipitation flag is a screen.** It needs a day with low ≤ 32°F, high ≤ 36°F and
  liquid precip. Daily values can't resolve the shallow cold-air setups behind PNW freezing rain.
- **Basemap.** The interactive map uses CARTO's Positron vector style (OpenStreetMap data), with
  the weather layers inserted under its labels. Vector styles load without a key today; CARTO
  recommends one, and their raster tiles already require it. To send a key, add a repository
  variable `CARTO_KEY` (Settings → Secrets and variables → Actions → Variables); it's added to
  every CARTO request. Free use is up to 5M tile requests a month non-commercial, 1M commercial.
  If the basemap can't load, the data still draws on a plain background. To use another style,
  change `STYLE_URL` in `web/src/sections/InteractiveMap.tsx`.
- Impact flags are not official warnings. Check NWS Seattle and Portland.

## Layout

```
config.yaml                 domain, regions, points, windows, models, thresholds
briefing/grib.py            Herbie GRIB fetch: accumulations, samples, projected grids, ensembles
briefing/points.py          optional Open-Meteo supplement, binned to 12Z–12Z days
briefing/analysis.py        windows, region masks, regridding, summary
briefing/impacts.py         hazard rules, model agreement, event grouping
briefing/maps.py            cartopy small-multiple maps (PNG)
briefing/cogs.py            Cloud-Optimized GeoTIFF export
briefing/normals.py         PRISM (and B.C. ClimateNA) normals, daily interpolation, percent of normal
briefing/tempdep.py         departure of daily highs and lows from normal (table and maps)
briefing/alerts.py          NWS zones and active alerts
briefing/eccc_alerts.py     Environment Canada alerts for the B.C. locations
briefing/change.py          comparison with the previous briefing over the same days
briefing/standalone.py      single-file briefing with everything embedded
briefing/main.py            writes briefing.json + maps
briefing/context.py         IVT and the AR scale, pressure gradients, pass snow level
briefing/odds.py            ensemble exceedance odds (locations and maps)
briefing/observed.py        MRMS observed precipitation, past 7 and 30 days vs normal
briefing/snowpack.py        SNOTEL snowpack by area (NRCS AWDB)
briefing/outlooks.py        NWS forecast discussions, WPC excessive rainfall and CPC outlooks
briefing/landslide.py       USGS Seattle-area landslide threshold from observed + forecast rain
briefing/avalanche.py       NWAC avalanche danger (avalanche.org API)
briefing/demo.py            synthetic data for offline tests
briefing/repage.py          page-only rebuilds: refresh config labels in published data
web/src/components/ui/      shadcn/ui components
web/src/sections/           page sections (overview, changes, alerts, impacts, flood setup and
                            wind/snow signals, interactive map, maps, totals, location detail)
web/src/lib/cog.ts          COG reading (geotiff.js)
web/src/lib/gl/             WebGL grid and wind-particle layers for MapLibre
web/src/types.ts            the briefing.json contract
briefing/fields.py          time-stepped fields: fetch, precipitation type, multi-band export
scripts/                    site assembly (archive, pruning) and single-commit publishing
.github/workflows/          daily schedule: Python data step, Node build, gh-pages publish, archive
```
