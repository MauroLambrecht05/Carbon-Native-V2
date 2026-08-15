// Legacy keyCode / code derivation from a KeyboardEvent.key value.
//
// A shim rather than an install: nothing here touches globalThis. The
// keyboard bridge in globals/install.ts calls it when translating the
// runtime's `__cm_dispatch_keydown` into a DOM KeyboardEvent.

// Legacy keyCode/which derivation from a KeyboardEvent.key value. xterm.js
// (and CodeMirror, Monaco, etc.) branch on keyCode for non-printable keys,
// so the keydown bridge must supply it.
const _KEYCODE: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18,
  Pause: 19, CapsLock: 20, Escape: 27, " ": 32, Spacebar: 32,
  PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Insert: 45, Delete: 46, Meta: 91, ContextMenu: 93,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118,
  F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
};
// Physical keyCodes for US-layout punctuation / symbols. The keyCode
// reflects the PHYSICAL KEY, so a glyph and its shifted glyph share one code
// (e.g. `'` and `"` are both 222). This matters for two reasons xterm cares
// about:
//   1. Many symbols' character codes collide with named-key codes — `'`
//      is charCode 39 = ArrowRight, `(` is 40 = ArrowDown, `{` is 123 = F12.
//      Returning the character code made typing them fire cursor moves / F12.
//   2. xterm only treats a keydown as printable when keyCode >= 48, so a
//      symbol whose character code is < 48 (`"`=34, `!`=33, …) was dropped.
// The real physical codes are all >= 48 and avoid the named-key cases.
const _PUNCT_KEYCODE: Record<string, number> = {
  ";": 186, ":": 186,
  "=": 187, "+": 187,
  ",": 188, "<": 188,
  "-": 189, "_": 189,
  ".": 190, ">": 190,
  "/": 191, "?": 191,
  "`": 192, "~": 192,
  "[": 219, "{": 219,
  "\\": 220, "|": 220,
  "]": 221, "}": 221,
  "'": 222, '"': 222,
  // Shifted digit row → the digit's own physical key.
  "!": 49, "@": 50, "#": 51, "$": 52, "%": 53,
  "^": 54, "&": 55, "*": 56, "(": 57, ")": 48,
};
export function keyToKeyCode(key: string): number {
  if (key in _KEYCODE) return _KEYCODE[key];
  if (key.length === 1) {
    if (key in _PUNCT_KEYCODE) return _PUNCT_KEYCODE[key];
    // Letters A-Z → 65-90, digits 0-9 → 48-57 already match their key code.
    return key.toUpperCase().charCodeAt(0);
  }
  return 0;
}
export function keyToCode(key: string): string {
  if (key.length === 1) {
    const u = key.toUpperCase();
    if (u >= "A" && u <= "Z") return "Key" + u;
    if (key >= "0" && key <= "9") return "Digit" + key;
    if (key === " ") return "Space";
  }
  if (key === " ") return "Space";
  if (key.startsWith("Arrow") || key.length > 1) return key;
  return "";
}
