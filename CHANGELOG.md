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

- A sidebar of changed files on the left of the review screen, as a folder tree that is
  always expanded. The diff body follows the same order, so the sidebar, the diff and
  `h`/`l` all agree: a new file in a folder that already has modified files appears beside
  them rather than at the end, which is where `git diff` puts untracked files. File lines show
  only the base name, since the folder is implied by nesting. The current file is marked
  with `▸`, the folders containing it are highlighted, and a `●N` badge shows how many
  drafts each file has
  (amber when one of them has a stale anchor). Delta is now rendered for the width of the
  diff column rather than the whole terminal. Terminals narrower than 76 columns keep the
  previous full-width diff with no sidebar.

[Unreleased]: https://github.com/rsenses/pi-review/compare/main...HEAD