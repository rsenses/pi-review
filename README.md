# Pi Review

A native Pi code-review extension for Git diffs. `/review` opens a screen for the repository containing Pi's current working directory. Delta provides the preferred full visual output; when the `delta` executable is absent, the screen falls back to the same canonical Git unified patch. Line comments are enabled only where the patch mapping is verified. Drafts are scoped to the current Pi session and repository. Opening or closing the screen sends nothing; `w` requests submission or validation, and `y` confirms after a fresh diff check.

Reviews are bounded to 256 diff sections, 24 MiB per subprocess, 64 MiB total subprocess output, and 60 seconds; exceeding a limit aborts the review instead of showing an incomplete diff. Terminal controls found in source text are displayed as escaped text. Delta's own colors are retained; the raw-patch fallback is intentionally colorless so source-provided terminal escapes cannot be mistaken for Git styling.

## Requirements

- Pi 0.87.1 or newer.
- `git` available on `PATH`.
- Delta is optional. If `delta` is genuinely missing from `PATH`, pi-review automatically displays the raw unified Git patch; other Delta spawn or exit errors are propagated.

## Install

Install from the public Git repository:

```sh
pi install git:github.com/rsenses/pi-review
```

Append `@<tag-or-commit>` to pin a specific Git ref. Pi installs this globally for your user by default; see the [Pi package documentation](https://pi.dev/docs/latest/packages) for Git sources and package management. The repository root contains a `pi` manifest in `package.json` that loads `index.ts`.

Pi packages can execute extension code with Pi's permissions. Review the source before installing.

## Prompt configuration

The optional user-level configuration lives at `~/.pi/agent/extensions/pi-review/config.json` (or under the agent directory selected by Pi). In this dotfiles checkout it is stored at `dotfiles/pi/.pi/agent/extensions/pi-review/config.json`, separately from this package repository. Renderer selection is automatic; configuration only customizes prompts.

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

Delta renders the canonical unified Git patch with its normal styling and paging disabled. The same captured, no-color patch is the raw fallback and the source for display mapping and stale-draft hashes. The configured Git pager is not used: Git is invoked with `--no-pager` and captured stdout, not as a terminal pager. Source terminal controls are escaped before either display path; Git ANSI colors are disabled so captured output cannot confuse Git styling with ANSI bytes in file contents. Delta output is reconciled against exact patch rows before line anchors are accepted; the raw fallback maps only strict parsed hunk rows.

Git diff-shaping configuration such as `diff.algorithm`, `diff.indentHeuristic`, and `diff.context` remains effective. The extension enforces unified patch output, default `a/`/`b/` prefixes, rename detection, short submodule summaries, and inspection of submodule changes. External diff programs and textconv are disabled. Malformed or mismatched metadata fails closed. Binary and submodule rows remain file-commentable but have no line anchors.

Git compatibility: exercised with Git 2.53.0. Collection uses Git's documented `--patch-with-raw -z` output and validates the raw NUL-delimited records against each unified patch header. Other versions are accepted only when that framing and the quoted paths validate; otherwise the review aborts rather than guessing anchors.

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
