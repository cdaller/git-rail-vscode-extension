'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

async function runGit(cwd, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    encoding: 'utf8'
  });
  return stdout;
}

async function isGitRepository(cwd) {
  try {
    const out = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

async function readBranches(cwd, includeRemoteBranches, includeLocalBranches = true) {
  const refs = [];
  if (includeLocalBranches) refs.push('refs/heads');
  if (includeRemoteBranches) refs.push('refs/remotes');
  if (!refs.length) return [];

  const format = '%(refname)%00%(refname:short)%00%(objectname)%00%(HEAD)';
  const out = await runGit(cwd, ['for-each-ref', `--format=${format}`, ...refs]);

  const all = out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, name, tip, head] = line.split('\0');
      return { ref, name, tip, current: head === '*' };
    })
    .filter((b) => !b.ref.endsWith('/HEAD'));

  // A remote-tracking branch that mirrors an existing local branch (e.g. "origin/main" next
  // to "main") would otherwise show up as a second, redundant lane for the same branch.
  const localNames = new Set(all.filter((b) => b.ref.startsWith('refs/heads/')).map((b) => b.name));

  // Local branches are flagged with a "has a remote" indicator (and the remote's full name)
  // even when remote lanes themselves aren't shown, so this is checked independently of
  // includeRemoteBranches.
  let remoteRefs;
  if (includeRemoteBranches) {
    remoteRefs = all.filter((b) => b.ref.startsWith('refs/remotes/'));
  } else {
    const remoteOut = await runGit(cwd, ['for-each-ref', '--format=%(refname)%00%(refname:short)', 'refs/remotes']);
    remoteRefs = remoteOut
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref, name] = line.split('\0');
        return { ref, name };
      })
      .filter((b) => !b.ref.endsWith('/HEAD'));
  }
  const remoteNameByBranch = new Map(remoteRefs.map((b) => [b.name.split('/').slice(1).join('/'), b.name]));

  const deduped = all
    .filter((b) => {
      if (!b.ref.startsWith('refs/remotes/')) return true;
      return !localNames.has(b.name.split('/').slice(1).join('/'));
    })
    .map((b) => (b.ref.startsWith('refs/heads/')
      ? { ...b, hasRemote: remoteNameByBranch.has(b.name), remoteName: remoteNameByBranch.get(b.name) }
      : b));

  return deduped.sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
}

async function readCommits(cwd, maxCommits) {
  // ASCII record/unit separators make commit messages safe to parse without JSON escaping tricks.
  const pretty = '%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1e';
  const out = await runGit(cwd, [
    'log', '--all', '--date-order', `--max-count=${maxCommits}`,
    `--pretty=format:${pretty}`
  ]);

  return out
    .split('\x1e')
    .map((record) => record.replace(/^\n+|\n+$/g, ''))
    .filter(Boolean)
    .map((record) => {
      const [hash, parentText, author, email, timestamp, subject] = record.split('\x1f');
      return {
        hash,
        shortHash: hash.slice(0, 8),
        parents: parentText ? parentText.split(' ').filter(Boolean) : [],
        author,
        email,
        timestamp: Number(timestamp) * 1000,
        subject: subject || '(no subject)'
      };
    });
}

async function readCommitFiles(cwd, hash) {
  const out = await runGit(cwd, ['diff-tree', '--no-commit-id', '--name-status', '-r', hash]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...pathParts] = line.split('\t');
      // Renames/copies report two paths (old\tnew); the rest report just one.
      const oldPath = pathParts.length > 1 ? pathParts[0] : undefined;
      const path = pathParts.length > 1 ? pathParts[1] : pathParts[0];
      return { status, path, oldPath };
    });
}

async function readFirstParentDistances(cwd, branches, visibleHashes) {
  const visible = new Set(visibleHashes);
  const candidates = new Map();

  await Promise.all(branches.map(async (branch, branchIndex) => {
    try {
      const out = await runGit(cwd, ['rev-list', '--first-parent', branch.ref]);
      let distance = 0;
      for (const hash of out.split('\n')) {
        if (!hash) continue;
        if (visible.has(hash)) {
          const previous = candidates.get(hash);
          const score = [distance, branchIndex];
          if (!previous || score[0] < previous.score[0] ||
              (score[0] === previous.score[0] && score[1] < previous.score[1])) {
            candidates.set(hash, { branch: branch.name, score });
          }
        }
        distance += 1;
      }
    } catch {
      // A ref can disappear during refresh; the next refresh will reconcile it.
    }
  }));

  return new Map([...candidates].map(([hash, value]) => [hash, value.branch]));
}

async function readBranchWarnings(cwd, localBranches) {
  const warnings = new Map();
  await Promise.all(localBranches.map(async (branch) => {
    const format = '%(upstream)%00%(upstream:track)';
    let upstream = '';
    let track = '';
    try {
      const out = await runGit(cwd, ['for-each-ref', `--format=${format}`, branch.ref]);
      [upstream, track] = out.trim().split('\0');
    } catch {
      // Ref can disappear during refresh; treat as not pushed.
    }
    const aheadMatch = /ahead (\d+)/.exec(track || '');
    const ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
    const notPushed = !upstream;

    let unmerged = true;
    try {
      const containsOut = await runGit(cwd, [
        'for-each-ref', '--format=%(refname:short)', '--contains', branch.tip,
        'refs/heads', 'refs/remotes'
      ]);
      const containedIn = containsOut
        .split('\n')
        .filter(Boolean)
        .filter((refName) => refName !== branch.name && refName.split('/').slice(1).join('/') !== branch.name);
      unmerged = containedIn.length === 0;
    } catch {
      // A ref can disappear during refresh; assume unmerged so the warning stays visible.
    }

    warnings.set(branch.name, { unmerged, notPushed, ahead, warn: unmerged || notPushed });
  }));
  return warnings;
}

async function loadRepository(cwd, options = {}) {
  const maxCommits = options.maxCommits || 300;
  const includeRemoteBranches = Boolean(options.includeRemoteBranches);
  const includeLocalBranches = options.includeLocalBranches !== false;

  const [branches, commits] = await Promise.all([
    readBranches(cwd, includeRemoteBranches, includeLocalBranches),
    readCommits(cwd, maxCommits)
  ]);

  const [ownerByHash, branchWarnings] = await Promise.all([
    readFirstParentDistances(cwd, branches, commits.map((c) => c.hash)),
    readBranchWarnings(cwd, branches.filter((b) => b.ref.startsWith('refs/heads/')))
  ]);

  const branchesWithWarnings = branches.map((b) => ({ ...b, ...branchWarnings.get(b.name) }));

  return { branches: branchesWithWarnings, commits, ownerByHash };
}

module.exports = {
  runGit,
  isGitRepository,
  readBranches,
  readCommits,
  readCommitFiles,
  readBranchWarnings,
  readFirstParentDistances,
  loadRepository
};
