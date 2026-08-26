/**
 * Configuration : conservée dans le localStorage du navigateur, jamais ailleurs.
 *
 * Elle est propre à l'appareil ET au navigateur : d'où l'export/import JSON
 * pour la transporter du PC au téléphone. Le jeton Google n'y figure pas —
 * il reste en mémoire vive et expire au bout d'une heure.
 */

const CLE = 'pdf2agenda.config.v1';
const VERSION = 1;

/** Aucune donnée personnelle ni propre à un employeur dans les valeurs par défaut. */
export const CONFIG_VIDE = {
  version: VERSION,
  clientId: '',
  personne: '',
  calendarId: '',
  calendarNom: '',
  tag: '',
  couleur: '9',
  fuseau: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Paris',
  joursOffEnJourneeEntiere: false,
  heritagePrefixe: '',
  postes: {},
  codes: {},
};

export const COULEURS = {
  1: 'Lavande', 2: 'Sauge', 3: 'Raisin', 4: 'Flamant', 5: 'Banane', 6: 'Mandarine',
  7: 'Paon', 8: 'Graphite', 9: 'Myrtille', 10: 'Basilic', 11: 'Tomate',
};

export function charger() {
  try {
    const brut = localStorage.getItem(CLE);
    if (!brut) return { ...CONFIG_VIDE };
    return { ...CONFIG_VIDE, ...JSON.parse(brut), version: VERSION };
  } catch {
    return { ...CONFIG_VIDE };
  }
}

export function enregistrer(config) {
  localStorage.setItem(CLE, JSON.stringify({ ...config, version: VERSION }));
  return config;
}

export function effacer() {
  localStorage.removeItem(CLE);
}

/** Réglages minimaux avant de pouvoir synchroniser. */
export function incomplet(config) {
  const manque = [];
  if (!config.clientId) manque.push('identifiant client OAuth');
  if (!config.personne) manque.push('nom de la personne');
  if (!config.calendarId) manque.push('agenda de destination');
  if (!Object.keys(config.postes).length && !Object.keys(config.codes).length) {
    manque.push('table des codes');
  }
  return manque;
}

export function exporter(config) {
  const { clientId, ...reste } = config;
  return JSON.stringify({ ...reste, exporteLe: new Date().toISOString() }, null, 2);
}

export function importer(texte) {
  const brut = JSON.parse(texte);
  if (typeof brut !== 'object' || brut === null) throw new Error('Fichier illisible.');
  const { exporteLe, clientId, ...reste } = brut;
  // clientId est propre à l'appareil (origine JavaScript autorisée) : on ne
  // l'écrase pas lors d'un import.
  const actuel = charger();
  return enregistrer({ ...CONFIG_VIDE, ...reste, clientId: actuel.clientId });
}

/** Demande au navigateur de ne pas évincer le stockage sous pression mémoire. */
export async function rendrePersistant() {
  if (!navigator.storage?.persist) return null;
  if (await navigator.storage.persisted?.()) return true;
  return navigator.storage.persist();
}
