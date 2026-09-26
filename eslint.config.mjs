import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },

  // TypeScript 推荐规则：正确性检查
  ...tseslint.configs.recommended,

  // unused 由 tsc noUnusedLocals/noUnusedParameters 在编译期报错，不重复检查
  { rules: { '@typescript-eslint/no-unused-vars': 'off' } },

  // ── 运行时边界（四个 bundle 的物理隔离，esbuild 打包前拦截）──
  //
  // worker.ts（worker_threads）、cli.ts（独立 CLI 进程）及 parser/demangle/analysis
  // 跑在纯 Node 运行时：import vscode 会被打进对应 bundle，启动即崩；且 tsc 查不出
  // （@types/vscode 使 vscode 可解析），必须在 lint 层拦截。
  {
    files: ['src/worker.ts', 'src/cli.ts', 'src/cliApp.ts', 'src/parser/**', 'src/demangle/**', 'src/analysis/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['vscode', 'vscode/*'],
              message:
                '纯 Node 运行时（worker/cli）禁止依赖 VSCode API——vscode 只允许出现在扩展宿主层（extension/mapEditor/diffPanel/workerClient）。',
            },
          ],
        },
      ],
    },
  },

  // webview 跑在 VSCode 沙箱 iframe：无 vscode、无 Node 内置模块
  {
    files: ['src/webview/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['vscode', 'vscode/*', 'node:*', 'fs', 'path', 'worker_threads', 'child_process', 'readline', 'module'],
              message: 'webview 运行时无 vscode / Node 环境——数据经 postMessage（protocol.ts）与宿主交换。',
            },
          ],
        },
      ],
    },
  },
)
