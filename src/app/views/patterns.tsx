/**
 * The pattern library / proofing screen: every base-stylesheet pattern and
 * token on one authenticated page, so design changes are proofed here before
 * any real screen wears them.
 */

const COLOR_ROLES = [
  ["primary", "on-primary"],
  ["primary-container", "on-primary-container"],
  ["secondary", "on-secondary"],
  ["secondary-container", "on-secondary-container"],
  ["tertiary", "on-tertiary"],
  ["tertiary-container", "on-tertiary-container"],
  ["error", "on-error"],
  ["error-container", "on-error-container"],
  ["surface", "on-surface"],
  ["surface-variant", "on-surface-variant"],
  ["background", "on-background"],
] as const;

const TYPE_SCALE = ["display", "headline", "title", "body", "label"] as const;

export function Patterns() {
  return (
    <>
      <h1>Pattern library</h1>
      <p>
        Every pattern the app dresses in, on one page. Colors are generated from the seed in{" "}
        <code>src/app/theme/tokens.ts</code>; shapes and type live in <code>src/app/static/base.css</code>. Flip your
        system color scheme to proof dark mode.
      </p>

      <h2>Color roles</h2>
      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: 0.5rem">
        {COLOR_ROLES.map(([bg, fg]) => (
          <div
            style={`background: var(--md-sys-color-${bg}); color: var(--md-sys-color-${fg}); border: 1px solid var(--md-sys-color-outline-variant); border-radius: var(--md-sys-shape-corner); padding: 0.75rem`}
          >
            {bg}
            <br />
            <small>{fg}</small>
          </div>
        ))}
      </div>

      <h2>Type scale</h2>
      {TYPE_SCALE.map((step) => (
        <p style={`font: var(--md-sys-typescale-${step})`}>
          {step} — Andrena prunorum on Phacelia hastata
        </p>
      ))}

      <h2>Buttons and chips</h2>
      <p style="display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap">
        <button>Filled</button>
        <button class="tonal">Tonal</button>
        <button class="outlined">Outlined</button>
        <span class="chip">3 specimens</span>
        <span class="chip error">locality too long</span>
      </p>

      <h2>Form controls</h2>
      <form>
        <label for="p-locality">Locality</label>
        <input id="p-locality" type="text" value="Corvallis" />
        <label for="p-protocol">Protocol</label>
        <select id="p-protocol">
          <option>net</option>
          <option>trap</option>
        </select>
        <label for="p-notes">Notes</label>
        <textarea id="p-notes" rows={2}>
          Collected along the fence line.
        </textarea>
      </form>

      <h2>Table</h2>
      <table>
        <thead>
          <tr>
            <th>Sample</th>
            <th>Date</th>
            <th>Locality</th>
            <th>Specimens</th>
            <th>Findings</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>3</td>
            <td>2026-07-14</td>
            <td>Corvallis</td>
            <td>3</td>
            <td>—</td>
          </tr>
          <tr>
            <td>4</td>
            <td>2026-07-15</td>
            <td>Alsea Falls</td>
            <td>12</td>
            <td>
              <span class="chip error">missing host</span>
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Card</h2>
      <div class="card" style="max-width: 24rem">
        <h3 style="margin-top: 0">Sample 4 — Alsea Falls</h3>
        <p>Cards frame anything that isn't a table row.</p>
      </div>

      <h2>Island</h2>
      <p>
        A Lit component hydrated client-side, in light DOM so this same stylesheet reaches in. If the counter counts,
        the Vite island build and hydration chain work:
      </p>
      <demo-counter></demo-counter>
    </>
  );
}
