import { describe, expect, it, vi } from "vitest";
import { type ZoomInput, type ZoomableContents, nextZoomLevel, registerZoomShortcuts } from "./zoom.js";

function key(partial: Partial<ZoomInput>): ZoomInput {
  return { type: "keyDown", key: "", control: true, meta: false, alt: false, ...partial };
}

describe("nextZoomLevel", () => {
  // Regression: the default menu's zoom-IN accelerator ("CommandOrControl+Plus") never matches Ctrl+= on a US
  // layout (the "+" key is Shift+=), so only zoom-out/reset used to work. Both glyphs must zoom in.
  it("zooms in on Ctrl+= (unshifted) and Ctrl++ (shifted) alike", () => {
    expect(nextZoomLevel(key({ key: "=" }), 0)).toBe(0.5);
    expect(nextZoomLevel(key({ key: "+" }), 0)).toBe(0.5);
  });

  it("zooms out on Ctrl+- and Ctrl+_ , and resets on Ctrl+0", () => {
    expect(nextZoomLevel(key({ key: "-" }), 0)).toBe(-0.5);
    expect(nextZoomLevel(key({ key: "_" }), 0)).toBe(-0.5);
    expect(nextZoomLevel(key({ key: "0" }), 2)).toBe(0);
  });

  it("accepts Cmd (meta) as well as Ctrl for macOS", () => {
    expect(nextZoomLevel(key({ key: "=", control: false, meta: true }), 0)).toBe(0.5);
  });

  it("ignores a zoom key without Ctrl/Cmd, with Alt held, or on key-up", () => {
    expect(nextZoomLevel(key({ key: "=", control: false, meta: false }), 0)).toBeNull();
    expect(nextZoomLevel(key({ key: "=", alt: true }), 0)).toBeNull();
    expect(nextZoomLevel(key({ key: "=", type: "keyUp" }), 0)).toBeNull();
  });

  it("ignores non-zoom keys", () => {
    expect(nextZoomLevel(key({ key: "a" }), 0)).toBeNull();
  });

  it("clamps to the sane zoom range in both directions", () => {
    expect(nextZoomLevel(key({ key: "+" }), 4)).toBe(4);
    expect(nextZoomLevel(key({ key: "-" }), -4)).toBe(-4);
  });
});

describe("registerZoomShortcuts", () => {
  function fakeContents(): ZoomableContents & {
    fire(input: ZoomInput): { prevented: boolean };
    setZoomLevel: ReturnType<typeof vi.fn>;
  } {
    let level = 0;
    let listener: ((event: { preventDefault(): void }, input: ZoomInput) => void) | null = null;
    const setZoomLevel = vi.fn((l: number) => {
      level = l;
    });
    return {
      on: (_event, l) => {
        listener = l;
      },
      getZoomLevel: () => level,
      setZoomLevel,
      fire: (input) => {
        let prevented = false;
        listener?.(
          {
            preventDefault: () => {
              prevented = true;
            },
          },
          input,
        );
        return { prevented };
      },
    };
  }

  it("preventDefaults and steps the zoom level on a zoom shortcut", () => {
    const contents = fakeContents();
    registerZoomShortcuts(contents);
    // Two zoom-ins accumulate; preventDefault also suppresses the (broken) default menu accelerator.
    expect(contents.fire(key({ key: "+" })).prevented).toBe(true);
    expect(contents.fire(key({ key: "+" })).prevented).toBe(true);
    expect(contents.setZoomLevel).toHaveBeenLastCalledWith(1);
  });

  it("leaves non-zoom keystrokes alone (no preventDefault, no zoom change)", () => {
    const contents = fakeContents();
    registerZoomShortcuts(contents);
    expect(contents.fire(key({ key: "a" })).prevented).toBe(false);
    expect(contents.setZoomLevel).not.toHaveBeenCalled();
  });
});
