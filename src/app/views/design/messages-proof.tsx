import type { Messages } from "../../messages/index.js";
import { DataTable } from "../components/index.js";
import { DesignPage } from "./shell.js";

/**
 * The string-proofing screen: the whole catalog rendered flat. Message
 * functions are invoked with «sample» placeholders — safe because messages
 * only interpolate (a template coerces anything), and the placeholders make
 * each slot visible to the proofreader.
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
    <DesignPage
      current="/design/messages"
      title="Message catalog"
      lede="Every message a volunteer can see, rendered. Functions are called with «sample» placeholders so each interpolation slot is visible. Proof copy here before any screen ships it."
    >
      {[...sections].map(([section, entries]) => (
        <>
          <h2>{section}</h2>
          <DataTable columns={["Key", "Rendered"]}>
            {entries.map(([path, text]) => (
              <tr>
                <td>
                  <code>{path}</code>
                </td>
                <td>{text}</td>
              </tr>
            ))}
          </DataTable>
        </>
      ))}
    </DesignPage>
  );
}
