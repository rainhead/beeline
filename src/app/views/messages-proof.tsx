import type { Messages } from "../messages/index.js";

/**
 * The string-proofing screen (companion to /patterns): the whole catalog
 * rendered flat. Message functions are invoked with «sample» placeholders —
 * safe because messages only interpolate (a template coerces anything), and
 * the placeholders make each slot visible to the proofreader.
 */

const SAMPLE_ARG = "«sample»";

function flatten(node: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof node === "string") {
    out.push([path, node]);
  } else if (typeof node === "function") {
    const fn = node as (...args: unknown[]) => unknown;
    out.push([path, String(fn(...(Array(fn.length).fill(SAMPLE_ARG) as unknown[])))]);
  } else if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) flatten(value, path === "" ? key : `${path}.${key}`, out);
  }
}

export function MessagesProof({ m }: { m: Messages }) {
  const sections = new Map<string, Array<[string, string]>>();
  const flat: Array<[string, string]> = [];
  flatten(m, "", flat);
  for (const [path, text] of flat) {
    const section = path.split(".")[0]!;
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section)!.push([path, text]);
  }

  return (
    <>
      <h1>{m.messagesProof.heading}</h1>
      <p>{m.messagesProof.intro}</p>
      {[...sections].map(([section, entries]) => (
        <>
          <h2>{section}</h2>
          <table>
            <thead>
              <tr>
                <th style="width: 30%">{m.messagesProof.keyHeader}</th>
                <th>{m.messagesProof.textHeader}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([path, text]) => (
                <tr>
                  <td>
                    <code>{path}</code>
                  </td>
                  <td>{text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ))}
    </>
  );
}
