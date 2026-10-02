import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DiffResult } from './types';
import type { WebviewToHost } from './protocol';
import { l10nBundleScript } from './hostI18n';

/**
 * Map Diff viewer (M5): a standalone webview panel comparing two maps.
 * Data arrives pre-computed from the worker; the panel only renders and
 * forwards CSV export requests.
 */
export class DiffPanel {
    static async create(
        context: vscode.ExtensionContext,
        diff: DiffResult,
    ): Promise<DiffPanel> {
        const panel = vscode.window.createWebviewPanel('mapvisual.diffView', vscode.l10n.t('Diff: {0} ↔ {1}', path.basename(diff.fileA), path.basename(diff.fileB)), vscode.ViewColumn.Active, {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')],
            retainContextWhenHidden: true,
        });
        return new DiffPanel(context, panel, diff);
    }

    private constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly panel: vscode.WebviewPanel,
        private readonly diff: DiffResult,
    ) {
        const webview = this.panel.webview;
        webview.html = this.getHtml(webview);

        webview.onDidReceiveMessage((msg: WebviewToHost) => {
            if (msg.type === 'ready') {
                void webview.postMessage({ type: 'diffResult', diff: this.diff });
            } else if (msg.type === 'exportCsv') {
                void this.exportCsv(msg.csv, msg.suggestedName);
            }
        });

        this.panel.onDidDispose(() => {
            // nothing persistent to clean up
        });
    }

    private async exportCsv(csv: string, suggestedName: string): Promise<void> {
        // Anchor the suggestion next to the diffed maps, not the host cwd.
        const defaultUri = path.isAbsolute(suggestedName) ? vscode.Uri.file(suggestedName) : vscode.Uri.joinPath(vscode.Uri.file(path.dirname(this.diff.fileA)), suggestedName);
        const target = await vscode.window.showSaveDialog({
            defaultUri,
            filters: { 'CSV': ['csv'] },
        });
        if (!target) {
            return;
        }
        await vscode.workspace.fs.writeFile(target, Buffer.from(csv, 'utf8'));
        void vscode.window.showInformationMessage(vscode.l10n.t('MapVisual: exported {0}', path.basename(target.fsPath)));
    }

    private getHtml(webview: vscode.Webview): string {
        const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'diff.js'));
        const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'));
        const nonce = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
        return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}">
<title>MapVisual Diff</title>
</head>
<body>
<div id="app"></div>
${l10nBundleScript()}
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
    }
}
