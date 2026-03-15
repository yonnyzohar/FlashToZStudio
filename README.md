# swfExporter_mac

Exports a compiled `.swf` file into a scene hierarchy, animations, and images consumable by the `zImporter_PIXI` runtime and the `graphicsIDE` editor.

## Output

Given a `.swf`, the exporter writes to `<outputFolder>/output/`:

| File | Description |
|---|---|
| `placements.json` | Full scene hierarchy — positions, rotations, scales, skews, alphas, pivots, and animation track data for every instance |
| `images/` | Individual PNG images for each display object |

A copy of `placements.json` is also written directly to `<outputFolder>/` for convenience.

---

## Usage

```bash
/path/to/swfExporter_mac.app/Contents/MacOS/FlashToOutput \
  -swf:/absolute/path/to/file.swf \
  [-outputFolder:/absolute/path/to/output] \
  [-useTextureAtlas]
```

### Arguments

| Argument | Required | Description |
|---|---|---|
| `-swf:<path>` | Yes | Absolute path to the `.swf` file to export |
| `-outputFolder:<path>` | No | Output directory. Defaults to the SWF's own directory. |
| `-useTextureAtlas` | No | Pack all images into a single texture atlas instead of individual PNGs |

### Example

```bash
./swfExporter_mac.app/Contents/MacOS/FlashToOutput \
  -swf:/Users/me/myProject/animation.swf \
  -outputFolder:/Users/me/myProject/exported
```

Output will be written to:
```
/Users/me/myProject/exported/output/placements.json
/Users/me/myProject/exported/output/images/SomeSymbol.png
...
```

---

## SWF Structure Requirements

The exporter expects the `.swf` to follow specific rules. If your `.swf` was compiled from an `.fla` that doesn't meet these requirements, it will not export correctly.

| Requirement | Detail |
|---|---|
| **No Graphic symbols** | Every symbol in the library must be a MovieClip |
| **One MovieClip per layer** | Each layer may contain only a single MovieClip instance |
| **Linkage identifiers** | Every MovieClip must have an ActionScript linkage identifier set |
| **No bitmap animations** | Bitmaps must not be animated directly — wrap them in a MovieClip first |
| **No mask layers** | Mask and masked layers are not supported and must be removed |

---

## Fixing Your FLA with the JSFL Scripts

The `jsfl/` folder contains three scripts for Adobe Animate that automatically fix a non-conforming `.fla` file.

```
jsfl/
  runFullPipeline.jsfl              ← run this
  unifyKeyframesToFirstSymbol.jsfl
  convertLibraryToMovieClips.jsfl
```

### Normal workflow

> **Save your `.fla` before running any script.**

1. Open your `.fla` in Adobe Animate.
2. Open the Scripts panel (`Commands > Run Script...` or via the JSFL panel).
3. Run **`runFullPipeline.jsfl`**.

This single script:
1. Walks every timeline (root scene and all nested MovieClips) and ensures each layer contains only one consistent MovieClip across all its keyframes (`unifyKeyframesToFirstSymbol.jsfl`).
2. Converts any remaining Graphic symbols to MovieClips, assigns linkage identifiers to every MovieClip, wraps bare bitmap instances in their own MovieClip, and removes unused library items (`convertLibraryToMovieClips.jsfl`).

After it completes, re-publish the `.swf` and run the exporter.

### If you hit errors

Run the two scripts manually, one step at a time:

1. Select the problem layer(s) in the timeline.
2. Run **`unifyKeyframesToFirstSymbol.jsfl`** — repeat for each layer or set of layers that has issues.
3. Once all timelines are clean, run **`convertLibraryToMovieClips.jsfl`** once across the whole library.

Check the **Output** panel in Animate after each run for trace messages that describe what was changed or skipped.
