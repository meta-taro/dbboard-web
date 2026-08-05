/**
 * The `@tanstack/vue-virtual` stand-in both grid test files mount against.
 *
 * We trust the virtualizer itself and only test our component's rendering, so
 * this returns every row as a visible virtual item. That is the point: on
 * happy-dom `getBoundingClientRect` always reports zero size, so the real
 * virtualizer would render nothing and every assertion would be about an
 * empty table.
 *
 * Shared rather than copied because the two files disagreeing about what a
 * virtual item looks like would show up as a component bug in one of them.
 * Import it from inside the `vi.mock` factory — the factory is hoisted above
 * the imports, so it has to reach for this itself:
 *
 * ```ts
 * vi.mock("@tanstack/vue-virtual", async () => ({
 *   useVirtualizer: (await import("./helpers/virtualizer")).fakeUseVirtualizer,
 * }));
 * ```
 */

interface VirtualizerOptions {
  count: number;
  estimateSize: () => number;
}

/** Accepts the options however the component passes them — a getter, a ref,
 *  or a plain object — so the mock does not constrain the call site. */
function readOptions(computedOptions: unknown): VirtualizerOptions {
  const candidate = computedOptions as
    | (() => VirtualizerOptions)
    | { value?: VirtualizerOptions }
    | VirtualizerOptions;
  if (typeof candidate === "function") return candidate();
  if (
    candidate &&
    typeof candidate === "object" &&
    "value" in candidate &&
    candidate.value !== undefined
  ) {
    return candidate.value;
  }
  return candidate as VirtualizerOptions;
}

export function fakeUseVirtualizer(computedOptions: unknown) {
  return {
    value: {
      getVirtualItems: () => {
        const opts = readOptions(computedOptions);
        const size = opts.estimateSize();
        return Array.from({ length: opts.count }, (_, index) => ({
          index,
          start: index * size,
          size,
          end: (index + 1) * size,
          key: index,
        }));
      },
      getTotalSize: () => {
        const opts = readOptions(computedOptions);
        return opts.count * opts.estimateSize();
      },
      measureElement: () => {},
    },
  };
}
