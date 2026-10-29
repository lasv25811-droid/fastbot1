// ==================== IMPORTS ====================
import http from 'http';
import fs from 'fs';
import { chromium } from 'playwright';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// ==================== KONFİQ ====================
const CHC_URL  = 'https://chcgreen.net';
const CHC_USER = process.env.CHC_USER;
const CHC_PASS = process.env.CHC_PASS;
const PORT     = process.env.PORT || 3000;

const MIN_AMOUNT = 3;       // saytdakı minimumla eyni
const MAX_AMOUNT = 2000;    // saytdakı CODE_MAX_AZN ilə eyni
const STALE_PROCESSING_MS = 2 * 60_000;

let browser = null, context = null, page = null;
let lastLoginMs = 0;
let db = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

// ==================== HTTP SERVER (Render portu görsün + "oyatma" üçün) ====================
const queue = [];
const queued = new Set();
let working = false;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    bot: 'chcgreen-bot',
    firebase: !!db,
    queue: queue.length,
    working,
    uptime: Math.floor(process.uptime()),
    lastLogin: lastLoginMs ? new Date(lastLoginMs).toISOString() : null,
    time: new Date().toISOString()
  }));
}).listen(PORT, '0.0.0.0', () => log(`🌐 HTTP server port ${PORT}-də işləyir`));

// ==================== FIREBASE ====================
function loadServiceAccount() {
  let raw = process.env.FIREBASE_CREDENTIALS;
  if (!raw) {
    for (const p of ['/etc/secrets/firebase.json', './firebase.json']) {
      if (fs.existsSync(p)) { raw = fs.readFileSync(p, 'utf8'); break; }
    }
  }
  if (!raw) throw new Error('FIREBASE_CREDENTIALS tapılmadı (Render → Environment)');
  raw = raw.trim();
  if (!raw.startsWith('{')) {
    try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch (_) {}
  }
  let sa;
  try { sa = JSON.parse(raw); }
  catch (e) { throw new Error('FIREBASE_CREDENTIALS düzgün JSON deyil: ' + e.message); }
  if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  if (!sa.project_id || !sa.client_email || !sa.private_key) {
    throw new Error('Service account JSON-da project_id / client_email / private_key çatışmır');
  }
  return sa;
}

function initFirebase() {
  const sa = loadServiceAccount();
  initializeApp({ credential: cert(sa) });
  db = getFirestore();
  log('🔥 Firebase qoşuldu → project:', sa.project_id);
}

// ==================== LOGIN ====================
async function ensureLoggedIn() {
  const fresh = page && (Date.now() - lastLoginMs < 25 * 60_000);
  if (fresh) {
    try {
      const url = page.url();
      if (url.includes('/invoice') || url.includes('/manage')) return;
    } catch (_) {}
  }

  if (browser) { try { await browser.close(); } catch (_) {} }
  browser = null; context = null; page = null;

  log('🔐 Login...');
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
  });
  context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 }
  });
  page = await context.newPage();
  page.setDefaultTimeout(30000);

  await page.goto(CHC_URL, { waitUntil: 'domcontentloaded' });
  await page.fill('#username', CHC_USER);
  await page.fill('#password', CHC_PASS);

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('input[type="submit"][value="Login"]')
  ]);

  const url = page.url();
  if (url.includes('security_check') || url.toLowerCase().includes('login')) {
    throw new Error('Login alınmadı — CHC_USER / CHC_PASS yanlışdır');
  }

  lastLoginMs = Date.now();
  log('✅ Login OK');
}

async function resetBrowser() {
  lastLoginMs = 0;
  try { if (browser) await browser.close(); } catch (_) {}
  browser = null; context = null; page = null;
}

// ==================== INVOICE SİYAHISI ====================
async function readInvoices() {
  return await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('#invoices tbody tr').forEach(row => {
      const idInput    = row.querySelector('input[name="_chk"]');
      const amountCell = row.querySelector('td.actions');
      const codeLink   = row.querySelector('td:nth-child(5) a');
      out.push({
        id: idInput ? idInput.value : null,
        code: codeLink ? codeLink.textContent.trim() : null,
        amount: parseFloat(amountCell ? amountCell.textContent : '0') || 0,
        isIn: row.classList.contains('in')
      });
    });
    return out;
  });
}

// ==================== YENİ INVOICE (kod) ====================
// e.safe === true  → "Save" basılmamışdı, invoice yaranmayıb, pul təhlükəsiz qaytarıla bilər
// e.safe === false → "Save" basılıb, invoice yaranmış ola bilər, admin yoxlamalıdır
async function createInvoice(amount) {
  let saved = false;
  try {
    await ensureLoggedIn();
    log(`📝 Invoice yaradılır: ${amount} AZN`);

    // Əvvəlki invoice-ların ID-ləri (yenisini dəqiq tapmaq üçün)
    await page.goto(`${CHC_URL}/invoice/list`, { waitUntil: 'domcontentloaded' });
    const before = new Set((await readInvoices()).map(r => r.id).filter(Boolean));

    await page.goto(`${CHC_URL}/invoice/new`, { waitUntil: 'domcontentloaded' });
    await page.fill('#amount', String(amount));

    saved = true; // bundan sonrakı hər xəta "qeyri-müəyyən" sayılır
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      page.click('input[value="Save"]')
    ]);

    let rows = await readInvoices();
    if (!rows.length) {
      await page.goto(`${CHC_URL}/invoice/list`, { waitUntil: 'domcontentloaded' });
      rows = await readInvoices();
    }

    const fresh = rows.find(r => r.id && !before.has(r.id) && r.isIn && r.code && r.amount > 0);
    if (!fresh) throw new Error('Yeni invoice/kod tapılmadı (struktur dəyişib?)');

    if (Math.abs(fresh.amount - amount) > 0.01) {
      log(`⚠️ Məbləğ fərqlidir: istənilən ${amount}, saytda ${fresh.amount}`);
    }
    log(`✅ Kod: ${fresh.code} | ID: ${fresh.id} | Məbləğ: ${fresh.amount}`);
    return { code: fresh.code, invoiceId: String(fresh.id), amount: fresh.amount };
  } catch (e) {
    e.safe = !saved;
    await resetBrowser();
    throw e;
  }
}

// ==================== FIRESTORE KÖMƏKÇİLƏR ====================
async function claim(ref) {
  return await db.runTransaction(async tx => {
    const s = await tx.get(ref);
    if (!s.exists || s.data().status !== 'pending') return null;
    tx.update(ref, { status: 'processing', startedAt: FieldValue.serverTimestamp() });
    return s.data();
  });
}

async function deliver(ref, id, data, result) {
  const batch = db.batch();
  batch.set(db.collection('users').doc(data.uid).collection('codes').doc('req_' + id), {
    code: result.code,
    platform: data.platform || 'fastloto',
    amount: Number(data.amount),
    source: 'chcgreen',
    status: 'active',
    createdAt: FieldValue.serverTimestamp()
  });
  batch.update(ref, {
    status: 'delivered',
    code: result.code,
    invoiceId: result.invoiceId,
    deliveredAt: FieldValue.serverTimestamp()
  });
  await batch.commit();
}

// Pulu istifadəçiyə qaytarır (yalnız invoice YARANMAYIBSA)
async function refund(ref, id, data, reason) {
  const amount = r2(data.amount);
  await db.runTransaction(async tx => {
    const rs = await tx.get(ref);
    if (!rs.exists || rs.data().refunded) return;
    const uRef = db.collection('users').doc(data.uid);
    const us = await tx.get(uRef);
    if (us.exists) {
      tx.update(uRef, { balance: r2((Number(us.data().balance) || 0) + amount) });
      tx.set(uRef.collection('history').doc('refund_' + id), {
        type: 'deposit',
        amount,
        description: (data.platform || 'fastloto').toUpperCase() + ' kod — texniki xəta, məbləğ qaytarıldı',
        createdAt: FieldValue.serverTimestamp()
      });
    }
    tx.update(ref, {
      status: 'failed',
      refunded: true,
      error: String(reason).slice(0, 300),
      failedAt: FieldValue.serverTimestamp()
    });
  });
  log(`↩️ Qaytarıldı ${amount} AZN → ${data.uid} (${reason})`);
}

// Qeyri-müəyyən hal: admin paneldə "Texniki xəta" bölməsinə düşür
async function markReview(ref, id, data, stage, reason, extra = {}) {
  try {
    await ref.update({
      status: 'review',
      error: String(reason).slice(0, 300),
      failedAt: FieldValue.serverTimestamp(),
      ...extra
    });
  } catch (_) {}
  try {
    let userName = '', userId = String(data.userId || '');
    try {
      const u = await db.collection('users').doc(data.uid).get();
      if (u.exists) { userName = u.data().displayName || ''; userId = String(u.data().uniqueId || userId); }
    } catch (_) {}
    await db.collection('failedOps').add({
      uid: data.uid || '',
      userId,
      userName,
      kind: 'code_purchase',
      platform: String(data.platform || 'fastloto'),
      amount: Number(data.amount) || 0,
      stage,
      charged: true,
      poolId: '',
      error: String(reason).slice(0, 300),
      status: 'new',
      createdAt: FieldValue.serverTimestamp()
    });
  } catch (e) { log('failedOps yazılmadı:', e.message); }
  log(`⚠️ Admin yoxlamalıdır: ${id} (${stage}: ${reason})`);
}

// ==================== BİR SORĞUNU İŞLƏ ====================
async function handle(id) {
  const ref = db.collection('chcgreenRequests').doc(id);
  const data = await claim(ref);
  if (!data) return; // başqası götürüb və ya artıq pending deyil

  const amount = Number(data.amount);
  if (!data.uid || !Number.isFinite(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
    await markReview(ref, id, data, 'invalid_request', 'Yanlış sorğu məlumatı');
    return;
  }

  log(`▶️ Sorğu ${id}: ${data.uid} → ${amount} AZN (${data.platform || 'fastloto'})`);

  let result;
  try {
    result = await createInvoice(amount);
  } catch (e) {
    log(`❌ ${id}:`, e.message);
    if (e.safe) {
      try { await refund(ref, id, data, e.message); }
      catch (e2) { await markReview(ref, id, data, 'refund_failed', e2.message); }
    } else {
      await markReview(ref, id, data, 'after_save', e.message);
    }
    return;
  }

  try {
    await deliver(ref, id, data, result);
    log(`✅ Çatdırıldı: ${data.uid} → ${result.code}`);
  } catch (e) {
    // Kod var, amma Firestore-a yazılmadı → bir də cəhd, olmasa admin
    try { await sleep(1500); await deliver(ref, id, data, result); log(`✅ Çatdırıldı (2-ci cəhd): ${result.code}`); }
    catch (e2) {
      await markReview(ref, id, data, 'deliver_failed', e2.message, { code: result.code, invoiceId: result.invoiceId });
    }
  }
}

// ==================== NÖVBƏ ====================
function enqueue(id) {
  if (queued.has(id)) return;
  queued.add(id);
  queue.push(id);
}

async function worker() {
  while (true) {
    const id = queue.shift();
    if (!id) { await sleep(400); continue; }
    queued.delete(id);
    working = true;
    try { await handle(id); }
    catch (e) { log('❌ Worker xətası:', e.message); }
    working = false;
  }
}

function listen() {
  db.collection('chcgreenRequests')
    .where('status', '==', 'pending')
    .onSnapshot(
      snap => snap.docChanges().forEach(ch => {
        if (ch.type === 'added' || ch.type === 'modified') enqueue(ch.doc.id);
      }),
      err => {
        log('❌ Listener xətası:', err.message, '→ 5 san sonra yenidən');
        setTimeout(listen, 5000);
      }
    );
  log('👂 chcgreenRequests dinlənilir');
}

// Bot çöküb "processing"-də qalmış sorğular → admin yoxlasın (təkrar kod verməmək üçün)
async function recoverStale() {
  try {
    const snap = await db.collection('chcgreenRequests').where('status', '==', 'processing').get();
    for (const d of snap.docs) {
      const data = d.data();
      const started = data.startedAt && data.startedAt.toMillis ? data.startedAt.toMillis() : 0;
      if (Date.now() - started > STALE_PROCESSING_MS) {
        await markReview(d.ref, d.id, data, 'bot_restart', 'Bot sorğu işlənərkən dayanıb');
      }
    }
  } catch (e) { log('recoverStale:', e.message); }
}

// ==================== START ====================
async function main() {
  log('🤖 Bot işə düşdü');
  if (!CHC_USER || !CHC_PASS) throw new Error('CHC_USER və CHC_PASS təyin olunmayıb (Render → Environment)');
  initFirebase();
  await recoverStale();
  worker();
  listen();
  // Login-i əvvəlcədən et ki, ilk sorğu tez getsin (alınmasa sorğu gələndə yenidən cəhd olunur)
  try { await ensureLoggedIn(); } catch (e) { log('⚠️ İlk login:', e.message); await resetBrowser(); }
}

process.on('unhandledRejection', e => console.error('UNHANDLED:', e));
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
