/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { ScreenType, CampusZone, HourlyForecast, BMSLogEntry } from './types';
import {
  INITIAL_HOURLY_FORECASTS,
  INITIAL_ZONES,
  INITIAL_BMS_LOGS,
  MODEL_METRICS_DATA,
} from './data/mockData';
import { Header } from './components/Header';
import { MicroclimateCards } from './components/MicroclimateCards';
import { ModelMetricsCard } from './components/ModelMetricsCard';
import { ForecastChart } from './components/ForecastChart';
import { HourScrubber } from './components/HourScrubber';
import { CampusZoneStatus } from './components/CampusZoneStatus';
import { RoiPanel } from './components/RoiPanel';
import { LiveActionLog } from './components/LiveActionLog';
import { SetPointModal } from './components/SetPointModal';
import { ZoneDetailScreen } from './components/screens/ZoneDetailScreen';
import { ModelEngineScreen } from './components/screens/ModelEngineScreen';
import { RoiReportScreen } from './components/screens/RoiReportScreen';
import { ScenarioSimulatorScreen } from './components/screens/ScenarioSimulatorScreen';

export default function App() {
  const [currentScreen, setCurrentScreen] = useState<ScreenType>('overview');
  const [currentHour, setCurrentHour] = useState<number>(14);
  const [autoBalancing, setAutoBalancing] = useState<boolean>(true);
  const [isStreaming, setIsStreaming] = useState<boolean>(true);

  // Microclimate & Comfort parameters
  const [targetSetpoint, setTargetSetpoint] = useState<number>(25.1);
  const [beeModeLabel, setBeeModeLabel] = useState<string>('Dry Mode (BEE)');
  const [thermalSafetyActive, setThermalSafetyActive] = useState<boolean>(true);
  const [isSetpointModalOpen, setIsSetpointModalOpen] = useState<boolean>(false);

  // Environmental scenario offsets
  const [scenarioOffset, setScenarioOffset] = useState<{
    tempDelta: number;
    humidityDelta: number;
    occupancyFactor: number;
  }>({
    tempDelta: 0,
    humidityDelta: 0,
    occupancyFactor: 1,
  });

  // State collections
  const [zones, setZones] = useState<CampusZone[]>(INITIAL_ZONES);
  const [logs, setLogs] = useState<BMSLogEntry[]>(INITIAL_BMS_LOGS);
  const [hourlyForecasts, setHourlyForecasts] = useState<HourlyForecast[]>(INITIAL_HOURLY_FORECASTS);

  // Find active hour baseline
  const activeForecast = hourlyForecasts.find((f) => f.hour === currentHour) || hourlyForecasts[6];

  // Dynamic calculations based on current hour and scenario
  const effectiveOutdoorTemp = parseFloat(
    (activeForecast.outdoorTemp + scenarioOffset.tempDelta).toFixed(2)
  );
  const effectiveHumidity = Math.min(
    95,
    Math.max(25, Math.round(activeForecast.humidity + scenarioOffset.humidityDelta))
  );

  // Adjust zones dynamically when scrubber or scenario changes
  useEffect(() => {
    setZones((prevZones) =>
      prevZones.map((z) => {
        let loadRatio = 1.0;
        let occRatio = 1.0;

        if (currentHour === 14) {
          // Exact screenshot defaults
          if (z.id === 'block-a') return { ...z, powerKw: 42.8, occupancy: 340, status: 'ACTIVE', airflowLabel: '100% (Normal)' };
          if (z.id === 'lab-wing') return { ...z, powerKw: 36.5, occupancy: 120, status: 'ACTIVE', airflowLabel: '85% (Optimized)' };
          if (z.id === 'block-b') return { ...z, powerKw: 6.2, occupancy: 0, status: 'THROTTLED (20%)', airflowLabel: 'Eco Idle', chillerLoopBypassed: true };
        }

        if (z.id === 'block-a') {
          loadRatio = activeForecast.zoneBreakdown.blockA / 42.8;
          occRatio = (activeForecast.totalOccupancy * 0.74) / 340;
          return {
            ...z,
            powerKw: parseFloat((42.8 * loadRatio).toFixed(1)),
            occupancy: Math.round(340 * occRatio * scenarioOffset.occupancyFactor),
          };
        }
        if (z.id === 'lab-wing') {
          loadRatio = activeForecast.zoneBreakdown.labWing / 36.5;
          occRatio = (activeForecast.totalOccupancy * 0.26) / 120;
          return {
            ...z,
            powerKw: parseFloat((36.5 * loadRatio).toFixed(1)),
            occupancy: Math.round(120 * occRatio * scenarioOffset.occupancyFactor),
          };
        }
        if (z.id === 'block-b') {
          return {
            ...z,
            powerKw: parseFloat((activeForecast.zoneBreakdown.blockB).toFixed(1)),
          };
        }
        return z;
      })
    );
  }, [currentHour, scenarioOffset]);

  // Periodic BMS action log streaming simulation
  useEffect(() => {
    if (!isStreaming) return;
    const interval = setInterval(() => {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      const timeStr = `${hh}:${mm}:${ss}`;

      const dynamicMessages = [
        'AHU-1 modulating damper trimmed by 2% to balance supply static pressure.',
        'Lab-Wing cleanroom particulate sensors nominal: Air change rate maintained at 18 ACH.',
        'Chilled water return delta T optimal at 5.8°C; secondary VFD pump running at 41 Hz.',
        'Campus occupancy update: Wi-Fi beacon telemetry reconciled with academic timetable.',
        'Thermal safety ΔT verification pulse passed: comfort boundary compliant.',
      ];

      const newMsg = dynamicMessages[Math.floor(Math.random() * dynamicMessages.length)];
      setLogs((prev) => [
        {
          id: `dyn-${Date.now()}`,
          time: timeStr,
          message: newMsg,
          category: 'safety',
          level: 'info',
        },
        ...prev.slice(0, 14),
      ]);
    }, 7000);

    return () => clearInterval(interval);
  }, [isStreaming]);

  const handleUpdateZone = (zoneId: string, updates: Partial<CampusZone>) => {
    setZones((prev) => prev.map((z) => (z.id === zoneId ? { ...z, ...updates } : z)));
    // Add corresponding BMS log
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(
      now.getMinutes()
    ).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

    setLogs((prev) => [
      {
        id: `manual-${Date.now()}`,
        time: timeStr,
        message: `Manual operator action applied to ${zoneId}: Setpoint/damper state updated.`,
        category: 'damper',
        level: 'warning',
      },
      ...prev,
    ]);
  };

  const handleAddManualLog = (message: string) => {
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(
      now.getMinutes()
    ).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    setLogs((prev) => [
      {
        id: `inj-${Date.now()}`,
        time: timeStr,
        message,
        category: 'schedule',
        level: 'info',
      },
      ...prev,
    ]);
  };

  const handleApplyScenario = (tempShift: number, humidityShift: number, occupancyFactor: number) => {
    setScenarioOffset({
      tempDelta: tempShift,
      humidityDelta: humidityShift,
      occupancyFactor,
    });
    // Add log
    handleAddManualLog(
      `Simulation Scenario applied: Outdoor temp shift ${tempShift > 0 ? '+' : ''}${tempShift.toFixed(1)}°C, Occupancy factor ${(occupancyFactor * 100).toFixed(0)}%.`
    );
  };

  return (
    <div className="min-h-screen selection:bg-[#e040a0]/20 selection:text-[#e040a0]">
      {/* Top Header & Branding (Full Width Widescreen) */}
      <Header
        currentScreen={currentScreen}
        onSelectScreen={setCurrentScreen}
        isStreaming={isStreaming}
        onToggleStreaming={() => setIsStreaming(!isStreaming)}
        autoBalancing={autoBalancing}
        onToggleAutoBalancing={() => {
          setAutoBalancing(!autoBalancing);
          handleAddManualLog(
            `Campus Auto-Balancing mode ${!autoBalancing ? 'engaged' : 'switched to manual control'}.`
          );
        }}
      />

      {/* Main Content Area */}
      <main className="max-w-[1500px] mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {currentScreen === 'overview' && (
          <>
            {/* Top Summary Row: Microclimate & Comfort Control Cards */}
            <MicroclimateCards
              outdoorTemp={effectiveOutdoorTemp}
              humidity={effectiveHumidity}
              targetSetpoint={targetSetpoint}
              onOpenSetpointModal={() => setIsSetpointModalOpen(true)}
              dailySavingsKwh={432.2}
              peakShedKw={6.4}
              peakShedPct={14.2}
              thermalSafetyActive={thermalSafetyActive}
              onToggleThermalSafety={() => {
                setThermalSafetyActive(!thermalSafetyActive);
                handleAddManualLog(
                  `BEE Thermal Safety ΔT > 12°C Guard ${
                    !thermalSafetyActive ? 'activated' : 'manually bypassed'
                  }.`
                );
              }}
              heatIndexLabel={effectiveOutdoorTemp > 36 ? 'Heat Index: High' : 'Heat Index: Moderate'}
              beeModeLabel={beeModeLabel}
            />

            {/* Main Content Widescreen Grid (7:5 Ratio matching screenshot) */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Left Column: Wide Analytics & Forecasting (lg:col-span-7) */}
              <div className="lg:col-span-7 space-y-6">
                {/* PS-21 Error Metrics Panel */}
                <ModelMetricsCard
                  metrics={MODEL_METRICS_DATA}
                  onOpenModelScreen={() => setCurrentScreen('model')}
                />

                {/* Main Hourly Power Demand Forecast Chart */}
                <ForecastChart
                  forecasts={hourlyForecasts}
                  currentHour={currentHour}
                  onSelectHour={setCurrentHour}
                  thresholdKw={110}
                />

                {/* Dynamic Time Slider & Hour Scrubber */}
                <HourScrubber currentHour={currentHour} onHourChange={setCurrentHour} />
              </div>

              {/* Right Column: Campus Operations, ROI & Logs (lg:col-span-5) */}
              <div className="lg:col-span-5 space-y-6">
                {/* Campus Zone Status Breakdown */}
                <CampusZoneStatus
                  zones={zones}
                  autoBalancing={autoBalancing}
                  onToggleAutoBalancing={() => setAutoBalancing(!autoBalancing)}
                  onSelectZone={(zone) => {
                    setCurrentScreen('zones');
                  }}
                  currentHour={currentHour}
                />

                {/* Financial & Carbon ROI Panel */}
                <RoiPanel
                  dailyCostSavings={4322}
                  monthlyEstimateLakhs={1.29}
                  carbonOffsetKg={354.4}
                  billingCycleDay={18}
                  onOpenRoiScreen={() => setCurrentScreen('roi')}
                />

                {/* BMS Live Action Log Terminal */}
                <LiveActionLog
                  logs={logs}
                  isStreaming={isStreaming}
                  onToggleStreaming={() => setIsStreaming(!isStreaming)}
                  onAddManualLog={handleAddManualLog}
                />
              </div>
            </div>
          </>
        )}

        {/* Screen 2: Zone Diagnostics & AHU Subsystems */}
        {currentScreen === 'zones' && (
          <ZoneDetailScreen
            zones={zones}
            onUpdateZone={handleUpdateZone}
            onBackToOverview={() => setCurrentScreen('overview')}
          />
        )}

        {/* Screen 3: PS-21 Model Engine & Telemetry */}
        {currentScreen === 'model' && (
          <ModelEngineScreen
            metrics={MODEL_METRICS_DATA}
            onBackToOverview={() => setCurrentScreen('overview')}
          />
        )}

        {/* Screen 4: Tariff & Carbon Reports */}
        {currentScreen === 'roi' && (
          <RoiReportScreen onBackToOverview={() => setCurrentScreen('overview')} />
        )}

        {/* Screen 5: Scenario Simulator */}
        {currentScreen === 'simulator' && (
          <ScenarioSimulatorScreen
            onApplyScenario={handleApplyScenario}
            onBackToOverview={() => setCurrentScreen('overview')}
          />
        )}
      </main>

      {/* Target Setpoint & BEE Safety Modal */}
      <SetPointModal
        isOpen={isSetpointModalOpen}
        onClose={() => setIsSetpointModalOpen(false)}
        currentSetpoint={targetSetpoint}
        outdoorTemp={effectiveOutdoorTemp}
        onSaveSetpoint={(newSetpoint, newMode) => {
          setTargetSetpoint(newSetpoint);
          setBeeModeLabel(newMode);
          handleAddManualLog(
            `Campus Target Setpoint adjusted to ${newSetpoint.toFixed(1)}°C (${newMode}).`
          );
        }}
      />
    </div>
  );
}
