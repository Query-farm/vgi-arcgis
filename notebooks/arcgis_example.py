"""Fetch public provenance metadata and plot only SQL-returned ArcGIS results."""

import json
from urllib.request import urlopen
import numpy as np
import matplotlib.pyplot as plt
from vgi_notebooks import finish

COUNTIES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1"
IMAGERY = (
    "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer"
)
LAND, WATER, SELECTED = "#b78a4b", "#217da6", "#a84234"


def metadata(url):
    if url not in {COUNTIES, IMAGERY}:
        raise ValueError("Only the two documented public metadata URLs are allowed")
    with urlopen(url + "?f=pjson", timeout=60) as response:
        body = json.load(response)
    if "error" in body:
        raise RuntimeError("Public ArcGIS metadata request returned an error")
    return body


def validate_share(value):
    if type(value) not in {int, float} or not np.isfinite(value) or not 0 <= value <= 1:
        raise ValueError("WATER_SHARE_THRESHOLD must be a finite fraction from 0 to 1")


def validate_elevation(value):
    if (
        type(value) not in {int, float}
        or not np.isfinite(value)
        or not 0 <= value <= 1500
    ):
        raise ValueError("ELEVATION_THRESHOLD_M must be finite and between 0 and 1500")


def county_areas(counties, summary, WATER_SHARE_THRESHOLD, started_utc):
    s = summary.iloc[0]
    plot = counties.sort_values("water_share")
    y = np.arange(len(plot))
    fig, axes = plt.subplots(
        1, 2, figsize=(12.6, 6.8), sharey=True, gridspec_kw={"width_ratios": [1.15, 1]}
    )
    axes[0].barh(y, plot.land_km2, color=LAND, label="Land")
    axes[0].barh(y, plot.water_km2, left=plot.land_km2, color=WATER, label="Water")
    axes[0].set_yticks(y, plot.county.str.replace(" County", "", regex=False))
    axes[0].set_xlabel("County area (km²)")
    axes[0].set_title("Absolute area: land + water")
    axes[0].legend(loc="lower right")
    for idx, (_, row) in enumerate(plot.iterrows()):
        axes[1].plot(
            row.water_share * 100,
            idx,
            "D" if row.meets_cutoff else "o",
            color=SELECTED if row.meets_cutoff else WATER,
            markersize=6,
        )
    axes[1].axvline(
        WATER_SHARE_THRESHOLD * 100,
        color=SELECTED,
        linestyle="--",
        label=f"Cutoff ≥ {WATER_SHARE_THRESHOLD:.0%}",
    )
    axes[1].axvline(
        s.area_weighted_share * 100,
        color="#444444",
        linestyle=":",
        label=f"Area-weighted {s.area_weighted_share:.1%}",
    )
    axes[1].set(
        xlabel="Water / total county area (%)",
        xlim=(-2, 102),
        title="Relative area: water share",
    )
    axes[1].legend(loc="lower right", fontsize=9)
    finish(
        fig,
        "Massachusetts: total footprint and water share differ",
        f"14 counties · inclusive cutoff {WATER_SHARE_THRESHOLD:.0%} · source area attributes",
        f"Source: U.S. Census Bureau TIGERweb · state FIPS25 · retrieved {started_utc:%Y-%m-%d %H:%M UTC}\nVGI ArcGIS v0.6.0 + visible SQL · no geometry-area approximation or hazard inference",
        name="01-county-water",
    )


def threshold_curve(sensitivity, counties, summary, WATER_SHARE_THRESHOLD, started_utc):
    s = summary.iloc[0]
    fig, ax = plt.subplots(figsize=(10.5, 4.7))
    # At a county's exact share it remains selected; immediately above it it drops.
    ax.step(
        sensitivity.cutoff * 100,
        sensitivity.selected_count,
        where="pre",
        color=WATER,
        linewidth=2,
    )
    ax.scatter(
        [WATER_SHARE_THRESHOLD * 100],
        [s.selected_count],
        color=SELECTED,
        s=75,
        zorder=3,
        label=f"Selected: {WATER_SHARE_THRESHOLD:.0%} → {int(s.selected_count)} counties",
    )
    ax.axvline(WATER_SHARE_THRESHOLD * 100, color=SELECTED, linestyle="--", alpha=0.6)
    ax.set(
        xlabel="Inclusive water-share cutoff (%)",
        ylabel="Counties meeting cutoff (count)",
        xlim=(-1, 101),
        ylim=(-0.5, len(counties) + 0.5),
    )
    ax.set_yticks(range(0, len(counties) + 1, 2))
    ax.legend(loc="upper right")
    finish(
        fig,
        "A stricter cutoff changes membership, not geography",
        "Inclusive cutoff on one complete local snapshot; no additional service requests",
        f"Source: U.S. Census Bureau TIGERweb · state FIPS25 · retrieved {started_utc:%Y-%m-%d %H:%M UTC}\nVGI ArcGIS v0.6.0 + visible SQL · exploratory threshold, not an official classification",
        name="02-cutoff-sensitivity",
    )


def sample_accounting(inventory, accounting, threshold, started):
    fig, axes = plt.subplots(
        1, 2, figsize=(13, 6.2), gridspec_kw={"width_ratios": [1.65, 1]}
    )
    colors = {
        "At or above cutoff": SELECTED,
        "Below cutoff": WATER,
        "Unavailable": "#919c97",
    }
    for i, row in enumerate(inventory.itertuples()):
        if np.isfinite(row.elevation_m):
            axes[0].plot(
                row.elevation_m,
                i,
                "D" if row.elevation_class == "At or above cutoff" else "o",
                color=colors[row.elevation_class],
                markersize=8,
            )
            axes[0].annotate(
                f"{row.elevation_m:.1f}",
                (row.elevation_m, i),
                xytext=(8, 0),
                textcoords="offset points",
                va="center",
            )
        else:
            axes[0].text(
                0.02,
                i,
                row.availability,
                transform=axes[0].get_yaxis_transform(),
                va="center",
                color="#65756c",
                fontstyle="italic",
                bbox={"facecolor": "white", "edgecolor": "none", "pad": 1.5},
            )
    axes[0].set_yticks(range(len(inventory)), inventory.label)
    axes[0].set_ylim(len(inventory) - 0.5, -0.5)
    axes[0].axvline(
        threshold,
        color=SELECTED,
        linestyle="--",
        linewidth=1.2,
        label=f"Cutoff ≥ {threshold:g} m",
    )
    axes[0].set_xlim(-30, max(float(inventory.elevation_m.max()), threshold) * 1.2 + 30)
    axes[0].set_xlabel("Finite sampled elevation · metres")
    axes[0].set_title("One row per requested coordinate")
    axes[0].legend(
        loc="upper left", bbox_to_anchor=(0, 1.16), fontsize=10, frameon=False
    )
    axes[0].grid(axis="y", visible=False)
    axes[1].bar(
        range(3),
        accounting.requested_points,
        color=[colors[c] for c in accounting.elevation_class],
        width=0.6,
    )
    axes[1].set_xticks(range(3), ["At/above", "Below", "Unavailable"], rotation=15)
    axes[1].set_yticks(range(6))
    axes[1].set_ylim(0, 5.5)
    axes[1].set_ylabel("Requested points · count")
    axes[1].set_title("All five requests remain")
    for i, value in enumerate(accounting.requested_points):
        axes[1].text(i, value + 0.12, str(int(value)), ha="center")
    axes[1].grid(axis="x", visible=False)
    finish(
        fig,
        "A missing sample is not zero elevation",
        f"Five authored WGS84 coordinates · default service sampling · cutoff {threshold:g} m",
        f"Source: USGS 3DEP live ImageServer · retrieved {started:%Y-%m-%d %H:%M UTC}\nVGI ArcGIS v0.6.0 + visible SQL · approximate point labels; no survey, citywide or hazard inference",
        name="03-sample-accounting",
    )
