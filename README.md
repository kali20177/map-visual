<div align="center">

<img src="media/icon-2x.png" width="96" alt="MapVisual icon" />

# MapVisual

**Linker map files, visualized inside VS Code.**

[![CI](https://github.com/kali20177/map-visual/actions/workflows/ci.yml/badge.svg)](https://github.com/kali20177/map-visual/actions/workflows/ci.yml)

[English](README.md) | [简体中文](README.zh-CN.md)

</div>

A linker map records where object files are mapped into memory, how common symbols are allocated, which archive members the link pulled in, and the values assigned to symbols, whether or not those symbols end up in the image. A real map runs to megabytes of dense text. MapVisual turns the `.map` from GNU ld or LLVM lld into a sortable, filterable symbol list with per-symbol Flash and RAM use, a treemap, a build-to-build diff, and a built-in C++ demangler.

## Features

- **Open a map**: press `Alt+M` and pick one, or double-click any `.map` file. Rebuild your firmware and the open view refreshes itself.
- **Symbol-level list**: sort by size, name, kind, section, object or address; group by object, library, output section, section kind or directory; filter by text, kind or minimum size; hide compiler and runtime objects; see what `--gc-sections` removed. Virtual scrolling keeps multi-megabyte maps fast.
- **Filtering that keeps up**: whitespace-separated terms are combined, `-word` excludes, and `"a phrase"` stays one term for names and paths with spaces. Matches are highlighted in the list and counted in the toolbar, so an empty result says so instead of looking broken.
- **Memory usage**: region usage bars, section-kind composition and the largest symbols in the side panel, plus a status-bar readout for the active map.
- **Locate in raw map**: double-click a symbol row — or `Alt+click`, or press `Enter` on a focused row — and MapVisual opens the raw map beside the view with that line highlighted. Copy actions live in the row context menu.
- **Treemap**: switch the list to an area-proportional treemap and drill into any group.
- **Map diff**: compare two builds symbol by symbol (added / removed / changed), with Flash and RAM totals and CSV export.
- **Built-in C++ demangling**: the extension bundles a WASM demangler, so you need no toolchain or configuration. Symbols recovered from section names (`.text._ZN…`) are demangled too, and both the mangled and demangled forms are searchable.
- **Real linker output**: handles `-ffunction-sections` entries, LTO merged sections, `--gc-sections` discards, `*fill*` padding, static-archive members and relax annotations, and counts `.data` in both Flash and RAM.
- **CSV export**: the filtered rows, or just the rows you selected.
- **Go to source**: jump from a symbol to its source file in your workspace.
- **Chinese UI**: the interface follows your VS Code display language. With the Chinese language pack installed, the commands, settings, tooltips, panels and row menus all come up in Chinese, with no configuration; anything without a translation stays in English.
- **CLI included**: the same parser runs from the command line too (see below).

## Getting started

1. Install the extension from the marketplace (or from a `.vsix`).
2. Open a workspace containing your project and press `Alt+M`, or double-click any `.map` file. MapVisual opens it by default.
3. To read a map as plain text, use the **Open as Text** button in the editor title bar. To change the default permanently, right-click the file → *Open With…* → *Configure default editor*.

While reading a map:

- **Toolbar**: `Demangle` (C++ name demangling), `System` (hide crt/libgcc/libc), `Removed` (gc-sectioned symbols), `Treemap`, `Raw` (open the raw map beside), `CSV` export. The filter box takes `-word` to exclude and `"a phrase"` to keep a name with spaces together.
- **Columns**: drag the divider in a header to resize it — neighbouring columns trade width, so the table keeps filling the panel.
- **Rows**: a click selects a row, and dragging over rows selects that range the way a file list works — drag past the edge and the list scrolls on its own. `Alt+click` or double-click reveals the row's line in the raw map (`Enter` does too, on a focused row). `Shift+click` and `Shift+↑/↓` extend from the anchor, `Ctrl/Cmd+click` toggles single rows, `Ctrl/Cmd+A` selects everything visible — a selection exports through the row menu. Right-click opens the row menu: copy the demangled name, the mangled name or the whole row, reveal the raw line, filter by object or section, show only one kind, exclude an object, go to source. With more than one row selected the menu switches to batch actions (copy the names, copy the rows, export as CSV, clear the selection), and right-clicking a row outside the selection re-targets it first.
- **View state is kept, per file**: filter, sort, grouping, collapsed groups, the treemap drill-down, column widths, scroll position and your row selection all come back when you switch tabs, and again when you close the file and reopen it later — even in a new window. Returning to a tab does not re-parse the map.
- **Status bar**: Flash and RAM totals for the map you are looking at.

## Commands

| Command | Key |
|---|---|
| MapVisual: Open Map File | `Alt+M` |
| MapVisual: Compare Two Maps | `Alt+Shift+D` |
| MapVisual: Open as Text | editor title bar (while viewing a map) |

## Settings

| Setting | Default | Description |
|---|---|---|
| `mapvisual.demangle` | `true` | Demangle C++ symbol names (built-in WASM demangler). |
| `mapvisual.formatOverride` | `auto` | Force the map format instead of auto-detection (`gnu-ld` / `lld`). |

## Command line

The parser does not depend on VS Code. After building, the same engine runs as a CLI for scripts and AI assistants, with `summary`, `symbols`, `treemap` and `diff` commands. Output is JSON by default, or Markdown with `--md`:

```bash
node dist/cli.js summary firmware.map
node dist/cli.js symbols firmware.map --top 20 --kind code
node dist/cli.js treemap firmware.map --depth 2
node dist/cli.js diff old.map new.map
```

See [docs/CLI.md](docs/CLI.md) for the full contract.

## Supported toolchains

| Toolchain | Status |
|---|---|
| GNU ld (`gcc`, `arm-none-eabi-gcc`) | ✅ verified against real firmware builds |
| LLVM lld (`ld.lld`) | ✅ verified against real builds |
| Keil armlink | planned |
| IAR ilink | planned |

## Privacy

Parsing runs entirely on your machine, in a local worker process. The extension collects no telemetry and makes no network requests, so your firmware's symbols stay on your machine.

## License

[MIT](LICENSE)
