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

    // A "leaf" MC has exactly 1 layer with exactly 1 keyframe holding exactly
    // 1 bitmap instance and no further animation.  No need to recurse into it.
    function isLeaf(item) {
        if (!item || !item.timeline) return true;
        var tl = item.timeline;
        if (tl.layers.length !== 1) return false;
        var layer = tl.layers[0];
        var keyframeCount = 0;
        for (var i = 0; i < layer.frames.length; i++) {
            if (layer.frames[i].startFrame === i) keyframeCount++;
        }
        if (keyframeCount !== 1) return false;
        var elems = layer.frames[0].elements;
        if (elems.length !== 1) return false;
        return elems[0].elementType === "instance" &&
               elems[0].libraryItem  &&
               elems[0].libraryItem.itemType === "bitmap";
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
                        el.libraryItem.itemType === "movie clip" &&
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
        selectAllLayers(tl);
        fl.runScript(unifyScript);

        // Re-fetch timeline; runScript may have altered element state.
        tl = doc.getTimeline();

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

    fl.trace("════════════════════════════════════════");
    fl.trace("Full Pipeline — pass 1: unify all timelines");
    fl.trace("════════════════════════════════════════");

    // Always start from the root scene.
    doc.exitEditMode();
    processTimeline(0, "Scene (root)");

    // Make sure we are back at the root before the library conversion.
    doc.exitEditMode();

    fl.trace("════════════════════════════════════════");
    fl.trace("Full Pipeline — pass 2: convertLibraryToMovieClips");
    fl.trace("════════════════════════════════════════");
    fl.runScript(convertScript);

    doc.exitEditMode();
    fl.trace("════════════════════════════════════════");
    fl.trace("Full Pipeline complete.");
    fl.trace("════════════════════════════════════════");

})();
