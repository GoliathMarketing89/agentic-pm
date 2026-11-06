# Landing page copy

## Navigation

Agentic PM
The board · Agent workflow · Questions
Get it on GitHub ↗

## Hero

Personal projects. A shared view.

A daily board,
organized by you
and your agents.

A personal whiteboard for your projects. Talk through a few updates with your agent when things change.

Get Agentic PM on GitHub ↗
See how it works ↓

Free & open source · Runs on your computer

Preview caption: A real Agentic PM board, shown with example projects.

## Board walkthrough

Make the board fit the way you work.

Some projects belong together. Some need your attention today. Keep both in view without rearranging your whole life around a list.

01 — Give related work its own island.
Group projects and sub-projects, then move their islands wherever they make sense. Zoom out for the overview or focus on one island.

02 — Pin what's on your mind today.
Keep a project close without moving it out of its usual home. Unpin it when you're done.

03 — Pick up where you left off.
Save a view for the work you want to see. Your filters, open islands and camera come back with it.

## Agent workflow

Talk it through.
The board catches up.

With a connected agent, review three or four projects at a time. Type a brain dump or use your agent's dictation. Skip anything that hasn't changed.

01 — Connect your agent.
Use the local MCP connector with a compatible client, such as Codex or Claude Code.

02 — Tell it what changed.
The Board update skill shows your current tasks and asks about a small batch. Answer in any order.

03 — Keep the useful context.
Your agent saves the updates while preserving existing notes. Newer edits are checked before a change is applied.

Example conversation (explicitly a demonstration, not live chat):
Agent: Where do we stand on Website refresh, Newsletter, Photography site and Weekend garden?
You: Website copy is ready; design is next. Newsletter is unchanged. The photography site is waiting on images. Skip the garden.
Action: See the update →
After action: 2 updated · 2 unchanged
Website refresh — Design the page; copy is ready.
Photography site — Waiting on images.
Newsletter and Weekend garden — Left unchanged.
Reset action: Replay example

Visible outcome: Result: two projects updated. Two left unchanged.
Footnote: The example uses sample projects. Voice input comes from your agent client.

## Local setup

Free to use.
Yours to keep.

Agentic PM runs on your computer. Start with an empty board and make it your own. The source is MIT-licensed, with no app account or hosted subscription.

Quick start — Node.js 24+
git clone https://github.com/GoliathMarketing89/agentic-pm.git
cd agentic-pm/project-list
node server.mjs

Then open http://127.0.0.1:4173/ in your browser.

Setup guide on GitHub ↗

## Questions

What do I need to run it?
Node.js 24 or newer and a modern browser. The Windows launcher is included. Connect a compatible MCP agent when you want help filling out the board.

Can I use it without an agent?
Yes. Create projects, edit tasks and notes, and arrange the board manually. Agent skills add a conversational way to maintain it.

Is it free?
The application is free and MIT-licensed. Your chosen agent client or model provider may have its own charges.

Where do my projects live?
On your computer in a local SQLite database. Browser preferences stay in your browser. A connected agent handles model requests under its own settings; the board itself is not a hosted AI service.

Does it sync between computers?
Not automatically. Export a JSON backup and import it on another computer. Import replaces the destination board rather than merging the two.

Can I bring back something I removed?
Archived projects can be restored at any time. Deleted projects have a separate seven-day recovery window. The board also keeps up to ten eligible shared actions available to undo.

## Closing

Give your projects
a place to land.

Start with your next project. Bring your agent when you're ready.

Get Agentic PM on GitHub ↗
Free & open source · MIT license

## Footer

Agentic PM
A daily board organized by you and your agents.
GitHub · Setup guide · MIT license
Built by Goliath Marketing
