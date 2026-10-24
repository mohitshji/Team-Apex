"""USAR campus HVAC simulation (Delhi).

Compares an "always full cooling" HVAC against a timetable-aware,
comfort-aware HVAC for one operating day, and writes the result to JSON.

Usage:
    python hvac_simulation.py
    python hvac_simulation.py --season Summer --output forecast_data.json
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------
# 1. CONFIGURATION
# ---------------------------------------------------------------------

DEFAULT_SEASON = "Autumn"
OPERATING_HOURS = range(8, 18)  # 08:00 to 17:00

# Power model constants (kW)
BASE_FAN_KW_PER_ZONE = 12.0
MAX_COOLING_KW_PER_ZONE = 35.0
BODY_HEAT_KW_PER_STUDENT = 0.10

# Comfort rules
UNOCCUPIED_SETBACK_C = 28.0
UNOCCUPIED_AIRFLOW_FRACTION = 0.20
FAN_SETPOINT_BONUS_C = 1.0  # moving air feels ~2 C cooler, so raise setpoint 1 C
MAX_INDOOR_OUTDOOR_DELTA_C = 12.0  # thermal shock limit
BEE_BASELINE_C = 24.0
HOT_REFERENCE_C = 38.0
MIN_WEATHER_FACTOR = 0.2


@dataclass(frozen=True)
class SeasonWeather:
    """5-year (2021-2025) average weather for one season, Safdarjung, Delhi."""

    avg_max_temp: float
    mode: str
    outdoor_range: str


SEASONS: dict[str, SeasonWeather] = {
    "Spring/Summer": SeasonWeather(37.15, "Extreme Summer", "38°C to 45°C+"),
    "Summer": SeasonWeather(37.15, "Extreme Summer", "38°C to 45°C+"),
    "Monsoon": SeasonWeather(36.95, "Monsoon / Humid", "32°C to 38°C"),
    "Autumn": SeasonWeather(32.45, "Autumn / Transition", "26°C to 33°C"),
    "Winter": SeasonWeather(23.59, "Winter Season", "7°C to 20°C"),
}


@dataclass(frozen=True)
class ClassSlot:
    """One timetable entry. `end` is exclusive (class 9-10 covers hour 9 only)."""

    room: str
    dept: str
    start: int
    end: int
    students: int
    zone: str

    def is_active(self, hour: int) -> bool:
        return self.start <= hour < self.end


# USAR timetable, Odd Semester 2026-27
TIMETABLE: list[ClassSlot] = [
    ClassSlot("A-406-CR", "AIDS-III", 9, 10, 60, "Block-A"),
    ClassSlot("A-406-CR", "AIDS-III", 10, 11, 60, "Block-A"),
    ClassSlot("A-406-CR", "AIDS-III", 12, 13, 60, "Block-A"),
    ClassSlot("A-601-CR", "AIML-III", 9, 12, 60, "Block-A"),
    ClassSlot("A-601-CR", "AIML-III", 13, 15, 60, "Block-A"),
    ClassSlot("AUB-03-Com Lab", "AIML-III", 9, 11, 30, "Lab-Wing"),
    ClassSlot("AUB-03-Com Lab", "AIML-III", 14, 16, 30, "Lab-Wing"),
    ClassSlot("A-301-Rob Lab", "AR-III", 11, 13, 30, "Lab-Wing"),
    ClassSlot("B-003-Lec Hall", "IIoT-VII", 10, 12, 120, "Block-B"),
    ClassSlot("B-003-Lec Hall", "IIoT-VII", 13, 15, 120, "Block-B"),
]

ZONES = ["Block-A", "Lab-Wing", "Block-B"]


# ---------------------------------------------------------------------
# 2. THERMAL COMFORT LOGIC
# ---------------------------------------------------------------------

def get_comfort_settings(outdoor_temp: float, fans_active: bool = True) -> dict[str, Any]:
    """Return the AC setpoint, mode and thermal-shock check.

    Based on BEE guidelines, fan wind-chill, and a max indoor/outdoor
    difference of 12 C to avoid thermal shock.
    """
    if outdoor_temp >= 38.0:
        base_setpoint, mode = 25.0, "Cooling (High Load)"
    elif outdoor_temp >= 32.0:
        base_setpoint, mode = 24.0, "Dry Mode (Dehumidification)"
    elif outdoor_temp >= 26.0:
        base_setpoint, mode = 24.0, "Eco-Cooling / Ventilation"
    else:
        # Winter: no compressor needed
        return {
            "target_setpoint": 20.0,
            "hvac_mode": "Ventilation Only (Compressor Off)",
            "thermal_shock_safe": True,
            "delta_temp": round(abs(outdoor_temp - 20.0), 1),
        }

    setpoint = base_setpoint + (FAN_SETPOINT_BONUS_C if fans_active else 0.0)

    # Keep indoor/outdoor gap within the thermal shock limit
    shock_safe = (outdoor_temp - setpoint) <= MAX_INDOOR_OUTDOOR_DELTA_C
    if not shock_safe:
        setpoint = outdoor_temp - MAX_INDOOR_OUTDOOR_DELTA_C

    return {
        "target_setpoint": round(setpoint, 1),
        "hvac_mode": mode,
        "thermal_shock_safe": shock_safe,
        "delta_temp": round(outdoor_temp - setpoint, 1),
    }


def get_weather_factor(outdoor_temp: float) -> float:
    """Cooling load scale (0.2 to ~1+) relative to the 24 C BEE baseline."""
    raw = (outdoor_temp - BEE_BASELINE_C) / (HOT_REFERENCE_C - BEE_BASELINE_C)
    return max(MIN_WEATHER_FACTOR, raw)


# ---------------------------------------------------------------------
# 3. POWER MODEL
# ---------------------------------------------------------------------

def students_in_zone(zone: str, hour: int) -> int:
    return sum(c.students for c in TIMETABLE if c.zone == zone and c.is_active(hour))


def unoptimized_zone_kw(students: int) -> float:
    """Baseline: full cooling the whole day, whether occupied or not."""
    return (
        BASE_FAN_KW_PER_ZONE
        + MAX_COOLING_KW_PER_ZONE
        + students * BODY_HEAT_KW_PER_STUDENT
    )


def optimized_zone_kw(students: int, weather_factor: float) -> float:
    """Timetable-aware: throttle empty zones, scale cooling by weather."""
    if students == 0:
        return BASE_FAN_KW_PER_ZONE + (
            MAX_COOLING_KW_PER_ZONE * UNOCCUPIED_AIRFLOW_FRACTION * weather_factor
        )
    return (
        BASE_FAN_KW_PER_ZONE
        + MAX_COOLING_KW_PER_ZONE * weather_factor
        + students * BODY_HEAT_KW_PER_STUDENT
    )


# ---------------------------------------------------------------------
# 4. HOURLY SIMULATION
# ---------------------------------------------------------------------

def simulate_day(comfort: dict[str, Any], weather_factor: float) -> list[dict[str, Any]]:
    """Run the hour-by-hour simulation and return one record per hour."""
    occupied_setpoint = f"{comfort['target_setpoint']}°C ({comfort['hvac_mode']})"
    unoccupied_setpoint = f"{UNOCCUPIED_SETBACK_C}°C (Unoccupied Setback)"

    records: list[dict[str, Any]] = []
    for hour in OPERATING_HOURS:
        total_students = 0
        unopt_total = 0.0
        opt_total = 0.0
        zone_details: dict[str, Any] = {}

        for zone in ZONES:
            students = students_in_zone(zone, hour)
            unopt = unoptimized_zone_kw(students)
            opt = optimized_zone_kw(students, weather_factor)

            total_students += students
            unopt_total += unopt
            opt_total += opt

            occupied = students > 0
            zone_details[zone] = {
                "status": f"ACTIVE ({students} Students)" if occupied else "THROTTLED (20% Airflow)",
                "target_setpoint": occupied_setpoint if occupied else unoccupied_setpoint,
                "students": students,
                "kw_unoptimized": round(unopt, 1),
                "kw_optimized": round(opt, 1),
            }

        records.append({
            "hour": hour,
            "time_str": f"{hour:02d}:00",
            "total_students": total_students,
            "unoptimized_kw": round(unopt_total, 1),
            "optimized_kw": round(opt_total, 1),
            "kwh_saved": round(unopt_total - opt_total, 1),
            "zones": zone_details,
        })
    return records


# ---------------------------------------------------------------------
# 5. METRICS
# ---------------------------------------------------------------------

def compute_metrics(df: pd.DataFrame) -> dict[str, float]:
    """Error metrics (PS-21) plus peak and energy savings."""
    actual = df["unoptimized_kw"]
    predicted = df["optimized_kw"]
    error = actual - predicted

    mae = float(np.mean(np.abs(error)))
    rmse = float(np.sqrt(np.mean(error**2)))
    mape = float(np.mean(np.abs(error / actual)) * 100)  # actual is always > 0

    unopt_peak = float(actual.max())
    opt_peak = float(predicted.max())
    return {
        "unoptimized_peak_kw": unopt_peak,
        "optimized_peak_kw": opt_peak,
        "peak_reduction_kw": round(unopt_peak - opt_peak, 1),
        "total_kwh_saved": round(float(df["kwh_saved"].sum()), 1),
        "mae_kw": round(mae, 2),
        "rmse_kw": round(rmse, 2),
        "mape_percent": round(mape, 2),
    }


# ---------------------------------------------------------------------
# 6. OUTPUT
# ---------------------------------------------------------------------

def print_summary(season: str, weather: SeasonWeather, comfort: dict[str, Any],
                  metrics: dict[str, float]) -> None:
    line = "=" * 65
    print(f"\n{line}")
    print(f"  USAR CAMPUS HVAC ENGINE — DELHI {season.upper()} SIMULATION")
    print(line)
    print(f"  Outdoor Weather Baseline   : {weather.avg_max_temp}°C ({weather.mode})")
    print(f"  Calculated Target Setpoint : {comfort['target_setpoint']}°C ({comfort['hvac_mode']})")
    print(f"  Thermal Shock Safe Delta   : {comfort['delta_temp']}°C (Safe: {comfort['thermal_shock_safe']})")
    print("-" * 65)
    print(f"  Unoptimized Peak Demand    : {metrics['unoptimized_peak_kw']} kW")
    print(f"  Optimized Peak Demand      : {metrics['optimized_peak_kw']} kW")
    print(f"  Peak Demand Shaved         : {metrics['peak_reduction_kw']} kW")
    print(f"  Total Daily Energy Saved   : {metrics['total_kwh_saved']} kWh")
    print("-" * 65)
    print("  PS-21 Error Metrics:")
    print(f"   • MAE  : {metrics['mae_kw']} kW")
    print(f"   • RMSE : {metrics['rmse_kw']} kW")
    print(f"   • MAPE : {metrics['mape_percent']}%")
    print(f"{line}\n")


def run(season: str, output_path: Path) -> dict[str, Any]:
    if season not in SEASONS:
        raise ValueError(f"Unknown season '{season}'. Choose from: {', '.join(SEASONS)}")

    weather = SEASONS[season]
    comfort = get_comfort_settings(weather.avg_max_temp, fans_active=True)
    weather_factor = get_weather_factor(weather.avg_max_temp)

    hourly = simulate_day(comfort, weather_factor)
    metrics = compute_metrics(pd.DataFrame(hourly))

    report = {
        "weather_context": {
            "location": "Safdarjung, Delhi",
            "season": season,
            "outdoor_temp_c": weather.avg_max_temp,
            "indoor_comfort_rules": comfort,
        },
        "metrics": metrics,
        "hourly_timeline": hourly,
    }

    output_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print_summary(season, weather, comfort, metrics)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="USAR campus HVAC simulation")
    parser.add_argument("--season", default=DEFAULT_SEASON, choices=list(SEASONS))
    parser.add_argument("--output", type=Path, default=Path("forecast_data.json"))
    args = parser.parse_args()
    run(args.season, args.output)


if __name__ == "__main__":
    main()
