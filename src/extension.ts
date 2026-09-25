import * as path from 'node:path';
import * as vscode from 'vscode';
import { MapEditorProvider } from './mapEditor';
import { ParseWorkerClient } from './workerClient';

export function activate(context: vscode.ExtensionContext): void {
    const worker = new ParseWorkerClient(context.extensionPath);
    const provider = new MapEditorProvider(context, worker);

    context.subscriptions.push(
        worker,
        vscode.window.registerCustomEditorProvider('mapvisual.editor', provider, {
            supportsMultipleEditorsPerDocument: false,
        }),
        vscode.commands.registerCommand('mapvisual.open', () => void openMapFile()),
        vscode.commands.registerCommand('mapvisual.openAsText', (uri?: vscode.Uri) =>
            void vscode.commands.executeCommand('vscode.openWith', uri ?? currentMapUri(), 'default', vscode.ViewColumn.Active),
        ),
    );
}

function currentMapUri(): vscode.Uri | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri && /\.map$/i.test(uri.fsPath) ? uri : undefined;
}

async function openMapFile(): Promise<void> {
    const active = currentMapUri();
    if (active) {
        await openInViewer(active);
        return;
    }
    const maps = await findWorkspaceMaps();
    if (maps.length === 0) {
        void vscode.window.showInformationMessage(
            'MapVisual: no .map files found in this workspace. Generate one with -Wl,-Map=out.map (GCC/clang) or -Map=out.map (ld.lld).',
        );
        return;
    }
    if (maps.length === 1) {
        await openInViewer(maps[0]);
        return;
    }
    const items = maps.map((uri) => ({ uri, label: workspaceRelative(uri) }));
    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a linker map file',
        matchOnDescription: true,
    });
    if (picked) {
        await openInViewer(picked.uri);
    }
}

async function openInViewer(uri: vscode.Uri): Promise<void> {
    await vscode.commands.executeCommand('vscode.openWith', uri, 'mapvisual.editor', vscode.ViewColumn.Active);
}

function workspaceRelative(uri: vscode.Uri): string {
    const ws = vscode.workspace.getWorkspaceFolder(uri);
    if (!ws) {
        return uri.fsPath;
    }
    return path.relative(ws.uri.fsPath, uri.fsPath);
}

async function findWorkspaceMaps(): Promise<vscode.Uri[]> {
    const files = await vscode.workspace.findFiles('**/*.map', '**/{node_modules,.git,dist,out,build,DerivedData}/**', 200);
    const stats = await Promise.all(
        files.map(async (uri) => {
            try {
                const st = await vscode.workspace.fs.stat(uri);
                return { uri, mtime: st.mtime, size: st.size };
            } catch {
                return { uri, mtime: 0, size: 0 };
            }
        }),
    );
    return stats
        .sort((a, b) => b.mtime - a.mtime || b.size - a.size)
        .map((s) => s.uri);
}
