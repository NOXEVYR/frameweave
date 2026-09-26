# FrameWeave development

- Display brand since 0.5.0: 棱光 PrismCanvas. Preserve the FrameWeave Python package, data directory, browser storage keys, schemas, MCP server name and API identity for compatibility. New Windows builds use PrismCanvas.exe. The selected E04 geometry lives in assets/frameweave.svg and web/brand.svg.

- Reply in Chinese for this project. This is an independently written lightweight AI canvas client.
- Never copy YUH Studio implementation, branding, advertisements, user history, configuration, or weights into this repository.
- Use Python 3.11+ standard library for the local HTTP service, plain ES modules/CSS for the canvas. No runtime npm dependencies.
- Keep all runtime user data outside the source tree; tests use temporary directories.
- Validation: `python -m unittest discover -s tests -v`; `node --test tests/*.test.mjs`; `python -m compileall -q frameweave`; `node --check web/app.js`.
- Bind only to loopback. Validate Host, Origin and CSRF token on writes. Backend connections are loopback-only in v0.1.
- Publish only source, documentation, a clean release archive and manifests. Never publish local model paths, user media, tokens, cache, or private inspection evidence.
- Do not claim generation quality/speed from protocol or mock tests. Report real GPU generation separately.
- Keep docs/DEVELOPMENT_LOG.md current with each change's scope, decisions, issues, validation evidence and outstanding limits. Record private paths, prompts and temporary runtime details only outside the public project tree.
- Workflow packages are data-only JSON with explicit scalar/image bindings; importing must never submit a job. Preserve stable package identity and old canvas compatibility, and validate live node schemas before generation.
- Package organization is local metadata; archival must preserve existing canvas references and exported content identity. Replay exact saved API graphs only on the original backend after fresh schema validation; retain request IDs and never resend an uncertain submission automatically.
- MCP uses stateless JSON Streamable HTTP at /mcp with the current startup Bearer token. Keep tool schemas consistent with compiler inputs. Preserve durable request IDs, cross-process locking and uncertain-submit guards; never log or export connection tokens. Protocol tests use the mock backend, not real GPU inference.
- Generation studio drafts are independent of the canvas and retained per model kind. Bind navigation clicks only to .workspace-nav, never the body data-workspace attribute. Keep frozen request parameters and IDs through not_found/unknown; only an explicit rejected response permits a new submission. Include `node --check web/generation-studio.mjs` when validating frontend changes.
- Canvas workflow edges bind explicit text/image fields. Execute only a frozen graph snapshot, persist each request before submitting, and use fresh upstream results from the same run. Preserve canvas identity and job mapping through undo/redo; never attach an old run to an imported canvas merely because node IDs match. Import/export collections is data-only and must not trigger generation. Preserve package raw JSON on unchanged round trips so existing content IDs remain valid.
