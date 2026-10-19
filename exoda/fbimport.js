// Μετατροπή backup του Fast Budget (βάση SQLite) στη μορφή της εφαρμογής.
// Δουλεύει στον browser (window.FBImport) και σε node (module.exports).
(function (root) {
  const ICONS = {
    ic_cup: '🍴', ic_base_shopping: '🛒', ic_base_road: '🛣️', ic_party_hat: '🎉', ic_home: '🏠',
    ic_family: '👨‍👩‍👧', ic_base_health: '❤️', ic_plane: '✈️', ic_sheet_red: '🧾', ic_plate_fork_knife: '🍽️',
    ic_coffee: '☕', ic_cocktail: '🍹', ic_t_shirt: '👕', ic_shoe: '👟', ic_hard_drive: '💻', ic_gift: '🎁',
    ic_fuel: '⛽', ic_car: '🚗', ic_coach: '🚌', ic_umbrella: '☂️', ic_journal: '📚', ic_house_rent: '🏢',
    ic_power_cord: '💡', ic_water_drop: '💧', ic_cellular: '📱', ic_pacifier: '🍼', ic_board: '📋',
    ic_health: '💊', ic_weights: '🏋️', ic_bed: '🛏️', ic_courthouse: '🏛️', ic_cigarette: '🚬',
    ic_base_incomes: '💰', ic_sheet_green: '🧾', ic_workbag: '💼', ic_tools: '🔧', ic_piggy_bank: '🐷'
  };
  const PERIOD = {0: 'd', 1: 'w', 2: 'm', 3: 'y'};

  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Athens', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  function local(ms) {
    const p = {};
    for (const x of fmt.formatToParts(new Date(Number(ms)))) p[x.type] = x.value;
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  }
  const round2 = v => Math.round(Number(v || 0) * 100) / 100;
  const clean = s => (s == null ? '' : String(s)).trim();

  function rows(db, sql) {
    const out = [];
    let res;
    try { res = db.exec(sql); } catch (e) { return out; }
    if (!res.length) return out;
    const {columns, values} = res[0];
    for (const v of values) { const o = {}; columns.forEach((c, i) => o[c] = v[i]); out.push(o); }
    return out;
  }

  function isSqlite(bytes) {
    const sig = 'SQLite format 3';
    for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig.charCodeAt(i)) return false;
    return true;
  }

  function convert(SQL, bytes) {
    if (!isSqlite(bytes)) throw new Error('Το αρχείο δεν είναι backup του Fast Budget');
    const db = new SQL.Database(bytes);
    try {
      const tables = rows(db, "select name from sqlite_master where type='table'").map(r => r.name);
      if (!tables.includes('income_or_expense')) throw new Error('Το αρχείο δεν είναι backup του Fast Budget');

      // ---- κατηγορίες: ομάδες και υποκατηγορίες ----
      const raw = rows(db, 'select _id,name,ei,icon_name,parent_id,position from categories_table order by ei,position,_id');
      const byId = {};
      raw.forEach(r => byId[r._id] = r);
      const cats = [], seen = new Set();
      let order = 0;
      const push = (n, t, g, ic) => {
        const key = t + '|' + n;
        if (!n || seen.has(key)) return;
        seen.add(key);
        cats.push({n, t, g, ic: ic || '🏷️', o: ++order});
      };
      for (const t of ['e', 'i']) {
        const ei = t === 'e' ? 0 : 1;
        const groups = raw.filter(r => r.ei === ei && !r.parent_id);
        for (const g of groups) {
          push(clean(g.name), t, '', ICONS[g.icon_name]);
          raw.filter(r => r.parent_id === g._id)
             .sort((a, b) => a.position - b.position)
             .forEach(ch => { if (clean(ch.name) !== clean(g.name)) push(clean(ch.name), t, clean(g.name), ICONS[ch.icon_name]); });
        }
        // υποκατηγορίες με γονέα που λείπει: γίνονται ομάδες
        raw.filter(r => r.ei === ei && r.parent_id && !byId[r.parent_id]).forEach(r => push(clean(r.name), t, '', ICONS[r.icon_name]));
      }

      // ---- λογαριασμοί ----
      const accs = rows(db, 'select name,initial_funds from account order by position,_id')
        .map(r => ({n: clean(r.name), init: round2(r.initial_funds)}));
      for (const c of rows(db, 'select name from credit_cards')) accs.push({n: clean(c.name), init: 0});

      // ---- κινήσεις ----
      const noteOf = r => {
        const n = clean(r.notes), w = clean(r.from_or_to);
        if (!w || w === n) return n;
        return n ? `${n} · ${w}` : w;
      };
      const tx = rows(db, 'select _id,i_e,value,category,account,date,from_or_to,notes,is_refund from income_or_expense order by date desc')
        .map(r => {
          let t = r.i_e === 1 ? 'i' : 'e', v = round2(r.value);
          if (v < 0) { v = -v; t = t === 'e' ? 'i' : 'e'; }
          return {id: 'fb' + r._id, d: local(r.date), t, v, c: clean(r.category), n: noteOf(r), a: clean(r.account) || (accs[0] || {}).n || 'Πορτοφόλι'};
        });
      // κατηγορίες που χρησιμοποιούνται αλλά δεν υπάρχουν στη λίστα
      tx.forEach(x => { if (x.c && !seen.has(x.t + '|' + x.c)) push(x.c, x.t, '', '🏷️'); });

      // ---- επαναλαμβανόμενες ----
      const recs = rows(db, 'select * from scheduled_transaction order by _id').map(r => {
        const nx = local(r.next_date).slice(0, 10);
        return {
          id: 'fb' + r._id, t: r.i_e === 1 ? 'i' : 'e', v: round2(r.value), c: clean(r.category), n: noteOf(r),
          a: clean(r.account) || (accs[0] || {}).n || 'Πορτοφόλι',
          ev: Math.max(1, Number(r.repeat_every) || 1), u: PERIOD[r.period] || 'm',
          nx, dy: Number(nx.slice(8, 10)), rm: Number(r.number_of_repeat) > 0 ? Number(r.number_of_repeat) : ''
        };
      });
      recs.forEach(x => { if (x.c && !seen.has(x.t + '|' + x.c)) push(x.c, x.t, '', '🏷️'); });

      if (!accs.length) accs.push({n: 'Πορτοφόλι', init: 0});
      const bal = accs.reduce((s, a) => s + a.init, 0) + tx.reduce((s, x) => s + (x.t === 'i' ? x.v : -x.v), 0);
      return {
        tx, cats, recs, accs,
        stats: {
          tx: tx.length, cats: cats.length, recs: recs.length, balance: round2(bal),
          from: tx.length ? tx[tx.length - 1].d.slice(0, 10) : '', to: tx.length ? tx[0].d.slice(0, 10) : ''
        }
      };
    } finally {
      db.close();
    }
  }

  const api = {convert, isSqlite, local};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FBImport = api;
})(this);
