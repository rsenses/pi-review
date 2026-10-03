# Pi Review

A native Pi code-review extension for Git diffs. `/review` opens a screen for the repository containing Pi's current working directory. It renders normal Delta output and enables line comments only where the Git patch mapping is verified. Drafts are scoped to the current Pi session and repository. Opening or closing the screen sends nothing; `w` requests submission or validation, and `y` confirms after a fresh diff check.

The screen opens as a full-viewport overlay with a sidebar of the changed files on the left, and the diff on the right. The sidebar is a folder tree, always expanded, with siblings in the order they first appear in the diff — so the staged-before-untracked grouping of `git diff` survives at folder level. Each file line shows only its base name, since the folder is implied by nesting. Delta is rendered for the width of the diff column, so the sidebar costs nothing in diff space. Terminals narrower than 76 columns drop the sidebar and give the whole width to the diff.

Reviews are bounded to 256 diff sections, 24 MiB per subprocess, 64 MiB total subprocess output, and 60 seconds; exceeding a limit aborts the review instead of showing an incomplete diff. Terminal controls found in source text are displayed as escaped text while Delta's own colors are retained.

## Requirements

- Pi 0.87.1 or newer.
- Git available on `PATH`.
- Delta available on `PATH`. Delta is required; if it is missing, the review fails with a clear error.

## Install

Install from the public Git repository:

```sh
pi install git:github.com/rsenses/pi-review
```

Append `@<tag-or-commit>` to pin a specific Git ref. Pi installs this globally for your user by default; see the [Pi package documentation](https://pi.dev/docs/latest/packages) for Git sources and package management. The repository root contains a `pi` manifest in `package.json` that loads `index.ts`.

Pi packages can execute extension code with Pi's permissions. Review the source before installing.

## Prompt configuration

The optional user-level configuration lives at `~/.pi/agent/extensions/pi-review/config.json` (or under the agent directory selected by Pi). In this dotfiles checkout it is stored at `dotfiles/pi/.pi/agent/extensions/pi-review/config.json`, separately from this package repository:

```json
{
  "prompt": {
    "prepend": null,
    "append": "\n\n---\n\nExtra instructions for comment reviews.",
    "comments": null,
    "validation": null
  }
}
```

All four fields are optional and may be `null`. Missing or `null` `prepend`/`append` values do nothing; when provided, they are concatenated verbatim around the comment-review follow-up, so include any desired whitespace or separators. They do not affect validation.

`prompt.comments` replaces the default comment-review instructions; Pi still appends the generated list of file/line comments. If missing or `null`, the existing instructions are used. `prompt.validation` replaces the no-comments validation message; if missing or `null`, the existing default is used.

Git generates one canonical unified patch with NUL-delimited file metadata; pi-review verifies its old/new paths before mapping line anchors. Delta presents that patch, while Pi provides navigation, comments, drafts, stale detection and submission. Git's configured pager is never used: pi-review captures Git's output and runs Delta directly with paging disabled, line numbers enabled and the width set to the review viewport. Delta's other normal configuration (including syntax highlighting, theme and styles) remains in effect.

Compatible Git diff configuration (including algorithm, indent heuristic and context) is left in place. For a verifiable patch, pi-review disables external diffs, textconv and Git colors, requires default path prefixes and short submodule summaries, and includes submodule changes. Git moved-color settings cannot color this captured patch because Git colors are disabled; Delta supplies the visual colors. No PTY or other pager is launched.

## Controls

- `j`/`k` or arrows: navigate; the viewport scrolls only when the cursor reaches an edge.
- `h`/`l` or left/right arrows: jump to the previous or next file. The sidebar follows the cursor, marking the current file with `▸` and highlighting the folders that contain it.
- `c`: add or edit a file/line comment.
- In the comment editor, `Enter` saves the comment. `Shift+Enter` (or Pi's default `Ctrl+J`) inserts a newline, so the comment can span multiple lines. `Esc` cancels editing.
- `x`: remove the selected comment. Stale drafts remain visible and must be removed with `x` before sending.
- `w`: ask to send comments or validation. `y` confirms after a fresh diff check; `n`/`Esc` cancels. `q` closes without sending and preserves drafts.

The sidebar lists each changed folder and the files inside it. A `●N` badge counts the drafts on that file; it turns amber when one of those drafts has a stale anchor.

## Acknowledgements

Pi Review's review workflow was inspired by [Plannotator Code Review](https://plannotator.ai/code-review/). Thanks to [Plannotator](https://github.com/backnotprop/plannotator) and its contributors for their work and inspiration. Pi Review is an independent native Pi extension.

## Development checks

For a local checkout, use `pi install /path/to/pi-review` or add its path to `packages` in `~/.pi/agent/settings.json`. Pi resolves relative package paths from the settings file.

Run from this directory after installing the development dependencies:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
# or both gates:
npm run check
```

The tests use Node's built-in test runner; the extension itself is loaded by Pi without a build step. The Pi SDK versions in `devDependencies` are the versions used for local typechecking; update them when validating against a newer Pi release.
