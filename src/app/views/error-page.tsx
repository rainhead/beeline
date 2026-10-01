import type { Messages } from "../messages/index.js";
import { PageHeader } from "./components/text.js";

/**
 * What a request gets when it fails or finds nothing (beeline-0kj): the
 * ordinary page with the header, the menu and Send feedback still there,
 * saying what happened in plain words and offering a way on.
 */

export type ErrorKind = "notFound" | "failed";

export interface ErrorPageProps {
  m: Messages;
  kind: ErrorKind;
  /** A failure's reference, shown and carried in the feedback email. */
  reference?: string;
  /** Overrides the not-found wording where the page knows more and saying so leaks nothing. */
  message?: string;
  /** And its heading, where the generic one would contradict the message. */
  heading?: string;
  /** Where "Go back" leads: the same-site page that linked here, if there was one. */
  back?: string | null;
  /** The error itself — development only, never anywhere a volunteer could see it. */
  dev?: { text: string; staleStore: boolean } | null;
}

export function ErrorPage({ m, kind, reference, message, heading, back, dev }: ErrorPageProps) {
  const e = m.errorPage;
  const copy = e[kind];
  return (
    <>
      <PageHeader title={kind === "notFound" ? (heading ?? copy.heading) : copy.heading} lede={kind === "notFound" ? (message ?? copy.body) : copy.body} />
      {kind === "failed" && reference !== undefined && <p class="meta">{e.failed.reference(reference)}</p>}
      <p class="row">
        {back && (
          <a class="button tonal" href={back}>
            {e.back}
          </a>
        )}
        <a class="button outlined" href="/">
          {e.home}
        </a>
      </p>
      {dev && (
        <details open>
          <summary>{e.dev.heading}</summary>
          {dev.staleStore && <p>{e.dev.staleStore}</p>}
          <pre>{dev.text}</pre>
        </details>
      )}
    </>
  );
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/**
 * The page of last resort, for when rendering the real one failed too — the
 * store unreachable, say, so the layout cannot resolve the person. Nothing
 * here depends on anything that can break: no session, no store, no
 * stylesheet beyond the tokens.
 */
export function staticErrorPage(m: Messages, kind: ErrorKind, reference?: string): string {
  const copy = m.errorPage[kind];
  const ref = kind === "failed" && reference !== undefined ? `<p>${escape(m.errorPage.failed.reference(reference))}</p>` : "";
  return (
    `<!doctype html><html lang="${escape(m.locale)}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escape(m.layout.pageTitle(copy.title))}</title></head>` +
    `<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5">` +
    `<h1>${escape(copy.heading)}</h1><p>${escape(copy.body)}</p>${ref}<p><a href="/">${escape(m.errorPage.home)}</a></p>` +
    `</body></html>`
  );
}
