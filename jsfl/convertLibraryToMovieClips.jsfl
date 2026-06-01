// convertLibraryToMovieClips.jsfl
//
// Iterates over every item in the library:
//   1. Converts any Graphic symbol into a MovieClip.
//   2. Ensures every MovieClip (including newly converted ones) has an
//      ActionScript linkage identifier derived from its name.

(function () {

    var doc = fl.getDocumentDOM();
    if (!doc) { fl.trace("No document is open."); return; }

    var lib = doc.library;

    // Linkage APIs (linkageIdentifier etc.) are not supported on HTML5 Canvas / WebGL docs.
    // We detect this at runtime: the first write that throws sets supportsLinkage = false,
    // and the Step-3 gate (if ... && supportsLinkage) then skips all subsequent items.
    var supportsLinkage = true;

    // Sanitise a library item name into a valid AS3 class identifier.
    // Strips folder paths and file extensions, replaces illegal characters,
    // and capitalises the first letter (e.g. for linkage class names).
    // Names/identifiers must not start with a digit — prefix 'Mc_' if needed.
    function toIdentifier(itemName) {
        var s = itemName
            .replace(/^.*\//, "")          // strip folder path
            .replace(/\.[^.]+$/, "")       // strip extension
            .replace(/[^a-zA-Z0-9$]/g, "");
        s = s.charAt(0).toUpperCase() + s.slice(1);
        if (/^[0-9]/.test(s)) s = "Mc" + s;  // can't start with a digit
        return s;
    }

    // Return a copy of the library item's full name (preserving any folder
    // prefix) with the base-name's first letter forced to lower-case.
    // Names must not start with a digit — prefix 'mc_' if needed.
    function lowercaseBaseName(fullName) {
        var slash  = fullName.lastIndexOf("/");
        var prefix = slash >= 0 ? fullName.slice(0, slash + 1) : "";
        var base   = slash >= 0 ? fullName.slice(slash + 1)   : fullName;
        base = base.charAt(0).toLowerCase() + base.slice(1);
        if (/^[0-9]/.test(base)) base = "mc" + base;  // can't start with a digit
        return prefix + base;
    }

    // Make sure a linkage identifier is unique across the library's current
    // set of identifiers. If 'wanted' is already taken by a different item,
    // append a number.
    function uniqueIdentifier(existingIds, wanted) {
        if (!existingIds[wanted]) return wanted;
        var n = 1;
        while (existingIds[wanted + n]) n++;
        return wanted + n;
    }

    // Collect all identifiers already in use so we can avoid collisions.
    var usedIds = {};
    var items = lib.items;
    for (var i = 0; i < items.length; i++) {
        var id = items[i].linkageIdentifier;
        if (id && id !== "") usedIds[id] = true;
    }

    var convertedCount = 0;
    var linkageCount   = 0;
    var skippedCount   = 0;

    // Track items converted from Graphic→MC in this run so Step 4 doesn't
    // re-open them via lib.editItem (which can revert the type change).
    var justConverted = {};

    // Dump every library item so we can see exactly what exists and what type it is.
    fl.trace("── Library contents (" + lib.items.length + " items) ──");
    for (var d = 0; d < lib.items.length; d++) {
        var di = lib.items[d];
        fl.trace("  [LIB] '" + di.name + "'  type=" + di.itemType +
                 "  linkage='" + (di.linkageIdentifier || "") + "'" +
                 "  exportForAS=" + !!di.linkageExportForAS);
    }
    fl.trace("────────────────────────────────────");

    // Snapshot item NAMES (not references or indices) before the loop.
    var itemNames = [];
    for (var n0 = 0; n0 < lib.items.length; n0++) {
        itemNames.push(lib.items[n0].name);
    }

    function findItem(name) {
        for (var fi = 0; fi < lib.items.length; fi++) {
            if (lib.items[fi].name === name) return lib.items[fi];
        }
        return null;
    }

    for (var j = 0; j < itemNames.length; j++) {
        var item = findItem(itemNames[j]);
        if (!item) { fl.trace("  [MISSING] '" + itemNames[j] + "' not found after snapshot"); continue; }

        // ── Step 1: convert Graphics to MovieClips ───────────────────────
        if (item.itemType === "graphic") {
            lib.selectItem(item.name);
            // linkageExportForAS = true silently locks itemType — disable it
            // first, change the type, then restore the linkage settings.
            var g_linkage    = supportsLinkage ? (item.linkageIdentifier      || "") : "";
            var g_export     = supportsLinkage ? !!item.linkageExportForAS          : false;
            var g_firstFrame = supportsLinkage ? !!item.linkageExportInFirstFrame   : false;
            if (g_export) item.linkageExportForAS = false;
            item.symbolType = "movie clip";
            if (supportsLinkage && g_export && g_linkage) {
                item.linkageExportForAS        = true;
                try { item.linkageIdentifier   = g_linkage; } catch(e) {}
                item.linkageExportInFirstFrame = g_firstFrame;
            }
            // Record so Step 4 skips lib.editItem on this item (which can
            // reload the on-disk Graphic state and revert the type change).
            justConverted[item.name] = true;
            convertedCount++;
            fl.trace("[CONVERTED] '" + item.name + "' graphic → movie clip");
            // Re-find after potential reindex
            item = findItem(itemNames[j]);
            if (!item) continue;
        }

        // ── Step 2: ensure the library name starts with a lower-case letter ──
        if (item.itemType === "movie clip") {
            var desired = lowercaseBaseName(item.name);
            if (desired !== item.name) {
                var oldName = item.name;
                // Keep justConverted in sync so the renamed item stays excluded from Step 4.
                if (justConverted[oldName]) {
                    justConverted[desired] = true;
                    delete justConverted[oldName];
                }
                item.name = desired;
                // Update our name snapshot so later findItem still works
                itemNames[j] = desired;
                fl.trace("[RENAME]    '" + oldName + "' \u2192 '" + desired + "'");
                // Re-find after rename
                item = findItem(desired);
                if (!item) continue;
            }
        }

        // ── Step 3: ensure every MovieClip has a linkage identifier ──────
        if (item.itemType === "movie clip" && supportsLinkage) {
            var currentId = (item.linkageIdentifier || "").replace(/^\s+|\s+$/g, "");

            if (currentId === "" || !item.linkageExportForAS) {
                var wanted = toIdentifier(item.name);
                // Don't mark it used yet — do that after we assign
                if (usedIds[wanted] && item.linkageIdentifier !== wanted) {
                    wanted = uniqueIdentifier(usedIds, wanted);
                }

                // Guard: when linkageExportForAS is set to true, Animate
                // auto-assigns linkageIdentifier = item.name (basename, as-is).
                // This check is case-insensitive, so 'tail' collides with 'Tail'.
                // Fix: rename the item to the safe lowercase-first `wanted` name
                // before enabling export so the auto-assignment won't collide.
                var autoName = item.name.replace(/^.*\//, "");
                var ciBlock  = false;
                for (var cig = 0; cig < lib.items.length; cig++) {
                    var cigId = lib.items[cig].linkageIdentifier;
                    if (cigId && cigId !== "" &&
                        lib.items[cig].name !== item.name &&
                        cigId.toLowerCase() === autoName.toLowerCase()) {
                        ciBlock = true;
                        break;
                    }
                }
                if (ciBlock) {
                    var slash4   = item.name.lastIndexOf("/");
                    var folder4  = slash4 >= 0 ? item.name.slice(0, slash4 + 1) : "";
                    var safeName = folder4 + wanted.charAt(0).toLowerCase() + wanted.slice(1);
                    fl.trace("[CI-RENAME] '" + item.name + "' → '" + safeName +
                             "' (auto-assign would CI-collide)");
                    item.name    = safeName;
                    itemNames[j] = safeName;
                    item = findItem(safeName);
                    if (!item) continue;
                }

                // Enable export first so linkageIdentifier becomes writable,
                // then set the identifier, then enable first-frame export.
                // Wrap in try/catch: linkageIdentifier throws on HTML5 Canvas docs.
                // On first throw, set supportsLinkage = false so the outer gate
                // (if ... && supportsLinkage) skips all remaining items.
                try {
                    item.linkageExportForAS        = true;
                    item.linkageIdentifier         = wanted;
                    item.linkageExportInFirstFrame = true;
                    usedIds[wanted] = true;
                    linkageCount++;
                    fl.trace("[LINKAGE]   '" + item.name + "' → identifier: '" + wanted + "'");
                } catch(lkErr) {
                    supportsLinkage = false;
                    fl.trace("[INFO] Linkage not supported — skipping all further linkage. (" + lkErr.message + ")");
                }
            } else {
                // Linkage exists — strip underscores and ensure first letter is upper-case
                var cleanedId = currentId.replace(/_/g, "");
                var fixedId   = cleanedId.charAt(0).toUpperCase() + cleanedId.slice(1);
                if (/^[0-9]/.test(fixedId)) fixedId = "Mc" + fixedId;
                if (fixedId !== currentId) {
                    // Free the old slot before checking whether the cleaned form is available.
                    delete usedIds[currentId];
                    if (!usedIds[fixedId]) {
                        try {
                            item.linkageExportForAS = false;
                            item.linkageExportForAS = true;
                            item.linkageIdentifier         = fixedId;
                            item.linkageExportInFirstFrame = true;
                            usedIds[fixedId] = true;
                            linkageCount++;
                            fl.trace("[FIX ID]    '" + item.name + "' linkage '" + currentId + "' → '" + fixedId + "'");
                        } catch(lkErr) { supportsLinkage = false; }
                    } else {
                        var suffixed = uniqueIdentifier(usedIds, fixedId);
                        try {
                            item.linkageExportForAS = false;
                            item.linkageExportForAS = true;
                            item.linkageIdentifier         = suffixed;
                            item.linkageExportInFirstFrame = true;
                            usedIds[suffixed] = true;
                            linkageCount++;
                            fl.trace("[FIX ID]    '" + item.name + "' linkage '" + currentId + "' → '" + suffixed + "' (collided with '" + fixedId + "')");
                        } catch(lkErr) { supportsLinkage = false; }
                    }
                } else {
                    skippedCount++;
                    fl.trace("[OK]        '" + item.name + "' already has linkage: '" + currentId + "'");
                }
            }
        }
    }

    // ── Step 4: enter every MC and wrap any bare bitmap instances ────────────
    //
    // If a MovieClip's timeline contains a raw bitmap instance sitting alongside
    // a MovieClip instance (or alone), that bitmap must be wrapped in its own
    // MC so every nested asset is a MovieClip with a linkage identifier.
    //
    // Strategy:
    //   Read pass  – enter the MC, snapshot bitmap element data as plain values,
    //                exit immediately (no writes yet).
    //   Write pass – for each bitmap found, re-enter the parent MC, navigate to
    //                the correct frame/layer, select the bitmap, call
    //                convertToSymbol, set instance name, exit.
    //   Linkage    – after exiting, set linkage on the newly created lib item.
    //
    // Only MCs that existed BEFORE this step are processed (new wrappers created
    // here are intentionally excluded to avoid infinite loops).

    function uniqueLibraryName(wantedBase) {
        // Must be free as both a library item name AND a linkage identifier,
        // because enabling linkageExportForAS auto-assigns identifier = item name.
        var existing = {};
        for (var xi = 0; xi < lib.items.length; xi++) {
            existing[lib.items[xi].name.toLowerCase()] = true;
            var xlid = lib.items[xi].linkageIdentifier;
            if (xlid && xlid !== "") existing[xlid.toLowerCase()] = true;
        }
        if (!existing[wantedBase.toLowerCase()]) return wantedBase;
        var n = 1;
        while (existing[(wantedBase + n).toLowerCase()]) n++;
        return wantedBase + n;
    }

    function uniqueLinkageIdLocal(wanted) {
        var used = {};
        for (var xi = 0; xi < lib.items.length; xi++) {
            var lid = lib.items[xi].linkageIdentifier;
            if (lid && lid !== "") used[lid.toLowerCase()] = true;
        }
        if (!used[wanted.toLowerCase()]) return wanted;
        var n = 1;
        while (used[(wanted + n).toLowerCase()]) n++;
        return wanted + n;
    }

    // Snapshot existing MC names so new wrappers created in this step are
    // not themselves iterated. Also exclude items just converted from Graphic
    // so lib.editItem doesn't revert their in-memory type change.
    var existingMCNames = [];
    for (var em = 0; em < lib.items.length; em++) {
        var emItem = lib.items[em];
        if (emItem.itemType === "movie clip" && !justConverted[emItem.name]) {
            existingMCNames.push(emItem.name);
        }
    }

    var innerWrapCount = 0;
    var separatedLayerCount = 0;

    for (var emi = 0; emi < existingMCNames.length; emi++) {
        var parentMCName = existingMCNames[emi];

        // ── Sub-pass: one element per layer ────────────────────────────────
        // Repeatedly find the first keyframe that holds more than one element
        // on the same layer, select all elements in that keyframe, and call
        // distributeToLayers() so each element is moved to its own layer.
        // Loop until no multi-element keyframes remain in this MC.
        var sepAgain = true;
        var seenSepPos = {};   // every position we have already attempted to distribute
        var sepIterations = 0;
        var MAX_SEP_ITER = 200;
        while (sepAgain && sepIterations < MAX_SEP_ITER) {
            sepIterations++;
            sepAgain = false;
            lib.editItem(parentMCName);
            var sepTL = doc.getTimeline();
            var sepFndLyr = -1, sepFndFrm = -1;
            for (var sepLi = 0; sepLi < sepTL.layers.length && sepFndLyr < 0; sepLi++) {
                for (var sepFi = 0; sepFi < sepTL.layers[sepLi].frames.length && sepFndLyr < 0; sepFi++) {
                    var sepKf = sepTL.layers[sepLi].frames[sepFi];
                    if (sepKf.startFrame !== sepFi) continue;
                    var sepInstCount = 0;
                    for (var sepEiC = 0; sepEiC < sepKf.elements.length; sepEiC++) {
                        if (sepKf.elements[sepEiC].elementType === "instance") sepInstCount++;
                    }
                    if (sepInstCount > 1) {
                        sepFndLyr = sepLi;
                        sepFndFrm = sepFi;
                    }
                }
            }
            if (sepFndLyr < 0) { doc.exitEditMode(); break; }

            // If we have already attempted this exact position, distributeToLayers
            // made no progress (e.g. shape/vector elements that cannot be distributed).
            var sepPos = sepFndLyr + "_" + sepFndFrm;
            if (seenSepPos[sepPos]) {
                fl.trace("[WARN] distributeToLayers made no progress at layer " + sepFndLyr +
                         " frame " + sepFndFrm + " of '" + parentMCName + "' — skipping");
                doc.exitEditMode();
                break;
            }
            seenSepPos[sepPos] = true;

            sepTL.currentLayer = sepFndLyr;
            sepTL.currentFrame = sepFndFrm;
            var sepKfEl = sepTL.layers[sepFndLyr].frames[sepFndFrm].elements;
            var sepSel = [];
            for (var sepEi = 0; sepEi < sepKfEl.length; sepEi++) sepSel.push(sepKfEl[sepEi]);
            doc.selection = sepSel;
            var dtlOk = false;
            if (typeof doc.distributeToLayers === "function") {
                try {
                    doc.distributeToLayers();
                    dtlOk = true;
                } catch (dtlErr) {
                    fl.trace("[WARN] distributeToLayers() unavailable for '" + parentMCName + "': " + dtlErr);
                }
            } else {
                fl.trace("[WARN] distributeToLayers not defined — skipping layer separation for '" + parentMCName + "'");
            }
            doc.exitEditMode();
            if (!dtlOk) break;
            sepAgain = true;
            separatedLayerCount++;
            fl.trace("[SEPARATE]  '" + parentMCName + "': layer " + sepFndLyr +
                     " frame " + sepFndFrm + " → distributed to individual layers");
        }
        if (sepIterations >= MAX_SEP_ITER) {
            fl.trace("[WARN] distributeToLayers hit MAX_SEP_ITER for '" + parentMCName + "' — aborting separation");
        }

        // ── Read pass ──────────────────────────────────────────────────────
        lib.editItem(parentMCName);
        var innerTL = doc.getTimeline();

        var bitmapsFound = [];
        for (var il = 0; il < innerTL.layers.length; il++) {
            var ilyr = innerTL.layers[il];
            for (var iff = 0; iff < ilyr.frames.length; iff++) {
                if (ilyr.frames[iff].startFrame !== iff) continue;
                var ifrm = ilyr.frames[iff];
                for (var iel = 0; iel < ifrm.elements.length; iel++) {
                    var ielt = ifrm.elements[iel];
                    if (ielt.elementType === "instance" &&
                        ielt.libraryItem &&
                        ielt.libraryItem.itemType === "bitmap") {
                        bitmapsFound.push({
                            layerIdx:   il,
                            frameIdx:   iff,
                            bitmapName: ielt.libraryItem.name,
                            x:          ielt.x,
                            y:          ielt.y
                        });
                    }
                }
            }
        }

        doc.exitEditMode();

        if (bitmapsFound.length === 0) continue;

        // ── Write pass ─────────────────────────────────────────────────────
        var newWrapperNames = [];

        for (var bi = 0; bi < bitmapsFound.length; bi++) {
            var bw = bitmapsFound[bi];

            // Derive names while still outside the symbol (lib still accessible)
            var bBase      = toIdentifier(bw.bitmapName);   // UpperCase-first identifier
            var bBaseLower = bBase.charAt(0).toLowerCase() + bBase.slice(1); // lowercase-first for lib name
            var wrapName   = uniqueLibraryName(bBaseLower + "MC"); // library name: lowercase-first

            // Enter the parent MC for this wrap operation
            lib.editItem(parentMCName);
            var wTL = doc.getTimeline();
            wTL.currentLayer = bw.layerIdx;
            wTL.currentFrame = bw.frameIdx;

            // Find the bitmap element in this frame
            var wLyr  = wTL.layers[bw.layerIdx];
            var wFrm  = wLyr ? wLyr.frames[bw.frameIdx] : null;
            var bmpEl = null;
            if (wFrm) {
                for (var we = 0; we < wFrm.elements.length; we++) {
                    var welt = wFrm.elements[we];
                    if (welt.elementType === "instance" &&
                        welt.libraryItem &&
                        welt.libraryItem.itemType === "bitmap" &&
                        welt.libraryItem.name === bw.bitmapName) {
                        bmpEl = welt;
                        break;
                    }
                }
            }

            if (!bmpEl) {
                fl.trace("  [WARN] Could not find bitmap '" + bw.bitmapName +
                         "' inside '" + parentMCName + "' layer=" + bw.layerIdx +
                         " frame=" + bw.frameIdx);
                doc.exitEditMode();
                continue;
            }

            // Unlock and show the target layer — a locked/hidden layer silently
            // prevents doc.selection from accepting the element reference.
            var tgtLyr = wTL.layers[bw.layerIdx];
            if (tgtLyr) {
                tgtLyr.locked  = false;
                tgtLyr.visible = true;
            }

            // Re-fetch the element after the layer-state change (stale-ref guard)
            wTL  = doc.getTimeline();
            wLyr = wTL.layers[bw.layerIdx];
            wFrm = wLyr ? wLyr.frames[bw.frameIdx] : null;
            bmpEl = null;
            if (wFrm) {
                for (var we3 = 0; we3 < wFrm.elements.length; we3++) {
                    var welt3 = wFrm.elements[we3];
                    if (welt3.elementType === "instance" &&
                        welt3.libraryItem &&
                        welt3.libraryItem.itemType === "bitmap" &&
                        welt3.libraryItem.name === bw.bitmapName) {
                        bmpEl = welt3;
                        break;
                    }
                }
            }
            if (!bmpEl) {
                fl.trace("  [WARN] bitmap '" + bw.bitmapName +
                         "' lost after layer unlock in '" + parentMCName + "' — skipping");
                doc.exitEditMode();
                continue;
            }

            // Select then wrap
            doc.selection = [bmpEl];
            if (!doc.selection || doc.selection.length === 0) {
                fl.trace("  [WARN] Selection empty for '" + bw.bitmapName +
                         "' in '" + parentMCName + "' — skipping");
                doc.exitEditMode();
                continue;
            }
            doc.convertToSymbol("movie clip", wrapName, "top left");

            // Re-find the placed MC instance and set its instance name
            wTL  = doc.getTimeline();
            wLyr = wTL.layers[bw.layerIdx];
            wFrm = wLyr ? wLyr.frames[bw.frameIdx] : null;
            if (wFrm) {
                for (var we2 = 0; we2 < wFrm.elements.length; we2++) {
                    var welt2 = wFrm.elements[we2];
                    if (welt2.elementType === "instance" &&
                        welt2.libraryItem &&
                        welt2.libraryItem.name === wrapName) {
                        // Instance name: same as library name (already lowercase-first)
                        welt2.name = wrapName;
                        break;
                    }
                }
            }

            doc.exitEditMode();

            newWrapperNames.push(wrapName);
            innerWrapCount++;
            fl.trace("[INNER WRAP] '" + parentMCName + "': bitmap '" +
                     bw.bitmapName + "' → '" + wrapName + "'");
        }

        // ── Set linkage on all new wrapper MCs ─────────────────────────────
        if (supportsLinkage) {
            for (var nw = 0; nw < newWrapperNames.length; nw++) {
                var nwItem = findItem(newWrapperNames[nw]);
                if (!nwItem) continue;
                var lwId = uniqueLinkageIdLocal(toIdentifier(newWrapperNames[nw]));
                nwItem.linkageExportForAS        = true;
                try { nwItem.linkageIdentifier   = lwId; } catch(e) {
                    lwId = nwItem.linkageIdentifier || newWrapperNames[nw];
                }
                nwItem.linkageExportInFirstFrame = true;
                fl.trace("[INNER LINK] '" + newWrapperNames[nw] + "' → '" + lwId + "'");
            }
        }
    }

    // ── Step 4b: re-convert any Graphics that reverted during Step 4 ────────
    // lib.editItem on a just-converted Graphic can reload the on-disk symbol
    // state and revert itemType. Run a second sweep to catch those, this time
    // WITHOUT entering their timelines.
    // IMPORTANT: linkageExportForAS = true silently locks itemType, so we
    // must disable it, change type, then restore linkage.
    doc.exitEditMode(); // ensure no symbol is currently being edited
    for (var rc = 0; rc < lib.items.length; rc++) {
        var rcItem = lib.items[rc];
        if (rcItem.itemType === "graphic") {
            lib.selectItem(rcItem.name);
            var rc_linkage    = supportsLinkage ? (rcItem.linkageIdentifier    || "") : "";
            var rc_export     = supportsLinkage ? !!rcItem.linkageExportForAS         : false;
            var rc_firstFrame = supportsLinkage ? !!rcItem.linkageExportInFirstFrame  : false;
            if (rc_export) rcItem.linkageExportForAS = false;
            rcItem.symbolType = "movie clip";
            if (supportsLinkage && rc_export && rc_linkage) {
                rcItem.linkageExportForAS        = true;
                try { rcItem.linkageIdentifier   = rc_linkage; } catch(e) {}
                rcItem.linkageExportInFirstFrame = rc_firstFrame;
            }
            fl.trace("[RE-CONVERT] '" + rcItem.name + "' reverted to graphic, re-converted");
            convertedCount++;
        }
    }

    // ── Step 5: remove unused library items (even those with linkage) ───
    // lib.unusedItems treats linkage-exported items as "used", so we
    // manually walk every timeline (main scene + every library symbol)
    // to build the real set of items that have at least one instance.

    function gatherUsed(timeline, usedSet) {
        var layers = timeline.layers;
        for (var li = 0; li < layers.length; li++) {
            var frames = layers[li].frames;
            for (var fi = 0; fi < frames.length; fi++) {
                // startFrame !== fi means this is a tween/span continuation — skip
                if (frames[fi].startFrame !== fi) continue;
                var elems = frames[fi].elements;
                for (var ei = 0; ei < elems.length; ei++) {
                    if (elems[ei].elementType === "instance") {
                        usedSet[elems[ei].libraryItem.name] = true;
                    }
                }
            }
        }
    }

    var usedSet = {};

    // Walk all scene timelines
    for (var s = 0; s < doc.timelines.length; s++) {
        gatherUsed(doc.timelines[s], usedSet);
    }

    // Walk every library item's own timeline (nested usage)
    var allItemsSnap = lib.items;
    for (var n = 0; n < allItemsSnap.length; n++) {
        if (allItemsSnap[n].timeline) {
            gatherUsed(allItemsSnap[n].timeline, usedSet);
        }
    }

    // Collect names of items with 0 instances anywhere
    var unusedNames = [];
    for (var k = 0; k < lib.items.length; k++) {
        var it = lib.items[k];
        if (it.itemType !== "folder" && !usedSet[it.name]) {
            unusedNames.push(it.name);
        }
    }

    var removedCount = 0;
    for (var m = 0; m < unusedNames.length; m++) {
        fl.trace("[REMOVE]    '" + unusedNames[m] + "' — no instances anywhere, deleted");
        lib.deleteItem(unusedNames[m]);
        removedCount++;
    }

    fl.trace("─────────────────────────────────────────");
    fl.trace("Done.");
    fl.trace("  Graphics converted to MovieClip : " + convertedCount);
    fl.trace("  Linkage identifiers assigned    : " + linkageCount);
    fl.trace("  Already had linkage (skipped)   : " + skippedCount);
    fl.trace("  Bitmap instances wrapped in MC  : " + innerWrapCount);
    fl.trace("  Multi-element layers separated  : " + separatedLayerCount);
    fl.trace("  Unused items removed            : " + removedCount);

})();
