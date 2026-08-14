'use strict';

const path = require('node:path');
const vscode = require('vscode');
const { isGitRepository, loadRepository, readCommitFiles } = require('./git');
const { buildLayout } = require('./layout');

let currentPanel;

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('gitRail.open', () => openGitRail(context)),
    vscode.commands.registerCommand('gitRail.refresh', () => refreshPanel())
  );
}

async function chooseRepositoryFolder() {
  const folders = vscode.workspace.workspaceFolders || [];
  const gitFolders = [];

  for (const folder of folders) {
    if (await isGitRepository(folder.uri.fsPath)) {
      gitFolders.push(folder);
    }
  }

  if (gitFolders.length === 1) return gitFolders[0];
  if (gitFolders.length > 1) {
    const picked = await vscode.window.showQuickPick(
      gitFolders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
      { placeHolder: 'Select the Git repository to visualize' }
    );
    return picked?.folder;
  }

  vscode.window.showWarningMessage('Git Rail: no local Git repository found in this workspace.');
  return undefined;
}

async function openGitRail(context) {
  const folder = await chooseRepositoryFolder();
  if (!folder) return;

  if (currentPanel) currentPanel.dispose();

  const panel = vscode.window.createWebviewPanel(
    'gitRail.branchMap',
    `Git Rail — ${folder.name}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')]
    }
  );

  currentPanel = { panel, folder, context };
  panel.onDidDispose(() => {
    if (currentPanel?.panel === panel) currentPanel = undefined;
  });

  panel.webview.onDidReceiveMessage(async (message) => {
    if (message?.type === 'refresh') await refreshPanel();
    if (message?.type === 'loadMore') {
      currentPanel.maxCommits = (currentPanel.maxCommits || 300) + (currentPanel.loadMoreStep || 300);
      await refreshPanel();
    }
    if (message?.type === 'copyHash' && message.hash) {
      await vscode.env.clipboard.writeText(message.hash);
      vscode.window.setStatusBarMessage(`Git Rail: copied ${message.hash.slice(0, 8)}`, 1800);
    }
    if (message?.type === 'commitFiles' && message.hash) {
      try {
        const files = await readCommitFiles(folder.uri.fsPath, message.hash);
        panel.webview.postMessage({ type: 'commitFiles', hash: message.hash, files });
      } catch (error) {
        panel.webview.postMessage({ type: 'commitFiles', hash: message.hash, files: [], error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (message?.type === 'openDiff' && message.hash && message.filePath) {
      await openFileDiff(folder, message.hash, message.filePath, message.status);
    }
  });

  panel.webview.html = loadingHtml();
  await refreshPanel();
}

async function refreshPanel() {
  if (!currentPanel) return;
  const { panel, folder, context } = currentPanel;

  try {
    const config = vscode.workspace.getConfiguration('gitRail', folder.uri);
    const defaultMaxCommits = config.get('maxCommits', 300);
    const maxCommits = currentPanel.maxCommits || defaultMaxCommits;
    const repository = await loadRepository(folder.uri.fsPath, {
      maxCommits,
      includeRemoteBranches: config.get('includeRemoteBranches', false),
      includeLocalBranches: config.get('includeLocalBranches', true)
    });
    currentPanel.maxCommits = maxCommits;
    currentPanel.loadMoreStep = defaultMaxCommits;
    const hasMore = repository.commits.length >= maxCommits;
    const layout = buildLayout(repository, {
      hideEmptyBranches: config.get('hideEmptyBranches', true)
    });
    const maxBranchLabelWidth = config.get('maxBranchLabelWidth', 130);
    const codiconCssUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
    );
    panel.webview.html = renderHtml(folder.name, layout, repository.branches, hasMore, maxBranchLabelWidth, codiconCssUri);
  } catch (error) {
    panel.webview.html = errorHtml(error instanceof Error ? error.message : String(error));
  }
}

function toGitUri(fsPath, ref) {
  return vscode.Uri.file(fsPath).with({
    scheme: 'git',
    query: JSON.stringify({ path: fsPath, ref })
  });
}

async function openFileDiff(folder, hash, filePath, status) {
  const fsPath = path.join(folder.uri.fsPath, filePath);
  const short = hash.slice(0, 8);
  const fileName = path.basename(filePath);

  if (status === 'A') {
    await vscode.commands.executeCommand('vscode.open', toGitUri(fsPath, hash), {}, `${fileName} (${short})`);
    return;
  }
  if (status === 'D') {
    await vscode.commands.executeCommand('vscode.open', toGitUri(fsPath, `${hash}^`), {}, `${fileName} (${short}^)`);
    return;
  }
  await vscode.commands.executeCommand(
    'vscode.diff',
    toGitUri(fsPath, `${hash}^`),
    toGitUri(fsPath, hash),
    `${fileName} (${short}^ ↔ ${short})`
  );
}

function loadingHtml() {
  return `<!doctype html><html><body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px">Loading Git history…</body></html>`;
}

function errorHtml(message) {
  return `<!doctype html><html><body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px"><h2>Git Rail</h2><p>Could not load repository.</p><pre>${escapeHtml(message)}</pre></body></html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderHtml(repoName, layout, branches, hasMore, maxBranchLabelWidth, codiconCssUri) {
  const data = JSON.stringify({ ...layout, branches, hasMore: Boolean(hasMore), maxBranchLabelWidth: maxBranchLabelWidth || 130 }).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<link rel="stylesheet" href="${codiconCssUri}">
<style>
  :root { --row-h: 38px; --lane-w: 60px; --header-h: 110px; }
  * { box-sizing: border-box; }
  body { margin:0; color:var(--vscode-foreground); background:var(--vscode-editor-background); font-family:var(--vscode-font-family); }
  .toolbar { position:sticky; top:0; z-index:10; display:flex; align-items:center; gap:10px; padding:9px 12px; border-bottom:1px solid var(--vscode-panel-border); background:var(--vscode-editor-background); }
  .toolbar strong { margin-right:auto; }
  button { color:var(--vscode-button-foreground); background:var(--vscode-button-background); border:0; padding:5px 10px; cursor:pointer; }
  button:hover { background:var(--vscode-button-hoverBackground); }
  .hint { color:var(--vscode-descriptionForeground); font-size:12px; }
  .viewport { overflow:auto; height:calc(100vh - 43px); }
  .canvas { position:relative; min-width:max-content; }
  .laneHeader { position:sticky; top:0; z-index:8; height:var(--header-h); border-bottom:1px solid var(--vscode-panel-border); background:var(--vscode-editor-background); }
  .laneTitle { position:absolute; bottom:10px; max-width:var(--lane-title-max-w, 130px); padding:3px 7px; border-radius:5px; cursor:pointer; overflow:hidden; background:var(--vscode-badge-background); color:var(--vscode-badge-foreground); font-size:11px; transform-origin:left bottom; transform:rotate(-35deg); display:flex; align-items:center; gap:3px; }
  .laneTitle.current { outline:2px solid var(--vscode-focusBorder); font-weight:700; background:var(--vscode-statusBarItem-prominentBackground, var(--vscode-badge-background)); }
  .laneTitle.history { opacity:.65; font-style:italic; }
  .laneTitle .warnIcon, .laneTitle .currentMark, .laneTitle .remoteIcon, .laneTitle .aheadIcon { flex:0 0 auto; }
  .laneTitle .warnIcon { color:var(--vscode-editorWarning-foreground, #cca700); font-weight:800; }
  .laneTitle .aheadIcon { color:inherit; font-weight:700; white-space:nowrap; }
  .laneTitle .remoteIcon { color:inherit; font-size:12px; }
  .laneTitle .labelText { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .branchPopover { position:fixed; z-index:20; padding:5px 9px; border-radius:5px; background:var(--vscode-editorHoverWidget-background, var(--vscode-editor-background)); color:var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground)); border:1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border)); font-size:12px; box-shadow:0 2px 8px rgba(0,0,0,.3); pointer-events:none; white-space:nowrap; display:none; }
  .commitPopover, .edgePopover { position:fixed; z-index:20; max-width:360px; padding:7px 10px; border-radius:5px; background:var(--vscode-editorHoverWidget-background, var(--vscode-editor-background)); color:var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground)); border:1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border)); font-size:12px; box-shadow:0 2px 8px rgba(0,0,0,.3); pointer-events:none; display:none; }
  .commitPopover .hash, .edgePopover .hash { font-family:var(--vscode-editor-font-family); color:var(--vscode-textLink-foreground); }
  .commitPopover .subject, .edgePopover .subject { display:block; margin:4px 0; color:var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground)); white-space:normal; word-break:break-word; }
  .commitPopover .meta, .edgePopover .meta { color:var(--vscode-descriptionForeground); }
  .edgePopover .row { margin:2px 0; }
  .edgePopover .lane { color:var(--vscode-textLink-foreground); }
  .commitDetailsPanel { position:fixed; z-index:25; display:none; flex-direction:column; width:420px; height:280px; min-width:260px; min-height:120px; max-width:90vw; max-height:70vh; overflow:hidden; resize:both; padding:9px 12px; border-radius:6px; background:var(--vscode-editorHoverWidget-background, var(--vscode-editor-background)); color:var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground)); border:1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border)); font-size:12px; box-shadow:0 4px 16px rgba(0,0,0,.4); }
  .commitDetailsPanel .closeBtn { position:absolute; top:6px; right:8px; font-size:16px; line-height:1; color:var(--vscode-descriptionForeground); cursor:pointer; }
  .commitDetailsPanel .closeBtn:hover { color:var(--vscode-foreground); }
  .commitDetailsPanel .detailsHeader { flex:0 0 auto; padding-right:20px; }
  .commitDetailsPanel .detailsBody { flex:1 1 auto; overflow:auto; }
  .commitDetailsPanel .hash { font-family:var(--vscode-editor-font-family); color:var(--vscode-textLink-foreground); }
  .commitDetailsPanel .subject { display:block; margin:4px 0; font-weight:600; white-space:normal; word-break:break-word; }
  .commitDetailsPanel .meta { color:var(--vscode-descriptionForeground); display:block; margin-bottom:8px; }
  .commitDetailsPanel .fileList { border-top:1px solid var(--vscode-panel-border); padding-top:6px; }
  .commitDetailsPanel .file { display:flex; align-items:baseline; gap:6px; padding:2px 0; cursor:pointer; overflow:hidden; }
  .commitDetailsPanel .file:hover .fileName { text-decoration:underline; }
  .commitDetailsPanel .status { width:14px; flex:0 0 auto; font-weight:700; font-family:var(--vscode-editor-font-family); }
  .commitDetailsPanel .status.A { color:var(--vscode-gitDecoration-addedResourceForeground, green); }
  .commitDetailsPanel .status.M { color:var(--vscode-gitDecoration-modifiedResourceForeground, orange); }
  .commitDetailsPanel .status.D { color:var(--vscode-gitDecoration-deletedResourceForeground, red); }
  .commitDetailsPanel .fileName { flex:0 0 auto; white-space:nowrap; }
  .commitDetailsPanel .filePath { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--vscode-descriptionForeground); font-size:11px; }
  .details .subject, .details .meta { cursor:pointer; pointer-events:auto; }
  .searchBar { position:absolute; top:50%; transform:translateY(-50%); display:flex; flex-direction:column; align-items:stretch; gap:6px; }
  .compactToggles { display:flex; align-items:center; gap:10px; }
  .search { flex:1 1 auto; box-sizing:border-box; padding:6px 10px; border:1px solid var(--vscode-panel-border); border-radius:4px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); font-family:inherit; font-size:13px; }
  .search:focus { outline:1px solid var(--vscode-focusBorder); }
  .compactToggle { display:flex; align-items:center; gap:5px; font-size:12px; color:var(--vscode-descriptionForeground); white-space:nowrap; cursor:pointer; }
  svg { position:absolute; left:0; top:var(--header-h); overflow:visible; pointer-events:none; }
  .rail { stroke:var(--vscode-editorIndentGuide-background); stroke-width:2; pointer-events:stroke; cursor:pointer; }
  .traceDim { opacity:.15 !important; }
  .traceSpine { stroke:var(--vscode-textLink-foreground) !important; stroke-width:3 !important; opacity:1 !important; }
  .traceMerged { stroke:var(--vscode-gitDecoration-addedResourceForeground, #2ea043) !important; stroke-width:3 !important; opacity:1 !important; }
  .node.traceSpine { background:var(--vscode-textLink-foreground); box-shadow:0 0 0 2px var(--vscode-textLink-foreground); }
  .node.traceMerged { background:var(--vscode-gitDecoration-addedResourceForeground, #2ea043); box-shadow:0 0 0 2px var(--vscode-gitDecoration-addedResourceForeground, #2ea043); }
  .node.traceBoundary { box-shadow:0 0 0 3px var(--vscode-editorWarning-foreground, #cca700); }
  .edge { fill:none; stroke:var(--vscode-editorIndentGuide-activeBackground); stroke-width:2; opacity:.55; pointer-events:stroke; cursor:pointer; }
  .edge.merge { stroke-dasharray:5 4; opacity:.9; }
  .commit { position:absolute; height:var(--row-h); display:flex; align-items:center; border-bottom:1px solid color-mix(in srgb, var(--vscode-panel-border) 45%, transparent); pointer-events:none; }
  .node { position:absolute; width:12px; height:12px; border-radius:50%; transform:translate(-6px,-6px); top:50%; background:var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-textLink-foreground)); border:2px solid var(--vscode-editor-background); box-shadow:0 0 0 1px var(--vscode-editorIndentGuide-activeBackground); pointer-events:auto; cursor:pointer; }
  .commit.mergeCommit .node { width:14px; height:14px; transform:translate(-7px,-7px) rotate(45deg); border-radius:2px; }
  .details { margin-left:28px; width:650px; display:flex; gap:9px; align-items:baseline; white-space:nowrap; overflow:hidden; }
  .hash { font-family:var(--vscode-editor-font-family); color:var(--vscode-textLink-foreground); cursor:pointer; pointer-events:auto; }
  .subject { overflow:hidden; text-overflow:ellipsis; }
  .meta { color:var(--vscode-descriptionForeground); font-size:12px; }
  .dim { opacity:.16 !important; }
  .focused { opacity:1 !important; }
  .empty { padding:30px; color:var(--vscode-descriptionForeground); }
  .loadMore { position:absolute; left:0; display:flex; align-items:center; justify-content:center; }
  .loadMore button:disabled { opacity:.6; cursor:default; }
</style>
</head>
<body>
<div class="toolbar"><strong>Git Rail — ${escapeHtml(repoName)}</strong><span class="hint">Click branch labels to select (multiple allowed, compact hides the rest) · click hash to copy</span><button id="clear">Clear focus</button><button id="refresh">Refresh</button></div>
<div class="viewport"><div id="canvas" class="canvas"></div></div>
<script>
const vscode = acquireVsCodeApi();
const model = ${data};
const rowH = 38, graphPadding = 36, detailsW = 700, loadMoreH = 44;
const canvas = document.getElementById('canvas');
const viewport = document.querySelector('.viewport');
const branchMap = new Map(model.branches.map(b => [b.name, b]));
document.documentElement.style.setProperty('--lane-title-max-w', model.maxBranchLabelWidth + 'px');
const selectedLanes = new Set();

const laneW = 60;
const labelAngle = 35 * Math.PI / 180;
const measureCtx = document.createElement('canvas').getContext('2d');
measureCtx.font = '11px ' + getComputedStyle(document.body).fontFamily;
const maxLabelWidth = model.lanes.reduce((max, lane) => {
  const naturalWidth = measureCtx.measureText(lane).width + 14; // matches .laneTitle's 3px+7px horizontal padding
  return Math.max(max, Math.min(naturalWidth, model.maxBranchLabelWidth));
}, 40);
const headerH = Math.max(70, Math.round(maxLabelWidth * Math.sin(labelAngle)) + 36);
document.documentElement.style.setProperty('--header-h', headerH + 'px');

const graphWidth = model.lanes.length * laneW + graphPadding * 2;
const width = Math.max(500, graphWidth + detailsW);
const bodyHeight = Math.max(rowH, model.rows.length * rowH);
const footerH = model.hasMore ? loadMoreH : 0;
canvas.style.width = width + 'px';
canvas.style.height = (headerH + bodyHeight + footerH) + 'px';

const header = document.createElement('div');
header.className = 'laneHeader';
header.style.width = width + 'px';
canvas.appendChild(header);

function laneX(index) { return graphPadding + index * laneW + laneW / 2; }
function rowY(index) { return index * rowH + rowH / 2; }

const branchPopover = document.createElement('div');
branchPopover.className = 'branchPopover';
document.body.appendChild(branchPopover);

const laneTitleEls = [];
model.lanes.forEach((lane, i) => {
  const branch = branchMap.get(lane);
  const isCurrent = Boolean(branch?.current);
  const hasRemote = Boolean(branch?.hasRemote);
  const ahead = Number(branch?.ahead) || 0;
  const warnReasons = [];
  if (branch?.unmerged) warnReasons.push('not merged into another branch');
  if (branch?.notPushed) warnReasons.push('no upstream branch');
  const warn = warnReasons.length > 0;

  const el = document.createElement('div');
  el.className = 'laneTitle' + (isCurrent ? ' current' : '') + (lane === 'history' ? ' history' : '') + (warn ? ' warn' : '');
  el.innerHTML = (warn ? '<span class="warnIcon">!</span>' : '') +
    (hasRemote ? '<span class="remoteIcon codicon codicon-remote"></span>' : '') +
    (ahead ? '<span class="aheadIcon">⇡' + ahead + '</span>' : '') +
    (isCurrent ? '<span class="currentMark">✓</span>' : '') +
    '<span class="labelText">' + escapeHtmlClient(lane) + '</span>';
  el.title = lane === 'history'
    ? 'Commits not assigned to the first-parent chain of a current branch'
    : [
        isCurrent ? 'currently checked out' : '',
        hasRemote ? 'remote: ' + branch.remoteName : '',
        ahead ? ahead + ' commit(s) ahead of remote' : '',
        warnReasons.join(' · ')
      ].filter(Boolean).join(' — ');
  el.style.left = laneX(i) + 'px';
  el.dataset.lane = lane;
  el.onclick = () => {
    if (selectedLanes.has(lane)) selectedLanes.delete(lane); else selectedLanes.add(lane);
    activeTrace = null;
    applyTrace();
    applyFocus();
    applyFilter();
    saveUiState();
  };
  el.onmouseenter = () => {
    branchPopover.textContent = lane === 'history'
      ? 'history'
      : [
          lane + (isCurrent ? ' (current)' : ''),
          hasRemote ? '→ ' + branch.remoteName : '',
          ahead ? '⇡' + ahead : '',
          warn ? '⚠ ' + warnReasons.join(', ') : ''
        ].filter(Boolean).join(' ');
    branchPopover.style.display = 'block';
    const rect = el.getBoundingClientRect();
    branchPopover.style.left = rect.left + 'px';
    branchPopover.style.top = (rect.bottom + 6) + 'px';
  };
  el.onmouseleave = () => { branchPopover.style.display = 'none'; };
  header.appendChild(el);
  laneTitleEls.push(el);
});

const searchBar = document.createElement('div');
searchBar.className = 'searchBar';
searchBar.style.left = (graphWidth + 8) + 'px';
searchBar.style.width = (detailsW - 16) + 'px';
header.appendChild(searchBar);

const search = document.createElement('input');
search.type = 'search';
search.className = 'search';
search.placeholder = 'Filter (words OR-combined, "quoted" = exact); or author:x message:x commit:x';
searchBar.appendChild(search);

const compactToggles = document.createElement('div');
compactToggles.className = 'compactToggles';
searchBar.appendChild(compactToggles);

function createCompactToggle(labelText, title) {
  const toggle = document.createElement('label');
  toggle.className = 'compactToggle';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  toggle.appendChild(checkbox);
  toggle.appendChild(document.createTextNode(labelText));
  toggle.title = title;
  compactToggles.appendChild(toggle);
  return checkbox;
}
const compactRowsCheckbox = createCompactToggle('Compact rows', 'Remove non-matching commit rows instead of just hiding them');
const compactBranchesCheckbox = createCompactToggle('Compact branches', 'Hide branch lanes with no visible commits instead of just leaving them empty');

const NS = 'http://www.w3.org/2000/svg';
const svg = document.createElementNS(NS, 'svg');
svg.setAttribute('width', graphWidth);
svg.setAttribute('height', bodyHeight);
canvas.appendChild(svg);

function edgePathD(x1, y1, x2, y2) {
  const dy = Math.max(14, Math.min(50, Math.abs(y2 - y1) * .3));
  return x1 === x2
    ? ('M ' + x1 + ' ' + y1 + ' L ' + x2 + ' ' + y2)
    : ('M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + (y1 + dy) + ', ' + x2 + ' ' + (y2 - dy) + ', ' + x2 + ' ' + y2);
}

const railEls = [];
model.lanes.forEach((lane, i) => {
  const line = document.createElementNS(NS, 'line');
  line.setAttribute('x1', laneX(i)); line.setAttribute('x2', laneX(i));
  line.setAttribute('y1', 0); line.setAttribute('y2', bodyHeight);
  line.setAttribute('class', 'rail'); line.dataset.lane = lane;
  line.onclick = (e) => {
    e.stopPropagation();
    const target = nearestRowInLane(i, e.clientY);
    if (target) toggleTrace(target);
  };
  svg.appendChild(line);
  railEls.push(line);
});

const rowByHash = new Map(model.rows.map(r => [r.hash, r]));

// Traces a branch's own history back to where it diverged from already-known history,
// even if the branch itself no longer exists (its commits just sit in the 'history' lane).
// A parent commit is a "boundary" once it belongs to a different, still-existing branch —
// i.e. shared ancestry this branch doesn't exclusively own. Anything else (same lane, or
// still unowned 'history') is treated as part of this branch's own story and expanded further.
function traceBranch(startRow) {
  const startLane = startRow.lane;
  const isBoundary = (r) => r.lane !== 'history' && r.lane !== startLane;

  const spineHashes = new Set([startRow.hash]);
  let cur = startRow;
  while (cur.parents[0]) {
    const p = rowByHash.get(cur.parents[0]);
    if (!p) break;
    spineHashes.add(p.hash);
    if (isBoundary(p)) break;
    cur = p;
  }

  const ancestryHashes = new Set([startRow.hash]);
  const boundaryHashes = new Set();
  const queue = [startRow];
  const visited = new Set([startRow.hash]);
  while (queue.length) {
    const row = queue.shift();
    for (const parentHash of row.parents) {
      if (visited.has(parentHash)) continue;
      visited.add(parentHash);
      const p = rowByHash.get(parentHash);
      if (!p) continue;
      ancestryHashes.add(p.hash);
      if (isBoundary(p)) { boundaryHashes.add(p.hash); continue; }
      queue.push(p);
    }
  }

  return { startHash: startRow.hash, spineHashes, ancestryHashes, boundaryHashes };
}

let activeTrace = null;
function applyTrace() {
  commitEls.forEach(({ el, row, node }) => {
    el.classList.remove('traceDim');
    node.classList.remove('traceSpine', 'traceMerged', 'traceBoundary');
    if (!activeTrace) return;
    if (!activeTrace.ancestryHashes.has(row.hash)) { el.classList.add('traceDim'); return; }
    if (activeTrace.boundaryHashes.has(row.hash)) node.classList.add('traceBoundary');
    else if (activeTrace.spineHashes.has(row.hash)) node.classList.add('traceSpine');
    else node.classList.add('traceMerged');
  });
  edgeEls.forEach(({ path, edge }) => {
    path.classList.remove('traceDim', 'traceSpine', 'traceMerged');
    if (!activeTrace) return;
    const bothTraced = activeTrace.ancestryHashes.has(edge.childHash) && activeTrace.ancestryHashes.has(edge.parentHash);
    if (!bothTraced) { path.classList.add('traceDim'); return; }
    const isSpine = !edge.mergeParent && activeTrace.spineHashes.has(edge.childHash) && activeTrace.spineHashes.has(edge.parentHash);
    path.classList.add(isSpine ? 'traceSpine' : 'traceMerged');
  });
}
function toggleTrace(row) {
  if (activeTrace && activeTrace.startHash === row.hash) {
    activeTrace = null;
  } else {
    selectedLanes.clear();
    applyFocus();
    activeTrace = traceBranch(row);
  }
  applyTrace();
  saveUiState();
}
function topRowOfLane(laneIndex) {
  return model.rows.reduce((best, r) => (r.laneIndex === laneIndex && (!best || r.row < best.row) ? r : best), null);
}
// The shared 'history' lane can hold several unrelated deleted-branch chains stacked in one
// column, so tracing always from the topmost commit would silently ignore the others. Using
// the commit nearest the actual click lets each chain be traced by clicking near it.
function nearestRowInLane(laneIndex, clientY) {
  let best = null, bestDist = Infinity;
  commitEls.forEach(({ el, row }) => {
    if (row.laneIndex !== laneIndex || el.style.display === 'none') return;
    const rect = el.getBoundingClientRect();
    const dist = Math.abs(rect.top + rect.height / 2 - clientY);
    if (dist < bestDist) { bestDist = dist; best = row; }
  });
  return best || topRowOfLane(laneIndex);
}

const edgePopover = document.createElement('div');
edgePopover.className = 'edgePopover';
document.body.appendChild(edgePopover);

const edgeEls = [];
model.edges.forEach(edge => {
  const x1 = laneX(edge.fromLane), y1 = rowY(edge.fromRow);
  const x2 = laneX(edge.toLane), y2 = rowY(edge.toRow);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', edgePathD(x1, y1, x2, y2));
  path.setAttribute('class', 'edge' + (edge.mergeParent ? ' merge' : ''));
  path.dataset.fromLane = model.lanes[edge.fromLane];
  path.dataset.toLane = model.lanes[edge.toLane];
  path.onclick = (e) => {
    e.stopPropagation();
    const child = rowByHash.get(edge.childHash);
    const parent = rowByHash.get(edge.parentHash);
    edgePopover.innerHTML =
      '<div class="row">Source branch: <span class="lane">' + escapeHtmlClient(model.lanes[edge.toLane]) + '</span></div>' +
      '<div class="row">Target branch: <span class="lane">' + escapeHtmlClient(model.lanes[edge.fromLane]) + '</span></div>' +
      '<span class="hash">' + parent.shortHash + '</span><span class="subject">' + escapeHtmlClient(parent.subject) + '</span><span class="meta">' + escapeHtmlClient(parent.author) + '</span>' +
      (edge.mergeParent ? '<div class="row meta">merge parent</div>' : '') +
      '<span class="hash">' + child.shortHash + '</span><span class="subject">' + escapeHtmlClient(child.subject) + '</span><span class="meta">' + escapeHtmlClient(child.author) + '</span>';
    edgePopover.style.display = 'block';
    edgePopover.style.left = (e.clientX + 12) + 'px';
    edgePopover.style.top = (e.clientY + 12) + 'px';
  };
  svg.appendChild(path);
  edgeEls.push({ path, edge });
});
document.addEventListener('click', () => { edgePopover.style.display = 'none'; });

const commitPopover = document.createElement('div');
commitPopover.className = 'commitPopover';
document.body.appendChild(commitPopover);

const commitDetailsPanel = document.createElement('div');
commitDetailsPanel.className = 'commitDetailsPanel';
commitDetailsPanel.onclick = (e) => e.stopPropagation();
const commitDetailsClose = document.createElement('span');
commitDetailsClose.className = 'closeBtn';
commitDetailsClose.textContent = '×';
commitDetailsClose.title = 'Close';
commitDetailsClose.onclick = () => { commitDetailsPanel.style.display = 'none'; };
commitDetailsPanel.appendChild(commitDetailsClose);
const commitDetailsHeader = document.createElement('div');
commitDetailsHeader.className = 'detailsHeader';
commitDetailsPanel.appendChild(commitDetailsHeader);
const commitDetailsBody = document.createElement('div');
commitDetailsBody.className = 'detailsBody';
commitDetailsPanel.appendChild(commitDetailsBody);
document.body.appendChild(commitDetailsPanel);
document.addEventListener('click', () => { commitDetailsPanel.style.display = 'none'; });

let openCommitHash = null;
function statusLabel(status) { return (status || '').charAt(0); }
function commitDetailsHeaderHtml(row, date) {
  return '<span class="hash">' + row.shortHash + '</span>' +
    '<span class="subject">' + escapeHtmlClient(row.subject) + '</span>' +
    '<span class="meta">' + escapeHtmlClient(row.author) + ' · ' + date + '</span>';
}
function renderCommitFiles(row, date, msg) {
  if (msg.hash !== openCommitHash) return;
  commitDetailsHeader.innerHTML = commitDetailsHeaderHtml(row, date);
  if (msg.error) {
    commitDetailsBody.innerHTML = '<div class="meta">Could not load files: ' + escapeHtmlClient(msg.error) + '</div>';
    return;
  }
  if (!msg.files.length) {
    commitDetailsBody.innerHTML = '<div class="meta">No file changes.</div>';
    return;
  }
  function splitPath(p) {
    const idx = p.lastIndexOf('/');
    return idx === -1 ? { name: p, dir: '' } : { name: p.slice(idx + 1), dir: p.slice(0, idx) };
  }
  const fileList = msg.files.map((f) => {
    const { name, dir } = splitPath(f.path);
    let label = '<span class="fileName">' + escapeHtmlClient(name) + '</span>';
    if (dir) label += '<span class="filePath">' + escapeHtmlClient(dir) + '</span>';
    if (f.oldPath) label += '<span class="filePath">(renamed from ' + escapeHtmlClient(f.oldPath) + ')</span>';
    return '<div class="file" data-path="' + escapeForAttr(f.path) + '" data-status="' + escapeForAttr(f.status) + '">' +
      '<span class="status ' + statusLabel(f.status) + '">' + escapeHtmlClient(statusLabel(f.status)) + '</span>' +
      label + '</div>';
  }).join('');
  commitDetailsBody.innerHTML = '<div class="fileList">' + fileList + '</div>';
  commitDetailsBody.querySelectorAll('.file').forEach((fileEl) => {
    fileEl.onclick = () => vscode.postMessage({
      type: 'openDiff', hash: row.hash, filePath: fileEl.dataset.path, status: fileEl.dataset.status
    });
  });
}
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg?.type === 'commitFiles') {
    const row = rowByHash.get(msg.hash);
    if (!row) return;
    const date = new Date(row.timestamp).toLocaleString(undefined, {year:'numeric',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit'});
    renderCommitFiles(row, date, msg);
  }
});
function openCommitDetails(e, row, date) {
  e.stopPropagation();
  openCommitHash = row.hash;
  commitDetailsHeader.innerHTML = commitDetailsHeaderHtml(row, date);
  commitDetailsBody.innerHTML = '<div class="meta">Loading files…</div>';
  commitDetailsPanel.style.display = 'flex';
  commitDetailsPanel.style.left = Math.min(e.clientX + 12, window.innerWidth - 440) + 'px';
  commitDetailsPanel.style.top = Math.min(e.clientY + 12, window.innerHeight - 300) + 'px';
  vscode.postMessage({ type: 'commitFiles', hash: row.hash });
}

const commitEls = [];
model.rows.forEach(row => {
  const el = document.createElement('div');
  el.className = 'commit' + (row.parents.length > 1 ? ' mergeCommit' : '');
  el.style.left = '0'; el.style.top = (headerH + row.row * rowH) + 'px'; el.style.width = width + 'px';
  el.dataset.lane = row.lane;

  const date = new Date(row.timestamp).toLocaleString(undefined, {year:'numeric',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit'});

  const node = document.createElement('span');
  node.className = 'node'; node.style.left = laneX(row.laneIndex) + 'px';
  node.onmouseenter = () => {
    commitPopover.innerHTML = '<span class="hash">' + row.shortHash + '</span><span class="subject">' + escapeHtmlClient(row.subject) + '</span><span class="meta">' + escapeHtmlClient(row.author) + ' · ' + date + '</span>';
    commitPopover.style.display = 'block';
    const rect = node.getBoundingClientRect();
    commitPopover.style.left = (rect.right + 10) + 'px';
    commitPopover.style.top = rect.top + 'px';
  };
  node.onmouseleave = () => { commitPopover.style.display = 'none'; };
  node.onclick = (e) => { e.stopPropagation(); toggleTrace(row); };
  el.appendChild(node);

  const details = document.createElement('div');
  details.className = 'details'; details.style.marginLeft = (graphWidth + 8) + 'px';
  details.innerHTML = '<span class="hash" title="Copy full hash">' + row.shortHash + '</span><span class="subject" title="' + escapeForAttr(row.subject) + '">' + escapeHtmlClient(row.subject) + '</span><span class="meta">' + escapeHtmlClient(row.author) + ' · ' + date + '</span>';
  details.querySelector('.hash').onclick = () => vscode.postMessage({type:'copyHash', hash:row.hash});
  details.querySelector('.subject').title += (details.querySelector('.subject').title ? ' — ' : '') + 'Click for commit details';
  details.querySelector('.subject').onclick = (e) => openCommitDetails(e, row, date);
  details.querySelector('.meta').onclick = (e) => openCommitDetails(e, row, date);
  el.appendChild(details);
  canvas.appendChild(el);
  commitEls.push({ el, row, node, details });
});

let loadMoreEl;
if (model.hasMore) {
  loadMoreEl = document.createElement('div');
  loadMoreEl.className = 'loadMore';
  loadMoreEl.style.top = (headerH + bodyHeight) + 'px';
  loadMoreEl.style.width = width + 'px';
  loadMoreEl.style.height = loadMoreH + 'px';
  const loadMoreBtn = document.createElement('button');
  loadMoreBtn.textContent = 'Load more commits';
  loadMoreBtn.onclick = () => {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = 'Loading…';
    vscode.postMessage({ type: 'loadMore' });
  };
  loadMoreEl.appendChild(loadMoreBtn);
  canvas.appendChild(loadMoreEl);
}

function parseFilterTokens(str) {
  const tokens = [];
  const re = /(author|message|commit|branch)\\s*:\\s*(?:"([^"]*)"|'([^']*)'|(\\S+))|"([^"]*)"|'([^']*)'|(\\S+)/gi;
  let m;
  while ((m = re.exec(str))) {
    if (m[1] !== undefined) {
      const criteria = m[1].toLowerCase();
      if (m[2] !== undefined) tokens.push({ criteria, text: m[2], exact: true });
      else if (m[3] !== undefined) tokens.push({ criteria, text: m[3], exact: true });
      else tokens.push({ criteria, text: m[4], exact: false });
    } else if (m[5] !== undefined) tokens.push({ criteria: null, text: m[5], exact: true });
    else if (m[6] !== undefined) tokens.push({ criteria: null, text: m[6], exact: true });
    else tokens.push({ criteria: null, text: m[7], exact: false });
  }
  return tokens.filter(t => t.text.length);
}
function wordsOf(s) { return s.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean); }
function fieldMatches(row, criteria, text, exact) {
  const t = text.toLowerCase();
  if (criteria === 'commit') {
    const hash = row.hash.toLowerCase();
    return exact ? hash === t : hash.includes(t);
  }
  if (criteria === 'message') {
    const subject = row.subject.toLowerCase();
    return exact ? wordsOf(row.subject).includes(t) : subject.includes(t);
  }
  if (criteria === 'branch') {
    const lane = row.lane.toLowerCase();
    return exact ? lane === t : lane.includes(t);
  }
  const author = row.author.toLowerCase();
  return exact ? wordsOf(row.author).includes(t) : author.includes(t);
}
function rowMatchesFilter(row, tokens) {
  if (!tokens.length) return true;
  const byCriteria = new Map();
  const bare = [];
  tokens.forEach((tok) => {
    if (!tok.criteria) { bare.push(tok); return; }
    if (!byCriteria.has(tok.criteria)) byCriteria.set(tok.criteria, []);
    byCriteria.get(tok.criteria).push(tok);
  });
  for (const [criteria, toks] of byCriteria) {
    if (!toks.some(({ text, exact }) => fieldMatches(row, criteria, text, exact))) return false;
  }
  if (bare.length) {
    const hash = row.hash.toLowerCase();
    const subject = row.subject.toLowerCase();
    const author = row.author.toLowerCase();
    const subjectWords = wordsOf(row.subject);
    const authorWords = wordsOf(row.author);
    const anyBareMatch = bare.some(({ text, exact }) => {
      const t = text.toLowerCase();
      if (exact) return hash === t || subjectWords.includes(t) || authorWords.includes(t);
      return hash.includes(t) || subject.includes(t) || author.includes(t);
    });
    if (!anyBareMatch) return false;
  }
  return true;
}
function applyFilter() {
  const tokens = parseFilterTokens(search.value);
  const hasActiveFilter = tokens.length > 0 || selectedLanes.size > 0;
  const compactRows = compactRowsCheckbox.checked && hasActiveFilter;
  const compactBranches = compactBranchesCheckbox.checked && hasActiveFilter;

  function rowVisible(row) {
    const textMatch = rowMatchesFilter(row, tokens);
    if (!compactBranches) return textMatch;
    return textMatch && (!selectedLanes.size || selectedLanes.has(row.lane));
  }

  const visibleByRow = new Map();
  const compactRowIndex = new Map();
  const visibleLanes = new Set();
  let visibleCount = 0;
  commitEls.forEach(({ row }) => {
    const visible = rowVisible(row);
    visibleByRow.set(row.row, visible);
    if (visible) {
      visibleLanes.add(row.laneIndex);
      if (compactRows) {
        compactRowIndex.set(row.row, visibleCount);
        visibleCount++;
      }
    }
  });

  const compactLaneIndex = new Map();
  if (compactBranches) {
    model.lanes.forEach((lane, i) => {
      if (visibleLanes.has(i)) compactLaneIndex.set(i, compactLaneIndex.size);
    });
  }
  function currentLaneX(origIndex) {
    return compactBranches ? laneX(compactLaneIndex.get(origIndex)) : laneX(origIndex);
  }
  function currentRowY(rowIndex) {
    return compactRows ? rowY(compactRowIndex.get(rowIndex)) : rowY(rowIndex);
  }

  const currentGraphWidth = compactBranches
    ? Math.max(laneW, compactLaneIndex.size * laneW + graphPadding * 2)
    : graphWidth;
  const currentWidth = Math.max(500, currentGraphWidth + detailsW);

  model.lanes.forEach((lane, i) => {
    const show = !compactBranches || visibleLanes.has(i);
    laneTitleEls[i].style.display = show ? '' : 'none';
    railEls[i].style.display = show ? '' : 'none';
    if (show) {
      laneTitleEls[i].style.left = currentLaneX(i) + 'px';
      railEls[i].setAttribute('x1', currentLaneX(i));
      railEls[i].setAttribute('x2', currentLaneX(i));
    }
  });

  commitEls.forEach(({ el, row, node, details }) => {
    const visible = visibleByRow.get(row.row);
    el.style.display = visible ? '' : 'none';
    el.style.width = currentWidth + 'px';
    if (!compactRows) {
      el.style.top = (headerH + row.row * rowH) + 'px';
    } else if (visible) {
      el.style.top = (headerH + compactRowIndex.get(row.row) * rowH) + 'px';
    }
    if (visible) node.style.left = currentLaneX(row.laneIndex) + 'px';
    details.style.marginLeft = (currentGraphWidth + 8) + 'px';
  });

  canvas.style.width = currentWidth + 'px';
  header.style.width = currentWidth + 'px';
  searchBar.style.left = (currentGraphWidth + 8) + 'px';
  svg.setAttribute('width', currentGraphWidth);

  const newBodyHeight = compactRows ? Math.max(rowH, visibleCount * rowH) : bodyHeight;
  canvas.style.height = (headerH + newBodyHeight + footerH) + 'px';
  svg.setAttribute('height', newBodyHeight);
  railEls.forEach(line => line.setAttribute('y2', newBodyHeight));

  if (loadMoreEl) {
    loadMoreEl.style.top = (headerH + newBodyHeight) + 'px';
    loadMoreEl.style.width = currentWidth + 'px';
  }

  const anyCompact = compactRows || compactBranches;
  edgeEls.forEach(({ path, edge }) => {
    if (!anyCompact) {
      path.style.display = '';
      path.setAttribute('d', edgePathD(laneX(edge.fromLane), rowY(edge.fromRow), laneX(edge.toLane), rowY(edge.toRow)));
      return;
    }
    if (!visibleByRow.get(edge.fromRow) || !visibleByRow.get(edge.toRow)) {
      path.style.display = 'none';
      return;
    }
    path.style.display = '';
    path.setAttribute('d', edgePathD(currentLaneX(edge.fromLane), currentRowY(edge.fromRow), currentLaneX(edge.toLane), currentRowY(edge.toRow)));
  });
}
// Loading more commits replaces the whole webview (a fresh DOM/script each time), which would
// otherwise silently drop the search text, compact toggles, branch selection/trace, and scroll
// position. vscode.setState/getState persists across that reload for the same panel.
function saveUiState() {
  vscode.setState({
    search: search.value,
    compactRows: compactRowsCheckbox.checked,
    compactBranches: compactBranchesCheckbox.checked,
    selectedLanes: [...selectedLanes],
    traceHash: activeTrace ? activeTrace.startHash : null,
    scrollTop: viewport.scrollTop,
    scrollLeft: viewport.scrollLeft
  });
}

search.addEventListener('input', () => { applyFilter(); saveUiState(); });
compactRowsCheckbox.addEventListener('change', () => { applyFilter(); saveUiState(); });
compactBranchesCheckbox.addEventListener('change', () => { applyFilter(); saveUiState(); });
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    search.focus();
    search.select();
  }
});
let scrollSaveScheduled = false;
viewport.addEventListener('scroll', () => {
  if (scrollSaveScheduled) return;
  scrollSaveScheduled = true;
  requestAnimationFrame(() => { scrollSaveScheduled = false; saveUiState(); });
});

function applyFocus() {
  document.querySelectorAll('[data-lane], [data-from-lane]').forEach(el => el.classList.remove('dim','focused'));
  if (!selectedLanes.size) return;
  document.querySelectorAll('.commit, .rail, .laneTitle').forEach(el => {
    el.classList.toggle('focused', selectedLanes.has(el.dataset.lane));
    el.classList.toggle('dim', !selectedLanes.has(el.dataset.lane));
  });
  document.querySelectorAll('.edge').forEach(el => {
    const relevant = selectedLanes.has(el.dataset.fromLane) || selectedLanes.has(el.dataset.toLane);
    el.classList.toggle('focused', relevant); el.classList.toggle('dim', !relevant);
  });
}
function escapeHtmlClient(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
function escapeForAttr(s) { return escapeHtmlClient(s).replaceAll('"','&quot;'); }

document.getElementById('clear').onclick = () => { selectedLanes.clear(); activeTrace = null; applyFocus(); applyFilter(); applyTrace(); saveUiState(); };
document.getElementById('refresh').onclick = () => vscode.postMessage({type:'refresh'});
if (!model.rows.length) canvas.insertAdjacentHTML('beforeend','<div class="empty">No commits found.</div>');

const savedUiState = vscode.getState();
if (savedUiState) {
  if (savedUiState.search) search.value = savedUiState.search;
  compactRowsCheckbox.checked = Boolean(savedUiState.compactRows);
  compactBranchesCheckbox.checked = Boolean(savedUiState.compactBranches);
  (savedUiState.selectedLanes || []).forEach((lane) => selectedLanes.add(lane));
  applyFilter();
  applyFocus();
  if (savedUiState.traceHash) {
    const tracedRow = rowByHash.get(savedUiState.traceHash);
    if (tracedRow) { activeTrace = traceBranch(tracedRow); applyTrace(); }
  }
  if (savedUiState.scrollTop != null) viewport.scrollTop = savedUiState.scrollTop;
  if (savedUiState.scrollLeft != null) viewport.scrollLeft = savedUiState.scrollLeft;
}
</script>
</body></html>`;
}

function deactivate() {}
module.exports = { activate, deactivate };
