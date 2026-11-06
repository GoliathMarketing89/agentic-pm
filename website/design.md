# Agentic PM landing page

## Approved direction

The user approved the outline and reference direction on 6 November 2026: minimalist phthalo green and warm ivory, real board preview, board walkthrough, agent brain-dump example, local/MIT setup and FAQs, and a GitHub call to action. Build a reviewable local preview before publishing the site.

Goal: help visitors understand the board and get the source/setup instructions at https://github.com/GoliathMarketing89/agentic-pm. No sign-up, sales form, paid plan, or invented social proof.

## Copywriting brief and decisions

Offer: MIT-licensed, local-first personal project manager with whiteboard and local MCP connector. Application code is free; agent providers can have separate charges. Audience: people juggling personal/client projects who already use coding agents. Channel: public product landing page. Desired action: get the source from GitHub. Voice: plain, warm, specific and restrained.

Position: solution-aware visitors know boards and agents; demonstrate the division of work. Dominant desire: control of the work without maintaining a second administrative job. Mechanism: humans arrange the overview; connected agents turn a short batch conversation into saved project updates.

Arc: product promise → visible proof → personal organization → agent walkthrough → practical setup/objection answers → GitHub action. Nav serves visitors ready to install; the closing CTA follows explanation. No invented urgency, adoption counts, testimonials or productivity percentages.

## Approved references

The shared library was checked before browsing. The user approved these references and borrow decisions:

- Nav, hero, product preview, feature hierarchy and closing CTA: https://linear.app/ — product-first typography, quiet nav, concrete interface proof. Borrow hierarchy and restraint, not branding, assets, wording or gradients.
- Numbered board/agent walkthrough: https://hookagency.com/ — distinct numbered steps with verb-led headings. Borrow process legibility, not service-business styling or copy.
- Setup and FAQ: continue Linear's editorial hierarchy and the library's plain objection-led FAQ approach. Native disclosure rows. One honest MIT/free statement rather than manufactured pricing tiers.

## Visual system

Use app tokens: phthalo #103C34 / #123F35, ivory #F6F4EF, card #FFFDF8, text #173F35, muted #586B62, line #D5DAD0. Dark green frames hero and agent walkthrough; ivory carries longer reading. Cream CTAs on dark, green CTAs on light. Warm accent for focus only.

System sans-serif with expressive size and spacing. Large left-aligned hero, generous whitespace, slim rules, limited radii. Avoid generic bento tiles, floating badges, decorative grids, gradients and stock images. The visual asset is the actual app running with synthetic projects, never the owner's board.

Static HTML/CSS with small progressive-enhancement JS; no dependencies or build step. Core content/links/FAQ remain usable without JS. Motion only short opacity/transform transitions, with reduced-motion support.

## Verification

Check desktop/mobile, keyboard, FAQ, example advance/reset, copy feedback, destinations, overflow, semantics, contrast and reduced motion. Independent screenshot-only design critique against approved references: revise to independently earn 9/10+, then present human preview before publishing.

## Verification results — 6 November 2026

- Browser checked at desktop 1280px and mobile 390, 375 and 320px. No horizontal document overflow; narrow screenshots include a 15px scrollbar area. Mobile preview deliberately crops the real app image to show a readable island.
- Example advance/replay, command copying, anchor destinations and FAQ mouse/Space-key controls verified. Image loads; no browser console errors. Core content and native FAQ do not require JavaScript. Skip target is programmatically focusable; reduced-motion disables smooth scrolling.
- Local HTTP checks: page, CSS, JS and image return 200; HEAD works; source notes/path traversal and unsupported methods return 404. Both scripts pass Node syntax checks.
- Existing app regression suite: 66/66 pass with localhost access. Initial restricted execution could not complete HTTP tests; unrestricted rerun passed without application code changes.
- Initial independent design critique scored 7.8/10. Revised hero height, mobile image crop, section spacing, visible demo result and explicit header GitHub destination; requested a second screenshot review.

## Conversion review

The installed resource lists highlights rather than a numbered full 25-point rubric. This is the page-specific 25-check audit, not a claim to reproduce an unavailable rubric. No paid offer, lead form, testimonials or urgency were added to manufacture compliance.

1. Clear product headline: pass.
2. Above-fold description explains personal whiteboard: pass.
3. Prominent primary GitHub action: pass.
4. Action destination and free/local offer clear: pass.
5. Requested agent/project-manager message matches the page: pass.
6. Real application proof: pass, synthetic data labelled.
7. Mobile product proof readable: pass, focused image crop.
8. Benefits precede implementation details: pass.
9. Three concise organization features: pass.
10. Agent process explained in numbered steps: pass.
11. Agent example outcome visible: pass.
12. Interactive example is labelled as an example: pass.
13. Repeated primary action after explanation: pass.
14. Secondary action offers lower-commitment walkthrough: pass.
15. No competing signup or paid conversion: pass.
16. Price/license clear: pass, MIT/free.
17. Agent-provider costs addressed honestly: pass.
18. Setup requirements stated: pass, Node 24+.
19. Setup instructions actionable: pass, copyable commands.
20. Practical objections answered: pass, six FAQ rows.
21. Local storage and sync limits disclosed: pass.
22. Recovery behavior stated accurately: pass.
23. No invented social proof, results or urgency: pass.
24. Reading hierarchy, whitespace and contrast: pass; phthalo/ivory and muted supporting text.
25. Mobile actions, keyboard controls and no-JS content: pass.

Final screenshot-only critique: 8.8/10; critic reported no remaining concrete visual blockers. Added a visible changed-field example, cropped the toolbar to expose project content sooner, tightened mobile spacing and added a keyboard-accessible command area with scrolling instructions. The skill's 9/10 critic threshold has not been met, so this remains a local review preview rather than a release-ready publication. Publication also requires the owner's visual review.

Subsequent owner review: the user approved the preview and explicitly requested publication despite the disclosed 8.8 score. Published version 1 through Sites on 6 November 2026 at https://agentic-pm.powis-michael.chatgpt.site/. Public access confirmed; deployment succeeded and the live page was opened and visually verified. Source commit: 236f734a1f4a232d4e9e5cb99b2e0693d00c67d1 in the separate Sites checkout.
