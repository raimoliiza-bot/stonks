/**
 * PORTFELL — andmeserver äpi jaoks (Apps Script web-app) ja Google Sheeti loogika ühes failis.
 *
 * Paigaldus (uus fail):
 *   1. Tee tühi Google Sheet → Extensions → Apps Script → kleebi kogu see fail.
 *   2. Pane allpool PF_PIN (muidu saab äpist ainult vaadata, tehinguid lisada ei saa).
 *   3. Käivita PF_seadista (ülevalt rippmenüüst) ja luba ligipääs.
 *   4. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone. Kopeeri link äppi (Seaded).
 *   Koodi muutes: Manage deployments → pliiats → New version (mitte New deployment, muidu muutub link).
 *
 * Lugemine on avatud kõigile, kellel on link (nagu vanas vaates). Tehingu lisamine nõuab PIN-i.
 */

var PF_PIN = '';            // ← pane siia oma PIN (vähemalt 4 märki)
var PF_PIN_KATSEID = 5;     // pärast nii mitut vale PIN-i on lisamine 15 minutiks lukus
var PF_VARSKENDUS_VAHE = 120;   // sekundit: äpi "Värskenda" ei küsi Yahoolt hindu tihemini

function doGet(e) {
  var p = (e && e.parameter) || {};
  var cb = p.cb || p.callback;
  if (cb) {                                                     // JSONP – varutee, kui fetch ei õnnestu
    if (!/^[A-Za-z0-9_]{1,40}$/.test(cb)) {
      return ContentService.createTextOutput('// vigane callback').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return ContentService.createTextOutput(cb + '(' + JSON.stringify(PF_api(p.a || 'andmed', p.q || '{}')) + ')')
                         .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  if (p.a) {                                                    // JSON – allalaetud HTML-faili põhitee (fetch, ilma küpsisteta)
    return ContentService.createTextOutput(JSON.stringify(PF_api(p.a, p.q || '{}'))).setMimeType(ContentService.MimeType.JSON);
  }
  try {                                                         // kui projektis on ka HTML-fail "live", näidatakse lehte otse
    return HtmlService.createHtmlOutputFromFile('live')
                      .setTitle('Portfell')
                      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } catch (err) {
    return ContentService.createTextOutput('Portfelli andmeserver töötab. Kleebi see link äpis vahekaardile Seaded.');
  }
}

/** Ainus sisenemispunkt. Tagastab alati objekti; vea korral {viga: '...'}. */
function PF_api(tegevus, q) {
  try {
    if (typeof q === 'string') q = JSON.parse(q || '{}');
    q = q || {};
    if (tegevus === 'andmed') return PF_andmed_(q.p);
    if (tegevus === 'varskenda') {
      var viimane = PF_viimaneUuendus_(PF_loeHinnad_());
      if (!viimane || (Date.now() - viimane.getTime()) / 1000 > PF_VARSKENDUS_VAHE) PF_varskendaHinnad(true);
      return PF_andmed_(q.p);
    }
    if (tegevus === 'vara') {
      PF_kontrolliPin_(q.pin);
      PF_salvestaVara_(q);
      var dv = PF_andmed_(q.p);
      dv.teade = 'Salvestatud';
      return dv;
    }
    if (tegevus === 'varaKustuta') {
      PF_kontrolliPin_(q.pin);
      PF_kustutaVara_(q.vara, q.p);
      var dk = PF_andmed_(q.p);
      dk.teade = 'Kustutatud';
      return dk;
    }
    if (tegevus === 'konto') {
      PF_kontrolliPin_(q.pin);
      var uus = PF_lisaKonto_(q.nimi);
      var dn = PF_andmed_(uus);
      dn.teade = 'Konto ' + uus + ' lisatud';
      return dn;
    }
    if (tegevus === 'tehing') {
      PF_kontrolliPin_(q.pin);
      var tt = PF_puhastaTehing_(q.t);
      tt.portfell = PF_konto_(tt.portfell);
      var teade = PF_lisaTehing(tt);
      var d = PF_andmed_(tt.portfell);
      d.teade = teade;
      return d;
    }
    throw new Error('Tundmatu tegevus');
  } catch (err) {
    return { viga: String((err && err.message) || err) };
  }
}

function PF_kontrolliPin_(pin) {
  if (!PF_PIN || String(PF_PIN).length < 4) throw new Error('PIN on määramata – lisa see faili liveapi.gs algusesse');
  var cache = CacheService.getScriptCache(), vigu = Number(cache.get('PF_pin_vead') || 0);
  if (vigu >= PF_PIN_KATSEID) throw new Error('Liiga palju valesid PIN-e. Proovi 15 minuti pärast uuesti.');
  if (String(pin || '') !== String(PF_PIN)) {
    cache.put('PF_pin_vead', String(vigu + 1), 900);
    throw new Error('Vale PIN');
  }
  cache.remove('PF_pin_vead');
}

var PF_VARA_PAIS = ['Portfell', 'Vara', 'Väärtus €', 'Kogus', 'Ostuhind € (ühiku kohta)', 'Ticker'];

function PF_varaLeht_() {
  var sh = PF_leht_(PF_CFG.lehed.seaded);
  sh.getRange(1, 1, 1, PF_VARA_PAIS.length).setValues([PF_VARA_PAIS]).setFontWeight('bold');
  var viimane = sh.getLastRow();
  return { sh: sh, read: viimane >= 2 ? sh.getRange(2, 1, viimane - 1, PF_VARA_PAIS.length).getValues() : [] };
}

/**
 * Muu vara lehel Seaded: muudab olemasolevat rida või lisab uue. Kaks liiki:
 *   summa   – v: väärtus eurodes (pension, korter jms), uuendatakse käsitsi
 *   kogus   – kogus + ost (ostuhind eurodes ühiku kohta) + ticker (vaikimisi GC=F ehk kuld untsides);
 *             väärtus arvutatakse turuhinnast
 */
function PF_salvestaVara_(q) {
  var portfell = PF_konto_(q.p);
  var vara = String(q.vara || '').replace(/^[=+\-@\s]+/, '').trim().slice(0, 30);
  if (!vara) throw new Error('Vara nimi puudub');
  var rida, kogus = PF_num_(q.kogus);
  if (kogus > 0) {
    var ost = PF_num_(q.ost), ticker = String(q.ticker || 'GC=F').trim().toUpperCase();
    if (!(ost >= 0)) throw new Error('Sisesta ostuhind eurodes ühiku kohta');
    if (!/^[A-Z0-9^][A-Z0-9.\-=^]{0,19}$/.test(ticker)) throw new Error('Vigane ticker');
    var h = PF_loeHinnad_()[ticker];
    if (!h || !(h.hind > 0)) throw new Error('Tickeril ' + ticker + ' pole lehel Hinnad hinda');
    rida = [portfell, vara, '', kogus, ost, ticker];
  } else {
    var vaartus = PF_num_(q.v);
    if (!(vaartus >= 0)) throw new Error('Sisesta väärtus eurodes');
    rida = [portfell, vara, vaartus, '', '', ''];
  }
  var L = PF_varaLeht_();
  for (var i = 0; i < L.read.length; i++) {
    if (String(L.read[i][0]).trim() === portfell && String(L.read[i][1]).trim().toLowerCase() === vara.toLowerCase()) {
      rida[1] = String(L.read[i][1]).trim();
      L.sh.getRange(i + 2, 1, 1, rida.length).setValues([rida]);
      return;
    }
  }
  L.sh.appendRow(rida);
}

function PF_kustutaVara_(vara, konto) {
  var portfell = PF_konto_(konto), L = PF_varaLeht_(), alles = [], leitud = false;
  vara = String(vara || '').trim().toLowerCase();
  for (var i = 0; i < L.read.length; i++) {
    if (!leitud && String(L.read[i][0]).trim() === portfell && String(L.read[i][1]).trim().toLowerCase() === vara) { leitud = true; continue; }
    alles.push(L.read[i]);
  }
  if (!leitud) throw new Error('Sellist vara ei leitud');
  L.sh.getRange(2, 1, L.read.length, PF_VARA_PAIS.length).clearContent();
  if (alles.length) L.sh.getRange(2, 1, alles.length, PF_VARA_PAIS.length).setValues(alles);
}

/** Uus konto samas failis. Nimi jääb meelde ka siis, kui kontol pole veel ühtegi tehingut. */
function PF_lisaKonto_(nimi) {
  nimi = String(nimi || '').trim();
  if (!/^[A-Za-zÀ-ž0-9][A-Za-zÀ-ž0-9 \-]{0,19}$/.test(nimi)) throw new Error('Konto nimi võib sisaldada tähti, numbreid, tühikut ja sidekriipsu (kuni 20 märki)');
  if (nimi.toLowerCase() === 'koos') throw new Error('Nimi „Koos“ on koondvaate jaoks kinni');
  var pf = PF_portfellid_();
  for (var i = 0; i < pf.length; i++) if (pf[i].toLowerCase() === nimi.toLowerCase()) throw new Error('Selline konto on juba olemas');
  var prop = PropertiesService.getScriptProperties(), k = [];
  try { k = JSON.parse(prop.getProperty('PF_KONTOD') || '[]'); } catch (e) {}
  if (!PF_loeTehingud_().length && pf.length === 1) k.push(pf[0]);   // tühja faili vaikimisi konto jääb esimeseks
  k.push(nimi);
  prop.setProperty('PF_KONTOD', JSON.stringify(k));
  return nimi;
}

/** Mitme konto seis kokku: sama ticker liidetakse üheks reaks (kogus ja soetus summana, ostuhind kaalutud keskmine). */
function PF_seisKoos_(nimed, hinnad, osad) {
  if (nimed.length === 1) { var yks = PF_seis_(nimed[0], hinnad); osad[nimed[0]] = yks; return yks; }
  var kokku = { read: [], raha: 0, aktsiad: 0, kokku: 0, netoSisse: 0, realiseeritud: 0, dividendid: 0, tasud: 0, tana: 0, puudu: [] }, rida = {};
  for (var i = 0; i < nimed.length; i++) {
    var s = PF_seis_(nimed[i], hinnad); osad[nimed[i]] = s;
    kokku.raha += s.raha; kokku.aktsiad += s.aktsiad; kokku.kokku += s.kokku; kokku.netoSisse += s.netoSisse;
    kokku.realiseeritud += s.realiseeritud; kokku.dividendid += s.dividendid; kokku.tasud += s.tasud; kokku.tana += s.tana;
    for (var p = 0; p < s.puudu.length; p++) if (kokku.puudu.indexOf(s.puudu[p]) < 0) kokku.puudu.push(s.puudu[p]);
    for (var j = 0; j < s.read.length; j++) {
      var r = s.read[j], m = rida[r.ticker];
      if (!m) {
        m = rida[r.ticker] = { ticker: r.ticker, kuva: r.kuva, nimi: r.nimi, valuuta: r.valuuta, kogus: 0, kuluOma: 0, soetus: 0, hind: r.hind,
                               vaartus: r.vaartus === null ? null : 0, kasum: null, kasumPr: null, tana: null, tanaPr: r.tanaPr,
                               nadalPr: r.nadalPr, aastaPr: r.aastaPr, osad: [] };
        kokku.read.push(m);
      }
      m.kogus += r.kogus; m.kuluOma += r.ostuhind * r.kogus; m.soetus += r.soetus;
      if (r.vaartus !== null && m.vaartus !== null) m.vaartus += r.vaartus;
      if (r.tana !== null) m.tana = (m.tana || 0) + r.tana;
      m.osad.push({ n: nimed[i], kogus: r.kogus });
    }
  }
  for (var k = 0; k < kokku.read.length; k++) {
    var x = kokku.read[k];
    x.ostuhind = x.kogus > 0 ? x.kuluOma / x.kogus : 0;
    if (x.vaartus !== null) { x.kasum = x.vaartus - x.soetus; x.kasumPr = x.soetus > 0 ? x.kasum / x.soetus : null; }
  }
  kokku.read.sort(function (a, b) { return (b.vaartus || 0) - (a.vaartus || 0); });
  return kokku;
}

/** Lubab läbi ainult oodatud väljad ja ei lase lahtrisse valemit kirjutada. */
function PF_puhastaTehing_(t) {
  if (!t) throw new Error('Tehing puudub');
  var ticker = String(t.ticker || '').trim().toUpperCase();
  if (ticker && !/^[A-Z0-9^][A-Z0-9.\-=^]{0,19}$/.test(ticker)) throw new Error('Vigane ticker: ' + ticker);
  var kuupaev = String(t.kuupaev || '');
  if (kuupaev && !/^\d{4}-\d{2}-\d{2}$/.test(kuupaev)) throw new Error('Vigane kuupäev');
  if (kuupaev && new Date(kuupaev).getTime() > Date.now() + 86400000) throw new Error('Kuupäev on tulevikus');
  if (t.tyyp === 'Korrektsioon' && !(Math.abs(PF_num_(t.summa)) >= 0.01)) throw new Error('Korrektsiooni summa puudub');
  var valuuta = String(t.valuuta || '').trim().toUpperCase();
  if (valuuta && !/^[A-Z]{3}$/.test(valuuta)) throw new Error('Vigane valuuta');
  return {
    portfell: String(t.portfell || ''), tyyp: String(t.tyyp || ''), ticker: ticker,
    kogus: PF_num_(t.kogus), hind: PF_num_(t.hind), tasu: PF_num_(t.tasu) || 0, summa: PF_num_(t.summa),
    valuuta: valuuta, kurss: PF_num_(t.kurss), kuupaev: kuupaev,
    markus: String(t.markus || '').replace(/^[=+\-@\s]+/, '').slice(0, 100)
  };
}

function PF_viimaneUuendus_(hinnad) {
  var m = null;
  for (var i = 0; i < hinnad._jarjekord.length; i++) {
    var u = hinnad[hinnad._jarjekord[i]].uuendatud;
    if (u instanceof Date && (!m || u > m)) m = u;
  }
  return m;
}

/** Kõik, mida vaade ühe portfelli kohta vajab. */
function PF_andmed_(soov) {
  // soov = konto nimi või '*' (kõik kontod koos, ainult vaatamiseks). Tühi konto on lubatud,
  // et esimese tehingu saaks lisada äpist.
  var portfellid = PF_portfellid_(), koos = soov === '*' && portfellid.length > 1, nimi = 'Koos';
  if (!koos) { nimi = portfellid[0]; for (var pi = 0; pi < portfellid.length; pi++) if (portfellid[pi].toLowerCase() === String(soov || '').trim().toLowerCase()) nimi = portfellid[pi]; }
  var nimed = koos ? portfellid : [nimi], osaSeis = {};
  var omanik = function (x) { x = String(x).trim(); return nimed.indexOf(x) >= 0 ? x : null; };

  var hinnad = PF_loeHinnad_(), s = PF_seisKoos_(nimed, hinnad, osaSeis), r2 = function (x) { return PF_umarda_(x, 2); };
  var n = function (x, k) { return (typeof x === 'number' && isFinite(x)) ? PF_umarda_(x, k) : null; };
  var onFx = function (t) { return /=X$/.test(t); };

  // positsioonid
  var pos = [], peetud = {}, vanu = [];
  for (var j = 0; j < s.read.length; j++) {
    var r = s.read[j], h = hinnad[r.ticker] || {};
    peetud[r.ticker] = true;
    var ok = String(h.staatus || '') === 'OK';
    if (!ok) vanu.push(r.kuva);
    pos.push({ t: r.ticker, kuva: r.kuva, nimi: r.nimi, val: r.valuuta, kogus: r.kogus, ost: n(r.ostuhind, 4),
               hind: n(r.hind, 4), v: n(r.vaartus, 2), soetus: n(r.soetus, 2), kasum: n(r.kasum, 2), kasumPr: n(r.kasumPr, 4),
               tana: n(r.tana, 2), tanaPr: n(r.tanaPr, 4), nadalPr: n(r.nadalPr, 4), aastaPr: n(r.aastaPr, 4),
               osakaal: s.kokku > 0 && r.vaartus !== null ? n(r.vaartus / s.kokku, 4) : null,
               max52: n(h.max52, 4), min52: n(h.min52, 4), ok: ok, osad: koos ? r.osad : undefined });
  }

  // ajalugu + tänane seis reaalajas
  var ah = PF_leht_(PF_CFG.lehed.ajalugu), viimane = ah.getLastRow(), ajalugu = [];
  var read = viimane >= 2 ? ah.getRange(2, 1, viimane - 1, PF_AJALUGU_PAIS.length).getValues() : [];
  var tana = PF_paev_(new Date());
  var osak = 100, loeB = function (rida) { var bb = []; for (var bk = 0; bk < PF_CFG.vordlus.length; bk++) bb.push(n(PF_num_(rida[PF_AJALUGU_ALUS + bk]) || NaN, 2)); return bb; };
  if (!koos) {
    for (var a = 0; a < read.length; a++) {
      if (String(read[a][1]).trim() !== nimi || !(read[a][0] instanceof Date)) continue;
      var paev = PF_paev_(read[a][0]);
      if (paev >= tana) continue;                               // tänane punkt arvutatakse värskelt
      ajalugu.push({ d: paev, v: r2(PF_num_(read[a][2])), s: r2(PF_num_(read[a][3])), h: PF_umarda_(PF_num_(read[a][6]), 4), b: loeB(read[a]) });
    }
    var eel = ajalugu.length ? ajalugu[ajalugu.length - 1] : null;
    if (eel) osak = eel.h * (1 + PF_dietz_(s.kokku, eel.v, s.netoSisse - eel.s));
  } else {
    // Koondajalugu: iga kuupäeva kohta kontode viimane teadaolev seis kokku. Osaku hind arvutatakse uuesti;
    // konto lisandumine loetakse rahavooks kogu selle väärtuses, et varasem kasum ei näiks ühe päeva tootlusena.
    var perKp = {}, kpd = [], viim = {}, hK = 100, eelV = null;
    for (var ka = 0; ka < read.length; ka++) {
      var om = omanik(read[ka][1]);
      if (!om || !(read[ka][0] instanceof Date)) continue;
      var kp = PF_paev_(read[ka][0]);
      if (kp >= tana) continue;
      if (!perKp[kp]) { perKp[kp] = {}; kpd.push(kp); }
      perKp[kp][om] = { v: PF_num_(read[ka][2]) || 0, s: PF_num_(read[ka][3]) || 0, b: loeB(read[ka]) };
    }
    kpd.sort();
    for (var kd = 0; kd < kpd.length; kd++) {
      var paevas = perKp[kpd[kd]], voog = 0, bK = null, vK = 0, sK = 0;
      for (var on in paevas) { voog += viim[on] ? paevas[on].s - viim[on].s : paevas[on].v; viim[on] = paevas[on]; bK = bK || paevas[on].b; }
      for (var vn in viim) { vK += viim[vn].v; sK += viim[vn].s; }
      if (eelV !== null) hK = hK * (1 + PF_dietz_(vK, eelV, voog));
      ajalugu.push({ d: kpd[kd], v: r2(vK), s: r2(sK), h: PF_umarda_(hK, 4), b: bK });
      eelV = vK;
    }
    var voogN = 0;
    for (var ni = 0; ni < nimed.length; ni++) { var cs = osaSeis[nimed[ni]]; voogN += viim[nimed[ni]] ? cs.netoSisse - viim[nimed[ni]].s : cs.kokku; }
    osak = eelV !== null ? hK * (1 + PF_dietz_(s.kokku, eelV, voogN)) : 100;
  }
  var bNyyd = [], vordlus = [];
  for (var bn = 0; bn < PF_CFG.vordlus.length; bn++) {
    var bh = hinnad[PF_CFG.vordlus[bn]] || {};
    bNyyd.push(n(bh.hind > 0 ? bh.hind : NaN, 2));
    vordlus.push({ t: PF_CFG.vordlus[bn], kuva: bh.kuva || PF_kuvanimi_(PF_CFG.vordlus[bn]),
                   tanaPr: bh.hind > 0 && bh.eelmine > 0 ? n(bh.hind / bh.eelmine - 1, 4) : null });
  }
  if (!s.puudu.length) ajalugu.push({ d: tana, v: r2(s.kokku), s: r2(s.netoSisse), h: PF_umarda_(osak, 4), b: bNyyd });
  var paev = [], pv = PF_CFG.paevaVordlus || PF_CFG.vordlus;
  for (var pk = 0; pk < pv.length; pk++) {
    var ph = hinnad[pv[pk]] || {};
    if (ph.hind > 0 && ph.eelmine > 0) paev.push({ t: pv[pk], kuva: ph.kuva || PF_kuvanimi_(pv[pk]), tanaPr: n(ph.hind / ph.eelmine - 1, 4) });
  }
  var aastaAlgus = null, sellAasta = tana.slice(0, 4);
  for (var b = 0; b < ajalugu.length; b++) if (ajalugu[b].d.slice(0, 4) < sellAasta) aastaAlgus = ajalugu[b];

  // päeva jälg lehelt "Päev" + praegune hetk
  var joon = [], psh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Päev');
  var minut = function (dt) { var hm = Utilities.formatDate(dt, PF_CFG.ajavoond, 'HH:mm').split(':'); return (+hm[0]) * 60 + (+hm[1]); };
  if (psh && psh.getLastRow() >= 2) {
    var pread = psh.getRange(2, 1, psh.getLastRow() - 1, 3 + pv.length).getValues(), grupp = {}, mj = [];
    for (var pj = 0; pj < pread.length; pj++) {
      var pr = pread[pj], po = omanik(pr[1]);
      if (!(pr[0] instanceof Date) || PF_paev_(pr[0]) !== tana || !po) continue;
      var pb = []; for (var pc = 0; pc < pv.length; pc++) pb.push(n(PF_num_(pr[3 + pc]), 5));
      // koondvaates kaalutakse kontode päevamuutus nende aktsiate eilse väärtusega
      var kaal = koos ? Math.max(osaSeis[po].aktsiad - osaSeis[po].tana, 0) : 1, pm = minut(pr[0]), pp = PF_num_(pr[2]);
      if (!isFinite(pp) || !(kaal > 0)) continue;
      if (!grupp[pm]) { grupp[pm] = { wp: 0, w: 0, b: pb }; mj.push(pm); }
      grupp[pm].wp += pp * kaal; grupp[pm].w += kaal;
    }
    mj.sort(function (x, y) { return x - y; });
    for (var gi = 0; gi < mj.length; gi++) joon.push({ m: mj[gi], p: n(grupp[mj[gi]].wp / grupp[mj[gi]].w, 5), b: grupp[mj[gi]].b });
  }
  var eilneV = s.aktsiad - s.tana;
  if (!s.puudu.length && eilneV > 0) {
    var nb = []; for (var nk = 0; nk < pv.length; nk++) { var nh = hinnad[pv[nk]] || {}; nb.push(nh.hind > 0 && nh.eelmine > 0 ? n(nh.hind / nh.eelmine - 1, 5) : null); }
    var nm = minut(new Date());
    if (!joon.length || joon[joon.length - 1].m < nm) joon.push({ m: nm, p: n(s.tana / eilneV, 5), b: nb });
  }

  // turg, jälgimisnimekiri, vormi tickerid
  var turg = [], jalgin = [], tickerid = [];
  for (var c = 0; c < hinnad._jarjekord.length; c++) {
    var t = hinnad._jarjekord[c], x = hinnad[t];
    if (onFx(t)) continue;
    if (x.valuuta) tickerid.push({ t: t, kuva: x.kuva, val: x.valuuta, hind: n(x.hind, 4) });
    if (!(x.hind > 0)) continue;
    var rida = { t: t, kuva: x.kuva, nimi: x.nimi, val: x.valuuta, hind: n(x.hind, 4),
                 tanaPr: x.eelmine > 0 ? n(x.hind / x.eelmine - 1, 4) : null,
                 nadalPr: x.nadal > 0 ? n(x.hind / x.nadal - 1, 4) : null,
                 aastaPr: x.algus > 0 ? n(x.hind / x.algus - 1, 4) : null,
                 tipust: x.max52 > 0 ? n(Math.min(0, x.hind / x.max52 - 1), 4) : null };
    if (PF_CFG.turg.indexOf(t) >= 0) turg.push(rida);
    else if (!peetud[t]) jalgin.push(rida);
  }

  turg.sort(function (x, y) { return PF_CFG.turg.indexOf(x.t) - PF_CFG.turg.indexOf(y.t); });

  // kursid
  var kursid = {};
  for (var d = 0; d < hinnad._jarjekord.length; d++) {
    var m = hinnad._jarjekord[d].match(/^EUR([A-Z]{3})=X$/);
    if (m && hinnad[hinnad._jarjekord[d]].hind > 0) kursid[m[1]] = PF_umarda_(1 / hinnad[hinnad._jarjekord[d]].hind, 6);
  }

  // muud varad: summana (käsitsi) või kogusena, mille väärtus tuleb turuhinnast (nt kuld untsides)
  var varad = [], varadKokku = 0, sh = PF_leht_(PF_CFG.lehed.seaded), vr = sh.getLastRow();
  var vread = vr >= 2 ? sh.getRange(2, 1, vr - 1, 6).getValues() : [];
  for (var f = 0; f < vread.length; f++) {
    var vo = omanik(vread[f][0]);
    if (!vo || !String(vread[f][1]).trim()) continue;
    var vv = PF_num_(vread[f][2]), vkogus = PF_num_(vread[f][3]);
    var vara = { vara: String(vread[f][1]).trim() + (koos ? ' (' + vo + ')' : ''), v: vv > 0 ? r2(vv) : 0 };
    if (vkogus > 0) {
      var vt = String(vread[f][5]).trim().toUpperCase() || 'GC=F', vh = hinnad[vt] || {}, vost = PF_num_(vread[f][4]) || 0;
      vara.kogus = vkogus; vara.ost = vost; vara.ticker = vt; vara.v = 0;
      if (vh.hind > 0) {
        var vk = PF_kurss_(vh.valuuta, hinnad);
        vara.hind = r2(vh.hind * vk);                           // turuhind eurodes ühiku kohta
        vara.v = r2(vkogus * vh.hind * vk);
        vara.soetus = r2(vkogus * vost);
        vara.kasum = r2(vara.v - vara.soetus);
        vara.kasumPr = vara.soetus > 0 ? n(vara.kasum / vara.soetus, 4) : null;
        vara.tanaPr = vh.eelmine > 0 ? n(vh.hind / vh.eelmine - 1, 4) : null;
      }
    }
    varad.push(vara);
    if (vara.v > 0) varadKokku += vara.v;
  }

  // viimased tehingud (ilma algseisuta)
  var th = PF_leht_(PF_CFG.lehed.tehingud), tr = th.getLastRow(), tehingud = [];
  var tread = tr >= 2 ? th.getRange(2, 1, tr - 1, PF_TEHING_PAIS.length).getValues() : [];
  for (var g = tread.length - 1; g >= 0 && tehingud.length < 12; g--) {
    var q = tread[g];
    var qo = omanik(q[1]);
    if (!qo || !q[2] || String(q[10]).indexOf('algseis') === 0) continue;
    var tk = String(q[3]).trim();
    tehingud.push({ d: q[0] instanceof Date ? PF_paev_(q[0]) : '', tyyp: String(q[2]), t: tk,
                    kuva: tk ? ((hinnad[tk] || {}).kuva || PF_kuvanimi_(tk)) : '',
                    kogus: n(PF_num_(q[4]), 6), hind: n(PF_num_(q[5]), 4), val: String(q[6]), summa: n(PF_num_(q[9]), 2),
                    markus: String(q[10] || ''), omanik: koos ? qo : undefined });
  }

  var uuendatud = PF_viimaneUuendus_(hinnad), eilne = s.aktsiad - s.tana;
  return {
    portfellid: portfellid, portfell: nimi, valik: koos ? '*' : nimi, koos: koos,
    uuendatud: uuendatud ? Utilities.formatDate(uuendatud, PF_CFG.ajavoond, 'dd.MM.yyyy HH:mm') : '',
    serveriVersioon: 6, vanu: vanu, hinnata: s.puudu, pinOlemas: !!PF_PIN && String(PF_PIN).length >= 4,
    kokku: {
      vaartus: r2(s.kokku), aktsiad: r2(s.aktsiad), raha: r2(s.raha), netoSisse: r2(s.netoSisse),
      kasum: r2(s.kokku - s.netoSisse), kasumPr: s.netoSisse > 0 ? n((s.kokku - s.netoSisse) / s.netoSisse, 4) : null,
      realiseerimata: r2(s.kokku - s.netoSisse - s.realiseeritud - s.dividendid),
      realiseeritud: r2(s.realiseeritud), dividendid: r2(s.dividendid),
      tana: r2(s.tana), tanaPr: eilne > 0 ? n(s.tana / eilne, 4) : null,
      aastaPr: aastaAlgus ? n(osak / aastaAlgus.h - 1, 4) : null,
      aastaEur: aastaAlgus ? r2((s.kokku - s.netoSisse) - (aastaAlgus.v - aastaAlgus.s)) : null,
      algusestPr: ajalugu.length ? n(osak / ajalugu[0].h - 1, 4) : null,
      algus: ajalugu.length ? ajalugu[0].d : '',
      varad: r2(varadKokku), koik: r2(s.kokku + varadKokku)
    },
    pos: pos, ajalugu: ajalugu, turg: turg, jalgin: jalgin, tickerid: tickerid, kursid: kursid,
    varad: varad, tehingud: tehingud, vordlus: vordlus, paev: paev, paevaJoon: joon, paevaTickerid: pv
  };
}


/**
 * PORTFELL v2 — uue, tühja Google Sheeti jaoks.
 * Hinnad (üks kood kõigile tickeritele), tehingute pearaamat, positsioonid, päevane hetktõmmis.
 * Kõik globaalid PF_ eesliitega.
 *
 * Paigaldus (üks kord, selles järjekorras):
 *   PF_seadista()               – loob lehed Tehingud, Hinnad, Positsioonid, Ajalugu, Seaded, toob esimesed hinnad
 *                                 ja paneb käima automaatse uuendamise (hinnad iga 15 min, hetktõmmis iga päev kell 23)
 *
 * Edaspidi:
 *   PF_lisaTehing({...})        – lisab tehingu ja kirjutab Positsioonid uuesti
 *   PF_varskendaHinnad(true)    – käsitsi värskendus (ka menüüst Portfell → Värskenda hinnad)
 *   PF_taidaVordlus()           – täidab Ajalugu lehel S&P 500 puuduvad tasemed
 *
 * Lehed:
 *   Tehingud      – ainus koht, kuhu sisestatakse
 *   Hinnad        – üks rida tickeri kohta; skript kirjutab VÄÄRTUSED (valemeid pole).
 *                   Veerg "Kuvanimi" on sinu muuta (nt HYPE32196-USD → Hyperliquid); skript seda üle ei kirjuta.
 *                   Lisa veergu A uus ticker ja see hakkab kaasa uuenema (jälgimisnimekiri).
 *   Positsioonid  – skript kirjutab tehingutest ja hindadest; käsitsi ei muudeta
 *   Ajalugu       – päevane hetktõmmis graafiku jaoks
 *   Seaded        – muud varad (kuld, pension), käsitsi
 */

var PF_CFG = {
  lehed: { tehingud: 'Tehingud', hinnad: 'Hinnad', positsioonid: 'Positsioonid', ajalugu: 'Ajalugu', seaded: 'Seaded' },
  ajavoond: 'Europe/Tallinn',
  nimi: 'Portfell',                       // portfelli nimi uues failis (olemasolevas failis kehtib Tehingud lehel olev nimi)
  turg: ['^GSPC', 'ES=F', 'GC=F', 'BTC-USD'],   // on alati Hinnad lehel (turuülevaade)
  vordlus: ['^GSPC'],                     // võrdlusindeks: tase salvestatakse iga hetktõmmisega lehele Ajalugu
  // Päeva võrdlus: kui USA börs on kinni, näitab sama indeksi futuur (ES=F), kuhu S&P 500 parajasti liigub.
  paevaVordlus: ['^GSPC', 'ES=F'],
  varuKurss: { USD: 0.876 },              // ainult siis, kui valuutakurssi pole kunagi kätte saadud
  ooPaus: [0, 8],                         // automaatne värskendus jääb vahele kell 00–08
  pakk: 10,                               // mitu päringut korraga
  kuvanimed: { '^GSPC': 'S&P 500', 'ES=F': 'S&P 500 futuur', 'GC=F': 'Kuld', 'BTC-USD': 'Bitcoin', 'ETH-USD': 'Ethereum' },  // vaikimisi kuvanimed
  // Valikuline algseis (vaikimisi tühi: seis sisestatakse äpist sissemakse ja ostudena).
  // Kuju: { 'Nimi': { raha: 200, netoSisse: 10000, positsioonid: [['VWRL.AS','EUR',133.16,10]], ajalugu: [{aasta:2025,sisse:9000,vaartus:11000}], muudVarad: ['Kuld'] } }
  algseis: {}
};

var PF_TEHING_PAIS = ['Kuupäev', 'Portfell', 'Tüüp', 'Ticker', 'Kogus', 'Hind', 'Valuuta',
                      'Kurss (→EUR)', 'Tasu €', 'Summa €', 'Märkus'];
var PF_HIND_PAIS = ['Ticker', 'Kuvanimi', 'Nimi', 'Valuuta', 'Hind', 'Eelmine sulgemine', 'Nädal tagasi', 'Aasta algus',
                    '52n max', '52n min', 'Uuendatud', 'Staatus'];
var PF_POS_PAIS = ['Portfell', 'Ticker', 'Kuvanimi', 'Nimi', 'Valuuta', 'Kogus', 'Ostuhind', 'Hind', 'Väärtus €', 'Soetus €',
                   'Kasum €', 'Kasum %', 'Täna €', 'Täna %', 'Nädal %', 'Aasta %', 'Osakaal %'];
var PF_AJALUGU_ALUS = 8;   // veergude arv enne võrdlusindekseid
var PF_AJALUGU_PAIS = ['Kuupäev', 'Portfell', 'Väärtus €', 'Netosissemaksed €', 'Kasum €',
                       'Osakuid', 'Osaku hind', 'Märkus'].concat(PF_CFG.vordlus.map(function (t) { return PF_kuvanimi_(t); }));
var PF_TYYBID = ['Ost', 'Müük', 'Sissemakse', 'Väljamakse', 'Dividend', 'Tasu', 'Korrektsioon'];

/* ================================================================ abid */

/** Parsib Eesti arvuvormingu: "7 575", "0,876", "0,44%", "1 303 €". */
function PF_num_(v) {
  if (typeof v === 'number') return v;
  if (v === null || v === undefined || v === '') return NaN;
  var s = String(v).replace(/[\s  €%]/g, '').replace('−', '-').replace(',', '.');
  return s === '' ? NaN : Number(s);
}
function PF_umarda_(x, kohti) { var k = Math.pow(10, kohti); return Math.round(x * k) / k; }
function PF_paev_(d) { return Utilities.formatDate(d, PF_CFG.ajavoond, 'yyyy-MM-dd'); }
function PF_leht_(nimi) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(nimi);
  if (!sh) throw new Error('Lehte "' + nimi + '" ei leitud – käivita PF_seadista()');
  return sh;
}
/**
 * Kontode (portfellide) nimed: lehelt Tehingud esinemise järjekorras, siis lehelt Seaded ja äpist lisatud kontod.
 * Tühjas failis seadistuse nimi.
 */
function PF_portfellid_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), out = [], olemas = {};
  var lisa = function (x) { var n = String(x || '').trim(); if (n && !olemas[n.toLowerCase()]) { olemas[n.toLowerCase()] = true; out.push(n); } };
  var loe = function (leht, veerg) {
    var sh = ss.getSheetByName(leht), viimane = sh ? sh.getLastRow() : 0;
    if (viimane < 2) return;
    var v = sh.getRange(2, veerg, viimane - 1, 1).getValues();
    for (var i = 0; i < v.length; i++) lisa(v[i][0]);
  };
  loe(PF_CFG.lehed.tehingud, 2);
  loe(PF_CFG.lehed.seaded, 1);
  try { var k = JSON.parse(PropertiesService.getScriptProperties().getProperty('PF_KONTOD') || '[]'); for (var j = 0; j < k.length; j++) lisa(k[j]); } catch (e) {}
  if (!out.length) { for (var a in PF_CFG.algseis) lisa(a); }
  return out.length ? out : [PF_CFG.nimi];
}
/** Konto, kuhu kirjutada: äpist tulnud nimi peab olema olemas. Kui kontosid on üks, kasutatakse seda. */
function PF_konto_(soov) {
  var pf = PF_portfellid_(), n = String(soov || '').trim().toLowerCase();
  for (var i = 0; i < pf.length; i++) if (pf[i].toLowerCase() === n) return pf[i];
  if (pf.length === 1) return pf[0];
  throw new Error('Vali konto, mida muuta');
}
function PF_fxTicker_(valuuta) { return 'EUR' + valuuta + '=X'; }
/**
 * Vaikimisi kuvanimi tickerist: VWRL.AS → VWRL, HYPE32196-USD → HYPE, EURUSD=X → EUR/USD.
 * Kasutatakse ainult siis, kui Hinnad lehe veerg "Kuvanimi" on tühi – sinna kirjutatud nimi jääb alati alles.
 */
function PF_kuvanimi_(ticker) {
  if (PF_CFG.kuvanimed[ticker]) return PF_CFG.kuvanimed[ticker];
  var m = ticker.match(/^([A-Z]{3})([A-Z]{3})=X$/);
  if (m) return m[1] + '/' + m[2];
  if (/-USD$/.test(ticker)) return ticker.replace(/-USD$/, '').replace(/\d+$/, '');
  return ticker.replace(/^\^/, '').replace(/=[A-Z]$/, '').replace(/\.[A-Z]+$/, '');
}
function PF_tyhiVoiArv_(x) { return (typeof x === 'number' && isFinite(x)) ? x : ''; }

/* ================================================================ hinnad (Yahoo chart, üks päring tickeri kohta) */

/**
 * Üks päring annab kõik: hind, nimi, valuuta, eelmine sulgemine, nädalatagune ja aasta alguse hind.
 * Aken algab eelmise aasta 15. detsembrist, et aasta viimane sulgemine oleks sees.
 */
function PF_hinnaUrl_(ticker, host, nowSek) {
  var aasta = Number(Utilities.formatDate(new Date(nowSek * 1000), PF_CFG.ajavoond, 'yyyy'));
  var p1 = Math.floor(Date.UTC(aasta - 1, 11, 15) / 1000);
  return 'https://' + host + '.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) +
         '?period1=' + p1 + '&period2=' + nowSek + '&interval=1d';
}

/** Parsib chart-vastuse. Viskab vea, kui hinda pole. */
function PF_parsiChart_(tekst, nowSek) {
  var j = JSON.parse(tekst);
  if (!j.chart || !j.chart.result || !j.chart.result[0]) {
    var v = j.chart && j.chart.error ? (j.chart.error.description || j.chart.error.code) : 'tühi vastus';
    throw new Error(v);
  }
  var res = j.chart.result[0], meta = res.meta || {};
  var hind = meta.regularMarketPrice;
  if (!(typeof hind === 'number' && isFinite(hind))) throw new Error('hind puudub');

  var ts = res.timestamp || [];
  var closes = (res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close) || [];
  var nihe = meta.gmtoffset || 0;                               // börsi kohalik aeg
  var paev = function (sek) { return Math.floor((sek + nihe) / 86400); };
  var aasta = function (sek) { return new Date((sek + nihe) * 1000).getUTCFullYear(); };
  var turuAeg = meta.regularMarketTime || nowSek;
  var tana = paev(turuAeg), sellAastal = aasta(turuAeg), nadalSiht = nowSek - 7 * 86400;

  var eelmine = null, nadal = null, algus = null, esimene = null;
  for (var i = 0; i < ts.length; i++) {
    var c = closes[i];
    if (c === null || c === undefined) continue;
    if (esimene === null) esimene = c;
    if (paev(ts[i]) < tana) eelmine = c;                        // viimane sulgemine enne tänast kauplemispäeva
    if (ts[i] <= nadalSiht) nadal = c;                          // viimane sulgemine vähemalt 7 päeva tagasi
    if (aasta(ts[i]) < sellAastal) algus = c;                   // eelmise aasta viimane sulgemine
  }
  if (eelmine === null && typeof meta.previousClose === 'number') eelmine = meta.previousClose;
  if (nadal === null) nadal = esimene;                          // uus ticker: esimene olemasolev sulgemine
  if (algus === null) algus = esimene;

  var valuuta = String(meta.currency || '').trim();
  var jagaja = 1;
  if (valuuta === 'GBp' || valuuta === 'GBX') { jagaja = 100; valuuta = 'GBP'; }   // Londoni börs: pennid
  var f = function (x) { return (typeof x === 'number' && isFinite(x)) ? x / jagaja : null; };
  return {
    nimi: meta.longName || meta.shortName || '',
    valuuta: valuuta.toUpperCase(),
    hind: f(hind), eelmine: f(eelmine), nadal: f(nadal), algus: f(algus),
    max52: f(meta.fiftyTwoWeekHigh), min52: f(meta.fiftyTwoWeekLow)
  };
}

/**
 * Toob hinnad paralleelselt (fetchAll), pakkidena. Ebaõnnestunud proovitakse üks kord uuesti teise serveri pealt.
 * Tagastab {ticker: {ok:true, ...} | {ok:false, viga:'HTTP 429'}} – ei viska kunagi viga.
 */
function PF_tooHinnad_(tickerid) {
  var nowSek = Math.floor(Date.now() / 1000);
  var tulem = {}, jarel = tickerid.slice(), hostid = ['query1', 'query2'];
  for (var katse = 0; katse < hostid.length && jarel.length; katse++) {
    if (katse > 0) Utilities.sleep(2000);
    var uuesti = [];
    for (var i = 0; i < jarel.length; i += PF_CFG.pakk) {
      if (i > 0) Utilities.sleep(300);
      var osa = jarel.slice(i, i + PF_CFG.pakk);
      var paringud = [];
      for (var k = 0; k < osa.length; k++) {
        paringud.push({ url: PF_hinnaUrl_(osa[k], hostid[katse], nowSek), muteHttpExceptions: true });
      }
      var vastused = null, pakiViga = '';
      try { vastused = UrlFetchApp.fetchAll(paringud); } catch (e) { pakiViga = String(e.message || e).slice(0, 60); }
      for (var m = 0; m < osa.length; m++) {
        var t = osa[m];
        if (!vastused) { tulem[t] = { ok: false, viga: pakiViga }; uuesti.push(t); continue; }
        var kood = vastused[m].getResponseCode();
        if (kood === 200) {
          try {
            var h = PF_parsiChart_(vastused[m].getContentText(), nowSek);
            h.ok = true; tulem[t] = h; continue;
          } catch (e2) { tulem[t] = { ok: false, viga: String(e2.message || e2).slice(0, 60) }; }
        } else {
          tulem[t] = { ok: false, viga: kood === 404 ? 'tickerit ei leitud' : 'HTTP ' + kood };
        }
        if (kood !== 404) uuesti.push(t);                       // tundmatut tickerit pole mõtet uuesti küsida
      }
    }
    jarel = uuesti;
  }
  return tulem;
}

/** Loeb Hinnad lehe: {ticker: {kuva, nimi, valuuta, hind, eelmine, nadal, algus, max52, min52, uuendatud, staatus}}. */
function PF_loeHinnad_() {
  var sh = PF_leht_(PF_CFG.lehed.hinnad), viimane = sh.getLastRow(), out = { _jarjekord: [] };
  if (viimane < 2) return out;
  var v = sh.getRange(2, 1, viimane - 1, PF_HIND_PAIS.length).getValues();
  for (var i = 0; i < v.length; i++) {
    var t = String(v[i][0]).trim();
    if (!t || out[t]) continue;
    out._jarjekord.push(t);
    out[t] = { kuva: String(v[i][1]).trim() || PF_kuvanimi_(t), nimi: v[i][2],
               valuuta: String(v[i][3]).trim().toUpperCase(), hind: PF_num_(v[i][4]),
               eelmine: PF_num_(v[i][5]), nadal: PF_num_(v[i][6]), algus: PF_num_(v[i][7]),
               max52: PF_num_(v[i][8]), min52: PF_num_(v[i][9]), uuendatud: v[i][10], staatus: v[i][11] };
  }
  return out;
}

/** Valuuta → EUR kordaja Hinnad lehe põhjal (EURUSD=X hind 1,14 → USD kordaja 0,877). */
function PF_kurss_(valuuta, hinnad) {
  if (!valuuta || valuuta === 'EUR') return 1;
  var h = hinnad[PF_fxTicker_(valuuta)];
  if (h && h.hind > 0) return 1 / h.hind;
  if (PF_CFG.varuKurss[valuuta]) return PF_CFG.varuKurss[valuuta];
  throw new Error('Valuuta ' + valuuta + ' kurss puudub – värskenda hinnad');
}

/**
 * Värskendab Hinnad lehe ja kirjutab Positsioonid uuesti.
 * sunni=true: käsitsi värskendus (öine paus ei kehti). Triggerist käivitades on argument sündmuse objekt → paus kehtib.
 * Kui tickeri päring ebaõnnestub, jäävad vanad numbrid alles ja staatuseks läheb "VANA – põhjus".
 */
function PF_varskendaHinnad(sunni) {
  if (sunni !== true) {
    var tund = Number(Utilities.formatDate(new Date(), PF_CFG.ajavoond, 'H'));
    if (tund >= PF_CFG.ooPaus[0] && tund < PF_CFG.ooPaus[1]) return 'Öine paus';
  }
  var lukk = LockService.getScriptLock();
  if (!lukk.tryLock(20000)) return 'Teine värskendus käib juba';
  try {
    var vanad = PF_loeHinnad_();
    var nimekiri = vanad._jarjekord.slice(), olemas = {};
    for (var i = 0; i < nimekiri.length; i++) olemas[nimekiri[i]] = true;
    var lisa = function (t) { if (t && !olemas[t]) { olemas[t] = true; nimekiri.push(t); } };

    var pfd = PF_portfellid_();
    for (var p = 0; p < pfd.length; p++) {
      var seis = PF_arvuta_(PF_loeTehingud_(pfd[p]));
      for (var tk in seis.pos) {
        if (seis.pos[tk].kogus > 0) { lisa(tk); if (seis.pos[tk].valuuta !== 'EUR') lisa(PF_fxTicker_(seis.pos[tk].valuuta)); }
      }
    }
    for (var q = 0; q < PF_CFG.turg.length; q++) lisa(PF_CFG.turg[q]);
    if (!nimekiri.length) return 'Tickereid pole';

    var uued = PF_tooHinnad_(nimekiri), nyyd = new Date(), read = [], vead = [];
    for (var r = 0; r < nimekiri.length; r++) {
      var t = nimekiri[r], u = uued[t], v = vanad[t], kuva = v ? v.kuva : PF_kuvanimi_(t);
      if (u && u.ok) {
        // jälgimisnimekirja valuuta võib anda uue kursi vajaduse – lisatakse järgmisel ringil
        read.push([t, kuva, u.nimi, u.valuuta, u.hind, PF_tyhiVoiArv_(u.eelmine), PF_tyhiVoiArv_(u.nadal),
                   PF_tyhiVoiArv_(u.algus), PF_tyhiVoiArv_(u.max52), PF_tyhiVoiArv_(u.min52), nyyd, 'OK']);
      } else {
        var pohjus = u ? u.viga : 'vastust ei tulnud';
        vead.push(t + ' (' + pohjus + ')');
        if (v) read.push([t, kuva, v.nimi, v.valuuta, PF_tyhiVoiArv_(v.hind), PF_tyhiVoiArv_(v.eelmine), PF_tyhiVoiArv_(v.nadal),
                          PF_tyhiVoiArv_(v.algus), PF_tyhiVoiArv_(v.max52), PF_tyhiVoiArv_(v.min52), v.uuendatud,
                          (isFinite(v.hind) ? 'VANA – ' : 'PUUDUB – ') + pohjus]);
        else read.push([t, kuva, '', '', '', '', '', '', '', '', '', 'PUUDUB – ' + pohjus]);
      }
    }
    PF_leht_(PF_CFG.lehed.hinnad).getRange(2, 1, read.length, PF_HIND_PAIS.length).setValues(read);
    PF_kirjutaPositsioonid_();
    try { PF_logiPaev_(); } catch (pe) { Logger.log('Päeva logi: ' + pe.message); }
    var s = (nimekiri.length - vead.length) + '/' + nimekiri.length + ' uuendatud' +
            (vead.length ? '; vead: ' + vead.join(', ') : '');
    Logger.log(s);
    return s;
  } finally {
    lukk.releaseLock();
  }
}

/* ================================================================ tehingud ja arvutus */

function PF_loeTehingud_(portfell) {
  var sh = PF_leht_(PF_CFG.lehed.tehingud), viimane = sh.getLastRow();
  if (viimane < 2) return [];
  var v = sh.getRange(2, 1, viimane - 1, PF_TEHING_PAIS.length).getValues(), out = [];
  for (var i = 0; i < v.length; i++) {
    var r = v[i];
    if (!r[2]) continue;
    if (portfell && String(r[1]).trim() !== portfell) continue;
    var kurss = PF_num_(r[7]);
    out.push({
      kuupaev: r[0], portfell: String(r[1]).trim(), tyyp: String(r[2]).trim(), ticker: String(r[3]).trim(),
      kogus: PF_num_(r[4]) || 0, hind: PF_num_(r[5]) || 0,
      valuuta: String(r[6]).trim().toUpperCase() || 'EUR',
      kurss: kurss > 0 ? kurss : 1, tasu: PF_num_(r[8]) || 0, summa: PF_num_(r[9]) || 0
    });
  }
  return out;
}

/** Arvutab tehingutest seisu. Keskmise soetushinna meetod. */
function PF_arvuta_(tehingud) {
  var s = { raha: 0, netoSisse: 0, realiseeritud: 0, dividendid: 0, tasud: 0, korrektsioon: 0, pos: {} };
  for (var i = 0; i < tehingud.length; i++) {
    var t = tehingud[i], tasu = t.tasu || 0;
    if (t.tyyp === 'Ost' || t.tyyp === 'Müük') {
      var eur = t.kogus * t.hind * t.kurss;
      var p = s.pos[t.ticker];
      if (!p) p = s.pos[t.ticker] = { ticker: t.ticker, valuuta: t.valuuta, kogus: 0, kuluOma: 0, kuluEur: 0, realiseeritud: 0 };
      if (t.tyyp === 'Ost') {
        p.kogus += t.kogus; p.kuluOma += t.kogus * t.hind; p.kuluEur += eur + tasu;
        s.raha -= eur + tasu;
      } else {
        if (t.kogus > p.kogus + 1e-9) throw new Error('Müük ületab positsiooni: ' + t.ticker);
        var osa = t.kogus / p.kogus;
        var kasum = eur - tasu - p.kuluEur * osa;
        p.realiseeritud += kasum; s.realiseeritud += kasum;
        p.kuluOma -= p.kuluOma * osa; p.kuluEur -= p.kuluEur * osa; p.kogus -= t.kogus;
        if (p.kogus < 1e-9) { p.kogus = 0; p.kuluOma = 0; p.kuluEur = 0; }
        s.raha += eur - tasu;
      }
      s.tasud += tasu;
    } else if (t.tyyp === 'Sissemakse') { s.raha += t.summa; s.netoSisse += t.summa; }
    else if (t.tyyp === 'Väljamakse')   { s.raha -= t.summa; s.netoSisse -= t.summa; }
    else if (t.tyyp === 'Dividend')     { s.raha += t.summa; s.dividendid += t.summa; }
    else if (t.tyyp === 'Tasu')         { s.raha -= t.summa; s.tasud += t.summa; }
    else if (t.tyyp === 'Korrektsioon') { s.raha += t.summa; s.korrektsioon += t.summa; }
    else throw new Error('Tundmatu tehingu tüüp: ' + t.tyyp);
  }
  return s;
}

/** Portfelli seis hindadega: read positsioonide kaupa + kogusummad. puudu = tickerid, millel pole hinda. */
function PF_seis_(nimi, hinnad) {
  var s = PF_arvuta_(PF_loeTehingud_(nimi)), read = [], aktsiad = 0, puudu = [], tanaKokku = 0;
  for (var tk in s.pos) {
    var p = s.pos[tk];
    if (!(p.kogus > 0)) continue;
    var h = hinnad[tk] || {};
    var r = { ticker: tk, kuva: h.kuva || PF_kuvanimi_(tk), nimi: h.nimi || '', valuuta: p.valuuta, kogus: p.kogus, ostuhind: p.kuluOma / p.kogus,
              hind: null, vaartus: null, soetus: p.kuluEur, kasum: null, kasumPr: null,
              tana: null, tanaPr: null, nadalPr: null, aastaPr: null };
    if (h.hind > 0) {
      var k = PF_kurss_(p.valuuta, hinnad);
      r.hind = h.hind;
      r.vaartus = p.kogus * h.hind * k;
      r.kasum = r.vaartus - p.kuluEur;
      r.kasumPr = p.kuluEur > 0 ? r.kasum / p.kuluEur : null;
      if (h.eelmine > 0) { r.tana = p.kogus * (h.hind - h.eelmine) * k; r.tanaPr = h.hind / h.eelmine - 1; tanaKokku += r.tana; }
      if (h.nadal > 0) r.nadalPr = h.hind / h.nadal - 1;
      if (h.algus > 0) r.aastaPr = h.hind / h.algus - 1;
      aktsiad += r.vaartus;
    } else {
      puudu.push(tk);
    }
    read.push(r);
  }
  read.sort(function (a, b) { return (b.vaartus || 0) - (a.vaartus || 0); });
  return { read: read, raha: s.raha, aktsiad: aktsiad, kokku: aktsiad + s.raha, netoSisse: s.netoSisse,
           realiseeritud: s.realiseeritud + s.korrektsioon, dividendid: s.dividendid, tasud: s.tasud,
           tana: tanaKokku, puudu: puudu };
}

/** Kirjutab Positsioonid lehe nullist (väärtused, valemeid pole). */
function PF_kirjutaPositsioonid_() {
  var hinnad = PF_loeHinnad_(), valja = [];
  var n = function (x, kohti) { return (typeof x === 'number' && isFinite(x)) ? PF_umarda_(x, kohti) : ''; };
  var pfd = PF_portfellid_();
  for (var i = 0; i < pfd.length; i++) {
    var nimi = pfd[i];
    if (!PF_loeTehingud_(nimi).length) continue;
    var s = PF_seis_(nimi, hinnad);
    for (var j = 0; j < s.read.length; j++) {
      var r = s.read[j];
      valja.push([nimi, r.ticker, r.kuva, r.nimi, r.valuuta, r.kogus, n(r.ostuhind, 4), n(r.hind, 4), n(r.vaartus, 2),
                  n(r.soetus, 2), n(r.kasum, 2), n(r.kasumPr, 4), n(r.tana, 2), n(r.tanaPr, 4), n(r.nadalPr, 4),
                  n(r.aastaPr, 4), s.kokku > 0 ? n(r.vaartus / s.kokku, 4) : '']);
    }
    valja.push([nimi, 'RAHA', 'Raha', 'Vaba raha', 'EUR', '', '', '', n(s.raha, 2), '', '', '', '', '', '', '',
                s.kokku > 0 ? n(s.raha / s.kokku, 4) : '']);
  }
  var sh = PF_leht_(PF_CFG.lehed.positsioonid), viimane = sh.getLastRow();
  if (viimane >= 2) sh.getRange(2, 1, viimane - 1, PF_POS_PAIS.length).clearContent();
  if (valja.length) sh.getRange(2, 1, valja.length, PF_POS_PAIS.length).setValues(valja);
}

/** Kokkuvõte live vaate jaoks. */
function PF_kokkuvote(nimi) {
  var s = PF_seis_(nimi, PF_loeHinnad_());
  return {
    vaartus: PF_umarda_(s.kokku, 2), aktsiad: PF_umarda_(s.aktsiad, 2), raha: PF_umarda_(s.raha, 2),
    netoSisse: PF_umarda_(s.netoSisse, 2), kasum: PF_umarda_(s.kokku - s.netoSisse, 2),
    realiseerimata: PF_umarda_(s.kokku - s.netoSisse - s.realiseeritud - s.dividendid, 2),
    realiseeritud: PF_umarda_(s.realiseeritud, 2), dividendid: PF_umarda_(s.dividendid, 2),
    tasud: PF_umarda_(s.tasud, 2), tana: PF_umarda_(s.tana, 2), hinnataTickerid: s.puudu
  };
}

/* ================================================================ tehingu lisamine */

/**
 * Näited:
 *   PF_lisaTehing({tyyp:'Ost',  ticker:'GOOGL', kogus:5, hind:340, tasu:1})
 *   PF_lisaTehing({tyyp:'Müük', ticker:'GOOGL', kogus:2, hind:345})
 *   PF_lisaTehing({tyyp:'Sissemakse', summa:500})
 *   PF_lisaTehing({tyyp:'Dividend', ticker:'VWRL.AS', summa:112.40})
 * Valikulised: kuupaev, valuuta (vaikimisi Hinnad lehelt), kurss (vaikimisi tänane), markus.
 * Uue tickeri puhul kontrollitakse kõigepealt, et Yahoo seda tunneb.
 */
function PF_lisaTehing(t) {
  if (!t) throw new Error('Tehing puudub');
  t.portfell = PF_konto_(t.portfell);
  if (PF_TYYBID.indexOf(t.tyyp) < 0) throw new Error('Tundmatu tüüp: ' + t.tyyp);
  var kaup = t.tyyp === 'Ost' || t.tyyp === 'Müük';
  var ticker = String(t.ticker || '').trim(), tasu = PF_num_(t.tasu) || 0;
  var kogus = '', hind = '', valuuta = 'EUR', kurss = 1, summa, uusTicker = false;

  if (kaup) {
    kogus = PF_num_(t.kogus); hind = PF_num_(t.hind);
    if (!ticker || !(kogus > 0) || !(hind >= 0)) throw new Error('Ost/müük vajab tickerit, kogust ja hinda');
    var hinnad = PF_loeHinnad_();
    if (t.tyyp === 'Müük') {
      var p = PF_arvuta_(PF_loeTehingud_(t.portfell)).pos[ticker];
      if (!p || p.kogus + 1e-9 < kogus) throw new Error('Müüa ei saa: ' + ticker + ' positsioon on ' + (p ? p.kogus : 0));
      valuuta = p.valuuta;
    } else {
      if (!hinnad[ticker] || !hinnad[ticker].valuuta) {
        var u = PF_tooHinnad_([ticker])[ticker];
        if (!u.ok && !t.valuuta) throw new Error('Tickerit ' + ticker + ' ei saanud kontrollida (' + u.viga + ') – paranda ticker või anna valuuta käsitsi');
        valuuta = u.ok ? u.valuuta : '';
        uusTicker = true;
      } else {
        valuuta = hinnad[ticker].valuuta;
      }
    }
    if (t.valuuta) valuuta = String(t.valuuta).toUpperCase();
    kurss = PF_num_(t.kurss);
    if (!(kurss > 0)) {
      if (valuuta !== 'EUR' && !(hinnad[PF_fxTicker_(valuuta)] && hinnad[PF_fxTicker_(valuuta)].hind > 0)) {
        var fx = PF_tooHinnad_([PF_fxTicker_(valuuta)])[PF_fxTicker_(valuuta)];
        if (fx.ok) hinnad[PF_fxTicker_(valuuta)] = fx;
        uusTicker = true;
      }
      kurss = PF_kurss_(valuuta, hinnad);
    }
    summa = PF_umarda_(kogus * hind * kurss, 2);
  } else {
    summa = PF_num_(t.summa);
    if (!(summa > 0) && t.tyyp !== 'Korrektsioon') throw new Error('Summa (EUR) puudub');
  }
  var kuupaev = t.kuupaev ? new Date(t.kuupaev) : new Date();
  PF_leht_(PF_CFG.lehed.tehingud).appendRow(
    [kuupaev, t.portfell, t.tyyp, ticker, kogus, hind, valuuta, PF_umarda_(kurss, 6), tasu, summa, t.markus || '']);
  if (uusTicker) PF_varskendaHinnad(true); else PF_kirjutaPositsioonid_();
  return t.tyyp + (ticker ? ' ' + ticker : '') + ' lisatud (' + summa + ' €)';
}

/* ================================================================ hetktõmmis ja osaku hind */

/** Perioodi tootlus, kui sissemaksed loetakse perioodi keskele (Modified Dietz). */
function PF_dietz_(vaartus, eelmineVaartus, netoSissePerioodis) {
  var alus = eelmineVaartus + netoSissePerioodis / 2;
  if (!(alus > 0)) return 0;
  return (vaartus - eelmineVaartus - netoSissePerioodis) / alus;
}

/** Aastatabelist osaku hinna rida: esimese aasta lõpp = 100. */
function PF_ajalooRead_(portfell, ajalugu) {
  var read = [], hind = 100;
  for (var i = 0; i < ajalugu.length; i++) {
    var a = ajalugu[i];
    if (i > 0) { var e = ajalugu[i - 1]; hind = hind * (1 + PF_dietz_(a.vaartus, e.vaartus, a.sisse - e.sisse)); }
    var rida = [new Date(a.aasta, 11, 31), portfell, a.vaartus, a.sisse, a.vaartus - a.sisse,
                PF_umarda_(a.vaartus / hind, 4), PF_umarda_(hind, 4), 'aastalõpp (hinnang)'];
    for (var k = 0; k < PF_CFG.vordlus.length; k++) rida.push('');     // täidab PF_taidaVordlus()
    read.push(rida);
  }
  return read;
}

/** Päevane hetktõmmis: värskendab hinnad ja kirjutab iga portfelli kohta rea lehele Ajalugu. */
function PF_hetktommis() {
  var logi = [PF_varskendaHinnad(true)];
  var pfd = PF_portfellid_();
  for (var i = 0; i < pfd.length; i++) {
    try { logi.push(PF_hetktommisYks_(pfd[i])); }
    catch (e) { logi.push(pfd[i] + ': VIGA – ' + e.message); }
  }
  Logger.log(logi.join('\n'));
  return logi.join('\n');
}

function PF_hetktommisYks_(nimi) {
  if (!PF_loeTehingud_(nimi).length) return nimi + ': tehinguid pole, jätan vahele';
  var hinnad = PF_loeHinnad_(), s = PF_seis_(nimi, hinnad);
  if (s.puudu.length) throw new Error('hind puudub: ' + s.puudu.join(', ') + ' – hetktõmmist ei kirjutatud');
  var vanad = [];
  for (var i = 0; i < s.read.length; i++) {
    if (String((hinnad[s.read[i].ticker] || {}).staatus).indexOf('VANA') === 0) vanad.push(s.read[i].ticker);
  }
  var vaartus = PF_umarda_(s.kokku, 2);

  var ah = PF_leht_(PF_CFG.lehed.ajalugu), viimane = ah.getLastRow();
  var read = viimane >= 2 ? ah.getRange(2, 1, viimane - 1, PF_AJALUGU_PAIS.length).getValues() : [], omad = [];
  for (var r = 0; r < read.length; r++) {
    if (String(read[r][1]).trim() === nimi && read[r][0] instanceof Date) {
      omad.push({ rida: r + 2, paev: PF_paev_(read[r][0]), vaartus: PF_num_(read[r][2]),
                  sisse: PF_num_(read[r][3]), hind: PF_num_(read[r][6]) });
    }
  }
  var tana = new Date(), sihtRida = viimane + 1, alus = omad.length ? omad[omad.length - 1] : null;
  if (alus && alus.paev === PF_paev_(tana)) {                   // sama päeva rida kirjutatakse üle
    sihtRida = alus.rida;
    alus = omad.length > 1 ? omad[omad.length - 2] : null;
  }
  var hind = 100;
  if (alus) hind = alus.hind * (1 + PF_dietz_(vaartus, alus.vaartus, s.netoSisse - alus.sisse));
  var rida = [tana, nimi, vaartus, PF_umarda_(s.netoSisse, 2), PF_umarda_(vaartus - s.netoSisse, 2),
              PF_umarda_(vaartus / hind, 4), PF_umarda_(hind, 4), vanad.length ? 'vana hind: ' + vanad.join(', ') : ''];
  for (var k = 0; k < PF_CFG.vordlus.length; k++) {
    var vh = hinnad[PF_CFG.vordlus[k]];
    rida.push(vh && vh.hind > 0 ? vh.hind : '');
  }
  PF_ajalooPais_(ah);
  ah.getRange(sihtRida, 1, 1, rida.length).setValues([rida]);
  return nimi + ': väärtus ' + vaartus + ' €, raha ' + PF_umarda_(s.raha, 2) + ' €, osaku hind ' + PF_umarda_(hind, 2);
}

/**
 * Päeva jälg: iga hinnavärskendusega üks rida portfelli kohta lehele "Päev" (portfelli ja võrdluse tänane muutus).
 * Leht luuakse vajadusel ise ja tühjendatakse uue päeva esimesel värskendusel. Lisapäringuid Yahoole ei tehta.
 */
function PF_logiPaev_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), pv = PF_CFG.paevaVordlus || PF_CFG.vordlus;
  var pais = ['Aeg', 'Portfell', 'Portfell %'].concat(pv.map(function (t) { return PF_kuvanimi_(t) + ' %'; }));
  var sh = ss.getSheetByName('Päev');
  if (!sh) { sh = ss.insertSheet('Päev'); sh.setFrozenRows(1); }
  var viimane = sh.getLastRow(), nyyd = new Date();
  if (viimane >= 2) {
    var esimene = sh.getRange(2, 1, 1, 1).getValues()[0][0];
    if (!(esimene instanceof Date) || PF_paev_(esimene) !== PF_paev_(nyyd)) { sh.getRange(2, 1, viimane - 1, pais.length).clearContent(); }
  }
  sh.getRange(1, 1, 1, pais.length).setValues([pais]).setFontWeight('bold');
  var hinnad = PF_loeHinnad_(), vb = [];
  for (var k = 0; k < pv.length; k++) {
    var h = hinnad[pv[k]] || {};
    vb.push(h.hind > 0 && h.eelmine > 0 ? PF_umarda_(h.hind / h.eelmine - 1, 5) : '');
  }
  var pfd = PF_portfellid_();
  for (var i = 0; i < pfd.length; i++) {
    var nimi = pfd[i];
    if (!PF_loeTehingud_(nimi).length) continue;
    var s = PF_seis_(nimi, hinnad), eilne = s.aktsiad - s.tana;
    if (s.puudu.length || !(eilne > 0)) continue;
    sh.appendRow([nyyd, nimi, PF_umarda_(s.tana / eilne, 5)].concat(vb));
  }
}

/** Kirjutab Ajalugu lehe päise (lisab võrdlusindeksite veerud, kui leht on tehtud vanema versiooniga). */
function PF_ajalooPais_(ah) {
  ah.getRange(1, 1, 1, PF_AJALUGU_PAIS.length).setValues([PF_AJALUGU_PAIS]).setFontWeight('bold');
}

/** Ühe tickeri päevased sulgemised alates kuupäevast. Tagastab {ok, read:[{d:'yyyy-MM-dd', c}]} või {ok:false, viga}. */
function PF_tooAjalugu_(ticker, algusSek) {
  var nowSek = Math.floor(Date.now() / 1000), hostid = ['query1', 'query2'], viga = '';
  for (var k = 0; k < hostid.length; k++) {
    if (k > 0) Utilities.sleep(2000);
    try {
      var url = 'https://' + hostid[k] + '.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) +
                '?period1=' + algusSek + '&period2=' + nowSek + '&interval=1d';
      var r = UrlFetchApp.fetchAll([{ url: url, muteHttpExceptions: true }])[0];
      if (r.getResponseCode() !== 200) { viga = 'HTTP ' + r.getResponseCode(); continue; }
      var res = JSON.parse(r.getContentText()).chart.result[0];
      var ts = res.timestamp || [], cl = res.indicators.quote[0].close || [], nihe = (res.meta && res.meta.gmtoffset) || 0, read = [];
      for (var i = 0; i < ts.length; i++) {
        if (cl[i] === null || cl[i] === undefined) continue;
        read.push({ d: new Date((ts[i] + nihe) * 1000).toISOString().slice(0, 10), c: cl[i] });
      }
      return { ok: true, read: read };
    } catch (e) { viga = String(e.message || e).slice(0, 60); }
  }
  return { ok: false, viga: viga };
}

/**
 * Täidab lehel Ajalugu võrdlusindeksite tühjad lahtrid (nt aastalõpu read) selle päeva sulgemistasemega.
 * Käivita üks kord pärast uuendust; edaspidi kirjutab hetktõmmis taseme ise.
 */
function PF_taidaVordlus() {
  var ah = PF_leht_(PF_CFG.lehed.ajalugu), viimane = ah.getLastRow();
  if (viimane < 2) return 'Ajalugu on tühi';
  // Kui veerus on varasema võrdlusindeksi andmed (päis ei klapi), tühjendatakse veerg enne täitmist.
  var pais = ah.getRange(1, 1, 1, PF_AJALUGU_PAIS.length).getValues()[0], logi = [];
  for (var c = PF_AJALUGU_ALUS; c < PF_AJALUGU_PAIS.length; c++) {
    if (String(pais[c]).trim() && String(pais[c]).trim() !== PF_AJALUGU_PAIS[c]) {
      ah.getRange(2, c + 1, viimane - 1, 1).clearContent();
      logi.push('Veerg "' + pais[c] + '" tühjendatud ja asendatud: ' + PF_AJALUGU_PAIS[c]);
    }
  }
  // Varasemast versioonist jäänud lisaveerud (nt teine võrdlusindeks) eemaldatakse.
  var ule = ah.getRange(1, PF_AJALUGU_PAIS.length + 1, 1, 3).getValues()[0];
  for (var u = 0; u < ule.length; u++) {
    if (String(ule[u]).trim()) {
      ah.getRange(1, PF_AJALUGU_PAIS.length + 1 + u, viimane, 1).clearContent();
      logi.push('Veerg "' + ule[u] + '" eemaldatud');
    }
  }
  PF_ajalooPais_(ah);
  var v = ah.getRange(2, 1, viimane - 1, PF_AJALUGU_PAIS.length).getValues();
  for (var k = 0; k < PF_CFG.vordlus.length; k++) {
    var t = PF_CFG.vordlus[k], col = PF_AJALUGU_ALUS + k, vaja = [], varaseim = null;
    for (var i = 0; i < v.length; i++) {
      if (v[i][0] instanceof Date && !(PF_num_(v[i][col]) > 0)) { vaja.push(i); if (!varaseim || v[i][0] < varaseim) varaseim = v[i][0]; }
    }
    if (!vaja.length) { logi.push(PF_kuvanimi_(t) + ': kõik read täidetud'); continue; }
    var aj = PF_tooAjalugu_(t, Math.floor(varaseim.getTime() / 1000) - 14 * 86400);
    if (!aj.ok) { logi.push(PF_kuvanimi_(t) + ': ei saanud ajalugu (' + aj.viga + ')'); continue; }
    var taidetud = 0, veerg = [];
    for (var r = 0; r < v.length; r++) veerg.push([v[r][col]]);
    for (var j = 0; j < vaja.length; j++) {
      var paev = PF_paev_(v[vaja[j]][0]), leitud = null;
      for (var m = 0; m < aj.read.length && aj.read[m].d <= paev; m++) leitud = aj.read[m].c;
      if (leitud !== null) { veerg[vaja[j]][0] = PF_umarda_(leitud, 2); taidetud++; }
    }
    ah.getRange(2, col + 1, veerg.length, 1).setValues(veerg);
    logi.push(PF_kuvanimi_(t) + ': täidetud ' + taidetud + '/' + vaja.length + ' rida');
  }
  Logger.log(logi.join('\n'));
  return logi.join('\n');
}

/* ================================================================ seadistus, triggerid, menüü */

function PF_seadista() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), L = PF_CFG.lehed, nimi;
  for (var k in L) {
    if (ss.getSheetByName(L[k])) throw new Error('Leht "' + L[k] + '" on juba olemas. Seadistus on mõeldud tühja faili jaoks.');
  }
  var teeLeht = function (nimi, pais) {
    var sh = ss.insertSheet(nimi);
    sh.getRange(1, 1, 1, pais.length).setValues([pais]).setFontWeight('bold');
    sh.setFrozenRows(1);
    return sh;
  };
  var th = teeLeht(L.tehingud, PF_TEHING_PAIS);
  var hh = teeLeht(L.hinnad, PF_HIND_PAIS);
  var ph = teeLeht(L.positsioonid, PF_POS_PAIS);
  var ah = teeLeht(L.ajalugu, PF_AJALUGU_PAIS);
  var sh = teeLeht(L.seaded, ['Portfell', 'Vara', 'Väärtus €']);
  th.getRange(2, 1, 3000, 1).setNumberFormat('dd.MM.yyyy');
  ah.getRange(2, 1, 6000, 1).setNumberFormat('dd.MM.yyyy');
  hh.getRange(2, 11, 500, 1).setNumberFormat('dd.MM.yyyy HH:mm');
  ph.getRange(2, 12, 500, 1).setNumberFormat('0.00%');
  ph.getRange(2, 14, 500, 4).setNumberFormat('0.00%');

  // 1) tickerid Hinnad lehele ja esimene hinnapäring
  var tickerid = [], olemas = {};
  var lisa = function (t) { if (!olemas[t]) { olemas[t] = true; tickerid.push([t]); } };
  for (nimi in PF_CFG.algseis) {
    var pp = PF_CFG.algseis[nimi].positsioonid;
    for (var i = 0; i < pp.length; i++) { lisa(pp[i][0]); if (pp[i][1] !== 'EUR') lisa(PF_fxTicker_(pp[i][1])); }
  }
  lisa(PF_fxTicker_('USD'));
  for (var q = 0; q < PF_CFG.turg.length; q++) lisa(PF_CFG.turg[q]);
  hh.getRange(2, 1, tickerid.length, 1).setValues(tickerid);
  var logi = ['Hinnad: ' + PF_varskendaHinnad(true)];
  var hinnad = PF_loeHinnad_();

  // 2) algseisu tehingud
  var tana = new Date(), tehinguRead = [], ajalooRead = [], varad = [];
  for (nimi in PF_CFG.algseis) {
    var a = PF_CFG.algseis[nimi], kuluEur = 0, ostud = [];
    for (var j = 0; j < a.positsioonid.length; j++) {
      var p = a.positsioonid[j], kurss = PF_kurss_(p[1], hinnad), eur = p[3] * p[2] * kurss;
      kuluEur += eur;
      ostud.push([tana, nimi, 'Ost', p[0], p[3], p[2], p[1], PF_umarda_(kurss, 6), 0, PF_umarda_(eur, 2), 'algseis']);
    }
    // Vahe = varem realiseeritud kasum + dividendid − tasud, mis on juba positsioonidesse tagasi pandud.
    var korr = PF_umarda_(kuluEur + a.raha - a.netoSisse, 2);
    tehinguRead.push([tana, nimi, 'Sissemakse', '', '', '', 'EUR', 1, 0, a.netoSisse, 'algseis: netosissemaksed kokku']);
    tehinguRead.push([tana, nimi, 'Korrektsioon', '', '', '', 'EUR', 1, 0, korr, 'algseis: varasem realiseeritud kasum']);
    tehinguRead = tehinguRead.concat(ostud);
    ajalooRead = ajalooRead.concat(PF_ajalooRead_(nimi, a.ajalugu || []));
    for (var m = 0; m < (a.muudVarad || []).length; m++) varad.push([nimi, a.muudVarad[m], '']);
    logi.push(nimi + ': ' + a.positsioonid.length + ' positsiooni, soetusmaksumus ' + PF_umarda_(kuluEur, 0) +
              ' €, korrektsioon ' + korr + ' €');
  }
  if (tehinguRead.length) th.getRange(2, 1, tehinguRead.length, PF_TEHING_PAIS.length).setValues(tehinguRead);
  if (ajalooRead.length) ah.getRange(2, 1, ajalooRead.length, PF_AJALUGU_PAIS.length).setValues(ajalooRead);
  if (varad.length) sh.getRange(2, 1, varad.length, 3).setValues(varad);

  // 3) positsioonid ja esimene hetktõmmis
  PF_kirjutaPositsioonid_();
  for (nimi in PF_CFG.algseis) {
    try { logi.push(PF_hetktommisYks_(nimi)); } catch (e) { logi.push(nimi + ': hetktõmmis jäi tegemata – ' + e.message); }
  }
  try { logi.push(PF_paigaldaTriggerid()); } catch (te) { logi.push('Triggerid jäid paigaldamata (' + te.message + ') – käivita PF_paigaldaTriggerid()'); }
  Logger.log(logi.join('\n'));
  return logi.join('\n');
}

function PF_paigaldaTriggerid() {
  var t = ScriptApp.getProjectTriggers();
  for (var i = 0; i < t.length; i++) {
    var f = t[i].getHandlerFunction();
    if (f === 'PF_varskendaHinnad' || f === 'PF_hetktommis') ScriptApp.deleteTrigger(t[i]);
  }
  ScriptApp.newTrigger('PF_varskendaHinnad').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('PF_hetktommis').timeBased().everyDays(1).atHour(23).inTimezone(PF_CFG.ajavoond).create();
  return 'Hinnad iga 15 min (paus 00–08), hetktõmmis iga päev kell 23–24';
}

function PF_varskendaKohe() { return PF_varskendaHinnad(true); }

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Portfell')
    .addItem('Värskenda hinnad', 'PF_varskendaKohe')
    .addItem('Tee hetktõmmis', 'PF_hetktommis')
    .addToUi();
}
