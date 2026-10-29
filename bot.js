import { chromium } from 'playwright';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// ==================== FIREBASE ====================
const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// ==================== KONFİQ ====================
const CHC_URL  = 'https://chcgreen.net';
const CHC_USER = process.env.CHC_USER || 'Ayl22';
const CHC_PASS = process.env.CHC_PASS || 'Qwerty1234@';
const TICK_MS  = 5000;              // əsas loop
const SYNC_ALL_EVERY = 30000;       // tam sync 30s-də bir

let browser, context, page;
let lastLoginMs = 0;
let lastFullSyncMs = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ==================== LOGIN ====================
async function ensureLoggedIn() {
  const fresh = page && (Date.now() - lastLoginMs < 25 * 60_000);
  if (fresh) {
    try {
      const url = page.url();
      if (url.includes('/invoice') || url.includes('/manage')) return;
    } catch(_) {}
  }

  if (browser) { try { await browser.close(); } catch(_){} }

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
  if (url.includes('security_check') || url.includes('login')) {
    throw new Error('Login alınmadı — kredensiallar yanlışdır');
  }

  lastLoginMs = Date.now();
  log('✅ Login OK');
}

// ==================== YENİ INVOICE ====================
async function createInvoice(amount) {
  await ensureLoggedIn();
  log(`📝 Invoice yaradılır: ${amount} AZN`);

  await page.goto(`${CHC_URL}/invoice/new`, { waitUntil: 'domcontentloaded' });

  // Token-lər avtomatik formda göndərilir (Playwright insan kimi davranır)
  await page.fill('#amount', String(amount));

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('input[value="Save"]')
  ]);

  // İndi /invoice/list səhifəsindəyik — ən yeni "in" invoice-u tap
  const latest = await page.evaluate(() => {
    const rows = document.querySelectorAll('#invoices tbody tr');
    for (const row of rows) {
      if (!row.classList.contains('in')) continue;
      const amountCell = row.querySelector('td.actions');
      const codeLink   = row.querySelector('td:nth-child(5) a');
      const idInput    = row.querySelector('input[name="_chk"]');
      if (!codeLink || !amountCell) continue;
      const amt = parseFloat(amountCell.textContent) || 0;
      if (amt <= 0) continue;
      return {
        code: codeLink.textContent.trim(),
        invoiceId: idInput ? idInput.value : null,
        amount: amt
      };
    }
    return null;
  });

  if (!latest || !latest.code || !latest.invoiceId) {
    throw new Error('Kod tapılmadı (list boş və ya struktur dəyişib)');
  }
  log(`✅ Kod: ${latest.code} | ID: ${latest.invoiceId} | Balans: ${latest.amount}`);
  return latest;
}

// ==================== INVOICE BALANSINI OXU ====================
async function getInvoiceBalance(invoiceId) {
  await ensureLoggedIn();
  await page.goto(`${CHC_URL}/invoice/list`, { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate((id) => {
    const rows = document.querySelectorAll('#invoices tbody tr');
    for (const row of rows) {
      const idInput = row.querySelector('input[name="_chk"]');
      if (!idInput || idInput.value !== id) continue;
      const amountCell = row.querySelector('td.actions');
      const amount = parseFloat(amountCell ? amountCell.textContent : '0') || 0;
      return {
        exists: true,
        amount,
        isIn: row.classList.contains('in'),
        isOut: row.classList.contains('out')
      };
    }
    return { exists: false, amount: 0 };
  }, String(invoiceId));

  return result;
}

// ==================== SORĞULARI İŞLƏ ====================
async function processCodeRequests() {
  const snap = await db.collection('chcgreenRequests')
    .where('status', '==', 'pending')
    .limit(5)
    .get();

  for (const doc of snap.docs) {
    const data = doc.data();
    try {
      await doc.ref.update({ status: 'processing', startedAt: FieldValue.serverTimestamp() });

      const result = await createInvoice(Number(data.amount));

      await doc.ref.update({
        status: 'delivered',
        code: result.code,
        invoiceId: result.invoiceId,
        deliveredAt: FieldValue.serverTimestamp()
      });

      // İstifadəçi sənədinə invoice bağla
      await db.collection('users').doc(data.uid).update({
        chcgreenInvoiceId: result.invoiceId,
        chcgreenTracking: true,
        chcgreenLastSync: FieldValue.serverTimestamp(),
        balance: result.amount
      });

      // İstifadəçinin kod arxivinə yaz
      await db.collection('users').doc(data.uid).collection('codes').add({
        code: result.code,
        platform: data.platform || 'fastloto',
        amount: Number(data.amount),
        source: 'chcgreen',
        status: 'active',
        createdAt: FieldValue.serverTimestamp()
      });

      log(`✅ ${data.uid} → ${result.code}`);
    } catch (e) {
      log(`❌ Sorğu xətası ${doc.id}:`, e.message);
      await doc.ref.update({
        status: 'failed',
        error: e.message.slice(0, 300),
        failedAt: FieldValue.serverTimestamp()
      });
    }
  }
}

// ==================== SINXRON İSTƏKLƏRİ ====================
async function processSyncRequests() {
  const snap = await db.collection('chcgreenSync').limit(10).get();
  if (snap.empty) return;

  for (const doc of snap.docs) {
    const uid = doc.id;
    try {
      const uSnap = await db.collection('users').doc(uid).get();
      if (!uSnap.exists) { await doc.ref.delete(); continue; }
      const u = uSnap.data();
      if (!u.chcgreenInvoiceId || u.chcgreenTracking === false) {
        await doc.ref.delete();
        continue;
      }
      const bal = await getInvoiceBalance(u.chcgreenInvoiceId);
      if (!bal.exists || bal.isOut || bal.amount <= 0) {
        await db.collection('users').doc(uid).update({
          balance: 0,
          chcgreenTracking: false,
          chcgreenLastSync: FieldValue.serverTimestamp()
        });
      } else {
        await db.collection('users').doc(uid).update({
          balance: bal.amount,
          chcgreenLastSync: FieldValue.serverTimestamp()
        });
      }
      await doc.ref.delete();
      log(`🔄 Sync ${uid} → ${bal.amount} AZN`);
    } catch (e) {
      log(`❌ Sync xətası ${uid}:`, e.message);
      await doc.ref.delete().catch(()=>{});
    }
  }
}

// ==================== BÜTÜN TRACKING İSTİFADƏÇİLƏR ====================
async function syncAllTracking() {
  if (Date.now() - lastFullSyncMs < SYNC_ALL_EVERY) return;
  lastFullSyncMs = Date.now();

  const snap = await db.collection('users')
    .where('chcgreenTracking', '==', true)
    .limit(50)
    .get();

  if (snap.empty) return;
  log(`🔄 Tam sync: ${snap.size} istifadəçi`);

  for (const userDoc of snap.docs) {
    const u = userDoc.data();
    if (!u.chcgreenInvoiceId) continue;
    try {
      const bal = await getInvoiceBalance(u.chcgreenInvoiceId);
      if (!bal.exists || bal.isOut || bal.amount <= 0) {
        await userDoc.ref.update({
          balance: 0,
          chcgreenTracking: false,
          chcgreenLastSync: FieldValue.serverTimestamp()
        });
      } else if (Number(u.balance) !== bal.amount) {
        await userDoc.ref.update({
          balance: bal.amount,
          chcgreenLastSync: FieldValue.serverTimestamp()
        });
      } else {
        await userDoc.ref.update({ chcgreenLastSync: FieldValue.serverTimestamp() });
      }
    } catch (e) {
      log(`⚠️ ${userDoc.id}:`, e.message);
    }
    await sleep(500); // rate limit
  }
}

// ==================== MAIN LOOP ====================
async function main() {
  log('🤖 Bot işə düşdü');
  await ensureLoggedIn();

  while (true) {
    try {
      await processCodeRequests();
      await processSyncRequests();
      await syncAllTracking();
    } catch (e) {
      log('❌ Loop xətası:', e.message);
      // Login problemi ola bilər → yenidən login
      if (/Login|security_check|Navigation/i.test(e.message)) {
        lastLoginMs = 0;
        try { await browser.close(); } catch(_){}
        browser = null; page = null;
      }
    }
    await sleep(TICK_MS);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });