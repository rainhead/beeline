import type { Messages } from "../messages/index.js";
import { KEY_LIFETIMES_DAYS, KEY_NAME_MAX, type CreateKeyProblem, type KeyListing, type KeyScope } from "../api-keys.js";
import { Button, Callout, Chip, DataTable, EmptyState, Meta, PageHeader, SelectField, TextField } from "./components/index.js";

/**
 * A table of keys, for the person's own page and for staff looking at somebody
 * else's (beeline-pnqr.9): never the key, only its reference. `revokeAction`
 * gives the address a Revoke button posts to for a working key, or null where
 * there is to be no button.
 */
export function KeysTable({
  m,
  keys,
  revokeAction,
  now,
  audience = "owner",
}: {
  m: Messages;
  keys: KeyListing[];
  revokeAction: (ref: string) => string | null;
  now: Date;
  /** Whose page: the owner's own, or staff looking at somebody else's, which always says who revoked a key. */
  audience?: "owner" | "staff";
}) {
  const k = m.keys;
  const working = (key: KeyListing) => key.revokedAt === null && key.expiresAt > now;
  return (
    <DataTable columns={[k.col.name, k.col.scope, k.col.created, k.col.expires, k.col.lastUsed, k.col.reference, ""]}>
      {keys.map((key) => {
        const action = working(key) ? revokeAction(key.ref) : null;
        return (
          <tr>
            <td>{key.name}</td>
            <td>{k.scope[key.scope].label}</td>
            <td>{m.format.date(key.createdAt)}</td>
            <td>
              {key.revokedAt !== null ? (
                <Chip>{k.revoked(m.format.date(key.revokedAt), key.revokedBy, key.revokedReason, audience)}</Chip>
              ) : key.expiresAt <= now ? (
                <Chip>{k.expired(m.format.date(key.expiresAt))}</Chip>
              ) : (
                m.format.date(key.expiresAt)
              )}
            </td>
            <td>{key.lastUsedAt === null ? <Meta>{k.neverUsed}</Meta> : m.format.dateTime(key.lastUsedAt)}</td>
            <td>
              <code>{key.ref}</code>
            </td>
            <td>
              {action !== null && (
                <form method="post" action={action}>
                  <Button variant="outlined">{k.revoke}</Button>
                </form>
              )}
            </td>
          </tr>
        );
      })}
    </DataTable>
  );
}

/**
 * A person's own API keys (beeline-pnqr.1): the keys they have made, a form
 * to make another, and a button to revoke each. A new key is shown on the
 * page that answers the form and nowhere after, since the store keeps only
 * its hash.
 *
 * Always about the person signed in, never the person being acted for: a key
 * is a way to sign in as its owner, which a delegation does not hand over.
 */
export function KeysPage({
  m,
  keys,
  scopes,
  created,
  problem,
  acting,
  now,
}: {
  m: Messages;
  keys: KeyListing[];
  /** The scopes this person may give a key. */
  scopes: readonly KeyScope[];
  /** The key just made, to be shown this once. */
  created?: { key: string; name: string };
  problem?: CreateKeyProblem;
  /** Acting for somebody else: the list is still the signed-in person's, and nothing can be changed. */
  acting: boolean;
  now: Date;
}) {
  const k = m.keys;
  return (
    <>
      <PageHeader title={k.heading} lede={k.intro} />
      {created !== undefined && (
        <Callout tone="success">
          <p>{k.created.lead(created.name)}</p>
          <p>
            <code class="secret">{created.key}</code>
          </p>
          <p>{k.created.use}</p>
        </Callout>
      )}
      {problem !== undefined && <Callout tone="blocking">{k.problems[problem]}</Callout>}
      <h2>{k.yours}</h2>
      {keys.length === 0 ? (
        <EmptyState>{k.none}</EmptyState>
      ) : (
        <KeysTable m={m} keys={keys} revokeAction={(ref) => (acting ? null : `/keys/${ref}/revoke`)} now={now} />
      )}
      <h2>{k.create.heading}</h2>
      {acting && <Callout>{k.create.acting}</Callout>}
      {!acting && (
        <form method="post" action="/keys" class="stack">
          <TextField id="key-name" name="name" label={k.create.name} hint={k.create.nameHint(KEY_NAME_MAX)} />
          <SelectField
            id="key-scope"
            name="scope"
            label={k.create.scope}
            value={scopes[0]!}
            options={scopes.map((s) => [s, `${k.scope[s].label}: ${k.scope[s].means}`] as const)}
          />
          <SelectField
            id="key-lifetime"
            name="lifetime"
            label={k.create.lifetime}
            value="30"
            options={KEY_LIFETIMES_DAYS.map((d) => [String(d), k.create.days(d)] as const)}
            hint={k.create.lifetimeHint}
          />
          <Button>{k.create.submit}</Button>
        </form>
      )}
    </>
  );
}
