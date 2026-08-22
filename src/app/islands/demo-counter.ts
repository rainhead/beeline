import { html, LitElement } from "lit";

/**
 * Proof-of-chain island for the pattern library: if the button counts, the
 * Vite build, module loading, and hydration all work. Islands render in light
 * DOM so the base stylesheet reaches in (no shadow boundary).
 */
export class DemoCounter extends LitElement {
  static properties = { count: { state: true } };
  declare count: number;

  constructor() {
    super();
    this.count = 0;
  }

  override createRenderRoot() {
    return this; // light DOM, by convention for all islands
  }

  override render() {
    return html`<button class="tonal" @click=${() => this.count++}>Counted ${this.count}</button>`;
  }
}

customElements.define("demo-counter", DemoCounter);
