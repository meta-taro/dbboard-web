// Nuxt's @nuxt/eslint generates this config based on nuxt.config.ts.
// withNuxt() pulls in Vue + TypeScript rules consistent with the app's modules.
import withNuxt from "./.nuxt/eslint.config.mjs";

export default withNuxt({
  rules: {
    // Prettier rewrites `<input>` to `<input />` in Vue templates, and this
    // rule's default (`void: "never"`) warns about exactly that — so the
    // warning cannot be acted on: satisfying it fails `pnpm format:check`,
    // and leaving it trains everyone to skim past lint output. Prettier
    // owns the void-element spelling. `normal` and `component` keep their
    // defaults, where there is no formatter opinion to collide with.
    "vue/html-self-closing": ["warn", { html: { void: "any" } }],
  },
});
