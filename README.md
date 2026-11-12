# 🌙 nightq

**A markdown work-queue CLI with a timestamped stream log and stall detection.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh)
[![Dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#-design)

`nightq` manages a work queue as **plain markdown files** — no database, no server, no lock-in. The queue is a file a human can read and edit by hand; the CLI just keeps its format honest, appends a timestamped log of everything that happens, and can tell you when work has **stalled**: items are marked as in-progress, but nothing has been updated for a while.

It was built for long-running, semi-autonomous work sessions (overnight coding runs, batch jobs with a human watcher), where "the worker went quiet an hour ago" is the failure mode you actually need to catch.

## 📑 Table of Contents

- [Why](#-why)
- [Install](#-install)
- [Quick start](#-quick-start)
- [Commands](#-commands)
- [The watch command](#-the-watch-command)
- [File format](#-file-format)
- [Design](#-design)
- [Development](#-development)
- [License](#-license)

## 🤔 Why

- **The queue is the state.** Everything lives in two markdown files. If the worker dies, the next one reads the files and continues. Nothing is held in a process's memory.
- **The log is the proof.** Every mutation appends a `- [HH:MM] ...` line to the stream log, so a watcher can reconstruct the night minute by minute.
- **Stalls are detectable.** `nightq watch` exits non-zero when items are `DOING` but neither the queue nor the log has been updated within a threshold — exactly the signal a cron job or heartbeat needs.

## 📦 Install

Requires [Bun](https://bun.sh). There are no dependencies to install.

```bash
git clone https://github.com/souta-lab/nightq.git
cd nightq
bun run src/cli.ts --help
```

Optionally alias it:

```bash
alias nightq="bun run $PWD/src/cli.ts"
```

## 🚀 Quick start

```console
$ nightq init
Created QUEUE.md
Created stream-log.md

$ nightq add "Write the release notes" --note "Draft lives in docs/draft.md"
Added #1: Write the release notes

$ nightq add "Fix the flaky parser test"
Added #2: Fix the flaky parser test

$ nightq claim 1
Item 1 claimed: Write the release notes

$ nightq watch
OK: 1 item(s) in DOING, no update for 0m

$ nightq done 1 --note "Published as v0.1.0"
Item 1 done: Write the release notes

$ nightq block 2 "Waiting on CI quota"
Item 2 blocked: Fix the flaky parser test

$ nightq list
1. [DONE] Write the release notes
2. [BLOCKED] Fix the flaky parser test
— 0 todo, 0 doing, 1 done, 1 blocked
```

The resulting `QUEUE.md`:

```markdown
# Queue

The single work list. A watcher monitors this file; workers take items top-down.
One item = one deliverable. States: TODO / DOING / DONE / BLOCKED (with a reason note).

## Items

1. [DONE] Write the release notes
   - Draft lives in docs/draft.md
   - Published as v0.1.0
2. [BLOCKED] Fix the flaky parser test
   - BLOCKED: Waiting on CI quota
```

And `stream-log.md`:

```markdown
# Stream Log

- [23:41] Queue initialized
- [23:41] Item 1 added: Write the release notes
- [23:41] Item 2 added: Fix the flaky parser test
- [23:41] Item 1 claimed: Write the release notes
- [23:41] Item 1 done: Write the release notes
- [23:41] Item 2 blocked: Fix the flaky parser test — Waiting on CI quota
```

## 🛠 Commands

| Command | Description |
| --- | --- |
| `nightq init` | Create `QUEUE.md` and `stream-log.md` if missing (never overwrites) |
| `nightq add "<title>" [--note <text>]` | Append a `TODO` item |
| `nightq list` | Print all items and a state summary |
| `nightq claim <n>` | Mark item *n* as `DOING` |
| `nightq done <n> [--note <text>]` | Mark item *n* as `DONE`, optionally adding a note |
| `nightq block <n> <reason...>` | Mark item *n* as `BLOCKED` with a reason note |
| `nightq log "<message>"` | Append a timestamped entry to the stream log |
| `nightq watch [--stall <dur>]` | Stall detection (see below) |

Global flags `--queue <path>` and `--log <path>` can appear anywhere and override the default file locations, so one directory can host several queues.

## ⏱ The watch command

```console
$ nightq watch --stall 20m
STALLED: 1 item(s) in DOING, no update for 40m
$ echo $?
1
```

`watch` considers the queue "updated" at the **newer** of:

- the queue file's modification time, and
- the latest `- [HH:MM]` timestamp in today's stream log.

If at least one item is `DOING` and the last update is older than the threshold, it prints `STALLED` and exits `1`. In every other situation (including "nothing is DOING") it prints `OK` and exits `0`. Durations accept `20m`, `90s`, `1h`, or a bare number of seconds. Drop it into a cron job or a heartbeat loop and alert on the exit code — that's the whole integration.

## 📄 File format

Items are numbered lines; notes are indented sub-bullets; a block reason is a note prefixed with `BLOCKED: `.

```markdown
N. [STATE] title
   - a note
   - BLOCKED: the reason, for BLOCKED items
```

`STATE` is one of `TODO` / `DOING` / `DONE` / `BLOCKED`. Parsing is tolerant: headings, prose and blank lines anywhere in the file are preserved verbatim on rewrite, and item numbers are re-sequenced in file order. You can edit the queue in your editor mid-run; the CLI will not fight you.

## 🧩 Design

- **Zero dependencies.** Only Bun/Node built-ins. `bun test` runs the full suite (18 tests).
- **Files over processes.** All state is in the two markdown files; every command is a short-lived process that reads, mutates, and writes.
- **Library first.** `src/queue.ts` holds the parsing, state transitions and stall logic; `src/cli.ts` is a thin entry point, so the behavior is unit-testable without spawning the CLI.

## 🔧 Development

```bash
bun test          # run the test suite
bun run src/cli.ts --help
```

## 📜 License

[MIT](./LICENSE)
