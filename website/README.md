# Landing page preview

Published: https://agentic-pm.powis-michael.chatgpt.site/

The existing Sites deployment checkout stores its Site identity in `.openai/hosting.json`. Reuse that identity for updates. Only static landing-page files are deployed.

From the repository root, run:

```sh
node website/preview.mjs
```

Open http://127.0.0.1:4192/. The page is static HTML, CSS and a small enhancement script, with no install or build step. It can be hosted as the contents of this directory after review. The preview server is local-only and is separate from the project-board server on port 4173.

The product image in `assets/board-preview.jpg` was captured from the actual application using synthetic sample projects. It contains no personal board data. The example conversation is a demonstration, not a live agent connection.

`design.md` records the approved outline and references. `copy.md` records the copywriting brief's page copy. The page's canonical and Open Graph URLs use the published origin.
