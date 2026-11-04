"""Small-multiple maps of window precipitation and snowfall (matplotlib + cartopy)."""
from __future__ import annotations

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

# One hue, light -> dark, ending in a deep blue-violet so 20"+ windward totals separate.
PRECIP_LEVELS = [0.1, 0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8, 10, 15, 20, 30]
PRECIP_COLORS = ["#e9f0fb", "#d3e2f8", "#bdd3f4", "#a2c1ef", "#86afea", "#6a9ce4", "#4f88dd",
                 "#3474d5", "#1f5fd1", "#1a50b2", "#164293", "#123576", "#0f2a5e", "#0b1f47", "#1c1240"]
SNOW_LEVELS = [0.5, 1, 2, 4, 6, 8, 12, 18, 24, 36, 48, 72]
SNOW_COLORS = ["#f3f1fc", "#e3dff8", "#cdc6f2", "#b4aaeb", "#998de3", "#7f70da", "#6553cf",
               "#5040b6", "#3f3299", "#30267b", "#221a5e", "#160f42", "#0d082c"]
# Spread is uncertainty, not a hazard: neutral gray, so red stays reserved for hazards.
SPREAD_LEVELS = [0.25, 0.5, 1, 2, 3, 4, 6, 8, 12]
SPREAD_COLORS = ["#f4f4f4", "#e6e6e6", "#d2d2d2", "#bcbcbc", "#a3a3a3", "#898989", "#6e6e6e",
                 "#545454", "#383838", "#1c1c1c"]


def _cmap(levels, colors):
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


def _legend(fig, rect, levels, colors, label):
    cm, nm = _cmap(levels, colors)
    cax = fig.add_axes(rect)
    cb = fig.colorbar(plt.cm.ScalarMappable(norm=nm, cmap=cm), cax=cax, orientation="horizontal",
                      extend="max", ticks=levels, extendfrac=0.04)
    cb.ax.set_xticklabels([f"{v:g}" for v in levels], fontproperties=REG, fontsize=7.5, color=BLACK)
    cb.ax.tick_params(length=2, width=0.5, color=BLACK)
    cb.outline.set_visible(False)
    cax.set_title(label, loc="left", fontproperties=REG, fontsize=8, color=GRAY, pad=4)


def _run(m):
    return f"{m['run']:%HZ %a %-d %b} run" if m.get("run") is not None else ""


def _figure(panels, cfg, out_path, levels, colors, label, spread=None):
    """panels: list of (lat, lon, field, title, sub). `spread` appended in its own ramp."""
    n = len(panels) + (1 if spread is not None else 0)
    ncols = n if n <= 6 else 5        # wide rows: small multiples read best side by side
    rows = (n + ncols - 1) // ncols
    PW, PH, LEG = 2.45, 3.5, 0.75   # panel width/height and legend band, inches
    fig = plt.figure(figsize=(PW * ncols, PH * rows + LEG), facecolor=PAPER, dpi=160)
    gs = fig.add_gridspec(rows, ncols, left=0.01, right=0.99, top=1 - 0.32 / (PH * rows + LEG),
                          bottom=LEG / (PH * rows + LEG), wspace=0.07, hspace=0.24)
    axes, tr = _axes(fig, gs, n, cfg["domain"])
    cm, nm = _cmap(levels, colors)
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
        _legend(fig, [0.01, leg_y, 0.6, 0.11 / (PH * rows + LEG)], levels, colors, label)
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
