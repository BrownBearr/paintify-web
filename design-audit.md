# Paintify Web audit — 2026-10-28

Read-only source audit by Sol with two user-requested Luna agents. No application code changed. Root browser audit successfully loaded deployed main and rendered the coffee sample at 1200×800 (19,763 strokes); narrow viewport around 406px wraps the toolbar into two rows and leaves a long scrollable settings area. Local future changes have not yet been built or visually tested.

## Confirmed and inferred findings

- Confirmed setting-loss defect: `src/web/main_web.cpp:204` mutates stored tensor sigma to zero on off renders; on restores only 0.1. Preserve stored sigma using temporary effective render parameters. UI range minimum is 0.5 (`web/app.js:668`). This is a source-confirmed defect; the exact user's Follow image reproduction remains unknown.
- Follow image selector (`web/app.js:657`) is correctly mode zero in `shaders/stylefield.comp:63`; the shader applies procedural blending only to modes 1–5. Pattern strength 1.00 does not override mode zero. Low-confidence pixels deliberately use a fallback. Disable irrelevant Pattern strength and Swirl controls and explain the distinction.
- Video export exists (`web/app.js:362`), uses WebCodecs and in-memory MP4 muxing, omits audio, guesses frame rate and tests only three exact codec profiles. Camera uses MediaRecorder MIME negotiation (`:310`) and may produce WebM. User failure could be capability-dependent; not reproduced yet.
- Encoder and muxer setup occurs before the export try/finally; source/settings changes are not locked against export; seeks have no timeout; recorder streams are not explicitly stopped. These are concrete robustness risks to address.
- CSS-disabled slider fields remain keyboard-operable (`web/style.css:174`, slider refresh `web/app.js:511`). Ranges already have aria-labels; associate visible labels rather than falsely claiming no accessible names. View tablist has incomplete tab semantics (`web/index.html:29`); menu triggers lack expanded state. Notice/loading need meaningful live status semantics.
- Existing local fonts, coherent light/dark palette, compact creative-tool workspace and focus CSS should be retained. Avoid decorative redesign that reduces painting space. Enlarge mobile touch targets, improve settings reachability, and verify light/dark and short viewports.
- Existing style registry has 24 historical material recipes. Web brush selection applies material fields only. Adding named brushes alone would not implement new painting algorithms; add a separate explicit Experimental group.

## Research supporting proposed additions

- [Praun et al., Real-Time Hatching](https://gfx.cs.princeton.edu/pubs/Praun_2001_RH/) — foundational tone-dependent hatch techniques. Proposed implementation is a small deterministic image-space approximation, not the paper's full tonal art map system.
- [Real-Time Pen-and-Ink Illustration in Image Space](https://www.cs.ubc.ca/~heidrich/Projects/Hatching/) — image-space illustration and line coherence context.
- [Ulichney, Digital Halftoning, MIT Press](https://doi.org/10.7551/mitpress/2421.001.0001) — halftoning reference; proposed CMYK effect uses separate rotated ink screens.
- [Achanta et al., SLIC Superpixels](https://www.cs.jhu.edu/~ayuille1/JHUcourses/VisionAsBayesianInference2022/4/Achanta_SLIC_PAMI2012.pdf) — comparison for boundary-adhering region methods. Proposed fast Voronoi mosaic is deliberately simpler and must not be called SLIC.
- [W3C WebCodecs](https://www.w3.org/TR/webcodecs/) — codec configuration/support and encoding lifecycle; supported API does not guarantee a particular encoder configuration.
- [W3C MediaStream Recording](https://www.w3.org/TR/mediastream-recording/) — MIME negotiation and recording/resource limits.
- [Canvas captureStream](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream) — canvas capture output and origin-clean restriction.

## Verification state

Terra review confirmed additional implementation hazards: extending StyleParams must retain legacy exact-length look parsing; `styles.cpp` compares the trailing style bytes for brush classification; neighborhood postprocessing cannot read from an image concurrently written by other invocations; export setup must enter cleanup protection before allocating resources; camera stop callbacks must capture session ownership rather than mutable global source/name/display state. Windows URL pathname handling also affects `web/test/run.mjs` and `web/tools/build_shaders.mjs`.

Existing `web/test/ui.mjs` covers a 24-frame export download size and camera recording download size, but does not validate decoded output, cancellation or capability failures. Existing CI builds shaders/Wasm and tests brush rendering on Linux. Native build tools are absent from current Windows PATH. No local build/test pass is claimed.
