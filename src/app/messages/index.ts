import { en, type Messages } from "./en.js";
import { es } from "./es.js";

export type { Messages };
export { en, es };

/**
 * Locale → catalog. Resolves to Spanish for Spanish locales (e.g. "es", "es-MX",
 * "es-419"), English otherwise. A person's locale preference will come from
 * their session when it exists.
 */
export function messagesFor(locale: string | null): Messages {
  if (locale && (locale === "es" || locale.startsWith("es-") || locale.startsWith("es_"))) {
    return es;
  }
  return en;
}
