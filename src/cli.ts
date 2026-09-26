import { createRequire } from 'node:module';
import { runCli } from './cliApp';

/**
 * CLI 进程入口（M6，docs/CLI.md）——esbuild cjs bundle 到 dist/cli.js。
 * 全部逻辑在 cliApp.ts（可测、可被未来 MCP server 复用）；本文件只做
 * argv/stdout/stderr/exitCode 的进程接线，因此不需要 worker_threads——
 * CLI 本身就是独立进程，同步解析不会阻塞任何 UI。
 */

// esbuild 把 import.meta 替换为空对象，CJS 环境的版本号只能在这里用 __filename 解析
const { version } = createRequire(__filename)('../package.json') as { version: string };

// 管道读者先关（`mapvisual symbols big.map | head`）是本命令通道的首要用例：
// EPIPE 不是错误，静默按成功收场；其余写错误照常上抛
const onWriteError = (e: NodeJS.ErrnoException): void => {
    if (e.code === 'EPIPE') {
        process.exit(0);
    }
    throw e;
};
process.stdout.on('error', onWriteError);
process.stderr.on('error', onWriteError);

void runCli(process.argv.slice(2), {
    wasmDir: __dirname, // demangler wasm 由 build.mjs 拷在 dist/（同 worker 约定）
    version,
    onProgress: (stage, pct) => {
        process.stderr.write(`mapvisual: ${pct}% ${stage}\n`);
    },
}).then((r) => {
    if (r.out) {
        process.stdout.write(r.out);
    }
    if (r.err) {
        process.stderr.write(r.err);
    }
    // 不用 process.exit：大 JSON 可能截断在 pipe 缓冲里，赋值 exitCode 让其自然刷出
    process.exitCode = r.code;
});
