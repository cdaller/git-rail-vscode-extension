'use strict';

function buildLayout(repository, options = {}) {
  const { hideEmptyBranches = true } = options;
  const { branches, commits, ownerByHash } = repository;
  let branchNames = branches.map((b) => b.name);

  if (hideEmptyBranches) {
    const ownedBranches = new Set(commits.map((c) => ownerByHash.get(c.hash)));
    branchNames = branchNames.filter((name) => ownedBranches.has(name));
  }

  const known = new Set(branchNames);

  // A synthetic lane keeps history readable when a commit is not on the first-parent
  // chain of any currently existing branch (common after deleting a feature branch).
  const needsHistory = commits.some((c) => !ownerByHash.get(c.hash));
  const lanes = needsHistory ? [...branchNames, 'history'] : branchNames;
  const laneIndex = new Map(lanes.map((name, i) => [name, i]));

  const rows = commits.map((commit, row) => {
    const owner = ownerByHash.get(commit.hash);
    const lane = known.has(owner) ? owner : 'history';
    return { ...commit, row, lane, laneIndex: laneIndex.get(lane) };
  });

  const rowByHash = new Map(rows.map((row) => [row.hash, row]));
  const edges = [];

  for (const child of rows) {
    child.parents.forEach((parentHash, parentNumber) => {
      const parent = rowByHash.get(parentHash);
      if (!parent) return;
      edges.push({
        childHash: child.hash,
        parentHash,
        fromLane: child.laneIndex,
        toLane: parent.laneIndex,
        fromRow: child.row,
        toRow: parent.row,
        mergeParent: parentNumber > 0
      });
    });
  }

  return { lanes, rows, edges };
}

module.exports = { buildLayout };
