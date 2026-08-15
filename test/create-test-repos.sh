#!/usr/bin/env bash
# Creates a handful of throwaway git repositories under test/repos, each exercising
# a specific Git Rail feature (deleted branches, remote tracking, warnings, long
# branch names, ...). Safe to re-run; it wipes and recreates test/repos each time.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPOS_DIR="$ROOT_DIR/test/repos"

export GIT_AUTHOR_NAME="Test User"
export GIT_AUTHOR_EMAIL="test@example.com"
export GIT_COMMITTER_NAME="Test User"
export GIT_COMMITTER_EMAIL="test@example.com"

commit() {
  local message="$1"
  local file="${2:-file.txt}"
  echo "$message $RANDOM" >> "$file"
  git add "$file"
  git commit -q -m "$message"
}

echo "Removing $REPOS_DIR"
rm -rf "$REPOS_DIR"
mkdir -p "$REPOS_DIR"

# 1. simple: a single linear branch, no warnings, nothing special.
echo "Creating simple"
repo="$REPOS_DIR/simple"
mkdir -p "$repo" && cd "$repo"
git init -q
for i in 1 2 3 4 5; do commit "commit $i"; done

# 2. feature-merge: a feature branch merged into main and then deleted, so its
# commits land in the synthetic "history" lane. Good for testing branch tracing.
echo "Creating feature-merge"
repo="$REPOS_DIR/feature-merge"
mkdir -p "$repo" && cd "$repo"
git init -q
commit "root"
commit "main work"
git checkout -qb feature/login
commit "add login form"
commit "wire up auth"
git checkout -q main 2>/dev/null || git checkout -q master
git merge --no-ff -q feature/login -m "merge feature/login"
git branch -D feature/login -q 2>/dev/null || git branch -D feature/login
commit "main work after merge"

# 3. active-branches: a still-existing feature branch with no upstream and not
# merged anywhere -> triggers the "!" warning icon. Also useful for multiselect.
echo "Creating active-branches"
repo="$REPOS_DIR/active-branches"
mkdir -p "$repo" && cd "$repo"
git init -q
commit "root"
commit "main c2"
git checkout -qb develop
commit "develop c1"
commit "develop c2"
git checkout -q main 2>/dev/null || git checkout -q master
git checkout -qb feature/unfinished-work
commit "wip: unfinished work"
git checkout -q main 2>/dev/null || git checkout -q master
commit "main c3"

# 4. remote-tracking: a bare "origin" plus a clone, with one branch up to date,
# one branch ahead of its remote, and one local-only branch with no remote at all.
echo "Creating remote-tracking"
bare="$REPOS_DIR/remote-tracking.git"
repo="$REPOS_DIR/remote-tracking"
git init -q --bare "$bare"
git clone -q "$bare" "$repo"
cd "$repo"
commit "root"
git push -q origin main 2>/dev/null || git push -q origin master
git checkout -qb up-to-date-branch
commit "up to date branch work"
git push -q -u origin up-to-date-branch
git checkout -qb ahead-branch
commit "ahead branch work"
git push -q -u origin ahead-branch
commit "one more commit not pushed yet"
git checkout -qb local-only-branch
commit "never pushed anywhere"
git checkout -q main 2>/dev/null || git checkout -q master

# 5. long-names: branches with long, realistic names to test label truncation
# and the gitRail.maxBranchLabelWidth setting.
echo "Creating long-names"
repo="$REPOS_DIR/long-names"
mkdir -p "$repo" && cd "$repo"
git init -q
commit "root"
git checkout -qb feature/JIRA-12345-implement-really-long-descriptive-branch-name
commit "work on the long named feature"
git checkout -q main 2>/dev/null || git checkout -q master
git checkout -qb release/2024.12.01-final-release-candidate-branch
commit "prep release"
git checkout -q main 2>/dev/null || git checkout -q master
commit "main work"

# 6. parallel-deleted: two unrelated feature branches that were both alive (and
# both later deleted) during overlapping time windows, both merged into main.
# Good for testing that clicking near one deleted chain in the shared "history"
# lane doesn't also highlight the other, unrelated one.
echo "Creating parallel-deleted"
repo="$REPOS_DIR/parallel-deleted"
mkdir -p "$repo" && cd "$repo"
git init -q
commit "root"
git checkout -qb feature/a
commit "feature a work 1" feature-a.txt
git checkout -q main 2>/dev/null || git checkout -q master
git checkout -qb feature/b
commit "feature b work 1" feature-b.txt
git checkout -q feature/a
commit "feature a work 2" feature-a.txt
git checkout -q feature/b
commit "feature b work 2" feature-b.txt
git checkout -q main 2>/dev/null || git checkout -q master
git merge --no-ff -q feature/a -m "merge feature/a"
git merge --no-ff -q feature/b -m "merge feature/b"
git branch -D feature/a -q 2>/dev/null || git branch -D feature/a
git branch -D feature/b -q 2>/dev/null || git branch -D feature/b
commit "main work after both merges"

# 7. cherry-pick-detection: a feature branch with two commits, each cherry-picked onto
# main a different way — one with `-x` (leaves a "(cherry picked from commit ...)"
# trailer in the message) and one without (only detectable by matching patch-id).
echo "Creating cherry-pick-detection"
repo="$REPOS_DIR/cherry-pick-detection"
mkdir -p "$repo" && cd "$repo"
git init -q
commit "root"
git checkout -qb feature/cherries
commit "add feature x" feature.txt
commit "add feature y" feature.txt
git checkout -q main 2>/dev/null || git checkout -q master
git cherry-pick -x feature/cherries~1 >/dev/null
git cherry-pick feature/cherries >/dev/null

echo ""
echo "Done. Test repos created in $REPOS_DIR:"
ls "$REPOS_DIR"
