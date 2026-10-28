# Approved implementation checklist

- [x] Luna audits and Terra planning review; user approval received.
- [x] Preserve smoothing amount and look state.
- [x] Add video negotiation/abort helpers and harden export/recording lifecycle.
- [x] Implement three deterministic experimental GPU algorithms and old-look compatibility.
- [x] Integrate default-off Experimental controls and direction applicability.
- [x] Correct keyboard/accessibility and mobile interaction states.
- [x] Run focused tests and full Linux shader/Wasm/browser validation.
- [x] Inspect desktop/mobile and decoded video output.
- [x] Complete Terra integrated review and address findings.
- [x] Update documentation and architecture notes; deliver reviewable draft PR #1.

Verification source: `edaeb5b`, GitHub Actions run `40764358296`, all steps passed. Shader/Wasm build, six helper tests, rendered smoothing/look/experimental regressions, all 24 brush renders, basic float fallback and browser/export/recording checks passed with no console errors. Downloaded MP4: 24 frames at estimated 24 fps, 720×480, 1 second, 544989 bytes; decoded mean 115.55 and variance 2655.46 (nonblack/nonflat). Camera MP4: 304916 bytes. Root live IAB visual review passed desktop 1440×900, mobile 390×844, all three experimental algorithms, off/default state and disabled controls; the initially noisy hatch was corrected to coherent fixed 45°/135° families and visually rechecked. Terra reviewed the final hatch diff with no remaining blocker.

Screenshot QA found 500ms waits could capture a previous painting on SwiftShader. UI tests now instrument only the test server's app response to await the actual paint pump; application source stays unchanged. Corrected screenshots are being regenerated. Immediate UI cancellation and bounded seek abort helper tests pass; cancellation during device/source loss and camera decode/rapid restart remain coverage gaps.
