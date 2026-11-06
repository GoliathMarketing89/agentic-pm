# Agent skills for the project board

These three SKILL.md folders provide repeatable workflows for an agent connected to this board:

| Skill | Ask your agent |
| --- | --- |
| Board update | “Use board-update to review my active projects in batches of three or four. I'll dictate updates or say skip.” |
| Project capture | “Use project-capture to organize this brain dump into projects and sub-projects.” |
| Daily focus | “Use daily-focus to review what needs me and help pin today's priorities.” |

## Install and connect

1. Download and extract the skill bundle. Keep each named folder and its SKILL.md together.
2. Ask your coding agent to install those folders in its supported skills directory. Codex and Claude clients that support SKILL.md skills can use these instructions; skill installation and invocation depend on your client. You can also ask an agent to read a specific SKILL.md directly without installing it.
3. Attach a local stdio MCP server named `project_list`. Its command is `node`; its argument is the absolute path to this application's `project-list/mcp-server.mjs`. The host needs Node 24 or newer. Use your client's MCP configuration workflow. Keep the application files and database on the same PC. The server does not require the browser window to remain open.
4. Verify that the agent can discover `list_projects` and read your actual board before asking it to update anything. Existing configured clients may only need to reconnect. Then use one of the prompts above, or the skill name offered by your client.

If using the installed skill picker in Codex, the bundled names are `board-update`, `project-capture`, and `daily-focus`. A request to read the downloaded SKILL.md works when a client's picker does not expose it.

Typed replies and host-provided voice dictation both work. The skills themselves do not add a microphone or speech service to the board. Skip/stop are supported by the update walkthrough. Skills save through the connector, so history, revisions, existing undo, and deletion recovery rules remain the same.

A remote/cloud agent needs an explicitly configured connection to this PC's board. Its localhost is a different machine. Downloading a skill alone does not establish that connection, and this bundle does not expose the database publicly. If disconnected, the agent should retain your words as unsaved drafts.

Saved views and camera/expansion preferences belong to the browser. Shared projects, island positions, and pins belong to the connector. More details for maintainers are in `project-list/MCP.md` in the application checkout.
