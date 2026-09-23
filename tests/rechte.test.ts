import { describe, expect, it } from 'vitest';
import {
  begruendung,
  darfAendern,
  darfLesen,
  istEingeschraenkt,
  type Personenlage,
  type Rechtelage,
  type Stufe,
} from '../src/mcp/rechte.js';

/**
 * MCDC-Matrix der Rechteberechnung.
 *
 * Geprueft wird nicht, ob irgendeine Kombination das erwartete Ergebnis
 * liefert, sondern ob JEDE Bedingung fuer sich genommen ueber das Ergebnis
 * entscheidet. Dafuer gibt es zu jeder Bedingung ein Paar von Faellen, die sich
 * in genau dieser einen Bedingung unterscheiden und verschieden ausgehen.
 *
 * Warum so streng: Die Rangfolge der drei Stufen ist die Mandantengrenze. Eine
 * Bedingung, die in Wahrheit nie ausschlaggebend ist, waere eine Stufe, die es
 * nur auf dem Papier gibt — und genau das faellt in einem Test, der bloss
 * Beispiele durchrechnet, nicht auf.
 *
 * Bedingung             | Fall A (Wert)          | Fall B (Wert)          | Funktion    | A -> B
 * ----------------------|------------------------|------------------------|-------------|-----------
 * Sperre trifft         | [42]                   | []                     | darfLesen   | nein -> ja
 * Zugangsfreigabe leer  | [7]                    | []                     | darfLesen   | nein -> ja
 * Projekt in Freigabe   | [7]                    | [7, 42]                | darfLesen   | nein -> ja
 * Matrix aktiv          | aktiv                  | inaktiv                | darfLesen   | nein -> ja
 * Person erkannt        | nicht erkannt          | erkannt                | darfAendern | nein -> ja
 * Projekt in lesen      | []                     | [42]                   | darfLesen   | nein -> ja
 * Projekt in schreiben  | []                     | [42]                   | darfAendern | nein -> ja
 * grundstufe            | 'keine'                | 'lesen'                | darfLesen   | nein -> ja
 * readOnly              | true                   | false                  | darfAendern | nein -> ja
 * beiUnbekannt          | 'ablehnen'             | 'nur_lesen'            | darfLesen   | nein -> ja
 *
 * Alle uebrigen Werte bleiben im jeweiligen Paar gleich; genau das macht die
 * Bedingung als ergebnisbestimmend nachweisbar.
 */

const PROJEKT = 42;
const FREMD = 7;

function person(teil: Partial<Personenlage> = {}): Personenlage {
  return { aktiv: false, erkannt: false, grundstufe: 'keine', lesen: [], schreiben: [], ...teil };
}

function lage(teil: Partial<Rechtelage> = {}): Rechtelage {
  return {
    gesperrteProjektIds: [],
    allowedProjectIds: [],
    readOnly: false,
    person: person(),
    beiUnbekannt: 'nur_lesen',
    ...teil,
  };
}

/** Kurzform fuer eine erkannte Person mit Matrix. */
function zugeordnet(teil: Partial<Personenlage> = {}): Personenlage {
  return person({ aktiv: true, erkannt: true, ...teil });
}

describe('Stufe 1: Sperrliste', () => {
  it('sperrt ein Projekt, das auf der Liste steht', () => {
    expect(darfLesen(PROJEKT, lage({ gesperrteProjektIds: [PROJEKT] }))).toBe(false);
  });

  it('laesst dasselbe Projekt ohne Eintrag durch', () => {
    // Einziger Unterschied zum Fall darueber: die Sperrliste ist leer.
    expect(darfLesen(PROJEKT, lage({ gesperrteProjektIds: [] }))).toBe(true);
  });

  it('sperrt auch einen Zugang ganz ohne Einschraenkung', () => {
    // Der eigentliche Zweck der Liste: Bereiche, die ueber diese Anbindung
    // niemand sehen soll — auch nicht ueber einen uneingeschraenkten Zugang.
    const ohneEinschraenkung = lage({ gesperrteProjektIds: [PROJEKT], allowedProjectIds: [] });
    expect(darfLesen(PROJEKT, ohneEinschraenkung)).toBe(false);
    expect(darfAendern(PROJEKT, ohneEinschraenkung)).toBe(false);
  });

  it('greift nicht, wenn der Aufruf kein Projekt nennt', () => {
    expect(darfLesen(undefined, lage({ gesperrteProjektIds: [PROJEKT] }))).toBe(true);
  });
});

describe('Stufe 2: Zugangsfreigabe', () => {
  it('weist ein Projekt ausserhalb der Freigabe ab', () => {
    expect(darfLesen(PROJEKT, lage({ allowedProjectIds: [FREMD] }))).toBe(false);
  });

  it('laesst bei leerer Freigabe alles durch', () => {
    // Unterschied nur in der Laenge der Liste: leer heisst "keine zusaetzliche
    // Einschraenkung", nicht "nichts erlaubt".
    expect(darfLesen(PROJEKT, lage({ allowedProjectIds: [] }))).toBe(true);
  });

  it('laesst ein enthaltenes Projekt durch', () => {
    // Unterschied zum ersten Fall nur darin, ob 42 in der Liste steht.
    expect(darfLesen(PROJEKT, lage({ allowedProjectIds: [FREMD, PROJEKT] }))).toBe(true);
  });

  it('greift nicht, wenn der Aufruf kein Projekt nennt', () => {
    expect(darfLesen(undefined, lage({ allowedProjectIds: [FREMD] }))).toBe(true);
  });
});

describe('Stufe 3: Personenmatrix', () => {
  it('entscheidet nur, wenn sie aktiv ist', () => {
    const inaktiv = lage({ person: person({ aktiv: false, erkannt: true }) });
    const aktiv = lage({ person: person({ aktiv: true, erkannt: true }) });
    // Einziger Unterschied: der Schalter. Ohne Zuordnung und mit grundstufe
    // 'keine' schliesst die aktive Matrix das Projekt aus.
    expect(darfLesen(PROJEKT, inaktiv)).toBe(true);
    expect(darfLesen(PROJEKT, aktiv)).toBe(false);
  });

  it('macht die Erkennung zum Ausschlag beim Aendern', () => {
    const grundlage = { grundstufe: 'schreiben' as Stufe };
    const unbekannt = lage({ person: person({ aktiv: true, erkannt: false, ...grundlage }) });
    const bekannt = lage({ person: zugeordnet(grundlage) });
    expect(darfAendern(PROJEKT, unbekannt)).toBe(false);
    expect(darfAendern(PROJEKT, bekannt)).toBe(true);
  });

  it('macht den Eintrag in der Leseliste zum Ausschlag', () => {
    expect(darfLesen(PROJEKT, lage({ person: zugeordnet({ lesen: [] }) }))).toBe(false);
    expect(darfLesen(PROJEKT, lage({ person: zugeordnet({ lesen: [PROJEKT] }) }))).toBe(true);
  });

  it('macht den Eintrag in der Schreibliste zum Ausschlag', () => {
    const nurLesen = lage({ person: zugeordnet({ grundstufe: 'lesen', schreiben: [] }) });
    const mitSchreiben = lage({
      person: zugeordnet({ grundstufe: 'lesen', schreiben: [PROJEKT] }),
    });
    expect(darfAendern(PROJEKT, nurLesen)).toBe(false);
    expect(darfAendern(PROJEKT, mitSchreiben)).toBe(true);
  });

  it('macht die Grundstufe zum Ausschlag, wo kein eigener Eintrag steht', () => {
    expect(darfLesen(PROJEKT, lage({ person: zugeordnet({ grundstufe: 'keine' }) }))).toBe(false);
    expect(darfLesen(PROJEKT, lage({ person: zugeordnet({ grundstufe: 'lesen' }) }))).toBe(true);
  });

  it('laesst die Grundstufe auch ueber das Aendern entscheiden', () => {
    expect(darfAendern(PROJEKT, lage({ person: zugeordnet({ grundstufe: 'lesen' }) }))).toBe(false);
    expect(darfAendern(PROJEKT, lage({ person: zugeordnet({ grundstufe: 'schreiben' }) }))).toBe(
      true,
    );
  });

  it('laesst einen eigenen Eintrag die Grundstufe ueberstimmen', () => {
    // Beide Richtungen: der Eintrag kann erweitern und einschraenken — aber nur
    // innerhalb der Obergrenze des Zugangs.
    const strengeGrundstufe = zugeordnet({ grundstufe: 'keine', schreiben: [PROJEKT] });
    expect(darfAendern(PROJEKT, lage({ person: strengeGrundstufe }))).toBe(true);

    const weiteGrundstufe = zugeordnet({ grundstufe: 'schreiben', lesen: [PROJEKT] });
    expect(darfLesen(PROJEKT, lage({ person: weiteGrundstufe }))).toBe(true);
    expect(darfAendern(PROJEKT, lage({ person: weiteGrundstufe }))).toBe(false);
  });
});

describe('Schreibschutz des Zugangs', () => {
  it('macht readOnly zum Ausschlag', () => {
    expect(darfAendern(PROJEKT, lage({ readOnly: true }))).toBe(false);
    expect(darfAendern(PROJEKT, lage({ readOnly: false }))).toBe(true);
  });

  it('laesst sich von der Matrix nicht aufheben', () => {
    // Die Matrix kann nur weiter einschraenken, nie lockern.
    const mitSchreibrecht = lage({
      readOnly: true,
      person: zugeordnet({ grundstufe: 'schreiben', schreiben: [PROJEKT] }),
    });
    expect(darfAendern(PROJEKT, mitSchreibrecht)).toBe(false);
    expect(darfLesen(PROJEKT, mitSchreibrecht)).toBe(true);
  });
});

describe('Unbekannte Person', () => {
  const unbekannt = (beiUnbekannt: 'ablehnen' | 'nur_lesen'): Rechtelage =>
    lage({ beiUnbekannt, person: person({ aktiv: true, erkannt: false }) });

  it('macht beiUnbekannt zum Ausschlag', () => {
    expect(darfLesen(PROJEKT, unbekannt('ablehnen'))).toBe(false);
    expect(darfLesen(PROJEKT, unbekannt('nur_lesen'))).toBe(true);
  });

  it('erlaubt mit nur_lesen das Lesen und verweigert jede Aenderung', () => {
    // Der Betriebsfall: Die Benutzer-Kopfzeilen kommen noch nicht bei jedem
    // Client an. Lesen muss weiterlaufen, Schreiben darf es nicht.
    expect(darfLesen(PROJEKT, unbekannt('nur_lesen'))).toBe(true);
    expect(darfAendern(PROJEKT, unbekannt('nur_lesen'))).toBe(false);
  });

  it('verweigert die Aenderung auch ohne Projektbezug', () => {
    // Sonst waere die Matrix ueber jeden projektlosen Schreibaufruf zu umgehen:
    // es genuegte, das Projekt nicht zu nennen.
    expect(darfLesen(undefined, unbekannt('nur_lesen'))).toBe(true);
    expect(darfAendern(undefined, unbekannt('nur_lesen'))).toBe(false);
  });

  it('bleibt mit nur_lesen an die Zugangsfreigabe gebunden', () => {
    const eingeschraenkt = lage({
      allowedProjectIds: [FREMD],
      person: person({ aktiv: true, erkannt: false }),
    });
    expect(darfLesen(PROJEKT, eingeschraenkt)).toBe(false);
    expect(darfLesen(FREMD, eingeschraenkt)).toBe(true);
  });

  it('verweigert mit ablehnen auch den projektlosen Aufruf', () => {
    expect(darfLesen(undefined, unbekannt('ablehnen'))).toBe(false);
    expect(darfAendern(undefined, unbekannt('ablehnen'))).toBe(false);
  });
});

describe('Rangfolge der drei Stufen', () => {
  it('laesst die Sperre die Zuordnung schlagen', () => {
    // Die Person hat ausdruecklich Schreibrecht an genau diesem Projekt — die
    // Sperrliste hebt es trotzdem nicht auf.
    const gesperrt = lage({
      gesperrteProjektIds: [PROJEKT],
      person: zugeordnet({ grundstufe: 'schreiben', schreiben: [PROJEKT] }),
    });
    expect(darfLesen(PROJEKT, gesperrt)).toBe(false);
    expect(darfAendern(PROJEKT, gesperrt)).toBe(false);
  });

  it('laesst die Sperre auch die Zugangsfreigabe schlagen', () => {
    const gesperrt = lage({
      gesperrteProjektIds: [PROJEKT],
      allowedProjectIds: [PROJEKT, FREMD],
    });
    expect(darfLesen(PROJEKT, gesperrt)).toBe(false);
    expect(darfLesen(FREMD, gesperrt)).toBe(true);
  });

  it('laesst eine Zuordnung die Zugangsfreigabe nicht ausweiten', () => {
    // Der Kern der Rangfolge: Die Matrix schraenkt innerhalb der Obergrenze
    // ein, sie verschiebt die Obergrenze nicht.
    const ausserhalb = lage({
      allowedProjectIds: [FREMD],
      person: zugeordnet({ grundstufe: 'schreiben', schreiben: [PROJEKT] }),
    });
    expect(darfLesen(PROJEKT, ausserhalb)).toBe(false);
    expect(darfAendern(PROJEKT, ausserhalb)).toBe(false);
  });

  it('laesst eine Zuordnung die Sperrliste nicht ausweiten, auch nicht bei leerer Freigabe', () => {
    const ausserhalb = lage({
      gesperrteProjektIds: [PROJEKT],
      allowedProjectIds: [],
      person: zugeordnet({ grundstufe: 'schreiben' }),
    });
    expect(darfAendern(PROJEKT, ausserhalb)).toBe(false);
  });
});

describe('Aufrufe ohne Projektbezug bei erkannter Person', () => {
  it('laesst das Lesen zu, weil die Projektpruefung nicht greifen kann', () => {
    expect(darfLesen(undefined, lage({ person: zugeordnet({ grundstufe: 'keine' }) }))).toBe(true);
  });

  it('erlaubt eine Aenderung nur, wenn die Person irgendwo Schreibrecht hat', () => {
    const ohneSchreibrecht = lage({ person: zugeordnet({ grundstufe: 'lesen', lesen: [PROJEKT] }) });
    const mitSchreibrecht = lage({ person: zugeordnet({ grundstufe: 'lesen', schreiben: [PROJEKT] }) });
    expect(darfAendern(undefined, ohneSchreibrecht)).toBe(false);
    expect(darfAendern(undefined, mitSchreibrecht)).toBe(true);
  });

  it('erlaubt eine Aenderung auch bei schreibender Grundstufe', () => {
    expect(darfAendern(undefined, lage({ person: zugeordnet({ grundstufe: 'schreiben' }) }))).toBe(
      true,
    );
  });
});

describe('Abgeschaltete Matrix verhaelt sich wie bisher', () => {
  /** Die Regel, die vor der Matrix galt: nur die Zugangsfreigabe zaehlt. */
  function wieBisher(projectId: number | undefined, allowed: number[]): boolean {
    if (allowed.length === 0) return true;
    if (projectId === undefined) return true;
    return allowed.includes(projectId);
  }

  const freigaben: number[][] = [[], [PROJEKT], [FREMD], [FREMD, PROJEKT]];
  const projekte: Array<number | undefined> = [PROJEKT, FREMD, 99, undefined];

  it('liefert fuer jede Kombination aus Freigabe und Projekt dasselbe Ergebnis', () => {
    for (const allowed of freigaben) {
      for (const projectId of projekte) {
        const ohneMatrix = lage({ allowedProjectIds: allowed });
        expect({ allowed, projectId, erlaubt: darfLesen(projectId, ohneMatrix) }).toEqual({
          allowed,
          projectId,
          erlaubt: wieBisher(projectId, allowed),
        });
      }
    }
  });

  it('macht das Aendern weiterhin allein an readOnly fest', () => {
    for (const allowed of freigaben) {
      for (const projectId of projekte) {
        const schreibend = lage({ allowedProjectIds: allowed, readOnly: false });
        const lesend = lage({ allowedProjectIds: allowed, readOnly: true });
        expect(darfAendern(projectId, schreibend)).toBe(wieBisher(projectId, allowed));
        expect(darfAendern(projectId, lesend)).toBe(false);
      }
    }
  });

  it('ignoriert eine hinterlegte Zuordnung, solange die Matrix aus ist', () => {
    // Wichtig fuer die stufenweise Umstellung: Eine bereits gepflegte Matrix
    // darf einen noch nicht umgestellten Zugang nicht veraendern.
    const gepflegtAberAus = lage({
      person: person({ aktiv: false, erkannt: true, grundstufe: 'keine', lesen: [FREMD] }),
    });
    expect(darfLesen(PROJEKT, gepflegtAberAus)).toBe(true);
    expect(darfAendern(PROJEKT, gepflegtAberAus)).toBe(true);
  });
});

describe('Erkennung einer Einschraenkung', () => {
  it('meldet einen voellig unbeschraenkten Zugang als unbeschraenkt', () => {
    expect(istEingeschraenkt(lage())).toBe(false);
  });

  it('meldet jede der drei Stufen einzeln als Einschraenkung', () => {
    expect(istEingeschraenkt(lage({ gesperrteProjektIds: [PROJEKT] }))).toBe(true);
    expect(istEingeschraenkt(lage({ allowedProjectIds: [PROJEKT] }))).toBe(true);
    expect(istEingeschraenkt(lage({ person: person({ aktiv: true }) }))).toBe(true);
  });

  it('zaehlt den Schreibschutz nicht dazu', () => {
    // readOnly filtert nichts heraus, es verhindert nur Aenderungen. Eine
    // Trefferzahl muss deshalb davon unberuehrt bleiben.
    expect(istEingeschraenkt(lage({ readOnly: true }))).toBe(false);
  });
});

describe('Begruendung', () => {
  it('nennt die Sperrliste, wenn sie gegriffen hat', () => {
    const text = begruendung(
      PROJEKT,
      lage({
        gesperrteProjektIds: [PROJEKT],
        allowedProjectIds: [FREMD],
        person: zugeordnet({ grundstufe: 'keine' }),
      }),
    );
    expect(text).toMatch(/gesperrt/);
  });

  it('nennt die Zugangsfreigabe, wenn sie gegriffen hat', () => {
    const text = begruendung(
      PROJEKT,
      lage({ allowedProjectIds: [FREMD], person: zugeordnet({ grundstufe: 'schreiben' }) }),
    );
    expect(text).toMatch(/nicht freigegeben/);
  });

  it('nennt die fehlende Zuordnung, wenn die Matrix gegriffen hat', () => {
    const text = begruendung(PROJEKT, lage({ person: zugeordnet({ grundstufe: 'keine' }) }));
    expect(text).toMatch(/nicht zugeordnet/);
  });

  it('unterscheidet "nur lesend zugeordnet" von "nicht zugeordnet"', () => {
    const text = begruendung(PROJEKT, lage({ person: zugeordnet({ lesen: [PROJEKT] }) }));
    expect(text).toMatch(/nur lesend/);
  });

  it('nennt die fehlende Erkennung, wenn die Person unbekannt blieb', () => {
    const text = begruendung(PROJEKT, lage({ person: person({ aktiv: true, erkannt: false }) }));
    expect(text).toMatch(/nicht zugeordnet werden/);
    expect(text).not.toMatch(new RegExp(String(PROJEKT)));
  });

  it('nennt den Schreibschutz des Zugangs', () => {
    const text = begruendung(PROJEKT, lage({ readOnly: true }));
    expect(text).toMatch(/beschränkt/);
  });

  it('verraet nie, ob es das Projekt gibt', () => {
    // Ein Unterschied in der Formulierung waere ein Weg, die Projektlandschaft
    // fremder Mandanten abzutasten: Man probiert Nummern durch und liest am
    // Wortlaut ab, welche existiert.
    const eingeschraenkt = lage({ allowedProjectIds: [FREMD] });
    const ersterText = begruendung(1234, eingeschraenkt);
    const zweiterText = begruendung(5678, eingeschraenkt);
    expect(ersterText.replace('1234', '#')).toBe(zweiterText.replace('5678', '#'));
    expect(ersterText).not.toMatch(/existiert|unbekannt|gibt es nicht/i);
  });

  it('schreibt echte Umlaute statt Ersatzschreibweisen', () => {
    // Die Saetze gehen in Fehlermeldungen und damit vor die Augen der Anwender.
    const saetze = [
      begruendung(PROJEKT, lage({ gesperrteProjektIds: [PROJEKT] })),
      begruendung(PROJEKT, lage({ allowedProjectIds: [FREMD] })),
      begruendung(PROJEKT, lage({ readOnly: true })),
      begruendung(PROJEKT, lage({ person: person({ aktiv: true, erkannt: false }) })),
      begruendung(
        PROJEKT,
        lage({
          beiUnbekannt: 'ablehnen',
          person: person({ aktiv: true, erkannt: false }),
        }),
      ),
    ];
    for (const satz of saetze) {
      expect(satz).not.toMatch(/\b(fuer|moeglich|Aenderungen|beschraenkt|laesst)\b/);
    }
  });
});
