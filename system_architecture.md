# Paintify Web contracts

- Keep the original 260-float StyleParams/GLSL uniform layout and saved-look format. Painting rendering stages remain unchanged.
- Keep requested smoothing sigma in g_params; render through a temporary copy with effective zero when disabled. Browser saved looks add an ordinary # paintify-tensor-on=0/1 comment to retain switch state independently of amount. Old files without the comment retain sigma-based behavior.
- web/video-export.js owns codec negotiation, bounded abortable seeks and encoder backpressure. The app owns the export session, locks source/settings changes, waits for active painting, and restores controls in finally.
- File export emits silent MP4 at an estimated constant frame rate and buffers encoded bytes in memory. Camera recording captures its session resources locally and stops canvas-stream tracks after completion.
- Display.destroy releases its uniform buffer/context without destroying borrowed source textures.
- CI builds shaders/Wasm and tests smoothing/look retention, all existing brushes, optional GPU-feature fallbacks, mobile/keyboard controls, real MP4 decoding and camera recording. Camera tests use a fresh browser/default look with actual recorder-chunk readiness.
- The user requested removal of the added visual effects from PR #1. Further painting ideas are discussion/research only until separately selected for implementation.
