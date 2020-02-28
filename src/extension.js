import {
  clearPackageCache,
  getImports,
  JAVASCRIPT,
  TYPESCRIPT,
} from './get-imports';
import * as vscode from 'vscode';
import { calculated, flushDecorations, clearDecorations } from './decorator';
import logger from './logger';
import { SnykVulnInfo } from './SnykAction';
import { refreshDiagnostics } from './diagnostics';

const { window, workspace, commands } = vscode;

let isActive = true;
let packageWatcher = {};

export function activate(context) {
  try {
    logger.init(context);
    logger.log('starting...');

    context.subscriptions.push(
      vscode.languages.registerCodeActionsProvider(
        JAVASCRIPT,
        new SnykVulnInfo(),
        {
          providedCodeActionKinds: SnykVulnInfo.providedCodeActionKinds,
        }
      )
    );

    context.subscriptions.push(
      vscode.languages.registerCodeActionsProvider(
        TYPESCRIPT,
        new SnykVulnInfo(),
        {
          providedCodeActionKinds: SnykVulnInfo.providedCodeActionKinds,
        }
      )
    );

    const diagnostics = vscode.languages.createDiagnosticCollection(
      'snyk-vulns'
    );

    context.subscriptions.push(diagnostics);

    workspace.onDidChangeTextDocument(
      ev => isActive && processActiveFile(ev.document, diagnostics)
    );
    window.onDidChangeActiveTextEditor(
      ev => ev && isActive && processActiveFile(ev.document, diagnostics)
    );
    if (window.activeTextEditor && isActive) {
      processActiveFile(window.activeTextEditor.document, diagnostics);
    }

    context.subscriptions.push(
      commands.registerCommand('vulnCost.check', () => {
        processActiveFile(window.activeTextEditor.document, diagnostics);
      })
    );

    context.subscriptions.push(
      commands.registerCommand('vulnCost.toggle', () => {
        isActive = !isActive;
        if (isActive && window.activeTextEditor) {
          processActiveFile(window.activeTextEditor.document, diagnostics);
        } else {
          deactivate();
          clearDecorations();
        }
      })
    );
  } catch (e) {
    logger.log('wrapping error: ' + e);
  }
}

export function deactivate() {}

function createPackageWatcher(fileName) {
  if (packageWatcher[fileName]) {
    return;
  }

  const watcher = vscode.workspace.createFileSystemWatcher(fileName);
  watcher.onDidChange(() => {
    clearPackageCache();
    if (isActive && window.activeTextEditor) {
      commands.executeCommand('vulnCost.check');
    }
  });

  packageWatcher[fileName] = watcher;
}

let emitters = {};
async function processActiveFile(document, diagnostics) {
  if (document && language(document)) {
    const { fileName } = document;
    if (emitters[fileName]) {
      emitters[fileName].removeAllListeners();
    }
    // const { timeout } = workspace.getConfiguration('vulnCost');
    emitters[fileName] = getImports(
      fileName,
      document.getText(),
      language(document)
    );

    emitters[fileName].on('package', createPackageWatcher);
    emitters[fileName].on('error', e => logger.log(`vulnCost error: ${e}`));
    emitters[fileName].on('start', packages => {
      flushDecorations(fileName, packages);
    });
    emitters[fileName].on('calculated', calculated);

    emitters[fileName].on('done', packages => {
      flushDecorations(fileName, packages);
      refreshDiagnostics(document, diagnostics, packages);
    });
  }
}

function language({ fileName, languageId }) {
  const configuration = workspace.getConfiguration('vulnCost');
  const typescriptRegex = new RegExp(
    configuration.typescriptExtensions.join('|')
  );
  const javascriptRegex = new RegExp(
    configuration.javascriptExtensions.join('|')
  );
  if (
    languageId === 'typescript' ||
    languageId === 'typescriptreact' ||
    typescriptRegex.test(fileName)
  ) {
    return TYPESCRIPT;
  } else if (
    languageId === 'javascript' ||
    languageId === 'javascriptreact' ||
    javascriptRegex.test(fileName)
  ) {
    return JAVASCRIPT;
  } else {
    return undefined;
  }
}