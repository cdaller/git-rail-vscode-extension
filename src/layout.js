'use strict';

function buildLayout(repository, options = {}) {
  const { hideEmptyBranches = true } = options;
  const { branches, commits, ownerByHash, branchesByHash = new Map() } = repository;
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
    const branchesForCommit = (branchesByHash.get(commit.hash) || [lane]).filter((name) => known.has(name));
    return { ...commit, row, lane, laneIndex: laneIndex.get(lane), branches: branchesForCommit.length ? branchesForCommit : [lane] };
  });

  const rowByHash = new Map(rows.map((row) => [row.hash, row]));

  // The shared 'history' lane can hold several deleted branches that were alive at the same
  // time. Each maximal first-parent run of history commits becomes a chain, and chains whose
  // row ranges overlap get distinct sub-tracks, so they are drawn side by side inside the one
  // lane instead of on top of each other.
  const historyChains = [];
  const historyRows = rows.filter((row) => row.lane === 'history');
  // Rows come from `git log --date-order` (children before parents), so the first unassigned
  // row reached is always the tip of a new chain.
  historyRows.forEach((tip) => {
    if (tip.historyChain !== undefined) return;
    const chain = { id: historyChains.length, topRow: tip.row, bottomRow: tip.row, subLane: 0 };
    let cur = tip;
    while (cur && cur.lane === 'history' && cur.historyChain === undefined) {
      cur.historyChain = chain.id;
      chain.bottomRow = cur.row;
      cur = rowByHash.get(cur.parents[0]);
    }
    historyChains.push(chain);
  });
  const subLaneBottoms = [];
  historyChains.forEach((chain) => {
    let slot = subLaneBottoms.findIndex((bottom) => bottom < chain.topRow);
    if (slot === -1) slot = subLaneBottoms.length;
    subLaneBottoms[slot] = chain.bottomRow;
    chain.subLane = slot;
  });
  historyRows.forEach((row) => { row.subLane = historyChains[row.historyChain].subLane; });

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

  // A commit shared by several branches is usually just one point in a long run of shared
  // ancestry (everything before the earliest divergence is trivially shared by all of them).
  // Marking every one of those would be noise, so only the topmost (newest) commit of a
  // shared run — where a child's own branch set narrows or the run starts — is flagged.
  const childrenByParentHash = new Map();
  edges.forEach((edge) => {
    if (!childrenByParentHash.has(edge.parentHash)) childrenByParentHash.set(edge.parentHash, []);
    childrenByParentHash.get(edge.parentHash).push(edge.childHash);
  });
  const sameBranchSet = (a, b) => a.length === b.length && new Set(a).size === new Set([...a, ...b]).size;
  rows.forEach((row) => {
    if (row.branches.length <= 1) { row.sharedBoundary = false; return; }
    const children = (childrenByParentHash.get(row.hash) || []).map((hash) => rowByHash.get(hash)).filter(Boolean);
    row.sharedBoundary = children.every((child) => !sameBranchSet(child.branches, row.branches));
  });

  return { lanes, rows, edges, historyChains, historySubLanes: subLaneBottoms.length };
}

module.exports = { buildLayout };
