import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import * as vscode from 'vscode';
import type { MapDocument } from './types';
import type { ParseRequest, ParseResponse } from './protocol';

/**
 * Long-lived parse worker. Requests are serialized: each parse is
 * self-contained, so a single worker keeps memory flat and ordering sane.
 */
export class ParseWorkerClient implements vscode.Disposable {
    private worker: Worker | null = null;
    private pending: { resolve: (doc: MapDocument) => void; reject: (err: Error) => void } | null = null;
    private queue: Promise<unknown> = Promise.resolve();

    constructor(private readonly extensionPath: string) {}

    private ensure(): Worker {
        if (!this.worker) {
            this.worker = new Worker(path.join(this.extensionPath, 'dist', 'worker.js'));
            this.worker.on('message', (msg: ParseResponse) => {
                const job = this.pending;
                this.pending = null;
                if (!job) {
                    return;
                }
                if (msg.type === 'result') {
                    job.resolve(msg.doc);
                } else {
                    job.reject(new WorkerError(msg.error.kind, msg.error.message));
                }
            });
            this.worker.on('error', (err) => {
                const job = this.pending;
                this.pending = null;
                job?.reject(new WorkerError('io', err.message));
            });
            this.worker.on('exit', (code) => {
                if (code !== 0) {
                    const job = this.pending;
                    this.pending = null;
                    job?.reject(new WorkerError('io', `parser worker exited with code ${code}`));
                }
                this.worker = null;
            });
        }
        return this.worker;
    }

    parse(req: ParseRequest): Promise<MapDocument> {
        const job = this.queue.then(
            () =>
                new Promise<MapDocument>((resolve, reject) => {
                    this.pending = { resolve, reject };
                    this.ensure().postMessage(req);
                }),
        );
        // keep the chain alive after a rejection
        this.queue = job.catch(() => undefined);
        return job;
    }

    dispose(): void {
        void this.worker?.terminate();
        this.worker = null;
    }
}

export class WorkerError extends Error {
    constructor(public readonly kind: string, message: string) {
        super(message);
    }
}
