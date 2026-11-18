import type { Messages } from "../messages/index.js";
import type { describeApi } from "../api-description.js";
import type { KeyScope } from "../api-keys.js";
import { Chip, DataTable } from "./components/index.js";

/** The description the API serves at GET /api/v1: this page is drawn from it, not from a second list. */
export type ApiDescription = ReturnType<typeof describeApi>;

/** The scope an endpoint needs, as the description names it. */
const NEEDED_SCOPE: Record<string, KeyScope> = { "any key": "read", "edit key": "edit", "staff key": "staff" };

const anchor = (method: string, path: string) => `${method}-${path}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");

/** `Param`s of an endpoint: a name, what it means, and the values it takes where that is a list. */
function NameTable({ m, rows, withValues }: { m: Messages; rows: Array<[string, string, readonly string[] | undefined]>; withValues: boolean }) {
  const d = m.keys.docs.endpoints;
  return (
    <DataTable columns={withValues ? [d.name, d.meaning, d.values] : [d.name, d.meaning]}>
      {rows.map(([name, meaning, values]) => (
        <tr>
          <td>
            <code>{name}</code>
          </td>
          <td>{meaning}</td>
          {withValues && <td>{values === undefined ? "" : values.join(", ")}</td>}
        </tr>
      ))}
    </DataTable>
  );
}

/**
 * The documentation half of the API page: how to use a key, then every
 * endpoint of the API exactly as `describeApi` lists it (so a new endpoint
 * appears with no change here), then the columns of the listings. Prose that
 * the description does not carry comes from the message catalogue.
 *
 * `scopes` are the kinds of key this viewer may make; an endpoint that needs
 * a kind they cannot make is marked, and still listed.
 */
export function ApiDocs({ m, description, scopes }: { m: Messages; description: ApiDescription; scopes: readonly KeyScope[] }) {
  const d = m.keys.docs;
  const limits = description.limits;
  return (
    <>
      <h2>{d.heading}</h2>
      <p>{d.lede}</p>

      <h3>{d.sendKey.heading}</h3>
      <p>{d.sendKey.body}</p>
      <p>{d.sendKey.example}</p>
      <pre>
        <code>{`curl -H "Authorization: Bearer ${d.sendKey.exampleKey}" ${description.base_url}/me`}</code>
      </pre>

      <h3>{d.scopes.heading}</h3>
      <p>{d.scopes.body}</p>
      <DataTable columns={[m.keys.col.scope, m.keys.docs.endpoints.meaning]}>
        {Object.entries(description.authentication.scopes).map(([scope, means]) => (
          <tr>
            <td>
              <code>{scope}</code>
            </td>
            <td>{means}</td>
          </tr>
        ))}
      </DataTable>

      <h3>{d.limits.heading}</h3>
      <ul>
        <li>{d.limits.requests(limits.requests_per_minute_per_person)}</li>
        <li>{d.limits.reads(limits.read_requests_per_minute_per_person)}</li>
        <li>{d.limits.over}</li>
        <li>{d.limits.pageSize(limits.page_size_max)}</li>
        <li>{d.limits.body(limits.write_body_max_bytes / 1024)}</li>
      </ul>

      <h3>{d.reference.heading}</h3>
      <p>{d.reference.body}</p>

      <h3>{d.errors.heading}</h3>
      <p>{d.errors.body}</p>
      <DataTable columns={[d.errors.status, d.errors.meaning]}>
        {Object.entries(description.statuses).map(([status, means]) => (
          <tr>
            <td>
              <code>{status}</code>
            </td>
            <td>{means}</td>
          </tr>
        ))}
      </DataTable>
      <p>{d.people}</p>

      <h2>{d.endpoints.heading}</h2>
      <p>
        {d.endpoints.lede} {d.endpoints.base}: <code>{new URL(description.base_url).origin}</code>
      </p>
      {description.endpoints.map((e) => {
        const usable = scopes.includes(NEEDED_SCOPE[e.needs] ?? "staff");
        const parameters = Object.entries(e.parameters ?? {}).map(
          ([name, spec]): [string, string, readonly string[] | undefined] => [
            name,
            (spec as { meaning: string }).meaning,
            (spec as { values?: readonly string[] }).values,
          ],
        );
        const body = Object.entries(e.body ?? {}).map(([name, what]): [string, string, undefined] => [name, what, undefined]);
        return (
          <section class="api-endpoint" id={anchor(e.method, e.path)}>
            <h3>
              <code>
                {e.method} {e.path}
              </code>
            </h3>
            <p>
              {e.summary}{" "}
              <Chip>{d.endpoints.needs[e.needs] ?? e.needs}</Chip>
              {!usable && (
                <>
                  {" "}
                  <span title={d.endpoints.notForYouHint}>
                    <Chip tone="warning">{d.endpoints.notForYou}</Chip>
                  </span>
                </>
              )}
            </p>
            {parameters.length > 0 && (
              <>
                <h4>{d.endpoints.parameters}</h4>
                <NameTable m={m} rows={parameters} withValues={parameters.some((p) => p[2] !== undefined)} />
              </>
            )}
            {body.length > 0 && (
              <>
                <h4>{d.endpoints.body}</h4>
                <NameTable m={m} rows={body} withValues={false} />
              </>
            )}
            <h4>{d.endpoints.answers}</h4>
            <p>{e.answers}</p>
          </section>
        );
      })}

      <h2>{d.columns.heading}</h2>
      <p>{d.columns.lede}</p>
      {(["samples", "specimens"] as const).map((which) => (
        <details>
          <summary>{d.columns[which]}</summary>
          <NameTable m={m} rows={description.columns[which].map((c): [string, string, undefined] => [c.name, c.meaning, undefined])} withValues={false} />
        </details>
      ))}
    </>
  );
}
