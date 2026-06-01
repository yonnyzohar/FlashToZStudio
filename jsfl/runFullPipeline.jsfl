// runFullPipeline.jsfl
//
// One-click automation:
//   1. Starting at the root scene, selects all layers and runs
//      unifyKeyframesToFirstSymbol.jsfl so every layer holds a single MC
//      across all its keyframes.
//   2. Recurses depth-first into every unique MovieClip referenced on stage
//      and repeats the unify step for each one's internal timeline.
//      A "leaf" node — a MC whose only content is a single bitmap on a single
//      keyframe with no further animation — is recognised and skipped.
//      Each unique MC is processed at most once (shared symbols are safe).
//   3. Once the entire symbol hierarchy has been unified, runs
//      convertLibraryToMovieClips.jsfl to normalise types and linkage for
//      the whole library.

(function () {

    var doc = fl.getDocumentDOM();
    if (!doc) { fl.trace("No document open."); return; }

    var lib        = doc.library;
    var scriptsDir = fl.scriptURI.replace(/[^\/]+$/, "");
    var unifyScript   = scriptsDir + "unifyKeyframesToFirstSymbol.jsfl";
    var convertScript = scriptsDir + "convertLibraryToMovieClips.jsfl";

    // ── helpers ──────────────────────────────────────────────────────────────

    function findLibItem(name) {
        for (var i = 0; i < lib.items.length; i++) {
            if (lib.items[i].name === name) return lib.items[i];
        }
        return null;
    }

    // A "leaf" MC has no MC/Graphic instances anywhere in its timeline —
    // either a single bitmap instance or purely vector shapes.
    // No need to recurse into leaves; doing so can corrupt shape content.
    function isLeaf(item) {
        if (!item || !item.timeline) return true;
        var tl = item.timeline;
        // Classic leaf: single layer, single keyframe, single bitmap instance.
        if (tl.layers.length === 1) {
            var layer = tl.layers[0];
            var kfCount = 0;
            for (var i = 0; i < layer.frames.length; i++) {
                if (layer.frames[i].startFrame === i) kfCount++;
            }
            if (kfCount === 1) {
                var elems = layer.frames[0].elements;
                if (elems.length === 1 &&
                    elems[0].elementType === "instance" &&
                    elems[0].libraryItem  &&
                    elems[0].libraryItem.itemType === "bitmap") return true;
            }
        }
        // Shape-only leaf: no MC/Graphic instances in any layer or frame.
        // These symbols are pure vector artwork; unifying them is a no-op and
        // calling lib.editItem on them can corrupt their content.
        for (var li = 0; li < tl.layers.length; li++) {
            var frames = tl.layers[li].frames;
            for (var fi = 0; fi < frames.length; fi++) {
                if (frames[fi].startFrame !== fi) continue;
                for (var ei = 0; ei < frames[fi].elements.length; ei++) {
                    if (frames[fi].elements[ei].elementType === "instance") return false;
                }
            }
        }
        return true;
    }

    // Select every layer in the timeline so the unify script processes them all.
    // The second parameter to setSelectedLayers: true = replace, false = add.
    function selectAllLayers(tl) {
        if (tl.layers.length === 0) return;
        tl.setSelectedLayers(0, true);          // select first, replacing any current selection
        for (var i = 1; i < tl.layers.length; i++) {
            tl.setSelectedLayers(i, false);     // add each remaining layer to the selection
        }
    }

    // Collect the names of every unique MovieClip library item that has at
    // least one instance anywhere in the given timeline.
    function referencedMCNames(tl) {
        var seen   = {};
        var result = [];
        for (var li = 0; li < tl.layers.length; li++) {
            var frames = tl.layers[li].frames;
            for (var fi = 0; fi < frames.length; fi++) {
                if (frames[fi].startFrame !== fi) continue;
                var elems = frames[fi].elements;
                for (var ei = 0; ei < elems.length; ei++) {
                    var el = elems[ei];
                    if (el.elementType === "instance" &&
                        el.libraryItem  &&
                        (el.libraryItem.itemType === "movie clip" ||
                         el.libraryItem.itemType === "graphic") &&
                        !seen[el.libraryItem.name]) {
                        seen[el.libraryItem.name] = true;
                        result.push(el.libraryItem.name);
                    }
                }
            }
        }
        return result;
    }

    // ── recursive processor ───────────────────────────────────────────────────

    // Guard against processing the same MC twice (it may be referenced from
    // multiple parent timelines).
    var visited = {};

    function processTimeline(depth, label) {
        var tl = doc.getTimeline();
        fl.trace("[D" + depth + "] " + label +
                 " — " + tl.layers.length + " layer(s)");

        // ── Step A: unify all layers in this timeline ─────────────────────
        // Skip the root scene (depth 0).  The root scene uses a 3D layer-
        // parenting rig with motion tweens; running unifyKeyframesToFirstSymbol
        // on it would delete static shape layers (e.g. the Bicycle drawing)
        // and corrupt motion-tween keyframes, causing frame 0 to go missing.
        // Nested library MC timelines are processed normally (depth > 0).
        if (depth > 0) {
            selectAllLayers(tl);
            fl.runScript(unifyScript);

            // Re-fetch timeline; runScript may have altered element state.
            tl = doc.getTimeline();
        }

        // ── Step B: recurse into every MC now referenced on stage ─────────
        var mcNames = referencedMCNames(tl);

        for (var mi = 0; mi < mcNames.length; mi++) {
            var mcName = mcNames[mi];
            if (visited[mcName]) {
                fl.trace("[D" + depth + "] Already visited '" + mcName + "' — skipping");
                continue;
            }
            visited[mcName] = true;

            var mcItem = findLibItem(mcName);
            if (!mcItem) continue;

            if (isLeaf(mcItem)) {
                fl.trace("[D" + depth + "] Leaf '" + mcName + "' — skipping");
                continue;
            }

            fl.trace("[D" + depth + "] → drilling into '" + mcName + "'");
            lib.editItem(mcName);
            processTimeline(depth + 1, "'" + mcName + "'");
            doc.exitEditMode();
        }
    }

    // ── entry point ───────────────────────────────────────────────────────────

    // Pass 1 must run BEFORE the unify traversal so that every library item is
    // already a MovieClip when unifyKeyframesToFirstSymbol runs.  Without this,
    // a Graphic that appears in two parent timelines gets converted while
    // processing the first parent, but the second parent sees it as "already MC"
    // and may fail to set the instance name due to stale element references.
    // Running convertLibraryToMovieClips first converts every Graphic atomically
    // (library-wide), so the unify traversal always starts with all-MC items.
    fl.trace("════════════════════════════════════════");
    fl.trace("Full Pipeline — pass 1: convertLibraryToMovieClips");
    fl.trace("════════════════════════════════════════");
    doc.exitEditMode();
    fl.runScript(convertScript);

    doc.exitEditMode();

    fl.trace("════════════════════════════════════════");
    fl.trace("Full Pipeline — pass 2: unify all timelines (nested symbols)");
    fl.trace("════════════════════════════════════════");

    // Always start from the root scene.
    doc.exitEditMode();
    processTimeline(0, "Scene (root)");

    doc.exitEditMode();

    // Pass 3: second unused-item sweep.
    // The unify pass (pass 2) may have deleted puppet/shape layers that were
    // referencing library symbols.  Those symbols are now unreferenced but
    // were not caught by the unused-removal inside pass 1 (which ran before
    // the deletions).  Running convertLibraryToMovieClips again is safe —
    // it is idempotent for already-converted items — and its Step 5 will
    // clean up any newly orphaned symbols (PuppetShape, WarpedAsset, etc.).
    fl.trace("════════════════════════════════════════");
    fl.trace("Full Pipeline — pass 3: second unused-item sweep");
    fl.trace("════════════════════════════════════════");
    fl.runScript(convertScript);

    doc.exitEditMode();
    fl.trace("════════════════════════════════════════");
    fl.trace("Full Pipeline complete.");
    fl.trace("════════════════════════════════════════");

})();
