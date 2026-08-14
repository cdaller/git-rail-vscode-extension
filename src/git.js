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

  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ref, name, tip, head] = line.split('\0');
      return { ref, name, tip, current: head === '*' };
    })
    .filter((b) => !b.ref.endsWith('/HEAD'))
    .sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
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

async function loadRepository(cwd, options = {}) {
  const maxCommits = options.maxCommits || 300;
  const includeRemoteBranches = Boolean(options.includeRemoteBranches);
  const includeLocalBranches = options.includeLocalBranches !== false;

  const [branches, commits] = await Promise.all([
    readBranches(cwd, includeRemoteBranches, includeLocalBranches),
    readCommits(cwd, maxCommits)
  ]);

  const ownerByHash = await readFirstParentDistances(
    cwd,
    branches,
    commits.map((c) => c.hash)
  );

  return { branches, commits, ownerByHash };
}

module.exports = {
  runGit,
  isGitRepository,
  readBranches,
  readCommits,
  readCommitFiles,
  readFirstParentDistances,
  loadRepository
};
