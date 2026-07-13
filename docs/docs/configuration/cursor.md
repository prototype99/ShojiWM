---
sidebar_position: 4.5
---

# Cursor theme

`COMPOSITOR.cursor` configures the XCursor theme used by ShojiWM's
compositor-owned named cursors, including the default pointer and SSD resize
cursors.

```ts
COMPOSITOR.cursor.configure({
  theme: 'Bibata-Modern-Classic',
  size: 24,
});
```

`theme` is the installed XCursor theme name. `size` is an integer from 1 to 512
in **logical pixels**. ShojiWM chooses an appropriately scaled image for each
output, so a size of 24 remains the same logical size on scale-1 and scale-2
outputs.

Calling `configure()` takes effect without restarting ShojiWM and also:

- sets `XCURSOR_THEME` and `XCURSOR_SIZE` for processes started afterwards;
- publishes those variables to the systemd and D-Bus activation environments;
- discards ShojiWM's decoded cursor and GPU buffer caches; and
- schedules the new named cursor for the next redraw.

## Reloading theme files

If theme files were replaced without changing their theme name or size, reload
the current theme explicitly:

```ts
COMPOSITOR.cursor.reload();
```

This is also available from a keybinding:

```ts
COMPOSITOR.key.bind('reload-cursor', 'Super+Shift+C', () => {
  COMPOSITOR.cursor.reload();
});
```

## Client-owned cursor surfaces

Wayland clients may send their own cursor surface. ShojiWM must display that
surface as supplied by the client and cannot replace it with a named cursor.
The exported XCursor environment variables let newly started toolkits choose
the same theme, but an already-running application may need to be restarted or
to reload its own settings before its client-owned cursor changes.

Changing the cursor configuration never replaces or modifies a client-owned
cursor surface.
