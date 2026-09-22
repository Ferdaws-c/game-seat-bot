# İKÜ Course Seat Bot

![Course Seat Bot interface illustration](game-seat-bot/preview.svg)

A Chrome extension that watches an İKÜ Orion course section in each tab and adds it to the registration basket when a green seat count appears. Set the section type, optional times, and refresh interval in the popup.

## Install and use

Open the [extension folder](game-seat-bot/) and follow its [installation and configuration guide](game-seat-bot/README.md). When Chrome asks which folder to load as an unpacked extension, choose the inner `game-seat-bot` folder containing `manifest.json`.

The bot supports lab + theory, theory-only, and single-section or online courses. A test run makes a real basket attempt. Check Orion for any final enrollment step.
