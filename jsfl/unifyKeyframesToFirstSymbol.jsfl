// unifyKeyframesToFirstSymbol.jsfl
//
// For every selected layer:
//   1. Inspects the first keyframe to determine the ONE MovieClip to use:
//        - Bitmap instance  → creates a new MC, places bitmap at (0,0) inside it,
//                             sets AS linkage.
//        - Graphic/MC symbol → uses that library item as-is, converts it to
//                             MovieClip type in the library if needed, sets linkage.
//   2. Replaces EVERY keyframe on the layer with an instance of that ONE MC,
//      preserving each frame's original position/transform.
//   3. Every instance gets symbolType "movie clip" and the same instance name
//      (read from frame 0, or derived from the symbol name).

(function () {

    // ── helpers ──────────────────────────────────────────────────────────────

    function getTransform(el) {
        return {
            x:        el.x,
            y:        el.y,
            scaleX:   el.scaleX   !== undefined ? el.scaleX   : 1,
            scaleY:   el.scaleY   !== undefined ? el.scaleY   : 1,
            rotation: el.rotation !== undefined ? el.rotation : 0,
            skewX:    el.skewX    !== undefined ? el.skewX    : 0,
            skewY:    el.skewY    !== undefined ? el.skewY    : 0
        };
    }

    function applyTransform(el, t) {
        el.x        = t.x;
        el.y        = t.y;
        el.scaleX   = t.scaleX;
        el.scaleY   = t.scaleY;
        el.rotation = t.rotation;
        el.skewX    = t.skewX;
        el.skewY    = t.skewY;
    }

    function deriveName(rawName) {
        var s = rawName
            .replace(/^.*\//, "")
            .replace(/\.[^.]+$/, "")
            .replace(/[^a-zA-Z0-9$]/g, "");
        s = s.charAt(0).toLowerCase() + s.slice(1);
        if (/^[0-9]/.test(s)) s = "mc" + s;  // instance/lib names can't start with a digit
        return s;
    }

    // Same as deriveName but with an uppercase first letter — for linkage IDs.
    function deriveLinkageName(rawName) {
        var s = rawName
            .replace(/^.*\//, "")
            .replace(/\.[^.]+$/, "")
            .replace(/[^a-zA-Z0-9$]/g, "");
        s = s.charAt(0).toUpperCase() + s.slice(1);
        if (/^[0-9]/.test(s)) s = "Mc" + s;  // linkage IDs can't start with a digit
        return s;
    }

    // Returns a name that is free both as a library item name AND as a linkage
    // identifier. When linkageExportForAS is first enabled, Animate auto-sets
    // the identifier = symbol name, so both slots must be vacant to avoid the
    // "must specify a unique identifier" error.
    function uniqueLibName(lib, wanted) {
        var names = {};
        var ids   = {};
        for (var i = 0; i < lib.items.length; i++) {
            names[lib.items[i].name] = true;
            var lid = lib.items[i].linkageIdentifier;
            if (lid && lid !== "") ids[lid] = true;
        }
        var candidate = wanted;
        var n = 1;
        while (names[candidate] || ids[candidate]) {
            candidate = wanted + n;
            n++;
        }
        return candidate;
    }

    function findLibItem(lib, name) {
        for (var i = 0; i < lib.items.length; i++) {
            if (lib.items[i].name === name) return lib.items[i];
        }
        return null;
    }

    // Returns a linkage identifier that is not yet used by any library item.
    function uniqueLinkageId(lib, wanted) {
        var used = {};
        for (var i = 0; i < lib.items.length; i++) {
            var id = lib.items[i].linkageIdentifier;
            if (id && id !== "") used[id] = true;
        }
        if (!used[wanted]) return wanted;
        var n = 1;
        while (used[wanted + n]) n++;
        return wanted + n;
    }

    // ── main ─────────────────────────────────────────────────────────────────

    var doc = fl.getDocumentDOM();
    if (!doc) { fl.trace("No document is open."); return; }

    var timeline         = doc.getTimeline();
    var lib              = doc.library;
    var usedInstanceNames = {};   // tracks names already assigned in this timeline run

    // ── Delete mask and masked layers before any other processing ────────────
    // Collect indices of every mask/masked layer, then delete from the highest
    // index downward so earlier indices are not invalidated by each removal.
    var maskIndicesToDelete = [];
    for (var mdi = 0; mdi < timeline.layers.length; mdi++) {
        var ltype = timeline.layers[mdi].layerType;
        if (ltype === "mask") {
            maskIndicesToDelete.push(mdi);
        }
    }
    // Sort descending so deletions don't shift remaining indices.
    maskIndicesToDelete.sort(function(a, b) { return b - a; });
    for (var mdi2 = 0; mdi2 < maskIndicesToDelete.length; mdi2++) {
        fl.trace("  [DELETE MASK] Removing layer " + maskIndicesToDelete[mdi2] +
                 " ('" + timeline.layers[maskIndicesToDelete[mdi2]].name + "'" +
                 " type=" + timeline.layers[maskIndicesToDelete[mdi2]].layerType + ")");
        timeline.deleteLayer(maskIndicesToDelete[mdi2]);
    }
    // Re-fetch timeline after deletions.
    timeline = doc.getTimeline();

    // ── Unlock every layer so stage operations reach all of them ─────────────
    for (var uli = 0; uli < timeline.layers.length; uli++) {
        timeline.layers[uli].locked = false;
    }

    // ── Pre-pass: one element per keyframe ───────────────────────────────────
    // processLayer only inspects elements[0] per keyframe; extras are silently
    // skipped and stay as Graphics.  Strategy: read everything first (no
    // mutations), then delete the extras, then add each to its own new layer.
    // Clipboard (clipCut/clipPaste) is intentionally avoided — timeline refs go
    // stale after addNewLayer and paste lands back on the wrong layer.
    (function separateMultiElementKeyframes() {
        // Phase 1 — snapshot extra instance elements (read-only, no mutations).
        var stl = doc.getTimeline();
        var extras = [];
        for (var li = 0; li < stl.layers.length; li++) {
            var lyr = stl.layers[li];
            for (var fi = 0; fi < lyr.frames.length; fi++) {
                var frm = lyr.frames[fi];
                if (frm.startFrame !== fi) continue;
                for (var ei = 1; ei < frm.elements.length; ei++) {
                    var el = frm.elements[ei];
                    if (el.elementType === "instance" && el.libraryItem) {
                        extras.push({
                            layerName:   lyr.name,
                            frameIdx:    fi,
                            libItemName: el.libraryItem.name,
                            x:           el.x,
                            y:           el.y
                        });
                    }
                }
            }
        }
        if (extras.length === 0) return;
        fl.trace("  [PRE-SEP] " + extras.length + " extra instance(s) to redistribute");

        // Phase 2 — delete extra instances in place.
        // Only element counts change here, not layer counts, so indices are stable.
        stl = doc.getTimeline();
        for (var li2 = 0; li2 < stl.layers.length; li2++) {
            var lyr2 = stl.layers[li2];
            lyr2.locked  = false;
            lyr2.visible = true;
            for (var fi2 = 0; fi2 < lyr2.frames.length; fi2++) {
                var frm2 = lyr2.frames[fi2];
                if (frm2.startFrame !== fi2) continue;
                var toDelete = [];
                for (var ei2 = 1; ei2 < frm2.elements.length; ei2++) {
                    var el2 = frm2.elements[ei2];
                    if (el2.elementType === "instance" && el2.libraryItem) {
                        toDelete.push(el2);
                    }
                }
                if (toDelete.length === 0) continue;
                stl.currentLayer = li2;
                stl.currentFrame = fi2;
                doc.selection = toDelete;
                doc.deleteSelection();
            }
        }

        // Phase 3 — add each extra to its own new layer.
        // addNewLayer shifts indices so re-look up the parent layer by name each time.
        for (var xi = 0; xi < extras.length; xi++) {
            var ex = extras[xi];
            var libItem = findLibItem(lib, ex.libItemName);
            if (!libItem) {
                fl.trace("  [PRE-SEP WARN] item not in library: '" + ex.libItemName + "'");
                continue;
            }
            stl = doc.getTimeline();
            var li3 = -1;
            for (var lj = 0; lj < stl.layers.length; lj++) {
                if (stl.layers[lj].name === ex.layerName) { li3 = lj; break; }
            }
            if (li3 < 0) {
                fl.trace("  [PRE-SEP WARN] layer not found: '" + ex.layerName + "'");
                continue;
            }
            stl.currentLayer = li3;
            stl.addNewLayer("", "normal", true); // inserts at li3; original → li3+1
            stl = doc.getTimeline();             // re-fetch so currentLayer is fresh
            stl.currentLayer = li3;
            stl.currentFrame = ex.frameIdx;
            if (ex.frameIdx > 0) stl.insertBlankKeyframe(ex.frameIdx);
            doc.addItem({ x: ex.x, y: ex.y }, libItem);
            fl.trace("  [PRE-SEP] '" + ex.layerName + "' frame " + ex.frameIdx +
                     ": '" + ex.libItemName + "' → new layer");
        }

        // Unlock all layers (addNewLayer may leave new layers locked).
        stl = doc.getTimeline();
        for (var ul = 0; ul < stl.layers.length; ul++) stl.layers[ul].locked = false;
    })();
    timeline = doc.getTimeline(); // re-fetch after pre-pass may have added layers

    // ── De-duplicate layer names ──────────────────────────────────────────────
    // processLayer looks up layers by name; when two layers share a name,
    // findLayerByName always returns the first match — the second layer is
    // processed twice while the duplicate is silently skipped (e.g. two
    // 'Pig_Pupil' layers means one never gets an instance name).
    (function deduplicateLayerNames() {
        var stl  = doc.getTimeline();
        var seen = {};
        for (var i = 0; i < stl.layers.length; i++) {
            var n = stl.layers[i].name;
            if (seen[n] === undefined) {
                seen[n] = 0;
            } else {
                seen[n]++;
                var uname = n + "_" + seen[n];
                stl.layers[i].name = uname;
                fl.trace("  [DEDUP] '" + n + "' → '" + uname + "'");
            }
        }
    })();
    timeline = doc.getTimeline();

    // Build selectedIndices from ALL remaining layers.
    // We do this explicitly (rather than calling getSelectedLayers) because
    // deleting mask layers above invalidates whatever UI selection was active,
    // so getSelectedLayers would return stale / incomplete results.
    var selectedIndices = [];
    for (var sli = 0; sli < timeline.layers.length; sli++) {
        selectedIndices.push(sli);
    }
    if (selectedIndices.length === 0) {
        selectedIndices = [timeline.currentLayer];
    }

    fl.trace("Processing " + selectedIndices.length + " layer(s)...");
    for (var li = 0; li < selectedIndices.length; li++) {
        // Re-read the timeline so mutations from the previous processLayer call
        // are fully reflected before we inspect layer names / lock states.
        timeline = doc.getTimeline();

        // Lock every OTHER selected layer for the duration of this pass.
        // When Animate has multiple layers selected, stage operations such as
        // doc.addItem, doc.deleteSelection, and doc.convertToSymbol can affect
        // ALL selected layers simultaneously.  Locking the bystanders prevents
        // that spill-over, which is what caused the "same image on every layer"
        // symptom when processing more than one layer at a time.
        var savedLocks = [];
        for (var lj = 0; lj < selectedIndices.length; lj++) {
            savedLocks[lj] = timeline.layers[selectedIndices[lj]].locked;
            timeline.layers[selectedIndices[lj]].locked = (lj !== li);
        }

        var layerName0 = timeline.layers[selectedIndices[li]].name;
        processLayer(doc, lib, layerName0);

        // Restore original lock states.
        timeline = doc.getTimeline();
        for (var lj = 0; lj < selectedIndices.length; lj++) {
            timeline.layers[selectedIndices[lj]].locked = savedLocks[lj];
        }
    }

    // ─────────────────────────────────────────────────────────────────────────

    function findLayerByName(tl, name) {
        for (var i = 0; i < tl.layers.length; i++) {
            if (tl.layers[i].name === name) return i;
        }
        return -1;
    }

    function processLayer(doc, lib, layerName) {

        var timeline   = doc.getTimeline();
        var layerIndex = findLayerByName(timeline, layerName);
        if (layerIndex < 0) {
            fl.trace("  [SKIP] Layer '" + layerName + "' not found."); return;
        }
        var layer = timeline.layers[layerIndex];

        // Collect keyframe start indices
        var keyframes = [];
        for (var i = 0; i < layer.frames.length; i++) {
            if (layer.frames[i].startFrame === i) keyframes.push(i);
        }
        if (keyframes.length === 0) {
            fl.trace("  [SKIP] No keyframes on layer '" + layerName + "'."); return;
        }
        fl.trace("  Layer '" + layerName + "': " + keyframes.length +
                 " keyframe(s) at [" + keyframes.join(", ") + "]");

        // ── Phase 0: snapshot all keyframe data as plain JS values ───────────

        timeline.currentLayer = layerIndex;
        var firstFrame = layer.frames[keyframes[0]];
        if (!firstFrame || firstFrame.elements.length === 0) {
            fl.trace("  [SKIP] First keyframe is empty."); return;
        }
        var firstEl = firstFrame.elements[0];
        fl.trace("  Frame 0: elementType=" + firstEl.elementType +
                 (firstEl.libraryItem
                     ? "  libItemType=" + firstEl.libraryItem.itemType +
                       "  libName='" + firstEl.libraryItem.name + "'"
                     : "  (no libraryItem)"));
        if (firstEl.elementType !== "instance") {
            fl.trace("  [SKIP] First element is not an instance."); return;
        }

        var kfData = [];
        for (var r = 0; r < keyframes.length; r++) {
            timeline.currentFrame = keyframes[r];
            var rf  = layer.frames[keyframes[r]];
            var rel = (rf && rf.elements.length > 0) ? rf.elements[0] : null;
            kfData.push({
                hasEl:    !!rel,
                isBitmap: !!(rel && rel.libraryItem &&
                             rel.libraryItem.itemType === "bitmap"),
                libName:  (rel && rel.libraryItem) ? rel.libraryItem.name : "",
                x:    rel ? rel.x    : 0,
                y:    rel ? rel.y    : 0,
                left: rel ? rel.left : 0,
                top:  rel ? rel.top  : 0
            });
            fl.trace("  [READ KF " + r + "] frame=" + keyframes[r] +
                     (rel ? "  " + rel.elementType +
                            (rel.libraryItem ? " '" + rel.libraryItem.name + "'" : "")
                          : "  empty"));
        }

        // ── Phase 1: library metadata only (no stage ops, no editItem) ───────

        var targetItemName     = "";
        var targetInstanceName = (firstEl.name || "").replace(/^\s+|\s+$/g, "");

        // isBitmapLayer: frame 0 is a bitmap — MC will be created in Phase 2
        // via doc.convertToSymbol directly on the stage element.
        // This avoids lib.editItem/exitEditMode which corrupt stage positions.
        var isBitmapLayer  = (firstEl.libraryItem.itemType === "bitmap");
        var bitmapLibName  = isBitmapLayer ? firstEl.libraryItem.name : "";
        var bitmapBaseName = isBitmapLayer ? deriveName(bitmapLibName) : "";
        var bitmapMCName   = isBitmapLayer
                             ? uniqueLibName(lib, bitmapBaseName + "MC")
                             : null;

        if (isBitmapLayer) {
            targetItemName     = bitmapMCName;
            targetInstanceName = targetInstanceName || bitmapBaseName;
            fl.trace("  [BITMAP] Will wrap '" + bitmapLibName +
                     "' → '" + bitmapMCName + "' via convertToSymbol");
        } else {
            var symItem        = firstEl.libraryItem;
            targetItemName     = symItem.name;
            targetInstanceName = targetInstanceName || deriveName(targetItemName);

            if (symItem.itemType !== "movie clip") {
                // itemType is read-only; symbolType is the writable property.
                // linkageExportForAS silently locks symbolType, so disable it first.
                var su_export = !!symItem.linkageExportForAS;
                var su_id     = symItem.linkageIdentifier || "";
                var su_ff     = !!symItem.linkageExportInFirstFrame;
                if (su_export) symItem.linkageExportForAS = false;
                symItem.symbolType = "movie clip";
                if (su_export && su_id) {
                    symItem.linkageExportForAS        = true;
                    try { symItem.linkageIdentifier   = su_id; } catch(e) {}
                    symItem.linkageExportInFirstFrame = su_ff;
                }
                fl.trace("  [LIB FIX] '" + targetItemName + "': Graphic → MovieClip");
            }
            if (!symItem.linkageExportForAS) {
                // Guard against case-insensitive collision: when linkageExportForAS
                // is set to true, Animate auto-assigns linkageIdentifier = symItem.name.
                // If any existing identifier matches that name case-insensitively,
                // Animate throws a non-catchable "unique identifier" error.
                // In that case, defer linkage assignment to convertLibraryToMovieClips,
                // which uses case-insensitive deduplication throughout.
                var nameLC    = symItem.name.toLowerCase();
                var ciCollide = false;
                for (var ci = 0; ci < lib.items.length; ci++) {
                    var cLid = lib.items[ci].linkageIdentifier;
                    if (cLid && cLid !== "" && cLid.toLowerCase() === nameLC) {
                        ciCollide = true;
                        break;
                    }
                }
                if (!ciCollide) {
                    var lId = uniqueLinkageId(lib, deriveLinkageName(targetItemName));
                    symItem.linkageExportForAS        = true;
                    symItem.linkageIdentifier         = lId;
                    symItem.linkageExportInFirstFrame = true;
                    fl.trace("  [LINKAGE] '" + targetItemName + "' → '" + lId + "'");
                } else {
                    fl.trace("  [LINKAGE DEFER] '" + targetItemName +
                             "' — name collides case-insensitively, deferred to convertLibraryToMovieClips");
                }
            }
            fl.trace("  [SYMBOL] Using '" + targetItemName +
                     "'  instance='" + targetInstanceName + "'");
        }

        // Ensure the instance name is unique within this timeline.
        if (usedInstanceNames[targetInstanceName]) {
            var suffix = 1;
            while (usedInstanceNames[targetInstanceName + suffix]) suffix++;
            targetInstanceName = targetInstanceName + suffix;
            fl.trace("  [UNIQUE] Renamed instance to '" + targetInstanceName + "' to avoid collision");
        }
        usedInstanceNames[targetInstanceName] = true;

        // ── Phase 2: stage work ───────────────────────────────────────────────
        //
        // For bitmap layers, the FIRST bitmap keyframe uses doc.convertToSymbol
        // which creates the MC in the library AND places the instance on stage
        // with the bitmap already inside — no lib.editItem/exitEditMode needed.
        // All subsequent bitmap keyframes use delete + addItem.
        // Symbol keyframes use swapElement + AABB position correction.

        var bitmapMCCreated = !isBitmapLayer; // true = no convertToSymbol needed

        for (var k = 0; k < keyframes.length; k++) {
            var frameIdx = keyframes[k];
            var kf       = kfData[k];

            timeline   = doc.getTimeline();
            layerIndex = findLayerByName(timeline, layerName);
            layer      = timeline.layers[layerIndex];
            timeline.currentLayer = layerIndex;
            timeline.currentFrame = frameIdx;

            var frameObj = layer.frames[frameIdx];
            var el = (frameObj && frameObj.elements.length > 0)
                     ? frameObj.elements[0] : null;

            fl.trace("  [KF " + k + "] frame=" + frameIdx +
                     (kf.isBitmap ? "  BITMAP" : "  SYMBOL") +
                     " '" + kf.libName + "'" +
                     "  el=" + (el ? "present" : "empty"));

            if (kf.isBitmap && !bitmapMCCreated) {
                // ── First bitmap: convertToSymbol creates + populates the MC
                // and positions it correctly in one atomic operation.
                // No context switch, no editItem, no exitEditMode.
                doc.selection = [el];
                doc.convertToSymbol("movie clip", bitmapMCName, "top left");
                bitmapMCCreated = true;

                // Re-fetch (convertToSymbol swaps the element in-place)
                timeline   = doc.getTimeline();
                layerIndex = findLayerByName(timeline, layerName);
                if (layerIndex < 0) {
                    fl.trace("  [ERROR] Lost layer after convertToSymbol"); return;
                }
                layer = timeline.layers[layerIndex];

                // Set linkage on the freshly created MC
                var newMC = findLibItem(lib, bitmapMCName);
                if (newMC) {
                    newMC.linkageExportForAS = true;
                    var bLinkId = uniqueLinkageId(lib, deriveLinkageName(bitmapLibName));
                    try {
                        newMC.linkageIdentifier = bLinkId;
                    } catch (e) {
                        bLinkId = newMC.linkageIdentifier || bitmapMCName;
                    }
                    newMC.linkageExportInFirstFrame = true;
                    fl.trace("  [LINKAGE] '" + bitmapMCName + "' → '" + bLinkId + "'");
                }

                // convertToSymbol already placed the MC at the right position;
                // just stamp the name below (no positional correction needed).

            } else if (el && !kf.isBitmap && el.elementType === "instance" && targetItemName) {
                // ── Symbol instance: swap preserves the reg-point on stage.
                // Skip if already the target symbol — swapElement fails on a self-swap.
                if (el.libraryItem && el.libraryItem.name === targetItemName) {
                    fl.trace("  [KF " + k + "] Already '" + targetItemName + "' — no swap needed");
                } else {
                    // Guard: swapElement throws "Argument number 1 is invalid" when the
                    // target name doesn't match any library item (e.g. broken ref or stale
                    // path after a rename).  Also guard against a null libraryItem on el
                    // (broken instance) which would pass the identity check above but leave
                    // the selection pointing at an unswappable element.
                    if (!el.libraryItem) {
                        fl.trace("  [WARN KF " + k + "] Element has no libraryItem (broken ref) on layer '" + layerName + "' frame " + frameIdx + " — skipping swap");
                    } else if (!findLibItem(lib, targetItemName)) {
                        fl.trace("  [WARN KF " + k + "] Target '" + targetItemName + "' not found in library — skipping swap");
                    } else {
                        doc.selection = [el];
                        if (!doc.selection || doc.selection.length === 0) {
                            fl.trace("  [WARN KF " + k + "] Selection failed on layer '" + layerName + "' frame " + frameIdx + " — skipping swap");
                        } else {
                            doc.swapElement(targetItemName);
                        }
                    }
                }

            } else {
                // ── Remaining bitmap frames, empty frames, or non-instance
                // elements: delete whatever is there then addItem.
                var freshItem = findLibItem(lib, targetItemName);
                if (!freshItem) {
                    fl.trace("  [ERROR] Cannot find '" + targetItemName + "' in library"); continue;
                }
                if (el) {
                    doc.selection = [el];
                    doc.deleteSelection();
                    timeline   = doc.getTimeline();
                    layerIndex = findLayerByName(timeline, layerName);
                    layer      = timeline.layers[layerIndex];
                    timeline.currentLayer = layerIndex;
                    timeline.currentFrame = frameIdx;
                }
                doc.addItem({ x: 0, y: 0 }, freshItem);
            }

            // Re-fetch placed element
            timeline   = doc.getTimeline();
            layerIndex = findLayerByName(timeline, layerName);
            layer      = timeline.layers[layerIndex];
            var pf     = layer ? layer.frames[frameIdx] : null;
            var placed = pf ? pf.elements[0] : null;

            if (placed) {
                if (kf.hasEl) {
                    if (kf.isBitmap && !bitmapMCCreated) {
                        // Should never reach here (bitmapMCCreated was just set),
                        // but guard anyway
                    } else if (kf.isBitmap) {
                        // Subsequent bitmap frames placed as MC via addItem:
                        // MC reg = top-left = original bitmap.x/y
                        placed.x = kf.x;
                        placed.y = kf.y;
                    } else {
                        // Symbol swapped: correct for differing registration points
                        placed.x += (kf.left - placed.left);
                        placed.y += (kf.top  - placed.top);
                    }
                }
                placed.symbolType = "movie clip";
                placed.name       = targetInstanceName;
                fl.trace("  [KF " + k + "] ✓  name='" + placed.name +
                         "'  x=" + placed.x + "  y=" + placed.y);
            } else {
                fl.trace("  [WARN] KF " + k + " (frame " + frameIdx +
                         "): no element after swap/add");
            }
        }

        fl.trace("  Done! Layer '" + layerName + "' — " + keyframes.length +
                 " KF(s) → '" + targetItemName +
                 "'  instance='" + targetInstanceName + "'");
    }

})();

