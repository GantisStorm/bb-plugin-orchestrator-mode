---
name: setup-jev
description: "Use only when the user explicitly asks to store or replace the OpenRouter key for orchestrator mode's advisory judge. Opens BB's secure setup prompt with `bb orchestrator-mode setup-jev`; never collects a key in chat, a CLI argument, a file or a log."
---

# Set up the advisory judge key

This skill stores the OpenRouter key the orchestrator mode advisory judge uses.
It is a manual, user-invoked flow: run it when the user asks to set up, store or
replace that key, not on your own initiative and not as part of enabling the
judge.

## The one command

```
bb orchestrator-mode setup-jev
```

Run that command exactly as written, with no key argument. It opens a secure
prompt in BB (renderer `setup-jev`) with a masked field, a Show/Hide control,
and explicit **Save key** and **Cancel** buttons. The key is typed only into
that field and stored in the plugin's owner-only file.

- **Save key** stores or replaces the one key.
- **Cancel** closes the prompt and leaves any existing key exactly as it was.
- The prompt never displays a stored key; it can only tell you whether one
  exists. The command prints no key and returns no key.

There is one stored key for this plugin. Do not create a second one, a copy in a
file, or a per-project key.

## Never handle the credential

- Never ask the user to paste the key into chat, a prompt, a message, a
  terminal argument, an environment variable, a file, or a commit.
- Never run a command that takes the key as an argument. The setup command
  accepts none; do not invent `--key`, `--token` or a piped secret.
- Never echo, log, quote, screenshot, summarize or repeat the key, and never put
  it in a tool call. If it appears anywhere in output, do not copy it forward.
- Do not read the secret file. The key is readable only by the plugin backend.

If the user offers a key in chat, do not use it. Tell them to run
`bb orchestrator-mode setup-jev` and type it into the prompt instead. If the
prompt cannot open, the user must attach a BB UI before setting the key.

## After the prompt closes

The key alone sends nothing. The advisory judge is a separate, explicit opt-in:

```
bb orchestrator-mode scope --global --judge-advisory on
```

Use the project form instead when the user wants the opt-in only there:

```
bb orchestrator-mode scope --project <id> --judge-advisory on
```

`bb orchestrator-mode status` shows whether a key is configured and whether the
scope opted in. The judge never records a verdict, blocks a unit or stops a
turn; it appends advice to a check unit's report. It is sent only the check's
bare verdict and the names of the allowlisted programs the report says it ran —
no arguments, paths, headers, file contents or output. Opt in only when the
user asks for it; a stored key is not consent to turn the judge on.

To turn the judge off without deleting the key:

```
bb orchestrator-mode scope --global --judge-advisory off
```
