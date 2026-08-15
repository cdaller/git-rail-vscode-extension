'use strict';

const { execFile, spawn } = require('node:child_process');
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

// Computes a patch-id for every commit in one pass by piping `git log -p` straight into
// `git patch-id`, instead of shelling out per commit (which would be O(commits) git calls).
async function runGitPatchIds(cwd, args) {
  return new Promise((resolve, reject) => {
    const log = spawn('git', args, { cwd, windowsHide: true });
    const patchId = spawn('git', ['patch-id', '--stable'], { cwd, windowsHide: true });

    let out = '';
    let err = '';
    patchId.stdout.setEncoding('utf8');
    patchId.stdout.on('data', (chunk) => { out += chunk; });
    patchId.stderr.setEncoding('utf8');
    patchId.stderr.on('data', (chunk) => { err += chunk; });

    let logErr = '';
    log.stderr.setEncoding('utf8');
    log.stderr.on('data', (chunk) => { logErr += chunk; });

    let settled = false;
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };
    // Once either side of the pipe exits, writes to the other can fail with EPIPE; an
    // unhandled 'error' on a stream would otherwise crash the whole extension host.
    log.stdout.on('error', () => {});
    patchId.stdin.on('error', () => {});
    log.stdout.pipe(patchId.stdin);
    log.on('error', fail);
    patchId.on('error', fail);
    patchId.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) return reject(new Error(err || logErr || `git patch-id exited with code ${code}`));
      resolve(out);
    });
  });
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

const CHERRY_PICK_RE = /cherry picked from commit ([0-9a-f]{7,40})/i;

async function readCommits(cwd, maxCommits) {
  // ASCII record/unit separators make commit messages safe to parse without JSON escaping tricks.
  const pretty = '%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b%x1e';
  const out = await runGit(cwd, [
    'log', '--all', '--date-order', `--max-count=${maxCommits}`,
    `--pretty=format:${pretty}`
  ]);

  return out
    .split('\x1e')
    .map((record) => record.replace(/^\n+|\n+$/g, ''))
    .filter(Boolean)
    .map((record) => {
      const [hash, parentText, author, email, timestamp, subject, body] = record.split('\x1f');
      const cherryPickMatch = CHERRY_PICK_RE.exec(body || '');
      return {
        hash,
        shortHash: hash.slice(0, 8),
        parents: parentText ? parentText.split(' ').filter(Boolean) : [],
        author,
        email,
        timestamp: Number(timestamp) * 1000,
        subject: subject || '(no subject)',
        cherryPickedFrom: cherryPickMatch ? cherryPickMatch[1] : undefined
      };
    });
}

async function readPatchIds(cwd, maxCommits) {
  const out = await runGitPatchIds(cwd, [
    'log', '--all', '--date-order', `--max-count=${maxCommits}`, '-p', '--no-color'
  ]);

  const patchIdByHash = new Map();
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [patchId, hash] = line.split(' ');
    if (patchId && hash) patchIdByHash.set(hash, patchId);
  }
  return patchIdByHash;
}

// Commits sharing a patch-id carry the same change, which is what a content-preserving
// cherry-pick (with no "(cherry picked from ...)" trailer) looks like; the oldest commit in
// each group is treated as the original and every later one is flagged as derived from it.
function findCherryPicksByPatchId(commits, patchIdByHash) {
  const groups = new Map();
  for (const commit of commits) {
    const patchId = patchIdByHash.get(commit.hash);
    if (!patchId) continue;
    if (!groups.has(patchId)) groups.set(patchId, []);
    groups.get(patchId).push(commit);
  }

  const sourceHashByHash = new Map();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [original, ...rest] = [...group].sort((a, b) => a.timestamp - b.timestamp);
    for (const commit of rest) sourceHashByHash.set(commit.hash, original.hash);
  }
  return sourceHashByHash;
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
  // Every branch whose first-parent chain reaches a commit, not just the winning "owner" —
  // lets the UI point out when a commit is genuinely the shared base of several branches.
  const branchesByHash = new Map();

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
          if (!branchesByHash.has(hash)) branchesByHash.set(hash, new Set());
          branchesByHash.get(hash).add(branch.name);
        }
        distance += 1;
      }
    } catch {
      // A ref can disappear during refresh; the next refresh will reconcile it.
    }
  }));

  // A commit shared with main/master is usually just main/master's own history that a
  // shorter-lived branch happens to sit closer to — prefer main/master as the owner over
  // the plain "closest tip" heuristic so the commit renders on the long-lived branch.
  for (const [hash, names] of branchesByHash) {
    if (names.has('main')) candidates.set(hash, { branch: 'main', score: [-1, -1] });
    else if (names.has('master')) candidates.set(hash, { branch: 'master', score: [-1, -1] });
  }

  return {
    ownerByHash: new Map([...candidates].map(([hash, value]) => [hash, value.branch])),
    branchesByHash: new Map([...branchesByHash].map(([hash, names]) => [hash, [...names]]))
  };
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
    const behindMatch = /behind (\d+)/.exec(track || '');
    const behind = behindMatch ? Number(behindMatch[1]) : 0;
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

    warnings.set(branch.name, { unmerged, notPushed, ahead, behind, warn: unmerged || notPushed });
  }));
  return warnings;
}

async function loadRepository(cwd, options = {}) {
  const maxCommits = options.maxCommits || 300;
  const includeRemoteBranches = Boolean(options.includeRemoteBranches);
  const includeLocalBranches = options.includeLocalBranches !== false;

  const [branches, commits, patchIdByHash] = await Promise.all([
    readBranches(cwd, includeRemoteBranches, includeLocalBranches),
    readCommits(cwd, maxCommits),
    // Patch-id-based cherry-pick detection is supplementary; if it fails for any reason
    // (unusual git version, huge diffs, etc.) the rest of the view should still load.
    readPatchIds(cwd, maxCommits).catch(() => new Map())
  ]);

  const [{ ownerByHash, branchesByHash }, branchWarnings] = await Promise.all([
    readFirstParentDistances(cwd, branches, commits.map((c) => c.hash)),
    readBranchWarnings(cwd, branches.filter((b) => b.ref.startsWith('refs/heads/')))
  ]);

  const branchesWithWarnings = branches.map((b) => ({ ...b, ...branchWarnings.get(b.name) }));

  const cherryPickSourceByHash = findCherryPicksByPatchId(commits, patchIdByHash);

  // The reverse relation, so the original commit can also show "this was cherry-picked
  // to <hash>" rather than only the copy showing where it came from.
  const cherryPickedToByHash = new Map();
  const addCherryPickedTo = (sourceHash, targetHash) => {
    if (!cherryPickedToByHash.has(sourceHash)) cherryPickedToByHash.set(sourceHash, new Set());
    cherryPickedToByHash.get(sourceHash).add(targetHash);
  };
  for (const c of commits) {
    if (c.cherryPickedFrom) addCherryPickedTo(c.cherryPickedFrom, c.hash);
  }
  for (const [hash, sourceHash] of cherryPickSourceByHash) {
    addCherryPickedTo(sourceHash, hash);
  }

  const commitsWithCherryPicks = commits.map((c) => ({
    ...c,
    patchId: patchIdByHash.get(c.hash),
    cherryPickSourceHash: cherryPickSourceByHash.get(c.hash),
    cherryPickedTo: cherryPickedToByHash.has(c.hash) ? [...cherryPickedToByHash.get(c.hash)] : undefined
  }));

  return { branches: branchesWithWarnings, commits: commitsWithCherryPicks, ownerByHash, branchesByHash };
}

module.exports = {
  runGit,
  isGitRepository,
  readBranches,
  readCommits,
  readPatchIds,
  findCherryPicksByPatchId,
  readCommitFiles,
  readBranchWarnings,
  readFirstParentDistances,
  loadRepository
};
