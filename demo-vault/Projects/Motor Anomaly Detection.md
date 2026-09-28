---
tags: [project, motor, predictive-maintenance, active]
---
# Motor Anomaly Detection

Build an edge system that detects unusual motor behaviour before bearing
failure. The prototype combines vibration and motor-current signals from an
[[Concepts/IMU Sensors|IMU]] and current sensor, then sends compact features to
an ESP32.

## What success looks like

- Detect bearing-fault patterns within five seconds.
- Keep inference local on the [[Projects/ESP32 Edge Prototype|ESP32 prototype]].
- Compare a simple RMS baseline against [[Concepts/FFT Analysis|FFT features]].

## Related knowledge

The research plan is in [[Research/Predictive Maintenance]]. Experimental
observations are collected in [[Research/Motor Research Log]]. The current
sampling approach is recorded in [[Decisions/Motor Sampling Revision]].

## Next experiment

Capture ten normal runs and three deliberately imbalanced runs at 4 kHz.

