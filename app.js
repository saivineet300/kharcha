/* Kharcha — expenses, budgets, bills, goals, splits, calculator and money tools.
   Plain JS, no build step. Data lives in the Claude artifact store when available,
   otherwise in this browser's localStorage. */
(() => {
  'use strict';

  // ============================================================
  // Helpers
  // ============================================================
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const pad2 = (n) => String(n).padStart(2, '0');
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + f(x), 0);
  const round2 = (n) => Math.round(n * 100) / 100;
  const ic = (name, cls = '') => `<span class="ms ${cls}" aria-hidden="true">${name}</span>`;
  const plural = (n, word, many) => `${n} ${n === 1 ? word : many || word + 's'}`;
  const num = (v) => {
    const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };

  // ---------- Where the book lives ----------
  // Inside a Claude artifact: the Claude account store. On the website with firebase-config.js
  // filled in: Google sign-in + Firestore. Otherwise: this browser only.
  const IN_CLAUDE = (() => { try { return !!(window.claude && typeof window.claude.use === 'function'); } catch { return false; } })();
  const FB_CONFIG = !IN_CLAUDE && window.KHARCHA_FIREBASE && window.KHARCHA_FIREBASE.apiKey ? window.KHARCHA_FIREBASE : null;
  const FB_SDK = 'https://www.gstatic.com/firebasejs/12.19.0';
  const session = { mode: 'local', user: null, books: [], invites: [], bookId: 'personal', book: null, unsubs: [], openSeq: 0 };
  let fb = null;
  // JSON with sorted keys, so a document read back from a server compares equal to the local copy.
  const stableJson = (v) => JSON.stringify(v, (k, val) => (val && typeof val === 'object' && !Array.isArray(val)
    ? Object.keys(val).sort().reduce((o, key) => { o[key] = val[key]; return o; }, {}) : val));
  const safeId = (v) => String(v ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);

  // ---------- Dates (all local, stored as YYYY-MM-DD) ----------
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MON = MONTHS.map((m) => m.slice(0, 3));
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const toDateStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const parseDate = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); };
  const todayStr = () => toDateStr(new Date());
  const thisMonth = () => todayStr().slice(0, 7);
  const shiftMonth = (key, n) => { const [y, m] = key.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; };
  const daysInMonth = (key) => { const [y, m] = key.split('-').map(Number); return new Date(y, m, 0).getDate(); };
  const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return toDateStr(d); };
  const diffDays = (a, b) => Math.round((parseDate(a) - parseDate(b)) / 864e5);
  const monthLabel = (key) => { const [y, m] = key.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; };
  const monthShort = (key) => MON[Number(key.slice(5, 7)) - 1];
  const dateLabel = (s) => {
    const d = parseDate(s);
    const yr = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : '';
    return `${d.getDate()} ${MON[d.getMonth()]}${yr}`;
  };
  const dayLabel = (s) => {
    const t = todayStr();
    if (s === t) return 'Today';
    if (s === addDays(t, -1)) return 'Yesterday';
    if (s === addDays(t, 1)) return 'Tomorrow';
    const d = parseDate(s);
    return `${WD[d.getDay()]}, ${dateLabel(s)}`;
  };
  const isDateStr = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

  // ---------- Money ----------
  const CURRENCIES = [
    { code: 'INR', name: 'Indian rupee', locale: 'en-IN' },
    { code: 'USD', name: 'US dollar', locale: 'en-US' },
    { code: 'EUR', name: 'Euro', locale: 'en-IE' },
    { code: 'GBP', name: 'British pound', locale: 'en-GB' },
    { code: 'AED', name: 'UAE dirham', locale: 'en-AE' },
    { code: 'SGD', name: 'Singapore dollar', locale: 'en-SG' },
    { code: 'AUD', name: 'Australian dollar', locale: 'en-AU' },
    { code: 'CAD', name: 'Canadian dollar', locale: 'en-CA' },
    { code: 'JPY', name: 'Japanese yen', locale: 'ja-JP' },
  ];
  let cur = { code: 'INR', locale: 'en-IN', symbol: '₹' };
  let fmtWhole, fmtDec, fmtNum;
  function setCurrency(code) {
    const c = CURRENCIES.find((x) => x.code === code) || CURRENCIES[0];
    fmtWhole = new Intl.NumberFormat(c.locale, { style: 'currency', currency: c.code, maximumFractionDigits: 0, minimumFractionDigits: 0 });
    fmtDec = c.code === 'JPY' ? fmtWhole : new Intl.NumberFormat(c.locale, { style: 'currency', currency: c.code, minimumFractionDigits: 2, maximumFractionDigits: 2 });
    fmtNum = new Intl.NumberFormat(c.locale, { maximumFractionDigits: 2 });
    const sym = fmtWhole.formatToParts(0).find((p) => p.type === 'currency');
    cur = { code: c.code, locale: c.locale, symbol: sym ? sym.value : c.code };
  }
  function money(n, opts = {}) {
    const v = Number(n) || 0;
    const frac = Math.abs(v - Math.round(v)) > 0.004;
    const s = frac && !opts.whole ? fmtDec.format(v) : fmtWhole.format(Math.round(v));
    return opts.sign && v > 0 ? '+' + s : s;
  }
  const trim1 = (x) => (Math.round(x * 10) / 10).toString().replace(/\.0$/, '');
  function compact(n) {
    const v = Math.abs(n), sg = n < 0 ? '-' : '';
    if (cur.code === 'INR') {
      if (v >= 1e7) return `${sg}₹${trim1(v / 1e7)}Cr`;
      if (v >= 1e5) return `${sg}₹${trim1(v / 1e5)}L`;
      if (v >= 1e3) return `${sg}₹${trim1(v / 1e3)}K`;
      return `${sg}₹${Math.round(v)}`;
    }
    return new Intl.NumberFormat(cur.locale, { style: 'currency', currency: cur.code, notation: 'compact', maximumFractionDigits: 1 }).format(n);
  }
  const fmtN = (n) => fmtNum.format(n);
  const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;

  // ============================================================
  // Categories, payment modes
  // ============================================================
  const EXPENSE_CATS = [
    { id: 'food', name: 'Food & dining', short: 'Food', icon: 'restaurant', h: 24 },
    { id: 'groceries', name: 'Groceries', short: 'Groceries', icon: 'local_grocery_store', h: 88 },
    { id: 'transport', name: 'Transport', short: 'Transport', icon: 'directions_bus', h: 210 },
    { id: 'fuel', name: 'Fuel', short: 'Fuel', icon: 'local_gas_station', h: 4 },
    { id: 'shopping', name: 'Shopping', short: 'Shopping', icon: 'shopping_bag', h: 318 },
    { id: 'bills', name: 'Bills & utilities', short: 'Bills', icon: 'receipt_long', h: 44 },
    { id: 'rent', name: 'Rent & housing', short: 'Rent', icon: 'home', h: 258 },
    { id: 'recharge', name: 'Mobile & internet', short: 'Recharge', icon: 'smartphone', h: 188 },
    { id: 'health', name: 'Health', short: 'Health', icon: 'medical_services', h: 350 },
    { id: 'entertainment', name: 'Entertainment', short: 'Fun', icon: 'movie', h: 280 },
    { id: 'education', name: 'Education', short: 'Education', icon: 'school', h: 232 },
    { id: 'travel', name: 'Travel', short: 'Travel', icon: 'flight', h: 198 },
    { id: 'personal', name: 'Personal care', short: 'Personal', icon: 'spa', h: 300 },
    { id: 'gifts', name: 'Gifts & donations', short: 'Gifts', icon: 'redeem', h: 336 },
    { id: 'emi', name: 'EMI & loans', short: 'EMI', icon: 'account_balance', h: 30 },
    { id: 'invest', name: 'Investments', short: 'Invest', icon: 'trending_up', h: 150 },
    { id: 'subs', name: 'Subscriptions', short: 'Subs', icon: 'subscriptions', h: 268 },
    { id: 'other', name: 'Other', short: 'Other', icon: 'category', h: 140, s: 0 },
  ];
  const INCOME_CATS = [
    { id: 'salary', name: 'Salary', short: 'Salary', icon: 'payments', h: 145 },
    { id: 'business', name: 'Business', short: 'Business', icon: 'storefront', h: 200 },
    { id: 'freelance', name: 'Freelance', short: 'Freelance', icon: 'work', h: 260 },
    { id: 'interest', name: 'Interest & dividends', short: 'Interest', icon: 'savings', h: 40 },
    { id: 'refund', name: 'Refunds & cashback', short: 'Refunds', icon: 'currency_exchange', h: 180 },
    { id: 'giftin', name: 'Gifts received', short: 'Gifts', icon: 'redeem', h: 330 },
    { id: 'otherin', name: 'Other income', short: 'Other', icon: 'add_card', h: 140, s: 0 },
  ];
  const UNKNOWN_CAT = { id: '?', name: 'Uncategorised', short: 'Other', icon: 'category', h: 140, s: 0 };
  const MODES = [
    { id: 'upi', name: 'UPI', icon: 'qr_code_scanner', color: 'var(--s1)' },
    { id: 'cash', name: 'Cash', icon: 'payments', color: 'var(--s2)' },
    { id: 'debit', name: 'Debit card', icon: 'credit_card', color: 'var(--s3)' },
    { id: 'credit', name: 'Credit card', icon: 'credit_score', color: 'var(--s4)' },
    { id: 'netbanking', name: 'Net banking', icon: 'account_balance', color: 'var(--s5)' },
    { id: 'wallet', name: 'Wallet', icon: 'account_balance_wallet', color: 'var(--s6)' },
  ];
  const modeOf = (id) => MODES.find((m) => m.id === id) || MODES[0];
  const ICON_CHOICES = ['pets', 'child_care', 'sports_esports', 'fitness_center', 'local_cafe', 'local_bar', 'checkroom', 'build', 'local_laundry_service', 'directions_car', 'two_wheeler', 'local_taxi', 'train', 'hotel', 'park', 'celebration', 'cake', 'music_note', 'menu_book', 'laptop', 'headphones', 'local_pharmacy', 'volunteer_activism', 'water_drop', 'bolt', 'wifi', 'tv', 'savings', 'work', 'sell', 'favorite', 'beach_access', 'home', 'smartphone', 'flight', 'school'];
  const GOAL_ICONS = ['savings', 'flight', 'smartphone', 'directions_car', 'two_wheeler', 'home', 'school', 'laptop', 'favorite', 'beach_access', 'celebration', 'medical_services'];
  const HUES = [4, 24, 44, 88, 145, 188, 210, 232, 258, 280, 318, 340];

  function allCats(type) {
    return [...(type === 'income' ? INCOME_CATS : EXPENSE_CATS), ...state.customCats.filter((c) => c.type === type)];
  }
  function getCat(id) {
    return EXPENSE_CATS.find((c) => c.id === id) || INCOME_CATS.find((c) => c.id === id) || state.customCats.find((c) => c.id === id) || UNKNOWN_CAT;
  }
  const catIco = (c, size = '') => `<span class="cat-ico ${size}" style="--h:${Number(c.h) || 0};--s:${c.s ?? 1}">${ic(c.icon)}</span>`;

  // ============================================================
  // State
  // ============================================================
  const DEFAULT_SETTINGS = { currency: 'INR', theme: 'system', name: '' };
  const emptyData = () => ({ txns: [], budgets: { total: 0, cats: {} }, goals: [], bills: [], splits: [], customCats: [] });
  const state = { ...emptyData(), settings: { ...DEFAULT_SETTINGS }, sample: false, started: false, loaded: false };
  const ui = {
    tab: 'home',
    month: thisMonth(),
    filter: { q: '', type: 'all', cat: '', mode: '' },
    insight: 'expense',
    plan: 'budgets',
    tools: 'calc',
    theme: 'system',
  };
  const toolVals = {};
  // While someone with their own data browses sample data, their book waits here untouched.
  let sampleStash = null;
  const takeData = () => JSON.parse(JSON.stringify({ txns: state.txns, budgets: state.budgets, goals: state.goals, bills: state.bills, splits: state.splits, customCats: state.customCats }));
  const calc = { expr: '', done: false, error: '', history: [] };

  // Per-viewer conveniences (tab, theme, calculator history) — never the book itself.
  const PREFS_KEY = 'kharcha.prefs';
  let prefs = {};
  function prefsLoad() {
    try { prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { prefs = {}; }
    return prefs;
  }
  function prefsSave() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs, tab: ui.tab, plan: ui.plan, tools: ui.tools, insight: ui.insight, theme: ui.theme, calc: calc.history.slice(0, 30) }));
    } catch { /* storage blocked: preferences just reset next visit */ }
  }

  // ============================================================
  // Storage backends
  // ============================================================
  const LS_PREFIX = 'kharcha.v1.';
  const localStore = {
    kind: 'device',
    async loadAll() {
      const out = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(LS_PREFIX)) {
          try { out[k.slice(LS_PREFIX.length)] = JSON.parse(localStorage.getItem(k)); } catch { /* skip corrupt doc */ }
        }
      }
      return out;
    },
    async set(key, data) { localStorage.setItem(LS_PREFIX + key, JSON.stringify(data)); },
    async del(key) { localStorage.removeItem(LS_PREFIX + key); },
  };
  const memoryStore = {
    kind: 'memory', docs: {},
    async loadAll() { return JSON.parse(JSON.stringify(this.docs)); },
    async set(key, data) { this.docs[key] = data; },
    async del(key) { delete this.docs[key]; },
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function withRetry(fn) {
    try { return await fn(); } catch (e) {
      if (e && e.code === 'unavailable') { await wait(400 + Math.random() * 600); return fn(); }
      throw e;
    }
  }
  function cloudStore(db, userId) {
    const col = db.collection('data/users/' + userId);
    return {
      kind: 'cloud',
      async loadAll() {
        const snap = await withRetry(() => col.limit(1000).get());
        const out = {};
        snap.docs.forEach((d) => { if (d.exists) out[d.id] = JSON.parse(JSON.stringify(d.data())); });
        return out;
      },
      set: (key, data) => withRetry(() => col.doc(key).set(data)),
      del: (key) => withRetry(() => col.doc(key).delete()),
    };
  }
  const capUse = (name) => {
    try {
      if (window.claude && typeof window.claude.use === 'function') return window.claude.use(name).catch(() => null);
    } catch { /* not in a viewer */ }
    return Promise.resolve(null);
  };
  function localWorks() {
    try { const k = LS_PREFIX + '__t'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return true; } catch { return false; }
  }
  async function pickStore() {
    const [db, user] = await Promise.all([capUse('db'), capUse('user')]);
    if (db && user) {
      try {
        const id = await user.id();
        if (id) return cloudStore(db, id);
      } catch { /* fall through to device storage */ }
    }
    return localWorks() ? localStore : memoryStore;
  }
  let store = memoryStore;
  const downloadsCap = capUse('downloads');

  // ---------- Documents <-> state ----------
  const ITEM_COLS = ['txns', 'goals', 'bills', 'splits'];
  function buildDocs() {
    const meta = { v: 1, started: true, settings: state.settings, budgets: state.budgets, customCats: state.customCats };
    if (store.granular) {
      // One document per entry, so two people editing different entries never overwrite each other.
      const out = { 'meta/main': meta };
      for (const col of ITEM_COLS) for (const x of state[col]) out[`${col}/${x.id}`] = x;
      return out;
    }
    const docs = {
      meta,
      goals: { items: state.goals },
      bills: { items: state.bills },
      splits: { items: state.splits },
    };
    for (const t of state.txns) {
      const k = 'tx-' + t.date.slice(0, 7);
      (docs[k] || (docs[k] = { items: [] })).items.push(t);
    }
    return docs;
  }
  const hasBook = (docs) => !!docs.meta || !!docs['meta/main'] || Object.keys(docs).some((k) => k.startsWith('tx-') || k.startsWith('txns/'));
  function applyDocs(docs) {
    if (Object.keys(docs).some((k) => k.includes('/'))) {
      const m = docs['meta/main'] || {};
      const pick = (col) => Object.keys(docs).filter((k) => k.startsWith(col + '/')).map((k) => ({ ...docs[k], id: k.slice(col.length + 1) }));
      const data = { settings: m.settings, budgets: m.budgets, customCats: m.customCats, txns: pick('txns'), goals: pick('goals'), bills: pick('bills'), splits: pick('splits') };
      Object.assign(state, sanitizeData(data), { sample: false, started: true });
      return;
    }
    const m = docs.meta || {};
    const data = {
      settings: m.settings, budgets: m.budgets, customCats: m.customCats,
      goals: docs.goals && docs.goals.items, bills: docs.bills && docs.bills.items, splits: docs.splits && docs.splits.items,
      txns: Object.keys(docs).filter((k) => k.startsWith('tx-')).flatMap((k) => (docs[k] && docs[k].items) || []),
    };
    Object.assign(state, sanitizeData(data), { sample: false, started: true });
  }
  function sanitizeData(d) {
    const str = (v, max = 80) => String(v ?? '').slice(0, max);
    const pos = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? round2(n) : 0; };
    const arr = (v) => (Array.isArray(v) ? v : []);
    const settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
    if (!CURRENCIES.some((c) => c.code === settings.currency)) settings.currency = 'INR';
    if (!['system', 'light', 'dark'].includes(settings.theme)) settings.theme = 'system';
    settings.name = str(settings.name, 40);
    const customCats = arr(d.customCats).filter((c) => c && c.id && c.name).map((c) => ({
      id: str(c.id, 40), name: str(c.name, 30), short: str(c.name, 12), type: c.type === 'income' ? 'income' : 'expense',
      icon: ICON_CHOICES.includes(c.icon) ? c.icon : 'sell', h: clamp(Number(c.h) || 0, 0, 360),
    }));
    const txns = arr(d.txns).filter((t) => t && isDateStr(t.date) && pos(t.amount) > 0).map((t) => ({
      id: safeId(t.id) || uid(), type: t.type === 'income' ? 'income' : 'expense', amount: pos(t.amount),
      cat: str(t.cat, 40) || 'other', mode: MODES.some((m) => m.id === t.mode) ? t.mode : 'upi',
      date: t.date, note: str(t.note), ts: Number(t.ts) || 0, ...(t.by ? { by: str(t.by, 128) } : {}),
      ...(t.billId ? { billId: str(t.billId, 40) } : {}), ...(t.splitId ? { splitId: str(t.splitId, 40) } : {}),
    }));
    const b = d.budgets || {};
    const cats = {};
    Object.entries(b.cats || {}).forEach(([k, v]) => { if (pos(v)) cats[str(k, 40)] = pos(v); });
    const goals = arr(d.goals).filter((g) => g && g.name).map((g) => ({
      id: safeId(g.id) || uid(), name: str(g.name, 40), icon: GOAL_ICONS.includes(g.icon) ? g.icon : 'savings',
      target: pos(g.target), saved: Math.max(0, round2(Number(g.saved) || 0)), deadline: isDateStr(g.deadline) ? g.deadline : '',
      h: clamp(Number(g.h) || 145, 0, 360),
    }));
    const FREQ = ['monthly', 'quarterly', 'yearly', 'weekly'];
    const bills = arr(d.bills).filter((x) => x && x.name && isDateStr(x.nextDue)).map((x) => ({
      id: safeId(x.id) || uid(), name: str(x.name, 40), amount: pos(x.amount), cat: str(x.cat, 40) || 'bills',
      freq: FREQ.includes(x.freq) ? x.freq : 'monthly', nextDue: x.nextDue, day: clamp(Number(x.day) || parseDate(x.nextDue).getDate(), 1, 31),
      mode: MODES.some((m) => m.id === x.mode) ? x.mode : 'upi', lastPaid: isDateStr(x.lastPaid) ? x.lastPaid : '',
    }));
    const splits = arr(d.splits).filter((s) => s && s.title).map((s) => ({
      id: safeId(s.id) || uid(), title: str(s.title, 50), date: isDateStr(s.date) ? s.date : todayStr(), total: pos(s.total),
      paidBy: str(s.paidBy || 'me', 30) || 'me', myShare: Math.max(0, round2(Number(s.myShare) || 0)), iSettled: !!s.iSettled,
      people: arr(s.people).filter((p) => p && p.name).map((p) => ({ name: str(p.name, 30), share: Math.max(0, round2(Number(p.share) || 0)), settled: !!p.settled })),
      ...(s.txnId ? { txnId: str(s.txnId, 40) } : {}),
    }));
    return { settings, customCats, txns, budgets: { total: pos(b.total), cats }, goals, bills, splits };
  }

  // ---------- Persisting (diffs each document against what was last stored) ----------
  let lastSaved = {};
  let saveTimer = null;
  let writeChain = Promise.resolve();
  let pendingWrites = 0;
  let lastLoad = 0;
  const FAILED = '\u0000failed';
  const snapshotOf = (docs) => Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, stableJson(v)]));

  let loadFailed = false;
  function persist() {
    if (state.sample || loadFailed) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 350);
  }
  function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (state.sample || loadFailed) return;
    const docs = buildDocs();
    const keys = new Set([...Object.keys(docs), ...Object.keys(lastSaved)]);
    for (const k of keys) {
      const json = docs[k] ? stableJson(docs[k]) : null;
      if (json === (lastSaved[k] ?? null)) continue;
      if (json === null) delete lastSaved[k]; else lastSaved[k] = json;
      pendingWrites++;
      const target = store;
      const write = () => (json === null ? target.del(k) : target.set(k, JSON.parse(json)));
      const fail = (e) => {
        if (store === target) lastSaved[k] = FAILED;
        toast(saveErrorText(e));
      };
      if (target.fireAndForget) Promise.resolve().then(write).catch(fail).finally(() => { pendingWrites--; });
      else writeChain = writeChain.then(write).catch(fail).finally(() => { pendingWrites--; });
    }
  }
  function saveErrorText(e) {
    const code = (e && (e.code || e.name)) || '';
    if (code === 'quota_exceeded' || code === 'QuotaExceededError' || code === 'resource-exhausted') return 'Storage is full. Export a backup and delete old entries.';
    if (code === 'permission-denied') return 'You don’t have permission to change this book any more.';
    return "Couldn't save your last change. It will retry on your next edit.";
  }
  async function refreshFromStore() {
    if (!state.loaded || store.live || state.sample || pendingWrites || saveTimer || Date.now() - lastLoad < 15000) return;
    if (Object.values(lastSaved).includes(FAILED)) { persist(); return; }
    try {
      const docs = await store.loadAll();
      lastLoad = Date.now();
      const snap = snapshotOf(docs);
      if (stableJson(snap) === stableJson(lastSaved) || !hasBook(docs) || pendingWrites || saveTimer) return;
      applyDocs(docs);
      lastSaved = snap;
      setCurrency(state.settings.currency);
      applyTheme();
      if (!sheets.length) render();
    } catch { /* offline: keep what is on screen */ }
  }

  // A document changed somewhere else (another device, or someone sharing this book).
  function applyRemote(changes) {
    let touched = false;
    for (const { key, data } of changes) {
      const json = data ? stableJson(data) : null;
      if (json === (lastSaved[key] ?? null)) continue; // our own write coming back
      if (json === null) delete lastSaved[key]; else lastSaved[key] = json;
      if (state.sample && !sampleStash) {
        // First real data arrived while samples were showing: drop the samples.
        const settings = state.settings;
        Object.assign(state, emptyData(), { settings, sample: false, started: true });
      }
      applyDocTo(state.sample && sampleStash ? sampleStash : state, key, data);
      touched = true;
    }
    if (touched) scheduleRender();
  }
  function applyDocTo(target, key, data) {
    const slash = key.indexOf('/');
    const col = key.slice(0, slash), id = key.slice(slash + 1);
    if (col === 'meta') {
      const clean = sanitizeData({ settings: data && data.settings, budgets: data && data.budgets, customCats: data && data.customCats });
      if (target === state) { state.settings = clean.settings; setCurrency(clean.settings.currency); }
      target.budgets = clean.budgets;
      target.customCats = clean.customCats;
      return;
    }
    if (!ITEM_COLS.includes(col)) return;
    const rest = target[col].filter((x) => x.id !== id);
    const item = data ? sanitizeData({ [col]: [{ ...data, id }] })[col][0] : null;
    target[col] = item ? [...rest, item] : rest;
  }
  let renderTimer;
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      if (!state.loaded) return;
      if (ui.tab === 'txns' && document.activeElement && document.activeElement.id === 'tx-q') renderTxList();
      else render();
    }, 120);
  }

  // Every change goes through here. While sample data is showing, the first real
  // change clears the samples and starts the person's own book.
  function commit(fn, { keepSample = false } = {}) {
    let fresh = false;
    if (state.sample && !keepSample) {
      const settings = state.settings;
      Object.assign(state, sampleStash || emptyData(), { settings, sample: false, started: true });
      sampleStash = null;
      fresh = true;
    }
    fn();
    persist();
    render();
    return fresh;
  }
  const freshNote = (fresh) => (fresh ? ' Sample data cleared.' : '');
  function upsert(list, item) {
    const i = list.findIndex((x) => x.id === item.id);
    if (i >= 0) list[i] = item; else list.push(item);
  }

  // ============================================================
  // Sample data (shown on first open, never saved)
  // ============================================================
  function mulberry32(a) {
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function makeSample() {
    const rnd = mulberry32(20261005);
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const between = (a, b, step = 10) => Math.round((a + rnd() * (b - a)) / step) * step;
    const mode = () => { const r = rnd(); return r < 0.58 ? 'upi' : r < 0.72 ? 'cash' : r < 0.82 ? 'debit' : r < 0.93 ? 'credit' : 'wallet'; };
    const txns = [];
    const add = (type, cat, amount, date, note, m) => txns.push({ id: uid() + txns.length, type, cat, amount, date, note, mode: m || mode(), ts: parseDate(date).getTime() + txns.length });
    const now = new Date();
    for (let back = 5; back >= 0; back--) {
      const base = new Date(now.getFullYear(), now.getMonth() - back, 1);
      const key = toDateStr(base).slice(0, 7);
      const last = back === 0 ? now.getDate() : daysInMonth(key);
      const ds = (d) => `${key}-${pad2(d)}`;
      add('income', 'salary', 68000, ds(1), 'Monthly salary', 'netbanking');
      if (back % 2 === 0 && last >= 15) add('income', 'freelance', between(8000, 16000, 500), ds(15), 'Website project', 'netbanking');
      if (back === 2 && last >= 20) add('income', 'refund', 450, ds(20), 'Cashback', 'upi');
      if (last >= 3) add('expense', 'rent', 16000, ds(3), 'House rent', 'netbanking');
      if (last >= 5) add('expense', 'emi', 3200, ds(5), 'Bike EMI', 'netbanking');
      if (last >= 6) add('expense', 'invest', 5000, ds(6), 'Mutual fund SIP', 'netbanking');
      for (let d = 1; d <= last; d++) {
        const date = ds(d);
        const wd = parseDate(date).getDay();
        const weekday = wd !== 0 && wd !== 6;
        if (weekday && rnd() < 0.62) add('expense', 'food', between(80, 200, 5), date, pick(['Office canteen lunch', 'Lunch – thali', 'Lunch with team', 'Dosa & coffee']));
        if (rnd() < 0.16) add('expense', 'food', between(260, 680), date, pick(['Swiggy dinner', 'Zomato order', 'Dinner out', 'Pizza night']));
        if (rnd() < 0.3) add('expense', 'food', between(20, 90, 5), date, pick(['Chai & snacks', 'Coffee', 'Juice']), 'cash');
        if (weekday && rnd() < 0.6) add('expense', 'transport', between(30, 140, 5), date, pick(['Metro', 'Auto to office', 'Bus pass top-up', 'Cab home']));
        if (d % 5 === 2) add('expense', 'groceries', between(500, 2200), date, pick(['Weekly groceries', 'Vegetables & fruits', 'Milk & essentials', 'Supermarket run']));
        if (d === 7 || d === 21) add('expense', 'fuel', between(1500, 2600, 50), date, pick(['Petrol – full tank', 'Petrol top-up']));
        if (rnd() < 0.05) add('expense', 'shopping', between(450, 3200, 50), date, pick(['T-shirts', 'Shoes', 'Kitchen items', 'Amazon order']));
        if (rnd() < 0.045) add('expense', 'entertainment', between(250, 900, 50), date, pick(['Movie tickets', 'Bowling', 'Concert entry']));
        if (rnd() < 0.025) add('expense', 'health', between(150, 1200), date, pick(['Pharmacy', 'Doctor visit', 'Lab test']));
        if (rnd() < 0.02) add('expense', 'personal', between(200, 700, 50), date, pick(['Haircut', 'Salon']));
        if (rnd() < 0.012) add('expense', 'gifts', between(500, 2000, 100), date, pick(['Birthday gift', 'Wedding gift']));
      }
      if (last >= 12) add('expense', 'bills', between(1100, 1900), ds(12), 'Electricity bill');
      if (last >= 8) add('expense', 'bills', 799, ds(8), 'Broadband');
      if (last >= 18) add('expense', 'recharge', 299, ds(18), 'Mobile recharge');
      if (last >= 22) add('expense', 'subs', 199, ds(22), 'Netflix');
      if (back === 3 && last >= 14) add('expense', 'travel', 6400, ds(14), 'Train tickets – Goa trip', 'credit');
      if (back === 1 && last >= 10) add('expense', 'education', 2499, ds(10), 'Online course', 'credit');
    }
    const t = todayStr();
    const dueOn = (day, minAhead = 0) => {
      const d = new Date(); d.setDate(d.getDate() + minAhead);
      let c = new Date(d.getFullYear(), d.getMonth(), day);
      if (toDateStr(c) < toDateStr(d)) c = new Date(d.getFullYear(), d.getMonth() + 1, day);
      return toDateStr(c);
    };
    const bills = [
      { id: 's-b1', name: 'House rent', amount: 16000, cat: 'rent', freq: 'monthly', nextDue: dueOn(3), day: 3, mode: 'netbanking' },
      { id: 's-b2', name: 'Broadband', amount: 799, cat: 'bills', freq: 'monthly', nextDue: addDays(t, -2), day: parseDate(addDays(t, -2)).getDate(), mode: 'upi' },
      { id: 's-b3', name: 'Electricity', amount: 1600, cat: 'bills', freq: 'monthly', nextDue: addDays(t, 2), day: parseDate(addDays(t, 2)).getDate(), mode: 'upi' },
      { id: 's-b4', name: 'Mobile recharge', amount: 299, cat: 'recharge', freq: 'monthly', nextDue: dueOn(18), day: 18, mode: 'upi' },
      { id: 's-b5', name: 'Netflix', amount: 199, cat: 'subs', freq: 'monthly', nextDue: dueOn(22), day: 22, mode: 'credit' },
      { id: 's-b6', name: 'Bike insurance', amount: 2850, cat: 'bills', freq: 'yearly', nextDue: addDays(t, 41), day: parseDate(addDays(t, 41)).getDate(), mode: 'upi' },
    ];
    const inMonths = (n) => { const d = new Date(); d.setMonth(d.getMonth() + n); return toDateStr(d); };
    const goals = [
      { id: 's-g1', name: 'Emergency fund', icon: 'savings', target: 150000, saved: 62000, deadline: inMonths(10), h: 145 },
      { id: 's-g2', name: 'New phone', icon: 'smartphone', target: 45000, saved: 18500, deadline: inMonths(4), h: 210 },
      { id: 's-g3', name: 'Goa trip', icon: 'beach_access', target: 30000, saved: 9000, deadline: inMonths(6), h: 24 },
    ];
    const splits = [
      { id: 's-s1', title: 'Team dinner', date: addDays(t, -3), total: 3200, paidBy: 'me', myShare: 800, iSettled: false,
        people: [{ name: 'Rahul', share: 800, settled: false }, { name: 'Priya', share: 800, settled: false }, { name: 'Arjun', share: 800, settled: true }] },
      { id: 's-s2', title: 'Weekend movie', date: addDays(t, -6), total: 900, paidBy: 'Priya', myShare: 300, iSettled: false,
        people: [{ name: 'Priya', share: 300, settled: true }, { name: 'Neha', share: 300, settled: false }] },
    ];
    const budgets = { total: 42000, cats: { food: 9000, groceries: 6000, transport: 2500, fuel: 4500, shopping: 3000, entertainment: 1500, bills: 3500 } };
    return { txns, bills, goals, splits, budgets, customCats: [] };
  }
  function loadSample() {
    Object.assign(state, makeSample(), { sample: true });
  }

  // ============================================================
  // Derived numbers
  // ============================================================
  const sortTx = (list) => list.sort((a, b) => b.date.localeCompare(a.date) || (b.ts || 0) - (a.ts || 0));
  const maxMonth = () => state.txns.reduce((m, t) => (t.date.slice(0, 7) > m ? t.date.slice(0, 7) : m), thisMonth());
  const txIn = (key, type) => state.txns.filter((t) => t.date.startsWith(key) && (!type || t.type === type));
  function totals(key) {
    let inc = 0, exp = 0;
    for (const t of state.txns) if (t.date.startsWith(key)) { if (t.type === 'income') inc += t.amount; else exp += t.amount; }
    return { inc, exp, bal: inc - exp };
  }
  function byCat(list) {
    const m = new Map();
    for (const t of list) m.set(t.cat, (m.get(t.cat) || 0) + t.amount);
    return [...m].map(([cat, amt]) => ({ cat, amt })).sort((a, b) => b.amt - a.amt);
  }
  const budgetLevel = (spent, limit) => (!limit ? 'none' : spent > limit ? 'over' : spent >= 0.8 * limit ? 'warn' : 'ok');
  function daysElapsed(key) {
    const nowKey = thisMonth();
    if (key === nowKey) return new Date().getDate();
    return key < nowKey ? daysInMonth(key) : 0;
  }
  const FREQS = { monthly: 'Monthly', quarterly: 'Every 3 months', yearly: 'Yearly', weekly: 'Weekly' };
  function advanceDue(bill) {
    if (bill.freq === 'weekly') return addDays(bill.nextDue, 7);
    const d = parseDate(bill.nextDue);
    const months = bill.freq === 'yearly' ? 12 : bill.freq === 'quarterly' ? 3 : 1;
    const target = new Date(d.getFullYear(), d.getMonth() + months, 1);
    const dim = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(bill.day || d.getDate(), dim));
    return toDateStr(target);
  }
  function billStatus(b) {
    const n = diffDays(b.nextDue, todayStr());
    if (n < 0) return { cls: 'err', icon: 'error', text: `Overdue ${plural(-n, 'day')}`, n };
    if (n === 0) return { cls: 'warn', icon: 'schedule', text: 'Due today', n };
    if (n === 1) return { cls: 'warn', icon: 'schedule', text: 'Due tomorrow', n };
    if (n <= 3) return { cls: 'warn', icon: 'schedule', text: `Due in ${n} days`, n };
    if (n <= 7) return { cls: 'info', icon: 'event', text: `Due in ${n} days`, n };
    return { cls: '', icon: 'event', text: `Due ${dateLabel(b.nextDue)}`, n };
  }
  const monthlyEquiv = (b) => (b.freq === 'yearly' ? b.amount / 12 : b.freq === 'quarterly' ? b.amount / 3 : b.freq === 'weekly' ? (b.amount * 52) / 12 : b.amount);
  function splitBalances() {
    const people = new Map();
    for (const s of state.splits) {
      if (s.paidBy === 'me') {
        for (const p of s.people) if (!p.settled) people.set(p.name, (people.get(p.name) || 0) + p.share);
      } else if (!s.iSettled && s.myShare > 0) {
        people.set(s.paidBy, (people.get(s.paidBy) || 0) - s.myShare);
      }
    }
    const list = [...people].map(([name, net]) => ({ name, net: round2(net) })).filter((p) => Math.abs(p.net) > 0.009).sort((a, b) => b.net - a.net);
    return { list, owed: sum(list.filter((p) => p.net > 0), (p) => p.net), owe: -sum(list.filter((p) => p.net < 0), (p) => p.net) };
  }
  function goalPlan(g) {
    const left = Math.max(0, g.target - g.saved);
    if (!g.deadline || left <= 0) return { left, perMonth: 0, months: 0 };
    const d = parseDate(g.deadline), n = new Date();
    const months = Math.max(1, (d.getFullYear() - n.getFullYear()) * 12 + (d.getMonth() - n.getMonth()));
    return { left, perMonth: left / months, months };
  }
  const hueOf = (name) => HUES[[...String(name)].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];
  const initial = (name) => esc(([...String(name).trim()][0] || '?').toUpperCase());

  // ============================================================
  // Theme
  // ============================================================
  function applyTheme() {
    const t = ui.theme;
    const root = document.documentElement;
    if (t === 'light' || t === 'dark') root.setAttribute('data-app-theme', t); else root.removeAttribute('data-app-theme');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
      if (bg) meta.setAttribute('content', bg);
    }
  }
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { applyTheme(); drawCharts(); });
  } catch { /* old browsers */ }

  // ============================================================
  // Rendering: shared bits
  // ============================================================
  const charts = {};
  let chartSeq = 0;
  function chartSlot(spec) {
    const id = 'c' + ++chartSeq;
    charts[id] = spec;
    return `<div class="chart" data-chart="${id}" style="height:${spec.height}px" role="img" aria-label="${esc(spec.label)}"></div>`;
  }
  const monthBar = (opts = {}) => `
    <div class="month-bar" role="group" aria-label="Month">
      <button class="icon-btn sm" type="button" data-act="month-prev" aria-label="Previous month">${ic('chevron_left')}</button>
      <span class="label">${monthLabel(ui.month)}${opts.note ? ` <span class="faint">· ${esc(opts.note)}</span>` : ''}</span>
      <button class="icon-btn sm" type="button" data-act="month-next" aria-label="Next month" ${ui.month >= maxMonth() ? 'disabled style="opacity:.3"' : ''}>${ic('chevron_right')}</button>
    </div>`;
  function txItem(t, { showDate = false } = {}) {
    const c = getCat(t.cat);
    const title = t.note || c.name;
    const who = session.book && t.by ? memberName(t.by) : null;
    const sub = [t.note ? c.name : null, modeOf(t.mode).name, who, showDate ? dayLabel(t.date) : null].filter(Boolean).join(' · ');
    const isIn = t.type === 'income';
    return `<button class="li" type="button" data-act="open-tx" data-id="${esc(t.id)}">
      ${catIco(c)}
      <span class="li-main"><span class="li-title">${esc(title)}</span><span class="li-sub">${esc(sub)}</span></span>
      <span class="li-end"><span class="amt ${isIn ? 'in' : ''}">${isIn ? '+' : ''}${esc(money(t.amount))}</span></span>
    </button>`;
  }
  const emptyState = (icon, title, text, btn = '') => `<div class="empty">${ic(icon)}<b>${esc(title)}</b><span>${esc(text)}</span>${btn}</div>`;
  function meterHtml(spent, limit, label, cls = '') {
    const lvl = budgetLevel(spent, limit);
    const p = limit ? Math.min(100, (spent / limit) * 100) : 0;
    return `<div class="meter ${lvl === 'over' ? 'over' : lvl === 'warn' ? 'warn' : ''} ${cls}" role="progressbar" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p)}"><i style="width:${p}%"></i></div>`;
  }
  const progressHtml = (p, label) => `<div class="meter" role="progressbar" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p * 100)}"><i style="width:${clamp(p, 0, 1) * 100}%"></i></div>`;
  function levelNote(spent, limit) {
    const lvl = budgetLevel(spent, limit);
    if (lvl === 'over') return `<span class="pill err">${ic('error')}Over by ${esc(money(spent - limit, { whole: true }))}</span>`;
    if (lvl === 'warn') return `<span class="pill warn">${ic('warning')}${esc(money(limit - spent, { whole: true }))} left</span>`;
    return `<span class="pill ok">${ic('check_circle')}${esc(money(limit - spent, { whole: true }))} left</span>`;
  }

  const BRAND = '<span class="brand-mark" aria-hidden="true">₹</span><span>Kharcha</span>';
  const isWide = () => window.matchMedia('(min-width: 840px)').matches;
  // A layout slot: on phones every slot stacks in its order number; on wide screens slots sit in two columns.
  const slot = (html, n) => (html ? `<div class="slot o${n}">${html}</div>` : '');
  function accountControls() {
    if (session.mode === 'firebase' && session.user) {
      const name = session.book ? session.book.name : 'My book';
      return `<button class="book-chip" type="button" data-act="account" title="Switch book">${ic(session.book ? 'group' : 'person', 'sm')}<span>${esc(name)}</span>${ic('arrow_drop_down', 'sm')}</button>
        <button class="avatar-btn" type="button" data-act="account" aria-label="Account and books">${avatarHtml(session.user)}</button>`;
    }
    return `<button class="icon-btn" type="button" data-act="settings" aria-label="Settings">${ic('settings')}</button>`;
  }
  function topbarHtml(title, extra = '') {
    const head = ui.tab === 'home'
      ? `<div class="brand only-mobile">${BRAND}</div><h1 class="only-desktop">${esc(title)}</h1>`
      : `<h1>${esc(title)}</h1>`;
    return `<header class="topbar">${head}${extra}${accountControls()}</header>`;
  }
  const exportBtn = () => `<button class="icon-btn" type="button" data-act="export" aria-label="Export to CSV">${ic('download')}</button>`;

  function renderBanner() {
    const el = $('#banner');
    if (loadFailed) {
      el.innerHTML = `<div class="banner" role="alert">${ic('cloud_off')}<p>Couldn’t load your saved data, so nothing you change now will be saved.</p><button class="btn btn-text" type="button" data-act="retry-load">Try again</button></div>`;
      return;
    }
    if (!state.sample) { el.innerHTML = ''; return; }
    el.innerHTML = sampleStash
      ? `<div class="banner" role="note">${ic('science')}<p>You're looking at sample data. Your own book is safe and comes back when you add an entry.</p><button class="btn btn-text" type="button" data-act="exit-sample">Show my data</button></div>`
      : `<div class="banner" role="note">${ic('science')}<p>You're looking at sample data. Your first entry clears it and starts your own book.</p><button class="btn btn-text" type="button" data-act="start-fresh">Start fresh</button></div>`;
  }

  function updateChrome() {
    $$('.nav-item').forEach((b) => b.setAttribute('aria-current', b.dataset.tab === ui.tab ? 'page' : 'false'));
    const fab = $('#fab');
    let f = null;
    if (ui.tab === 'home' || ui.tab === 'txns') f = { label: 'Add expense', icon: 'add', act: 'add' };
    if (ui.tab === 'plan') {
      f = { budgets: { label: 'Edit budgets', icon: 'edit', act: 'edit-budgets' }, goals: { label: 'New goal', icon: 'add', act: 'add-goal' }, bills: { label: 'Add bill', icon: 'add', act: 'add-bill' }, split: { label: 'New split', icon: 'add', act: 'add-split' } }[ui.plan];
    }
    fab.hidden = !f || !state.loaded;
    if (f) { fab.innerHTML = `${ic(f.icon)}<span>${f.label}</span>`; fab.dataset.act = f.act; }
    $('#screen').classList.toggle('no-fab', !f);
  }

  let lastTab = null;
  function render() {
    if (!state.loaded) return;
    Object.keys(charts).forEach((k) => delete charts[k]);
    renderBanner();
    const screen = $('#screen');
    const html = { home: renderHome, txns: renderTxns, insights: renderInsights, plan: renderPlan, tools: renderTools }[ui.tab]();
    screen.dataset.tab = ui.tab;
    screen.innerHTML = html;
    if (ui.tab === 'txns') renderTxList();
    if (ui.tab === 'tools') updateCalc();
    drawCharts(screen);
    updateChrome();
    if (lastTab !== ui.tab) { window.scrollTo(0, 0); lastTab = ui.tab; }
  }
  function setTab(tab) {
    if (!['home', 'txns', 'insights', 'plan', 'tools'].includes(tab)) tab = 'home';
    ui.tab = tab;
    prefsSave();
    render();
  }

  // ============================================================
  // Home
  // ============================================================
  function renderHome() {
    const key = ui.month;
    const isNow = key === thisMonth();
    const { inc, exp, bal } = totals(key);
    const today = sum(state.txns.filter((t) => t.type === 'expense' && t.date === todayStr()), (t) => t.amount);
    const budget = state.budgets.total;
    const hr = new Date().getHours();
    const hello = hr < 5 ? 'Good night' : hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
    const first = session.user ? session.user.name.split(' ')[0] : state.settings.name;
    const name = first ? `, ${esc(first)}` : '';
    const now = new Date();

    let budgetHtml;
    if (budget > 0) {
      const left = budget - exp;
      const daysLeft = isNow ? daysInMonth(key) - now.getDate() + 1 : 0;
      const perDay = isNow && left > 0 ? Math.floor(left / daysLeft) : 0;
      const p = Math.min(100, (exp / budget) * 100);
      budgetHtml = `<div class="meter ${exp > budget ? 'over' : ''}" role="progressbar" aria-label="Monthly budget used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p)}"><i style="width:${p}%"></i></div>
        <p>${left >= 0 ? `<b>${esc(money(left, { whole: true }))}</b> left of ${esc(money(budget, { whole: true }))}` : `<b>${esc(money(-left, { whole: true }))}</b> over your ${esc(money(budget, { whole: true }))} budget`}${perDay ? ` · ${esc(money(perDay, { whole: true }))}/day for ${plural(daysLeft, 'day')}` : ''}</p>`;
    } else {
      budgetHtml = `<p>No monthly budget yet. <button class="hero-link" type="button" data-act="edit-budgets">Set one</button></p>`;
    }
    const amt = money(exp);
    const amtHtml = esc(amt).replace(/(\.\d\d)$/, '<span class="dec">$1</span>');

    const quick = ['food', 'transport', 'fuel', 'groceries', 'shopping', 'bills', 'recharge', 'health'].map((id) => {
      const c = getCat(id);
      return `<button class="quick-tile" type="button" data-act="add" data-cat="${c.id}">${catIco(c, 'lg')}<span>${esc(c.short)}</span></button>`;
    }).join('') + `<button class="quick-tile" type="button" data-act="add" data-type="income"><span class="cat-ico lg" style="--h:145">${ic('add_card')}</span><span>Income</span></button>`;

    // Alerts
    const alerts = [];
    if (isNow) {
      const spentBy = new Map(byCat(txIn(key, 'expense')).map((x) => [x.cat, x.amt]));
      Object.entries(state.budgets.cats).forEach(([cat, lim]) => {
        const s = spentBy.get(cat) || 0;
        const lvl = budgetLevel(s, lim);
        if (lvl === 'over') alerts.push({ w: 3, cls: 'err', icon: 'error', html: `<b>${esc(getCat(cat).name)}</b> is over budget by ${esc(money(s - lim, { whole: true }))}`, act: 'data-act="goto" data-tab="plan" data-plan="budgets"' });
        else if (lvl === 'warn') alerts.push({ w: 2, cls: 'warn', icon: 'warning', html: `<b>${esc(getCat(cat).name)}</b>: ${pct(s / lim)} of budget used`, act: 'data-act="goto" data-tab="plan" data-plan="budgets"' });
      });
    }
    state.bills.forEach((b) => {
      const st = billStatus(b);
      if (st.n < 0) alerts.push({ w: 4, cls: 'err', icon: 'event_busy', html: `<b>${esc(b.name)}</b> bill of ${esc(money(b.amount))} is overdue`, act: 'data-act="goto" data-tab="plan" data-plan="bills"' });
    });
    const sb = splitBalances();
    if (sb.owed > 0) alerts.push({ w: 1, cls: 'info', icon: 'group', html: `Friends owe you <b>${esc(money(sb.owed))}</b>`, act: 'data-act="goto" data-tab="plan" data-plan="split"' });
    alerts.sort((a, b) => b.w - a.w);
    const alertsHtml = alerts.slice(0, 3).map((a) => `<button class="alert ${a.cls}" type="button" ${a.act}>${ic(a.icon)}<p>${a.html}</p>${ic('chevron_right')}</button>`).join('');

    // Upcoming bills
    const upcoming = [...state.bills].sort((a, b) => a.nextDue.localeCompare(b.nextDue)).slice(0, 3);
    const billsHtml = upcoming.length ? `<section class="card flush">
        <div class="card-head"><h2>Upcoming bills</h2><button class="btn btn-text" type="button" data-act="goto" data-tab="plan" data-plan="bills">See all</button></div>
        <div class="list">${upcoming.map(billRow).join('')}</div></section>` : '';

    // Top spending
    const top = byCat(txIn(key, 'expense')).slice(0, 4);
    const maxTop = top.length ? top[0].amt : 1;
    const topHtml = top.length ? `<section class="card flush">
        <div class="card-head"><h2>Top spending</h2><button class="btn btn-text" type="button" data-act="tab" data-tab="insights">Insights</button></div>
        <div class="rank">${top.map((x) => {
          const c = getCat(x.cat);
          return `<button class="rank-row" type="button" data-act="cat-tx" data-cat="${esc(x.cat)}">${catIco(c, 'sm')}<span class="rank-main"><span class="rank-top"><span class="name">${esc(c.name)}</span><span class="val">${esc(money(x.amt, { whole: true }))}</span></span><span class="rank-bar"><i style="width:${(x.amt / maxTop) * 100}%"></i></span></span></button>`;
        }).join('')}</div></section>` : '';

    // Recent
    const recent = sortTx([...state.txns]).slice(0, 5);
    const recentHtml = `<section class="card flush">
      <div class="card-head"><h2>Recent</h2>${recent.length ? '<button class="btn btn-text" type="button" data-act="tab" data-tab="txns">See all</button>' : ''}</div>
      ${recent.length ? `<div class="list">${recent.map((t) => txItem(t, { showDate: true })).join('')}</div>` : emptyState('receipt_long', 'No entries yet', 'Tap “Add expense” or a quick-add tile to log your first one.')}
    </section>`;

    // Goals
    const goalsHtml = state.goals.length ? `<section class="card">
        <div class="card-head"><h2>Savings goals</h2><button class="btn btn-text" type="button" data-act="goto" data-tab="plan" data-plan="goals">See all</button></div>
        ${state.goals.slice(0, 2).map((g) => `<div class="goal"><div class="goal-top"><span class="cat-ico sm" style="--h:${g.h}">${ic(g.icon)}</span><span class="li-main"><span class="li-title">${esc(g.name)}</span></span><span class="amt">${pct(g.target ? Math.min(1, g.saved / g.target) : 0)}</span></div>${progressHtml(g.target ? g.saved / g.target : 0, g.name + ' progress')}<div class="goal-nums"><span><b>${esc(money(g.saved, { whole: true }))}</b> saved</span><span>of ${esc(money(g.target, { whole: true }))}</span></div></div>`).join('')}
      </section>` : '';

    const heroHtml = `
      <section class="hero" aria-label="This month">
        <div class="month-switch">
          <button class="icon-btn sm" type="button" data-act="month-prev" aria-label="Previous month">${ic('chevron_left')}</button>
          <span class="label">${monthLabel(key)}</span>
          <button class="icon-btn sm" type="button" data-act="month-next" aria-label="Next month" ${key >= maxMonth() ? 'disabled style="opacity:.3"' : ''}>${ic('chevron_right')}</button>
        </div>
        ${session.book ? `<div class="hero-book">${ic('group', 'xs')}${esc(session.book.name)} · ${plural(session.book.members.length, 'person', 'people')}</div>` : ''}
        <div class="hero-label">Spent ${isNow ? 'this month' : 'in ' + MONTHS[Number(key.slice(5, 7)) - 1]}</div>
        <div class="hero-amount">${amtHtml}</div>
        <div class="hero-budget">${budgetHtml}</div>
        <div class="hero-stats">
          <div><span>Income</span><b>${esc(money(inc, { whole: true }))}</b></div>
          <div><span>${bal >= 0 ? 'Saved' : inc ? 'Overspent' : 'Balance'}</span><b>${esc((bal < 0 && !inc ? '−' : '') + money(Math.abs(bal), { whole: true }))}</b></div>
          <div><span>${isNow ? 'Today' : 'Entries'}</span><b>${isNow ? esc(money(today, { whole: true })) : txIn(key).length}</b></div>
        </div>
      </section>`;
    const quickHtml = `<section aria-label="Quick add"><div class="section-title">Quick add</div><div class="hscroll">${quick}</div></section>`;
    const alertsBox = alertsHtml ? `<section class="list" style="gap:8px" aria-label="Alerts">${alertsHtml}</section>` : '';
    const invites = session.mode === 'firebase' ? invitesHtml() : '';
    return `
      ${topbarHtml('Home')}
      <section class="greeting"><h2>${hello}${name}</h2><p>${WEEKDAY[now.getDay()]}, ${now.getDate()} ${MONTHS[now.getMonth()]}</p></section>
      <div class="layout layout--home">
        <div class="main-col">${slot(heroHtml, 2)}${slot(quickHtml, 3)}${slot(recentHtml, 7)}</div>
        <div class="side-col">${slot(invites ? `<div class="list" style="gap:8px">${invites}</div>` : '', 1)}${slot(alertsBox, 4)}${slot(billsHtml, 5)}${slot(topHtml, 6)}${slot(goalsHtml, 8)}</div>
      </div>`;
  }
  function billRow(b) {
    const st = billStatus(b);
    const c = getCat(b.cat);
    return `<div class="li clickable" role="button" tabindex="0" data-act="open-bill" data-id="${esc(b.id)}">
      ${catIco(c)}
      <span class="li-main"><span class="li-title">${esc(b.name)}</span><span class="li-sub">${esc(money(b.amount))} · ${esc(FREQS[b.freq])}</span>
      <span style="margin-top:4px"><span class="pill ${st.cls}">${ic(st.icon)}${esc(st.text)}</span></span></span>
      <button class="btn btn-tonal" type="button" style="height:36px;padding:0 16px" data-act="pay-bill" data-id="${esc(b.id)}">Mark paid</button>
    </div>`;
  }

  // ============================================================
  // Transactions
  // ============================================================
  function renderTxns() {
    const f = ui.filter;
    const typeChip = (v, label) => `<button class="chip" type="button" data-act="filter-type" data-v="${v}" aria-pressed="${f.type === v}">${f.type === v ? ic('check') : ''}${label}</button>`;
    return `
      ${topbarHtml('Activity', exportBtn())}
      <label class="search">${ic('search')}<input id="tx-q" type="search" placeholder="Search notes, categories, amounts" value="${esc(f.q)}" autocomplete="off" aria-label="Search transactions">
        <button class="icon-btn sm" type="button" data-act="clear-q" aria-label="Clear search" ${f.q ? '' : 'hidden'}>${ic('close')}</button></label>
      ${f.q ? '' : monthBar()}
      <div class="chip-row">
        ${typeChip('all', 'All')}${typeChip('expense', 'Expenses')}${typeChip('income', 'Income')}
        <button class="chip ${f.cat ? 'on' : ''}" type="button" data-act="pick-cat-filter">${f.cat ? ic('check') + esc(getCat(f.cat).name) : 'Category'}${ic('arrow_drop_down')}</button>
        <button class="chip ${f.mode ? 'on' : ''}" type="button" data-act="pick-mode-filter">${f.mode ? ic('check') + esc(modeOf(f.mode).name) : 'Paid with'}${ic('arrow_drop_down')}</button>
        ${f.cat || f.mode || f.type !== 'all' ? `<button class="chip" type="button" data-act="clear-filters">${ic('filter_alt_off')}Clear</button>` : ''}
      </div>
      <div id="tx-list"></div>`;
  }
  function filteredTx() {
    const f = ui.filter;
    const q = f.q.trim().toLowerCase();
    return sortTx(state.txns.filter((t) => {
      if (!q && !t.date.startsWith(ui.month)) return false;
      if (f.type !== 'all' && t.type !== f.type) return false;
      if (f.cat && t.cat !== f.cat) return false;
      if (f.mode && t.mode !== f.mode) return false;
      if (q) {
        const c = getCat(t.cat);
        const hay = `${t.note} ${c.name} ${modeOf(t.mode).name} ${t.amount} ${dateLabel(t.date)}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }));
  }
  function renderTxList() {
    const host = $('#tx-list');
    if (!host) return;
    const list = filteredTx();
    const out = sum(list.filter((t) => t.type === 'expense'), (t) => t.amount);
    const inn = sum(list.filter((t) => t.type === 'income'), (t) => t.amount);
    const scope = ui.filter.q ? 'across all months' : `in ${monthLabel(ui.month)}`;
    if (!list.length) {
      host.innerHTML = `<section class="card">${emptyState(ui.filter.q ? 'search_off' : 'receipt_long', ui.filter.q ? 'No matches' : 'Nothing here yet', ui.filter.q ? 'Try a different word, amount or category.' : `No entries ${scope} with these filters.`)}</section>`;
      return;
    }
    const groups = [];
    let g = null;
    for (const t of list) {
      if (!g || g.date !== t.date) { g = { date: t.date, items: [], spent: 0 }; groups.push(g); }
      g.items.push(t);
      if (t.type === 'expense') g.spent += t.amount;
    }
    host.innerHTML = `
      <div class="tiles" style="margin-bottom:16px">
        <div class="tile"><span>Spent ${esc(scope)}</span><b>${esc(money(out))}</b><small>${plural(list.length, 'entry', 'entries')}</small></div>
        <div class="tile"><span>Received</span><b>${esc(money(inn))}</b></div>
      </div>
      <section class="card flush">
        ${groups.map((gr) => `<div class="day-head"><span>${esc(dayLabel(gr.date))}</span><span class="num">${gr.spent ? esc(money(gr.spent)) : ''}</span></div><div class="list">${gr.items.map((t) => txItem(t)).join('')}</div>`).join('')}
      </section>`;
  }

  // ============================================================
  // Insights
  // ============================================================
  function renderInsights() {
    const key = ui.month;
    const type = ui.insight;
    const list = txIn(key, type);
    const total = sum(list, (t) => t.amount);
    const { inc, exp } = totals(key);
    const days = daysElapsed(key) || daysInMonth(key);
    // Compare like with like: for the current month, only the same days of last month.
    const prevKey = shiftMonth(key, -1);
    const cutoff = key === thisMonth() ? new Date().getDate() : 31;
    const prevVal = sum(txIn(prevKey, type).filter((t) => Number(t.date.slice(8, 10)) <= cutoff), (t) => t.amount);
    const delta = prevVal ? (total - prevVal) / prevVal : null;
    const seg = `<div class="seg" role="group" aria-label="Show">
      <button type="button" data-act="insight-type" data-v="expense" aria-pressed="${type === 'expense'}">${ic('check')}Spending</button>
      <button type="button" data-act="insight-type" data-v="income" aria-pressed="${type === 'income'}">${ic('check')}Income</button></div>`;
    const head = `${topbarHtml('Insights', exportBtn())}<div class="filters-row">${monthBar()}${seg}</div>`;

    // Daily totals
    const dim = daysInMonth(key);
    const daily = Array.from({ length: dim }, () => 0);
    list.forEach((t) => { daily[Number(t.date.slice(8, 10)) - 1] += t.amount; });
    let bigDay = 0;
    daily.forEach((v, i) => { if (v > daily[bigDay]) bigDay = i; });

    const prevLabel = cutoff < 31 ? `${cutoff === 1 ? '1' : '1–' + cutoff} ${monthShort(prevKey)}` : monthShort(prevKey);
    const deltaTxt = delta === null ? `Nothing in ${prevLabel} to compare` : `${delta >= 0 ? '▲' : '▼'} ${pct(Math.abs(delta))} vs ${prevLabel}`;
    const tiles = type === 'expense' ? `
      <div class="tiles">
        <div class="tile"><span>Spent</span><b>${esc(money(total, { whole: true }))}</b><small>${esc(deltaTxt)}</small></div>
        <div class="tile"><span>Daily average</span><b>${esc(money(total / days, { whole: true }))}</b><small>over ${plural(days, 'day')}</small></div>
        <div class="tile"><span>Biggest day</span><b>${esc(money(daily[bigDay], { whole: true }))}</b><small>${total ? esc(dateLabel(`${key}-${pad2(bigDay + 1)}`)) : '—'}</small></div>
        <div class="tile"><span>${inc - exp >= 0 ? 'Saved' : inc ? 'Overspent' : 'Balance'}</span><b>${esc((inc - exp < 0 && !inc ? '−' : '') + money(Math.abs(inc - exp), { whole: true }))}</b><small>${inc ? `${pct(Math.max(0, (inc - exp) / inc))} of income saved` : 'No income logged'}</small></div>
      </div>` : `
      <div class="tiles">
        <div class="tile"><span>Received</span><b>${esc(money(total, { whole: true }))}</b><small>${esc(deltaTxt)}</small></div>
        <div class="tile"><span>Savings rate</span><b>${inc ? pct(Math.max(0, (inc - exp) / inc)) : '—'}</b><small>${esc(money(Math.max(0, inc - exp), { whole: true }))} kept</small></div>
      </div>`;

    if (!list.length) {
      return `${head}${tiles}<section class="card">${emptyState('donut_large', type === 'expense' ? 'No spending in this month' : 'No income in this month', 'Entries you add will show up here as charts.', '<button class="btn btn-tonal" type="button" data-act="add" data-type="' + type + '">' + ic('add') + 'Add entry</button>')}</section>${trendCard(key)}`;
    }

    // Categories (single series ranked bars, budget tick when set)
    const cats = byCat(list);
    const budgetFor = (c) => (type === 'expense' ? state.budgets.cats[c] || 0 : 0);
    const scaleMax = Math.max(...cats.map((x) => Math.max(x.amt, budgetFor(x.cat))));
    const catHtml = `<section class="card flush">
      <div class="card-head"><h2>${type === 'expense' ? 'Where it went' : 'Where it came from'}</h2></div>
      <div class="rank">${cats.map((x) => {
        const c = getCat(x.cat);
        const b = budgetFor(x.cat);
        const meta = b ? (x.amt > b ? `<span class="pill err" style="height:20px">${ic('error')}Over budget ${esc(money(b, { whole: true }))}</span>` : `<span>Budget ${esc(money(b, { whole: true }))}</span>`) : '';
        return `<button class="rank-row" type="button" data-act="cat-tx" data-cat="${esc(x.cat)}">${catIco(c, 'sm')}<span class="rank-main">
          <span class="rank-top"><span class="name">${esc(c.name)}</span><span class="val">${esc(money(x.amt, { whole: true }))}</span></span>
          <span class="rank-bar" style="--bar:var(${type === 'expense' ? '--spend' : '--earn'})"><i style="width:${(x.amt / scaleMax) * 100}%"></i>${b ? `<em style="left:calc(${(b / scaleMax) * 100}% - 1px)" title="Budget"></em>` : ''}</span>
          <span class="rank-meta"><span>${pct(x.amt / total)} of ${type === 'expense' ? 'spending' : 'income'}</span>${meta}</span>
        </span></button>`;
      }).join('')}</div>
      ${type === 'expense' && Object.keys(state.budgets.cats).length ? '<p class="hint" style="padding:4px 16px 8px">The dark tick on a bar marks that category’s budget.</p>' : ''}
    </section>`;

    // Daily chart
    const avg = total / days;
    const color = type === 'expense' ? 'var(--spend)' : 'var(--earn)';
    const dailyHtml = type === 'expense' ? `<section class="card">
      <div class="card-head"><h2>Daily spending</h2></div>
      ${chartSlot({
        kind: 'columns', height: 180, label: `Daily spending in ${monthLabel(key)}`,
        groups: daily.map((v, i) => ({ values: [{ v, color }], tip: { title: dayLabel(`${key}-${pad2(i + 1)}`), rows: [{ color, value: money(v), label: 'spent' }] } })),
        xLabel: (i) => ([0, 7, 14, 21, 28].includes(i) ? String(i + 1) : ''),
        ref: avg > 0 ? { value: avg, label: `avg ${compact(avg)}` } : null,
      })}
    </section>` : '';

    // Payment methods
    const modes = MODES.map((m) => ({ ...m, v: sum(list.filter((t) => t.mode === m.id), (t) => t.amount) })).filter((m) => m.v > 0);
    const modesHtml = `<section class="card">
      <div class="card-head"><h2>${type === 'expense' ? 'Paid with' : 'Received in'}</h2></div>
      <div class="stack" role="img" aria-label="Share by payment method">${modes.map((m) => `<i style="flex:${m.v} 1 0;background:${m.color}" title="${esc(m.name)} ${esc(money(m.v))}"></i>`).join('')}</div>
      <div class="keylist">${modes.map((m) => `<div class="keyrow"><i style="background:${m.color}"></i><span class="name">${esc(m.name)}</span><span class="pct">${pct(m.v / total)}</span><span class="val">${esc(money(m.v, { whole: true }))}</span></div>`).join('')}</div>
    </section>`;

    // Shared books: who spent how much (colour follows the member, in member order)
    let peopleHtml = '';
    if (session.book && type === 'expense') {
      const ids = [...session.book.members];
      list.forEach((t) => { if (t.by && !ids.includes(t.by)) ids.push(t.by); });
      const rows = ids.map((id, i) => ({ name: memberName(id, true), v: sum(list.filter((t) => t.by === id), (t) => t.amount), color: `var(--s${(i % 6) + 1})` })).filter((r) => r.v > 0);
      const unknown = sum(list.filter((t) => !t.by), (t) => t.amount);
      if (unknown > 0) rows.push({ name: 'Not recorded', v: unknown, color: 'var(--outline)' });
      if (rows.length) {
        peopleHtml = `<section class="card">
          <div class="card-head"><h2>Who spent</h2></div>
          <div class="stack" role="img" aria-label="Share of spending by person">${rows.map((r) => `<i style="flex:${r.v} 1 0;background:${r.color}"></i>`).join('')}</div>
          <div class="keylist">${rows.map((r) => `<div class="keyrow"><i style="background:${r.color}"></i><span class="name">${esc(r.name)}</span><span class="pct">${pct(r.v / total)}</span><span class="val">${esc(money(r.v, { whole: true }))}</span></div>`).join('')}</div>
        </section>`;
      }
    }
    return `${head}<div class="layout">
      <div class="main-col">${slot(tiles, 1)}${slot(dailyHtml, 3)}${slot(trendCard(key), 6)}</div>
      <div class="side-col">${slot(catHtml, 2)}${slot(modesHtml, 4)}${slot(peopleHtml, 5)}</div>
    </div>`;
  }
  function trendCard(key) {
    const months = Array.from({ length: 6 }, (_, i) => shiftMonth(key, i - 5));
    const rows = months.map((m) => ({ m, ...totals(m) }));
    if (!rows.some((r) => r.inc || r.exp)) return '';
    const earn = 'var(--earn)', spend = 'var(--spend)';
    return `<section class="card">
      <div class="card-head"><h2>Last 6 months</h2></div>
      <div class="legend"><span><i style="background:${earn}"></i>Income</span><span><i style="background:${spend}"></i>Spent</span></div>
      ${chartSlot({
        kind: 'columns', height: 190, label: 'Income and spending over the last six months',
        groups: rows.map((r) => ({
          values: [{ v: r.inc, color: earn }, { v: r.exp, color: spend }],
          tip: { title: monthLabel(r.m), rows: [{ color: earn, value: money(r.inc, { whole: true }), label: 'income' }, { color: spend, value: money(r.exp, { whole: true }), label: 'spent' }] },
        })),
        xLabel: (i) => monthShort(rows[i].m),
      })}
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Month</th><th>Income</th><th>Spent</th><th>Saved</th></tr></thead>
        <tbody>${rows.slice().reverse().map((r) => `<tr><td>${monthShort(r.m)} ${r.m.slice(0, 4)}</td><td>${esc(money(r.inc, { whole: true }))}</td><td>${esc(money(r.exp, { whole: true }))}</td><td>${esc(money(r.bal, { whole: true }))}</td></tr>`).join('')}</tbody>
      </table></div>
    </section>`;
  }

  // ---------- Charts ----------
  function niceTicks(max, count = 3) {
    if (!(max > 0)) return [0];
    const raw = max / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const n = raw / mag;
    const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
    const out = [];
    for (let v = 0; v < max + step * 0.999; v += step) out.push(Math.round(v * 100) / 100);
    return out;
  }
  const roundTop = (x, y, w, h, r) => `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  function drawCharts(root = document) {
    $$('[data-chart]', root).forEach((el) => {
      const spec = charts[el.dataset.chart];
      if (spec && spec.kind === 'columns') drawColumns(el, spec);
    });
  }
  function drawColumns(el, spec) {
    const W = Math.max(240, el.clientWidth || 320);
    const H = spec.height;
    const padL = 44, padR = 6, padT = 14, padB = 22;
    const iw = W - padL - padR, ih = H - padT - padB;
    const n = spec.groups.length;
    const k = spec.groups[0] ? spec.groups[0].values.length : 1;
    const max = Math.max(spec.ref ? spec.ref.value : 0, ...spec.groups.flatMap((g) => g.values.map((v) => v.v)));
    const ticks = niceTicks(max, 3);
    const top = ticks[ticks.length - 1] || 1;
    const y = (v) => padT + ih - (v / top) * ih;
    const slot = iw / n;
    const gap = 2;
    const bw = Math.max(2, Math.min(24, (slot * (k > 1 ? 0.72 : 0.62) - gap * (k - 1)) / k));
    let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">`;
    ticks.forEach((t) => {
      const yy = Math.round(y(t)) + 0.5;
      s += `<line class="${t === 0 ? 'base' : 'grid'}" x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}"/>`;
      s += `<text x="${padL - 8}" y="${yy + 4}" text-anchor="end">${esc(compact(t))}</text>`;
    });
    spec.groups.forEach((g, i) => {
      const cx = padL + slot * i + slot / 2;
      const gw = bw * k + gap * (k - 1);
      g.values.forEach((v, j) => {
        if (!(v.v > 0)) return;
        const x = cx - gw / 2 + j * (bw + gap);
        const h = Math.max(1.5, (v.v / top) * ih);
        s += `<path class="bar" data-i="${i}" d="${roundTop(x, padT + ih - h, bw, h, Math.min(4, bw / 2, h))}" fill="${v.color}"/>`;
      });
      const xl = spec.xLabel(i);
      if (xl) s += `<text x="${cx}" y="${H - 5}" text-anchor="middle">${esc(xl)}</text>`;
    });
    if (spec.ref) {
      const yy = Math.round(y(spec.ref.value)) + 0.5;
      s += `<line class="ref" x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}"/>`;
      s += `<rect x="${W - padR - 64}" y="${yy - 17}" width="64" height="14" rx="3" fill="var(--card)"/>`;
      s += `<text class="ref-label" x="${W - padR - 2}" y="${yy - 6}" text-anchor="end">${esc(spec.ref.label)}</text>`;
    }
    s += '</svg>';
    el.innerHTML = s;
    const hit = (e) => {
      const r = el.getBoundingClientRect();
      const i = clamp(Math.floor((e.clientX - r.left - padL) / slot), 0, n - 1);
      el.classList.add('hovering');
      $$('.bar', el).forEach((b) => b.classList.toggle('hot', Number(b.dataset.i) === i));
      showTip(e.clientX, e.clientY, spec.groups[i].tip);
    };
    el.onpointermove = hit;
    el.onpointerdown = hit;
    el.onpointerleave = (e) => { if (e.pointerType !== 'mouse') return; el.classList.remove('hovering'); hideTip(); };
  }
  function showTip(x, y, tip) {
    const el = $('#tip');
    el.replaceChildren();
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = tip.title;
    el.append(t);
    tip.rows.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'r';
      const key = document.createElement('i');
      key.style.background = r.color;
      const b = document.createElement('b');
      b.textContent = r.value;
      const sp = document.createElement('span');
      sp.textContent = r.label;
      row.append(key, b, sp);
      el.append(row);
    });
    el.hidden = false;
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = x + 14, topY = y - h - 14;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    if (topY < 8) topY = y + 18;
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${topY}px`;
  }
  function hideTip() {
    $('#tip').hidden = true;
    $$('.chart.hovering').forEach((c) => c.classList.remove('hovering'));
  }
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.chart')) hideTip(); });
  window.addEventListener('scroll', hideTip, { passive: true });
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => drawCharts(), 120); });

  function donutSvg(segs, size = 148, stroke = 18) {
    const r = (size - stroke) / 2, C = 2 * Math.PI * r, c = size / 2;
    const total = sum(segs, (x) => x.v) || 1;
    const live = segs.filter((x) => x.v > 0);
    const gap = live.length > 1 ? 3 : 0;
    let off = 0;
    let s = `<svg viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--surface-high)" stroke-width="${stroke}"/>`;
    live.forEach((x) => {
      const len = (x.v / total) * C;
      s += `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${x.color}" stroke-width="${stroke}" stroke-dasharray="${Math.max(0.5, len - gap)} ${C}" stroke-dashoffset="${-off}"/>`;
      off += len;
    });
    return s + '</svg>';
  }

  // ============================================================
  // Plan: budgets, goals, bills, splits
  // ============================================================
  function renderPlan() {
    const tab = (id, label) => `<button type="button" role="tab" data-act="plan-tab" data-v="${id}" aria-selected="${ui.plan === id}">${label}</button>`;
    const body = { budgets: planBudgets, goals: planGoals, bills: planBills, split: planSplits }[ui.plan]();
    return `${topbarHtml('Plan')}
      <div class="tabs" role="tablist">${tab('budgets', 'Budgets')}${tab('goals', 'Goals')}${tab('bills', 'Bills')}${tab('split', 'Split')}</div>
      ${body}`;
  }
  function planBudgets() {
    const key = ui.month;
    const b = state.budgets;
    const exp = totals(key).exp;
    const spent = new Map(byCat(txIn(key, 'expense')).map((x) => [x.cat, x.amt]));
    if (!b.total && !Object.keys(b.cats).length) {
      return `${monthBar()}<section class="card">${emptyState('savings', 'No budgets yet', 'Set a monthly limit for everything, then optional limits per category. Kharcha warns you at 80% and when you go over.', `<button class="btn btn-filled" type="button" data-act="edit-budgets">${ic('add')}Set budgets</button>`)}</section>`;
    }
    const isNow = key === thisMonth();
    const daysLeft = isNow ? daysInMonth(key) - new Date().getDate() + 1 : 0;
    const overall = b.total ? `<section class="card">
        <div class="card-head"><h2>Monthly budget</h2>${levelNote(exp, b.total)}</div>
        <div class="result-hero"><b>${esc(money(exp, { whole: true }))}</b><span>spent of ${esc(money(b.total, { whole: true }))} · ${pct(exp / b.total)}</span></div>
        ${meterHtml(exp, b.total, 'Monthly budget used')}
        ${isNow && b.total > exp ? `<p class="hint">You can spend about <b>${esc(money(Math.floor((b.total - exp) / daysLeft), { whole: true }))}</b> a day for the next ${plural(daysLeft, 'day')}.</p>` : ''}
      </section>` : '';
    const cats = Object.entries(b.cats).map(([cat, lim]) => ({ cat, lim, s: spent.get(cat) || 0 })).sort((x, y) => y.s / y.lim - x.s / x.lim);
    const catHtml = cats.length ? `<section class="card flush">
        <div class="card-head"><h2>By category</h2></div>
        <div class="rank">${cats.map((x) => {
          const c = getCat(x.cat);
          return `<button class="rank-row" type="button" data-act="cat-tx" data-cat="${esc(x.cat)}">${catIco(c, 'sm')}<span class="rank-main">
            <span class="rank-top"><span class="name">${esc(c.name)}</span><span class="val">${esc(money(x.s, { whole: true }))} <span class="faint">/ ${esc(money(x.lim, { whole: true }))}</span></span></span>
            ${meterHtml(x.s, x.lim, c.name + ' budget used', 'thin')}
            <span class="rank-meta"><span>${pct(x.s / x.lim)} used</span>${levelNote(x.s, x.lim)}</span></span></button>`;
        }).join('')}</div></section>` : '';
    const loose = byCat(txIn(key, 'expense')).filter((x) => !b.cats[x.cat]);
    const looseHtml = loose.length ? `<section class="card flush">
        <div class="card-head"><h2>Spending without a budget</h2></div>
        <div class="list">${loose.map((x) => { const c = getCat(x.cat); return `<button class="li" type="button" data-act="edit-budgets">${catIco(c, 'sm')}<span class="li-main"><span class="li-title">${esc(c.name)}</span></span><span class="amt">${esc(money(x.amt, { whole: true }))}</span></button>`; }).join('')}</div>
      </section>` : '';
    return `${monthBar()}<div class="layout"><div class="main-col">${slot(overall, 1)}${slot(catHtml, 2)}</div><div class="side-col">${slot(looseHtml, 3)}</div></div>`;
  }
  function planGoals() {
    if (!state.goals.length) {
      return `<section class="card">${emptyState('flag', 'No savings goals yet', 'Save towards a trip, a phone or an emergency fund. Kharcha tells you how much to put aside each month.', `<button class="btn btn-filled" type="button" data-act="add-goal">${ic('add')}New goal</button>`)}</section>`;
    }
    const saved = sum(state.goals, (g) => g.saved), target = sum(state.goals, (g) => g.target);
    return `<div class="tiles"><div class="tile"><span>Saved so far</span><b>${esc(money(saved, { whole: true }))}</b><small>${pct(target ? saved / target : 0)} of all goals</small></div><div class="tile"><span>Still to save</span><b>${esc(money(Math.max(0, target - saved), { whole: true }))}</b><small>${plural(state.goals.length, 'goal')}</small></div></div>
      <div class="goal-grid">${state.goals.map((g) => {
        const p = g.target ? Math.min(1, g.saved / g.target) : 0;
        const plan = goalPlan(g);
        const done = g.saved >= g.target && g.target > 0;
        const sub = done ? 'Goal reached' : g.deadline ? `By ${dateLabel(g.deadline)}${plan.perMonth ? ` · save ${money(Math.ceil(plan.perMonth), { whole: true })}/month` : ''}` : 'No target date';
        return `<section class="card goal">
          <div class="goal-top"><span class="cat-ico" style="--h:${g.h}">${ic(g.icon)}</span>
            <span class="li-main"><span class="li-title">${esc(g.name)}</span><span class="li-sub">${esc(sub)}</span></span>
            <button class="icon-btn sm" type="button" data-act="edit-goal" data-id="${esc(g.id)}" aria-label="Edit ${esc(g.name)}">${ic('edit')}</button></div>
          ${progressHtml(p, g.name + ' progress')}
          <div class="goal-nums"><span><b>${esc(money(g.saved, { whole: true }))}</b> of ${esc(money(g.target, { whole: true }))}</span><span>${done ? `<span class="pill ok">${ic('check_circle')}Done</span>` : `${pct(p)} · ${esc(money(plan.left, { whole: true }))} to go`}</span></div>
          <div class="goal-actions"><button class="btn btn-tonal" type="button" data-act="goal-money" data-id="${esc(g.id)}" data-dir="in">${ic('add')}Add money</button><button class="btn btn-text" type="button" data-act="goal-money" data-id="${esc(g.id)}" data-dir="out">Withdraw</button></div>
        </section>`;
      }).join('')}</div>`;
  }
  function planBills() {
    if (!state.bills.length) {
      return `<section class="card">${emptyState('event_repeat', 'No bills or subscriptions', 'Add rent, electricity, recharges and subscriptions. Mark them paid in one tap and they’re logged as expenses.', `<button class="btn btn-filled" type="button" data-act="add-bill">${ic('add')}Add bill</button>`)}</section>`;
    }
    const monthly = sum(state.bills, monthlyEquiv);
    const week = state.bills.filter((b) => diffDays(b.nextDue, todayStr()) <= 7);
    const sorted = [...state.bills].sort((a, b) => a.nextDue.localeCompare(b.nextDue));
    return `<div class="tiles">
        <div class="tile"><span>Bills per month</span><b>${esc(money(monthly, { whole: true }))}</b><small>${plural(state.bills.length, 'bill')}, yearly ones spread out</small></div>
        <div class="tile"><span>Due within 7 days</span><b>${esc(money(sum(week, (b) => b.amount), { whole: true }))}</b><small>${plural(week.length, 'bill')}</small></div>
      </div>
      <section class="card flush"><div class="list">${sorted.map(billRow).join('')}</div></section>`;
  }
  function planSplits() {
    if (!state.splits.length) {
      return `<section class="card">${emptyState('group', 'No shared expenses', 'Split a dinner, trip or rent with friends and keep track of who has paid you back.', `<button class="btn btn-filled" type="button" data-act="add-split">${ic('add')}New split</button>`)}</section>`;
    }
    const bal = splitBalances();
    const people = bal.list.length ? `<section class="card flush">
        <div class="card-head"><h2>Balances</h2></div>
        <div class="list">${bal.list.map((p) => `<div class="li"><span class="avatar" style="--h:${hueOf(p.name)}">${initial(p.name)}</span><span class="li-main"><span class="li-title">${esc(p.name)}</span><span class="li-sub">${p.net > 0 ? 'owes you' : 'you owe'}</span></span><span class="amt ${p.net > 0 ? 'in' : ''}">${esc(money(Math.abs(p.net)))}</span></div>`).join('')}</div>
      </section>` : `<section class="card">${emptyState('task_alt', 'All settled up', 'Nobody owes anybody right now.')}</section>`;
    const list = [...state.splits].sort((a, b) => b.date.localeCompare(a.date)).map((s) => {
      const mine = s.paidBy === 'me';
      const rows = mine
        ? s.people.map((p, i) => `<div class="person-row"><span class="avatar" style="--h:${hueOf(p.name)}">${initial(p.name)}</span><span class="li-main"><span class="li-title">${esc(p.name)}</span><span class="li-sub">${esc(money(p.share))}</span></span>
            <button class="chip" type="button" data-act="settle" data-id="${esc(s.id)}" data-i="${i}" aria-pressed="${p.settled}">${p.settled ? ic('check') + 'Paid back' : 'Mark paid'}</button></div>`).join('')
        : `<div class="person-row"><span class="avatar" style="--h:${hueOf(s.paidBy)}">${initial(s.paidBy)}</span><span class="li-main"><span class="li-title">You owe ${esc(s.paidBy)}</span><span class="li-sub">${esc(money(s.myShare))}</span></span>
            <button class="chip" type="button" data-act="settle" data-id="${esc(s.id)}" data-i="me" aria-pressed="${s.iSettled}">${s.iSettled ? ic('check') + 'Settled' : 'Mark settled'}</button></div>`;
      return `<section class="card">
        <div class="goal-top"><span class="cat-ico" style="--h:268">${ic('group')}</span><span class="li-main"><span class="li-title">${esc(s.title)}</span><span class="li-sub">${esc(money(s.total))} · paid by ${mine ? 'you' : esc(s.paidBy)} · ${esc(dateLabel(s.date))}</span></span>
          <button class="icon-btn sm" type="button" data-act="edit-split" data-id="${esc(s.id)}" aria-label="Edit ${esc(s.title)}">${ic('edit')}</button></div>
        <div class="people">${rows}</div>
      </section>`;
    }).join('');
    const tiles = `<div class="tiles"><div class="tile"><span>You’re owed</span><b>${esc(money(bal.owed))}</b></div><div class="tile"><span>You owe</span><b>${esc(money(bal.owe))}</b></div></div>`;
    return `<div class="layout"><div class="main-col">${slot(list, 3)}</div><div class="side-col">${slot(tiles, 1)}${slot(people, 2)}</div></div>`;
  }

  // ============================================================
  // Tools: calculator + money calculators
  // ============================================================
  function renderTools() {
    const seg = `<div class="seg tools-seg" role="group" aria-label="Tools">
      <button type="button" data-act="tools-tab" data-v="calc" aria-pressed="${ui.tools === 'calc'}">${ic('check')}Calculator</button>
      <button type="button" data-act="tools-tab" data-v="money" aria-pressed="${ui.tools === 'money'}">${ic('check')}Money tools</button></div>`;
    const k = (label, key, cls = '', aria = '') => `<button class="ck ${cls}" type="button" data-act="calc-key" data-k="${esc(key)}" ${aria ? `aria-label="${aria}"` : ''}>${label}</button>`;
    const calcHtml = `<div class="calc">
        <div class="calc-display">
          <div class="calc-top">
            <button class="icon-btn sm" type="button" data-act="calc-history" aria-label="Calculation history">${ic('history')}</button>
            <button class="chip" type="button" data-act="calc-to-expense">${ic('add')}Add as expense</button>
          </div>
          <div class="calc-expr" id="calc-expr" aria-live="polite"></div><div class="calc-result" id="calc-res"></div>
        </div>
        <div class="calc-keys">
          ${k('AC', 'AC', 'fn', 'All clear')}${k('( )', '()', 'op', 'Parentheses')}${k('%', '%', 'op', 'Percent')}${k('÷', '÷', 'op', 'Divide')}
          ${k('7', '7')}${k('8', '8')}${k('9', '9')}${k('×', '×', 'op', 'Multiply')}
          ${k('4', '4')}${k('5', '5')}${k('6', '6')}${k('−', '−', 'op', 'Minus')}
          ${k('1', '1')}${k('2', '2')}${k('3', '3')}${k('+', '+', 'op', 'Plus')}
          ${k('0', '0')}${k('.', '.', '', 'Decimal point')}${k(ic('backspace'), 'del', '', 'Backspace')}${k('=', '=', 'eq', 'Equals')}
        </div>
      </div>`;
    const moneyHtml = `<div class="tool-grid">${Object.entries(TOOLS).map(([id, t]) => `<button class="tool-tile" type="button" data-act="open-tool" data-tool="${id}"><span class="cat-ico" style="--h:${t.h}">${ic(t.icon)}</span><b>${esc(t.name)}</b><small>${esc(t.desc)}</small></button>`).join('')}</div>
      <p class="hint">Results are estimates for planning. Banks and funds may round or compound differently.</p>`;
    return `${topbarHtml('Tools')}${seg}
      <div class="layout layout--tools" data-show="${ui.tools}">
        <div class="main-col tool-calc">${calcHtml}</div>
        <div class="side-col tool-money"><h2 class="section-title only-desktop">Money tools</h2>${moneyHtml}</div>
      </div>`;
  }

  // ---------- Safe expression evaluator (no eval) ----------
  function evaluate(src) {
    const s = String(src).replace(/\s+/g, '').replace(/,/g, '');
    let i = 0;
    const fail = () => { throw new Error('Invalid expression'); };
    const numTok = () => {
      const m = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
      if (!m) fail();
      i += m[0].length;
      return parseFloat(m[0]);
    };
    function primary() {
      const c = s[i];
      if (c === '(') { i++; const v = expr(); if (s[i] === ')') i++; else fail(); return v; }
      if (c === '−' || c === '-') { i++; return -factor().v; }
      return numTok();
    }
    function factor() {
      let v = primary(), pctFlag = false;
      while (s[i] === '%') { i++; v /= 100; pctFlag = true; }
      return { v, pct: pctFlag };
    }
    function term() {
      const f = factor();
      let v = f.v, p = f.pct;
      while (i < s.length && '×÷*/'.includes(s[i])) {
        const op = s[i++];
        const r = factor();
        v = op === '×' || op === '*' ? v * r.v : v / r.v;
        p = false;
      }
      return { v, pct: p };
    }
    function expr() {
      let v = term().v;
      while (s[i] === '+' || s[i] === '−' || s[i] === '-') {
        const op = s[i++];
        const r = term();
        const rv = r.pct ? v * r.v : r.v; // 500 + 18% = 590
        v = op === '+' ? v + rv : v - rv;
      }
      return v;
    }
    if (!s) return 0;
    const v = expr();
    if (i < s.length) fail();
    return v;
  }
  function tidyExpr(src) {
    let s = String(src).replace(/[+−×÷(.]+$/, '');
    const open = (s.match(/\(/g) || []).length - (s.match(/\)/g) || []).length;
    if (open > 0) s += ')'.repeat(open);
    return s;
  }
  function safeEval(src) {
    try {
      const v = evaluate(tidyExpr(src));
      return Number.isFinite(v) ? { ok: true, value: v } : { ok: false, error: 'Can’t divide by 0' };
    } catch { return { ok: false, error: 'Check the expression' }; }
  }
  const OPS = '+−×÷';
  const plainNum = (v) => {
    const r = Number(v.toPrecision(12));
    const s = Math.abs(r) < 1e21 ? r.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 10 }) : String(r);
    return s.replace('-', '−');
  };
  function prettyExpr(src) {
    return esc(src).replace(/\d+(?:\.\d*)?/g, (m) => {
      const [a, b] = m.split('.');
      const g = Number(a).toLocaleString(cur.locale, { maximumFractionDigits: 0 });
      return b !== undefined ? `${g}.${b}` : g;
    }).replace(/([+×÷])/g, ' $1 ').replace(/(\d|\)|%) ?−/g, '$1 − ');
  }
  const prettyNum = (v) => (Math.abs(v) >= 1e15 || (Math.abs(v) < 1e-6 && v !== 0) ? v.toExponential(6) : Number(v.toPrecision(12)).toLocaleString(cur.locale, { maximumFractionDigits: 10 })).replace(/^-/, '−');

  function calcPress(k) {
    const e = calc.expr;
    const last = e.slice(-1);
    calc.error = '';
    if (k === 'AC') { calc.expr = ''; calc.done = false; }
    else if (k === 'del') { calc.expr = calc.done ? '' : e.slice(0, -1); calc.done = false; }
    else if (k === '=') {
      if (!e) return updateCalc();
      const r = safeEval(e);
      if (r.ok) {
        if (/[+×÷%(]|.−/.test(e)) {
          calc.history.unshift({ expr: tidyExpr(e), result: r.value });
          calc.history = calc.history.slice(0, 30);
          prefsSave();
        }
        calc.expr = plainNum(r.value);
        calc.done = true;
      } else calc.error = r.error;
    } else if (OPS.includes(k)) {
      calc.done = false;
      const prev = e.slice(-2, -1);
      if (!e || e === '−') { if (k === '−') calc.expr = '−'; }
      else if (last === '(') { if (k === '−') calc.expr = e + k; }
      else if (OPS.includes(last)) {
        const unary = last === '−' && (prev === '(' || OPS.includes(prev));
        if (unary) calc.expr = prev === '(' ? e.slice(0, -1) + (k === '−' ? '−' : '') : e.slice(0, -2) + k;
        else if (k === '−' && (last === '×' || last === '÷')) calc.expr = e + k; // 5 × −3
        else calc.expr = e.slice(0, -1) + k;
      } else calc.expr = e + k;
    } else if (k === '%') {
      if (/[\d)%]/.test(last)) calc.expr = e + '%';
      calc.done = false;
    } else if (k === '()') {
      const open = (e.match(/\(/g) || []).length - (e.match(/\)/g) || []).length;
      if (calc.done) calc.expr = e + '×(';
      else if (open > 0 && /[\d)%.]/.test(last)) calc.expr = e + ')';
      else if (/[\d)%]/.test(last)) calc.expr = e + '×(';
      else calc.expr = e + '(';
      calc.done = false;
    } else if (k === '.') {
      if (calc.done) calc.expr = '0.';
      else {
        const m = e.match(/[\d.]*$/)[0];
        if (!m.includes('.')) calc.expr = e + (m === '' ? (/[)%]/.test(last) ? '×0.' : '0.') : '.');
      }
      calc.done = false;
    } else if (/^\d$/.test(k)) {
      if (calc.done) calc.expr = k;
      else if (/[)%]/.test(last)) calc.expr = e + '×' + k;
      else { const m = e.match(/[\d.]*$/)[0]; calc.expr = m === '0' ? e.slice(0, -1) + k : e + k; }
      calc.done = false;
    }
    if (calc.expr.length > 80) calc.expr = calc.expr.slice(0, 80);
    updateCalc();
  }
  function updateCalc() {
    const ex = $('#calc-expr'), res = $('#calc-res');
    if (!ex) return;
    ex.innerHTML = calc.expr ? prettyExpr(calc.expr) : '<span class="faint">0</span>';
    ex.classList.toggle('long', calc.expr.length > 12 && calc.expr.length <= 20);
    ex.classList.toggle('xlong', calc.expr.length > 20);
    res.classList.toggle('err', !!calc.error);
    if (calc.error) { res.textContent = calc.error; return; }
    const hasOp = /[+×÷%(]|.−/.test(calc.expr);
    if (hasOp && !calc.done) {
      const r = safeEval(calc.expr);
      res.textContent = r.ok ? '= ' + prettyNum(r.value) : '';
    } else res.textContent = '';
  }
  function calcValue() {
    const r = safeEval(calc.expr);
    return r.ok ? r.value : 0;
  }

  // ---------- Money calculators ----------
  const yearsTable = (title, head, rows) => ({ title, head, rows });
  const TOOLS = {
    emi: {
      name: 'EMI calculator', desc: 'Loan EMI, total interest and yearly payoff', icon: 'account_balance', h: 210,
      fields: [
        { id: 'p', label: 'Loan amount', type: 'range', money: true, min: 10000, max: 10000000, step: 10000, def: 1000000 },
        { id: 'r', label: 'Interest rate', type: 'range', suffix: '% p.a.', min: 1, max: 30, step: 0.05, def: 8.5 },
        { id: 'n', label: 'Tenure', type: 'range', suffix: 'years', min: 1, max: 30, step: 1, def: 20 },
      ],
      calc(v) {
        const P = v.p, i = v.r / 1200, n = Math.round(v.n * 12);
        if (!(P > 0 && n > 0)) return null;
        const emi = i ? (P * i * (1 + i) ** n) / ((1 + i) ** n - 1) : P / n;
        const total = emi * n, interest = total - P;
        let bal = P;
        const rows = [];
        for (let y = 1; y <= Math.ceil(n / 12); y++) {
          let pp = 0, ii = 0;
          for (let m = 0; m < 12 && (y - 1) * 12 + m < n; m++) { const int = bal * i; const pr = emi - int; ii += int; pp += pr; bal -= pr; }
          rows.push([`Year ${y}`, money(pp, { whole: true }), money(ii, { whole: true }), money(Math.max(0, bal), { whole: true })]);
        }
        return {
          hero: { label: 'Monthly EMI', value: money(emi, { whole: true }) },
          donut: [{ label: 'Principal', v: P, color: 'var(--s1)' }, { label: 'Interest', v: interest, color: 'var(--s2)' }],
          center: { label: 'Total', value: compact(total) },
          rows: [['Principal', money(P, { whole: true })], ['Total interest', money(interest, { whole: true })], ['Total you pay', money(total, { whole: true })], ['Interest as % of loan', pct(interest / P, 1)]],
          table: yearsTable('Year by year', ['Year', 'Principal', 'Interest', 'Balance'], rows),
          action: { label: 'Add EMI as a monthly bill', icon: 'event_repeat', run: () => openBillSheet({ preset: { name: 'Loan EMI', amount: Math.round(emi), cat: 'emi', freq: 'monthly' } }) },
        };
      },
    },
    sip: {
      name: 'SIP calculator', desc: 'Monthly investing with optional yearly step-up', icon: 'trending_up', h: 150,
      fields: [
        { id: 'a', label: 'Monthly investment', type: 'range', money: true, min: 500, max: 200000, step: 500, def: 5000 },
        { id: 'r', label: 'Expected return', type: 'range', suffix: '% p.a.', min: 1, max: 30, step: 0.5, def: 12 },
        { id: 'n', label: 'Time period', type: 'range', suffix: 'years', min: 1, max: 40, step: 1, def: 10 },
        { id: 'u', label: 'Yearly step-up', type: 'range', suffix: '%', min: 0, max: 25, step: 1, def: 0 },
      ],
      calc(v) {
        const i = v.r / 1200, months = Math.round(v.n * 12);
        if (!(v.a > 0 && months > 0)) return null;
        let inst = v.a, bal = 0, inv = 0;
        const rows = [];
        for (let m = 1; m <= months; m++) {
          if (m > 1 && (m - 1) % 12 === 0) inst *= 1 + v.u / 100;
          bal = (bal + inst) * (1 + i);
          inv += inst;
          if (m % 12 === 0 || m === months) rows.push([`Year ${Math.ceil(m / 12)}`, money(inv, { whole: true }), money(bal, { whole: true })]);
        }
        return {
          hero: { label: 'Estimated value', value: money(bal, { whole: true }) },
          donut: [{ label: 'Invested', v: inv, color: 'var(--s1)' }, { label: 'Estimated returns', v: bal - inv, color: 'var(--s3)' }],
          center: { label: 'Value', value: compact(bal) },
          rows: [['Total invested', money(inv, { whole: true })], ['Estimated returns', money(bal - inv, { whole: true })], ['Wealth gain', `${(bal / inv).toFixed(2)}×`]],
          table: yearsTable('Growth by year', ['Year', 'Invested', 'Value'], rows),
          note: 'Assumes the return stays the same every year. Market returns vary.',
        };
      },
    },
    fd: {
      name: 'FD & lumpsum', desc: 'Fixed deposit or one-time investment growth', icon: 'savings', h: 44,
      fields: [
        { id: 'p', label: 'Amount invested', type: 'range', money: true, min: 1000, max: 10000000, step: 1000, def: 100000 },
        { id: 'r', label: 'Interest rate', type: 'range', suffix: '% p.a.', min: 1, max: 20, step: 0.05, def: 7 },
        { id: 'n', label: 'Time period', type: 'range', suffix: 'years', min: 0.5, max: 30, step: 0.5, def: 5 },
        { id: 'k', label: 'Interest compounds', type: 'chips', def: 4, options: [{ v: 12, label: 'Monthly' }, { v: 4, label: 'Quarterly' }, { v: 2, label: 'Half-yearly' }, { v: 1, label: 'Yearly' }] },
      ],
      calc(v) {
        if (!(v.p > 0 && v.n > 0)) return null;
        const A = v.p * (1 + v.r / 100 / v.k) ** (v.k * v.n);
        const eff = (1 + v.r / 100 / v.k) ** v.k - 1;
        return {
          hero: { label: 'Maturity value', value: money(A, { whole: true }) },
          donut: [{ label: 'Invested', v: v.p, color: 'var(--s1)' }, { label: 'Interest earned', v: A - v.p, color: 'var(--s3)' }],
          center: { label: 'Maturity', value: compact(A) },
          rows: [['Amount invested', money(v.p, { whole: true })], ['Interest earned', money(A - v.p, { whole: true })], ['Effective yearly yield', pct(eff, 2)]],
          note: 'Indian banks usually compound FDs quarterly. Interest is taxable at your slab rate.',
        };
      },
    },
    gst: {
      name: 'GST calculator', desc: 'Add or remove GST, with CGST and SGST split', icon: 'receipt', h: 44,
      fields: [
        { id: 'mode', label: 'Calculation', type: 'seg', def: 'add', options: [{ v: 'add', label: 'Add GST' }, { v: 'remove', label: 'Remove GST' }] },
        { id: 'a', label: 'Amount', type: 'money', def: 10000 },
        { id: 'r', label: 'GST rate', type: 'chips', def: 18, options: [{ v: 3, label: '3%' }, { v: 5, label: '5%' }, { v: 18, label: '18%' }, { v: 40, label: '40%' }, { v: 'other', label: 'Other' }] },
        { id: 'cr', label: 'Rate', type: 'range', suffix: '%', min: 0, max: 50, step: 0.25, def: 12, show: (v) => v.r === 'other' },
      ],
      calc(v) {
        if (!(v.a > 0)) return null;
        const rate = v.r === 'other' ? v.cr : v.r;
        const net = v.mode === 'add' ? v.a : v.a / (1 + rate / 100);
        const tax = net * (rate / 100);
        const gross = net + tax;
        return {
          hero: v.mode === 'add' ? { label: 'Price including GST', value: money(gross) } : { label: 'Price before GST', value: money(net) },
          rows: [['Price before GST', money(net)], [`CGST (${rate / 2}%)`, money(tax / 2)], [`SGST (${rate / 2}%)`, money(tax / 2)], ['Total GST', money(tax)], ['Price including GST', money(gross)]],
          note: 'Common slabs since September 2025: 5% and 18%, 40% for luxury and sin goods, 3% for gold. For sales across states, IGST replaces CGST + SGST at the same total rate.',
        };
      },
    },
    split: {
      name: 'Split & tip', desc: 'Share a bill evenly, with tip', icon: 'group', h: 268,
      fields: [
        { id: 'a', label: 'Bill amount', type: 'money', def: 2400 },
        { id: 't', label: 'Tip', type: 'chips', def: 0, options: [{ v: 0, label: 'No tip' }, { v: 5, label: '5%' }, { v: 10, label: '10%' }, { v: 15, label: '15%' }, { v: 20, label: '20%' }] },
        { id: 'p', label: 'People', type: 'stepper', def: 4, min: 1, max: 50 },
        { id: 'round', label: 'Round up each share', type: 'toggle', def: true },
      ],
      calc(v) {
        if (!(v.a > 0)) return null;
        const tip = (v.a * v.t) / 100, total = v.a + tip;
        const each = total / v.p;
        const shown = v.round ? Math.ceil(each) : each;
        const rows = [['Tip', money(tip)], ['Total with tip', money(total)]];
        if (v.round) rows.push(['Extra collected by rounding', money(shown * v.p - total)]);
        return {
          hero: { label: `Each of ${v.p} pays`, value: money(shown) },
          rows,
          action: { label: 'Track this as a split', icon: 'group_add', run: () => openSplitSheet({ preset: { total: round2(total) } }) },
        };
      },
    },
    fuel: {
      name: 'Fuel cost', desc: 'Trip fuel cost or your vehicle’s mileage', icon: 'local_gas_station', h: 4,
      fields: [
        { id: 'mode', label: 'Calculate', type: 'seg', def: 'trip', options: [{ v: 'trip', label: 'Trip cost' }, { v: 'mileage', label: 'Mileage' }] },
        { id: 'd', label: 'Distance', type: 'range', suffix: 'km', min: 1, max: 3000, step: 1, def: 240, show: (v) => v.mode === 'trip' },
        { id: 'm', label: 'Mileage', type: 'range', suffix: 'km/L', min: 5, max: 80, step: 0.5, def: 18, show: (v) => v.mode === 'trip' },
        { id: 'rt', label: 'Return trip', type: 'toggle', def: false, show: (v) => v.mode === 'trip' },
        { id: 'km', label: 'Kilometres driven since last fill', type: 'range', suffix: 'km', min: 10, max: 2000, step: 1, def: 420, show: (v) => v.mode === 'mileage' },
        { id: 'l', label: 'Litres filled', type: 'range', suffix: 'L', min: 1, max: 100, step: 0.1, def: 24, show: (v) => v.mode === 'mileage' },
        { id: 'pr', label: 'Fuel price', type: 'range', money: true, suffix: '/L', min: 50, max: 200, step: 0.1, def: 103 },
      ],
      calc(v) {
        if (v.mode === 'mileage') {
          if (!(v.km > 0 && v.l > 0)) return null;
          const kpl = v.km / v.l, cost = v.l * v.pr;
          return {
            hero: { label: 'Your mileage', value: `${kpl.toFixed(1)} km/L` },
            rows: [['Cost of this fill', money(cost)], ['Cost per km', money(cost / v.km)], ['Cost per 100 km', money((cost / v.km) * 100, { whole: true })]],
            action: { label: 'Log this fill as a fuel expense', icon: 'local_gas_station', run: () => openTxSheet({ cat: 'fuel', amount: round2(cost), note: `Fuel – ${v.l} L` }) },
          };
        }
        if (!(v.d > 0 && v.m > 0)) return null;
        const dist = v.d * (v.rt ? 2 : 1);
        const litres = dist / v.m, cost = litres * v.pr;
        return {
          hero: { label: `Fuel for ${fmtN(dist)} km`, value: money(cost, { whole: true }) },
          rows: [['Fuel needed', `${litres.toFixed(1)} L`], ['Cost per km', money(cost / dist)]],
          action: { label: 'Log as a fuel expense', icon: 'local_gas_station', run: () => openTxSheet({ cat: 'fuel', amount: Math.round(cost), note: `Fuel for ${fmtN(dist)} km trip` }) },
        };
      },
    },
    discount: {
      name: 'Discount', desc: 'Sale price after one or two discounts', icon: 'sell', h: 318,
      fields: [
        { id: 'a', label: 'Original price', type: 'money', def: 2499 },
        { id: 'd', label: 'Discount', type: 'range', suffix: '%', min: 0, max: 90, step: 1, def: 30 },
        { id: 'x', label: 'Extra discount (bank offer, coupon)', type: 'range', suffix: '%', min: 0, max: 50, step: 1, def: 10 },
      ],
      calc(v) {
        if (!(v.a > 0)) return null;
        const after = v.a * (1 - v.d / 100) * (1 - v.x / 100);
        return {
          hero: { label: 'You pay', value: money(after) },
          rows: [['You save', money(v.a - after)], ['Effective discount', pct(1 - after / v.a, 1)]],
          note: v.x ? 'Extra discounts apply on the already-reduced price, so 30% + 10% is 37%, not 40%.' : '',
        };
      },
    },
    inflation: {
      name: 'Inflation', desc: 'What today’s cost will be in future', icon: 'show_chart', h: 340,
      fields: [
        { id: 'a', label: 'Cost today', type: 'money', def: 100000 },
        { id: 'r', label: 'Inflation rate', type: 'range', suffix: '% p.a.', min: 1, max: 15, step: 0.5, def: 6 },
        { id: 'n', label: 'Years from now', type: 'range', suffix: 'years', min: 1, max: 40, step: 1, def: 10 },
      ],
      calc(v) {
        if (!(v.a > 0)) return null;
        const f = (1 + v.r / 100) ** v.n;
        return {
          hero: { label: `Cost in ${v.n} years`, value: money(v.a * f, { whole: true }) },
          rows: [['Increase', money(v.a * f - v.a, { whole: true })], [`What ${money(v.a, { whole: true })} buys then, in today’s money`, money(v.a / f, { whole: true })]],
        };
      },
    },
  };

  function openTool(id) {
    const t = TOOLS[id];
    if (!t) return;
    const v = toolVals[id] || (toolVals[id] = Object.fromEntries(t.fields.map((f) => [f.id, f.def])));
    const fieldHtml = (f) => {
      if (f.show && !f.show(v)) return '';
      const val = v[f.id];
      if (f.type === 'range') {
        const scale = (x) => (f.money ? compact(x) : `${fmtN(x)}${f.suffix && f.suffix.length <= 2 ? f.suffix : ''}`);
        return `<div class="slider-field"><div class="slider-top"><label for="tf-${f.id}">${esc(f.label)}</label><span class="mini">${f.money ? `<b>${esc(cur.symbol)}</b>` : ''}<input id="tf-${f.id}" inputmode="decimal" autocomplete="off" data-num="${f.id}" value="${val}">${f.suffix ? `<b>${esc(f.suffix)}</b>` : ''}</span></div>
          <input type="range" id="tr-${f.id}" min="${f.min}" max="${f.max}" step="${f.step}" value="${clamp(val, f.min, f.max)}" data-range="${f.id}" aria-label="${esc(f.label)}">
          <div class="slider-scale"><span>${esc(scale(f.min))}</span><span>${esc(scale(f.max))}</span></div></div>`;
      }
      if (f.type === 'money') return `<label class="field"><span>${esc(f.label)}</span><span class="affix"><b>${esc(cur.symbol)}</b><input id="tf-${f.id}" inputmode="decimal" autocomplete="off" data-num="${f.id}" value="${val}"></span></label>`;
      if (f.type === 'chips') return `<div><div class="section-title" style="padding:0 0 8px">${esc(f.label)}</div><div class="chips">${f.options.map((o) => `<button class="chip" type="button" data-chip="${f.id}" data-v="${o.v}" aria-pressed="${o.v === val}">${o.v === val ? ic('check') : ''}${esc(o.label)}</button>`).join('')}</div></div>`;
      if (f.type === 'seg') return `<div class="seg" role="group" aria-label="${esc(f.label)}">${f.options.map((o) => `<button type="button" data-seg="${f.id}" data-v="${o.v}" aria-pressed="${o.v === val}">${ic('check')}${esc(o.label)}</button>`).join('')}</div>`;
      if (f.type === 'toggle') return `<label class="switch-row"><span class="txt">${esc(f.label)}</span><span class="switch"><input type="checkbox" id="tt-${f.id}" data-toggle="${f.id}" ${val ? 'checked' : ''}><i></i></span></label>`;
      if (f.type === 'stepper') return `<div class="switch-row"><span class="txt">${esc(f.label)}</span><span class="stepper"><button class="icon-btn sm" type="button" data-step="${f.id}" data-d="-1" aria-label="Fewer">${ic('remove')}</button><b>${val}</b><button class="icon-btn sm" type="button" data-step="${f.id}" data-d="1" aria-label="More">${ic('add')}</button></span></div>`;
      return '';
    };
    let result = null;
    const outHtml = () => {
      result = t.calc({ ...v });
      if (!result) return `<section class="card">${emptyState('edit', 'Enter the numbers above', 'Results update as you type.')}</section>`;
      const r = result;
      return `<section class="card">
          <div class="result-hero"><span>${esc(r.hero.label)}</span><b>${esc(r.hero.value)}</b></div>
          ${r.donut ? `<div class="donut-wrap"><div class="donut">${donutSvg(r.donut)}<div class="center"><span>${esc(r.center.label)}</span><b>${esc(r.center.value)}</b></div></div>
            <div class="keylist" style="flex:1;min-width:150px">${r.donut.map((d) => `<div class="keyrow"><i style="background:${d.color}"></i><span class="name">${esc(d.label)}</span><span class="pct">${pct(d.v / sum(r.donut, (x) => x.v))}</span></div>`).join('')}</div></div>` : ''}
          <div class="kv">${r.rows.map(([k2, val]) => `<div><span>${esc(k2)}</span><b>${esc(val)}</b></div>`).join('')}</div>
        </section>
        ${r.action ? `<button class="btn btn-tonal btn-block" type="button" data-tool-action>${ic(r.action.icon)}${esc(r.action.label)}</button>` : ''}
        ${r.note ? `<p class="hint">${esc(r.note)}</p>` : ''}
        ${r.table ? `<section class="card"><div class="card-head"><h2>${esc(r.table.title)}</h2></div><div class="table-wrap"><table class="data"><thead><tr>${r.table.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${r.table.rows.map((row) => `<tr>${row.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>` : ''}`;
    };
    openSheet({
      title: t.name,
      html: `<section class="card form" id="tool-form">${t.fields.map(fieldHtml).join('')}</section><div id="tool-out" class="form"></div>`,
      onMount(el) {
        const form = $('#tool-form', el), out = $('#tool-out', el);
        const redrawOut = () => { out.innerHTML = outHtml(); };
        const redrawForm = () => { form.innerHTML = t.fields.map(fieldHtml).join(''); redrawOut(); };
        redrawOut();
        el.addEventListener('input', (e) => {
          const n = e.target.dataset.num, r = e.target.dataset.range;
          if (n) {
            v[n] = num(e.target.value);
            const rg = $(`#tr-${n}`, el);
            if (rg) rg.value = v[n];
            redrawOut();
          } else if (r) {
            v[r] = Number(e.target.value);
            const box = $(`#tf-${r}`, el);
            if (box) box.value = v[r];
            redrawOut();
          } else if (e.target.dataset.toggle) {
            v[e.target.dataset.toggle] = e.target.checked;
            redrawForm();
          }
        });
        el.addEventListener('click', (e) => {
          const b = e.target.closest('button');
          if (!b) return;
          if (b.dataset.chip) { const f = t.fields.find((x) => x.id === b.dataset.chip); v[f.id] = f.options.find((o) => String(o.v) === b.dataset.v).v; redrawForm(); }
          else if (b.dataset.seg) { const f = t.fields.find((x) => x.id === b.dataset.seg); v[f.id] = f.options.find((o) => String(o.v) === b.dataset.v).v; redrawForm(); }
          else if (b.dataset.step) { const f = t.fields.find((x) => x.id === b.dataset.step); v[f.id] = clamp(v[f.id] + Number(b.dataset.d), f.min, f.max); redrawForm(); }
          else if (b.hasAttribute('data-tool-action') && result && result.action) result.action.run();
        });
      },
    });
  }

  // ============================================================
  // Sheets, dialogs, snackbar
  // ============================================================
  const sheets = [];
  let framed = true;
  try { framed = window.top !== window.self; } catch { framed = true; }
  let ignorePop = 0;
  function openSheet({ title, html, foot = '', action = '', cls = '', onMount, onClose, onKey }) {
    hideTip();
    const el = document.createElement('div');
    el.className = `sheet ${cls}`;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', title);
    el.innerHTML = `<div class="sheet-panel">
      <div class="sheet-head"><button class="icon-btn" type="button" data-sheet-close aria-label="Close">${ic('close')}</button><h2>${esc(title)}</h2>${action}</div>
      <div class="sheet-body">${html}</div>${foot ? `<div class="sheet-foot">${foot}</div>` : ''}</div>`;
    $('#sheets').appendChild(el);
    const sheet = { el, onClose, onKey, pushed: false, close: () => closeSheet(sheet) };
    $('[data-sheet-close]', el).addEventListener('click', () => sheet.close());
    el.addEventListener('click', (e) => { if (e.target === el) sheet.close(); });
    sheets.push(sheet);
    document.body.style.overflow = 'hidden';
    $('#fab').hidden = true;
    if (!framed) { try { history.pushState({ kharchaSheet: sheets.length }, ''); sheet.pushed = true; } catch { /* no history */ } }
    if (onMount) onMount(el, sheet);
    setTimeout(() => { const first = $('.sheet-head [data-sheet-close]', el); if (first && !el.contains(document.activeElement)) first.focus({ preventScroll: true }); }, 30);
    return sheet;
  }
  function closeSheet(sheet, fromPop = false) {
    const i = sheets.indexOf(sheet);
    if (i < 0) return;
    sheets.splice(i, 1);
    sheet.el.classList.add('closing');
    setTimeout(() => sheet.el.remove(), 180);
    if (!sheets.length) { document.body.style.overflow = ''; updateChrome(); }
    if (sheet.onClose) sheet.onClose();
    if (sheet.pushed && !fromPop) { ignorePop++; try { history.back(); } catch { ignorePop--; } }
  }
  window.addEventListener('popstate', () => {
    if (ignorePop) { ignorePop--; return; }
    const top = sheets[sheets.length - 1];
    if (top) closeSheet(top, true);
  });

  function openDialog({ title, html = '', icon = '', actions, onAction }) {
    return new Promise((resolve) => {
      const root = $('#dialog-root');
      const scrim = document.createElement('div');
      scrim.className = 'dialog-scrim';
      scrim.innerHTML = `<div class="dialog" role="alertdialog" aria-modal="true" aria-label="${esc(title)}">
        ${icon ? ic(icon, 'icon-top') : ''}<h2>${esc(title)}</h2>${html}
        <div class="dialog-actions">${actions.map((a, i) => `<button class="btn ${a.kind === 'filled' ? 'btn-filled' : a.kind === 'danger' ? 'btn-danger' : 'btn-text'}" type="button" data-i="${i}">${esc(a.label)}</button>`).join('')}</div></div>`;
      root.appendChild(scrim);
      const done = (val) => { scrim.remove(); resolve(val); };
      scrim.addEventListener('click', (e) => {
        if (e.target === scrim) return done(null);
        const b = e.target.closest('.dialog-actions button');
        if (!b) return;
        const a = actions[Number(b.dataset.i)];
        if (onAction && onAction(a.value, scrim) === false) return;
        done(a.value);
      });
      scrim.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); done(null); }
        if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
          const primary = actions.findIndex((a) => a.kind === 'filled' || a.kind === 'danger');
          if (primary >= 0) $(`.dialog-actions button[data-i="${primary}"]`, scrim).click();
        }
      });
      setTimeout(() => { const f = $('input, select', scrim) || $('.dialog-actions button:last-child', scrim); if (f) f.focus(); }, 30);
    });
  }
  const confirmDialog = (title, text, okLabel, danger = false) =>
    openDialog({ title, html: `<p>${esc(text)}</p>`, actions: [{ label: 'Cancel', value: false }, { label: okLabel, value: true, kind: danger ? 'danger' : 'filled' }] }).then((v) => v === true);
  async function pickDialog(title, options, current) {
    const html = `<div class="list" style="margin:0 -24px">${options.map((o, i) => `<button class="li" type="button" data-pick="${i}" style="min-height:52px;padding:6px 24px">${o.ico || ''}<span class="li-main"><span class="li-title">${esc(o.label)}</span></span>${o.value === current ? ic('check', 'sm') : ''}</button>`).join('')}</div>`;
    return new Promise((resolve) => {
      openDialog({ title, html, actions: [{ label: 'Cancel', value: undefined }] }).then((v) => resolve(v === undefined || v === null ? undefined : v));
      const last = $('#dialog-root').lastElementChild;
      last.addEventListener('click', (e) => {
        const b = e.target.closest('[data-pick]');
        if (!b) return;
        last.remove();
        resolve(options[Number(b.dataset.pick)].value);
      });
    });
  }

  let snackTimer;
  function toast(msg, action) {
    const sb = $('#snackbar');
    sb.innerHTML = `<p>${esc(msg)}</p>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
    sb.classList.toggle('over-sheet', sheets.length > 0);
    sb.classList.toggle('above-fab', !sheets.length && !$('#fab').hidden);
    sb.hidden = false;
    sb.style.animation = 'none';
    void sb.offsetHeight;
    sb.style.animation = '';
    const hide = () => { sb.hidden = true; };
    if (action) $('button', sb).onclick = () => { hide(); action.run(); };
    clearTimeout(snackTimer);
    snackTimer = setTimeout(hide, action ? 6000 : 3800);
  }

  // ============================================================
  // Add / edit transaction
  // ============================================================
  let lastMode = 'upi';
  function openTxSheet(opts = {}) {
    const tx = opts.tx || null;
    const d = {
      type: tx ? tx.type : opts.type || (opts.cat && INCOME_CATS.some((c) => c.id === opts.cat) ? 'income' : 'expense'),
      expr: tx ? plainNum(tx.amount) : opts.amount ? plainNum(round2(opts.amount)) : '',
      cat: tx ? tx.cat : opts.cat || '',
      mode: tx ? tx.mode : opts.mode || lastMode,
      date: tx ? tx.date : opts.date || todayStr(),
      note: tx ? tx.note : opts.note || '',
    };
    if (!d.cat || !allCats(d.type).some((c) => c.id === d.cat)) d.cat = allCats(d.type)[0].id;
    const title = tx ? 'Edit entry' : d.type === 'income' ? 'Add income' : 'Add expense';
    const keys = ['7', '8', '9', '÷', '4', '5', '6', '×', '1', '2', '3', '−', '.', '0', 'del', '+'];
    const keyHtml = keys.map((k) => `<button class="key ${'+−×÷'.includes(k) ? 'op' : ''}" type="button" data-k="${k}" aria-label="${k === 'del' ? 'Backspace' : k}">${k === 'del' ? ic('backspace') : k}</button>`).join('');
    openSheet({
      title,
      cls: 'tx-sheet',
      action: tx ? `<button class="icon-btn" type="button" id="tx-delete" aria-label="Delete entry">${ic('delete')}</button>` : '',
      html: `
        <div class="seg" role="group" aria-label="Entry type">
          <button type="button" data-type="expense">${ic('check')}Expense</button>
          <button type="button" data-type="income">${ic('check')}Income</button>
        </div>
        <div class="amount-box"><div class="amount-line"><div class="amount-display" id="amt-disp" aria-live="polite"></div></div><div class="amount-eval" id="amt-eval"></div></div>
        <div><div class="section-title" style="padding:0 0 4px">Category</div><div class="cat-grid" id="cat-grid" role="group" aria-label="Category"></div></div>
        <div class="row2">
          <label class="field"><span>Date</span><input type="date" id="tx-date" value="${d.date}" max="${addDays(todayStr(), 366)}"></label>
          <label class="field"><span id="mode-label">Paid with</span><select id="tx-mode">${MODES.map((m) => `<option value="${m.id}" ${m.id === d.mode ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>${ic('arrow_drop_down', 'select-ico')}</label>
        </div>
        <label class="field"><span>Note</span><input id="tx-note" maxlength="80" autocomplete="off" placeholder="e.g. Lunch with team" value="${esc(d.note)}"></label>`,
      foot: `<div class="keypad" id="keypad">${keyHtml}<button class="key save" type="button" id="tx-save">${ic('check')}Save</button></div>`,
      onMount(el, sh) {
        const disp = $('#amt-disp', el), evalEl = $('#amt-eval', el);
        const drawType = () => {
          $$('[data-type]', el).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.type === d.type)));
          $('#mode-label', el).textContent = d.type === 'income' ? 'Received in' : 'Paid with';
          $('#cat-grid', el).innerHTML = allCats(d.type).map((c) => `<button class="cat-opt" type="button" data-cat="${esc(c.id)}" aria-pressed="${c.id === d.cat}">${catIco(c)}<span>${esc(c.short || c.name)}</span></button>`).join('');
          const sel = $(`.cat-opt[aria-pressed="true"]`, el);
          if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'center' });
          $('h2', el).textContent = tx ? 'Edit entry' : d.type === 'income' ? 'Add income' : 'Add expense';
        };
        const drawAmt = () => {
          disp.classList.toggle('placeholder', !d.expr);
          disp.innerHTML = `<span class="cur">${esc(cur.symbol)}</span>${d.expr ? prettyExpr(d.expr) : '0'}`;
          const hasOp = /[+×÷]|.−/.test(d.expr);
          const r = safeEval(d.expr);
          evalEl.textContent = hasOp && r.ok ? `= ${money(r.value)}` : '';
        };
        const press = (k) => {
          const e = d.expr, last = e.slice(-1);
          if (k === 'del') d.expr = e.slice(0, -1);
          else if ('+−×÷'.includes(k)) { if (!e) return; d.expr = '+−×÷.'.includes(last) ? e.slice(0, -1) + k : e + k; }
          else if (k === '.') { const m = e.match(/[\d.]*$/)[0]; if (!m.includes('.')) d.expr = e + (m === '' ? '0.' : '.'); }
          else if (/^\d$/.test(k)) {
            const m = e.match(/[\d.]*$/)[0];
            if (/\.\d\d$/.test(m)) return;
            if (m.replace('.', '').length >= 10) return;
            d.expr = m === '0' ? e.slice(0, -1) + k : e + k;
          }
          drawAmt();
        };
        drawType();
        drawAmt();
        el.addEventListener('click', (e) => {
          const b = e.target.closest('button');
          if (!b) return;
          if (b.dataset.type && b.dataset.type !== d.type) { d.type = b.dataset.type; d.cat = allCats(d.type)[0].id; drawType(); }
          else if (b.dataset.cat) { d.cat = b.dataset.cat; $$('.cat-opt', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b))); }
          else if (b.dataset.k) press(b.dataset.k);
          else if (b.id === 'tx-save') save();
          else if (b.id === 'tx-delete') del();
        });
        sh.onKey = (e) => {
          const tg = e.target instanceof Element ? e.target : document.body;
          if (/^(INPUT|SELECT|TEXTAREA)$/.test(tg.tagName)) { if (e.key === 'Enter' && tg.id === 'tx-note') save(); return; }
          if (tg.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return;
          const map = { '*': '×', x: '×', '/': '÷', '-': '−', '+': '+', Backspace: 'del', '.': '.', ',': '.' };
          if (/^\d$/.test(e.key)) { press(e.key); e.preventDefault(); }
          else if (map[e.key]) { press(map[e.key]); e.preventDefault(); }
          else if (e.key === 'Enter') { save(); e.preventDefault(); }
        };
        function save() {
          const r = safeEval(d.expr);
          const amount = r.ok ? round2(r.value) : 0;
          if (!(amount > 0)) {
            evalEl.textContent = d.expr ? 'Amount must be more than zero' : 'Enter an amount using the keypad';
            evalEl.style.color = 'var(--error)';
            setTimeout(() => { evalEl.style.color = ''; }, 1600);
            return;
          }
          const date = $('#tx-date', el).value || todayStr();
          const rec = {
            ...(tx || {}),
            id: tx ? tx.id : uid(), type: d.type, amount, cat: d.cat, mode: $('#tx-mode', el).value,
            date: isDateStr(date) ? date : todayStr(), note: $('#tx-note', el).value.trim().slice(0, 80), ts: tx ? tx.ts : Date.now(),
            ...(session.user ? { by: (tx && tx.by) || session.user.uid } : {}),
          };
          lastMode = rec.mode;
          const fresh = commit(() => upsert(state.txns, rec));
          sh.close();
          let msg = tx ? 'Changes saved.' : `Added ${money(amount)} · ${getCat(rec.cat).name}.`;
          if (rec.type === 'expense' && rec.date.startsWith(thisMonth())) {
            const lim = state.budgets.cats[rec.cat];
            if (lim) {
              const spent = sum(txIn(thisMonth(), 'expense').filter((t) => t.cat === rec.cat), (t) => t.amount);
              if (spent > lim) msg += ` ${getCat(rec.cat).name} is over budget by ${money(spent - lim, { whole: true })}.`;
              else if (spent >= 0.8 * lim) msg += ` ${pct(spent / lim)} of ${getCat(rec.cat).short} budget used.`;
            }
          }
          toast(msg + freshNote(fresh));
        }
        function del() {
          const snapshot = { ...tx };
          commit(() => { state.txns = state.txns.filter((t) => t.id !== tx.id); }, { keepSample: true });
          sh.close();
          toast('Entry deleted.', { label: 'Undo', run: () => commit(() => upsert(state.txns, snapshot), { keepSample: true }) });
        }
      },
    });
  }

  // ============================================================
  // Budgets editor
  // ============================================================
  function openBudgetSheet() {
    const b = state.budgets;
    const cats = allCats('expense');
    const past = [1, 2, 3].map((n) => shiftMonth(thisMonth(), -n)).filter((m) => txIn(m, 'expense').length);
    const nPast = past.length || 1;
    const avgFor = (cat) => sum(past, (m) => sum(txIn(m, 'expense').filter((t) => t.cat === cat), (t) => t.amount)) / nPast;
    const avgTotal = sum(past, (m) => totals(m).exp) / nPast;
    const roundUp = (x, step = 500) => (x > 0 ? Math.ceil(x / step) * step : 0);
    const sheet = openSheet({
      title: 'Budgets',
      html: `
        <label class="field"><span>Monthly budget for all spending</span><span class="affix"><b>${esc(cur.symbol)}</b><input id="b-total" inputmode="decimal" autocomplete="off" value="${b.total || ''}" placeholder="e.g. 40000"></span></label>
        ${avgTotal > 0 ? `<button class="btn btn-tonal" type="button" id="b-suggest">${ic('auto_awesome')}Fill in from my last ${nPast === 1 ? 'month' : nPast + ' months'}</button>` : ''}
        <p class="hint" id="b-sum"></p>
        <div class="section-title" style="padding:4px 0 0">Category limits (optional)</div>
        <div class="list" style="gap:10px">${cats.map((c) => {
          const avg = avgFor(c.id);
          return `<div class="person-row">${catIco(c, 'sm')}<label class="field"><span>${esc(c.name)}${avg > 0 ? ` · avg ${esc(money(avg, { whole: true }))}` : ''}</span><span class="affix"><b>${esc(cur.symbol)}</b><input inputmode="decimal" autocomplete="off" data-bcat="${esc(c.id)}" value="${b.cats[c.id] || ''}" placeholder="No limit"></span></label></div>`;
        }).join('')}</div>`,
      foot: `<button class="btn btn-filled btn-block" type="button" id="b-save">Save budgets</button>`,
      onMount(el) {
        const upd = () => {
          const total = num($('#b-total', el).value);
          const catsSum = sum($$('[data-bcat]', el), (i) => num(i.value));
          $('#b-sum', el).innerHTML = catsSum ? `Category limits add up to <b>${esc(money(catsSum, { whole: true }))}</b>${total && catsSum > total ? ', which is more than your monthly budget.' : '.'}` : 'Kharcha warns you at 80% of a limit and again when you go over.';
        };
        upd();
        el.addEventListener('input', upd);
        el.addEventListener('click', (e) => {
          if (e.target.closest('#b-suggest')) {
            $('#b-total', el).value = roundUp(avgTotal, 1000);
            $$('[data-bcat]', el).forEach((i) => { const a = avgFor(i.dataset.bcat); i.value = a > 0 ? roundUp(a) : ''; });
            upd();
            toast('Filled in from your average spending. Adjust anything before saving.');
          }
          if (e.target.closest('#b-save')) {
            const next = { total: round2(Math.max(0, num($('#b-total', el).value))), cats: {} };
            $$('[data-bcat]', el).forEach((i) => { const v = num(i.value); if (v > 0) next.cats[i.dataset.bcat] = round2(v); });
            const fresh = commit(() => { state.budgets = next; });
            sheet.close();
            toast('Budgets saved.' + freshNote(fresh));
          }
        });
      },
    });
  }

  // ============================================================
  // Goals
  // ============================================================
  function openGoalSheet(goal) {
    const g = goal ? { ...goal } : { id: uid(), name: '', icon: 'savings', target: '', saved: '', deadline: '', h: 145 };
    const sheet = openSheet({
      title: goal ? 'Edit goal' : 'New savings goal',
      action: goal ? `<button class="icon-btn" type="button" id="g-del" aria-label="Delete goal">${ic('delete')}</button>` : '',
      html: `<div class="form">
        <label class="field"><span>Goal name</span><input id="g-name" maxlength="40" autocomplete="off" placeholder="e.g. Emergency fund" value="${esc(g.name)}"></label>
        <div><div class="section-title" style="padding:0 0 8px">Icon</div><div class="icon-picker" id="g-icons">${GOAL_ICONS.map((x) => `<button type="button" data-icon="${x}" aria-pressed="${x === g.icon}" aria-label="${x.replace(/_/g, ' ')}">${ic(x)}</button>`).join('')}</div></div>
        <div class="row2">
          <label class="field"><span>Target amount</span><span class="affix"><b>${esc(cur.symbol)}</b><input id="g-target" inputmode="decimal" autocomplete="off" value="${g.target}"></span></label>
          <label class="field"><span>Saved so far</span><span class="affix"><b>${esc(cur.symbol)}</b><input id="g-saved" inputmode="decimal" autocomplete="off" value="${g.saved}"></span></label>
        </div>
        <label class="field"><span>Target date (optional)</span><input type="date" id="g-date" value="${g.deadline}" min="${todayStr()}"></label>
        <p class="hint" id="g-hint"></p></div>`,
      foot: `<button class="btn btn-filled btn-block" type="button" id="g-save">${goal ? 'Save changes' : 'Create goal'}</button>`,
      onMount(el) {
        const hint = () => {
          const t = num($('#g-target', el).value), s = num($('#g-saved', el).value), dl = $('#g-date', el).value;
          const p = goalPlan({ target: t, saved: s, deadline: dl });
          $('#g-hint', el).textContent = t > 0 && dl && p.perMonth ? `Save about ${money(Math.ceil(p.perMonth), { whole: true })} a month for ${plural(p.months, 'month')} to get there.` : '';
        };
        hint();
        el.addEventListener('input', hint);
        el.addEventListener('click', async (e) => {
          const ib = e.target.closest('[data-icon]');
          if (ib) { g.icon = ib.dataset.icon; $$('[data-icon]', el).forEach((x) => x.setAttribute('aria-pressed', String(x === ib))); }
          if (e.target.closest('#g-save')) {
            const name = $('#g-name', el).value.trim();
            const target = num($('#g-target', el).value);
            if (!name) { $('#g-name', el).closest('.field').classList.add('invalid'); $('#g-name', el).focus(); return; }
            if (!(target > 0)) { $('#g-target', el).closest('.field').classList.add('invalid'); $('#g-target', el).focus(); return; }
            const rec = { ...g, name: name.slice(0, 40), target: round2(target), saved: round2(Math.max(0, num($('#g-saved', el).value))), deadline: $('#g-date', el).value || '' };
            if (!goal) rec.h = HUES[state.goals.length % HUES.length];
            const fresh = commit(() => upsert(state.goals, rec));
            sheet.close();
            toast((goal ? 'Goal updated.' : 'Goal created.') + freshNote(fresh));
          }
          if (e.target.closest('#g-del')) {
            if (!(await confirmDialog('Delete this goal?', `“${g.name}” and its progress will be removed.`, 'Delete', true))) return;
            const snapshot = { ...goal };
            commit(() => { state.goals = state.goals.filter((x) => x.id !== goal.id); }, { keepSample: true });
            sheet.close();
            toast('Goal deleted.', { label: 'Undo', run: () => commit(() => upsert(state.goals, snapshot), { keepSample: true }) });
          }
        });
      },
    });
  }
  // ============================================================
  // Bills
  // ============================================================
  function openBillSheet({ bill, preset } = {}) {
    const b = bill ? { ...bill } : { id: uid(), name: '', amount: '', cat: 'bills', freq: 'monthly', nextDue: todayStr(), mode: 'upi', ...(preset || {}) };
    const cats = allCats('expense');
    const sheet = openSheet({
      title: bill ? 'Edit bill' : 'New bill or subscription',
      action: bill ? `<button class="icon-btn" type="button" id="bl-del" aria-label="Delete bill">${ic('delete')}</button>` : '',
      html: `<div class="form">
        <label class="field"><span>Name</span><input id="bl-name" maxlength="40" autocomplete="off" placeholder="e.g. Electricity, Netflix, Rent" value="${esc(b.name)}"></label>
        <label class="field"><span>Amount</span><span class="affix"><b>${esc(cur.symbol)}</b><input id="bl-amt" inputmode="decimal" autocomplete="off" value="${b.amount}"></span></label>
        <div class="row2">
          <label class="field"><span>Repeats</span><select id="bl-freq">${Object.entries(FREQS).map(([k, l]) => `<option value="${k}" ${k === b.freq ? 'selected' : ''}>${l}</option>`).join('')}</select>${ic('arrow_drop_down', 'select-ico')}</label>
          <label class="field"><span>Next due</span><input type="date" id="bl-due" value="${b.nextDue}"></label>
        </div>
        <div class="row2">
          <label class="field"><span>Category</span><select id="bl-cat">${cats.map((c) => `<option value="${esc(c.id)}" ${c.id === b.cat ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>${ic('arrow_drop_down', 'select-ico')}</label>
          <label class="field"><span>Paid with</span><select id="bl-mode">${MODES.map((m) => `<option value="${m.id}" ${m.id === b.mode ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>${ic('arrow_drop_down', 'select-ico')}</label>
        </div>
        <p class="hint">“Mark paid” logs the bill as an expense and moves the due date to the next cycle.</p></div>`,
      foot: `<button class="btn btn-filled btn-block" type="button" id="bl-save">${bill ? 'Save changes' : 'Add bill'}</button>`,
      onMount(el) {
        el.addEventListener('click', async (e) => {
          if (e.target.closest('#bl-save')) {
            const name = $('#bl-name', el).value.trim(), amount = num($('#bl-amt', el).value), due = $('#bl-due', el).value;
            if (!name) { $('#bl-name', el).closest('.field').classList.add('invalid'); $('#bl-name', el).focus(); return; }
            if (!(amount > 0)) { $('#bl-amt', el).closest('.field').classList.add('invalid'); $('#bl-amt', el).focus(); return; }
            if (!isDateStr(due)) { $('#bl-due', el).closest('.field').classList.add('invalid'); return; }
            const rec = { ...b, name: name.slice(0, 40), amount: round2(amount), freq: $('#bl-freq', el).value, nextDue: due, day: parseDate(due).getDate(), cat: $('#bl-cat', el).value, mode: $('#bl-mode', el).value };
            const fresh = commit(() => upsert(state.bills, rec));
            sheet.close();
            toast((bill ? 'Bill updated.' : 'Bill added.') + freshNote(fresh));
          }
          if (e.target.closest('#bl-del')) {
            if (!(await confirmDialog('Delete this bill?', `“${b.name}” will stop showing in upcoming bills. Expenses you already logged stay.`, 'Delete', true))) return;
            const snapshot = { ...bill };
            commit(() => { state.bills = state.bills.filter((x) => x.id !== bill.id); }, { keepSample: true });
            sheet.close();
            toast('Bill deleted.', { label: 'Undo', run: () => commit(() => upsert(state.bills, snapshot), { keepSample: true }) });
          }
        });
      },
    });
  }
  function payBill(id) {
    const bill = state.bills.find((b) => b.id === id);
    if (!bill) return;
    const before = { ...bill };
    const txn = { id: uid(), type: 'expense', amount: bill.amount, cat: bill.cat, mode: bill.mode, date: todayStr(), note: bill.name, ts: Date.now(), billId: bill.id, ...(session.user ? { by: session.user.uid } : {}) };
    const next = { ...bill, nextDue: advanceDue(bill), lastPaid: todayStr() };
    const fresh = commit(() => { upsert(state.bills, next); state.txns.push(txn); });
    toast(`${bill.name} paid · ${money(bill.amount)} logged. Next due ${dateLabel(next.nextDue)}.${freshNote(fresh)}`, fresh ? null : {
      label: 'Undo', run: () => commit(() => { upsert(state.bills, before); state.txns = state.txns.filter((t) => t.id !== txn.id); }),
    });
  }

  // ============================================================
  // Splits
  // ============================================================
  function openSplitSheet({ split, preset } = {}) {
    const s = split ? JSON.parse(JSON.stringify(split)) : { id: uid(), title: '', date: todayStr(), total: '', paidBy: 'me', myShare: 0, iSettled: false, people: [{ name: '', share: 0, settled: false }], ...(preset || {}) };
    const m = { equal: true, addExpense: !split, cat: 'food' };
    if (split) {
      const shares = [s.myShare, ...s.people.map((p) => p.share)];
      m.equal = shares.every((x) => Math.abs(x - shares[0]) < 0.02);
    }
    const sheet = openSheet({
      title: split ? 'Edit split' : 'Split an expense',
      action: split ? `<button class="icon-btn" type="button" id="sp-del" aria-label="Delete split">${ic('delete')}</button>` : '',
      html: `<div class="form" id="sp-form"></div>`,
      foot: `<button class="btn btn-filled btn-block" type="button" id="sp-save">${split ? 'Save changes' : 'Save split'}</button>`,
      onMount(el) {
        const form = $('#sp-form', el);
        const readForm = () => {
          s.title = ($('#sp-title', el) || {}).value ?? s.title;
          s.total = ($('#sp-total', el) || {}).value ?? s.total;
          s.date = ($('#sp-date', el) || {}).value ?? s.date;
          s.paidBy = ($('#sp-paid', el) || {}).value ?? s.paidBy;
          $$('[data-pname]', el).forEach((i) => { s.people[Number(i.dataset.pname)].name = i.value; });
          if (!m.equal) {
            $$('[data-pshare]', el).forEach((i) => { s.people[Number(i.dataset.pshare)].share = num(i.value); });
            const me = $('#sp-myshare', el); if (me) s.myShare = num(me.value);
          }
          const ae = $('#sp-addexp', el); if (ae) m.addExpense = ae.checked;
          const ct = $('#sp-cat', el); if (ct) m.cat = ct.value;
        };
        const draw = () => {
          const named = s.people.map((p) => p.name.trim()).filter(Boolean);
          if (s.paidBy !== 'me' && !named.includes(s.paidBy)) s.paidBy = 'me';
          const total = num(s.total), n = s.people.length + 1;
          const each = total / n;
          form.innerHTML = `
            <label class="field"><span>What was it for?</span><input id="sp-title" maxlength="50" autocomplete="off" placeholder="e.g. Dinner at Toit" value="${esc(s.title)}"></label>
            <div class="row2">
              <label class="field"><span>Total amount</span><span class="affix"><b>${esc(cur.symbol)}</b><input id="sp-total" inputmode="decimal" autocomplete="off" value="${esc(s.total)}"></span></label>
              <label class="field"><span>Date</span><input type="date" id="sp-date" value="${s.date}"></label>
            </div>
            <div class="section-title" style="padding:4px 0 0">People (besides you)</div>
            <div class="people">${s.people.map((p, i) => `<div class="person-row"><span class="avatar" style="--h:${hueOf(p.name || i)}">${p.name ? initial(p.name) : ic('person', 'xs')}</span>
              <label class="field"><span>Name</span><input data-pname="${i}" maxlength="30" autocomplete="off" value="${esc(p.name)}" placeholder="Friend’s name"></label>
              ${m.equal ? '' : `<label class="field" style="max-width:120px"><span>Share</span><input data-pshare="${i}" inputmode="decimal" autocomplete="off" value="${p.share || ''}"></label>`}
              <button class="icon-btn sm" type="button" data-premove="${i}" aria-label="Remove person" ${s.people.length === 1 ? 'disabled style="opacity:.3"' : ''}>${ic('close')}</button></div>`).join('')}
            </div>
            <button class="btn btn-outline" type="button" id="sp-addp">${ic('person_add')}Add person</button>
            <label class="field"><span>Paid by</span><select id="sp-paid"><option value="me">You</option>${named.map((nm) => `<option value="${esc(nm)}" ${nm === s.paidBy ? 'selected' : ''}>${esc(nm)}</option>`).join('')}</select>${ic('arrow_drop_down', 'select-ico')}</label>
            <label class="switch-row"><span class="txt">Split equally<small id="sp-each">${m.equal && total > 0 ? `${esc(money(each))} each for ${n} people` : 'Turn off to enter each share'}</small></span><span class="switch"><input type="checkbox" id="sp-equal" ${m.equal ? 'checked' : ''}><i></i></span></label>
            ${m.equal ? '' : `<label class="field"><span>Your share</span><span class="affix"><b>${esc(cur.symbol)}</b><input id="sp-myshare" inputmode="decimal" autocomplete="off" value="${s.myShare || ''}"></span></label><p class="hint" id="sp-left"></p>`}
            ${split ? '' : `<label class="switch-row"><span class="txt">Add my share to expenses<small>Logs only your part, not the whole bill</small></span><span class="switch"><input type="checkbox" id="sp-addexp" ${m.addExpense ? 'checked' : ''}><i></i></span></label>
            ${m.addExpense ? `<label class="field"><span>Category for my share</span><select id="sp-cat">${allCats('expense').map((c) => `<option value="${esc(c.id)}" ${c.id === m.cat ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>${ic('arrow_drop_down', 'select-ico')}</label>` : ''}`}`;
          updLeft();
        };
        const updEach = () => {
          const out = $('#sp-each', el);
          const total = num($('#sp-total', el).value), n = s.people.length + 1;
          if (out && m.equal) out.textContent = total > 0 ? `${money(total / n)} each for ${n} people` : 'Turn off to enter each share';
        };
        const updPaidBy = () => {
          const sel = $('#sp-paid', el);
          const named = [...new Set(s.people.map((p) => p.name.trim()).filter(Boolean))];
          const keep = named.includes(sel.value) ? sel.value : 'me';
          sel.innerHTML = `<option value="me">You</option>${named.map((nm) => `<option value="${esc(nm)}">${esc(nm)}</option>`).join('')}`;
          sel.value = keep;
        };
        const updLeft = () => {
          const left = $('#sp-left', el);
          if (!left) return;
          const total = num($('#sp-total', el).value);
          const assigned = num(($('#sp-myshare', el) || {}).value) + sum($$('[data-pshare]', el), (i) => num(i.value));
          const diff = round2(total - assigned);
          left.textContent = Math.abs(diff) < 0.01 ? 'Shares add up to the total.' : diff > 0 ? `${money(diff)} still to assign.` : `Shares are ${money(-diff)} more than the total.`;
        };
        draw();
        el.addEventListener('input', (e) => {
          if (e.target.dataset.pshare !== undefined || e.target.id === 'sp-myshare' || e.target.id === 'sp-total') { updLeft(); updEach(); }
          if (e.target.dataset.pname !== undefined) {
            const i = Number(e.target.dataset.pname);
            const av = e.target.closest('.person-row').querySelector('.avatar');
            s.people[i].name = e.target.value;
            av.style.setProperty('--h', hueOf(e.target.value || i));
            av.innerHTML = e.target.value.trim() ? initial(e.target.value) : ic('person', 'xs');
            updPaidBy();
          }
        });
        el.addEventListener('change', (e) => {
          if (['sp-equal', 'sp-addexp'].includes(e.target.id)) {
            readForm();
            if (e.target.id === 'sp-equal') m.equal = e.target.checked;
            draw();
          }
        });
        el.addEventListener('click', async (e) => {
          const b = e.target.closest('button');
          if (!b) return;
          if (b.id === 'sp-addp') { readForm(); s.people.push({ name: '', share: 0, settled: false }); draw(); const ins = $$('[data-pname]', el); ins[ins.length - 1].focus(); }
          if (b.dataset.premove !== undefined) { readForm(); s.people.splice(Number(b.dataset.premove), 1); draw(); }
          if (b.id === 'sp-save') save();
          if (b.id === 'sp-del') {
            if (!(await confirmDialog('Delete this split?', `“${s.title}” and who-owes-whom for it will be removed. A logged expense for your share stays.`, 'Delete', true))) return;
            const snapshot = JSON.parse(JSON.stringify(split));
            commit(() => { state.splits = state.splits.filter((x) => x.id !== split.id); }, { keepSample: true });
            sheet.close();
            toast('Split deleted.', { label: 'Undo', run: () => commit(() => upsert(state.splits, snapshot), { keepSample: true }) });
          }
        });
        function save() {
          readForm();
          const bad = (sel) => { const f = $(sel, el); if (f) { f.closest('.field').classList.add('invalid'); f.focus(); } };
          const title = s.title.trim(), total = round2(num(s.total));
          if (!title) return bad('#sp-title');
          if (!(total > 0)) return bad('#sp-total');
          const people = s.people.map((p) => ({ ...p, name: p.name.trim().slice(0, 30) })).filter((p) => p.name);
          if (!people.length) return bad('[data-pname="0"]');
          let myShare = s.myShare;
          if (m.equal) {
            const each = round2(total / (people.length + 1));
            people.forEach((p) => { p.share = each; });
            myShare = round2(total - each * people.length);
          } else if (Math.abs(total - myShare - sum(people, (p) => p.share)) > 0.01) {
            toast('Shares need to add up to the total.');
            return;
          }
          const rec = { ...s, title: title.slice(0, 50), total, myShare, people, date: isDateStr(s.date) ? s.date : todayStr() };
          if (rec.paidBy !== 'me' && !people.some((p) => p.name === rec.paidBy)) rec.paidBy = 'me';
          if (split && split.paidBy !== rec.paidBy) { people.forEach((p) => { p.settled = false; }); rec.iSettled = false; }
          if (rec.paidBy !== 'me') people.forEach((p) => { if (p.name === rec.paidBy) p.settled = true; });
          let txn = null;
          if (!split && m.addExpense && myShare > 0) {
            txn = { id: uid(), type: 'expense', amount: myShare, cat: m.cat, mode: rec.paidBy === 'me' ? lastMode : 'upi', date: rec.date, note: `Split: ${rec.title}`, ts: Date.now(), splitId: rec.id, ...(session.user ? { by: session.user.uid } : {}) };
            rec.txnId = txn.id;
          }
          const fresh = commit(() => { upsert(state.splits, rec); if (txn) state.txns.push(txn); });
          sheet.close();
          toast((split ? 'Split updated.' : `Split saved${txn ? ` · your ${money(myShare)} logged` : ''}.`) + freshNote(fresh));
        }
      },
    });
  }
  function toggleSettle(id, i) {
    const s = state.splits.find((x) => x.id === id);
    if (!s) return;
    const rec = JSON.parse(JSON.stringify(s));
    if (i === 'me') rec.iSettled = !rec.iSettled;
    else rec.people[Number(i)].settled = !rec.people[Number(i)].settled;
    commit(() => upsert(state.splits, rec), { keepSample: true });
  }

  // ============================================================
  // Settings, categories, data
  // ============================================================
  function storageLine() {
    if (session.mode === 'firebase' && session.book) return { icon: 'group', text: `Shared book: everyone in “${session.book.name}” sees and edits these entries, budgets and bills.` };
    if (state.sample) return { icon: 'science', text: 'Sample data is showing and isn’t saved. Your first entry starts your own book.' };
    if (store.kind === 'firebase') return { icon: 'cloud_done', text: `Synced to your Google account (${session.user.email}). Sign in on any phone or computer to see the same book.` };
    if (store.kind === 'cloud') return { icon: 'cloud_done', text: 'Saved to your Claude account. Open this page on your phone or computer to see the same book.' };
    if (store.kind === 'device') return { icon: 'smartphone', text: 'Saved in this browser on this device. Use “Back up data” now and then to keep a copy.' };
    return { icon: 'warning', text: 'This browser is blocking storage, so changes last only until you close the page. Back up your data before leaving.' };
  }
  function openSettings() {
    const sl = storageLine();
    const sheet = openSheet({
      title: 'Settings',
      html: `
        <div class="storage-note">${ic(sl.icon)}<span>${esc(sl.text)}</span></div>
        ${session.mode === 'firebase'
          ? `<button class="set-item" type="button" data-act="account">${ic('manage_accounts')}<span class="li-main"><span>Account & books</span><small>${esc(session.user.email)}</small></span>${ic('chevron_right')}</button>`
          : `<div class="set-group"><h3>You</h3>
          <label class="field"><span>Your name (for the greeting)</span><input id="st-name" maxlength="40" autocomplete="off" value="${esc(state.settings.name)}" placeholder="Optional"></label>
          ${FB_CONFIG ? `<button class="set-item" type="button" data-act="sign-in">${G_LOGO}<span class="li-main"><span>Sign in with Google</span><small>Sync across devices and share books with family</small></span>${ic('chevron_right')}</button>` : ''}</div>`}
        <div class="set-group"><h3>Appearance</h3>
          <div class="seg" role="group" aria-label="Theme">${['system', 'light', 'dark'].map((t) => `<button type="button" data-theme-opt="${t}" aria-pressed="${ui.theme === t}">${ic('check')}${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></div>
        <div class="set-group"><h3>Money</h3>
          <label class="field"><span>Currency</span><select id="st-cur">${CURRENCIES.map((c) => `<option value="${c.code}" ${c.code === state.settings.currency ? 'selected' : ''}>${c.code} · ${esc(c.name)}</option>`).join('')}</select>${ic('arrow_drop_down', 'select-ico')}</label>
          <button class="set-item" type="button" data-set="budgets">${ic('savings')}<span class="li-main"><span>Budgets</span><small>${state.budgets.total ? esc(money(state.budgets.total, { whole: true })) + ' a month' : 'Not set'}</small></span>${ic('chevron_right')}</button>
          <button class="set-item" type="button" data-set="cats">${ic('category')}<span class="li-main"><span>Your categories</span><small>${state.customCats.length ? plural(state.customCats.length, 'custom category', 'custom categories') : 'Add your own categories'}</small></span>${ic('chevron_right')}</button></div>
        <div class="set-group"><h3>Your data</h3>
          <button class="set-item" type="button" data-set="csv">${ic('table_view')}<span class="li-main"><span>Export to CSV</span><small>Opens in Excel or Google Sheets</small></span></button>
          <button class="set-item" type="button" data-set="backup">${ic('backup')}<span class="li-main"><span>Back up data</span><small>Save everything as one file</small></span></button>
          <label class="set-item" style="cursor:pointer">${ic('settings_backup_restore')}<span class="li-main"><span>Restore from backup</span><small>Replaces what’s here with the file’s data</small></span><input type="file" id="st-restore" accept="application/json,.json" hidden></label>
          ${session.book ? '' : `<button class="set-item" type="button" data-set="sample">${ic('science')}<span class="li-main"><span>Show sample data</span><small>Explore with example entries. Nothing is saved.</small></span></button>`}
          ${session.mode !== 'firebase' || !session.book || session.book.owner === session.user.uid ? `<button class="set-item danger" type="button" data-set="wipe">${ic('delete_forever')}<span class="li-main"><span>Delete all data${session.book ? ' in this book' : ''}</span><small>Removes every entry, budget, bill, goal and split${session.book ? ' for everyone in it' : ''}</small></span></button>` : ''}</div>
        <p class="hint" style="text-align:center">Kharcha · version 1.0</p>`,
      onMount(el) {
        el.addEventListener('change', async (e) => {
          if (e.target.id === 'st-name') commit(() => { state.settings.name = e.target.value.trim().slice(0, 40); }, { keepSample: true });
          if (e.target.id === 'st-cur') {
            commit(() => { state.settings.currency = e.target.value; setCurrency(e.target.value); }, { keepSample: true });
            toast(session.book ? `Everyone in ${session.book.name} now sees amounts in ${e.target.value}.` : `Amounts now show in ${e.target.value}. Existing numbers aren’t converted.`);
          }
          if (e.target.id === 'st-restore' && e.target.files[0]) { restoreBackup(e.target.files[0], sheet); e.target.value = ''; }
        });
        el.addEventListener('click', async (e) => {
          const t = e.target.closest('[data-theme-opt]');
          if (t) {
            ui.theme = t.dataset.themeOpt;
            $$('[data-theme-opt]', el).forEach((x) => x.setAttribute('aria-pressed', String(x === t)));
            applyTheme();
            prefsSave();
            drawCharts();
            return;
          }
          const b = e.target.closest('[data-set]');
          if (!b) return;
          const act = b.dataset.set;
          if (act === 'budgets') openBudgetSheet();
          if (act === 'cats') openCategories();
          if (act === 'csv') exportCsv('all');
          if (act === 'backup') backup();
          if (act === 'sample') {
            if (state.sample) { sheet.close(); return; }
            if (!(await confirmDialog('Show sample data?', 'Your own data stays saved. Tap “Show my data” in the banner to go back to it.', 'Show samples'))) return;
            sampleStash = takeData();
            const settings = state.settings;
            Object.assign(state, makeSample(), { settings, sample: true });
            sheet.close();
            render();
          }
          if (act === 'wipe') {
            const ok = await confirmDialog('Delete all data?', 'Every entry, budget, bill, goal and split will be removed. Back up first if you might want them later.', 'Delete everything', true);
            if (!ok) return;
            const settings = state.settings;
            sampleStash = null;
            Object.assign(state, emptyData(), { settings, sample: false, started: true });
            persist();
            sheet.close();
            render();
            toast('All data deleted.');
          }
        });
      },
    });
  }
  function openCategories() {
    openSheet({
      title: 'Your categories',
      html: `<div id="cats-body" class="form"></div>`,
      onMount(el) {
        const draft = { name: '', type: 'expense', icon: 'sell', h: 210 };
        const draw = () => {
          $('#cats-body', el).innerHTML = `
            <section class="card flush">${state.customCats.length ? `<div class="list">${state.customCats.map((c) => `<div class="li">${catIco(c)}<span class="li-main"><span class="li-title">${esc(c.name)}</span><span class="li-sub">${c.type === 'income' ? 'Income' : 'Expense'}</span></span><button class="icon-btn sm" type="button" data-cdel="${esc(c.id)}" aria-label="Delete ${esc(c.name)}">${ic('delete')}</button></div>`).join('')}</div>` : emptyState('category', 'No custom categories', 'Built-in ones cover the basics. Add your own for pets, kids, hobbies or anything else.')}</section>
            <section class="card form"><h3 style="font-size:16px">Add a category</h3>
              <div class="seg" role="group" aria-label="Category type"><button type="button" data-ctype="expense" aria-pressed="${draft.type === 'expense'}">${ic('check')}Expense</button><button type="button" data-ctype="income" aria-pressed="${draft.type === 'income'}">${ic('check')}Income</button></div>
              <label class="field"><span>Name</span><input id="c-name" maxlength="30" autocomplete="off" placeholder="e.g. Pet care" value="${esc(draft.name)}"></label>
              <div><div class="section-title" style="padding:0 0 8px">Icon</div><div class="icon-picker">${ICON_CHOICES.map((x) => `<button type="button" data-cicon="${x}" aria-pressed="${x === draft.icon}" aria-label="${x.replace(/_/g, ' ')}">${ic(x)}</button>`).join('')}</div></div>
              <div><div class="section-title" style="padding:0 0 8px">Colour</div><div class="hue-picker">${HUES.map((h) => `<button type="button" data-chue="${h}" style="--h:${h}" aria-pressed="${h === draft.h}" aria-label="Hue ${h}"></button>`).join('')}</div></div>
              <button class="btn btn-filled" type="button" id="c-add">${ic('add')}Add category</button>
            </section>`;
        };
        draw();
        el.addEventListener('input', (e) => { if (e.target.id === 'c-name') draft.name = e.target.value; });
        el.addEventListener('click', async (e) => {
          const b = e.target.closest('button');
          if (!b) return;
          if (b.dataset.ctype) { draft.type = b.dataset.ctype; draw(); }
          if (b.dataset.cicon) { draft.icon = b.dataset.cicon; draw(); }
          if (b.dataset.chue) { draft.h = Number(b.dataset.chue); draw(); }
          if (b.id === 'c-add') {
            const name = draft.name.trim();
            if (!name) { $('#c-name', el).closest('.field').classList.add('invalid'); $('#c-name', el).focus(); return; }
            if (allCats(draft.type).some((c) => c.name.toLowerCase() === name.toLowerCase())) { toast('A category with that name already exists.'); return; }
            const fresh = commit(() => state.customCats.push({ id: 'c_' + uid(), name: name.slice(0, 30), short: name.slice(0, 12), type: draft.type, icon: draft.icon, h: draft.h }));
            draft.name = '';
            draw();
            toast(`Added “${name}”.${freshNote(fresh)}`);
          }
          if (b.dataset.cdel) {
            const c = state.customCats.find((x) => x.id === b.dataset.cdel);
            const used = state.txns.filter((t) => t.cat === c.id).length;
            if (!(await confirmDialog(`Delete “${c.name}”?`, used ? `${plural(used, 'entry', 'entries')} use it and will show as Uncategorised.` : 'No entries use it.', 'Delete', true))) return;
            commit(() => { state.customCats = state.customCats.filter((x) => x.id !== c.id); delete state.budgets.cats[c.id]; }, { keepSample: true });
            draw();
          }
        });
      },
    });
  }

  async function saveFile(filename, text, mime) {
    const dl = await downloadsCap;
    if (dl) {
      try { await dl.save({ filename, data: text }); toast(`Saved ${filename}.`); } catch (e) {
        if (!e || e.code !== 'declined') toast('Downloads aren’t available here. Try opening Kharcha in a browser tab.');
      }
      return;
    }
    try {
      const url = URL.createObjectURL(new Blob([text], { type: mime }));
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast(`Saved ${filename}.`);
    } catch { toast('Couldn’t create the file in this browser.'); }
  }
  function csvCell(v) {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function exportCsv(scope) {
    const list = sortTx(scope === 'all' ? [...state.txns] : txIn(ui.month));
    if (!list.length) { toast('There are no entries to export yet.'); return; }
    const rows = [['Date', 'Type', 'Category', 'Amount', 'Currency', 'Paid with', 'Note']]
      .concat(list.map((t) => [t.date, t.type === 'income' ? 'Income' : 'Expense', getCat(t.cat).name, t.amount.toFixed(2), state.settings.currency, modeOf(t.mode).name, t.note]));
    const csv = '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
    saveFile(`kharcha-${scope === 'all' ? 'all' : ui.month}.csv`, csv, 'text/csv');
  }
  async function exportPrompt() {
    const v = await pickDialog('Export to CSV', [{ label: `${monthLabel(ui.month)} only`, value: 'month' }, { label: 'All transactions', value: 'all' }], null);
    if (v) exportCsv(v);
  }
  function backup() {
    const data = { app: 'kharcha', v: 1, exportedAt: new Date().toISOString(), data: { txns: state.txns, budgets: state.budgets, goals: state.goals, bills: state.bills, splits: state.splits, customCats: state.customCats, settings: state.settings } };
    saveFile(`kharcha-backup-${todayStr()}.json`, JSON.stringify(data, null, 1), 'application/json');
  }
  function restoreBackup(file, sheet) {
    const reader = new FileReader();
    reader.onload = async () => {
      let parsed;
      try { parsed = JSON.parse(String(reader.result)); } catch { toast('That file isn’t a Kharcha backup.'); return; }
      if (!parsed || parsed.app !== 'kharcha' || !parsed.data) { toast('That file isn’t a Kharcha backup.'); return; }
      const clean = sanitizeData(parsed.data);
      const ok = await confirmDialog('Restore this backup?', `It has ${plural(clean.txns.length, 'entry', 'entries')}, ${plural(clean.bills.length, 'bill')} and ${plural(clean.goals.length, 'goal')}. Everything here now will be replaced.`, 'Restore', true);
      if (!ok) return;
      sampleStash = null;
      Object.assign(state, clean, { sample: false, started: true });
      setCurrency(state.settings.currency);
      applyTheme();
      persist();
      sheet.close();
      render();
      toast('Backup restored.');
    };
    reader.onerror = () => toast('Couldn’t read that file.');
    reader.readAsText(file);
  }

  function openCalcHistory() {
    const sheet = openSheet({
      title: 'Calculator history',
      action: calc.history.length ? `<button class="btn btn-text" type="button" id="ch-clear">Clear</button>` : '',
      html: calc.history.length ? `<section class="card flush"><div class="list">${calc.history.map((h, i) => `<button class="li" type="button" data-h="${i}"><span class="li-main"><span class="li-sub">${prettyExpr(h.expr)}</span><span class="li-title">= ${esc(prettyNum(h.result))}</span></span>${ic('north_west', 'sm')}</button>`).join('')}</div></section>` : `<section class="card">${emptyState('history', 'No calculations yet', 'Results you get with “=” are kept here on this device.')}</section>`,
      onMount(el) {
        el.addEventListener('click', (e) => {
          const b = e.target.closest('[data-h]');
          if (b) { calc.expr = plainNum(calc.history[Number(b.dataset.h)].result); calc.done = true; sheet.close(); updateCalc(); }
          if (e.target.closest('#ch-clear')) { calc.history = []; prefsSave(); sheet.close(); }
        });
      },
    });
  }

  // ============================================================
  // Website accounts: Google sign-in, Firestore, private + shared books
  // ============================================================
  const BOOK_COLS = ['meta', ...ITEM_COLS];
  const G_LOGO = '<svg class="g-logo" viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

  async function initFirebase() {
    const [appMod, A, F] = await Promise.all([
      import(`${FB_SDK}/firebase-app.js`),
      import(`${FB_SDK}/firebase-auth.js`),
      import(`${FB_SDK}/firebase-firestore.js`),
    ]);
    const app = appMod.initializeApp(FB_CONFIG);
    const auth = A.getAuth(app);
    let db;
    try {
      db = F.initializeFirestore(app, { ignoreUndefinedProperties: true, localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
    } catch {
      db = F.getFirestore(app);
    }
    if (FB_CONFIG.emulator) {
      A.connectAuthEmulator(auth, FB_CONFIG.emulator.auth, { disableWarnings: true });
      F.connectFirestoreEmulator(db, FB_CONFIG.emulator.host, FB_CONFIG.emulator.port);
    }
    return { A, F, auth, db };
  }

  function firebaseStore(base) {
    const { F, db } = fb;
    let unsubs = [];
    return {
      kind: 'firebase', granular: true, fireAndForget: true, live: true, base,
      set: (key, data) => F.setDoc(F.doc(db, `${base}/${key}`), data),
      del: (key) => F.deleteDoc(F.doc(db, `${base}/${key}`)),
      async loadAll() {
        const out = {};
        const snaps = await Promise.all(BOOK_COLS.map((col) => F.getDocs(F.collection(db, `${base}/${col}`))));
        snaps.forEach((snap, i) => snap.forEach((d) => { out[`${BOOK_COLS[i]}/${d.id}`] = d.data(); }));
        return out;
      },
      // The first answer from the server for every collection is the load; after that,
      // changes made on other devices or by other people stream in.
      open(onChanges, onError) {
        return new Promise((resolve, reject) => {
          const latest = {};
          const fromServer = new Set();
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const docs = {};
            BOOK_COLS.forEach((col) => { if (latest[col]) latest[col].forEach((d) => { docs[`${col}/${d.id}`] = d.data(); }); });
            resolve(docs);
          };
          const timer = setTimeout(finish, 6000); // offline: go with what this device has cached
          unsubs = BOOK_COLS.map((col) => F.onSnapshot(F.collection(db, `${base}/${col}`), { includeMetadataChanges: true }, (snap) => {
            if (!settled) {
              latest[col] = snap;
              if (!snap.metadata.fromCache) fromServer.add(col);
              if (fromServer.size === BOOK_COLS.length) finish();
              return;
            }
            const changes = snap.docChanges().map((ch) => ({ key: `${col}/${ch.doc.id}`, data: ch.type === 'removed' ? null : ch.doc.data() }));
            if (changes.length) onChanges(changes);
          }, (err) => {
            if (!settled) { settled = true; clearTimeout(timer); reject(err); } else onError(err);
          }));
        });
      },
      close() { unsubs.forEach((u) => u()); unsubs = []; },
    };
  }

  const myInfo = () => ({ name: session.user.name, email: session.user.email, photo: session.user.photo });
  const waitUntil = async (test, ms) => { const end = Date.now() + ms; while (!test() && Date.now() < end) await wait(100); return test(); };
  const siteUrl = () => location.origin + location.pathname.replace(/index\.html$/, '');
  function stopSessionListeners() { session.unsubs.forEach((u) => u()); session.unsubs = []; }
  function closeAllSheets() { [...sheets].reverse().forEach((sh) => closeSheet(sh)); }
  function refreshAccountSheets() { sheets.forEach((sh) => { if (sh.redraw) sh.redraw(); }); }
  function memberName(id, full = false) {
    if (!id) return '';
    if (session.user && id === session.user.uid) return 'You';
    const info = session.book && session.book.memberInfo && session.book.memberInfo[id];
    const n = (info && (info.name || info.email)) || 'Former member';
    return full ? n : n.split(/[\s@]/)[0];
  }
  function avatarHtml(u, size = '') {
    const photo = u && typeof u.photo === 'string' && /^https:\/\//.test(u.photo) ? u.photo : '';
    if (photo) return `<img class="avatar avatar-img ${size}" src="${esc(photo)}" alt="" referrerpolicy="no-referrer">`;
    return `<span class="avatar ${size}" style="--h:${hueOf((u && (u.email || u.name)) || '?')}">${initial((u && u.name) || '?')}</span>`;
  }

  // ---------- The sign-in gate ----------
  function showGate(kind, opts = {}) {
    const g = $('#gate');
    if (!g) return;
    hideTip();
    closeAllSheets();
    $('#app').hidden = true;
    g.hidden = false;
    const logo = '<span class="gate-logo" aria-hidden="true">₹</span>';
    if (kind === 'loading') {
      g.innerHTML = `<div class="gate-card gate-wait" aria-busy="true">${logo}<p>${esc(opts.text || 'Loading…')}</p></div>`;
    } else if (kind === 'error') {
      g.innerHTML = `<div class="gate-card">${logo}<h1>Kharcha</h1><p class="gate-err" role="alert">${esc(opts.text)}</p>
        <div class="gate-actions">${opts.reload ? '<button class="btn btn-filled" type="button" data-gate="reload">Reload</button>' : '<button class="btn btn-filled" type="button" data-gate="retry">Try again</button><button class="btn btn-text" type="button" data-gate="signout">Sign out</button>'}</div></div>`;
    } else {
      g.innerHTML = `<div class="gate-card signin">
        ${logo}
        <h1>Kharcha</h1>
        <p class="lede">Your expenses, budgets and bills in one place, on your phone and your computer.</p>
        <button class="g-btn" type="button" data-gate="google">${G_LOGO}<span>Continue with Google</span></button>
        ${opts.error ? `<p class="gate-err" role="alert">${esc(opts.error)}</p>` : ''}
        <ul class="gate-points">
          <li>${ic('lock')}<span>A private book that only you can see, synced to your Google account</span></li>
          <li>${ic('group')}<span>Shared books for family or flatmates, with who-added-what</span></li>
          <li>${ic('calculate')}<span>Budgets, bills, savings goals, splits and a calculator</span></li>
        </ul>
        <button class="btn btn-text" type="button" data-gate="local">Use on this device without signing in</button>
      </div>`;
    }
  }
  function hideGate() {
    const g = $('#gate');
    if (g) g.hidden = true;
    $('#app').hidden = false;
  }
  function authErrorText(e) {
    const code = e && e.code;
    if (code === 'auth/unauthorized-domain') return `This web address (${location.hostname}) isn’t approved for sign-in yet. In Firebase, open Authentication → Settings → Authorized domains and add it.`;
    if (code === 'auth/operation-not-allowed') return 'Google sign-in isn’t switched on yet. In Firebase, open Authentication → Sign-in method and enable Google.';
    if (code === 'auth/network-request-failed') return 'No internet connection. Check your connection and try again.';
    if (code === 'auth/user-disabled') return 'This account has been disabled.';
    return 'Sign-in didn’t work. Please try again.';
  }
  async function signInWithGoogle() {
    const { A, auth } = fb;
    const provider = new A.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const btn = $('[data-gate="google"]');
    if (btn) btn.disabled = true;
    try {
      await A.signInWithPopup(auth, provider);
    } catch (e) {
      if (btn) btn.disabled = false;
      const code = e && e.code;
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
      if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
        try { await A.signInWithRedirect(auth, provider); return; } catch (e2) { showGate('signin', { error: authErrorText(e2) }); return; }
      }
      showGate('signin', { error: authErrorText(e) });
    }
  }
  async function signOutEverywhere() {
    if (saveTimer) flush();
    if (pendingWrites && !navigator.onLine) {
      const ok = await confirmDialog('Sign out while offline?', 'Some changes haven’t reached your account yet. Signing out now removes them from this browser.', 'Sign out anyway', true);
      if (!ok) return;
    }
    showGate('loading', { text: 'Signing out…' });
    try { await Promise.race([fb.F.waitForPendingWrites(fb.db), wait(4000)]); } catch { /* offline */ }
    stopSessionListeners();
    if (store.close) store.close();
    try { await fb.A.signOut(fb.auth); } catch { /* already signed out */ }
    try { await fb.F.terminate(fb.db); await fb.F.clearIndexedDbPersistence(fb.db); } catch { /* nothing cached */ }
    location.reload();
  }

  // ---------- Session and books ----------
  let booksReady = Promise.resolve();
  async function startSession(u) {
    session.user = { uid: u.uid, name: u.displayName || (u.email || 'You').split('@')[0], email: (u.email || '').toLowerCase(), photo: u.photoURL || '' };
    const { F, db } = fb;
    stopSessionListeners();
    let markReady;
    booksReady = new Promise((r) => { markReady = r; });
    session.unsubs.push(F.onSnapshot(F.query(F.collection(db, 'books'), F.where('members', 'array-contains', u.uid)), (snap) => {
      session.books = snap.docs.map((d) => ({ id: d.id, members: [], invites: [], memberInfo: {}, ...d.data() }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      markReady();
      if (session.bookId !== 'personal' && state.loaded) {
        const b = session.books.find((x) => x.id === session.bookId);
        if (!b) { toast('You’re no longer in that shared book.'); openBook('personal'); return; }
        session.book = b;
      }
      if (state.loaded) scheduleRender();
      refreshAccountSheets();
    }, () => markReady()));
    if (session.user.email) {
      session.unsubs.push(F.onSnapshot(F.query(F.collection(db, 'books'), F.where('invites', 'array-contains', session.user.email)), (snap) => {
        session.invites = snap.docs.map((d) => ({ id: d.id, memberInfo: {}, ...d.data() }));
        if (state.loaded) scheduleRender();
        refreshAccountSheets();
      }, () => { session.invites = []; }));
    }
    const last = (prefs.lastBook && prefs.lastBook[u.uid]) || 'personal';
    if (last !== 'personal') await Promise.race([booksReady, wait(5000)]);
    await openBook(last);
    offerDeviceImport();
  }
  function onBookError(err) {
    if (err && err.code === 'permission-denied' && session.bookId !== 'personal') {
      toast('You no longer have access to that book.');
      openBook('personal');
    }
  }
  async function openBook(id) {
    const seq = ++session.openSeq;
    if (saveTimer) flush();
    if (store.close) store.close();
    let book = null;
    if (id !== 'personal') {
      book = session.books.find((b) => b.id === id) || null;
      if (!book) id = 'personal';
    }
    session.bookId = id;
    session.book = book;
    state.loaded = false;
    sampleStash = null;
    showGate('loading', { text: book ? `Opening ${book.name}…` : 'Opening your book…' });
    const next = firebaseStore(id === 'personal' ? `users/${session.user.uid}` : `books/${id}`);
    store = next;
    lastSaved = {};
    let docs;
    try {
      docs = await next.open(applyRemote, onBookError);
    } catch {
      next.close();
      if (seq !== session.openSeq) return;
      if (id !== 'personal') { toast('That book couldn’t be opened. You may have been removed from it.'); openBook('personal'); return; }
      showGate('error', { text: 'Couldn’t open your book. Check your connection and try again.' });
      return;
    }
    if (seq !== session.openSeq) return;
    lastSaved = snapshotOf(docs);
    state.settings = { ...DEFAULT_SETTINGS };
    if (hasBook(docs)) applyDocs(docs);
    else if (id === 'personal') loadSample();
    else Object.assign(state, emptyData(), { sample: false, started: true });
    setCurrency(state.settings.currency);
    loadFailed = false;
    state.loaded = true;
    prefs.lastBook = { ...(prefs.lastBook || {}), [session.user.uid]: id };
    prefsSave();
    hideGate();
    lastTab = null;
    render();
  }
  async function offerDeviceImport() {
    if (session.bookId !== 'personal' || !state.sample || !localWorks()) return;
    const done = prefs.imported || {};
    if (done[session.user.uid]) return;
    let local = {};
    try { local = await localStore.loadAll(); } catch { return; }
    if (!hasBook(local)) return;
    const n = Object.keys(local).filter((k) => k.startsWith('tx-')).reduce((a, k) => a + ((local[k] && local[k].items) || []).length, 0);
    prefs.imported = { ...done, [session.user.uid]: true };
    prefsSave();
    const ok = await confirmDialog('Bring your data into your account?', `This browser has ${plural(n, 'entry', 'entries')} saved from before you signed in. Copy them into My book so they sync to your account?`, 'Copy to my account');
    if (!ok || session.bookId !== 'personal') return;
    applyDocs(local);
    sampleStash = null;
    setCurrency(state.settings.currency);
    persist();
    render();
    toast('Copied into My book.');
  }

  const bookRef = (id) => fb.F.doc(fb.db, 'books', id);
  async function bookOp(run, okMsg) {
    try {
      await Promise.race([run(), wait(12000).then(() => { throw { code: 'timeout' }; })]);
      if (okMsg) toast(okMsg);
      return true;
    } catch (e) {
      const code = e && e.code;
      toast(code === 'timeout' || code === 'unavailable' ? 'You seem to be offline. Try again when you’re connected.'
        : code === 'permission-denied' ? 'You don’t have permission to do that.' : 'That didn’t work. Please try again.');
      return false;
    }
  }
  async function createSharedBook(name) {
    const { F, db } = fb;
    const ref = F.doc(F.collection(db, 'books'));
    const me = session.user.uid;
    const ok = await bookOp(() => F.setDoc(ref, { name, owner: me, members: [me], invites: [], memberInfo: { [me]: myInfo() }, created: F.serverTimestamp() }));
    if (!ok) return;
    await waitUntil(() => session.books.some((b) => b.id === ref.id), 4000);
    await openBook(ref.id);
    if (session.bookId === ref.id) openManageBook();
  }
  async function joinBook(id) {
    const { F } = fb;
    const me = session.user.uid;
    const ok = await bookOp(() => F.updateDoc(bookRef(id), { members: F.arrayUnion(me), invites: F.arrayRemove(session.user.email), [`memberInfo.${me}`]: myInfo() }));
    if (!ok) return;
    await waitUntil(() => session.books.some((b) => b.id === id), 4000);
    await openBook(id);
    if (session.book) toast(`You joined ${session.book.name}.`);
  }
  const declineBook = (id) => bookOp(() => fb.F.updateDoc(bookRef(id), { invites: fb.F.arrayRemove(session.user.email) }), 'Invitation declined.');
  async function deleteSharedBook(id) {
    const { F, db } = fb;
    const ok = await bookOp(async () => {
      for (const col of BOOK_COLS) {
        const snap = await F.getDocs(F.collection(db, `books/${id}/${col}`));
        for (let i = 0; i < snap.docs.length; i += 400) {
          const batch = F.writeBatch(db);
          snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
          await batch.commit();
        }
      }
      await F.deleteDoc(bookRef(id));
    }, 'Book deleted.');
    if (ok) openBook('personal');
  }
  async function newBookPrompt() {
    let name = '';
    const v = await openDialog({
      title: 'New shared book',
      html: `<p>Everyone you invite sees and edits the same entries, budgets, bills and goals. Your private book stays private.</p>
        <label class="field"><span>Book name</span><input id="nb-name" maxlength="60" autocomplete="off" value="Home expenses"></label>`,
      actions: [{ label: 'Cancel', value: null }, { label: 'Create', value: 'ok', kind: 'filled' }],
      onAction(val, root) {
        if (val !== 'ok') return true;
        name = $('#nb-name', root).value.trim();
        if (!name) { $('#nb-name', root).closest('.field').classList.add('invalid'); return false; }
        return true;
      },
    });
    if (v === 'ok') createSharedBook(name.slice(0, 60));
  }
  function invitesHtml() {
    return session.invites.map((b) => {
      const from = (b.memberInfo && b.memberInfo[b.owner] && b.memberInfo[b.owner].name) || 'Someone';
      return `<div class="alert info invite">${ic('mail')}<p><b>${esc(from)}</b> invited you to the shared book <b>${esc(b.name)}</b></p>
        <span class="invite-actions"><button class="btn btn-text" type="button" data-act="decline-book" data-id="${esc(b.id)}">Decline</button><button class="btn btn-filled" type="button" data-act="join-book" data-id="${esc(b.id)}">Join</button></span></div>`;
    }).join('');
  }
  function accountHtml() {
    const u = session.user;
    const row = (id, icon, h, name, sub) => `<button class="li" type="button" data-book="${esc(id)}"><span class="cat-ico" style="--h:${h}">${ic(icon)}</span><span class="li-main"><span class="li-title">${esc(name)}</span><span class="li-sub">${esc(sub)}</span></span>${id === session.bookId ? `<span class="pill ok">${ic('check')}Open</span>` : ''}</button>`;
    return `
      <section class="card account-head">${avatarHtml(u, 'lg')}<span class="li-main"><span class="li-title">${esc(u.name)}</span><span class="li-sub">${esc(u.email)}</span></span></section>
      ${invitesHtml()}
      <div class="set-group"><h3>Your books</h3>
        <section class="card flush"><div class="list">
          ${row('personal', 'person', 145, 'My book', 'Private · only you')}
          ${session.books.map((b) => row(b.id, 'group', hueOf(b.id), b.name, `Shared · ${plural(b.members.length, 'person', 'people')}${b.owner === u.uid ? ' · you own it' : ''}`)).join('')}
        </div></section>
        <button class="btn btn-tonal" type="button" data-acc="new-book">${ic('group_add')}New shared book</button>
        ${session.book ? `<button class="btn btn-outline" type="button" data-acc="manage">${ic('manage_accounts')}Manage “${esc(session.book.name)}”</button>` : ''}
      </div>
      <div class="set-group"><h3>App</h3>
        <button class="set-item" type="button" data-acc="settings">${ic('settings')}<span class="li-main"><span>Settings</span><small>Theme, currency, budgets, export and backup</small></span>${ic('chevron_right')}</button>
        <button class="set-item danger" type="button" data-acc="signout">${ic('logout')}<span class="li-main"><span>Sign out</span><small>Your data stays in your account and leaves this browser</small></span></button>
      </div>`;
  }
  function openAccount() {
    if (session.mode !== 'firebase' || !session.user) { openSettings(); return; }
    openSheet({
      title: 'Account & books',
      html: '<div id="acc-body" class="form"></div>',
      onMount(el, sh) {
        const draw = () => { $('#acc-body', el).innerHTML = accountHtml(); };
        draw();
        sh.redraw = draw;
        el.addEventListener('click', (e) => {
          const b = e.target.closest('button');
          if (!b) return;
          if (b.dataset.book) { if (b.dataset.book === session.bookId) sh.close(); else openBook(b.dataset.book); }
          else if (b.dataset.acc === 'new-book') newBookPrompt();
          else if (b.dataset.acc === 'manage') openManageBook();
          else if (b.dataset.acc === 'settings') openSettings();
          else if (b.dataset.acc === 'signout') signOutEverywhere();
        });
      },
    });
  }
  function openManageBook() {
    const id = session.bookId;
    if (id === 'personal') return;
    const { F } = fb;
    openSheet({
      title: 'Manage shared book',
      html: '<div id="mb-body" class="form"></div>',
      onMount(el, sh) {
        const draw = () => {
          const b = session.books.find((x) => x.id === id);
          if (!b) { sh.close(); return; }
          const me = session.user.uid;
          const owner = b.owner === me;
          const info = b.memberInfo || {};
          const keepName = $('#mb-name', el) && document.activeElement === $('#mb-name', el) ? $('#mb-name', el).value : b.name;
          const keepEmail = ($('#mb-email', el) || {}).value || '';
          $('#mb-body', el).innerHTML = `
            <label class="field"><span>Book name</span><input id="mb-name" maxlength="60" autocomplete="off" value="${esc(keepName)}" ${owner ? '' : 'readonly'}></label>
            ${owner ? `<button class="btn btn-tonal" type="button" data-mb="rename">${ic('edit')}Save name</button>` : ''}
            <div class="set-group"><h3>People in this book</h3>
              <section class="card flush"><div class="list">${b.members.map((m) => {
                const p = info[m] || {};
                return `<div class="li">${avatarHtml({ name: p.name || '?', email: p.email || m, photo: p.photo })}<span class="li-main"><span class="li-title">${esc(m === me ? `${p.name || 'You'} (you)` : p.name || 'Member')}</span><span class="li-sub">${esc(p.email || '')}</span></span>
                  ${m === b.owner ? '<span class="pill info">Owner</span>' : owner ? `<button class="icon-btn sm" type="button" data-mb="remove" data-uid="${esc(m)}" aria-label="Remove ${esc(p.name || 'member')}">${ic('person_remove')}</button>` : ''}</div>`;
              }).join('')}</div></section></div>
            <div class="set-group"><h3>Invite someone</h3>
              <div class="person-row"><label class="field"><span>Their Google account email</span><input id="mb-email" type="email" inputmode="email" autocomplete="off" placeholder="name@gmail.com" value="${esc(keepEmail)}"></label><button class="btn btn-filled" type="button" data-mb="invite">Invite</button></div>
              <p class="hint">Send them this website’s link. When they sign in with that email, they’ll see your invitation and can join.</p>
              <div class="storage-note">${ic('link')}<span class="li-main" style="overflow-wrap:anywhere">${esc(siteUrl())}</span><button class="btn btn-text" type="button" data-mb="copy">Copy link</button></div>
              ${b.invites.length ? `<section class="card flush"><div class="list">${b.invites.map((em) => `<div class="li">${ic('schedule_send')}<span class="li-main"><span class="li-title">${esc(em)}</span><span class="li-sub">Invited · hasn’t joined yet</span></span><button class="btn btn-text" type="button" data-mb="uninvite" data-email="${esc(em)}">Cancel</button></div>`).join('')}</div></section>` : ''}
            </div>
            ${owner
              ? `<button class="set-item danger" type="button" data-mb="delete">${ic('delete_forever')}<span class="li-main"><span>Delete this book</span><small>Removes it and all its entries for everyone</small></span></button>`
              : `<button class="set-item danger" type="button" data-mb="leave">${ic('logout')}<span class="li-main"><span>Leave this book</span><small>You’ll stop seeing its entries. The others keep them.</small></span></button>`}`;
        };
        draw();
        sh.redraw = draw;
        el.addEventListener('click', async (e) => {
          const btn = e.target.closest('[data-mb]');
          if (!btn) return;
          const b = session.books.find((x) => x.id === id);
          if (!b) return;
          const act = btn.dataset.mb;
          if (act === 'rename') {
            const name = $('#mb-name', el).value.trim().slice(0, 60);
            if (name) bookOp(() => F.updateDoc(bookRef(id), { name }), 'Name saved.');
          } else if (act === 'invite') {
            const input = $('#mb-email', el);
            const email = input.value.trim().toLowerCase();
            const known = Object.values(b.memberInfo || {}).map((p) => (p.email || '').toLowerCase());
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { input.closest('.field').classList.add('invalid'); input.focus(); return; }
            if (known.includes(email)) { toast('That person is already in this book.'); return; }
            if (b.invites.includes(email)) { toast('They’re already invited.'); return; }
            if (b.invites.length >= 20) { toast('A book can have at most 20 pending invitations.'); return; }
            input.value = '';
            bookOp(() => F.updateDoc(bookRef(id), { invites: F.arrayUnion(email) }), `Invited ${email}. Send them the link so they can sign in and join.`);
          } else if (act === 'uninvite') {
            bookOp(() => F.updateDoc(bookRef(id), { invites: F.arrayRemove(btn.dataset.email) }), 'Invitation cancelled.');
          } else if (act === 'copy') {
            try { await navigator.clipboard.writeText(siteUrl()); toast('Link copied.'); } catch { toast(siteUrl()); }
          } else if (act === 'remove') {
            const m = btn.dataset.uid;
            const p = (b.memberInfo || {})[m] || {};
            if (!(await confirmDialog(`Remove ${p.name || 'this person'}?`, 'They’ll lose access to this book. Entries they added stay.', 'Remove', true))) return;
            bookOp(() => F.updateDoc(bookRef(id), { members: F.arrayRemove(m) }), 'Removed from the book.');
          } else if (act === 'leave') {
            if (!(await confirmDialog(`Leave ${b.name}?`, 'You’ll stop seeing its entries. The owner can invite you again later.', 'Leave', true))) return;
            const me = session.user.uid;
            const ok = await bookOp(() => F.updateDoc(bookRef(id), { members: F.arrayRemove(me) }), `You left ${b.name}.`);
            if (ok) openBook('personal');
          } else if (act === 'delete') {
            if (!(await confirmDialog(`Delete ${b.name}?`, 'Every entry, budget, bill, goal and split in this book is removed for everyone. This can’t be undone.', 'Delete book', true))) return;
            deleteSharedBook(id);
          }
        });
      },
    });
  }

  // ============================================================
  // Global events
  // ============================================================
  const ACTIONS = {
    tab: (el) => setTab(el.dataset.tab),
    goto: (el) => { if (el.dataset.plan) ui.plan = el.dataset.plan; setTab(el.dataset.tab); },
    'month-prev': () => { ui.month = shiftMonth(ui.month, -1); render(); },
    'month-next': () => { if (ui.month < maxMonth()) { ui.month = shiftMonth(ui.month, 1); render(); } },
    add: (el) => openTxSheet({ type: el.dataset.type, cat: el.dataset.cat }),
    'open-tx': (el) => { const t = state.txns.find((x) => x.id === el.dataset.id); if (t) openTxSheet({ tx: t }); },
    settings: () => openSettings(),
    account: () => openAccount(),
    'join-book': (el) => joinBook(el.dataset.id),
    'decline-book': (el) => declineBook(el.dataset.id),
    'sign-in': () => { prefs.localOnly = false; prefsSave(); location.reload(); },
    'start-fresh': async () => {
      const ok = await confirmDialog('Start your own book?', 'The sample data will be cleared. Your entries are saved from now on.', 'Start fresh');
      if (!ok) return;
      commit(() => {});
      toast('Your book is ready. Add your first expense with the + button.');
    },
    'exit-sample': () => {
      if (!state.sample || !sampleStash) return;
      Object.assign(state, sampleStash, { sample: false, started: true });
      sampleStash = null;
      persist();
      render();
      toast('Back to your own data.');
    },
    'edit-budgets': () => openBudgetSheet(),
    'add-goal': () => openGoalSheet(),
    'edit-goal': (el) => { const g = state.goals.find((x) => x.id === el.dataset.id); if (g) openGoalSheet(g); },
    'goal-money': async (el) => {
      const g = state.goals.find((x) => x.id === el.dataset.id);
      if (!g) return;
      const out = el.dataset.dir === 'out';
      let amt = 0;
      const v = await openDialog({
        title: out ? `Withdraw from ${g.name}` : `Add to ${g.name}`,
        html: `<label class="field"><span>Amount</span><span class="affix"><b>${esc(cur.symbol)}</b><input id="gm-amt" inputmode="decimal" autocomplete="off"></span></label>
          <p class="hint">${out ? `Available: ${esc(money(g.saved))}` : `${esc(money(Math.max(0, g.target - g.saved)))} to go`}</p>`,
        actions: [{ label: 'Cancel', value: null }, { label: out ? 'Withdraw' : 'Add', value: 'ok', kind: 'filled' }],
        onAction(val, root) {
          if (val !== 'ok') return true;
          amt = num($('#gm-amt', root).value);
          if (!(amt > 0) || (out && amt > g.saved + 0.001)) { $('#gm-amt', root).closest('.field').classList.add('invalid'); return false; }
          return true;
        },
      });
      if (v !== 'ok') return;
      const rec = { ...g, saved: round2(Math.max(0, g.saved + (out ? -amt : amt))) };
      const fresh = commit(() => upsert(state.goals, rec));
      const reached = !out && rec.saved >= rec.target && g.saved < g.target;
      toast((reached ? `You reached “${g.name}”!` : out ? `Withdrew ${money(amt)}.` : `Added ${money(amt)} to ${g.name}.`) + freshNote(fresh));
    },
    'add-bill': () => openBillSheet(),
    'open-bill': (el) => { const b = state.bills.find((x) => x.id === el.dataset.id); if (b) openBillSheet({ bill: b }); },
    'pay-bill': (el) => payBill(el.dataset.id),
    'add-split': () => openSplitSheet(),
    'edit-split': (el) => { const s = state.splits.find((x) => x.id === el.dataset.id); if (s) openSplitSheet({ split: s }); },
    settle: (el) => toggleSettle(el.dataset.id, el.dataset.i),
    'plan-tab': (el) => { ui.plan = el.dataset.v; prefsSave(); render(); },
    'tools-tab': (el) => { ui.tools = el.dataset.v; prefsSave(); render(); },
    'insight-type': (el) => { ui.insight = el.dataset.v; prefsSave(); render(); },
    'open-tool': (el) => openTool(el.dataset.tool),
    'calc-key': (el) => calcPress(el.dataset.k),
    'calc-history': () => openCalcHistory(),
    'calc-to-expense': () => {
      const v = calcValue();
      if (!(v > 0)) { toast('Calculate a positive amount first.'); return; }
      openTxSheet({ amount: round2(v) });
    },
    'filter-type': (el) => { ui.filter.type = el.dataset.v; render(); },
    'clear-filters': () => { ui.filter = { ...ui.filter, type: 'all', cat: '', mode: '' }; render(); },
    'clear-q': () => { ui.filter.q = ''; render(); },
    'pick-cat-filter': async () => {
      const opts = [{ label: 'All categories', value: '' }, ...[...allCats('expense'), ...allCats('income')].map((c) => ({ label: c.name, value: c.id, ico: catIco(c, 'sm') }))];
      const v = await pickDialog('Category', opts, ui.filter.cat);
      if (v !== undefined) { ui.filter.cat = v; render(); }
    },
    'pick-mode-filter': async () => {
      const opts = [{ label: 'Any method', value: '' }, ...MODES.map((m) => ({ label: m.name, value: m.id, ico: `<span class="cat-ico sm" style="--h:200;--s:0">${ic(m.icon)}</span>` }))];
      const v = await pickDialog('Paid with', opts, ui.filter.mode);
      if (v !== undefined) { ui.filter.mode = v; render(); }
    },
    'cat-tx': (el) => { ui.filter = { q: '', type: 'all', cat: el.dataset.cat, mode: '' }; setTab('txns'); },
    export: () => exportPrompt(),
    'retry-load': async () => {
      await loadBook();
      render();
      toast(loadFailed ? 'Still can’t reach your saved data.' : 'Your data is loaded.');
    },
  };

  function bindGlobal() {
    document.addEventListener('click', (e) => {
      const g = e.target.closest('[data-gate]');
      if (!g || g.disabled) return;
      const k = g.dataset.gate;
      if (k === 'google') signInWithGoogle();
      else if (k === 'local') { prefs.localOnly = true; prefsSave(); location.reload(); }
      else if (k === 'retry') openBook(session.bookId);
      else if (k === 'reload') location.reload();
      else if (k === 'signout') signOutEverywhere();
    });
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-act]');
      if (!el || el.disabled) return;
      const fn = ACTIONS[el.dataset.act];
      if (fn) { e.preventDefault(); hideTip(); fn(el, e); }
    });
    document.addEventListener('keydown', (e) => {
      const target = e.target instanceof Element ? e.target : document.body;
      if ((e.key === 'Enter' || e.key === ' ') && target.matches('[role="button"][data-act]')) { e.preventDefault(); target.click(); return; }
      if ($('#dialog-root').children.length) return;
      const top = sheets[sheets.length - 1];
      if (top) {
        if (e.key === 'Escape') { top.close(); return; }
        if (top.onKey) top.onKey(e);
        return;
      }
      if (target.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return;
      if (ui.tab === 'tools' && (ui.tools === 'calc' || isWide()) && !e.metaKey && !e.ctrlKey && !e.altKey && !/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) {
        const map = { '*': '×', x: '×', X: '×', '/': '÷', '-': '−', '+': '+', '%': '%', '.': '.', ',': '.', Enter: '=', '=': '=', Backspace: 'del', Delete: 'AC', Escape: 'AC', '(': '()', ')': '()' };
        const k = /^\d$/.test(e.key) ? e.key : map[e.key];
        if (k) { e.preventDefault(); calcPress(k); }
      }
    });
    document.addEventListener('input', (e) => {
      if (e.target.id === 'tx-q') {
        ui.filter.q = e.target.value;
        const clear = $('[data-act="clear-q"]');
        if (clear) clear.hidden = !ui.filter.q;
        const hadBar = !!$('.month-bar');
        if (hadBar === !!ui.filter.q) {
          const pos = e.target.selectionStart;
          render();
          const inp = $('#tx-q');
          inp.focus();
          try { inp.setSelectionRange(pos, pos); } catch { /* type=search */ }
        } else renderTxList();
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { if (saveTimer) flush(); }
      else refreshFromStore();
    });
    window.addEventListener('pagehide', () => { if (saveTimer) flush(); });
  }

  // ============================================================
  // Boot
  // ============================================================
  async function boot() {
    prefsLoad();
    if (['system', 'light', 'dark'].includes(prefs.theme)) ui.theme = prefs.theme;
    if (prefs.tab) ui.tab = prefs.tab;
    const hashTab = (location.hash || '').slice(1);
    if (['home', 'txns', 'insights', 'plan', 'tools'].includes(hashTab)) ui.tab = hashTab;
    if (['budgets', 'goals', 'bills', 'split'].includes(prefs.plan)) ui.plan = prefs.plan;
    if (['calc', 'money'].includes(prefs.tools)) ui.tools = prefs.tools;
    if (['expense', 'income'].includes(prefs.insight)) ui.insight = prefs.insight;
    if (Array.isArray(prefs.calc)) calc.history = prefs.calc.filter((h) => h && typeof h.expr === 'string' && Number.isFinite(h.result)).slice(0, 30);
    applyTheme();
    setCurrency('INR');
    bindGlobal();
    if (FB_CONFIG && !prefs.localOnly) {
      session.mode = 'firebase';
      showGate('loading', { text: 'Starting Kharcha…' });
      try {
        fb = await initFirebase();
      } catch {
        showGate('error', { text: 'Couldn’t load sign-in. Check your internet connection and reload the page.', reload: true });
        return;
      }
      fb.A.getRedirectResult(fb.auth).catch((e) => showGate('signin', { error: authErrorText(e) }));
      fb.A.onAuthStateChanged(fb.auth, (u) => {
        if (u) {
          if (!session.user || session.user.uid !== u.uid) startSession(u);
        } else {
          session.user = null;
          stopSessionListeners();
          if (store.close) store.close();
          state.loaded = false;
          showGate('signin');
        }
      });
      return;
    }
    session.mode = IN_CLAUDE ? 'claude' : 'local';
    store = await pickStore();
    await loadBook();
    state.loaded = true;
    setTab(ui.tab);
  }
  async function loadBook() {
    let docs = null;
    for (let attempt = 0; attempt < 2 && !docs; attempt++) {
      try { docs = await store.loadAll(); } catch { if (attempt === 0) await wait(1200); }
    }
    lastLoad = Date.now();
    loadFailed = !docs;
    docs = docs || {};
    if (hasBook(docs)) applyDocs(docs); else if (!loadFailed) loadSample();
    lastSaved = snapshotOf(docs);
    setCurrency(state.settings.currency);
    applyTheme();
  }
  boot();
})();
