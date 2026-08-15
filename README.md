# Git Rail

A VS Code extension prototype for visualizing Git history as **stable branch rails** instead of continuously rearranging topology columns.

## What the MVP does

- opens a full editor panel with `Git Rail: Open Branch Map`
- creates one stable vertical rail per current local branch
- assigns first-parent history to those rails
- renders ordinary parent edges and dashed merge-parent edges
- provides a synthetic `history` rail for commits that cannot be assigned to a current branch
- click a branch header to focus/dim the rest of the graph
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

## Settings

- `gitRail.maxCommits` — default `300`
- `gitRail.includeRemoteBranches` — default `false`

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
src/git.js       Git command execution and repository model
src/layout.js    editor-independent stable-lane layout
src/extension.js VS Code integration + Webview renderer
test/            Node built-in tests
```

## License

MIT

## TODO

* color mode (configurable): draw each branch lane in different colors
* rename to git-lanes?? need better name!
* unify the local branch ant its remote origin, so it does not appear as two branches in the lanes
* `history` lane is problematic, as multiple `history` lanes look like one, but in reality, there are multiple in parallel. how to visualize this without creating multiple history lanes in parallel from top to bottom? it would be ok to show these temporary lanes as in-between lanes. create a plan how to visualize first
* visualize cherry picks
