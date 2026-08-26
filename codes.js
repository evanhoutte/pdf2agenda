/**
 * Résolution d'un code de planning en créneau horaire.
 *
 * Deux mécanismes, dans cet ordre :
 *   1. `codes`  — cas particuliers, correspondance exacte du code ;
 *   2. `postes` — règle générale pour les codes « N chiffres + lettre
 *      facultative », indexée sur le DERNIER chiffre.
 * Un « * » final est toujours retiré avant recherche.
 */

const RE_HEURE = /^(\d{1,2}):(\d{2})$/;
const RE_POSTE = /^\d*(\d)[A-Z]?$/;

export class ErreurCodes extends Error {}

const nu = (code) => code.replace(/\*+$/, '');

function verifierHeure(valeur, code, champ) {
  const m = RE_HEURE.exec(String(valeur ?? ''));
  if (!m) {
    throw new ErreurCodes(
      `Code « ${code} » : « ${champ} » doit être au format HH:MM (trouvé « ${valeur ?? ''} »).`);
  }
  const [h, min] = [+m[1], +m[2]];
  if (h > 23 || min > 59) throw new ErreurCodes(`Code « ${code} » : heure invalide « ${valeur} ».`);
  return { h, min };
}

/** Ajoute une durée à un horaire mural, en restant dans la journée. */
const enMinutes = ({ h, min }) => h * 60 + min;
const format = (mn) => {
  const m = ((mn % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

function construire(code, entree) {
  const libelle = entree.libelle || null;
  if (entree.off) return { code, libelle, off: true };

  const debut = verifierHeure(entree.debut, code, 'debut');
  const fin = verifierHeure(entree.fin, code, 'fin');
  const d = enMinutes(debut);
  let f = enMinutes(fin);
  // Fin <= début : le créneau chevauche minuit (poste de nuit).
  const lendemain = f <= d;
  if (lendemain) f += 1440;

  return {
    code, libelle, off: false,
    debut: format(d), fin: format(f), lendemain,
    dureeMinutes: f - d,
  };
}

export class TableCodes {
  constructor({ codes = {}, postes = {} } = {}) {
    for (const cle of Object.keys(postes)) {
      if (!/^\d$/.test(cle)) {
        throw new ErreurCodes(
          `Règle de poste « ${cle} » invalide : attendu un chiffre unique ` +
          `(le dernier chiffre du code).`);
      }
    }
    this.codes = codes;
    this.postes = postes;
  }

  entreeExplicite(code) {
    return this.codes[code] ?? this.codes[nu(code)] ?? null;
  }

  entreePoste(code) {
    const m = RE_POSTE.exec(nu(code));
    return m ? (this.postes[m[1]] ?? null) : null;
  }

  /** Créneau correspondant au code, ou null s'il est inconnu ou à compléter. */
  resoudre(code) {
    const explicite = this.entreeExplicite(code);
    if (explicite && !explicite.todo) return construire(code, explicite);

    const poste = this.entreePoste(code);
    if (poste && !poste.todo) return construire(code, poste);

    return null;
  }

  /** Sépare les codes non résolus en « déclarés mais à compléter » et « inconnus ». */
  diagnostic(codes) {
    const aCompleter = new Set();
    const inconnus = new Set();
    for (const code of codes) {
      if (this.resoudre(code)) continue;
      const declare = !!(this.entreeExplicite(code) || this.entreePoste(code));
      (declare ? aCompleter : inconnus).add(code);
    }
    return { aCompleter: [...aCompleter].sort(), inconnus: [...inconnus].sort() };
  }

  titre(creneau, tag) {
    const base = `${tag || ''} ${creneau.code}`.trim();
    return creneau.libelle ? `${base} — ${creneau.libelle}` : base;
  }
}
