# Screenshot notes

Real BB renders, captured on 1 October 2026 with this plugin installed from
this checkout (`bb plugin install path:$PWD`).

Each image is a full browser viewport at 1440×900 CSS pixels, device pixel
ratio 2, so the files are 2880 px wide. Nothing was drawn, mocked or composited.

| File | Surface |
| --- | --- |
| `orchestrating-thread.png` | A thread in orchestrator mode: two finished worker threads, a third `orchestrator_delegate` call running, and the status strip above the composer. |
| `direct-work-caught.png` | The same thread after the watchdog recorded direct work. The strip shows the violation count and detail, and the agent's next line is a delegation. |
| `new-thread-default.png` | The root new-thread composer with the "new threads start as orchestrators" default on, and the `Orchestrator mode` row in the `+` menu. |

The demo runs in a throwaway project (a single-file Node to-do CLI) on a fresh
worktree, so only committed files were visible to the threads. The brief asked
for due dates, a `stats` command and tests; the workers produced them and the
watchdog recorded one command the parent ran itself.

## Edits made before saving

- The thread sidebar was collapsed in all three captures, so no other project
  or thread title appears.
- `new-thread-default.png`: the Playbooks panel below the composer (another
  plugin's section) was hidden with `display: none`.
- `direct-work-caught.png`: the Recap card above the strip (another plugin's
  section) was hidden with `display: none`.
- No text was added, changed or invented, and no other element was removed.

## To refresh

1. Create a worktree thread in a throwaway project with the default on:
   `bb orchestrator-mode default on`, then
   `bb thread create --project <id> --new-environment worktree --provider claude-code --model claude-sonnet-5 --permission-mode auto --title <title> --prompt-file <brief>`.
2. Drive BB headless (see the `browser-automation` skill), collapse the sidebar,
   and wait until the timeline shows the delegations.
3. To capture a violation, ask the thread for one small fix "yourself, no
   worker" in guard mode, then wait for the strip to update.
4. Hide the Playbooks and Recap panels as listed above, save at full resolution,
   then turn the default off again: `bb orchestrator-mode default off`.

Never capture a live user's conversations or project details. Close the
isolated browser session after saving the images.
