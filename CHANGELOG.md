# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- The review screen no longer flickers, or intermittently shows the agent transcript
  through it while scrolling. The screen is now a full-viewport overlay, so Pi's footer
  and the conversation above can no longer be drawn over the review. Previously the
  component was mounted in Pi's editor container, and Pi renders its own footer below it,
  which pushed the top rows of the review off-screen and revealed transcript text instead.

### Added

- A sidebar of changed files on the left of the review screen, listed in the same order
  they appear in the diff. The current file is marked with `▸`, the sidebar follows the
  cursor as it moves between files, and a `●N` badge shows how many drafts each file has
  (amber when one of them has a stale anchor). Delta is now rendered for the width of the
  diff column rather than the whole terminal. Terminals narrower than 76 columns keep the
  previous full-width diff with no sidebar.

[Unreleased]: https://github.com/rsenses/pi-review/compare/main...HEAD