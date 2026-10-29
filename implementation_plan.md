# Paintify Web revised scope

User scope correction: remove the added visual-effects feature from PR #1. Keep painting-style ideas for discussion, without implementing replacements.

- Restore original painting shaders, pipeline, style registry, uniform layout and style-block serialization.
- Remove added effects controls, parameters, tests and documentation.
- Keep the smoothing off/on and saved-switch fixes.
- Keep video capability negotiation, export cancellation/cleanup, camera recording, mobile settings and accessibility fixes.
- Verify JavaScript/helper tests and full shader/Wasm/browser CI, then refresh localhost with the rebuilt preview.
