"""Small-multiple maps of window precipitation and snowfall (matplotlib + cartopy)."""
from __future__ import annotations

import json
import logging
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib import font_manager as fm
from matplotlib.colors import BoundaryNorm, ListedColormap

from . import analysis

log = logging.getLogger(__name__)

FONT_DIR = Path(__file__).parent / "assets" / "fonts"
for f in FONT_DIR.glob("*.ttf"):
    fm.fontManager.addfont(str(f))
REG = fm.FontProperties(fname=str(FONT_DIR / "Inter-Regular.ttf"))
BOLD = fm.FontProperties(fname=str(FONT_DIR / "Inter-SemiBold.ttf"))
plt.rcParams["font.family"] = REG.get_name()

BLACK, GRAY, RULE, PAPER = "#1b1f24", "#6b7280", "#d9dce1", "#ffffff"

# Precipitation, snowfall, temperature and wind use Ryan Maue's GrADS colour tables, the same file
# the page reads (web/src/lib/ramps/maue.json, from forecasteagle.com/ramps), cut to the range worth
# drawing here. Lists below follow _cmap's layout: with clamp, colour i covers [level i, level i+1)
# and the last colour is "over"; without, colour 0 is an unused "under" slot and the rest shift by one.
_MAUE = json.loads((Path(__file__).resolve().parents[1] / "web/src/lib/ramps/maue.json").read_text())["ramps"]
LEGEND_TICKS: dict[tuple, list] = {}


def _maue(name, lo, hi, ticks, clamp=False):
    stops = [s for s in _MAUE[name]["stops"] if lo - 1e-6 <= s[0] <= hi + 1e-6]
    levels, colors = [s[0] for s in stops], [s[1] for s in stops]
    LEGEND_TICKS[tuple(levels)] = ticks
    return levels, (colors if clamp else [colors[0]] + colors)


PRECIP_LEVELS, PRECIP_COLORS = _maue("maue_precip_rgbset", 0.01, 20, [0.01, 0.1, 0.25, 0.5, 1, 2, 3, 4, 6, 8, 10, 16])
SNOW_LEVELS, SNOW_COLORS = _maue("maue_snowfall", 0.1, 48, [0.1, 1, 2, 4, 6, 8, 12, 18, 24, 36, 48])
# Spread is uncertainty, not a hazard: neutral gray, so red stays reserved for hazards.
SPREAD_LEVELS = [0.25, 0.5, 1, 2, 3, 4, 6, 8, 12]
SPREAD_COLORS = ["#f4f4f4", "#e6e6e6", "#d2d2d2", "#bcbcbc", "#a3a3a3", "#898989", "#6e6e6e",
                 "#545454", "#383838", "#1c1c1c"]

TEMP_LEVELS, TEMP_COLORS = _maue("maue_weather_us_temp", -10, 110, list(range(-10, 111, 10)), clamp=True)
# Maue's wind table is in knots, here on a miles-per-hour axis; nothing painted below its first level
WIND_LEVELS, WIND_COLORS = _maue("maue_wind10m_mph", 6.9, 103.6,
                                 [6.904674, 11.50779, 23.01558, 34.52337, 43.729602, 57.53895, 69.04674, 92.06232])
EXTREME_RAMPS = {"tmax": (TEMP_LEVELS, TEMP_COLORS, True), "tmin": (TEMP_LEVELS, TEMP_COLORS, True),
                 "wind": (WIND_LEVELS, WIND_COLORS, False), "gust": (WIND_LEVELS, WIND_COLORS, False)}


def _cmap(levels, colors, clamp=False):
    if clamp:
        # every value gets a colour: below the first level takes the first colour
        cm = ListedColormap(colors[: len(levels) - 1])
        cm.set_under(colors[0])
        cm.set_over(colors[len(levels) - 1])
        return cm, BoundaryNorm(levels, cm.N)
    cm = ListedColormap(colors[1:len(levels)])
    cm.set_under("none")
    cm.set_over(colors[-1])
    return cm, BoundaryNorm(levels, cm.N)


_FEATURES = None


def _features():
    """Natural Earth outlines, resolved eagerly so a failed download can't break savefig."""
    global _FEATURES
    if _FEATURES is None:
        _FEATURES = []
        try:
            import cartopy.crs as ccrs
            import cartopy.io.shapereader as shp
            from cartopy.feature import ShapelyFeature
            for cat, name, color, lw in (("cultural", "admin_1_states_provinces_lines", GRAY, 0.4),
                                         ("physical", "coastline", BLACK, 0.5),
                                         ("cultural", "admin_0_boundary_lines_land", GRAY, 0.4)):
                geoms = list(shp.Reader(shp.natural_earth("10m", cat, name)).geometries())
                _FEATURES.append((ShapelyFeature(geoms, ccrs.PlateCarree()), color, lw))
        except Exception as e:
            log.warning("map outlines unavailable (%s); drawing without them", e.__class__.__name__)
    return _FEATURES


COLS = 4   # every figure is this many panels wide, so a panel is the same size on the page whatever the count


def _full_width(fig):
    """An invisible frame over the whole figure, so the tight crop keeps the empty columns of a
    short row and every image comes out COLS panels wide."""
    from matplotlib.patches import Rectangle
    fig.patches.append(Rectangle((0, 0), 1, 1, transform=fig.transFigure, fill=False, edgecolor="none", linewidth=0))


def _aspect(dom):
    mid = np.deg2rad((dom["lat_min"] + dom["lat_max"]) / 2)
    return (dom["lon_max"] - dom["lon_min"]) * np.cos(mid) / (dom["lat_max"] - dom["lat_min"])


# a 2.45 x 3.5 in panel suited the original 43-50 N, 125.8-118.5 W box; other boxes scale from it
_REF = {"lat_min": 43.0, "lat_max": 50.0, "lon_min": -125.8, "lon_max": -118.5}


def _panel_h(dom, pw):
    """Panel height for width `pw`, so a panel keeps the map area's shape."""
    return round(3.5 * (pw / 2.45) * _aspect(_REF) / _aspect(dom), 2)


def _axes(fig, gs, n, dom):
    import cartopy.crs as ccrs
    proj = ccrs.LambertConformal(central_longitude=-122.5, standard_parallels=(45, 48))
    axes = []
    for k in range(n):
        ax = fig.add_subplot(gs[k // gs.ncols, k % gs.ncols], projection=proj)
        ax.set_extent([dom["lon_min"] + 0.35, dom["lon_max"] - 0.35, dom["lat_min"] + 0.35, dom["lat_max"] - 0.2],
                      crs=ccrs.PlateCarree())
        ax.spines["geo"].set_edgecolor(RULE)
        ax.spines["geo"].set_linewidth(0.6)
        axes.append(ax)
    return axes, ccrs.PlateCarree()


def _draw(ax, tr, lat, lon, field, cmap, norm, title, sub, cfg):
    la, lo = analysis._ll2d(lat, lon)
    ax.pcolormesh(lo, la, field, cmap=cmap, norm=norm, shading="nearest", transform=tr, rasterized=True)
    for feat, color, lw in _features():
        ax.add_feature(feat, edgecolor=color, linewidth=lw, facecolor="none")
    for r in cfg["regions"].values():
        poly = np.array(r["polygon"] + [r["polygon"][0]])
        ax.plot(poly[:, 0], poly[:, 1], color=BLACK, lw=0.9, ls=(0, (3, 2)), transform=tr)
    for p in cfg["points"]:
        ax.plot(p["lon"], p["lat"], "o", ms=2.6, mfc=PAPER, mec=BLACK, mew=0.7, transform=tr)
    ax.text(0, 1.065, title, transform=ax.transAxes, fontproperties=BOLD, fontsize=10.5, color=BLACK, va="bottom")
    ax.text(0, 1.012, sub, transform=ax.transAxes, fontproperties=REG, fontsize=8, color=GRAY, va="bottom")


def _legend(fig, rect, levels, colors, label, clamp=False):
    cm, nm = _cmap(levels, colors, clamp)
    cax = fig.add_axes(rect)
    cb = fig.colorbar(plt.cm.ScalarMappable(norm=nm, cmap=cm), cax=cax, orientation="horizontal",
                      extend="both" if clamp else "max", ticks=levels, extendfrac=0.04)
    ticks = LEGEND_TICKS.get(tuple(levels))
    if ticks is not None:       # long tables: tick and label only the chosen levels
        shown = [v for v in levels if any(abs(v - t) < 1e-6 for t in ticks)]
        cb.set_ticks(shown)
        cb.ax.set_xticklabels([f"{v:.0f}" if abs(v) >= 10 else f"{round(v, 1):g}" if abs(v) >= 1 else f"{v:.2g}" for v in shown],
                              fontproperties=REG, fontsize=7.5, color=BLACK)
    else:
        every = 2 if len(levels) > 16 else 1
        cb.ax.set_xticklabels([f"{v:g}" if k % every == 0 else "" for k, v in enumerate(levels)],
                              fontproperties=REG, fontsize=7.5, color=BLACK)
    cb.ax.minorticks_off()
    cb.ax.tick_params(length=2, width=0.5, color=BLACK)
    cb.outline.set_visible(False)
    cax.set_title(label, loc="left", fontproperties=REG, fontsize=8, color=GRAY, pad=4)


def _run(m):
    return f"{m['run']:%HZ %a %-m/%-d} run" if m.get("run") is not None else ""


def _figure(panels, cfg, out_path, levels, colors, label, spread=None, clamp=False):
    """panels: list of (lat, lon, field, title, sub). `spread` appended in its own ramp."""
    n = len(panels) + (1 if spread is not None else 0)
    ncols = COLS                      # rows of four; extra panels wrap to the next row
    rows = (n + ncols - 1) // ncols
    PW, LEG = 2.45, 0.75            # panel width and legend band, inches; height follows the map area
    PH = _panel_h(cfg["domain"], PW)
    fig = plt.figure(figsize=(PW * ncols, PH * rows + LEG), facecolor=PAPER, dpi=160)
    gs = fig.add_gridspec(rows, ncols, left=0.01, right=0.99, top=1 - 0.32 / (PH * rows + LEG),
                          bottom=LEG / (PH * rows + LEG), wspace=0.07, hspace=0.24)
    axes, tr = _axes(fig, gs, n, cfg["domain"])
    cm, nm = _cmap(levels, colors, clamp)
    for ax, (lat, lon, f, title, sub) in zip(axes, panels):
        _draw(ax, tr, lat, lon, f, cm, nm, title, sub, cfg)
    leg_y = 0.2 / (PH * rows + LEG)
    if spread is not None:
        sc, sn = _cmap(SPREAD_LEVELS, SPREAD_COLORS)
        lat, lon, f, title, sub = spread
        _draw(axes[-1], tr, lat, lon, f, sc, sn, title, sub, cfg)
        _legend(fig, [0.01, leg_y, 0.5, 0.11 / (PH * rows + LEG)], levels, colors, label)
        _legend(fig, [0.6, leg_y, 0.39, 0.11 / (PH * rows + LEG)], SPREAD_LEVELS, SPREAD_COLORS, "Model spread, max − min (in)")
    else:
        _legend(fig, [0.01, leg_y, 0.6, 0.11 / (PH * rows + LEG)], levels, colors, label, clamp)
    _full_width(fig)
    fig.savefig(out_path, facecolor=PAPER, bbox_inches="tight", pad_inches=0.08)
    plt.close(fig)
    return out_path


def window_precip(grib_models, cfg, wdays, out_path):
    """Every model covering the window, then the multi-model mean and spread on a common grid."""
    ms = [m for m in grib_models if m["range_days"] >= wdays]
    if not ms:
        return None
    panels = [(m["lat"], m["lon"], analysis.grid_window(m, wdays), m["label"], _run(m)) for m in ms]
    spread = None
    if len(ms) > 1:
        glat, glon = analysis.common_grid(cfg)
        stack = np.stack([analysis.regrid(m["lat"], m["lon"], analysis.grid_window(m, wdays), glat, glon) for m in ms])
        with np.errstate(all="ignore"):
            panels.append((glat, glon, np.nanmean(stack, 0), "Mean", f"{len(ms)} models"))
            spread = (glat, glon, np.nanmax(stack, 0) - np.nanmin(stack, 0), "Spread", "Highest minus lowest model")
    return _figure(panels, cfg, out_path, PRECIP_LEVELS, PRECIP_COLORS,
                   f"Precipitation, liquid equivalent, next {wdays * 24 if wdays <= 3 else wdays} "
                   f"{'hours' if wdays <= 3 else 'days'} (in)", spread)


def full_range_precip(grib_models, cfg, min_days, out_path):
    """Each longer-range model at its own full range; mean and spread over the window all of them cover."""
    ms = [m for m in grib_models if m["range_days"] >= min_days]
    if not ms:
        return None
    common = min(m["range_days"] for m in ms)
    panels = [(m["lat"], m["lon"], m["precip_mm"][-1] / 25.4, m["label"], f"{m['range_days']} days, {_run(m)}") for m in ms]
    spread = None
    if len(ms) > 1:
        glat, glon = analysis.common_grid(cfg, 0.1)
        stack = np.stack([analysis.regrid(m["lat"], m["lon"], analysis.grid_window(m, common), glat, glon) for m in ms])
        with np.errstate(all="ignore"):
            panels.append((glat, glon, np.nanmean(stack, 0), "Mean", f"First {common} days, {len(ms)} models"))
            spread = (glat, glon, np.nanmax(stack, 0) - np.nanmin(stack, 0), "Spread", f"First {common} days")
    return _figure(panels, cfg, out_path, PRECIP_LEVELS, PRECIP_COLORS, "Precipitation, liquid equivalent (in)", spread)


def snow(grib_models, cfg, wdays, out_path):
    ms = [m for m in grib_models if m.get("snow_in") is not None and m["range_days"] >= wdays]
    if not ms:
        return None
    panels = [(m["lat"], m["lon"], m["snow_in"][wdays], m["label"], m["snow_method"]) for m in ms]
    return _figure(panels, cfg, out_path, SNOW_LEVELS, SNOW_COLORS,
                   f"Snowfall, next {wdays * 24 if wdays <= 3 else wdays} {'hours' if wdays <= 3 else 'days'} (in)")


# ---------------------------------------------------------------- window extremes

def _ext_label(var, horizon):
    from .extremes import VARS
    v = VARS[var]
    return f"{v['label']}{', ' + horizon if horizon else ''} ({v['units']})"


def _horizon(wdays):
    return f"next {wdays * 24} hours" if wdays <= 3 else f"next {wdays} days"


def window_extreme(grib_models, cfg, var, wdays, out_path):
    """Each model's extreme over the window, then the multi-model mean on a common grid."""
    from .extremes import window
    ms = [(m, window(m, var, wdays)) for m in grib_models]
    ms = [(m, f) for m, f in ms if f is not None]
    if not ms:
        return None
    panels = [(m["lat"], m["lon"], f, m["label"], _run(m)) for m, f in ms]
    if len(ms) > 1:
        glat, glon = analysis.common_grid(cfg)
        stack = np.stack([analysis.regrid(m["lat"], m["lon"], f, glat, glon) for m, f in ms])
        with np.errstate(all="ignore"):
            panels.append((glat, glon, np.nanmean(stack, 0), "Mean", f"{len(ms)} models"))
    levels, colors, clamp = EXTREME_RAMPS[var]
    return _figure(panels, cfg, out_path, levels, colors, _ext_label(var, _horizon(wdays)), clamp=clamp)


def full_range_extreme(grib_models, cfg, var, min_days, out_path):
    """Each longer-range model's extreme over its own full range; mean over the days all of them cover."""
    from .extremes import window
    ms = [m for m in grib_models if m["range_days"] >= min_days and window(m, var, m["range_days"]) is not None]
    if not ms:
        return None
    common = min(m["range_days"] for m in ms)
    panels = [(m["lat"], m["lon"], window(m, var, m["range_days"]), m["label"], f"{m['range_days']} days, {_run(m)}")
              for m in ms]
    if len(ms) > 1:
        glat, glon = analysis.common_grid(cfg, 0.1)
        stack = np.stack([analysis.regrid(m["lat"], m["lon"], window(m, var, common), glat, glon) for m in ms])
        with np.errstate(all="ignore"):
            panels.append((glat, glon, np.nanmean(stack, 0), "Mean", f"First {common} days, {len(ms)} models"))
    levels, colors, clamp = EXTREME_RAMPS[var]
    return _figure(panels, cfg, out_path, levels, colors, _ext_label(var, None), clamp=clamp)


# ---------------------------------------------------------------- observed (MRMS)

PCT_LEVELS = [0, 25, 50, 70, 90, 110, 130, 160, 200, 300]
PCT_COLORS = ["#8c510a", "#bf812d", "#dfc27d", "#f6e8c3", "#f5f5f5", "#c7eae5", "#80cdc1", "#35978f", "#01665e", "#003c30"]


def observed(grids, cfg, out_path):
    """Past 7 and 30 days observed (MRMS), and the 30 days as percent of normal: three panels,
    each with its own legend."""
    if not grids or grids.get("obs7") is None:
        return None
    panels = [(grids["obs7"], "Past 7 days", "Observed precipitation (in)", PRECIP_LEVELS, PRECIP_COLORS, False),
              (grids["obs30"], "Past 30 days", "Observed precipitation (in)", PRECIP_LEVELS, PRECIP_COLORS, False)]
    if grids.get("pct30") is not None:
        panels.append((grids["pct30"], "Past 30 days", "Percent of 1991 – 2020 normal", PCT_LEVELS, PCT_COLORS, True))
    n = len(panels)
    PW, LEG = 2.45, 0.8
    PH = _panel_h(cfg["domain"], PW)
    fig = plt.figure(figsize=(PW * COLS, PH + LEG), facecolor=PAPER, dpi=160)
    gs = fig.add_gridspec(1, COLS, left=0.01, right=0.99, top=1 - 0.32 / (PH + LEG), bottom=LEG / (PH + LEG), wspace=0.07)
    axes, tr = _axes(fig, gs, n, cfg["domain"])
    for k, (ax, (f, title, label, levels, colors, clamp)) in enumerate(zip(axes, panels)):
        cm, nm = _cmap(levels, colors, clamp)
        _draw(ax, tr, grids["lat"], grids["lon"], f, cm, nm, title, "MRMS multi-sensor QPE", cfg)
        w = 0.98 / COLS
        _legend(fig, [0.01 + k * w + 0.01, 0.2 / (PH + LEG), w - 0.03, 0.11 / (PH + LEG)], levels, colors, label, clamp)
    _full_width(fig)
    fig.savefig(out_path, facecolor=PAPER, bbox_inches="tight", pad_inches=0.08)
    plt.close(fig)
    return out_path
