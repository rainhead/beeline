import type { Messages } from "../messages/index.js";
import { PROGRAM_PHOTOS } from "../program-photos.js";
import { programHref, type ProgramDetail, type ProgramLead, type ProgramSummary } from "../programs.js";
import { EMPTY_ROSTER_QUERY, rosterHref } from "../roster.js";
import { ATLAS_IDENTITY } from "../theme/atlas.js";
import {
  Absent,
  AtlasMark,
  Breadcrumbs,
  Button,
  DataTable,
  DetailList,
  EmptyState,
  Meta,
  PageHeader,
  PhotoCarousel,
  TextField,
} from "./components/index.js";

/**
 * The programs (beeline-rrit): a listing, and one page per program saying
 * what Beeline knows about it. Read by everyone signed in, so every word comes
 * from the catalog; the links into the listings and the roster are drawn only
 * for staff, who are the only ones those pages would show everybody's to.
 */

/** A records listing scoped to the program, as staff reach it. */
const scopedHref = (path: "/samples" | "/specimens", scope: string) => `${path}?${new URLSearchParams({ scope }).toString()}`;

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
  const season = programs[0]?.currentSeason.season ?? new Date().getFullYear();
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
            <td>{program.scope === null ? <Absent label={p.notMembership} /> : m.format.number(program.currentSeason.samples)}</td>
            <td>{program.scope === null ? <Absent label={p.notMembership} /> : m.format.number(program.specimens)}</td>
          </tr>
        ))}
      </DataTable>
    </>
  );
}

/**
 * How to reach the program: its leads, the address it gives people for
 * questions, and an atlas's own website (ATLAS_IDENTITY, beside its mark).
 * Staff set the address here; the admin flag is off while impersonating, so
 * a staffer viewing as a volunteer sees no form.
 */
function Contact({ m, program, admin }: { m: Messages; program: ProgramDetail; admin: boolean }) {
  const p = m.programs;
  const website = program.atlasCode === null ? undefined : ATLAS_IDENTITY[program.atlasCode]?.url;
  return (
    <>
      <h2>{p.contact}</h2>
      <DetailList
        items={[
          { term: p.leads, value: <Leads m={m} leads={program.leads} admin={admin} /> },
          {
            term: p.email,
            value:
              program.email === null ? (
                <Absent label={p.emailNone} spelled />
              ) : (
                <a href={`mailto:${program.email.value}`}>{program.email.value}</a>
              ),
          },
          // The host alone: Washington's page is a long path on a department's site.
          website === undefined ? null : { term: p.website, value: <a href={website}>{new URL(website).host.replace(/^www\./, "")}</a> },
        ]}
      />
      {admin && (
        <form method="post" action={`${programHref(program.code)}/contact`} class="form-column">
          <TextField
            id="program-email"
            name="email"
            label={p.emailField}
            value={program.email?.value ?? ""}
            hint={
              program.email === null
                ? p.emailHint
                : `${p.emailHint} ${p.emailSet(program.email.author, m.format.dateTime(program.email.recordedAt))}`
            }
          />
          <p class="row">
            <Button>{p.emailSave}</Button>
          </p>
        </form>
      )}
    </>
  );
}

function Labels({ m, program }: { m: Messages; program: ProgramDetail }) {
  const p = m.programs;
  if (program.printing === null) return null;
  return (
    <>
      <h2>{p.labels}</h2>
      <p>{program.printing === "own" ? p.printsOwn : p.printedByProgram}</p>
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

export function ProgramPage({ m, program, admin }: { m: Messages; program: ProgramDetail; admin: boolean }) {
  const p = m.programs;
  const season = program.currentSeason.season;
  return (
    <>
      <Breadcrumbs label={p.title} trail={[{ href: "/programs", label: p.title }]} />
      <PageHeader
        title={program.name}
        meta={p.meta(program.code, program.atlasCode !== null)}
        mark={program.atlasCode === null ? undefined : <AtlasMark code={program.atlasCode} name={program.name} href={null} />}
      />
      <PhotoCarousel m={m} photos={PROGRAM_PHOTOS[program.code] ?? []} />
      <h2>{p.summary}</h2>
      <DetailList
        items={[
          { term: p.members, value: <Members m={m} program={program} admin={admin} /> },
          ...(program.scope === null
            ? []
            : [
                { term: p.collectors(season), value: m.format.number(program.currentSeason.collectors) },
                { term: p.samples(season), value: m.format.number(program.currentSeason.samples) },
                { term: p.specimens(season), value: m.format.number(program.currentSeason.specimens) },
                { term: p.specimensEver, value: m.format.number(program.specimens) },
              ]),
        ]}
      />
      <Contact m={m} program={program} admin={admin} />
      <Labels m={m} program={program} />
      <Seasons m={m} program={program} admin={admin} />
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
