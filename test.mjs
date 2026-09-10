/**
 * Vérifie la synchronisation contre un faux serveur Google Calendar.
 * Aucun accès réseau, aucun compte requis.  Lancement : node test.mjs
 */
import { TableCodes } from './codes.js';
import * as gcal from './gcal.js';

// --- Faux environnement navigateur -----------------------------------------
let agenda = new Map();          // id -> événement
let appels = [];
let prochainId = 1;

globalThis.window = {
  google: { accounts: { oauth2: { initTokenClient: (o) => ({
    requestAccessToken() { this.callback({ access_token: 'faux-jeton' }); },
    callback: null, _clientId: o.client_id,
  }) } } },
};

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const methode = opts.method || 'GET';
  appels.push([methode, u.pathname]);
  const ok = (d) => ({ ok: true, status: 200, text: async () => JSON.stringify(d) });

  if (u.pathname.endsWith('/events') && methode === 'GET') {
    const props = u.searchParams.getAll('privateExtendedProperty');
    const [tMin, tMax] = [u.searchParams.get('timeMin'), u.searchParams.get('timeMax')];
    const items = [...agenda.values()].filter((ev) => {
      const p = ev.extendedProperties?.private || {};
      if (!props.every((f) => { const [k, v] = f.split('='); return p[k] === v; })) return false;
      const d = p.p2a_date || p.ancien_date;
      return `${d}T00:00:00Z` >= tMin && `${d}T00:00:00Z` <= tMax;
    });
    return ok({ items });
  }
  if (u.pathname.endsWith('/events') && methode === 'POST') {
    const ev = { ...JSON.parse(opts.body), id: `ev${prochainId++}` };
    agenda.set(ev.id, ev);
    return ok(ev);
  }
  const m = u.pathname.match(/\/events\/([^/]+)$/);
  if (m && methode === 'PUT') {
    const ev = { ...JSON.parse(opts.body), id: m[1] };
    agenda.set(ev.id, ev);
    return ok(ev);
  }
  if (m && methode === 'DELETE') {
    agenda.delete(m[1]);
    return { ok: true, status: 204, text: async () => '' };
  }
  return { ok: false, status: 404, text: async () => '{}' };
};

// --- Données de test (génériques, aucune donnée réelle) ---------------------
const config = {
  calendarId: 'test@group.calendar.google.com', tag: 'TAG', couleur: '9',
  fuseau: 'Europe/Paris', joursOffEnJourneeEntiere: false,
  heritagePrefixe: 'ancien',
};
// Horaires volontairement fictifs : ils exercent la règle (quatre tours, dont
// deux partageant un même créneau qui passe minuit) sans reproduire aucune
// table de codes réelle.
const table = new TableCodes({
  postes: { 1: { debut: '06:00', fin: '14:00', libelle: 'Tour 1' },
            2: { debut: '14:00', fin: '22:00', libelle: 'Tour 2' },
            3: { debut: '22:00', fin: '06:00', libelle: 'Tour 3' },
            4: { debut: '22:00', fin: '06:00', libelle: 'Tour 4' } },
  codes: { OFF: { off: true, libelle: 'Repos' } },
});
const planning = {
  personne: 'NOM PRENOM', edition: '01/01/2030',
  debut: '2030-01-01', fin: '2030-01-05',
  jours: [
    { date: '2030-01-01', code: '101' }, { date: '2030-01-02', code: '202' },
    { date: '2030-01-03', code: 'OFF' }, { date: '2030-01-04', code: '323MB' },
    { date: '2030-01-05', code: '101' },
  ],
};

const compte = (actions) => {
  const c = actions.reduce((a, x) => (a[x.genre] = (a[x.genre] || 0) + 1, a), {});
  return Object.fromEntries(Object.entries(c).sort());   // ordre stable
};
let echecs = 0;
const verifie = (nom, reel, attendu) => {
  const a = JSON.stringify(reel), b = JSON.stringify(attendu);
  const bon = a === b;
  if (!bon) echecs++;
  console.log(`  ${bon ? 'ok  ' : 'ECHEC'} ${nom} -> ${a}${bon ? '' : `  (attendu ${b})`}`);
};

await gcal.autoriser('faux-client-id');

// 0. Règle des postes : c'est le TROISIÈME chiffre qui porte l'horaire, quel
//    que soit le suffixe de variante. Les codes qui ne sont pas « 3 chiffres
//    + lettres » ne doivent surtout pas être devinés.
const creneau = (code) => {
  const c = table.resoudre(code);
  return c === null ? null : (c.off ? 'off' : `${c.debut}-${c.fin}${c.lendemain ? '+1' : ''}`);
};
for (const [code, attendu] of [
  ['101', '06:00-14:00'],          // sans suffixe
  ['121D', '06:00-14:00'],         // suffixe d'une lettre
  ['422B', '14:00-22:00'],
  ['323MB', '22:00-06:00+1'],        // suffixe de deux lettres
  ['902FD', '14:00-22:00'],
  ['101*', '06:00-14:00'],         // « * » final ignoré
  ['124', '22:00-06:00+1'],          // tours 3 et 4 : deux nuits, même horaire
  ['D01', null],                   // commence par une lettre : pas un poste
  ['F03', null],
  ['1012', null],                  // quatre chiffres : position ambiguë
  ['ABSA', null],
]) {
  verifie(`poste ${code}`, creneau(code), attendu);
}

// 1. Agenda vide : 4 jours travaillés sur 5
let actions = await gcal.preparer(planning, config, table, 'test.pdf');
verifie('agenda vide', compte(actions), { creer: 4 });

// 2. Le poste de nuit se termine bien le lendemain
const nuit = actions.find((a) => a.code === '323MB').corps;
verifie('poste de nuit', [nuit.start.dateTime, nuit.end.dateTime, nuit.start.timeZone],
        ['2030-01-04T22:00:00', '2030-01-05T06:00:00', 'Europe/Paris']);

// 3. Application, puis resynchronisation : rien à faire
await gcal.appliquer(actions, config);
verifie('après application', agenda.size, 4);
actions = await gcal.preparer(planning, config, table, 'test.pdf');
verifie('déjà synchronisé', compte(actions), { inchange: 4 });

// 4. Créneau modifié dans le PDF -> une seule mise à jour
const modifie = { ...planning, jours: planning.jours.map((j) =>
  j.date === '2030-01-02' ? { ...j, code: '101' } : j) };
actions = await gcal.preparer(modifie, config, table, 'test.pdf');
verifie('un créneau changé', compte(actions), { inchange: 3, mettreAJour: 1 });

// 5. Un jour devenu « repos » -> l'événement devenu orphelin est supprimé
const repos = { ...planning, jours: planning.jours.map((j) =>
  j.date === '2030-01-01' ? { ...j, code: 'OFF' } : j) };
actions = await gcal.preparer(repos, config, table, 'test.pdf');
verifie('jour passé en repos', compte(actions), { inchange: 3, supprimer: 1 });

// 6. Un créneau hors période (quinzaine suivante) ne doit jamais être touché
agenda.set('ev_hors', { id: 'ev_hors', summary: 'TAG 101 — Tour 1',
  extendedProperties: { private: { pdf2agenda: '1',
    p2a_personne: gcal.slug(planning.personne), p2a_date: '2030-01-06',
    p2a_code: '101', p2a_sig: 'x' } } });
actions = await gcal.preparer(planning, config, table, 'test.pdf');
verifie('hors période préservé', compte(actions), { inchange: 4 });

// 7. Événement hérité de la version Python doublonnant un créneau déjà posé :
//    l'actuel est conservé, l'hérité retiré — pas de doublon dans l'agenda.
const herite = (date) => ({ id: `ev_herite_${date}`, summary: 'ANCIEN 101 — Tour 1',
  extendedProperties: { private: { ancien2planning: '1',
    ancien_personne: gcal.slug(planning.personne), ancien_date: date,
    ancien_code: '101' } } });
agenda.set('ev_herite_2030-01-01', herite('2030-01-01'));
actions = await gcal.preparer(planning, config, table, 'test.pdf');
verifie('doublon hérité retiré', compte(actions), { inchange: 4, supprimer: 1 });
agenda.delete('ev_herite_2030-01-01');

// 7b. Migration réelle : seuls des événements hérités existent -> repris en
//     place, sans créer de doublon.
const sauvegarde = new Map(agenda);
agenda = new Map([['ev_hors', sauvegarde.get('ev_hors')]]);
for (const j of planning.jours) if (j.code !== 'OFF') agenda.set(`ev_herite_${j.date}`, herite(j.date));
actions = await gcal.preparer(planning, config, table, 'test.pdf');
verifie('migration depuis Python', compte(actions), { mettreAJour: 4 });
await gcal.appliquer(actions, config);
verifie('aucun doublon créé', agenda.size, 5);   // 4 créneaux + le hors-période
agenda = sauvegarde;

// 8. Revert : borné à la période du PDF
let revert = await gcal.preparerRevert(planning, config);
verifie('revert', compte(revert), { supprimer: 4 });
await gcal.appliquer(revert, config);
verifie('reste le hors-période', [...agenda.keys()], ['ev_hors']);

// 9. Un code non résolu arrête tout plutôt que d'être ignoré
try {
  await gcal.preparer({ ...planning, jours: [{ date: '2030-01-01', code: 'ZZZ' }] },
                      config, table, 'test.pdf');
  verifie('code inconnu', 'aucune erreur', 'une erreur');
} catch (e) {
  verifie('code inconnu rejeté', e instanceof gcal.ErreurGCal, true);
}

console.log(echecs ? `\n${echecs} échec(s).` : '\nTous les scénarios passent.');
process.exit(echecs ? 1 : 0);
