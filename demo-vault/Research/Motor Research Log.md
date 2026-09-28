---
tags: [research, motor, experiment, vibration]
---
# Motor Research Log

## 2026-09-14 — baseline

At constant speed, the healthy motor has a stable RMS vibration level. A loose
mount visibly increases low-frequency vibration. Current is useful because it
helps distinguish a load change from a purely mechanical anomaly.

## 2026-09-21 — feature plan

Use RMS and peak-to-peak as a simple baseline. Add selected
[[Concepts/FFT Analysis|FFT]] band energy when the baseline is reliable.

## Open question

Can the ESP32 calculate the useful bands quickly enough without sending raw
samples? This belongs to [[Projects/ESP32 Edge Prototype]].

