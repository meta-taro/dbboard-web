import { defineConfig, minimal2023Preset } from "@vite-pwa/assets-generator/config";

// minimal-2023 preset emits the smallest viable PWA icon set:
//   public/favicon.ico
//   public/icons/pwa-64x64.png
//   public/icons/pwa-192x192.png
//   public/icons/pwa-512x512.png
//   public/icons/maskable-icon-512x512.png
//   public/icons/apple-touch-icon-180x180.png
//
// We re-point the output into public/icons/ to keep root tidy.
//
// Regenerate manually with: pnpm pwa-assets
// (kept off the postinstall path — icons are checked into git so production
// builds never depend on the sharp binary being present.)
export default defineConfig({
  preset: {
    ...minimal2023Preset,
    transparent: {
      ...minimal2023Preset.transparent,
      sizes: [64, 192, 512],
      favicons: [[48, "favicon.ico"]],
    },
    maskable: {
      ...minimal2023Preset.maskable,
      sizes: [512],
    },
    apple: {
      ...minimal2023Preset.apple,
      sizes: [180],
    },
  },
  images: ["public/icons/source.svg"],
  headLinkOptions: {
    preset: "2023",
  },
});
