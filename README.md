# Git Rail

A VS Code extension prototype for visualizing Git history as **stable branch rails** instead of continuously rearranging topology columns.

Target is to easily identify all the commits that lead to the current state in one branch. So clicking on one branch rail/lane shows all commits in the graph and in the commit message list.

## What the MVP does

- opens a full editor panel with `Git Rail: Open Branch Map`
- creates one stable vertical rail per current local/remote branch
- assigns first-parent history to those rails
- renders ordinary parent edges and dashed merge-parent edges
- provides a synthetic `history` rail for commits that cannot be assigned to a current branch
- click a branch header to focus/dim the rest of the graph
- click a commit or a rail/lane to trace its full ancestry (not just the first-parent chain) back to the root, dimming everything unrelated
- toggle **Mark commits already in trace** to check-mark commits already covered by the traced commit — as a literal ancestor, or as a cherry-pick equivalent living anywhere else in the graph — instead of leaving them dimmed
- click a commit hash to copy it
- refresh from the panel
- supports multiple workspace repositories via a picker
- optionally includes remote-tracking branches
- configurable commit limit

## Run it

1. Open this folder in VS Code.
2. Press `F5` to start an Extension Development Host.
3. In the new VS Code window, open a Git repository.
4. Open the Command Palette and run **Git Rail: Open Branch Map**.

The prototype has no runtime npm dependencies. It calls the `git` executable available in the extension host environment.

## Install it into your default VS Code

To use the extension outside of the Extension Development Host, package it into a `.vsix` and install that into your normal VS Code:

```sh
npx --yes @vscode/vsce package
code --install-extension git-rail-0.1.0.vsix
```

`vsce` doesn't need to be installed as a dependency; `npx` fetches it on demand. Adjust the version number in the `.vsix` filename to match `package.json`. Repeat both commands after making changes to pick up the new version (VS Code will overwrite the previously installed one).

## Settings

- `gitRail.maxCommits` — default `300`
- `gitRail.includeLocalBranches` — default `true`
- `gitRail.includeRemoteBranches` — default `false`
- `gitRail.hideEmptyBranches` — default `true`
- `gitRail.maxBranchLabelWidth` — default `130`

## Design notes

A Git commit does not intrinsically belong to a branch. Branches are refs pointing into a DAG. For this MVP, commits are assigned to the nearest current branch along each branch's **first-parent chain**. This intentionally favors semantic stability over compact topology.

That algorithm is deliberately isolated from the renderer in `src/layout.js` / `src/git.js`, because improving branch ownership is expected to be the main area of experimentation.

Potential next steps:

- better ownership of commits from deleted/merged feature branches
- collapse a merged feature branch into a summary card
- hover a merge and highlight exactly which commits it introduced
- branch filters and search
- click a commit to open VS Code's native diff/history actions
- zoom/overview for repositories with many active branches
- incremental refresh instead of rebuilding the full Webview

## Project structure

```text
src/git.js        Git command execution and repository model
src/layout.js     editor-independent stable-lane layout
src/extension.js  VS Code integration (panel, commands, messages)
src/webview.html  Webview markup/CSS/renderer
test/             Node built-in tests
```

## License

MIT

## TODO

* color mode (configurable): draw each branch lane in different colors
* rename to git-lanes?? extension needs a better name!
* `history` lane is problematic, as multiple `history` lanes look like one, but in reality, there are multiple in parallel. how to visualize this without creating multiple history lanes in parallel from top to bottom? it would be ok to show these temporary lanes as in-between lanes. create a plan how to visualize first
* add screenshots to README.md