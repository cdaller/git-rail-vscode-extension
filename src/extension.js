'use strict';

const fs = require('node:fs');
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
  const data = JSON.stringify({ ...layout, branches, hasMore: Boolean(hasMore), maxBranchLabelWidth: maxBranchLabelWidth || 130 }).replaceAll('<', '\u003c');
  const template = fs.readFileSync(path.join(__dirname, 'webview.html'), 'utf8');
  return template
    .replace('__CODICON_CSS_URI__', () => codiconCssUri.toString())
    .replace('__REPO_NAME__', () => escapeHtml(repoName))
    .replace('const model = __MODEL_JSON__;', () => `const model = ${data};`);
}

function deactivate() {}
module.exports = { activate, deactivate };
