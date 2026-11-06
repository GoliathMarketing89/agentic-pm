# Agentic PM application

Start with the [repository README](../README.md) for setup and a tour of the board.

Run `node server.mjs` here with Node 24+, then open http://127.0.0.1:4173/. Stop a terminal-started server with Ctrl+C. The Windows launcher in the parent folder starts a hidden server and records it for the matching Stop launcher.

The database is `data/projects.sqlite`. The app makes local safety copies; use the backup menu for portable JSON export and import. Import replaces this computer's board. Keep independent backups for device loss. Saved views and camera settings live in this browser, while project content and layout positions are shared with the connector.

The [connector reference](MCP.md) lists the agent tools. The [bundled skills guide](agent-skills/README.md) explains installation and the Board update, Project capture and Daily focus workflows. Agent clients must connect to this computer's MCP server before they can save changes.

Archive preserves projects indefinitely. Delete uses a separate seven-day recovery window. Undo reverses the latest eligible shared action, with up to ten retained steps; history shows earlier updates. Browser camera movements and saved views are local preferences rather than shared undo steps.
