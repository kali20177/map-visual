import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import * as vscode from 'vscode';
import type { MapDocument } from './types';
import type { DiffResult } from './types';
import type { HostToWorker, ProgressEvent, WorkerToHost } from './protocol';

export type ProgressReporter = (progress: ProgressEvent) => void;

interface PendingJob {
    resolve: (value: MapDocument | DiffResult) => void;
    reject: (err: Error) => void;
    onProgress?: ProgressReporter;
}

export class WorkerError extends Error {
    constructor(public readonly kind: string, message: string) {
        super(message);
    }
}

/**
 * Long-lived parse/diff worker. Requests are serialized: each job is
 * self-contained, so a single worker keeps memory flat and ordering sane.
 */
export class ParseWorkerClient implements vscode.Disposable {
    private worker: Worker | null = null;
    private pending: PendingJob | null = null;
    private queue: Promise<unknown> = Promise.resolve();

    constructor(private readonly extensionPath: string) {}

    private ensure(): Worker {
        if (!this.worker) {
            this.worker = new Worker(path.join(this.extensionPath, 'dist', 'worker.js'));
            this.worker.on('message', (msg: WorkerToHost) => {
                const job = this.pending;
                if (!job) {
                    return;
                }
                if (msg.type === 'progress') {
                    job.onProgress?.({ stage: msg.stage, pct: msg.pct, side: msg.side, detail: msg.detail });
                    return;
                }
                this.pending = null;
                if (msg.type === 'result' || msg.type === 'diffResult') {
                    job.resolve(msg.type === 'result' ? msg.doc : msg.diff);
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

    private run<T>(request: HostToWorker, onProgress?: ProgressReporter): Promise<T> {
        const job = this.queue.then(
            () =>
                new Promise<T>((resolve, reject) => {
                    this.pending = { resolve: resolve as (v: MapDocument | DiffResult) => void, reject, onProgress };
                    this.ensure().postMessage(request);
                }),
        );
        // keep the chain alive after a rejection
        this.queue = job.catch(() => undefined);
        return job;
    }

    parse(req: Extract<HostToWorker, { type: 'parse' }>, onProgress?: ProgressReporter): Promise<MapDocument> {
        return this.run<MapDocument>(req, onProgress);
    }

    diff(req: Extract<HostToWorker, { type: 'diff' }>, onProgress?: ProgressReporter): Promise<DiffResult> {
        return this.run<DiffResult>(req, onProgress);
    }

    dispose(): void {
        void this.worker?.terminate();
        this.worker = null;
    }
}
