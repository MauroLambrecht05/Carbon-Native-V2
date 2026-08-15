// document.fonts — a FontFaceSet stub.

export function installFontFaceSet(doc: any): void {
  // document.fonts — FontFaceSet stub. xterm.js + many CSS-typography
  // libraries await `document.fonts.ready` before laying out text. We
  // resolve immediately because the runtime ships its own pre-loaded
  // font set (Inter / JetBrains Mono) via fontdue; nothing JS-side
  // needs to wait for a load event.
  if (!(doc as unknown as { fonts?: unknown }).fonts) {
    const readyP = Promise.resolve();
    const fontsStub = {
      ready: readyP,
      status: "loaded" as const,
      size: 0,
      add() {},
      delete() { return true; },
      clear() {},
      check() { return true; },
      load() { return Promise.resolve([]); },
      forEach() {},
      values: function* () {},
      keys: function* () {},
      entries: function* () {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return true; },
    };
    (doc as unknown as { fonts: typeof fontsStub }).fonts = fontsStub;
  }
}
