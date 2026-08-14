'use strict';

const vscode = require('vscode');
const { isGitRepository, loadRepository } = require('./git');
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
    { enableScripts: true, retainContextWhenHidden: true }
  );

  currentPanel = { panel, folder, context };
  panel.onDidDispose(() => {
    if (currentPanel?.panel === panel) currentPanel = undefined;
  });

  panel.webview.onDidReceiveMessage(async (message) => {
    if (message?.type === 'refresh') await refreshPanel();
    if (message?.type === 'copyHash' && message.hash) {
      await vscode.env.clipboard.writeText(message.hash);
      vscode.window.setStatusBarMessage(`Git Rail: copied ${message.hash.slice(0, 8)}`, 1800);
    }
  });

  panel.webview.html = loadingHtml();
  await refreshPanel();
}

async function refreshPanel() {
  if (!currentPanel) return;
  const { panel, folder } = currentPanel;

  try {
    const config = vscode.workspace.getConfiguration('gitRail', folder.uri);
    const repository = await loadRepository(folder.uri.fsPath, {
      maxCommits: config.get('maxCommits', 300),
      includeRemoteBranches: config.get('includeRemoteBranches', false),
      includeLocalBranches: config.get('includeLocalBranches', true)
    });
    const layout = buildLayout(repository, {
      hideEmptyBranches: config.get('hideEmptyBranches', true)
    });
    panel.webview.html = renderHtml(folder.name, layout, repository.branches);
  } catch (error) {
    panel.webview.html = errorHtml(error instanceof Error ? error.message : String(error));
  }
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

function renderHtml(repoName, layout, branches) {
  const data = JSON.stringify({ ...layout, branches }).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
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
  .laneTitle { position:absolute; bottom:10px; max-width:130px; padding:3px 7px; border-radius:5px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; background:var(--vscode-badge-background); color:var(--vscode-badge-foreground); font-size:11px; transform-origin:left bottom; transform:rotate(-35deg); }
  .laneTitle.current { outline:2px solid var(--vscode-focusBorder); }
  .laneTitle.history { opacity:.65; font-style:italic; }
  .branchPopover { position:fixed; z-index:20; padding:5px 9px; border-radius:5px; background:var(--vscode-editorHoverWidget-background, var(--vscode-editor-background)); color:var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground)); border:1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border)); font-size:12px; box-shadow:0 2px 8px rgba(0,0,0,.3); pointer-events:none; white-space:nowrap; display:none; }
  .searchBar { position:absolute; top:50%; transform:translateY(-50%); display:flex; align-items:center; gap:10px; }
  .search { flex:1 1 auto; box-sizing:border-box; padding:6px 10px; border:1px solid var(--vscode-panel-border); border-radius:4px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); font-family:inherit; font-size:13px; }
  .search:focus { outline:1px solid var(--vscode-focusBorder); }
  .compactToggle { display:flex; align-items:center; gap:5px; font-size:12px; color:var(--vscode-descriptionForeground); white-space:nowrap; cursor:pointer; }
  svg { position:absolute; left:0; top:var(--header-h); overflow:visible; pointer-events:none; }
  .rail { stroke:var(--vscode-editorIndentGuide-background); stroke-width:2; }
  .edge { fill:none; stroke:var(--vscode-editorIndentGuide-activeBackground); stroke-width:2; opacity:.55; }
  .edge.merge { stroke-dasharray:5 4; opacity:.9; }
  .commit { position:absolute; height:var(--row-h); display:flex; align-items:center; border-bottom:1px solid color-mix(in srgb, var(--vscode-panel-border) 45%, transparent); }
  .node { position:absolute; width:12px; height:12px; border-radius:50%; transform:translate(-6px,-6px); top:50%; background:var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-textLink-foreground)); border:2px solid var(--vscode-editor-background); box-shadow:0 0 0 1px var(--vscode-editorIndentGuide-activeBackground); }
  .commit.mergeCommit .node { width:14px; height:14px; transform:translate(-7px,-7px) rotate(45deg); border-radius:2px; }
  .details { margin-left:28px; width:650px; display:flex; gap:9px; align-items:baseline; white-space:nowrap; overflow:hidden; }
  .hash { font-family:var(--vscode-editor-font-family); color:var(--vscode-textLink-foreground); cursor:pointer; }
  .subject { overflow:hidden; text-overflow:ellipsis; }
  .meta { color:var(--vscode-descriptionForeground); font-size:12px; }
  .dim { opacity:.16 !important; }
  .focused { opacity:1 !important; }
  .empty { padding:30px; color:var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<div class="toolbar"><strong>Git Rail — ${escapeHtml(repoName)}</strong><span class="hint">Click a rail to focus · click hash to copy</span><button id="clear">Clear focus</button><button id="refresh">Refresh</button></div>
<div class="viewport"><div id="canvas" class="canvas"></div></div>
<script>
const vscode = acquireVsCodeApi();
const model = ${data};
const laneW = 60, rowH = 38, headerH = 110, graphPadding = 36, detailsW = 700;
const canvas = document.getElementById('canvas');
const branchMap = new Map(model.branches.map(b => [b.name, b]));
let focusedLane = null;

const width = Math.max(500, model.lanes.length * laneW + detailsW + graphPadding * 2);
const graphWidth = model.lanes.length * laneW + graphPadding * 2;
const bodyHeight = Math.max(rowH, model.rows.length * rowH);
canvas.style.width = width + 'px';
canvas.style.height = (headerH + bodyHeight) + 'px';

const header = document.createElement('div');
header.className = 'laneHeader';
header.style.width = graphWidth + 'px';
canvas.appendChild(header);

function laneX(index) { return graphPadding + index * laneW + laneW / 2; }
function rowY(index) { return index * rowH + rowH / 2; }

const branchPopover = document.createElement('div');
branchPopover.className = 'branchPopover';
document.body.appendChild(branchPopover);

model.lanes.forEach((lane, i) => {
  const el = document.createElement('div');
  el.className = 'laneTitle' + (branchMap.get(lane)?.current ? ' current' : '') + (lane === 'history' ? ' history' : '');
  el.textContent = lane;
  el.title = lane === 'history' ? 'Commits not assigned to the first-parent chain of a current branch' : '';
  el.style.left = laneX(i) + 'px';
  el.dataset.lane = lane;
  el.onclick = () => { focusedLane = focusedLane === lane ? null : lane; applyFocus(); };
  el.onmouseenter = () => {
    branchPopover.textContent = lane === 'history' ? 'history' : lane;
    branchPopover.style.display = 'block';
    const rect = el.getBoundingClientRect();
    branchPopover.style.left = rect.left + 'px';
    branchPopover.style.top = (rect.bottom + 6) + 'px';
  };
  el.onmouseleave = () => { branchPopover.style.display = 'none'; };
  header.appendChild(el);
});

const searchBar = document.createElement('div');
searchBar.className = 'searchBar';
searchBar.style.left = (graphWidth + 8) + 'px';
searchBar.style.width = (detailsW - 16) + 'px';
header.appendChild(searchBar);

const search = document.createElement('input');
search.type = 'search';
search.className = 'search';
search.placeholder = 'Filter by hash, message, author (words are OR-combined, "quoted" = exact match)';
searchBar.appendChild(search);

const compactToggle = document.createElement('label');
compactToggle.className = 'compactToggle';
const compactCheckbox = document.createElement('input');
compactCheckbox.type = 'checkbox';
compactToggle.appendChild(compactCheckbox);
compactToggle.appendChild(document.createTextNode('Compact'));
compactToggle.title = 'Remove non-matching rows instead of just hiding them';
searchBar.appendChild(compactToggle);

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
  svg.appendChild(line);
  railEls.push(line);
});

const edgeEls = [];
model.edges.forEach(edge => {
  const x1 = laneX(edge.fromLane), y1 = rowY(edge.fromRow);
  const x2 = laneX(edge.toLane), y2 = rowY(edge.toRow);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', edgePathD(x1, y1, x2, y2));
  path.setAttribute('class', 'edge' + (edge.mergeParent ? ' merge' : ''));
  path.dataset.fromLane = model.lanes[edge.fromLane];
  path.dataset.toLane = model.lanes[edge.toLane];
  svg.appendChild(path);
  edgeEls.push({ path, edge });
});

const commitEls = [];
model.rows.forEach(row => {
  const el = document.createElement('div');
  el.className = 'commit' + (row.parents.length > 1 ? ' mergeCommit' : '');
  el.style.left = '0'; el.style.top = (headerH + row.row * rowH) + 'px'; el.style.width = width + 'px';
  el.dataset.lane = row.lane;

  const node = document.createElement('span');
  node.className = 'node'; node.style.left = laneX(row.laneIndex) + 'px';
  el.appendChild(node);

  const details = document.createElement('div');
  details.className = 'details'; details.style.marginLeft = (graphWidth + 8) + 'px';
  const date = new Date(row.timestamp).toLocaleString(undefined, {year:'numeric',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit'});
  details.innerHTML = '<span class="hash" title="Copy full hash">' + row.shortHash + '</span><span class="subject" title="' + escapeForAttr(row.subject) + '">' + escapeHtmlClient(row.subject) + '</span><span class="meta">' + escapeHtmlClient(row.author) + ' · ' + date + '</span>';
  details.querySelector('.hash').onclick = () => vscode.postMessage({type:'copyHash', hash:row.hash});
  el.appendChild(details);
  canvas.appendChild(el);
  commitEls.push({ el, row });
});

function parseFilterTokens(str) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|([^ ]+)/g;
  let m;
  while ((m = re.exec(str))) {
    if (m[1] !== undefined) tokens.push({ text: m[1], exact: true });
    else if (m[2] !== undefined) tokens.push({ text: m[2], exact: true });
    else tokens.push({ text: m[3], exact: false });
  }
  return tokens.filter(t => t.text.length);
}
function wordsOf(s) { return s.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean); }
function rowMatchesFilter(row, tokens) {
  if (!tokens.length) return true;
  const hash = row.hash.toLowerCase();
  const subject = row.subject.toLowerCase();
  const author = row.author.toLowerCase();
  const subjectWords = wordsOf(row.subject);
  const authorWords = wordsOf(row.author);
  return tokens.some(({ text, exact }) => {
    const t = text.toLowerCase();
    if (exact) return hash === t || subjectWords.includes(t) || authorWords.includes(t);
    return hash.includes(t) || subject.includes(t) || author.includes(t);
  });
}
function applyFilter() {
  const tokens = parseFilterTokens(search.value);
  const compact = compactCheckbox.checked && tokens.length > 0;

  const compactRowIndex = new Map();
  let visibleCount = 0;
  commitEls.forEach(({ el, row }) => {
    const matches = rowMatchesFilter(row, tokens);
    el.style.display = matches ? '' : 'none';
    if (!compact) {
      el.style.top = (headerH + row.row * rowH) + 'px';
    } else if (matches) {
      el.style.top = (headerH + visibleCount * rowH) + 'px';
      compactRowIndex.set(row.row, visibleCount);
      visibleCount++;
    }
  });

  const newBodyHeight = compact ? Math.max(rowH, visibleCount * rowH) : bodyHeight;
  canvas.style.height = (headerH + newBodyHeight) + 'px';
  svg.setAttribute('height', newBodyHeight);
  railEls.forEach(line => line.setAttribute('y2', newBodyHeight));

  edgeEls.forEach(({ path, edge }) => {
    if (!compact) {
      path.style.display = '';
      path.setAttribute('d', edgePathD(laneX(edge.fromLane), rowY(edge.fromRow), laneX(edge.toLane), rowY(edge.toRow)));
      return;
    }
    const fromIdx = compactRowIndex.get(edge.fromRow);
    const toIdx = compactRowIndex.get(edge.toRow);
    if (fromIdx === undefined || toIdx === undefined) {
      path.style.display = 'none';
      return;
    }
    path.style.display = '';
    path.setAttribute('d', edgePathD(laneX(edge.fromLane), rowY(fromIdx), laneX(edge.toLane), rowY(toIdx)));
  });
}
search.addEventListener('input', applyFilter);
compactCheckbox.addEventListener('change', applyFilter);

function applyFocus() {
  document.querySelectorAll('[data-lane], [data-from-lane]').forEach(el => el.classList.remove('dim','focused'));
  if (!focusedLane) return;
  document.querySelectorAll('.commit, .rail, .laneTitle').forEach(el => {
    el.classList.toggle('focused', el.dataset.lane === focusedLane);
    el.classList.toggle('dim', el.dataset.lane !== focusedLane);
  });
  document.querySelectorAll('.edge').forEach(el => {
    const relevant = el.dataset.fromLane === focusedLane || el.dataset.toLane === focusedLane;
    el.classList.toggle('focused', relevant); el.classList.toggle('dim', !relevant);
  });
}
function escapeHtmlClient(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
function escapeForAttr(s) { return escapeHtmlClient(s).replaceAll('"','&quot;'); }

document.getElementById('clear').onclick = () => { focusedLane = null; applyFocus(); };
document.getElementById('refresh').onclick = () => vscode.postMessage({type:'refresh'});
if (!model.rows.length) canvas.insertAdjacentHTML('beforeend','<div class="empty">No commits found.</div>');
</script>
</body></html>`;
}

function deactivate() {}
module.exports = { activate, deactivate };
