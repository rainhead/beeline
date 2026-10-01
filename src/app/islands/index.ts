/**
 * The islands bundle: every Lit component the server may emit a tag for.
 * Vite builds this entry (with a manifest the server reads for the hashed
 * URL); registering here is what makes a component available to pages.
 */
import "./demo-counter.js";
import "./menus.js";
// PROTOTYPE (beeline-bcq), throwaway branch only.
import "./prototype-determinations/shared.js";
import "./prototype-determinations/variant-a-grid.js";
import "./prototype-determinations/variant-b-box.js";
import "./prototype-determinations/variant-c-tray.js";
