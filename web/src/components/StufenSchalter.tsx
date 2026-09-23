import { STUFEN, type Stufe } from '../rechte';

/**
 * Dreistufiger Schalter: keine / lesen / schreiben.
 *
 * Bewusst drei nebeneinanderliegende Schaltflaechen statt eines Auswahlfeldes.
 * Bei zweihundert Zeilen zaehlt jeder eingesparte Klick, und der geltende
 * Zustand muss beim Ueberfliegen einer Liste ohne Aufklappen erkennbar sein.
 *
 * `geerbt` markiert eine Stufe, die nicht an dieser Zeile haengt, sondern aus
 * der Grundstufe der Person stammt — gestrichelter Rahmen statt gefuellter
 * Flaeche. Wer das nicht unterscheiden kann, haelt eine geerbte Freigabe fuer
 * eine selbst gesetzte.
 */
export function StufenSchalter({
  wert,
  onWechsel,
  geerbt = false,
  disabled = false,
  beschriftung,
}: {
  wert: Stufe;
  onWechsel: (stufe: Stufe) => void;
  geerbt?: boolean;
  disabled?: boolean;
  /** Fuer Hilfsmittel: worauf sich die Auswahl bezieht. */
  beschriftung: string;
}) {
  const aktivKlasse: Record<Stufe, string> = {
    keine: 'bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-100',
    lesen: 'bg-sky-600 text-white',
    schreiben: 'bg-amber-600 text-white',
  };

  return (
    <div
      role="group"
      aria-label={beschriftung}
      className={`inline-flex overflow-hidden rounded-md border ${
        geerbt
          ? 'border-dashed border-slate-400 dark:border-slate-500'
          : 'border-slate-300 dark:border-slate-600'
      }`}
    >
      {STUFEN.map(({ wert: stufe, label }) => {
        const gewaehlt = stufe === wert;
        return (
          <button
            key={stufe}
            type="button"
            disabled={disabled}
            aria-pressed={gewaehlt}
            onClick={() => onWechsel(stufe)}
            className={`px-2 py-1 text-xs font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 ${
              gewaehlt
                ? `${aktivKlasse[stufe]} ${geerbt ? 'opacity-70' : ''}`
                : 'bg-white text-slate-600 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
