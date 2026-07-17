# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [1.1.0] - 2026-07-17

### Added
- Added cancellation support for schedule execution. (`e78788e`)
- Added Running and Stopped lifecycle controls for recurring schedules. (`db06cc9`)
- Added recurring send totals and recent send-time history.
- Added editing of messages, next send times, and frequencies for Running recurring schedules while keeping targets unchanged.

### Changed
- Improved scheduling error handling and protected Stop, Delete, and Edit operations from execution races. (`e78788e`)

## [1.0.0] - 2026-07-15

### Added
- Created the initial Manifest V3 WhatsApp Web scheduling extension. (`d0efb28`)
- Added automatic WhatsApp tab discovery and message sending improvements. (`0025a8b`)
- Added Clear Done history cleanup and enhanced schedule rendering. (`7fdb600`)
- Added copyright and MIT license notices. (`0154ffd`)
- Added popup guidance and accessible control titles. (`03f470a`)
- Added automated release ZIP creation with GitHub Actions. (`a7d0cf9`)
- Added a rich-text message toolbar with auto-continuing lists. (`e62c849`, merged by `186a5f9`)
- Added every-minute recurring schedules. (`77d7a75`)

### Changed
- Improved popup schedule-time validation. (`77d7a75`)
