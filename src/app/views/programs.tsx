import type { Messages } from "../messages/index.js";
import { LICENSES } from "../../program-governance.js";
import { programHref, type ProgramDetail, type ProgramLead, type ProgramSummary } from "../programs.js";
import { EMPTY_ROSTER_QUERY, rosterHref } from "../roster.js";
import { Absent, Breadcrumbs, DataTable, DetailList, EmptyState, Meta, PageHeader } from "./components/index.js";

/**
 * The programs (beeline-rrit): a listing, and one page per program saying
 * what Beeline knows about it. Read by everyone signed in, so every word comes
 * from the catalog; the links into the listings and the roster are drawn only
 * for staff, who are the only ones those pages would show everybody's to.
 */

/**
 * A YYYY-MM-DD from the curated files as that day: `new Date` would read it
 * as midnight UTC, which is the evening before in Pacific time.
 */
const localDate = (iso: string) => {
  const [y, mo, day] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, mo - 1, day);
};

/** A records listing scoped to the program, as staff reach it. */
const scopedHref = (path: "/samples" | "/specimens", scope: string) => `${path}?${new URLSearchParams({ scope }).toString()}`;

/**
 * A link that may safely be one: http(s) as written, anything else as text.
 * The values arrive from curated files and the store, and escaping does not
 * stop a `javascript:` scheme from being a scheme.
 */
function Source({ value, label }: { value: string; label: string }) {
  return /^https?:\/\//i.test(value) ? <a href={value}>{label}</a> : <>{value}</>;
}

function Leads({ m, leads, admin }: { m: Messages; leads: ProgramLead[]; admin: boolean }) {
  if (leads.length === 0) return <Absent label={m.programs.noLeads} spelled />;
  return (
    <>
      {leads.map((lead, i) => (
        <>
          {i > 0 && ", "}
          {admin ? <a href={`/people/${encodeURIComponent(lead.handle)}`}>{lead.name}</a> : lead.name}
        </>
      ))}
    </>
  );
}

function Members({ m, program, admin }: { m: Messages; program: ProgramSummary; admin: boolean }) {
  if (program.members === null) return <Absent label={m.programs.notMembership} spelled />;
  const text = m.programs.membersLink(program.members);
  return admin && program.memberFilter !== null ? (
    <a href={rosterHref(EMPTY_ROSTER_QUERY, { member: program.memberFilter })}>{text}</a>
  ) : (
    <>{text}</>
  );
}

export function ProgramIndex({ m, programs, admin }: { m: Messages; programs: ProgramSummary[]; admin: boolean }) {
  const p = m.programs;
  const season = programs[0]?.openSeason.season ?? new Date().getFullYear();
  return (
    <>
      <PageHeader title={p.title} lede={p.intro} />
      <DataTable columns={[p.colProgram, p.colLeads, p.colMembers, p.colSamples(season), p.colSpecimens]}>
        {programs.map((program) => (
          <tr>
            <td>
              <a href={programHref(program.code)}>{program.name}</a>
            </td>
            <td>
              <Leads m={m} leads={program.leads} admin={admin} />
            </td>
            <td>
              <Members m={m} program={program} admin={admin} />
            </td>
            <td>{program.scope === null ? <Absent label={p.notMembership} /> : m.format.number(program.openSeason.samples)}</td>
            <td>{program.scope === null ? <Absent label={p.notMembership} /> : m.format.number(program.specimens)}</td>
          </tr>
        ))}
      </DataTable>
    </>
  );
}

function Contact({ m, program, admin }: { m: Messages; program: ProgramDetail; admin: boolean }) {
  const p = m.programs;
  return (
    <>
      <h2>{p.contact}</h2>
      <DetailList
        items={[
          { term: p.leads, value: <Leads m={m} leads={program.leads} admin={admin} /> },
          ...program.contacts.map((c) => ({
            term: c.label !== "" ? c.label : c.kind === "email" ? p.email : p.website,
            value: c.kind === "email" ? <a href={`mailto:${c.value}`}>{c.value}</a> : <Source value={c.value} label={c.value} />,
          })),
        ]}
      />
      {program.contacts.length === 0 && (
        <p>
          {p.contactNone}
          {admin && (
            <>
              {" "}
              <Meta>{p.contactAdd}</Meta>
            </>
          )}
        </p>
      )}
    </>
  );
}

function Labels({ m, program }: { m: Messages; program: ProgramDetail }) {
  const p = m.programs;
  if (program.printing === null) return null;
  const answer = program.taxonObscured;
  return (
    <>
      <h2>{p.labels}</h2>
      <p>{program.printing === "own" ? p.printsOwn : p.printedByProgram}</p>
      <p>
        {answer === "unanswered" ? (
          p.taxonObscured.unanswered
        ) : answer === "none" ? (
          p.taxonObscured.outside
        ) : (
          <>
            {p.taxonObscured.answered(answer.decidedBy, answer.decidedOn)} <Source value={answer.source} label={p.taxonObscured.where} />
          </>
        )}
      </p>
    </>
  );
}

function Seasons({ m, program, admin }: { m: Messages; program: ProgramDetail; admin: boolean }) {
  const p = m.programs;
  return (
    <>
      <h2>{p.seasons}</h2>
      {program.scope === null ? (
        <p>{p.surveys}</p>
      ) : program.seasons.length === 0 ? (
        <EmptyState>{p.noRecords}</EmptyState>
      ) : (
        <>
          <DataTable columns={[p.colSeason, p.colSeasonSamples, p.colSeasonSpecimens, p.colSeasonCollectors]}>
            {program.seasons.map((s) => (
              <tr>
                <td>{p.season(s.season)}</td>
                <td>{m.format.number(s.samples)}</td>
                <td>{m.format.number(s.specimens)}</td>
                <td>{m.format.number(s.collectors)}</td>
              </tr>
            ))}
          </DataTable>
          {admin && (
            <p>
              <a href={scopedHref("/samples", program.scope)}>{p.seeSamples}</a> ·{" "}
              <a href={scopedHref("/specimens", program.scope)}>{p.seeSpecimens}</a>
            </p>
          )}
        </>
      )}
    </>
  );
}

function Publishing({ m, program, admin }: { m: Messages; program: ProgramDetail; admin: boolean }) {
  const p = m.programs;
  return (
    <>
      <h2>{p.publishing}</h2>
      {program.licenses.length === 0 ? (
        <p>{p.noLicense}</p>
      ) : (
        <ul>
          {program.licenses.map((l) => (
            <li>
              <a href={LICENSES[l.license].url}>{p.license(LICENSES[l.license].name, l.fromSeason)}</a>.{" "}
              <Meta>
                {p.recorded(l.decidedBy, localDate(l.decidedOn))} <Source value={l.source} label={p.source} />
              </Meta>
            </li>
          ))}
        </ul>
      )}
      {program.policies.length === 0 ? (
        <p>{p.noPolicy}</p>
      ) : (
        <ul>
          {program.policies.map((policy) => (
            <li>
              {p.policy(policy.fromSeason)}:{" "}
              {policy.url === "" ? p.policyNoPage : <Source value={policy.url} label={p.policyRead} />}{" "}
              <Meta>{p.recorded(policy.decidedBy, localDate(policy.decidedOn))}</Meta>
            </li>
          ))}
        </ul>
      )}
      {admin && program.scope !== null && (
        <p>
          <a href="/exports">{p.exports}</a>
        </p>
      )}
    </>
  );
}

export function ProgramPage({ m, program, admin }: { m: Messages; program: ProgramDetail; admin: boolean }) {
  const p = m.programs;
  const season = program.openSeason.season;
  return (
    <>
      <Breadcrumbs label={p.title} trail={[{ href: "/programs", label: p.title }]} />
      <PageHeader title={program.name} meta={p.meta(program.code, program.atlasCode !== null)} />
      <h2>{p.summary}</h2>
      <DetailList
        items={[
          { term: p.members, value: <Members m={m} program={program} admin={admin} /> },
          ...(program.scope === null
            ? []
            : [
                { term: p.collectors(season), value: m.format.number(program.openSeason.collectors) },
                { term: p.samples(season), value: m.format.number(program.openSeason.samples) },
                { term: p.specimens(season), value: m.format.number(program.openSeason.specimens) },
                { term: p.specimensEver, value: m.format.number(program.specimens) },
              ]),
        ]}
      />
      <Contact m={m} program={program} admin={admin} />
      <Labels m={m} program={program} />
      <Seasons m={m} program={program} admin={admin} />
      <Publishing m={m} program={program} admin={admin} />
      {program.ecdysis.length > 0 && (
        <>
          <h2>{p.ecdysis}</h2>
          {program.ecdysis.map((c) => (
            <p>{p.ecdysisDataset(c.datasetId)}</p>
          ))}
        </>
      )}
    </>
  );
}
