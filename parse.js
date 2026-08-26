/**
 * Extraction d'une ligne de planning depuis un PDF tabulaire.
 *
 * Le découpage en colonnes s'appuie sur la position horizontale des en-têtes
 * de date, pas sur un rendu texte : un décalage de colonne donnerait des
 * créneaux faux en silence. Chaque cellule est rattachée à la colonne dont
 * elle est la plus proche en x, et l'écart doit rester sous la demi-colonne.
 */

const MOIS = {
  janv: 1, fevr: 2, mars: 3, avr: 4, mai: 5, juin: 6,
  juil: 7, aout: 8, sept: 9, oct: 10, nov: 11, dec: 12,
};

const RE_ENTETE_DATE = /^(\d{1,2})-([A-Za-zÀ-ÿ]+)\.?$/;
const RE_PERIODE = /Du\s*(\d{2})\/(\d{2})\/(\d{4})\s*au\s*(\d{2})\/(\d{2})\/(\d{4})/;
const RE_DATE = /\b(\d{2}\/\d{2}\/\d{4})\b/g;

const TOLERANCE_COLONNE = 0.45;
const TOLERANCE_LIGNE = 3;

export class ErreurPDF extends Error {}

const sansAccent = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

export const normaliseNom = (s) =>
  sansAccent(s).toUpperCase().replace(/\s+/g, ' ').trim()
    .replace(/^(?:[A-Z] )+/, '').trim();

function moisDepuisAbrev(abrev) {
  const cle = sansAccent(abrev).toLowerCase().replace(/\.$/, '');
  for (const [prefixe, num] of Object.entries(MOIS)) {
    if (cle.startsWith(prefixe)) return num;
  }
  throw new ErreurPDF(`Mois non reconnu dans l'en-tête : « ${abrev} »`);
}

/** Regroupe les fragments de texte en lignes visuelles (même y à ~3pt près). */
function grouperEnLignes(items) {
  const lignes = [];
  for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const derniere = lignes[lignes.length - 1];
    if (derniere && Math.abs(derniere[0].y - it.y) <= TOLERANCE_LIGNE) derniere.push(it);
    else lignes.push([it]);
  }
  for (const l of lignes) l.sort((a, b) => a.x - b.x);
  return lignes;
}

const estEnteteDate = (it) => RE_ENTETE_DATE.test(it.t);

function periode(lignes) {
  for (const l of lignes) {
    const m = RE_PERIODE.exec(l.map((i) => i.t).join(' '));
    if (m) return { annee: +m[3], mois: +m[2] };
  }
  throw new ErreurPDF(
    "Ligne de période « Du JJ/MM/AAAA au JJ/MM/AAAA » introuvable. " +
    "Ce PDF n'a pas la structure attendue.");
}

function edition(lignes) {
  for (const l of lignes) {
    const texte = l.map((i) => i.t).join(' ');
    const p = RE_PERIODE.exec(texte);
    const bornes = new Set(p ? [`${p[1]}/${p[2]}/${p[3]}`, `${p[4]}/${p[5]}/${p[6]}`] : []);
    for (const m of texte.matchAll(RE_DATE)) if (!bornes.has(m[1])) return m[1];
  }
  return null;
}

/** Colonnes du tableau : centre en x et date, déduits de la ligne d'en-tête. */
function colonnesDates(lignes, anneeRef, moisRef) {
  for (const l of lignes) {
    const entetes = l.filter(estEnteteDate);
    if (entetes.length < 7) continue;

    const cols = [];
    let annee = anneeRef;
    let moisPrecedent = null;
    for (const it of entetes) {
      const m = RE_ENTETE_DATE.exec(it.t);
      const jour = +m[1];
      const mois = moisDepuisAbrev(m[2]);
      // Une quinzaine peut chevaucher deux mois, voire deux années.
      if (moisPrecedent !== null && mois < moisPrecedent) annee += 1;
      else if (moisPrecedent === null && mois < moisRef) annee += 1;
      moisPrecedent = mois;
      const iso = `${annee}-${String(mois).padStart(2, '0')}-${String(jour).padStart(2, '0')}`;
      cols.push({ mid: it.x + it.w / 2, date: iso });
    }
    return cols;
  }
  throw new ErreurPDF(
    "Ligne d'en-tête des dates introuvable (attendu des cellules type « 1-sept. »).");
}

async function lireItems(donnees, pdfjs) {
  const doc = await pdfjs.getDocument({ data: donnees, useSystemFonts: true }).promise;
  try {
    if (doc.numPages < 1) throw new ErreurPDF('PDF vide.');
    const page = await doc.getPage(1);
    const contenu = await page.getTextContent();
    return contenu.items
      .filter((i) => i.str && i.str.trim())
      .map((i) => ({ t: i.str.trim(), x: i.transform[4], y: i.transform[5], w: i.width }));
  } finally {
    doc.destroy();
  }
}

/** Structure du tableau, réutilisée pour lister les noms et extraire une ligne. */
async function analyser(donnees, pdfjs) {
  const items = await lireItems(donnees, pdfjs);
  const lignes = grouperEnLignes(items);
  const { annee, mois } = periode(lignes);
  const cols = colonnesDates(lignes, annee, mois);
  const pas = (cols[cols.length - 1].mid - cols[0].mid) / (cols.length - 1);
  return { lignes, cols, xMin: cols[0].mid - pas / 2, tolerance: pas * TOLERANCE_COLONNE,
           edition: edition(lignes) };
}

const nomDeLigne = (ligne, xMin) =>
  normaliseNom(ligne.filter((i) => i.x + i.w < xMin).map((i) => i.t).join(' '));

/**
 * Noms présents dans la colonne de gauche du tableau.
 * Sert à faire choisir son nom dans une liste plutôt qu'à le saisir.
 */
export async function listerPersonnes(donnees, pdfjs) {
  const { lignes, xMin } = await analyser(donnees, pdfjs);
  const noms = [];
  for (const l of lignes) {
    const nom = nomDeLigne(l, xMin);
    // Une ligne d'agent porte un nom d'au moins deux mots et des cellules à droite.
    if (nom.split(' ').length >= 2 && l.some((i) => i.x + i.w / 2 >= xMin)) noms.push(nom);
  }
  return [...new Set(noms)];
}

/** Extrait le planning d'une personne : { personne, edition, jours: [{date, code}] }. */
export async function extraire(donnees, personne, pdfjs) {
  const { lignes, cols, xMin, tolerance, edition: ed } = await analyser(donnees, pdfjs);
  const cible = normaliseNom(personne);

  const ligne = lignes.find((l) => nomDeLigne(l, xMin) === cible);
  if (!ligne) {
    const dispo = lignes.map((l) => nomDeLigne(l, xMin))
      .filter((n) => n.split(' ').length >= 2);
    throw new ErreurPDF(
      `Ligne « ${personne} » introuvable dans ce PDF. ` +
      `${dispo.length} lignes de personnel lues.`);
  }

  const parColonne = cols.map(() => []);
  const orphelins = [];
  for (const it of ligne.filter((i) => i.x + i.w / 2 >= xMin)) {
    const mid = it.x + it.w / 2;
    let best = 0;
    cols.forEach((c, k) => {
      if (Math.abs(mid - c.mid) < Math.abs(mid - cols[best].mid)) best = k;
    });
    if (Math.abs(mid - cols[best].mid) > tolerance) orphelins.push(it.t);
    else parColonne[best].push(it.t);
  }

  if (orphelins.length) {
    throw new ErreurPDF(
      `Cellules non rattachables à une colonne : ${orphelins.join(', ')}. ` +
      `La mise en page du PDF a peut-être changé.`);
  }

  const problemes = [];
  const jours = [];
  cols.forEach((c, i) => {
    const v = parColonne[i];
    if (v.length !== 1) problemes.push(`${c.date} : ${v.length} valeur(s)`);
    else jours.push({ date: c.date, code: v[0] });
  });
  if (problemes.length) {
    throw new ErreurPDF(`Colonnes ambiguës : ${problemes.join(' ; ')}`);
  }

  return { personne: cible, edition: ed, jours,
           debut: jours[0].date, fin: jours[jours.length - 1].date };
}
