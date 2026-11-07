/**
 * The Spanish catalog — satisfying Messages.
 *
 * Designed for a Mexican and Central American audience, welcoming to
 * beginners while remaining faithful to the scientific vocabulary of
 * melittology and biological collections.
 */

import type { TaxonQualifier } from "../views/components/taxon.js";
import type { LocalityBasis } from "../../locality-rule.js";
import type { OutOfDateField } from "../../model.js";
import { OLD_BEELINE_ORIGIN } from "../old-beeline.js";
import type { CreditedSource, GlossaryEntry, Messages } from "./en.js";

const locale = "es-MX";
const n = (x: number) => x.toLocaleString(locale);

// Date formatters pass strings through untouched so proofing placeholders survive.
const date = (d: Date | string) =>
  typeof d === "string" ? d : d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });

const listFormat = new Intl.ListFormat(locale, { style: "long", type: "conjunction" });
const list = (xs: readonly string[] | string) => (Array.isArray(xs) ? listFormat.format(xs) : String(xs));

const ZONE = "America/Los_Angeles";
const dateTime = (d: Date | string) =>
  typeof d === "string"
    ? d
    : d.toLocaleString(locale, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: ZONE,
        timeZoneName: "short",
      });

const stampParts = new Intl.DateTimeFormat("es-MX", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZone: ZONE,
  timeZoneName: "short",
});

const stamp = (d: Date | string) => {
  if (typeof d === "string") return d;
  const p = Object.fromEntries(stampParts.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${p.timeZoneName}`;
};

/** El día natural en que cayó un INSTANTE, en hora del Pacífico — nunca para columnas DATE, que usan `date`. */
const day = (d: Date | string) =>
  typeof d === "string"
    ? d
    : d.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric", timeZone: ZONE });

const datePrecise = (d: Date | string, precision: "month" | "year" | null) => {
  if (typeof d === "string" || precision === null) return date(d);
  if (precision === "year") return String(d.getFullYear());
  return d.toLocaleDateString(locale, { year: "numeric", month: "short" });
};

const dateRange = (start: Date | string, end: Date | string) =>
  date(start) === date(end) ? date(start) : `${date(start)} – ${date(end)}`;

const place = (parts: ReadonlyArray<string | null> | string) =>
  (Array.isArray(parts) ? parts : [parts]).filter(Boolean).join(", ");

export const es: Messages = {
  locale,
  brand: "Beeline",

  absence: {
    none: "ninguno",
    notRecorded: "no registrado",
  },

  format: { date, datePrecise, day, dateTime, dateRange, number: n, list, place },

  combobox: {
    noMatches: "No hay coincidencias.",
    toggle: "Mostrar opciones",
  },

  suggestedLocality: {
    lead: "Sugerida a partir de las coordenadas:",
    use: "Usar esta localidad",
    inUse: "Esta es la localidad de la muestra.",
    alternativesLead: "O bien:",
    useShort: "Usar",
    useShortLabel: (locality: string) => `Usar ${locality}`,
    inUseShort: "en uso",
    reason: (basis: string) => `Sugerida a partir de las coordenadas: ${basis}.`,
    notYours: "Solo la persona que asignó esta localidad puede cambiarla. Contacta al personal para solicitar un cambio.",
    setByOther: "Otro usuario asignó la localidad de esta muestra. Contacta al personal para solicitar un cambio.",
    changed: "La localidad sugerida ha cambiado desde que se cargó la página. Revísala antes de confirmar.",
    printed: "Ya se han impreso las etiquetas para esta muestra, por lo que su localidad no puede modificarse.",
    basis: {
      used_own: "la localidad de otras muestras de este colector en este punto",
      used: "la localidad de otras muestras en este punto",
      campground: "un campamento cercano",
      refuge: "dentro de un refugio nacional de vida silvestre",
      wildlife_area: "dentro de una unidad de área de vida silvestre de WDFW",
      national_park: "dentro de un parque o monumento nacional",
      state_park: "dentro de un parque estatal o provincial",
      local_park: "dentro de un parque o reserva local",
      neighbourhood: "el vecindario",
      town_limits: "dentro de los límites del poblado",
      island: "en la isla",
      feature: "un paraje cercano nombrado por otros voluntarios",
      peak: "un pico o cerro cercano",
      town: "un pueblo cercano",
      hamlet: "un paraje cercano",
      large_reserve: "dentro de una gran reserva",
      distance: "distancia y dirección desde el poblado más cercano",
    } satisfies Record<LocalityBasis, string>,
  },

  layout: {
    credits: {
      source: { lead: "El código fuente de Beeline está en", label: "GitHub", href: "https://github.com/rainhead/beeline" },
      records: "Taxonomía y determinaciones",
      recordSources: [
        {
          name: "Ecdysis y las colecciones que publican a través de ella",
          href: "https://ecdysis.org/index.php",
          terms: "Directrices de uso de datos",
          termsHref: "https://ecdysis.org/includes/usagepolicy.php",
        },
      ],
      observations: "Observaciones",
      observationSources: [{ name: "iNaturalist y sus observadores", href: "https://www.inaturalist.org/" }],
      places: "Nombres y límites geográficos",
      elevations: "Elevaciones",
      placeSources: [
        { name: "GeoNames", href: "https://www.geonames.org/", terms: "CC BY 4.0", termsHref: "https://creativecommons.org/licenses/by/4.0/" },
        { name: "© Colaboradores de OpenStreetMap", href: "https://www.openstreetmap.org/copyright", terms: "ODbL", termsHref: "https://www.openstreetmap.org/copyright" },
        {
          name: "Provincia de Columbia Británica",
          href: "https://catalogue.data.gov.bc.ca/",
          terms: "Licencia de Gobierno Abierto – Columbia Británica",
          termsHref: "https://www2.gov.bc.ca/gov/content/data/policy-standards/open-data/open-government-licence-bc",
        },
        { name: "Oficina del Censo de los EE. UU.", href: "https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html" },
        { name: "Servicio de Pesca y Vida Silvestre de los EE. UU.", href: "https://www.fws.gov/program/national-wildlife-refuge-system" },
        { name: "Servicio de Parques Nacionales", href: "https://www.nps.gov/" },
        { name: "Departamento de Pesca y Vida Silvestre de Washington", href: "https://wdfw.wa.gov/places-to-go/wildlife-areas" },
        { name: "Parques Estatales de Washington", href: "https://parks.wa.gov/" },
        { name: "Wilderness Connect", href: "https://wilderness.net/" },
      ],
      elevationSources: [
        { name: "NASA SRTM", href: "https://www.earthdata.nasa.gov/data/instruments/srtm" },
        {
          name: "Copernicus DEM GLO-30",
          href: "https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM",
          terms:
            "© DLR e.V. 2010–2014 y © Airbus Defence and Space GmbH 2014–2018, facilitado bajo COPERNICUS por la Unión Europea y la ESA",
        },
      ],
    } satisfies {
      source: { lead: string; label: string; href: string };
      records: string;
      recordSources: CreditedSource[];
      observations: string;
      observationSources: CreditedSource[];
      places: string;
      elevations: string;
      placeSources: CreditedSource[];
      elevationSources: CreditedSource[];
    },
    envBanner: (environment: string) => `Instancia de ${environment} — los datos aquí pueden ser eliminados y regenerados en cualquier momento`,
    sandboxBanner: "Este es el entorno de pruebas (sandbox), no Beeline. Los cambios realizados aquí no se conservan. Beeline se encuentra en melittologist.org.",
    nav: {
      samples: "Muestras",
      specimens: "Ejemplares",
      glossary: "Glosario",
      howItWorks: "Cómo funciona Beeline",
      people: "Personas",
      design: "Diseño",
      jobs: "Tareas",
      taxonomy: "Taxonomía",
      programs: "Programas",
      printRuns: "Tiradas de impresión",
      exports: "Exportaciones",
      identify: "Identificar ejemplares",
      unclaimed: "Colectores desconocidos",
    },
    more: "Referencia y herramientas",
    records: "Registros",
    feedback: {
      label: "Enviar comentarios",
      subject: "Comentarios sobre Beeline",
      body: (context: { url: string; when: string; userAgent: string; login: string; session: string; reference?: string }) =>
        [
          "¿Qué ocurrió o qué te gustaría decirnos?",
          "",
          "",
          "",
          "-- Por favor deja las líneas de abajo: nos ayudan a saber qué estabas consultando. --",
          `Página: ${context.url}`,
          `Página cargada: ${context.when}`,
          `Sesión iniciada como: ${context.login}`,
          `Sesión: ${context.session}`,
          ...(context.reference === undefined ? [] : [`Referencia de error: ${context.reference}`]),
          `Navegador: ${context.userAgent}`,
        ].join("\n"),
    },
    menu: "Menú",
    account: (login: string) => `Cuenta: ${login}`,
    acting: {
      banner: (name: string) => `Estás actuando en nombre de ${name}. Las muestras mostradas como tuyas le pertenecen.`,
      stop: "Dejar de actuar en su nombre",
      start: "Actuar en nombre de alguien",
      startFor: (name: string) => `Actuar en nombre de ${name}`,
    },
    impersonating: {
      banner: (name: string) =>
        `Estás viendo Beeline como ${name}. Esto es lo que esa persona ve, y nada puede modificarse desde aquí.`,
      stop: "Dejar de ver como esa persona",
    },
    signOut: "Cerrar sesión",
    devSession: "Sesión iniciada mediante BEELINE_DEV_LOGIN — detén el servidor de desarrollo para cambiar de usuario.",
    pageTitle: (title: string) => `${title} · Beeline`,
  },

  signIn: {
    title: "Iniciar sesión",
    heading: "Beeline",
    nothingPublic: "Beeline ha sido renovado. Pruébalo iniciando sesión con iNaturalist.",
    button: "Iniciar sesión con iNaturalist",
    about: {
      lead: "Beeline custodia los registros de los ejemplares de abejas que colectan los voluntarios de",
      program: { label: "Master Melittologist", href: "https://extension.oregonstate.edu/master-melittologist" },
      tail: ".",
    },
    oldBeeline: {
      lead: "Si deseas seguir usando la interfaz anterior para ingresar tus determinaciones, estará disponible en",
      label: "old.melittologist.org",
      tail: " hasta finales de febrero de 2027.",
    },
    joinLead: "Para participar como voluntario, comienza con tu atlas:",
    failed: "Error al iniciar sesión (discrepancia de estado o falta de código). Intenta nuevamente desde la página de inicio de sesión.",
  },

  pendingApproval: {
    title: "Casi listo",
    heading: "Casi listo",
    body: (login: string) =>
      `Iniciaste sesión como ${login}, pero esa cuenta de iNaturalist aún no está conectada a un registro de miembro. ` +
      `El personal de tu atlas puede conectarla.`,
  },

  qc: {
    title: "Tus muestras",
    heading: "Beeline",
    lede:
      "Beeline da seguimiento a las abejas que colectas para tu atlas. Cada observación de iNaturalist se convierte en una muestra aquí, " +
      "los ejemplares reciben etiquetas y las determinaciones de expertos se registran en la muestra. " +
      "Esta página muestra tus muestras de esta temporada que necesitan atención o están esperando etiquetas, " +
      "así como las muestras de la temporada pasada hasta el 1 de marzo.",
    howItWorksLink: "Cómo funciona Beeline, paso a paso.",
    summary: (flagged: number, blocking: number, waiting: number, placeholders: number, unnumbered = 0) => {
      const parts: string[] = [];
      if (flagged > 0) {
        parts.push(
          `${n(flagged)} ${flagged === 1 ? "muestra necesita" : "muestras necesitan"} atención` +
            (blocking > 0 ? ` (${n(blocking)} no ${blocking === 1 ? "puede imprimirse" : "pueden imprimirse"} hasta corregirse)` : ""),
        );
      }
      if (waiting > 0) {
        parts.push(
          parts.length === 0
            ? `${n(waiting)} ${waiting === 1 ? "muestra está esperando etiquetas" : "muestras están esperando etiquetas"}`
            : `${n(waiting)} ${waiting === 1 ? "está esperando etiquetas" : "están esperando etiquetas"}`,
        );
      }
      if (placeholders > 0) {
        parts.push(
          `${n(placeholders)} ${placeholders === 1 ? "observación aún indica" : "observaciones aún indican"} 0 ejemplares`,
        );
      }
      if (unnumbered > 0) {
        parts.push(
          `${n(unnumbered)} ${unnumbered === 1 ? "observación no tiene" : "observaciones no tienen"} número de muestra`,
        );
      }
      return parts.join(" · ");
    },
    col: {
      sample: "Muestra",
      place: "Lugar",
      coordinates: "Coordenadas",
      host: "Planta hospedera",
      specimens: "Ejemplares",
    },
    allClear: "Ninguna de tus muestras recientes necesita atención y ninguna está esperando etiquetas. ¡Muchas gracias!",
    refreshNote:
      "Beeline consulta tus observaciones de iNaturalist cada mañana a las 2:00 a. m. hora del Pacífico. " +
      "Cualquier corrección que hagas en iNaturalist se reflejará aquí al día siguiente.",
    neverSynced: "Esta instancia aún no ha leído datos de iNaturalist.",
    check: {
      button: "Consultar iNaturalist ahora",
      why: "Si actualizaste observaciones en iNaturalist, Beeline puede buscar actualizaciones en este momento.",
      lastChecked: (when: Date) => `Última consulta: ${dateTime(when)}.`,
      done: (fetched: number, changed: number) =>
        `Beeline leyó ${n(fetched)} de tus ${fetched === 1 ? "observación reciente" : "observaciones recientes"} nuevamente. ` +
        (changed === 0
          ? "Ninguna había cambiado desde la última lectura."
          : `${n(changed)} ${changed === 1 ? "había cambiado" : "habían cambiado"}, y esta página las muestra tal como están ahora.`),
      tooSoon: (seconds: number) =>
        `Beeline consultó iNaturalist recientemente. Puede volver a consultar en ${n(seconds)} ${seconds === 1 ? "segundo" : "segundos"}.`,
      busy: "Beeline está leyendo las observaciones de todos los usuarios desde iNaturalist en este momento. Intenta de nuevo después de las 5:00 a. m. hora del Pacífico.",
      failed:
        "Beeline no pudo comunicarse con iNaturalist en este momento, por lo que no hubo cambios. " +
        "Intenta de nuevo en unos minutos o espera a la lectura de mañana por la mañana.",
      noAccount: "Beeline no puede consultar iNaturalist aquí porque no hay ninguna cuenta de iNaturalist vinculada a esta persona.",
      unavailable: "Esta instancia de Beeline no lee datos de iNaturalist.",
    },
    sampleTitle: (sampleNumber: string, when: Date | string) => `Muestra ${sampleNumber} · ${date(when)}`,
    unnumberedTitle: (when: Date | string) => `Sin número · ${date(when)}`,
    specimens: (count: number) => `${n(count)} ${count === 1 ? "ejemplar" : "ejemplares"}`,
    labelsWaiting: (count: number) => `${n(count)} ${count === 1 ? "etiqueta por imprimir" : "etiquetas por imprimir"}`,
    labelsPrinting: (count: number) => `${n(count)} ${count === 1 ? "etiqueta se está imprimiendo" : "etiquetas se están imprimiendo"}`,
    labelsPrinted: (count: number, when: string) =>
      `${n(count)} ${count === 1 ? "etiqueta impresa" : "etiquetas impresas"} ${when}, aún no enviadas`,
    coordinates: (latitude: string, longitude: string) => `${latitude}, ${longitude}`,
    accuracy: (metres: number) => `dentro de ${n(metres)} m`,
    coordinatesObscured: "ocultas",
    coordinatesNone: "ninguna",
    hostNone: "ninguno",
    hostUnnamed: (taxonId: number) => `taxón ${taxonId} de iNaturalist`,
    fixOnInat: "Corregir en iNaturalist",
    editSample: "Editar esta muestra",
    blocksPrinting: "bloquea la impresión",
    headsUp: "aviso",
    identifiedAs: "Actualmente está identificada como",
    placeholder: {
      chip: "aún en 0",
      note:
        "Esta observación aún indica 0 ejemplares, por lo que todavía no es una muestra y no tiene etiquetas por imprimir. " +
        "Una vez que hayas verificado el lugar, las coordenadas y el conteo, ingresa cuántos ejemplares colectaste.",
    },
    unnumbered: {
      chip: "sin número",
      note:
        "Esta observación está en el proyecto de iNaturalist de tu atlas pero sin número de muestra, por lo que todavía no es una muestra. " +
        "Si colectaste abejas en esta planta, ingresa el número de muestra en la observación.",
      notesSay: (notes: string) => `Tus notas dicen: “${notes}”.`,
    },
    skipped: {
      note:
        "En algunos días recientes falta un número de muestra. " +
        "Si colectaste una muestra con alguno de esos números, confirma que su observación esté en el proyecto de tu atlas en iNaturalist con su número de muestra correspondiente.",
      day: (when: Date | string, runs: readonly string[], count: number) =>
        `${date(when)}: sin ${count === 1 ? "muestra" : "muestras"} ${list(runs)}`,
      link: "tus observaciones de ese día",
    },
    collectedWith: (people: string) => `colectada con ${people}`,
    identify: {
      note: (specimens: number, season: number) =>
        `${n(specimens)} de tus ejemplares de ${season} ${specimens === 1 ? "está esperando identificación" : "están esperando identificación"}.`,
      link: "Identifícalos",
    },
    settled: {
      note: (samples: number) =>
        `${n(samples)} ${samples === 1 ? "muestra anterior tuya aún tiene un aviso" : "muestras anteriores tuyas aún tienen avisos"}. ` +
        `Cada temporada concluye el 1 de marzo del año siguiente; los avisos permanecen visibles y aún pueden corregirse.`,
      link: "Mostrarlas",
    },
  },

  listings: {
    samples: {
      title: "Muestras",
      heading: "Muestras",
      ledeMine: "Todas las muestras que has colectado.",
      ledeAtlas: (atlas: string) => `Todas las muestras en ${atlas}.`,
      ledeAll: "Todas las muestras en todos los atlas.",
      ledeOutside: "Todas las muestras colectadas fuera del territorio de los atlas miembros.",
      count: (total: number) => `${n(total)} ${total === 1 ? "muestra" : "muestras"}`,
      emptyHeading: "Aún no hay nada aquí",
      emptyMine: "Aún no ha llegado ninguna de tus colectas a Beeline. Las muestras se incorporan desde iNaturalist durante las sincronizaciones programadas.",
      emptyFiltered: "Ninguna muestra coincide con estos filtros. Amplía las fechas, borra el taxón o amplía la búsqueda.",
      colSample: "Muestra",
      colDate: "Fecha",
      colCollectors: "Colectores",
      colPlace: "Lugar",
      colHost: "Planta hospedera",
      colMethod: "Método",
      colSpecimens: "Ejemplares",
      colStatus: "Avisos",
      colAtlas: "Atlas",
      atlasOutside: "exterior",
      colLinks: "Enlaces",
      viewOnInat: "Ver en iNaturalist",
      edit: "Editar",
      placeEdit: {
        open: (sample: string) => `Cambiar el lugar de la muestra ${sample}`,
        label: "Lugar",
        noteInaturalist: "de iNaturalist",
        noteBasis: {
          used_own: "usado previamente por este colector",
          used: "usado previamente",
          campground: "campamento",
          refuge: "refugio de vida silvestre",
          wildlife_area: "área de vida silvestre",
          national_park: "parque nacional",
          state_park: "parque estatal",
          local_park: "parque",
          neighbourhood: "vecindario",
          town_limits: "poblado",
          island: "isla",
          feature: "nombrado en las cercanías",
          peak: "pico cercano",
          town: "pueblo cercano",
          hamlet: "paraje cercano",
          large_reserve: "reserva",
          distance: "desde el poblado más cercano",
        } satisfies Record<LocalityBasis, string>,
        noteCurrent: "actual",
        printed: "Las etiquetas de esta muestra ya están impresas. Cambiar la localidad aquí no modifica las etiquetas impresas.",
        save: "Guardar",
        cancel: "Cancelar",
        onlyOffered: "Elige uno de los nombres sugeridos. Para usar otro, modifica el lugar en iNaturalist.",
      },
    },

    specimens: {
      title: "Ejemplares",
      heading: "Ejemplares",
      ledeMine: "Todos los ejemplares de tus muestras.",
      identify: "Identifícalos.",
      ledeAtlas: (atlas: string) => `Todos los ejemplares en ${atlas}.`,
      ledeAll: "Todos los ejemplares en todos los atlas.",
      ledeOutside: "Todos los ejemplares colectados fuera del territorio de los atlas miembros.",
      count: (total: number) => `${n(total)} ${total === 1 ? "ejemplar" : "ejemplares"}`,
      emptyHeading: "Aún no hay nada aquí",
      emptyMine: "Aún no hay ejemplares registrados. Un ejemplar se convierte en su propio registro cuando se imprime su etiqueta.",
      emptyFiltered: "Ningún ejemplar coincide con estos filtros. Amplía las fechas, borra el taxón o amplía la búsqueda.",
      colFieldNumber: "Número de campo",
      colSample: "Muestra",
      colDate: "Fecha",
      colCollectors: "Colectores",
      colPlace: "Lugar",
      colHost: "Planta hospedera",
      colDetermination: "Determinación",
      colDeterminer: "Determinado por",
      colDetermined: "Determinación",
      colAtlas: "Atlas",
      noFieldNumber: "sin número",
      awaitingNumber: "esperando número",
      undetermined: "no determinado",
      expert: "experto",
      reprintRequested: "reimpresión solicitada",
      bulk: {
        start: "Marcar etiquetas para reimpresión…",
        modeHeading: "Marcando etiquetas para reimpresión.",
        modeIntro:
          "Marca los ejemplares cuyas etiquetas deban imprimirse de nuevo; si una fila no puede marcarse, se indica el motivo. Tus selecciones se mantendrán mientras navegas y filtras en esta pestaña.",
        leave: "Dejar de marcar",
        blocker: {
          unnumbered: "sin número de campo",
          asked: "ya en espera",
          printing: "en una tirada no impresa",
        } as Record<string, string>,
        tickPage: "Marcar todos los ejemplares de esta página",
        tickOne: (fieldNumber: string) => `Marcar ${fieldNumber}`,
        countNone: "Nada marcado aún",
        countOne: "1 ejemplar marcado",
        countOther: "{n} ejemplares marcados",
        hint: "Sus etiquetas se incluirán en la próxima tirada de impresión con los números de campo que ya tienen, después de las etiquetas nuevas de esa tirada. Indicar un motivo es opcional.",
        button: "Marcar para reimpresión",
        clear: "Desmarcar todo",
        done: (requested: number, of: number) =>
          requested === of
            ? `Se ${requested === 1 ? "marcó" : "marcaron"} ${n(requested)} ${requested === 1 ? "etiqueta" : "etiquetas"} para reimpresión.`
            : `Se ${requested === 1 ? "marcó" : "marcaron"} ${n(requested)} de ${n(of)} ${of === 1 ? "etiqueta" : "etiquetas"} para reimpresión. El resto ya estaba en espera, forma parte de una tirada no impresa o no tiene número de campo.`,
      },
    },

    scope: {
      label: "Mostrar",
      mine: "Mis registros",
      atlasRecords: (atlas: string) => `Registros de ${atlas}`,
      all: "Todos los registros",
      outside: "Fuera de los atlas",
      withheldNote:
        "Cuando una observación es oculta o privada en iNaturalist, solo sus colectores y el personal pueden ver el lugar exacto donde se colectó. Lo mismo ocurre cuando Beeline no ha leído la observación o no puede encontrarla en iNaturalist.",
    },
    locationHidden: "ubicación oculta",

    filters: {
      search: "Buscar",
      searchHint: "Número de muestra, colector o número de campo",
      from: "Colectado desde",
      to: "Colectado hasta",
      place: "Lugar",
      placeHint: "Localidad, condado, estado, país, área silvestre o ecorregión",
      collector: "Colector",
      collectorHint: "Nombre o usuario de iNaturalist — cualquiera en la muestra",
      member: "El colector pertenece a",
      memberHint: "A qué programa pertenece la persona — no dónde colectó",
      memberAny: "Cualquiera",
      memberProgram: "Master Melittology (sin atlas)",
      memberUnrecorded: "No registrado",
      taxon: "Taxón",
      taxonHint: "Una familia, género o especie — cualquier categoría inferior también coincide",
      host: "Planta hospedera",
      hostHint: "La planta en la que se colectó la abeja, tal como la nombra la observación",
      det: "Determinación",
      detAny: "Cualquiera",
      detDetermined: "Determinado",
      detUndetermined: "No determinado",
      labels: "Etiquetas",
      labelsAny: "Cualquiera",
      labelsWaiting: "En espera",
      labelsPrinted: "Todas impresas",
      labelsWaitingHint: "Algunos ejemplares aún no tienen etiquetas impresas, incluidas muestras retenidas por algún aviso",
      labelWaiting: "Aún no impresa",
      labelPrinted: "Impresa",
      labelsWaitingCount: (count: number) => `${n(count)} esperando etiquetas`,
      method: "Método",
      methodAny: "Cualquiera",
      methodNet: "Red",
      methodTrap: "Trampa",
      qc: "Avisos",
      qcAny: "Cualquiera",
      qcFlagged: "Cualquier aviso",
      qcBlocking: "Bloquea la impresión",
      qcWarning: "Solo avisos informativos",
      qcClean: "Sin problemas",
      qcLocality: "Localidad faltante o no utilizable",
      flagKind: "Tipo de aviso",
      flagKindAny: "Cualquiera",
      apply: "Aplicar",
      clear: "Borrar todo",
      inForce: "Filtros aplicados",
      remove: (filter: string) => `Quitar el filtro de ${filter}`,
    },

    sort: {
      textAsc: "A a la Z",
      textDesc: "Z a la A",
      dateAsc: "Más antiguos primero",
      dateDesc: "Más recientes primero",
      numberAsc: "Menor a mayor",
      numberDesc: "Mayor a menor",
    },

    columnMenu: {
      both: (column: string) => `${column}: ordenar y filtrar`,
      sort: (column: string) => `${column}: ordenar`,
      filter: (column: string) => `${column}: filtrar`,
    },

    status: {
      blocking: (count: number) => `${n(count)} ${count === 1 ? "aviso bloquea" : "avisos bloquean"} la impresión`,
      warning: (count: number) => `${n(count)} ${count === 1 ? "aviso informativo" : "avisos informativos"}`,
      clean: "sin problemas",
      flag: {
        missing_required_field: "campo faltante",
        missing_recommended_field: "sin condado",
        obscured_no_true_coordinates: "ubicación oculta",
        taxon_obscured_awaiting_atlas: "planta hospedera rara",
        locality_format: "localidad",
        place_unabbreviated: "abreviatura de lugar",
        place_unrecognised: "estado o provincia desconocido",
        coordinate_uncertainty: "precisión",
        coordinate_out_of_region: "fuera de la región",
        non_tracheophyte_host: "planta hospedera",
        duplicate_sample_number: "número duplicado",
        count_mismatch: "conteo de ejemplares",
        count_below_printed: "conteo inferior a etiquetas",
        within_sample_disagreement: "identificaciones discrepantes",
        observation_missing_upstream: "observación desaparecida",
        staff_hold: "retenida por el personal",
      },
      flagMissing: {
        location: "sin ubicación",
        country: "sin país",
        state_province: "sin estado",
        locality: "sin localidad",
        protocol: "sin método",
      } as Record<string, string>,
      flagSeverity: { blocking: "Bloquea la impresión", warning: "Aviso informativo" },
      flagMore: (count: number) => `+${n(count)} más`,
      flagSeeSample: "Ver la muestra",
    },

    paging: {
      page: (page: number, pages: number) => `Página ${n(page)} de ${n(pages)}`,
      previous: "← Anterior",
      next: "Siguiente →",
    },

    csv: {
      menu: "Descargar",
      download: "Descargar como CSV",
      note:
        "El archivo CSV contiene exactamente lo que seleccionan estos filtros, incluidas las coordenadas, en columnas de Darwin Core, " +
        "omitiendo cualquier ubicación oculta aquí. Si iNaturalist oculta un registro, sus propias columnas lo indican, lo cual conviene revisar antes de republicar los datos.",
    },
  },

  trapSample: {
    newTitle: "Ingresar muestra de trampa",
    newHeading: "Ingresar muestra de trampa",
    editTitle: "Editar muestra de trampa",
    editHeading: (sampleNumber: string) => `Editar muestra de trampa ${sampleNumber}`,
    intro:
      "Una muestra comprende lo colectado en una botella o conjunto agrupado de botellas, desde el día en que se colocaron las trampas hasta el día en que se recogieron. " +
      "Sus etiquetas se imprimen una vez que los ejemplares se montan y se cuentan.",
    notSaved: "No se guardó nada. Corrige los campos marcados a continuación y guarda de nuevo.",
    trapCollectorNote: "tiene muestras de trampa",
    fields: {
      sampleNumber: "Número de muestra",
      collector: "Colector",
      otherCollector: (n: number) => `Colector ${n} (opcional)`,
      dateStart: "Colocación de trampas",
      dateEnd: "Recolección de trampas",
      method: "Tipo de trampa",
      trapCount: "Número de trampas",
      specimenCount: "Ejemplares",
      latitude: "Latitud",
      longitude: "Longitud",
      uncertainty: "Incertidumbre de coordenadas (m)",
      country: "País",
      stateProvince: "Estado o provincia",
      county: "Condado",
      locality: "Localidad",
    },
    hints: {
      sampleNumber: "Se sugiere el siguiente número en la serie de Oregon. Modifícalo si utilizas otra serie o un código de trampa.",
      collector: "El nombre del primer colector aparece en primer lugar en la etiqueta.",
      dateStart: "El día en que se colocaron las trampas en campo.",
      dateEnd: "El día en que se recogieron. Déjalo vacío si fue el mismo día.",
      method: "Elige uno o escríbelo directamente.",
      trapCount: "Cuántas trampas componen esta muestra, si se conoce.",
      specimenCount: "Déjalo en 0 hasta que las abejas estén montadas y contadas: una muestra sin ejemplares no imprime etiquetas.",
      latitude: "En grados decimales, por ejemplo 44.5646.",
      longitude: "En grados decimales, negativo al oeste, por ejemplo -123.2620.",
      uncertainty: "Radio estimado de distancia de las trampas respecto a este punto.",
      stateProvince: "El código de dos letras: OR, WA, BC.",
      county: "Beeline determina el condado a partir de las coordenadas cada noche, por lo que puede dejarse en blanco.",
      locality: "Tal como debe aparecer impresa en la etiqueta.",
    },
    create: "Ingresar muestra",
    save: "Guardar cambios",
    cancel: "Cancelar",
    enterLink: "Ingresar muestra de trampa",
    edit: "Editar muestra de trampa",
    notAllowedHeading: "Las muestras de trampa son ingresadas por quienes las manejan",
    notAllowed: "Las muestras de trampa son ingresadas por el personal y por personas que han colectado muestras de trampa anteriormente.",
    notEditableHeading: "Esta muestra ya no puede modificarse aquí",
    notEditable: "Las etiquetas de esta muestra ya están impresas o a punto de imprimirse, por lo que ya no puede modificarse aquí. Solicita al personal que realice la corrección.",
  },

  sampleEdit: {
    title: "Editar muestra",
    heading: (sampleNumber: string) => `Editar muestra ${sampleNumber}`,
    intro:
      "Esta muestra no tiene una observación de iNaturalist asociada, por lo que las correcciones se realizan aquí. " +
      "Los cambios guardados surten efecto de inmediato y quedan registrados con tu nombre.",
    fields: {
      locality: "Localidad",
      country: "País",
      state_province: "Estado / provincia",
      county: "Condado",
      protocol: "Protocolo de muestreo",
    } as Record<string, string>,
    noteLabel: "Nota (opcional)",
    noteHint: "Motivo de este cambio (opcional)",
    save: "Guardar cambios",
    cancel: "Cancelar",
    notEditable: "Esta muestra no puede editarse aquí. Puede pertenecer a otro colector o requerir edición directa en iNaturalist.",
    notEditableHeading: "Esta muestra no puede editarse aquí",
    noStagingRows: "Esta muestra no tiene registros subyacentes que corregir. Comunícate con el personal para obtener asistencia.",
  },

  record: {
    history: {
      heading: "Historial",
      hint: "Cada cambio registrado para esta muestra, del más reciente al más antiguo: una edición realizada aquí, una actualización de iNaturalist o la importación desde el antiguo Beeline.",
      empty: "Sin cambios aún. Las modificaciones a esta muestra se listarán aquí.",
      colWhen: "Cuándo",
      colWhat: "Qué",
      colChange: "Cambio",
      colWho: "Quién",
      set: "establecido en",
      cleared: "borrado — era",
      blank: "nada",
      field: {
        kind: "Tipo",
        date_end: "Fecha final",
        specimen_count: "Conteo de ejemplares",
        observation: "Observación de iNaturalist",
        location: "Coordenadas",
        location_source: "Fuente de coordenadas",
        geoprivacy: "Geoprivacidad",
        taxon_geoprivacy: "Geoprivacidad del taxón",
        country: "País",
        state_province: "Estado/Provincia",
        county: "Condado",
        locality: "Localidad",
        protocol: "Método",
        sampling_effort: "Esfuerzo de muestreo",
        host: "Hospedero floral",
        atlas: "Atlas",
        atlas_assigned_by: "Atlas asignado por",
        co_collectors: "Co-colectores",
        hold: "Retenida de impresión",
        waivers: "Avisos eximidos",
        collector: "Colector",
        sample_number: "Número de muestra",
        date_start: "Fecha inicial",
      },
      source: {
        app: "personal",
        legacy_promotion: "la importación del antiguo Beeline",
        observation_promotion: "iNaturalist",
        reconcile: "detectado al inicio",
        coordinates: "sus coordenadas",
      },
    },
    notYours: "Otra persona colectó esta muestra.",

    sample: {
      title: (sampleNumber: string) => `Muestra ${sampleNumber}`,
      back: "← Todas las muestras",
      collectors: "Colectada por",
      collected: "Colectada",
      method: "Método",
      methodNet: "Red",
      methodTrap: "Trampa",
      effort: "Esfuerzo de muestreo",
      place: "Lugar",
      asRecorded: (text: string) => `Registrada en iNaturalist como “${text}”.`,
      inWilderness: (names: string) => `Dentro de ${names}. Colectar en un área silvestre federal requiere un permiso.`,
      inEcoregion: (name: string) => `Ecorregión ${name}`,
      program: "Programa",
      host: "Hospedero floral",
      observation: "Observación de iNaturalist",
      observationNone: "Ninguna. Esta muestra no está vinculada a una observación de iNaturalist, por lo que se corrige directamente aquí en Beeline.",
      observationGone: (since: Date | string) =>
        `No encontrada en iNaturalist desde el ${date(since)}: lo más probable es que haya sido eliminada.`,
      notes: "Notas",
      viewOnInat: "Ver en iNaturalist",
      edit: "Editar esta muestra",
      unknown: "no registrado",
      staffLocality: {
        setBy: (name: string) => `Localidad asignada en Beeline por ${name}.`,
        setByStaff: "Localidad asignada en Beeline por el personal.",
        because: (reason: string) => `Motivo: ${reason}`,
        observationNow: (text: string) =>
          `iNaturalist ahora indica “${text}” para esta observación. La localidad asignada en Beeline se mantendrá hasta que se seleccione la de iNaturalist.`,
      },
      staffCoordinates: {
        setBy: (name: string) => `Coordenadas asignadas en Beeline por ${name}.`,
        setByStaff: "Coordenadas asignadas en Beeline por el personal.",
        because: (reason: string) => `Motivo: ${reason}`,
        observationNow: (lat: number, lon: number) =>
          `iNaturalist ahora ubica esta observación en ${lat}, ${lon}. Las coordenadas asignadas en Beeline se mantendrán hasta que se decida seguir a iNaturalist nuevamente.`,
        open: "Modificar las coordenadas",
        hint: "Las coordenadas asignadas aquí se consideran la ubicación verdadera y reemplazan a las de la observación, incluso cuando iNaturalist se actualice. La elevación se recalcula por la noche.",
        printed: "Las etiquetas de esta muestra ya están impresas. Modificar las coordenadas aquí no cambia las etiquetas impresas.",
        noObservation: "Las coordenadas solo pueden asignarse aquí en muestras que tengan una observación de iNaturalist.",
        latitude: "Latitud",
        longitude: "Longitud",
        uncertainty: "Precisión, en metros (opcional)",
        save: "Guardar",
        remove: "Seguir a iNaturalist nuevamente",
      },

      where: {
        heading: "Dónde se colectó",
        withheld: (why: { geoprivacy: string | null; taxonGeoprivacy: string | null; gone: boolean }) =>
          why.gone
            ? "Beeline no puede encontrar la observación de esta muestra en iNaturalist, por lo que no puede determinar si el colector mantuvo su ubicación como privada allí. Solo sus colectores y el personal pueden ver dónde se colectó."
            : why.geoprivacy === null && why.taxonGeoprivacy === null
            ? "Beeline no ha leído la observación de esta muestra desde iNaturalist, por lo que no puede determinar si el colector mantiene su ubicación como privada allí. Hasta que pueda hacerlo, solo sus colectores y el personal pueden ver dónde se colectó."
            : why.geoprivacy !== null
            ? `El colector mantiene la ubicación de esta observación como ${why.geoprivacy === "private" ? "privada" : "oculta"} en iNaturalist, por lo que solo sus colectores y el personal pueden ver dónde se colectó.`
            : `iNaturalist ${why.taxonGeoprivacy === "private" ? "oculta" : "desplaza"} la ubicación de esta observación porque su planta hospedera es rara, por lo que solo sus colectores y el personal pueden ver dónde se colectó.`,
        coordinates: "Coordenadas",
        coordinatesNone:
          "Beeline no dispone de coordenadas para esta muestra. Beeline solo registra coordenadas verdaderas; si iNaturalist desplaza la ubicación por privacidad, no se utiliza la ubicación desplazada.",
        accuracy: "Precisión",
        accuracyValue: (metres: number) => `dentro de ${n(metres)} m`,
        source: "Fuente",
        sources: {
          inat_trusted:
            "De la observación de iNaturalist, leída con autorización del colector; estas son las coordenadas verdaderas, aun cuando el mapa público de iNaturalist las desplace.",
          inat_public: "De la observación de iNaturalist, que las muestra públicamente tal como son.",
          legacy_import:
            "Importada del antiguo Beeline, que no registraba el origen de las coordenadas. Estas son las coordenadas impresas en las etiquetas.",
          staff_entry: "Ingresada por el personal.",
        } as Record<string, string>,
        privacy: "Coordenadas públicas",
        privacyObscured:
          "El colector configuró esta observación como oculta en iNaturalist, por lo que su mapa público muestra una ubicación desplazada. Las coordenadas anteriores representan la ubicación verdadera.",
        privacyPrivate:
          "El colector configuró esta observación como privada en iNaturalist, por lo que su mapa público no muestra ninguna ubicación. Las coordenadas anteriores representan la ubicación verdadera.",
        privacyTaxonObscured:
          "iNaturalist desplaza automáticamente la ubicación pública de esta observación porque su planta hospedera es rara. Las coordenadas anteriores representan la ubicación verdadera.",
        privacyTaxonPrivate:
          "iNaturalist oculta automáticamente la ubicación pública de esta observación porque su planta hospedera es rara. Las coordenadas anteriores representan la ubicación verdadera.",
        elevation: "Elevación",
        elevationValue: (metres: number) => `${n(metres)} m`,
        elevationNone: "Aún no calculada. La elevación se calcula a partir de las coordenadas durante la noche.",
        elevationFrom: (source: string) => `Leída de ${source}.`,
        elevationStale: "Calculada para coordenadas anteriores. Se recalculará durante la noche.",
      },

      flags: {
        heading: "Avisos",
        clean: "No hay avisos en esta muestra.",
        onSpecimen: (fieldNumber: string) => `en el ejemplar ${fieldNumber}`,
        onOneSpecimen: "en uno de sus ejemplares",
      },

      qcDecisions: {
        waivedHeading: "Avisos eximidos",
        waivedBy: (name: string) => `Eximido por ${name}.`,
        waivedByStaff: "Eximido por el personal.",
        flagSaid: (text: string) => `Al momento de eximirse, el aviso indicaba “${text}”.`,
        because: (reason: string) => `Motivo: ${reason}`,
        noLongerApplies:
          "Esta exención ya no aplica porque los detalles del aviso han cambiado desde que se concedió. Si el aviso sigue vigente, aparece listado arriba.",
        waive: "Eximir este aviso",
        waiveHint:
          "Para el personal. El aviso deja de bloquear la impresión hasta que sus detalles cambien. Explica el motivo: el colector y quien imprima verán tu explicación.",
        reason: "Por qué",
        waiveSave: "Eximir",
        removeWaiver: "Quitar la exención",
        holdHeading: "Retener de la impresión",
        holdHint:
          "Para el personal. Una muestra retenida se excluye de nuevas tiradas de impresión hasta que un administrador levante la retención, incluso si el colector corrige el registro. Si ya está en una tirada preparada, la página de esa tirada lo indicará. El colector y quien imprima verán tu nota.",
        holdPrinted: "Sus etiquetas ya están impresas, por lo que la retención solo afecta si se agregan más ejemplares.",
        heldBy: (name: string) => `Retenida por ${name}.`,
        heldByStaff: "Retenida por el personal.",
        hold: "Retener",
        liftNote: "Nota (opcional)",
        lift: "Levantar la retención",
        noObservation: "Esta muestra no tiene observación de iNaturalist, por lo que no puede retenerse ni eximirse de avisos.",
      },

      specimens: {
        heading: "Ejemplares",
        count: (total: number) => `${n(total)} ${total === 1 ? "ejemplar" : "ejemplares"}`,
        none: "Aún no hay ejemplares. Un ejemplar se convierte en su propio registro cuando se imprime su etiqueta.",
        counted: (expected: number, printed: number) =>
          `El conteo de ejemplares de la muestra es ${n(expected)}, y ${n(printed)} de ellos ya ${printed === 1 ? "tiene etiqueta impresa" : "tienen etiquetas impresas"} hasta ahora.`,
        colFieldNumber: "Número de campo",
        colNumber: "#",
        colDetermination: "Determinación",
        colDeterminer: "Determinado por",
        noFieldNumber: "sin número",
        awaitingNumber: "esperando número",
        undetermined: "no determinado",
        expert: "experto",
        colLabel: "Etiqueta",
        label: {
          printing: (prepared: string) => `Imprimiendo — preparada el ${prepared}`,
          printed: (when: string) => `Impresa el ${when}`,
          mailed: (when: string) => `Enviada por correo el ${when}`,
          canceled: "tirada cancelada; se numerará de nuevo en la siguiente tirada",
          legacy: "impresa antes de Beeline",
          reprintRequested: "reimpresión solicitada",
        },
      },
    },

    specimen: {
      title: (fieldNumber: string) => `Ejemplar ${fieldNumber}`,
      titleUnnumbered: (specimenNumber: number, sampleNumber: string) =>
        `Ejemplar ${n(specimenNumber)} de la muestra ${sampleNumber}`,
      back: (sampleNumber: string) => `← Muestra ${sampleNumber}`,
      fieldNumber: "Número de campo",
      identifyPrompt: "Ningún voluntario ha identificado este ejemplar aún.",
      identifyLink: "Identifica tus ejemplares",
      fieldNumberNone: "Sin número — la etiqueta de este ejemplar es anterior a la numeración de campo.",
      fieldNumberWithdrawn: (number: string, run: string) =>
        `Sin número — ${number} se retiró al cancelarse la tirada ${run}; la próxima tirada volverá a numerar este ejemplar.`,
      inSample: "Número en su muestra",
      fromSample: "De la muestra",
      disposition: {
        heading: "El alfiler",
        state: "Dónde se encuentra",
        inCollection: "En la colección",
        missing: "Extraviado: no se encontró ningún ejemplar montado con esta etiqueta",
        remarks: "Observaciones",
        statedBy: (name: string, date: string) => `Registrado por ${name}, ${date}.`,
      },
      labels: {
        heading: "Etiquetas",
        intro:
          "Cada tirada de impresión que preparó una etiqueta para este ejemplar y el estado que alcanzó cada una. Si la etiqueta se imprimió más de una vez, la más reciente es la correcta.",
        legacy: "Impresa por el antiguo Beeline, por lo que no hay tirada de impresión que mostrar.",
        colRun: "Tirada de impresión",
        colNumber: "Número",
        colState: "Estado",
        colSheet: "Hoja · celda",
        colPrepared: "Preparada",
        colPrinted: "Impresa",
        colMailed: "Enviada",
        notYet: "aún no",
        reprint: "reimpresión",
        requestedBy: (name: string, reason: string | null, note: string | null) =>
          `Solicitada por ${name}${reason === null ? "" : `: ${reason.toLowerCase()}`}${note === null ? "" : ` — ${note}`}.`,
      },
      reprint: {
        heading: "Reimpresión",
        pending: (name: string, when: string) => `${name} solicitó el ${when} que esta etiqueta se imprima nuevamente. Se incluirá en la próxima tirada de impresión con el mismo número de campo.`,
        because: (reason: string) => `Motivo: ${reason}.`,
        noteSaid: (note: string) => `Nota: ${note}`,
        waiting: "Esperará mientras la muestra tenga un aviso que bloquee la impresión (mostrado abajo junto a la muestra).",
        hint: "Para el personal. La etiqueta se imprime en la próxima tirada, después de las etiquetas nuevas de esa tirada, con el número de campo que ya tiene y con los datos del registro vigentes en ese momento.",
        reason: "Motivo",
        noReason: "Ningún motivo indicado",
        note: "Nota (opcional)",
        button: "Reimprimir esta etiqueta",
        withdraw: "Retirar la reimpresión",
        cannotUnnumbered: "Este ejemplar no tiene número de campo, por lo que no hay etiqueta que reimprimir.",
        cannotPrinting: "Una tirada de impresión que aún no se ha impreso ya incluye una etiqueta para este ejemplar. Para modificarla, cancela dicha tirada.",
      },
    },

    determinations: {
      heading: "Determinaciones",
      intro:
        "Todas las identificaciones de este ejemplar, de la más reciente a la más antigua. Una nueva identificación nunca borra una anterior.",
      recordRule:
        "La identificación marcada como “actual” es la que utiliza Beeline, al igual que Ecdysis: la más reciente realizada por un experto, o la más reciente de todas si ningún experto ha identificado el ejemplar.",
      recordNotNewest:
        "La determinación de un experto se mantiene como actual hasta que otro experto la revise. Una identificación posterior hecha por un voluntario no la sustituye.",
      empty: "Nadie ha identificado este ejemplar todavía.",
      colDetermination: "Determinación",
      colDeterminer: "Determinado por",
      colDetermined: "Determinación",
      colRecorded: "Agregada a Beeline",
      colStatus: "",
      ofRecord: "actual",
      expert: "experto",
      determinerUnknown: "no registrado",
      determinedUnknown: "fecha no registrada",
      verbatim: (text: string) => `escrito como “${text}”`,
      sex: (value: string) => (value === "female" ? "hembra" : value === "male" ? "macho" : `sexo ${value}`),
      caste: (value: string) => `casta ${value}`,
      channels: {
        in_app: "ingresada aquí",
        ecdysis_import: "importada de Ecdysis",
        legacy_import: "importada del antiguo Beeline",
        worksheet_import: "importada de una planilla de determinación",
      } as Record<string, string>,
    },
  },

  determine: {
    title: "Identifica tus ejemplares",
    lede: "Ingresa identificaciones para tus ejemplares montados. Identifica cada ejemplar hasta donde tengas certeza, como género o familia.",
    aboutDetermination: "Más sobre determinaciones.",
    tonight:
      "Los cambios se guardan automáticamente. Las entradas realizadas hoy se pueden deshacer hasta la 1:00 a. m. hora del Pacífico. " +
      "Después de la 1:00 a. m., cualquier actualización se guarda como una nueva determinación y la entrada anterior se conserva en el historial del ejemplar.",
    experts:
      "Las identificaciones de expertos no se muestran aquí para fomentar la determinación independiente. Permanecen registradas en la página de cada ejemplar.",
    readOnly: "Estás viendo esto en nombre de otra persona, por lo que nada puede modificarse aquí.",
    season: "Temporada",
    seasonGo: "Mostrar",
    seasonOption: (season: number, unnamed: number) =>
      unnamed === 0 ? String(season) : `${season} · ${n(unnamed)} por identificar`,
    empty: "Aún no tienes ejemplares. Un ejemplar aparece aquí una vez que se ha impreso su etiqueta.",
    emptySeason: "No hay ejemplares de esta temporada.",
    mode: {
      label: "Trabajar",
      bySample: "Por temporada",
      batch: (count: number) => `Por número de campo (${n(count)})`,
    },
    jump: {
      label: "Ir al número de campo",
      placeholder: "26019685 o sus últimos dígitos",
      notHere: (typed: string, season: number) =>
        `${typed} no está entre tus ejemplares de ${season}. Prueba con otra temporada o agrégalo a tu lista en 'Por número de campo', que busca en todas las temporadas.`,
    },
    batch: {
      lede:
        "Reúne ejemplares de cualquier temporada mediante sus números de campo. " +
        "Se listan en el orden en que los agregues y tu lista se conserva hasta que la limpies.",
      hint:
        "Separa los números con comas. Un intervalo puede terminar solo con sus últimos dígitos: 26019685-697 significa 26019685 a 26019697. " +
        "Si solo uno de tus números termina en 412, escribir 412 es suficiente.",
      add: "Agregar números de campo",
      addButton: "Agregar",
      placeholder: "26019685-697, 26027608 — o escanea cada etiqueta",
      empty: "Tu lista está vacía. Agrega números de campo arriba o marca filas en 'Por temporada' y agrégalas desde allí.",
      added: (count: number) => `Se agregaron ${n(count)}.`,
      addedSome: (added: number, already: number) =>
        `Se agregaron ${n(added)}; ${n(already)} ya ${already === 1 ? "estaba" : "estaban"} en tu lista.`,
      alreadyOne: (fieldNumber: string) => `${fieldNumber} ya está en tu lista.`,
      alreadyAll: (count: number) => `Los ${n(count)} ya están en tu lista.`,
      dismiss: (text: string) => `Descartar ${text}`,
      emptyBatch: "Limpiar la lista",
      remove: (fieldNumber: string) => `Quitar ${fieldNumber} de la lista (su identificación se mantiene)`,
    },
    problem: {
      notNumber: "Eso no es un número de campo.",
      ambiguous: (typed: string, count: number, examples: readonly string[] | string) => {
        const some = Array.isArray(examples) ? examples : [String(examples)];
        return `${n(count)} de tus números de campo terminan en ${typed} (${some.join(", ")}${count > some.length ? "…" : ""}). Escribe más dígitos.`;
      },
      digits: (typed: string, spans: string) => `${typed} tiene ${typed.length} dígitos. ${spans}`,
      digitsShort: (typed: string, digits: number, example: string) =>
        `${typed} tiene ${typed.length} dígitos. ¿Falta alguno? Tus números más recientes tienen ${n(digits)}, como ${example}.`,
      notTheirs: (typed: string, spans: string) => `${typed} no es uno de tus números de campo. ${spans}`,
      rangeStart: (inner: string) => `Un intervalo debe comenzar en uno de tus números de campo. ${inner}`,
      backwards: "Ese intervalo va en orden inverso. Escribe primero el número menor.",
      tooLong: (max: number) => `Ese intervalo abarca más de ${n(max)} números. ¿Falta o sobra algún dígito?`,
      lengthsDiffer: (start: string, end: string) => `${start} y ${end} tienen distinta cantidad de dígitos. ¿Falta alguno?`,
      emptyRange: (spans: string) => `Ninguno de tus números de campo cae en ese intervalo. ${spans}`,
      digitMissing: (digits: number, example: string) =>
        `Ninguno de tus números de campo cae en ese intervalo. ¿Falta algún dígito? Tus números más recientes tienen ${n(digits)} dígitos, como ${example}.`,
      noSpecimens: "Aún no tienes ejemplares con número de campo.",
      spans: (spans: readonly { digits: number; first: string; last: string }[] | string) =>
        typeof spans === "string"
          ? spans
          : spans.length === 1
          ? `Los tuyos van de ${spans[0]!.first} a ${spans[0]!.last}.`
          : `Los tuyos van de ${list(spans.map((s) => `${s.first} a ${s.last} (${s.digits} dígitos)`))}.`,
    },
    bulk: {
      none: "Selecciona filas para identificar varios ejemplares a la vez. Mantén presionada la tecla Mayús (Shift) para seleccionar un bloque.",
      ticked: (count: number) => `${n(count)} seleccionados`,
      namePlaceholder: (count: number) => (count === 0 ? "Identificarlos…" : count === 1 ? "Identificarlo…" : `Identificar los ${n(count)}…`),
      named: (count: number, name: string) => `Se identificaron ${n(count)} como ${name}.`,
      sexSet: (count: number) => `Se definió el sexo o casta de ${n(count)}.`,
      undo: "Deshacer",
      untick: "Borrar selección",
      addToBatch: "Agregar a la lista",
      removeFromBatch: "Quitar de la lista",
      sexLabel: "Sexo o casta de los ejemplares seleccionados",
    },
    table: {
      tickAll: (count: number) => `Seleccionar los ${n(count)} mostrados`,
      tickSample: "Seleccionar todos los ejemplares de esta muestra",
      tick: (fieldNumber: string) => `Seleccionar ${fieldNumber}`,
      position: "#",
      fieldNumber: "Número de campo",
      sample: "Muestra",
      name: "Identificado como",
      sex: "Casta",
      saved: "Ingresado",
      sampleHeading: (sampleNumber: string, when: string) => `Muestra ${sampleNumber} · ${when}`,
      onHost: "en",
      viewOnInat: "Ver en iNaturalist",
      addName: "Agregar identificación",
      noNumber: "sin número de campo",
      showMore: (more: number, left: number) => `Mostrar ${n(more)} más (quedan ${n(left)})`,
    },
    saved: {
      today: "Hoy",
      todayHint: "Puedes deshacer esta entrada hasta la 1:00 a. m. hora del Pacífico.",
      undo: "Deshacer",
      undoHint: "Revertir a lo que indicaba antes de hoy",
      on: (when: string) => when,
      beforeBeeline: "Sistema anterior",
      nothing: "nada ingresado",
      saving: "Guardando…",
      failed: "No se guardó",
      retry: "Reintentar",
    },
    sex: {
      label: "Casta",
      female: "Hembra",
      male: "Macho",
      queen: "Gina",
      worker: "Obrera",
      drone: "Zángano",
      castesHint: "Abejorros y abejas melíferas: gina, obrera o zángano",
    },
    picker: {
      placeholder: "Escribe un nombre (como Bombus u Osmia)",
      noBees: "Ningún nombre de abeja coincide.",
      noNames: "Ningún nombre coincide.",
      bycatch: "Incluir avispas y otros insectos",
    },
    saveFailed: "No se pudo guardar. Comprueba tu conexión e intenta de nuevo.",
  },

  errorPage: {
    notFound: {
      title: "Página no encontrada",
      heading: "No hay nada aquí",
      body:
        "Esta página no existe o contiene registros que no tienes permiso para ver. " +
        "Si un enlace dentro de Beeline te trajo aquí, envía comentarios para que el personal pueda corregirlo.",
    },
    failed: {
      title: "Algo salió mal",
      heading: "Algo salió mal",
      body:
        "Beeline tuvo un problema y no pudo mostrar esta página. No fue culpa de nada que hayas hecho. " +
        "Intenta de nuevo en un minuto. Si el problema continúa, envía comentarios e incluye la referencia de abajo: nos ayuda a encontrar el problema.",
      reference: (reference: string) => `Referencia: ${reference}`,
    },
    maintenance: {
      title: "Fuera de servicio por mantenimiento",
      heading: "Beeline está fuera de servicio por mantenimiento",
      body: "El personal está trabajando en Beeline y estará disponible nuevamente en breve. Por favor, intenta de nuevo en unos minutos.",
    },
    back: "Regresar",
    home: "Ir a tu página principal",
    dev: {
      heading: "El error (mostrado solo en desarrollo)",
      staleStore: "Esto parece un almacén de datos atrasado respecto al esquema. Compruébalo con pnpm db:migrate --status.",
    },
  },

  errors: {
    crossOrigin: "solicitud de origen cruzado rechazada",
    forbidden: "no se te ha concedido ese permiso",
    readOnlyImpersonating: "nada puede modificarse mientras ves Beeline como otra persona",
    impersonationNotRecorded: "no se pudo registrar que estás viendo como otra persona, por lo que no se inició",
  },

  taxonomy: {
    title: "Taxonomía",
    intro:
      "Los nombres taxonómicos asignados a los ejemplares, organizados bajo la taxonomía del programa, y su estado en la base de datos de museos Ecdysis.",
    aboutEcdysis: "Más sobre Ecdysis.",
    fetched: (on: Date | string) => `Verificado con los nombres de Ecdysis al ${date(on)}.`,
    notLoaded: "Los nombres de Ecdysis no se han cargado aquí, por lo que nada en estas páginas indica el estado de un nombre allí.",
    csv: "Descargar CSV",
    summary: {
      accepted: (count: number) => `${n(count)} aceptados en Ecdysis`,
      synonym: (count: number) => `${n(count)} en desuso`,
      homonym: (count: number) => `${n(count)} ambiguos`,
      absent: (count: number) => `${n(count)} no presentes en Ecdysis`,
      decided: (count: number) => `${n(count)} decididos por un taxónomo`,
      moved: (count: number) => `${n(count)} por revisar de nuevo`,
    },
    search: "Nombre",
    searchHint: "Cualquier parte de un nombre científico.",
    standingLabel: "En Ecdysis",
    standingOptions: {
      any: "Cualquiera",
      accepted: "Aceptado",
      synonym: "En desuso",
      homonym: "Ambiguo",
      absent: "No presente en Ecdysis",
    },
    decidedLabel: "Decisión del taxónomo",
    decidedOptions: {
      any: "Cualquiera",
      decided: "Decidido",
      moved: "Por revisar de nuevo",
    },
    apply: "Aplicar",
    clear: "Limpiar",
    found: (total: number) => `${n(total)} ${total === 1 ? "nombre" : "nombres"}`,
    nothingFound: "Ningún nombre coincide. Prueba con menos letras o con otro estado taxonómico.",
    pageOf: (page: number, pages: number) => `Página ${n(page)} de ${n(pages)}`,
    previous: "← Anterior",
    next: "Siguiente →",
    browse: "Explorar",
    empty: "La taxonomía está vacía: aún no se ha determinado nada aquí.",
    filedUnder: "Clasificado bajo",
    colName: "Nombre",
    colRank: "Rango",
    colFiledUnder: "Clasificado bajo",
    colEcdysis: "Ecdysis",
    colSpecimens: "Ejemplares",
    chip: {
      synonym: "En desuso",
      homonym: "Ambiguo",
      absent: "No presente en Ecdysis",
      decided: {
        addition: "Mantenido fuera de Ecdysis",
        departure: "Mantenido frente a Ecdysis",
        homonym: "Elegido",
      },
    },
    nowCalled: "Ecdysis utiliza:",
    specimens: (count: number) => `${n(count)} ${count === 1 ? "ejemplar" : "ejemplares"}`,
    counted: "Contabilizado según la determinación actual.",
    determinedHere: (count: number, rank: string) =>
      `Contabilizado según la determinación actual, incluyendo todo lo clasificado por debajo. ${n(count)} ${count === 1 ? "está determinado" : "están determinados"} a este ${rank} y no más detalladamente.`,
    seeSpecimens: "Ver estos ejemplares",
    below: "Clasificado debajo",
    nothingBelow: "No hay nada clasificado debajo de este nombre.",
    standing: {
      accepted: "Un nombre aceptado en Ecdysis.",
      synonym: "Ecdysis clasifica este nombre como en desuso. El nombre aceptado en Ecdysis es:",
      homonym:
        "Ecdysis tiene más de un nombre aceptado con esta grafía, de diferentes autores, y nada de lo registrado aquí indica a cuál se refiere:",
      absent: (rank: string) =>
        `Ecdysis no tiene ningún ${rank} con esta grafía. Esto incluye nombres que aún no están en Ecdysis, tratamientos alternativos del programa y errores ortográficos.`,
      report: (tid: string) => `Taxón ${tid} de Ecdysis`,
    },
    decision: {
      addition: "El programa conserva este nombre, del cual Ecdysis no dispone.",
      departure: "El programa conserva este nombre bajo su propio tratamiento. Ecdysis lo clasifica bajo:",
      homonym: (author: string | null) =>
        author === null
          ? "De los nombres de Ecdysis escritos de esta forma, el programa ha definido a cuál se refiere."
          : `De los nombres de Ecdysis escritos de esta forma, el programa se refiere al de ${author}.`,
      by: (taxonomist: string, decidedOn: Date | string, fetchedOn: Date | string) =>
        `Decidido por ${taxonomist}, el ${date(decidedOn)}, frente a los nombres de Ecdysis al ${date(fetchedOn)}.`,
      reference: "Referencia:",
      moved: "Ecdysis ha cambiado desde entonces.",
    },
    notFound: "No existe tal nombre en la taxonomía.",
  },

  photos: {
    label: "Fotos",
    credit: (name: string) => `Foto: ${name}`,
    previous: "Foto anterior",
    next: "Foto siguiente",
  },

  programs: {
    title: "Programas",
    intro:
      "Los programas para los cuales Beeline custodia registros: cada atlas de abejas, que conserva los registros colectados en su territorio; Master Melittology, que conserva los colectados donde ningún atlas llega; y los muestreos de BLM.",
    colProgram: "Programa",
    colLeads: "Dirigido por",
    colMembers: "Miembros",
    colSamples: (season: number) => `Muestras en ${season}`,
    colSpecimens: "Ejemplares, todas las temporadas",
    noLeads: "sin directores registrados",
    notMembership: "no registrado",
    notFound: "No hay ningún programa con ese código.",
    meta: (code: string, atlas: boolean) => (atlas ? `${code} · un atlas de abejas` : code),
    summary: "De un vistazo",
    members: "Miembros",
    membersLink: (count: number) => `${n(count)} ${count === 1 ? "persona" : "personas"}`,
    collectors: (season: number) => `Colectores en ${season}`,
    samples: (season: number) => `Muestras en ${season}`,
    specimens: (season: number) => `Ejemplares en ${season}`,
    specimensEver: "Ejemplares, todas las temporadas",
    contact: "Contacto",
    leads: "Dirigido por",
    website: "Sitio web",
    email: "Correo electrónico",
    emailNone: "ninguno registrado aún",
    emailField: "Dirección de correo electrónico del programa",
    emailHint: "La dirección que el programa proporciona para consultas. Déjala vacía para eliminarla.",
    emailSet: (login: string, when: string) => `Establecida por ${login}, ${when}.`,
    emailSave: "Guardar dirección",
    labels: "Etiquetas",
    printsOwn: "Imprime sus propias etiquetas en tiradas preparadas exclusivamente para él.",
    printedByProgram:
      "No imprime sus propias etiquetas: se imprimen en las tiradas del programa, que Oregon prepara para cada atlas que no imprime las suyas.",
    seasons: "Registros por temporada",
    colSeason: "Temporada",
    colSeasonSamples: "Muestras",
    colSeasonSpecimens: "Ejemplares",
    colSeasonCollectors: "Colectores",
    season: (year: number) => `Temporada ${year}`,
    noRecords: "No hay registros aún.",
    noGround: (code: string) =>
      code === "BLM"
        ? "Ninguno por lugar de colecta: las muestras de estos muestreos se ingresarán mediante su propia toma de datos en campo y les corresponderán según el día en que se colectaron, no por el punto geográfico en que cayeron."
        : code === "NWR"
          ? "Ninguno por lugar de colecta: las muestras de refugios ingresan mediante los proyectos de iNaturalist de sus atlas e imprimen con ellos; corresponden al programa según el refugio en que se colectaron, dato que Beeline aún no registra."
          : "Ninguno por lugar de colecta: este programa no dispone de territorio propio y aún no se registra qué muestras le pertenecen.",
    seeSamples: "Ver sus muestras",
    seeSpecimens: "Ver sus ejemplares",
    ecdysis: "Determinaciones de expertos",
    ecdysisDataset: (datasetId: number) =>
      `Consultado cada noche a las 3:00 a. m. hora del Pacífico desde Ecdysis, la base de datos de museos, conjunto de datos ${datasetId}.`,
  },

  exports: {
    title: "Exportaciones",
    heading: "Exportaciones",
    intro:
      "Archivos para trabajar fuera de Beeline. El archivo de ocurrencias contiene las columnas del sistema anterior, en su orden y formato original, para que los informes y cargas basados en ese archivo sigan funcionando sin cambios. Se regenera cada noche a las 4:00 a. m. hora del Pacífico; ejecuta la tarea legacy-export en Tareas para generarlo ahora.",
    occurrences: "Ocurrencias, en el formato del sistema anterior",
    written: (when: string) => `Generado el ${when}`,
    size: (megabytes: string) => `${megabytes} MB`,
    download: "Descargar",
    missing: "Aún no generado. Aparecerá después de la próxima ejecución nocturna o tras ejecutar la tarea legacy-export en Tareas.",
    archives: "Archivos Darwin Core, por programa y año",
    archivesIntro:
      "Los ejemplares de cada programa colectados en un año calendario, en formato de archivo Darwin Core: las columnas del CSV de ejemplares separadas por tabulaciones y cada identificación que haya tenido cada ejemplar. Un año abarca de enero a diciembre, según el criterio de los taxónomos, y una muestra pertenece al año de su primer día. El archivo de un atlas contiene los ejemplares colectados en su territorio, y el de Master Melittology contiene aquellos que ningún atlas cubre. Cada año se genera cada noche a las 4:00 a. m. hora del Pacífico para su descarga y revisión. Antes de publicar un año, su programa debe definir bajo qué licencia se comparten sus registros y contar con una política de privacidad para ese año; las columnas Licencia y Política de privacidad indican el progreso de cada uno. Cada programa también dispone de una lista de verificación que abarca todos los años: los nombres con los que se han identificado sus ejemplares, sus rangos superiores, cuántos ejemplares tiene cada uno y en qué años, como una lista de verificación de Darwin Core.",
    archivesCaution:
      "Estos archivos son para la operación del programa y para verificar que las herramientas de GBIF y Symbiota puedan leer lo que genera Beeline. No los subas a Ecdysis, GBIF ni a ninguna otra plataforma hasta que cada programa haya establecido qué publica, bajo qué identificadores y qué registros permanecen bajo reserva. Contienen nombres de colectores y coordenadas verdaderas, incluidas las protegidas por taxón.",
    archivesMissing:
      "Aún no generado. Aparecerá después de la próxima ejecución nocturna o tras ejecutar la tarea dwc-archives en Tareas.",
    archiveNone: (code: string) =>
      code === "BLM"
        ? "Sin archivos: las muestras de estos muestreos se ingresarán mediante su propia toma de datos en campo y les corresponderán según el día en que se colectaron, no por el punto geográfico en que cayeron."
        : code === "NWR"
          ? "Sin archivos: las muestras de refugios están en los archivos de sus atlas y corresponden al programa según el refugio en que se colectaron, dato que Beeline aún no registra."
          : "Sin archivos: este programa no dispone de territorio propio y aún no se registra qué muestras le pertenecen.",
    noSpecimens: "Sin ejemplares aún.",
    colYear: "Año",
    colSpecimens: "Ejemplares",
    colLicense: "Licencia",
    colPolicy: "Política de privacidad",
    colArchive: "Archivo",
    noLicense: "sin licencia",
    noPolicy: "ninguna aún",
    policyNoPage: "Acordada, aún no publicada",
    policyLink: "Leerla",
    archiveLicenseNone: "Este archivo no especifica licencia; se reescribirá con esta licencia esta noche.",
    archiveLicenseWas: (license: string) => `Este archivo indicaba ${license}; se reescribirá con esta licencia esta noche.`,
    downloadSized: (size: string) => `Descargar (${size})`,
    archiveDownload: (program: string, year: number) => `Descargar el archivo de ${program} para ${year}`,
    checklist: (taxa: number) => `Lista de verificación: ${n(taxa)} ${taxa === 1 ? "nombre" : "nombres"}, todos los años agrupados.`,
    checklistDownload: (program: string) => `Descargar la lista de verificación de ${program}`,
  },

  jobs: {
    title: "Tareas",
    heading: "Tareas programadas",
    intro: "Todo lo que la aplicación ejecuta según un cronograma y el resultado de las ejecuciones recientes. Las tareas de la ventana nocturna pueden tardar; las interactivas responden al presupuesto de un segundo.",
    registered: "Registradas",
    recentRuns: "Ejecuciones recientes",
    descriptions: {
      "session-purge": "Cada noche, elimina las sesiones de inicio de sesión inactivas por más de 30 días, las cuales ya han dejado de funcionar.",
      "nightly-pipeline":
        "Obtiene todas las observaciones modificadas desde la última ejecución (ediciones y nuevos registros, sin importar la antigüedad de la observación), las convierte en muestras y completa las elevaciones faltantes a partir de los mosaicos DEM en disco.",
      "legacy-export":
        "Exporta cada ejemplar en el formato de archivo de ocurrencias del sistema anterior —con las mismas columnas, orden y formato— para que los informes y cargas existentes continúen funcionando. Descárgalo desde Exportaciones.",
      "dwc-archives":
        "Genera un archivo Darwin Core para cada atlas y para Master Melittology, uno por año calendario, para revisión del personal, y elimina aquellos cuyo año ya no tenga ejemplares. Descárgalos desde Exportaciones.",
      "ecdysis-fetch":
        "Recupera las determinaciones realizadas en Ecdysis, la base de datos de museos de Washington. Descarga la colección solo cuando Ecdysis indica cambios; de lo contrario, recarga la copia existente. Los nombres faltantes en Beeline se toman de la lista de nombres de Ecdysis donde estén aceptados, y el resto se lista en la ejecución.",
      "store-backup":
        "Copia el almacén completo, las decisiones del personal y los historiales de cambios en un único archivo en la carpeta Bee Line de la unidad compartida de OSU, exclusivamente para recuperación. Verifica que las copias abran y coincidan con el archivo en Drive, conservando copias diarias por dos semanas y la del primer día de cada mes por un año.",
      "commit-determinations":
        "Convierte las entradas del día en Identificar ejemplares en determinaciones definitivas. Hasta que se ejecute, los voluntarios pueden modificar lo ingresado; después, cualquier cambio se añade junto al anterior.",
      "resource-budget":
        "Lee el consumo de recursos de la máquina en las últimas 25 horas —procesador, memoria, swap y disco— desde las métricas de Fly, y alerta cuando se acerca a un límite para prevenir bloqueos o saturación de disco.",
      "weekly-sweep":
        "Vuelve a consultar el año móvil completo de cada proyecto como prueba de presencia —la ejecución que detecta eliminaciones y cualquier elemento que las consultas incrementales hayan omitido— para luego promover y derivar elevaciones.",
    } as Record<string, string>,
    everyMinutes: (minutes: number) => `cada ${n(minutes)} min`,
    dailyLA: (hour: number) => `diariamente a las ${n(hour)}:00 hora del Pacífico (ventana nocturna)`,
    weeklyLA: (weekday: string, hour: number) => `${weekday}s a las ${n(hour)}:00 hora del Pacífico (ventana nocturna)`,
    weekdays: ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"],
    windowInteractive: "interactiva",
    windowNight: "nocturna",
    runNow: "Ejecutar ahora",
    colJob: "Tarea",
    colSchedule: "Horario",
    colWindow: "Ventana",
    colStarted: "Iniciada",
    colDuration: "Duración",
    colOutcome: "Resultado",
    colBreaches: "Incumplimientos de SLA",
    colDetail: "Detalle",
    outcomeSucceeded: "exitosa",
    outcomeFailed: "fallida",
    outcomeRunning: "ejecutándose…",
    durationSeconds: (s: number) => `${n(s)}s`,
    stillRunning: "aún en ejecución",
    noRuns: "Aún no hay ejecuciones.",
  },

  printRuns: {
    title: "Tiradas de impresión",
    heading: "Tiradas de impresión",
    intro:
      "Una tirada congela las muestras listas para imprimir, asigna a cada ejemplar su número de campo y genera las hojas. Nada agregado o modificado después del congelamiento se incluye en ella; eso espera a la siguiente tirada.",
    state: {
      prepared: "Preparada",
      approved: "Aprobada",
      printed: "Impresa",
      mailed: "Enviada por correo",
      canceled: "Cancelada",
    } as Record<string, string>,
    reprintReason: {
      never_received: "Nunca recibida",
      damaged: "Dañada o perdida",
      data_corrected: "Registro corregido",
    } as Record<string, string>,
    prepare: {
      heading: "Preparar una tirada",
      scopeLabel: "Etiquetas de quién",
      program: "Todos para quienes imprime Oregon",
      programCovers: (codes: readonly string[]) =>
        codes.length === 0
          ? "Cubre las muestras fuera de todo atlas; cada atlas imprime las suyas."
          : `Cubre ${list(codes)} y las muestras fuera de todo atlas.`,
      waiting: (labels: number, samples: number, reprints = 0) =>
        `${
          labels === 0
            ? "sin etiquetas nuevas"
            : `${n(labels)} ${labels === 1 ? "etiqueta" : "etiquetas"} para ${n(samples)} ${samples === 1 ? "muestra" : "muestras"}`
        }${reprints === 0 ? "" : ` y ${n(reprints)} ${reprints === 1 ? "reimpresión" : "reimpresiones"}`} en espera`,
      nothingWaiting: "nada en espera",
      button: "Preparar",
      hint:
        "Preparar congela el conjunto y asigna números de campo en el orden en que aparecerán las etiquetas en las hojas. Si hubo un error, cancela la tirada antes de imprimir: los números quedan utilizados y las muestras vuelven al estado de espera.",
      nothingToPrepare: "No había nada en espera de impresión en ese alcance, por lo que no se preparó ninguna tirada.",
    },
    colRun: "Tirada",
    colScope: "Alcance",
    colState: "Estado",
    colPrepared: "Preparada",
    colLabels: "Etiquetas",
    colSamples: "Muestras",
    colCollectors: "Colectores",
    colSheets: "Hojas",
    colPrinted: "Impresa",
    colMailed: "Enviada",
    none: "Aún no hay tiradas de impresión.",
    refused: (
      refusal:
        | { code: "no_location"; sampleId: number }
        | { code: "no_primary_collector"; sampleId: number }
        | { code: "determined"; printRunId: number; specimens: number }
        | { code: "atlas_not_printing"; atlasId: number }
        | { code: "reprint_refused"; specimens: number; unnumbered: number; asked: number; printing: number },
    ) =>
      refusal.code === "reprint_refused"
        ? refusal.specimens === 0
          ? "No hay ningún ejemplar allí para reimprimir. No se realizó ningún cambio."
          : refusal.specimens === 1
          ? refusal.asked > 0
            ? "Ya se solicitó la reimpresión de esta etiqueta. No se realizó ningún cambio."
            : refusal.printing > 0
              ? "Una tirada de impresión que aún no se ha impreso ya contiene esta etiqueta. No se realizó ningún cambio."
              : "Este ejemplar no tiene número de campo, por lo que no hay etiqueta que reimprimir. No se realizó ningún cambio."
          : `No se solicitó ninguna etiqueta: de ${n(refusal.specimens)} ejemplares, ${n(refusal.asked)} ya ${refusal.asked === 1 ? "está" : "están"} en espera, ${n(refusal.printing)} ${refusal.printing === 1 ? "está" : "están"} en una tirada no impresa y ${n(refusal.unnumbered)} no ${refusal.unnumbered === 1 ? "tiene" : "tienen"} número de campo.`
        : refusal.code === "atlas_not_printing"
        ? "No se preparó ninguna tirada: ese atlas no imprime sus propias etiquetas, por lo que sus muestras van en la tirada común de Oregon."
        : refusal.code === "determined"
        ? `Esta tirada no puede cancelarse: ${n(refusal.specimens)} de sus ejemplares ya ${refusal.specimens === 1 ? "ha sido identificado" : "han sido identificados"}, y cancelarla retiraría sus números de campo. No se realizó ningún cambio.`
        : refusal.code === "no_location"
          ? `No se preparó ninguna tirada: la muestra ${refusal.sampleId} está esperando impresión pero no tiene coordenadas registradas, lo cual no debería ocurrir. Revisa /samples/${refusal.sampleId} antes de intentar de nuevo.`
          : `No se preparó ninguna tirada: la muestra ${refusal.sampleId} está esperando impresión pero no tiene exactamente un colector principal. Revisa /samples/${refusal.sampleId} antes de intentar de nuevo.`,
    scopeProgram: "programa",
    notYet: "aún no",
    run: {
      title: (preparedAt: Date | string, atlasCode: string | null) =>
        `Tirada de impresión ${stamp(preparedAt)} · ${atlasCode ?? "programa"}`,
      back: "← Tiradas de impresión",
      preparedBy: (name: string, when: string) => `Preparada por ${name}, ${when}.`,
      scopeProgram: "Todos para quienes imprime Oregon.",
      scopeAtlas: (name: string) => `Solo ${name}.`,
      counts: (labels: number, samples: number, collectors: number, sheets: number, reprints = 0) =>
        `${n(labels)} ${labels === 1 ? "etiqueta" : "etiquetas"} para ${n(samples)} ${samples === 1 ? "muestra" : "muestras"} de ${n(collectors)} ${collectors === 1 ? "colector" : "colectores"}, en ${n(sheets)} ${sheets === 1 ? "hoja" : "hojas"}.` +
        (reprints === 0
          ? ""
          : ` ${n(reprints)} de las etiquetas ${reprints === 1 ? "es una reimpresión" : "son reimpresiones"}, después de las nuevas.`),
      reprint: "reimpresión",
      download: "Descargar las hojas (PDF)",
      approve: "Aprobar",
      approveHint: "Las etiquetas han sido revisadas y están listas para imprimir.",
      markPrinted: "Marcar como impresa",
      markPrintedHint:
        "Las hojas ya están impresas en papel. A partir de aquí las muestras en esta tirada conservan su fecha, lugar y coordenadas aunque la observación cambie en iNaturalist.",
      markMailed: "Marcar como enviada",
      markMailedHint: "Los sobres han sido despachados.",
      cancel: "Cancelar tirada",
      cancelHint:
        "Solo antes de imprimir. Sus números de campo quedan utilizados y nunca se reasignan; sus muestras regresan a espera y se numerarán de nuevo en la siguiente tirada.",
      note: "Nota",
      noteHint: "Conservada con la tirada: qué tuvo de particular o por qué se canceló.",
      done: "Esta tirada está concluida.",
      canceledAt: (when: string, note: string | null) =>
        note === null ? `Cancelada el ${when}.` : `Cancelada el ${when}: ${note}`,
      warnings: (count: number) => `${n(count)} ${count === 1 ? "etiqueta por revisar" : "etiquetas por revisar"}`,
      warningsIntro:
        "Estas líneas eran más largas de lo previsto para la etiqueta y se redujeron para ajustarse, faltaba un condado o una reimpresión difiere de la última etiqueta del ejemplar porque el registro cambió desde entonces. La tirada se imprime de todos modos.",
      warningsNone: "Todas las etiquetas encajan correctamente.",
      splitSamples: (count: number) =>
        `${n(count)} ${count === 1 ? "muestra" : "muestras"} en esta tirada también ${count === 1 ? "tiene" : "tienen"} etiquetas en otra tirada abierta, por lo que sus etiquetas llegarán en dos sobres.`,
      held: (count: number) =>
        `El personal ha retenido de la impresión ${count === 1 ? "una muestra" : `${n(count)} muestras`} en esta tirada desde que fue preparada. ` +
        `La tirada aún ${count === 1 ? "la incluye" : "las incluye"}. Para ${count === 1 ? "excluirla" : "excluirlas"}, cancela la tirada y prepárala de nuevo.`,
      heldSample: (collector: string, sampleNumber: string) => `Muestra ${sampleNumber} de ${collector}`,
      outOfDate: (count: number) =>
        `${count === 1 ? "Una muestra" : `${n(count)} muestras`} en esta tirada ${count === 1 ? "ha cambiado" : "han cambiado"} desde que fue preparada, ` +
        `pero ${count === 1 ? "sus etiquetas aún muestran" : "sus etiquetas aún muestran"} los valores anteriores. ` +
        `Para imprimir los nuevos valores, cancela la tirada y prepárala de nuevo, o imprímela y solicita la reimpresión de ${count === 1 ? "esa etiqueta" : "las etiquetas de estas muestras"}.`,
      outOfDateSample: (collector: string, sampleNumber: string, labels: number) =>
        `Muestra ${sampleNumber} de ${collector} (${n(labels)} ${labels === 1 ? "etiqueta" : "etiquetas"})`,
      outOfDateField: {
        locality: "localidad",
        county: "condado",
        state_province: "estado o provincia",
        country: "país",
        coordinates: "coordenadas",
        elevation: "elevación",
        dates: "fechas",
      } satisfies Record<OutOfDateField, string>,
      outOfDateChange: (field: string, onLabel: string | null, now: string | null) =>
        `${field}: en la etiqueta figura ${onLabel ?? "ninguno"}, ahora es ${now ?? "ninguno"}`,
      labels: "Etiquetas",
      colSheet: "Hoja",
      colCell: "Celda",
      colLocation: "Ubicación",
      colCoordinates: "Coordenadas",
      colDate: "Fecha · muestra.ejemplar",
      colCollector: "Colector",
      colMethod: "Método",
      colNumber: "Número de campo",
      colWarnings: "Revisar",
      colSample: "Muestra",
      noLabels: "Esta tirada no contiene etiquetas.",
      wrongState: (state: string) => `La tirada está ${state.toLowerCase()}, por lo que esa acción no puede realizarse ahora.`,
      notFound: "No existe tal tirada de impresión.",
      canceledNoSheets: "Esta tirada fue cancelada, por lo que no tiene hojas que imprimir. Sus muestras están esperando la próxima tirada.",
    },
  },

  people: {
    delegation: "Actuación en nombre de otros",
    delegationHint:
      "En nombre de quién puede actuar esta persona. Cuando un hogar comparte un único usuario de iNaturalist, el cónyuge o familiar que no lo posee no puede iniciar sesión; este permiso le permite acceder a sus muestras sin transferir créditos.",
    actsFor: "Puede actuar en nombre de",
    actsForHint:
      "Una referencia por persona, separada por punto y coma: name:Robert Pederson;inat:429964. Esto reemplaza la lista completa — déjalo vacío para revocar todos los permisos.",
    saveDelegation: "Guardar",
    actsForNobody: "No actúa en nombre de nadie",
    viewAs: "Ver Beeline como este usuario",
    viewAsHint:
      "Observa exactamente lo que ve esta persona al iniciar sesión —sus muestras con avisos, listados y páginas de registros— para asistirla por teléfono o verificar lo que se le muestra. Solo lectura; las páginas de personal quedan ocultas hasta detener la visualización.",
    viewAsButton: (name: string) => `Ver como ${name}`,
    viewAsNameShared:
      "dos personas comparten este nombre y la vista no puede distinguirlas; primero asigna un nombre distintivo a una de ellas",
    title: "Personas",
    heading: "Personas",
    intro:
      "Todos los integrantes en el almacén de datos y la cuenta de iNaturalist con la que inicia sesión cada uno. Alguien sin cuenta vinculada no puede iniciar sesión hasta que el personal la conecte.",
    search: "Buscar",
    searchHint: "Nombre o usuario de iNaturalist",
    onlySuspect: "Solo cuentas dudosas",
    apply: "Aplicar",
    clear: "Borrar todo",
    inForce: "Filtros aplicados",
    remove: (filter: string) => `Quitar el filtro de ${filter}`,
    activity: "Activo",
    activityHint: "Una muestra colectada o una visita aquí en los últimos 12 meses",
    activityAny: "Cualquiera",
    activityActive: "Activo en los últimos 12 meses",
    activityInactive: "Inactivo en los últimos 12 meses",
    memberAny: "Cualquiera",
    memberUnrecorded: "No registrado",
    onlyAdmins: "Solo administradores",
    csv: "Descargar CSV",
    colPerson: "Persona",
    colAccount: "Cuenta de iNaturalist",
    colSamples: "Muestras",
    colLastSample: "Última muestra",
    colLastSeen: "Visto por última vez",
    lastSeenSignInOnly: "solo inicio de sesión",
    never: "nunca",
    colMembership: "Pertenece a",
    colAdmin: "Administrador",
    noPeople: "Nadie coincide con la búsqueda.",
    noAccount: "Sin cuenta",
    accountHeldBy: (login: string, holder: string) => `Sus registros usan ${login}, que pertenece a ${holder}.`,
    accountRecordsPointAt: (records: number, login: string) =>
      `${n(records)} de sus registros usan ${login}, que nadie aquí posee.`,
    found: (total: number) => `${n(total)} ${total === 1 ? "persona" : "personas"}`,
    pageOf: (page: number, pages: number) => `Página ${n(page)} de ${n(pages)}`,
    previous: "← Anterior",
    next: "Siguiente →",
    accountLooksWrong: "probablemente una cuenta incorrecta",
    accountNotInRecords: "no figura en sus registros",
    lookWrong: (people: number) =>
      `${n(people)} ${people === 1 ? "persona tiene una cuenta que no coincide con" : "personas tienen cuentas que no coinciden con"} ` +
      `los registros correspondientes.`,
    showThem: "Mostrarlas",
    accountWhy: {
      supported: (records: number) => `${n(records)} de sus registros ${records === 1 ? "utiliza" : "utilizan"} esta cuenta.`,
      outweighed: (bound: number, top: string, top_records: number) =>
        `Solo ${n(bound)} de sus registros ${bound === 1 ? "utiliza" : "utilizan"} esta cuenta. ` +
        `${n(top_records)} ${top_records === 1 ? "utiliza" : "utilizan"} ${top} en su lugar.`,
      unattested: "Ningún registro suyo utiliza esta cuenta. Aún podría ser correcta; nada aquí afirma lo contrario.",
      unbound: "Sin cuenta de iNaturalist, por lo que no puede iniciar sesión.",
      unboundHeldBy: (records: number, login: string, holder: string) =>
        `Sin cuenta de iNaturalist, por lo que no puede iniciar sesión. ${n(records)} de sus registros usan ${login}, ` +
        `que pertenece a ${holder} — una cuenta compartida que solo una persona puede tener.`,
    },
    records: (n_: number) => `${n(n_)} ${n_ === 1 ? "registro" : "registros"}`,

    backToRoster: "← Todas las personas",
    identity: "Nombre",
    account: "Cuenta de iNaturalist",
    accountHint:
      "El ID de usuario es lo que realmente establece la conexión; el usuario se muestra al lado porque los nombres de usuario cambian pero los identificadores no. Comprueba la cuenta en iNaturalist antes de guardarla.",
    loginsSeen: "Cuentas en sus registros anteriores",
    loginsSeenHint: "Cada cuenta que aparece en sus registros, ordenada por frecuencia de uso. Solo una puede ser la suya.",
    colRecords: "Registros",
    boundMark: "en uso",
    useThis: "Vincular esta",
    membership: "Membresía",
    belongsTo: "Pertenece a",
    belongsToHint:
      "A qué programa pertenece esta persona — no dónde colectó sus muestras. Master Melittology es una opción válida: los voluntarios fuera de todo atlas trabajan bajo los auspicios del personal de OBA.",
    saveMembership: "Guardar membresía",
    membershipUnrecorded: "No registrado",
    membershipProgram: "Master Melittology (sin atlas)",
    membershipProgramShort: "Programa",
    leadership: "Dirección de programas",
    leadershipHint:
      "Los programas que esta persona coordina o dirige. Una persona puede coordinar varios programas. Coordinar un programa no otorga permisos de administrador — esos se configuran abajo.",
    leadsNothing: "No dirige ningún programa",
    removeLead: (program: string) => `Dejar de dirigir ${program}`,
    addLead: "Agregar programa que dirige",
    chooseProgram: "Elegir un programa",
    saveLead: "Agregar",
    colLeads: "Dirige",
    leadAny: "Cualquiera",
    leadSome: "Cualquier programa",
    notALead: "no dirige ningún programa",
    orcid: "ORCID",
    orcidHint:
      "Un identificador ORCID acredita a esta persona en los registros que publica Beeline, tanto como colector como en las determinaciones. Se utiliza el identificador conectado a su cuenta de iNaturalist; uno ingresado aquí solo se usa si su cuenta no tiene ninguno.",
    orcidFromInat: "Desde su cuenta de iNaturalist",
    orcidFromStaff: "Registrado por el personal",
    orcidNone: "Sin identificador ORCID",
    orcidConnect: "Para recibir crédito con su nombre cuando sus registros sean publicados, puede vincular su identificador ORCID en iNaturalist: en ",
    orcidConnectLink: "la configuración de iNaturalist",
    orcidConnectAfter:
      ", en Aplicaciones, elige Cuentas conectadas y conecta ORCID. Beeline lo reconocerá la próxima vez que inicie sesión — si ya tiene la sesión abierta, basta con cerrarla y volver a iniciarla.",
    orcidOverridden: (staff: string) =>
      `El personal también registró ${staff}. Se utilizará el identificador de su cuenta de iNaturalist.`,
    orcidShared: (names: string) => `El mismo identificador acredita también a ${names}. Un identificador pertenece a una sola persona — verifica a quién corresponde.`,
    orcidField: "Identificador ORCID registrado por el personal",
    orcidFieldHint:
      "Solo un identificador que la persona te haya proporcionado o que hayas confirmado que le pertenece. Tanto la dirección completa (https://orcid.org/…) como los dieciséis dígitos solos son válidos.",
    orcidInvalid: (value: string) =>
      `'${value}' no es un identificador ORCID válido — debe tener dieciséis dígitos en cuatro grupos, como 0000-0002-1825-0097, y el último es un dígito de control`,
    orcidTaken: (orcid: string, name: string) => `${orcid} ya está registrado para ${name}`,
    accountTaken: (uid: number, name: string) => `La cuenta de iNaturalist ${uid} ya está vinculada a ${name}`,
    saveOrcid: "Guardar ORCID",
    removeOrcid: "Eliminar",
    adminRights: "Permisos de administración",
    adminHint: "Los administradores tienen acceso a Tareas, Personas, Diseño y a los listados de todos los atlas.",
    grantAdmin: "Conceder administración",
    revokeAdmin: "Revocar administración",
    isAdmin: "Tiene permisos de administrador",
    notAdmin: "Sin permisos de administrador",
    displayName: "Nombre público",
    givenName: "Nombre de pila",
    familyName: "Apellidos",
    labelName: "Nombre para etiquetas (anulación)",
    labelNameHint: "Déjalo en blanco para usar la forma derivada automáticamente. Úsalo solo cuando la derivación sea errónea.",
    saveNames: "Guardar nombres",
    unbind: "Desvincular cuenta",
    inatUserId: "ID de usuario de iNaturalist",
    inatLogin: "Usuario",
    bindAccount: "Guardar cuenta",
    reason: "Motivo",
    reasonHint: "Se registra en el historial junto al cambio y será visible para quien lo revise más adelante.",
    samplesCollected: (all: number, primary: number) =>
      `${n(all)} colectadas, ${n(primary)} como colector principal`,
    saved: "Guardado.",
    savedRebuild: "Guardado.",

    history: {
      heading: "Historial",
      hint:
        "Cada cambio registrado para esta persona, del más reciente al más antiguo —desde esta pantalla, desde la importación del antiguo Beeline o por sincronización de iNaturalist.",
      empty: "Nada registrado aún. Los cambios a partir de ahora aparecerán en esta lista.",
      colWhen: "Cuándo",
      colWhat: "Qué",
      colChange: "Cambio",
      colWho: "Quién",
      colPerson: "Persona",
      set: "establecido en",
      cleared: "borrado — era",
      field: {
        display_name: "Nombre público",
        given_name: "Nombre de pila",
        family_name: "Apellidos",
        label_name: "Nombre para etiquetas",
        inat_user_id: "ID de usuario de iNaturalist",
        login: "Usuario",
        membership: "Pertenece a",
        admin: "Permisos de administrador",
        acts_for: "Puede actuar en nombre de",
        leads: "Dirige",
        orcid: "Identificador ORCID registrado por el personal",
        inat_orcid: "Identificador ORCID en iNaturalist",
      },
      source: {
        app: "personal",
        legacy_promotion: "la importación del antiguo Beeline",
        observation_promotion: "una sincronización de iNaturalist",
        inat_backfill: "una consulta de usuario en iNaturalist",
        inat_orcid_fetch: "una consulta de ORCID en iNaturalist",
        sign_in: "su inicio de sesión",
        reconcile: "detectado al inicio",
      },
      blank: "nada",
      admin: { yes: "sí", no: "no" },
      membershipNone: "no registrado",
      recentHeading: "Cambios recientes",
      recentHint: "Las entradas más recientes en el registro de cambios, de todas las personas.",
      personGone: "ya no existe en el sistema",
    },

    notFound: "No existe esa persona.",
    problem: (why: string) => `No se guardó: ${why}`,
  },

  addPerson: {
    link: "Agregar una persona",
    title: "Agregar una persona",
    heading: "Agregar una persona",
    intro:
      "Cualquiera que inicie sesión en Beeline debe estar vinculado previamente a su cuenta de iNaturalist. Los voluntarios se agregan a partir de sus registros en Colectores desconocidos; usa esto para quienes no colectan, como el personal.",
    backToPeople: "Todas las personas",
    lookUp: "Su cuenta de iNaturalist",
    lookUpHint: "Su usuario o un enlace a su perfil de iNaturalist.",
    find: "Buscar",
    notAccount: (typed: string) => `"${typed}" no es un usuario de iNaturalist ni un enlace a un perfil.`,
    noSuchAccount: (typed: string) => `iNaturalist no tiene ninguna cuenta llamada ${typed}.`,
    lookupFailed: "iNaturalist no respondió en este momento. Intenta de nuevo en un minuto.",

    turnedAwayHeading: "Rechazados al iniciar sesión",
    turnedAwayHint:
      "Estas personas intentaron iniciar sesión con iNaturalist, pero nadie en Beeline está conectado a su cuenta, por lo que se les indicó consultar con el personal de su atlas.",
    turnedAwayEmpty: "Nadie ha sido rechazado al iniciar sesión.",
    colAccount: "Cuenta de iNaturalist",
    colTried: "Último intento",
    tried: (first: Date, last: Date) =>
      dateTime(first) === dateTime(last) ? dateTime(last) : `${dateTime(last)} (primero el ${dateTime(first)})`,
    addThem: "Agregar",

    profile: "Su perfil de iNaturalist",
    profileName: (name: string) => `Nombrado ${name} en iNaturalist`,
    noProfileName: "Sin nombre en su perfil de iNaturalist",
    about: (observations: number, joined: Date | null) =>
      [
        `${n(observations)} ${observations === 1 ? "observación" : "observaciones"}`,
        joined === null
          ? null
          : `registrado el ${typeof joined === "string" ? joined : joined.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric", timeZone: ZONE })}`,
      ]
        .filter((x) => x !== null)
        .join(", "),
    triedToSignIn: (when: Date) => `Intentó iniciar sesión en Beeline el ${dateTime(when)}.`,
    held: (name: string) => `Esta cuenta ya está vinculada a ${name}.`,
    openPerson: (name: string) => `Abrir ${name}`,
    waiting: (records: number) =>
      `Esta cuenta tiene ${n(records)} ${records === 1 ? "registro" : "registros"} de colecta en espera en Colectores desconocidos. Agrégala allí para que sus registros se conviertan en muestras simultáneamente.`,
    openWaiting: "Abrir en Colectores desconocidos",

    displayName: "Nombre público",
    displayNameHint: "Cómo aparecerá en todo Beeline.",
    givenName: "Nombre de pila",
    familyName: "Apellidos",
    namesHint: "Se usarán en las etiquetas si llega a colectar.",
    staff: "Personal",
    staffHint: "El personal puede ver y modificar todo en Beeline, incluida la sección Personas.",
    reason: "Motivo (opcional)",
    add: "Agregar persona",
    addedReason: (staff: boolean) => (staff ? "Personal del programa" : "Agregado por su cuenta de iNaturalist"),

    nameBlank: "asigna un nombre a esta persona",
    nameTaken: (name: string) =>
      `alguien aquí ya se llama "${name}". Si se trata de la misma persona, vincula la cuenta desde su página en Personas; si no, dale un nombre que permita distinguirla`,
    problem: (why: string) => `No se guardó: ${why}`,
  },

  unclaimed: {
    title: "Colectores desconocidos",
    heading: "Colectores que Beeline no reconoce",
    intro:
      "Estas personas subieron registros de colecta a los proyectos en iNaturalist y nadie en Beeline está vinculado a su cuenta de iNaturalist. Hasta que alguien identifique quiénes son, sus registros no se convierten en muestras y no pueden iniciar sesión.",
    summary: (records: number, people: number, active: number) =>
      `${n(records)} ${records === 1 ? "registro" : "registros"} de ${n(people)} ${people === 1 ? "persona" : "personas"}, ${n(active)} de ellos de temporadas activas.`,
    empty: "Todas las personas que han subido registros de colecta a iNaturalist son conocidas por Beeline.",
    emptyHeading: "Nadie en espera",
    ledBy: "Dirigido por",
    noLead: "Sin director registrado",
    colAccount: "Cuenta de iNaturalist",
    colRecords: "Registros",
    colActiveSeasons: "Temporadas activas",
    colCollected: "Colectado",
    colMightBe: "Podría ser",
    colWhy: "Por qué",
    noSuggestion: "sin sugerencia",
    backToList: "Todos los colectores desconocidos",
    lede: (records: number, first: Date, last: Date) =>
      `${n(records)} ${records === 1 ? "registro" : "registros"} de colecta en iNaturalist, ${dateRange(first, last)}.`,
    profile: "Su perfil de iNaturalist",
    profileName: (name: string) => `Nombrado ${name} en iNaturalist`,
    collectedIn: (programs: string) => `Colectó en ${programs}`,
    records: "Sus registros",
    colSample: "Muestra",
    colSpecimens: "Ejemplares",
    colPlace: "Lugar",
    colProgram: "Programa",
    placeUnknown: "desconocido",
    viewOnInat: "Ver en iNaturalist",

    existing: "Alguien ya registrado",
    existingHint:
      "Un voluntario que cambió de cuenta o un miembro del hogar puede estar ya registrado en Beeline con otro nombre o cuenta. Vincularle esta cuenta le asignará estos registros y aquellos que ya estén en Beeline se enlazarán en lugar de duplicarse.",
    evidenceRegister: (login: string) => `El padrón del sistema anterior tiene a @${login} con este nombre.`,
    evidenceInatName: "Su perfil de iNaturalist tiene este nombre.",
    alreadyConnected: (login: string) => `Ya conectado con @${login}`,
    thisIs: (name: string) => `Esta persona es ${name}`,
    someoneElse: "Alguien más",
    someoneElseHint: "Su nombre tal como figura en Personas.",
    connect: "Conectar",

    newcomer: "Alguien nuevo",
    newcomerHint:
      "Agrega a esta persona a Beeline con esta cuenta de iNaturalist, para que sus registros se conviertan en muestras y pueda iniciar sesión.",
    checkFirst:
      "Revisa primero las sugerencias de arriba. Si se trata de alguien que ya está registrado aquí, agregarlo nuevamente creará duplicados de muestras existentes.",
    displayName: "Nombre público",
    displayNameHint: "Cómo aparecerá en todo Beeline. Tomado de su perfil de iNaturalist cuando dispone de un nombre.",
    givenName: "Nombre de pila",
    familyName: "Apellidos",
    namesHint: "Se usarán para sus etiquetas.",
    add: "Agregar persona",

    reason: "Motivo (opcional)",
    connectedReason: (records: number) => `${n(records)} registros de colecta en iNaturalist bajo esta cuenta`,

    connected: (login: string, name: string) => `@${login} ahora es ${name}.`,
    outcome: (made: number, linked: number, left: number) =>
      [
        `${n(made)} ${made === 1 ? "muestra nueva" : "muestras nuevas"}`,
        linked > 0 ? `${n(linked)} enlazadas a ${linked === 1 ? "una muestra existente" : "muestras existentes"}` : null,
        left > 0 ? `${n(left)} ${left === 1 ? "registro no pudo convertirse en muestra" : "registros no pudieron convertirse en muestras"}` : null,
      ]
        .filter((x) => x !== null)
        .join(", ") + ".",
    notMadeYet:
      "Se guardó, pero sus muestras no pudieron generarse en este momento. La tarea nocturna de las 2:00 a. m. las generará.",
    openPerson: (name: string) => `Abrir ${name}`,

    gone: "No hay nadie esperando bajo esta cuenta. Es posible que acabe de ser vinculada a alguien.",
    nobodyCalled: (name: string) => `nadie aquí se llama "${name}"`,
    nameAmbiguous: (name: string) =>
      `"${name}" también es el nombre con que los registros antiguos nombran a otra persona, por lo que conectar por este nombre podría asociarse a la persona equivocada — conecta la cuenta desde la página de la persona correcta en Personas`,
    nameShared: (name: string) =>
      `dos personas aquí se llaman "${name}" — conecta la cuenta desde la página de la persona correcta en Personas`,
    alreadyHasAccount: (name: string, login: string) =>
      `${name} ya está conectado a @${login}. Cada persona tiene una sola cuenta de iNaturalist aquí; para transferirla a esta, modifícala en su página de Personas`,
    nameBlank: "asigna un nombre a esta persona",
    nameTaken: (name: string) =>
      `alguien aquí ya se llama "${name}". Si es esa persona, conéctale la cuenta; si no, dale al nuevo usuario un nombre que permita distinguirlo`,
    problem: (why: string) => `No se guardó: ${why}`,
  },

  qcInstructions: {
    missing_required_field:
      "Falta completar un campo necesario para la etiqueta. Complétalo en la observación de iNaturalist (o directamente aquí si es una muestra de trampa).",
    missing_recommended_field:
      "Un campo recomendado está vacío. Completarlo mejora la calidad del registro, pero no impide la impresión.",
    obscured_no_true_coordinates:
      "Las coordenadas están ocultas por la geoprivacidad de iNaturalist y Beeline no dispone de las coordenadas verdaderas. Únete al proyecto con permiso para ver coordenadas verdaderas o desactiva la geoprivacidad en la observación.",
    taxon_obscured_awaiting_atlas:
      "iNaturalist oculta el lugar donde crece la planta de esta observación debido a su estado de conservación. Las etiquetas llevan la ubicación verdadera y Beeline solo la imprime si cuenta con la aprobación del atlas regional de abejas. Dicha aprobación aún no está implementada para esta zona, por lo que las etiquetas no se imprimirán por el momento. No se requiere ninguna acción de tu parte.",
    locality_format:
      "La localidad debe ser breve (18 caracteres o menos), sin comas ni comillas dobles, y ser algo más que el nombre de un condado: se imprime en una etiqueta de 3 pt junto al condado. Ejemplo: Corvallis en lugar de Corvallis, OR.",
    place_unabbreviated:
      "El país y el estado o provincia deben usar abreviaturas estándar (como USA en lugar de United States, u OR en lugar de Oregon) debido al espacio limitado en las etiquetas impresas.",
    place_unrecognised:
      "Beeline no reconoce el estado o provincia en este registro, o no coincide con el país. Utiliza el código de dos letras del estado de EE. UU. o provincia de Canadá (UT, BC) con el país correspondiente. Los registros de otros países pueden ser confirmados por el personal.",
    coordinate_uncertainty:
      "La incertidumbre de la ubicación supera el límite permitido. El aviso indica la precisión registrada y el límite aplicable. Los registros deben tener una precisión de 100 m o menor (resolución GPS) para imprimirse. Los registros colectados antes del 2 de septiembre de 2026 conservan el límite anterior de 250 m solo si sus etiquetas ya fueron impresas o su temporada ya concluyó. Actualiza la precisión en la observación o contacta al personal si la incertidumbre no se puede reducir.",
    coordinate_out_of_region:
      "Las coordenadas de este registro están fuera de Norteamérica, pero el registro indica que deberían estar dentro. Revisa la ubicación en la observación de iNaturalist. Si el ejemplar fue colectado fuera de Norteamérica, ajusta el país correspondiente y solicita confirmación al personal.",
    non_tracheophyte_host:
      "La observación de iNaturalist debe identificar el hospedero floral: una planta vascular, en lugar de un musgo, alga, hongo o la propia abeja. Actualiza la identificación de la observación a la planta en la que se colectó la abeja. Si la abeja no estaba sobre ninguna planta, por ejemplo capturada al vuelo, retira la identificación: una observación sin identificación no genera ningún aviso.",
    duplicate_sample_number:
      "Cada muestra debe tener su propio número, y este aparece en más de una de tus muestras para esa misma fecha. Renumera las observaciones duplicadas en iNaturalist dejando solo una con este número. Tus muestras en Beeline se actualizarán automáticamente hasta que sus etiquetas sean impresas.",
    count_mismatch:
      "El conteo de ejemplares en iNaturalist no coincide con esta muestra. Verifica que la observación tenga número de muestra, fecha y un conteo de uno o más. Una vez impresas las etiquetas, el registro conserva el conteo para el cual fueron emitidas.",
    count_below_printed:
      "El conteo de ejemplares es ahora menor que el número de etiquetas ya impresas para esta muestra. No se requiere ninguna acción; las etiquetas sobrantes pueden desecharse.",
    within_sample_disagreement:
      "Registros históricos combinados en esta muestra tenían valores contradictorios para un mismo campo. Se conservó el valor del registro más antiguo. Revisa las alternativas listadas y edita la muestra si el valor conservado no es correcto.",
    observation_missing_upstream:
      "iNaturalist ya no devuelve la observación asociada a esta muestra. Es posible que haya sido eliminada o retirada del proyecto correspondiente. El personal investigará la situación antes de realizar cualquier impresión adicional para esta muestra.",
    staff_hold:
      "El personal ha retenido esta muestra para que no se imprima. La nota indica el motivo. Si se solicita modificar algún dato, realízalo; el personal revisará el caso y levantará la retención.",
  } as Record<string, string>,

  howItWorks: {
    title: "Cómo funciona Beeline",
    heading: "Cómo funciona Beeline",
    lede: "Beeline transforma tus colectas en ejemplares etiquetados e identificados. Aquí te explicamos lo que ocurre en cada paso y lo que requiere de ti.",
    steps: [
      {
        heading: "En campo: registra cada muestra en iNaturalist.",
        body: [
          "Una ",
          { href: "/glossary#sample", label: "muestra" },
          " es un acto de colecta: un lugar, un día, un tipo de planta (o ninguna). Para cada una, crea una ",
          { href: "/glossary#observation", label: "observación" },
          " en el proyecto de tu atlas, correspondiente a la planta en la que colectaste. Si las abejas no estaban en una planta, por ejemplo si fueron capturadas al vuelo, crea la observación sin identificación. Asígnale el número de muestra (1, 2, 3… reiniciando cada día) y el número de ejemplares. La fecha y la ubicación de la observación se convierten en las de la muestra.",
        ],
      },
      {
        heading: "Cada mañana a las 2:00 a. m. hora del Pacífico, Beeline consulta tus observaciones.",
        body: [
          "No tienes que hacer nada. Cualquier observación nueva o modificada aparece aquí al día siguiente, o de inmediato si presionas “Consultar iNaturalist ahora” en ",
          { href: "/", label: "tu página principal" },
          ".",
        ],
      },
      {
        heading: "Tu página principal lista lo que requiere atención.",
        body: [
          "Beeline revisa cada muestra antes de que pueda etiquetarse y señala aquellas que necesitan corrección, como un número de muestra o conteo faltante, un número usado dos veces en un mismo día, un nombre de lugar demasiado largo para la etiqueta, coordenadas dudosas, ubicaciones fuera de Norteamérica o protegidas por iNaturalist que impiden la lectura de coordenadas verdaderas, una planta hospedera que no sea vascular o una observación que ya no existe. La mayoría de los ajustes se hacen en iNaturalist; los nombres de lugares a menudo pueden corregirse con un solo clic aquí. Una muestra con un ",
          { href: "/glossary#flag", label: "aviso" },
          " que ",
          { href: "/glossary#blocks-printing", label: "bloquea la impresión" },
          " no se imprime hasta que se solucione, por lo que este es el paso más importante.",
        ],
      },
      {
        heading: "El personal prepara una tirada de impresión.",
        body: [
          "Cuando el personal prepara una tirada de impresión, se incluye cada muestra que esté lista. En ese momento tus ejemplares reciben sus números de campo permanentes; las ",
          { href: "/glossary#label", label: "etiquetas" },
          " se imprimen y se te envían por correo. A partir de entonces, el lugar, las coordenadas, el número de muestra y el conteo quedan fijados: las ediciones posteriores en iNaturalist ya no los modifican, así que revisa tus observaciones antes de la tirada, no después. La fecha de la muestra se toma una sola vez y no cambia desde iNaturalist; una fecha incorrecta se corrige notificando al personal.",
        ],
      },
      {
        heading: "Llegan las etiquetas: monta tus ejemplares y colócalas.",
        body: [
          "Cada etiqueta lleva el número de campo, tu nombre, la fecha, el lugar y el número del ",
          { href: "/glossary#specimen", label: "ejemplar" },
          " dentro de su muestra.",
        ],
      },
      {
        heading: "Identifica tus ejemplares.",
        body: [
          "Abre ",
          { href: "/determinations", label: "Identificar ejemplares" },
          " e ingresa lo que puedas para cada uno, hasta donde tengas certeza, como género o familia. Los cambios se guardan a medida que avanzas y pueden deshacerse hasta la 1:00 a. m.; después de esa hora se conservan como tu ",
          { href: "/glossary#determination", label: "determinación" },
          ". Si prefieres la interfaz del antiguo Beeline, continuará disponible en ",
          { href: OLD_BEELINE_ORIGIN, label: "old.melittologist.org" },
          " hasta finales de febrero de 2027.",
        ],
      },
      {
        heading: "Entrega tus ejemplares.",
        body: [
          "Los ejemplares de tu temporada se entregan al taxónomo o al personal de tu atlas antes de la conferencia anual de Master Melittology a principios de marzo. Las identificaciones de expertos llegan más adelante —a menudo meses o años después— en lotes, y aparecen en la página de cada ejemplar.",
        ],
      },
    ],
    whenHeading: "Cuándo ocurren las cosas",
    when: [
      ["Todos los días a la 1:00 a. m. hora del Pacífico: las identificaciones ingresadas desde la 1:00 a. m. anterior se consolidan como tus determinaciones."],
      ["Todos los días a las 2:00 a. m. hora del Pacífico: Beeline consulta iNaturalist."],
      [
        "1 de marzo: concluye la ",
        { href: "/glossary#season", label: "temporada" },
        " del año anterior. Ya no se imprimen nuevas etiquetas de ella, aunque sus registros continúan siendo editables.",
      ],
      ["Las tiradas de impresión ocurren cuando el personal las prepara, no bajo un horario fijo."],
    ],
  },

  glossary: {
    title: "Glosario",
    heading: "Glosario",
    intro: "Términos utilizados en Beeline, provenientes de iNaturalist y de la nomenclatura científica.",
    entries: {
      atlas: {
        term: "Atlas",
        definition:
          "Un atlas estatal o provincial de abejas: Oregon, Washington, Columbia Británica, Idaho o Nuevo México. Las muestras corresponden a un atlas según el lugar donde fueron colectadas. Los voluntarios también pueden colectar fuera de los atlas miembros como parte de Master Melittology.",
      },
      authorship: {
        term: "Autoría",
        definition:
          "La persona que describió y publicó formalmente por primera vez un nombre taxonómico, junto con el año de publicación. La autoría forma parte del nombre científico formal y no se escribe en cursiva.",
        example: { rank: "species", scientificName: "Bombus vosnesenskii", authorship: "Radoszkowski, 1862" },
      },
      flag: {
        term: "Aviso",
        definition:
          "Una notificación que indica una inconsistencia o detalle pendiente en los datos de una muestra. Los avisos se evalúan automáticamente a partir de tus datos durante cada sincronización; resolver el problema desactiva el aviso.",
      },
      "heads-up": {
        term: "Aviso informativo",
        definition:
          "Un aviso orientativo que resalta una recomendación para mejorar el registro, pero que no impide la impresión de las etiquetas.",
      },
      "blocks-printing": {
        term: "Bloquea la impresión",
        definition:
          "Un aviso que señala un problema que impide imprimir las etiquetas, como un campo obligatorio faltante o coordenadas no confiables.",
      },
      bycatch: {
        term: "Captura incidental",
        definition:
          "Ejemplares de insectos distintos de las abejas colectados en una muestra, como avispas, moscas abeja o escarabajos. La captura incidental se conserva, se etiqueta y se identifica junto con las abejas.",
      },
      "cf-aff": {
        term: "cf., aff. y nr.",
        definition:
          "Calificadores utilizados cuando la identificación de una especie es tentativa. 'cf.' indica que el ejemplar se asemeja a esa especie pero requiere confirmación; 'aff.' indica afinidad con la especie pero probablemente representa un taxón distinto; 'nr.' indica que es cercano a dicha especie.",
        example: { rank: "species", scientificName: "Bombus occidentalis", qualifier: "cf." },
      },
      collector: {
        term: "Colector",
        definition:
          "La persona que colectó una muestra. Cuando una muestra registra varios colectores, el número de muestra corresponde a la serie de numeración del primer colector listado.",
      },
      "obscured-coordinates": {
        term: "Coordenadas ocultas",
        definition:
          "Coordenadas desplazadas o protegidas por iNaturalist por motivos de geoprivacidad o para proteger un taxón en riesgo. Las coordenadas ocultas no se imprimen en las etiquetas de los ejemplares.",
      },
      determination: {
        term: "Determinación",
        definition:
          "La identificación taxonómica registrada para un ejemplar. Las determinaciones conservan quién identificó el ejemplar y cuándo; las determinaciones anteriores se preservan en el historial si el ejemplar vuelve a identificarse.",
      },
      ecdysis: {
        term: "Ecdysis",
        definition:
          "El portal y base de datos donde se conservan los registros de ejemplares y las determinaciones de taxónomos especialistas. Los nombres científicos en Beeline se validan frente al tesauro taxonómico de Ecdysis.",
      },
      specimen: {
        term: "Ejemplar",
        definition:
          "Un insecto individual procedente de una muestra. Cada ejemplar recibe un número de campo distintivo y su propia etiqueta impresa.",
      },
      label: {
        term: "Etiqueta",
        definition:
          "La etiqueta impresa que se monta en el alfiler junto con el ejemplar, donde constan la fecha de colecta, localidad, colectores y número de campo. La localidad tiene un límite de 18 caracteres para caber en la etiqueta.",
      },
      "floral-host": {
        term: "Hospedero floral",
        definition:
          "La planta en la que se colectó una muestra, identificada a través de la observación de iNaturalist correspondiente. Las plantas hospederas deben ser vasculares. Las muestras obtenidas sin planta asociada no registran hospedero.",
      },
      "coordinate-uncertainty": {
        term: "Incertidumbre de coordenadas",
        definition:
          "El radio estimado de precisión de las coordenadas registradas en iNaturalist. Una precisión superior a 100 m es demasiado imprecisa para imprimir. Los registros colectados antes del 2 de septiembre de 2026 cuyas etiquetas se hayan impreso o cuya temporada haya concluido conservan el límite anterior de 250 m.",
      },
      "master-melittology": {
        term: "Master Melittology",
        definition:
          "El programa de Extensión de la Universidad Estatal de Oregón (OSU Extension) que capacita a voluntarios y coordina los atlas regionales de abejas.",
      },
      method: {
        term: "Método",
        definition:
          "La técnica utilizada para colectar una muestra: mediante red entomológica o con trampas, como trampas de aspas, trampas de plato o nidos trampa.",
      },
      sample: {
        term: "Muestra",
        definition:
          "Todos los ejemplares colectados en una misma especie de planta hospedera, en un único lugar y en una sola fecha, o bien colectados en ese sitio y fecha sin hospedero asociado. La muestra es la unidad fundamental para los controles de calidad y la generación de etiquetas.",
      },
      "trap-sample": {
        term: "Muestra de trampa",
        definition:
          "Ejemplares colectados mediante una trampa desatendida, fechados a lo largo del intervalo transcurrido desde que la trampa se revisó por última vez. Las muestras de trampa sin observaciones en iNaturalist se editan directamente en Beeline.",
      },
      "scientific-name": {
        term: "Nombre científico",
        definition:
          "El nombre formal en latín de un organismo. Los nombres de género y categorías inferiores se escriben en cursiva; las familias y categorías superiores se escriben sin cursiva.",
        example: { rank: "species", scientificName: "Bombus vosnesenskii" },
      },
      "vernacular-name": {
        term: "Nombre vernáculo",
        definition:
          "El nombre común o coloquial de un organismo. Beeline registra nombres científicos formales en lugar de nombres comunes.",
      },
      "field-number": {
        term: "Número de campo",
        definition:
          "El identificador único asignado a un ejemplar cuando se preparan las tiradas de impresión, impreso directamente en la etiqueta. Una vez asignado, permanece asociado permanentemente a ese ejemplar.",
      },
      "catalog-number": {
        term: "Número de catálogo",
        definition:
          "El identificador asignado a un ejemplar por una colección de museo, independiente del número de campo impreso en la etiqueta.",
      },
      "sample-number": {
        term: "Número de muestra",
        definition:
          "El identificador asignado a una muestra en la fecha de colecta. Los números de muestra son únicos para cada colector en una fecha determinada.",
      },
      observation: {
        term: "Observación",
        definition:
          "El registro de iNaturalist que documenta el evento de colecta de una muestra, aportando el número de muestra, conteo de ejemplares, fecha de colecta, coordenadas e identificación de la planta hospedera.",
      },
      program: {
        term: "Programa",
        definition:
          "El programa para el cual se colectó una muestra: un atlas estatal o provincial de abejas si se colectó dentro de su territorio; de lo contrario, Master Melittology. Otros programas, como los muestreos de BLM, se registrarán a medida que comiencen.",
      },
      rank: {
        term: "Rango taxonómico",
        definition:
          "El nivel jerárquico de una identificación en la clasificación biológica, como familia, género, especie o subespecie. Las identificaciones a nivel de género o familia constituyen determinaciones válidas.",
      },
      "sensu-stricto": {
        term: "s. str. y s. lat.",
        definition:
          "Abreviaturas de sensu stricto ('en sentido estricto') y sensu lato ('en sentido amplio'), que especifican cuál definición taxonómica de un nombre se está adoptando.",
        example: { rank: "genus", scientificName: "Bombus", qualifier: "s. str." },
      },
      sync: {
        term: "Sincronización",
        definition:
          "El proceso programado cada mañana que importa a Beeline las actualizaciones de observaciones realizadas en iNaturalist.",
      },
      sp: {
        term: "sp. y spp.",
        definition:
          "Abreviaturas taxonómicas: 'sp.' designa una especie no identificada dentro de un género; 'spp.' designa múltiples especies. Ninguna de las dos se escribe en cursiva.",
        example: { rank: "genus", scientificName: "Bombus", qualifier: "sp." },
      },
      subgenus: {
        term: "Subgénero",
        definition:
          "Un rango taxonómico entre género y especie, escrito entre paréntesis entre el nombre del género y el epíteto específico.",
        example: { rank: "species", scientificName: "Bombus insularis", subgenus: "Psithyrus" },
      },
      season: {
        term: "Temporada",
        definition:
          "Un año calendario de colectas. Las muestras pertenecen a la temporada en que fueron colectadas o, en el caso de trampas, cuando fueron colocadas. Las temporadas activas reciben impresión de etiquetas; el 1 de marzo la temporada previa concluye y ya no se imprimen etiquetas para ella.",
      },
    } satisfies Record<string, GlossaryEntry>,
  },
};
