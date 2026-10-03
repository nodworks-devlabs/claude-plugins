# limit-meter

A band above the Claude Code prompt that shows, live:

- **5-hour**, **Weekly** and per-model weekly limits (e.g. **Fable**) as rings, with the time until each resets
- **this chat**: how many points of each limit this conversation used
- **Context**: the context window's fill, as `282k / 1M`
- on **high**: the project's total and the other chats and threads working in the same repository

```
◔ 5-hour 11%  this chat 1% · 3h 5m    ◑ Weekly 67%  this chat 0% · 3h 35m    ◕ Fable 75% …   │   ◔ Context 28%  282k / 1M
```

## Install

```
/plugin marketplace add nodworks-devlabs/claude-plugins
/plugin install limit-meter@nodworks
```

If `marketplace add` fails with `Permission denied (publickey)`, you have no SSH key for GitHub; add it over HTTPS instead:

```
/plugin marketplace add https://github.com/nodworks-devlabs/claude-plugins.git
```

Built against Claude Code **2.1.286**. It uses function hooks, which are early access and may change between releases. Sign in with a **Claude subscription** (Pro / Max / Team). With an API key there are no plan limits to show.

## Sizes

| | |
| --- | --- |
| `small` | one row, small rings |
| `medium` (default) | rings, this chat and the reset time |
| `high` | large rings with the percent inside, project total and threads |

Switch with `/limit-meter small`, `/limit-meter medium` or `/limit-meter high` (remembered across sessions), or set **Band size** in the plugin's settings.

The desktop app draws rings; the terminal shows the same figures as an aligned table, sized to the window's width.

## How "this chat" is counted

Plan limits are account-wide, so no API says what one conversation used. limit-meter keeps a shared ledger of the last reading of each limit. When a chat's own response moves a limit, the points gained since the last reading are credited to that chat. Points gained while every chat sat idle (usage on claude.ai, for instance) are credited to no one.

It is an estimate:

- Limits are reported in whole points, so a short chat can read 0%.
- Two chats working at the same moment can trade a point.
- "Project" means chats in the same git repository (or folder). A chat is marked as a thread when a coordinating session hands it work. This grouping is a heuristic.

## What it reads, writes and sends

- **Network:** about once a minute, shared by every open chat, one request to `https://api.anthropic.com/api/oauth/usage`, the endpoint Claude Code's own usage view reads. It goes through Claude Code with your session's credential; the plugin never sees the token. This endpoint is not a documented public API and may change; if it fails, limit-meter keeps showing the last good reading for up to 10 minutes, then falls back to the 5-hour and weekly figures Claude Code already has (no per-model limit). The cause of the last failure (an HTTP status, never a response body) is written to `last-error.json`.
- **Disk:** `~/.claude/limit-meter/` holds one small file per chat (the project path, the first 22 characters of its first prompt as a label, and its credited points), a shared `ledger.json` and a `reading.json` cache. For troubleshooting, `LIMIT_METER_DEBUG=1` makes it also write `events.log`: which event credited which limit. In the desktop app set it in `~/.claude/settings.json` as `"env": { "LIMIT_METER_DEBUG": "1" }`; in the terminal, in your shell.
- Nothing else leaves your machine.

## Known gaps

Not yet checked on: the terminal layout, the IDE extensions, the light theme, the thread list with real threads, narrow windows. Reports welcome.

## License

MIT
