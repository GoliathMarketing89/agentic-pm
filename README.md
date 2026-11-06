# Agentic PM

**A daily board organized by you and your agents.**

Agentic PM is a personal project manager built around a simple division of work: you arrange the board and decide what matters; your agents help keep the projects up to date.

Put projects into movable islands, nest related work, and pin what you want to focus on today. When the details get stale, ask an agent to walk through three or four projects at a time. Type or dictate a brain dump, skip the projects that haven't changed, and let the agent save the updates through the local MCP connector.

Everything runs on your computer. There is no application account or hosted service to sign up for.

## Your overview, your arrangement

- Move islands freely on the whiteboard, with alignment guides and gentle snapping. Tidy up offers grid, row, column, alignment and spacing presets.
- Double-click an island to focus on it. Return to the previous overview when you're done.
- Switch between Board and List. Open all or close all for a quick overview.
- Save named views with your camera position, filters and open islands. Pin projects without moving them out of their usual home.
- Keep a current task, notes and important links on each project. Use Needs you to flag the work asking for your attention.

Projects support nested sub-projects, inline editing, update history and ten steps of shared undo. Archive finished work for later. Deleted projects can be restored for seven days.

## Agents help with the upkeep

The bundled skills work with an agent connected to the `project_list` MCP server:

| Skill | What it does |
| --- | --- |
| **Board update** | Reviews projects in batches of three or four, saving your updates and skipping the rest. |
| **Project capture** | Turns a brain dump into projects and sub-projects, using existing entries where appropriate. |
| **Daily focus** | Reviews priorities and helps pin the projects you choose for today. |

Start with: **“Use board-update to review my active projects. I'll dictate updates or say skip.”**

Voice input comes from your agent client's dictation or transcription. The board itself does not record audio. Agents use revision checks to avoid overwriting newer changes, and preserve existing notes when adding context.

## Run it locally

Install **Node.js 24 or newer**, then:

```sh
git clone https://github.com/GoliathMarketing89/agentic-pm.git
cd agentic-pm/project-list
node server.mjs
```

Open **http://127.0.0.1:4173/**. Your first board starts empty. No npm packages are required.

On Windows, you can also double-click **Start Project List.cmd** in the repository root. The launcher looks for Node on your PATH, with a fallback to an existing Codex runtime. **Stop Project List.cmd** stops a server started by that launcher.

## Connect an agent

Add a local stdio MCP server to your agent client:

- **Name:** `project_list`
- **Command:** the path to your Node 24+ executable, or `node`
- **Argument:** the absolute path to `project-list/mcp-server.mjs` in this checkout

The server and browser use the same SQLite database. Reconnect your client after changing its configuration, then ask it to read the board before making changes. In the app, **Agent skills** provides the skill bundle and installation guide. See [the skill guide](project-list/agent-skills/README.md) and [connector reference](project-list/MCP.md).

An agent running on another computer or in the cloud needs a separately configured connection to this board. Its localhost is a different machine; installing a skill alone does not connect it.

## Your data

Projects live in `project-list/data/projects.sqlite`, which is excluded from Git. SQLite and backup files are ordinary local, unencrypted files. Use the app's backup menu to export or import a JSON backup when moving between computers. Import replaces the destination board; it is not a synchronization or merge service.

Saved views and camera preferences stay in the browser. Project content, pins and island positions are shared with your connected local agent. The server binds to loopback and is intended for one user's computer, not public hosting or multi-user access.

## Development

```sh
cd project-list
node --test tests/*.test.mjs tests/*.test.ts
```

The app uses browser JavaScript, Node's HTTP server and built-in SQLite. After editing the skill sources, rebuild the downloadable bundle with `project-list/scripts/package-agent-skills.ps1` in PowerShell.

See [CONTRIBUTING.md](CONTRIBUTING.md) for a few development conventions.

## License

[MIT](LICENSE). Built by Goliath Marketing.
