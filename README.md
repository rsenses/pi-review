# Pi Review

A native Pi code-review extension for Git diffs. `/review` opens a screen for the repository containing Pi's current working directory. It renders normal Delta output and enables line comments only where the Git patch mapping is verified. Drafts are scoped to the current Pi session and repository. Opening or closing the screen sends nothing; `w` requests submission or validation, and `y` confirms after a fresh diff check.

Reviews are bounded to 256 diff sections, 24 MiB per subprocess, 64 MiB total subprocess output, and 60 seconds; exceeding a limit aborts the review instead of showing an incomplete diff. Terminal controls found in source text are displayed as escaped text while Delta's own colors are retained.

## Requirements

- Pi 0.87.1 or newer.
- `git` and `delta` available on `PATH`.

## Install

Install from the public Git repository:

```sh
pi install git:github.com/rsenses/pi-review
```

Append `@<tag-or-commit>` to pin a specific Git ref. Pi installs this globally for your user by default; see the [Pi package documentation](https://pi.dev/docs/latest/packages) for Git sources and package management. The repository root contains a `pi` manifest in `package.json` that loads `index.ts`.

Pi packages can execute extension code with Pi's permissions. Review the source before installing.

## Review prompt

The optional user-level configuration lives at `~/.pi/agent/extensions/pi-review/config.json` (or under the agent directory selected by Pi). In this dotfiles checkout it is stored at `dotfiles/pi/.pi/agent/extensions/pi-review/config.json`, separately from this package repository:

```json
{
  "prompt": {
    "append": "\n\n---\n\nExtra instructions appended to comment reviews."
  }
}
```

`prompt.append` affects only the comment-review follow-up; the no-comments validation message is unchanged. If the file or field is absent, no custom text is appended.

## Controls

- `j`/`k` or arrows: navigate; the viewport scrolls only when the cursor reaches an edge.
- `c`: add or edit a file/line comment.
- In the comment editor, `Enter` saves the comment. `Shift+Enter` (or Pi's default `Ctrl+J`) inserts a newline, so the comment can span multiple lines. `Esc` cancels editing.
- `x`: remove the selected comment. Stale drafts remain visible and must be removed with `x` before sending.
- `w`: ask to send comments or validation. `y` confirms after a fresh diff check; `n`/`Esc` cancels. `q` closes without sending and preserves drafts.

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
