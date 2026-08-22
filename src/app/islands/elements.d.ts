// Custom-element tags the server may emit. Each island registered in
// index.ts gets a row here so JSX knows the tag (attributes stay stringly —
// islands read attributes, never JSX props).
import "hono/jsx";

declare module "hono/jsx" {
  namespace JSX {
    interface IntrinsicElements {
      "demo-counter": { class?: string };
    }
  }
}
