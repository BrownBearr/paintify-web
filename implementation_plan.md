# Paintify Web implementation plan — approved

Repository: `C:\Users\I3row\AI-Work\ChatGPT\paintify-web`.
Status: user approved and implementation completed on 2026-10-28. Application source `edaeb5b` passed full CI run `40764358296` and final Terra review. Regenerating UI screenshot evidence with paint-completion waits; see `task.md` and PR #1 for final validation.

## Findings and scope

- Keep the existing vanilla JS/CSS, C++/WebAssembly and WebGPU shader architecture, fonts, palette and painting-first workspace. Apply focused usability corrections, not a framework or brand rewrite.
- Confirmed source defect: `src/web/main_web.cpp:204` destroys the stored smoothing amount by writing zero into `g_params.tensorSigma` whenever Smooth directions is off. Enabling then uses 0.1, below the UI minimum 0.5. Preserve requested settings separately from effective render parameters and initialize a valid amount on first enable.
- Follow image is a direction selector, not a switch. Mode zero uses image flow with low-confidence fallback; Pattern strength does not affect that mode. No reproduced evidence that its shader is broken. Clarify this behavior and disable inapplicable Pattern/Swirl controls; verify the user's reported behavior as part of regression coverage.
- Video output already exists: files export silent MP4 using WebCodecs; camera records via MediaRecorder as MP4 or WebM. Improve availability, negotiation, failure handling and discoverability rather than duplicate this pipeline. The exact user-reported export failure has not been reproduced.
- The current brush list applies brush material only (`applyBrushTexture`), not complete algorithmic recipes. Experimental algorithms must have their own explicitly gated selector.

## Planned files

### [MODIFY] `src/web/main_web.cpp`
- Render using a temporary `TuningParams` copy so smoothing off/on retains the requested sigma; use a UI-valid initial sigma when enabling a zero-default setting.
- Expose experimental settings through the existing named field bridge, without changing existing brush selection semantics.

### [MODIFY] `web/app.js`, `web/index.html`, `web/style.css`
- Add an explicit Experimental toggle, off by default, with a separate algorithm selector and concise experimental/performance explanation. Turning it off bypasses experimental output immediately; retain its last selection for the session. Loaded looks that enable it visibly disclose the state.
- Bind Follow image/Swirl/Pattern controls to their actual applicability; keep smoothing amount consistent across renders and toggles.
- Use real disabled states for unavailable controls; retain existing range aria-labels and associate visible labels. Replace incomplete tab semantics with a correctly announced exclusive view selector. Add menu expanded state, Escape/outside-close and keyboard navigation; accessible live notices/progress, focus visibility and reduced-motion support.
- Improve narrow-screen toolbar/settings reachability and touch targets while preserving a useful painting stage; verify 390px mobile and 1440px desktop layouts, plus short landscape viewport.
- Probe video capabilities for the selected dimensions; add broadly compatible H.264 configurations before alternate supported codecs, expose whether export is available and why, and preserve actual MIME/filename for camera recording. For browsers without viable frame export, explain the capability limit instead of promising an unsupported result.
- Put encoder, muxer, display, stream and canvas setup/cleanup inside safe lifecycle handling. Serialize export against the paint pump; disable source/settings operations that would race it, keep cancellation available, restore playback/UI after completion/cancellation/error. Use bounded seek waits and encoder backpressure/error checks so export cannot hang indefinitely.
- State video constraints in the UI: silent output, estimated frame rate (currently 10–60fps, fallback 30), processing may be slower than playback, encoded file buffered in memory. Show progress/cancel; do not claim original audio/frame timestamps are preserved.

### [MODIFY] `src/style.h`, `shaders/style.glsl`, `src/paramfile.cpp`, `src/pipeline.cpp`
- Add a vec4-aligned experimental setting block with zero/off defaults; keep host/shader layouts, static size checks and field serialization synchronized. Old looks retain existing output; new looks round-trip mode, scale and strength plus explicit gate.
- Preserve legacy saved looks explicitly: `paramfile.cpp` currently requires an exact style float count. Accept both the legacy size and the extended size, defaulting new fields off for old looks. Review `src/styles.cpp` tail comparisons so experiments cannot accidentally change brush classification.
- Ensure final experimental postprocessing runs whenever enabled, even with the classic brush or finish effects disabled, and that changes participate in render invalidation.
- Composite into the finished output, never into the temporal paint-history canvas. Gate-off returns the underlying painting without resetting unrelated settings.
- The overlay pass currently reads/writes the final image in place. Use distinct immutable input/output textures for any neighborhood sampling, with the existing WebGPU copy/barrier contract; do not sample adjacent pixels from an output being written concurrently.

### [MODIFY] `shaders/post.comp`
- **Crosshatch engraving:** tone-thresholded image-space line families, with additional cross-lines in shadows; use existing direction data conservatively and fixed image-space seeds for stable still/video texture.
- **CMYK screen print:** separate rotated cyan, magenta, yellow and black dot screens with subtractive overprint; distinct from the existing single Ben-Day dot overlay.
- **Voronoi mosaic:** deterministic jittered cells, representative source-color samples and dark cell seams; a lightweight mosaic approximation, explicitly not SLIC or a physically simulated stained-glass renderer.
- Offer one shared scale and strength control, bounded to keep GPU costs predictable. The algorithms are experimental artistic approximations, not claims of reproducing the cited papers.

### [MODIFY] `web/test/ui.mjs`, `web/test/run.mjs`, `web/tools/build_shaders.mjs`, `.github/workflows/web.yml` as required
- Correct file URL handling with `fileURLToPath` where needed for Windows test execution.
- Cover smoothing amount preservation and rendering after repeated off/on; Follow image versus Fixed angle and Swirl control applicability; actual native disabled states and keyboard view/menu interactions.
- Verify Experimental defaults off, each mode produces a visibly distinct nonempty output, gate-off restores the base result, legacy looks work, and experimental looks round-trip.
- Verify a short exported file downloads and decodes to painted nonblack frames with the expected duration/type; missing encoder, encoder failure, cancellation, source-change protection and camera MIME/cleanup paths recover correctly. Test fallback capability branches without pretending mocked encoding proves playback.
- Extend shader/renderer CI coverage only as required for these controls; keep unrelated existing brush regressions intact.

### [MODIFY] `README.md`, `docs/BUILDING.md`; [NEW] `task.md`, `system_architecture.md`
- Document experimental status and actual video formats/limitations; record supported workflow and completed verification, plus parameter/shader contracts for future maintenance.
- Create execution checklist after approval; update architecture notes after implementation.

## Validation and known limits

1. Build shaders and WebAssembly with the versions already specified by CI; run existing renderer suite and UI workflow, then focused regressions above.
2. Visually inspect desktop/mobile, light/dark, keyboard focus, empty/loading/error, image, playing video and export progress states; inspect each experimental style on the same reference image.
3. Confirm output downloads use the correct MIME and extension and decode to valid painting frames. Camera recording format is capability-dependent.
4. Native Emscripten, glslangValidator, spirv-cross and naga are absent from the current Windows PATH. Full validation will require isolated tooling under AI-Work or the existing Linux CI; no build pass is claimed at the audit stage. Browser audit of deployed main is not proof of future local modifications.
5. Audio preservation and exact variable-frame-rate remuxing are beyond the existing pipeline and this scoped export hardening. Very long/high-resolution exports remain constrained by encoder resources and in-memory muxing; surface errors honestly.

## Delegation and approval

User-requested Luna agents completed engine and design/research audits. User-requested Terra agent reviews this proposed approach before implementation and will check the implemented work afterward. Once this plan is approved, split engine/video and shader/UI work by ownership, integrate serially where files overlap, and run final Terra review before reporting completion. No push, deployment or PR is included in this stage.

Terra planning review completed: the plan incorporates its required legacy look compatibility, style-tail comparisons, safe shader input/output isolation, export session ownership, cancellation during seeks, camera track cleanup and Windows file URL handling. Execution ownership: Luna engine owns `src/web/main_web.cpp` smoothing and isolated video lifecycle helpers; Luna graphics owns shader/StyleParams/pipeline/serialization and algorithm regression coverage; Sol owns `web/app.js` integration, `index.html`, CSS, docs and shared test wiring. For shared files, helpers are integrated serially and only one writer owns a file at a time. Terra reviews the integrated result and regression evidence.
