/**
 * Synchronisation vers Google Calendar, en appels REST directs.
 *
 * Les événements posés par l'application portent des propriétés privées
 * (invisibles dans l'interface Google). C'est cette marque, et non le titre ni
 * la date, qui sert à les retrouver : les événements personnels de l'utilisateur
 * ne sont donc jamais touchés, même le même jour.
 */

const API = 'https://www.googleapis.com/calendar/v3';

export const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];

const MARQUEUR = 'pdf2agenda';

/**
 * Marque éventuellement posée par une version antérieure du programme, lue pour
 * reprendre ses événements sans créer de doublons — jamais écrite. Le préfixe
 * est un réglage local : rien de propre à un utilisateur n'est inscrit ici.
 * Un préfixe « xyz » désigne la marque « xyz2planning » et les propriétés
 * « xyz_personne », « xyz_date », « xyz_code ».
 */
const heritage = (prefixe) => (prefixe ? {
  marqueur: `${prefixe}2planning`,
  personne: `${prefixe}_personne`,
  date: `${prefixe}_date`,
  code: `${prefixe}_code`,
} : null);

export class ErreurGCal extends Error {}

export const slug = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** Empreinte du contenu significatif, pour ne mettre à jour que le nécessaire. */
function signature(corps) {
  const s = [corps.summary, JSON.stringify(corps.start), JSON.stringify(corps.end),
             corps.colorId || '', corps.description || ''].join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const decalerIso = (iso, jours) => {
  const [a, m, j] = iso.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, j + jours)).toISOString().slice(0, 10);
};

// ---------------------------------------------------------------- jeton OAuth

let jeton = null;
let clientJeton = null;

export const connecte = () => !!jeton;
export const oublierJeton = () => { jeton = null; };

/**
 * Demande un jeton d'accès. Il vit en mémoire, dure environ une heure et n'est
 * jamais écrit sur le disque : un accès au stockage du navigateur ne donne donc
 * aucun accès à l'agenda.
 */
export function autoriser(clientId, { silencieux = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) {
      reject(new ErreurGCal(
        "Bibliothèque Google non chargée. Vérifie ta connexion internet."));
      return;
    }
    if (!clientJeton || clientJeton._clientId !== clientId) {
      clientJeton = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPES.join(' '),
        callback: () => {},
      });
      clientJeton._clientId = clientId;
    }
    clientJeton.callback = (reponse) => {
      if (reponse.error) {
        reject(new ErreurGCal(
          reponse.error === 'access_denied'
            ? "Autorisation refusée."
            : `Autorisation impossible : ${reponse.error}`));
        return;
      }
      jeton = reponse.access_token;
      resolve(jeton);
    };
    clientJeton.error_callback = (e) =>
      reject(new ErreurGCal(`Autorisation interrompue (${e?.type || 'inconnu'}).`));
    clientJeton.requestAccessToken({ prompt: silencieux ? '' : 'consent' });
  });
}

async function appel(chemin, { methode = 'GET', corps, params } = {}) {
  if (!jeton) throw new ErreurGCal("Non autorisé — clique sur « Connecter ».");
  const url = new URL(API + chemin);
  for (const [k, v] of Object.entries(params || {})) {
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const r = await fetch(url, {
    method: methode,
    headers: {
      Authorization: `Bearer ${jeton}`,
      ...(corps ? { 'Content-Type': 'application/json' } : {}),
    },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  if (r.status === 401) {
    jeton = null;
    throw new ErreurGCal("Session Google expirée — reconnecte-toi.");
  }
  if (r.status === 204 || r.status === 200 && methode === 'DELETE') return null;
  const texte = await r.text();
  const donnees = texte ? JSON.parse(texte) : null;
  if (!r.ok) {
    throw new ErreurGCal(donnees?.error?.message || `Erreur Google (HTTP ${r.status}).`);
  }
  return donnees;
}

export async function listerAgendas() {
  const agendas = [];
  let page;
  do {
    const r = await appel('/users/me/calendarList', { params: { maxResults: 250, pageToken: page } });
    agendas.push(...(r.items || []));
    page = r.nextPageToken;
  } while (page);
  const ordre = { owner: 0, writer: 1, reader: 2, freeBusyReader: 3 };
  agendas.sort((a, b) =>
    (ordre[a.accessRole] ?? 9) - (ordre[b.accessRole] ?? 9) ||
    (a.summary || '').localeCompare(b.summary || ''));
  return agendas;
}

export const inscriptible = (a) => a.accessRole === 'owner' || a.accessRole === 'writer';

// ------------------------------------------------------------------ événements

function corpsEvenement(jour, creneau, config, description) {
  const commun = { summary: null, description };
  if (creneau.off) {
    if (!config.joursOffEnJourneeEntiere) return null;
    return {
      ...commun,
      start: { date: jour },
      end: { date: decalerIso(jour, 1) },
      transparency: 'transparent',
    };
  }
  // La date-heure est envoyée sans décalage UTC : le champ `timeZone` lève
  // l'ambiguïté côté Google, ce qui évite tout calcul de fuseau ici et reste
  // juste au passage à l'heure d'été.
  const finJour = creneau.lendemain ? decalerIso(jour, 1) : jour;
  return {
    ...commun,
    start: { dateTime: `${jour}T${creneau.debut}:00`, timeZone: config.fuseau },
    end: { dateTime: `${finJour}T${creneau.fin}:00`, timeZone: config.fuseau },
  };
}

async function listerMarques(config, personne, debut, fin) {
  // La fenêtre déborde pour rattraper un poste de nuit qui finit après minuit ;
  // on filtre ensuite sur la période réelle du PDF, sinon les créneaux de la
  // quinzaine voisine seraient pris pour des orphelins et supprimés.
  const params = {
    timeMin: `${decalerIso(debut, -1)}T00:00:00Z`,
    timeMax: `${decalerIso(fin, 3)}T00:00:00Z`,
    singleEvents: true,
    showDeleted: false,
    maxResults: 250,
  };
  const p = slug(personne);
  const h = heritage(config.heritagePrefixe);
  const requetes = [[`${MARQUEUR}=1`, `p2a_personne=${p}`]];
  if (h) requetes.push([`${h.marqueur}=1`, `${h.personne}=${p}`]);

  const parDate = new Map();
  const vus = new Set();
  for (const privateExtendedProperty of requetes) {
    let page;
    do {
      const r = await appel(`/calendars/${encodeURIComponent(config.calendarId)}/events`,
        { params: { ...params, privateExtendedProperty, pageToken: page } });
      for (const ev of r.items || []) {
        const prive = ev.extendedProperties?.private || {};
        const date = prive.p2a_date || (h && prive[h.date]);
        if (!date || date < debut || date > fin) continue;
        if (vus.has(ev.id)) continue;
        vus.add(ev.id);
        if (!parDate.has(date)) parDate.set(date, []);
        parDate.get(date).push({
          id: ev.id,
          summary: ev.summary || '',
          code: prive.p2a_code || (h && prive[h.code]) || '?',
          sig: prive.p2a_sig ?? null,
        });
      }
      page = r.nextPageToken;
    } while (page);
  }
  return parDate;
}

/** Compare le planning du PDF à l'agenda et renvoie la liste des actions. */
export async function preparer(planning, config, table, source) {
  const description =
    `Importé depuis « ${source} »` +
    (planning.edition ? ` (édition du ${planning.edition})` : '') +
    `\n${planning.personne}`;

  const voulu = new Map();
  for (const jour of planning.jours) {
    const creneau = table.resoudre(jour.code);
    if (!creneau) throw new ErreurGCal(`Code non résolu : ${jour.code} (${jour.date})`);
    const corps = corpsEvenement(jour.date, creneau, config, description);
    if (!corps) continue;
    corps.summary = table.titre(creneau, config.tag);
    if (config.couleur) corps.colorId = String(config.couleur);
    corps.extendedProperties = {
      private: {
        [MARQUEUR]: '1',
        p2a_personne: slug(planning.personne),
        p2a_date: jour.date,
        p2a_code: jour.code,
        p2a_sig: signature(corps),
      },
    };
    voulu.set(jour.date, { corps, code: jour.code });
  }

  const existants = await listerMarques(config, planning.personne, planning.debut, planning.fin);
  const actions = [];

  for (const [date, { corps, code }] of [...voulu].sort()) {
    const precedents = existants.get(date) || [];
    existants.delete(date);
    if (!precedents.length) {
      actions.push({ genre: 'creer', date, code, resume: corps.summary, corps });
      continue;
    }
    const [garde, ...doublons] = precedents;
    const identique = garde.sig === corps.extendedProperties.private.p2a_sig;
    actions.push({
      genre: identique ? 'inchange' : 'majSuppr',
      date, code, resume: corps.summary, corps, id: garde.id,
    });
    for (const d of doublons) {
      actions.push({ genre: 'supprimer', date, code, resume: 'doublon', id: d.id });
    }
  }

  for (const [date, evenements] of [...existants].sort()) {
    for (const ev of evenements) {
      actions.push({ genre: 'supprimer', date, code: ev.code, resume: ev.summary, id: ev.id });
    }
  }

  actions.forEach((a) => { if (a.genre === 'majSuppr') a.genre = 'mettreAJour'; });
  actions.sort((a, b) => a.date.localeCompare(b.date) || a.genre.localeCompare(b.genre));
  return actions;
}

/** Actions de suppression de tout ce que l'app a posé sur la période du PDF. */
export async function preparerRevert(planning, config) {
  const existants = await listerMarques(config, planning.personne, planning.debut, planning.fin);
  const actions = [];
  for (const [date, evenements] of [...existants].sort()) {
    for (const ev of evenements) {
      actions.push({ genre: 'supprimer', date, code: ev.code, resume: ev.summary, id: ev.id });
    }
  }
  return actions;
}

export async function appliquer(actions, config, progression = () => {}) {
  const cal = encodeURIComponent(config.calendarId);
  const aFaire = actions.filter((a) => a.genre !== 'inchange');
  let n = 0;
  for (const a of aFaire) {
    if (a.genre === 'creer') {
      await appel(`/calendars/${cal}/events`, { methode: 'POST', corps: a.corps });
    } else if (a.genre === 'mettreAJour') {
      await appel(`/calendars/${cal}/events/${a.id}`, { methode: 'PUT', corps: a.corps });
    } else if (a.genre === 'supprimer') {
      await appel(`/calendars/${cal}/events/${a.id}`, { methode: 'DELETE' });
    }
    progression(++n, aFaire.length, a);
  }
  return n;
}
