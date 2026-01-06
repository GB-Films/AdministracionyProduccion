/* LA CASONA - Admin. vNext
   - expenses = obligaciones (gasto total, con vencimiento)
   - paymentLines = pagos reales (parciales permitidos)
   - calendario real (mes/semana/día) con drag&drop para mover dueDate
   - presupuesto nuevo + hover descripción
   - buscadores sin perder foco por autosync/rerender
*/

const DEFAULT_BIN_ID = "6949ab15d0ea881f403a5807";
const DEFAULT_ACCESS_KEY = "$2a$10$nzjX1kWtm5vCMZj8qtlSoeP/kUp77ZWnpFE6kWIcnBqe1fDL1lkDi";

const AUTO_PULL_INTERVAL_MS = 6000;
const AUTO_PUSH_DEBOUNCE_MS = 1200;
const DUE_SOON_DAYS = 4;
// PDFs/adjuntos inline: deshabilitados (solo links).

const $ = (sel) => document.querySelector(sel);
const view = $("#view");
const dlg = $("#dlg");
const dlgTitle = $("#dlgTitle");
const dlgBody = $("#dlgBody");
const dlgOk = $("#dlgOk");

const LS_KEY = "lacasona_admin_config_v2";
const LS_DEVICE = "lacasona_admin_deviceId_v1";

const filters = {
  budget:"", expenses:"", vendors:"", calendar:"", payments:"", balances:"", docs:""
};

const state = {
  config: loadConfig(),
  db: null,
  dirty: false,
  pushing: false,
  pullTimer: null,
  pushTimer: null,

  ui: {
    lock: false,
    pendingRender: false,
    calendarMode: "month",      // month|week|day
    calendarCursor: todayISO(), // “mes actual”
    calendarSelected: todayISO()
  }
};

/* ---------------- UI lock: no re-render mientras estás tipeando ---------------- */
document.addEventListener("focusin", (e)=>{
  if(isFormField(e.target)) state.ui.lock = true;
});
document.addEventListener("focusout", (e)=>{
  if(isFormField(e.target)){
    setTimeout(()=>{
      const ae = document.activeElement;
      if(!isFormField(ae)){
        state.ui.lock = false;
        if(state.ui.pendingRender){
          state.ui.pendingRender = false;
          route({ preserveFocus:false });
        }
      }
    }, 0);
  }
});
function isFormField(el){
  if(!el) return false;
  return ["INPUT","TEXTAREA","SELECT"].includes(el.tagName);
}

/* ---------------- Basic helpers ---------------- */
function setStatus(s){ const el=$("#syncStatus"); if(el) el.textContent = s||""; }
function uid(prefix="id"){ return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`; }
function nowISO(){ return new Date().toISOString(); }
function todayISO(){ return new Date().toISOString().slice(0,10); }
function parseISO(s){ if(!s) return null; const t=Date.parse(s); return Number.isFinite(t)?new Date(t):null; }
function formatDate(s){
  // dd/mm/aa para display
  if(!s) return "—";
  const d=parseISO(s); if(!d) return "—";
  const dd=String(d.getDate()).padStart(2,"0");
  const mm=String(d.getMonth()+1).padStart(2,"0");
  const yy=String(d.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}
function money(n){ return Number(n||0).toLocaleString("es-AR",{maximumFractionDigits:2}); }
function escapeHtml(s){ return String(s||"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;"); }
function plusDaysISO(iso,days){ const d=parseISO(iso); if(!d) return ""; d.setDate(d.getDate()+days); return d.toISOString().slice(0,10); }
function confirmDelete(label="este ítem"){ return window.confirm(`¿Borrar ${label}? Esta acción no se puede deshacer.`); }

const ICON = { trash:"🗑️", edit:"✏️", pay:"💸" };

/* Focus preservation (para buscadores al re-render) */
function captureFocus(){
  const el = document.activeElement;
  if(!el || !el.id) return null;
  const info = { id: el.id };
  if("value" in el) info.value = el.value;
  if(typeof el.selectionStart==="number") info.start = el.selectionStart;
  if(typeof el.selectionEnd==="number") info.end = el.selectionEnd;
  return info;
}
function restoreFocus(info){
  if(!info?.id) return;
  const el = document.getElementById(info.id);
  if(!el) return;
  el.focus({ preventScroll:true });
  if(typeof info.start==="number" && el.setSelectionRange) el.setSelectionRange(info.start, info.end ?? info.start);
}

/* ---------------- Config ---------------- */
function getDeviceId(){
  let id = localStorage.getItem(LS_DEVICE);
  if(!id){
    id = `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
    localStorage.setItem(LS_DEVICE, id);
  }
  return id;
}
function loadConfig(){
  try{
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    return { binId: raw?.binId || DEFAULT_BIN_ID, accessKey: raw?.accessKey || DEFAULT_ACCESS_KEY, masterKey: raw?.masterKey || "" };
  }catch{
    return { binId: DEFAULT_BIN_ID, accessKey: DEFAULT_ACCESS_KEY, masterKey:"" };
  }
}
function saveConfig(cfg){
  localStorage.setItem(LS_KEY, JSON.stringify(cfg));
  state.config = cfg;
}

/* ---------------- DB normalize + MIGRACIÓN ---------------- */
function tstamp(s){ return s ? (Date.parse(s) || 0) : 0; }
function ensureMeta(db){
  db._meta = db._meta || {};
  if(!db._meta.deviceId) db._meta.deviceId = getDeviceId();
  if(typeof db._meta.revision !== "number") db._meta.revision = 0;
  if(!db._meta.updatedAt) db._meta.updatedAt = "";
  return db;
}

function ensureTombstones(db){
  // Tombstones = ids borrados en serio (evita que “revivan” al mergear y evita crecer el BIN con deleted=true)
  db._tombstones = db._tombstones || {};
  const t = db._tombstones;
  t.vendors = t.vendors || {};
  t.budget = t.budget || {};
  t.expenses = t.expenses || {};
  t.paymentLines = t.paymentLines || {};
  t.documents = t.documents || {};
  return db;
}
function tombHas(db, collection, id){
  return !!(db?._tombstones?.[collection]?.[id]);
}
function addTombstone(db, collection, id){
  if(!id) return;
  ensureTombstones(db);
  // guardamos timestamp solo para debug; la regla es: si está, está borrado.
  db._tombstones[collection][id] = db._tombstones[collection][id] || nowISO();
}
function applyTombstonesToCollection(db, collection){
  ensureTombstones(db);
  const tomb = db._tombstones[collection] || {};
  db[collection] = (db[collection]||[]).filter(r => r && r.id && !tomb[r.id]);
}
function applyAllTombstones(db){
  applyTombstonesToCollection(db, "vendors");
  applyTombstonesToCollection(db, "budget");
  applyTombstonesToCollection(db, "expenses");
  applyTombstonesToCollection(db, "paymentLines");
  applyTombstonesToCollection(db, "documents");
}
function mergeTombstones(A,B){
  const out = { vendors:{}, budget:{}, expenses:{}, paymentLines:{}, documents:{} };
  const cols = Object.keys(out);
  for(const c of cols){
    Object.assign(out[c], B?.[c]||{});
    Object.assign(out[c], A?.[c]||{});
  }
  return out;
}
function compactDbForRemote(db){
  // 1) borra legacy que NO queremos sincronizar
  delete db.audit;
  delete db.payments; // legacy

  ensureTombstones(db);

  // 2) promueve deleted=true a tombstone + elimina del array
  const compactArr = (name)=>{
    const keep=[];
    for(const r of (db[name]||[])){
      if(!r || !r.id) continue;
      if(r.deleted===true){
        addTombstone(db, name, r.id);
        continue;
      }
      // 3) PDFs/adjuntos inline: siempre fuera (solo links)
      if(name==="paymentLines"){
        if("receiptDataUrl" in r) delete r.receiptDataUrl;
      }
      if(name==="expenses"){
        if("invoiceDataUrl" in r) delete r.invoiceDataUrl;
      }
      if(name==="documents"){
        if("dataUrl" in r) delete r.dataUrl;
      }
      keep.push(r);
    }
    db[name]=keep;
  };

  compactArr("vendors");
  compactArr("budget");
  compactArr("expenses");
  compactArr("paymentLines");
  compactArr("documents");

  // 4) aplica tombstones (por si venía un remoto “viejo”)
  applyAllTombstones(db);

  return db;
}

function bumpMeta(db){
  ensureMeta(db);
  db._meta.revision += 1;
  db._meta.updatedAt = nowISO();
  db._meta.updatedBy = getDeviceId();
}
function normalizeCollection(arr){
  if(!Array.isArray(arr)) return [];
  return arr.map(r=>{
    if(!r || typeof r!=="object") return r;
    if(!r.id) return r;
    if(!r.updatedAt) r.updatedAt = nowISO();
    if(typeof r.deleted!=="boolean") r.deleted = false;
    return r;
  });
}
function normalizeDb(db){
  ensureMeta(db);
  ensureTombstones(db);

  db.catalog = db.catalog || {};
  db.catalog.departments = db.catalog.departments || [
    "Producción","Dirección","Foto / Cámara","Eléctrica / Grip","Arte","Vestuario","Maquillaje",
    "Sonido","Locaciones / Permisos","Transporte","Catering","Casting","Post / Edición","VFX",
    "Música / SFX","Seguros / Legales","Otros"
  ];

  db.project = db.project || {};
  db.project.name = db.project.name || "LA CASONA";
  db.project.currency = db.project.currency || "ARS";
  db.project.startDate = db.project.startDate || "";
  db.project.numDays = db.project.numDays || 10;

  db.vendors = normalizeCollection(db.vendors);
  db.expenses = normalizeCollection(db.expenses);

  // NUEVO: presupuesto nuevo
  db.budget = normalizeCollection(db.budget).map(b=>{
    // compat: si viene del viejo, adaptamos lo que se pueda
    if(b && typeof b==="object"){
      if(!b.unitType) b.unitType = b.unitType || "";
      if(typeof b.units !== "number") b.units = Number(b.units||0);
      if(typeof b.unitCost !== "number") b.unitCost = Number(b.unitCost||0);
      if(!b.vendorId) b.vendorId = b.vendorId || "";
      if(!b.description) b.description = b.description || "";
    }
    return b;
  });

  // NUEVO: pagos reales
  db.paymentLines = normalizeCollection(db.paymentLines);

  db.documents = normalizeCollection(db.documents);

  // aplica tombstones para que no reaparezcan borrados al merge
  applyAllTombstones(db);
  // No sincronizamos audit ni estructura legacy
  if("audit" in db) delete db.audit;
  if("payments" in db) delete db.payments;

  // compat: si expense tenía campos viejos de pago, los dejamos pero el estado lo calculamos desde paymentLines
  return db;
}
function visible(arr){ return (arr||[]).filter(x=>x && x.deleted!==true); }
function deptIndex(dept){
  const list = state.db?.catalog?.departments || [];
  const i = list.indexOf(dept);
  return i===-1 ? 999 : i;
}

/* ---------------- Payment logic coherente ---------------- */
function paymentLinesForExpense(expenseId){
  return visible(state.db.paymentLines).filter(pl => pl.expenseId === expenseId);
}
function sumPaid(expenseId){
  return paymentLinesForExpense(expenseId).reduce((s,x)=>s+Number(x.amount||0),0);
}
function remainingForExpense(exp){
  return Math.max(0, Number(exp.amount||0) - sumPaid(exp.id));
}
function expenseStatus(exp){
  const paid = sumPaid(exp.id);
  const total = Number(exp.amount||0);
  if(paid <= 0) return "pending";
  if(paid + 0.000001 < total) return "partial";
  return "paid";
}
function statusBadgeClass(status, dueDate){
  if(status==="paid") return "paid";
  const t = todayISO();
  if(dueDate && dueDate < t) return "over";
  return status==="partial" ? "due" : "due";
}
function statusLabel(status){
  if(status==="paid") return "pagado";
  if(status==="partial") return "pagado parcial";
  return "pendiente";
}

/* ---------------- JSONBin ---------------- */
async function jsonbinFetch(method, path, body){
  const binId = state.config.binId?.trim();
  if(!binId) throw new Error("Falta BIN_ID.");

  const url = `https://api.jsonbin.io/v3${path}`;
  const headers = { "Content-Type":"application/json" };
  if(state.config.accessKey) headers["X-Access-Key"] = state.config.accessKey;
  if(state.config.masterKey) headers["X-Master-Key"] = state.config.masterKey;

  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json=null; try{ json = text ? JSON.parse(text) : null; }catch{}
  if(!res.ok){
    const msg = json?.message || json?.error || text || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}
async function pullLatest(){ return await jsonbinFetch("GET", `/b/${state.config.binId.trim()}/latest?meta=false`, null); }
async function pushLatest(db){ return await jsonbinFetch("PUT", `/b/${state.config.binId.trim()}`, db); }

/* ---------------- Merge (por updatedAt) ---------------- */
function mergeCollection(localArr, remoteArr){
  const map = new Map();
  const ingest = (rec)=>{
    if(!rec || !rec.id) return;
    const prev = map.get(rec.id);
    if(!prev){ map.set(rec.id, rec); return; }
    if(tstamp(rec.updatedAt) >= tstamp(prev.updatedAt)) map.set(rec.id, rec);
  };
  (remoteArr||[]).forEach(ingest);
  (localArr||[]).forEach(ingest);
  return Array.from(map.values());
}
function mergeDb(local, remote){
  const L = normalizeDb(structuredClone(local));
  const R = normalizeDb(structuredClone(remote));

  const merged = normalizeDb({
    schemaVersion: Math.max(L.schemaVersion||1, R.schemaVersion||1),
    project: { ...(R.project||{}), ...(L.project||{}) },
    catalog: { ...(R.catalog||{}), ...(L.catalog||{}) },

    _tombstones: mergeTombstones(L._tombstones, R._tombstones),

    vendors: mergeCollection(L.vendors, R.vendors),
    budget: mergeCollection(L.budget, R.budget),
    expenses: mergeCollection(L.expenses, R.expenses),
    paymentLines: mergeCollection(L.paymentLines, R.paymentLines),
    documents: mergeCollection(L.documents, R.documents)
  });

  // Los borrados reales (tombstones) siempre ganan: si alguien lo borró, no vuelve.
  applyAllTombstones(merged);

  ensureMeta(merged);
  return merged;
}

/* ---------------- Autosync ---------------- */
function setDirty(v){
  state.dirty = v;
  $("#btnSave").disabled = !state.db;
  if(v) scheduleAutoPush();
}
function scheduleAutoPush(){
  if(!state.db) return;
  if(state.pushTimer) clearTimeout(state.pushTimer);
  state.pushTimer = setTimeout(()=>autoPush().catch(()=>{}), AUTO_PUSH_DEBOUNCE_MS);
  setStatus("Cambios…");
}
async function autoPush(){
  if(!state.db || state.pushing) return;
  state.pushing = true;
  try{
    setStatus("Guardando…");
    let remote=null; try{ remote = await pullLatest(); }catch{}
    if(remote) state.db = mergeDb(state.db, remote);

    // IMPORTANTÍSIMO: no llenamos el BIN con audit ni payloads pesados.
    // - deleted=true se convierte en tombstone + se elimina del array
    // - base64 (PDF/recibos) se descarta si excede el límite (o si está desactivado)
    state.db = compactDbForRemote(state.db);

    bumpMeta(state.db);
    await pushLatest(state.db);

    setDirty(false);
    setStatus("Sincronizado");
  }catch(e){
    const msg = String(e.message||e);
    if(msg.toLowerCase().includes("content too large") || msg.includes("413")){
      setStatus("Error: BIN demasiado grande (413). Se descartaron adjuntos base64; usá URL para comprobantes.");
    }else{
      setStatus(`Error: ${msg.slice(0,80)}… (guardado local)`);
    }
  }finally{
    state.pushing = false;
  }
}
function startAutoPull(){
  if(state.pullTimer) return;
  state.pullTimer = setInterval(async ()=>{
    if(!state.config.binId || state.pushing) return;
    try{
      const remote = await pullLatest();
      if(!remote) return;

      if(!state.db){
        state.db = normalizeDb(remote);
        setDirty(false);
        route({ preserveFocus:false });
        setStatus("Sincronizado");
        return;
      }

      const rStamp = remote?._meta?.updatedAt || "";
      const lStamp = state.db?._meta?.updatedAt || "";
      if(rStamp && rStamp === lStamp) return;

      // Si estás tipeando, NO rerender. Guardamos el update y lo pintamos cuando salgas del input.
      if(state.ui.lock){
        state.db = mergeDb(state.db, remote);
        state.ui.pendingRender = true;
        return;
      }

      if(!state.dirty){
        state.db = normalizeDb(remote);
        const changed = postLoadMigrations(state.db);
        setDirty(changed);
        route({ preserveFocus:false });
        setStatus(changed?"Actualizado (migración)":"Actualizado");
        return;
      }

      state.db = mergeDb(state.db, remote);
      setDirty(true);
      route({ preserveFocus:false });
      setStatus("Merge…");
    }catch{
      setStatus("Offline");
    }
  }, AUTO_PULL_INTERVAL_MS);
}
async function boot(force=false){
  setStatus("Conectando…");
  try{
    if(force || !state.db){
      const remote = await pullLatest();
      state.db = normalizeDb(remote);
      const changed = postLoadMigrations(state.db);
      setDirty(changed);
    }
    setStatus("Sincronizado");
  }catch{
    setStatus("Offline (usando local)");
  }finally{
    startAutoPull();
    route({ preserveFocus:false });
  }
}

/* ---------------- Dialog / Search ---------------- */
function openDialog(title, bodyHtml, onOk){
  dlgTitle.textContent = title;
  dlgBody.innerHTML = bodyHtml;
  dlgOk.onclick = async (ev)=>{
    ev.preventDefault();
    try{ await onOk(); dlg.close(); }
    catch(e){ alert(e.message || e); }
  };
  dlg.showModal();
}
function renderSearch(routeKey, placeholder){
  return `<input class="search" id="q" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(filters[routeKey]||"")}" />`;
}
function attachSearch(routeKey){
  const input = $("#q");
  if(!input) return;
  input.oninput = ()=>{
    filters[routeKey] = input.value;
    // rerender preservando cursor y sin re-sync “molesto”
    route({ preserveFocus:true });
  };
}
function matchQuery(q, ...fields){
  q = (q||"").trim().toLowerCase();
  if(!q) return true;
  return fields.join(" ").toLowerCase().includes(q);
}

/* ---------------- Categorías + orden (Presupuesto / Gastos reales) ---------------- */
function isCatRow(r){ return !!(r && typeof r==="object" && r.kind==="cat"); }
function budgetItems(){ return visible(state.db.budget).filter(r=>!isCatRow(r)); }
function expenseItems(){ return visible(state.db.expenses).filter(r=>!isCatRow(r)); }

function sortByOrder(a,b){
  const ao = Number(a?.order||0);
  const bo = Number(b?.order||0);
  if(ao!==bo) return ao-bo;
  return (a?.updatedAt||"").localeCompare(b?.updatedAt||"");
}

function renumberOrders(recs, step=1000){
  let i=1;
  for(const r of recs){
    r.order = i*step;
    r.updatedAt = nowISO();
    i++;
  }
}

function stripPdfFields(db){
  // Por compatibilidad: si existían adjuntos base64 viejos, los limpiamos.
  let changed=false;

  const strip = (arr, fields)=>{
    for(const r of (arr||[])){
      if(!r || typeof r!=="object") continue;
      let touched=false;
      for(const f of fields){
        if(r[f]){
          try{ delete r[f]; }catch{ r[f] = ""; }
          touched=true;
          changed=true;
        }
      }
      if(touched){
        r.updatedAt = nowISO();
      }
    }
  };

  strip(db.paymentLines, ["receiptDataUrl"]);
  strip(db.expenses, ["invoiceDataUrl"]);
  strip(db.documents, ["dataUrl"]);
  return changed;
}

function migrateGroupedOrdering(db){
  // Agrega campos: kind(cat), groupId, order. Solo si faltan.
  let changed=false;

  const ensure = (arr)=> Array.isArray(arr)?arr:[];
  const ensureOrderSeq = (recs, step=1000)=>{
    let i=1;
    for(const r of recs){
      r.order = i*step;
      r.updatedAt = nowISO();
      i++;
    }
  };

  const ensureFor = (name)=>{
    db[name] = ensure(db[name]);
    const all = db[name];

    const cats = all.filter(r=>r && r.deleted!==true && r.kind==="cat");
    const items = all.filter(r=>r && r.deleted!==true && r.kind!=="cat");

    const catsById = Object.fromEntries(cats.map(c=>[c.id,c]));

    // Limpia groupId huérfanos
    for(const it of items){
      if(it.groupId && !catsById[it.groupId]){
        it.groupId = "";
        it.updatedAt = nowISO();
        changed=true;
      }
    }

    // Categorías: order
    const catsMissingOrder = cats.filter(c=>typeof c.order!=="number");
    if(catsMissingOrder.length){
      const sorted = cats.slice()
        .sort((a,b)=>(a.order??0)-(b.order??0) || (a.updatedAt||"").localeCompare(b.updatedAt||"") || (a.name||"").localeCompare(b.name||""));
      let i=1;
      for(const c of sorted){
        if(typeof c.order!=="number"){
          c.order = i*1000;
          c.updatedAt = nowISO();
          changed=true;
        }
        i++;
      }
    }

    // Ítems: order
    const byGroup = new Map();
    for(const it of items){
      const gid = it.groupId || "";
      if(!byGroup.has(gid)) byGroup.set(gid, []);
      byGroup.get(gid).push(it);
    }

    for(const [gid, groupItems] of byGroup.entries()){
      const missing = groupItems.filter(x=>typeof x.order!=="number");
      if(!missing.length) continue;

      // Si el grupo no tiene órdenes: preservamos el orden "viejo" para que no te cambie todo de golpe.
      const allMissing = groupItems.every(x=>typeof x.order!=="number");
      if(allMissing){
        let sorted = groupItems.slice();
        if(name==="budget"){
          sorted.sort((a,b)=>(deptIndex(a.department)-deptIndex(b.department)) ||
            (a.category||"").localeCompare(b.category||"") ||
            (a.vendorId||"").localeCompare(b.vendorId||""));
        }else{
          // expenses: fecha desc
          sorted.sort((a,b)=>(b.date||"").localeCompare(a.date||""));
        }
        let i=1;
        for(const it of sorted){
          it.order = i*1000;
          it.updatedAt = nowISO();
          i++;
        }
        changed=true;
      }else{
        const max = groupItems.reduce((m,x)=>Math.max(m, Number(x.order||0)), 0);
        let cur = max || 0;
        for(const it of missing){
          cur += 1000;
          it.order = cur;
          it.updatedAt = nowISO();
        }
        changed=true;
      }
    }
  };

  ensureFor("budget");
  ensureFor("expenses");

  return changed;
}

function postLoadMigrations(db){
  let changed=false;
  changed = stripPdfFields(db) || changed;
  changed = migrateGroupedOrdering(db) || changed;
  return changed;
}

/* ---------------- Routing ---------------- */
function ensureDb(){
  if(state.db) return true;
  view.innerHTML = `
    <div class="card">
      <h2>Sin datos todavía</h2>
      <p class="small">Estoy intentando cargar desde JSONBin.</p>
      <div class="row"><button class="btn" id="retry">Reintentar</button></div>
    </div>`;
  $("#retry").onclick = ()=>boot(true);
  return false;
}
function route({ preserveFocus=false } = {}){
  const focus = preserveFocus ? captureFocus() : null;

  const hash = location.hash || "#/dashboard";
  const r = hash.replace("#/","").split("?")[0];

  document.querySelectorAll(".sidebar a").forEach(a=>{
    a.classList.toggle("active", a.dataset.route === r);
  });

  if(r === "config"){ renderConfig(); if(focus) restoreFocus(focus); return; }
  if(!ensureDb()){ if(focus) restoreFocus(focus); return; }

  if(r === "dashboard") renderDashboard();
  else if(r === "budget") renderBudget();
  else if(r === "expenses") renderExpenses();
  else if(r === "vendors") renderVendors();
  else if(r === "calendar") renderCalendar();
  else if(r === "payments") renderPayments();
  else if(r === "balances") renderBalances();
  else if(r === "docs") renderDocs();
  else renderDashboard();

  if(focus) restoreFocus(focus);
}
window.addEventListener("hashchange", ()=>route({ preserveFocus:false }));

/* ---------------- Dashboard ---------------- */
function calcPlannedByDept(){
  const m=new Map();
  for(const b of budgetItems()){
    const dept=b.department||"Otros";
    const total = Number(b.units||0) * Number(b.unitCost||0);
    m.set(dept, (m.get(dept)||0) + total);
  }
  return m;
}
function calcActualByDept(){
  const m=new Map();
  for(const e of expenseItems()){
    const dept=e.department||"Otros";
    m.set(dept, (m.get(dept)||0) + Number(e.amount||0));
  }
  return m;
}
function renderDashboard(){
  const plannedTotal = budgetItems().reduce((s,b)=>s + (Number(b.units||0)*Number(b.unitCost||0)),0);
  const actualTotal = expenseItems().reduce((s,e)=>s + Number(e.amount||0),0);
  const diff = actualTotal - plannedTotal;

  const today = todayISO();
  const soonLimit = plusDaysISO(today, DUE_SOON_DAYS);

  const due = visible(state.db.expenses)
    .filter(e=>e.dueDate)
    .map(e=>{
      const st = expenseStatus(e);
      const rem = remainingForExpense(e);
      return { e, st, rem };
    })
    .filter(x=>x.st!=="paid" && x.rem>0)
    .filter(x=>x.e.dueDate <= soonLimit)
    .sort((a,b)=>(a.e.dueDate||"9999-12-31").localeCompare(b.e.dueDate||"9999-12-31"));

  const plannedByDept = calcPlannedByDept();
  const actualByDept = calcActualByDept();
  const depts = (state.db.catalog?.departments||[]).slice().sort((a,b)=>deptIndex(a)-deptIndex(b));
  const deptRows = depts.map(dept=>{
    const p=plannedByDept.get(dept)||0;
    const a=actualByDept.get(dept)||0;
    if(p===0 && a===0) return null;
    return { dept, p, a, d:a-p };
  }).filter(Boolean);

  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <div>
          <h2>LA CASONA <span class="muted">- Admin.</span></h2>
          <div class="small">
            Inicio: ${formatDate(state.db.project?.startDate)} · Días: ${escapeHtml(state.db.project?.numDays||10)} · Moneda: ${escapeHtml(state.db.project?.currency||"ARS")}
          </div>
        </div>
        <span class="badge">rev ${state.db._meta?.revision||0}</span>
      </div>
    </div>

    <div class="card">
      <h3>Resumen</h3>
      <div class="kpi">
        <div class="box"><div class="small">Plan</div><div class="val">$ ${money(plannedTotal)}</div></div>
        <div class="box"><div class="small">Real</div><div class="val">$ ${money(actualTotal)}</div></div>
        <div class="box"><div class="small">Desvío</div><div class="val">$ ${money(diff)}</div></div>
        <div class="box"><div class="small">Próx/vencidos (≤${DUE_SOON_DAYS}d)</div><div class="val">${due.length}</div></div>
      </div>
    </div>

    <div class="card">
      <h3>Plan vs Real por Depto</h3>
      ${deptRows.length?`
        <table>
          <thead><tr><th>Depto</th><th>Plan</th><th>Real</th><th>Desvío</th></tr></thead>
          <tbody>
            ${deptRows.map(r=>{
              const badge = r.d>0 ? "over" : (r.d<0 ? "paid" : "");
              return `<tr>
                <td>${escapeHtml(r.dept)}</td>
                <td>$ ${money(r.p)}</td>
                <td>$ ${money(r.a)}</td>
                <td><span class="badge ${badge}">$ ${money(r.d)}</span></td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      `:`<div class="small">Todavía no hay datos suficientes para el resumen por depto.</div>`}
    </div>

    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h3>Vencen pronto y vencidos</h3>
        <button class="btn" id="goCalendar">Ver calendario</button>
      </div>
      ${renderDueTable(due.slice(0,10))}
    </div>
  `;
  $("#goCalendar").onclick = ()=>location.hash="#/calendar";
}
function renderDueTable(list){
  if(!list.length) return `<div class="small">Nada por vencer (o no cargaste vencimientos).</div>`;
  const vendorsById = Object.fromEntries(visible(state.db.vendors).map(v=>[v.id,v]));
  const today = todayISO();
  return `
    <table>
      <thead><tr><th>Vence</th><th>Proveedor</th><th>Concepto</th><th>Saldo</th><th>Estado</th></tr></thead>
      <tbody>
        ${list.map(x=>{
          const e=x.e;
          const v=vendorsById[e.vendorId]?.name||"—";
          const isOver = e.dueDate < today;
          const badge = isOver ? "over" : (x.st==="partial"?"due":"due");
          const label = isOver ? "vencido" : statusLabel(x.st);
          return `<tr>
            <td>${formatDate(e.dueDate)}</td>
            <td>${escapeHtml(v)}</td>
            <td>${escapeHtml(e.concept||"—")}</td>
            <td>$ ${money(x.rem)}</td>
            <td><span class="badge ${badge}">${label}</span></td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  `;
}

/* ---------------- Presupuesto (nuevo) ---------------- */
function renderBudget(){
  const q = (filters.budget || "").trim();
  const vendors = visible(state.db.vendors);
  const vendorsById = Object.fromEntries(vendors.map(v=>[v.id,v]));
  const departments = state.db.catalog?.departments || [];

  const all = visible(state.db.budget);
  const catsAll = all.filter(isCatRow).sort(sortByOrder);
  const itemsAll = all.filter(r=>!isCatRow(r));

  const catsById = Object.fromEntries(catsAll.map(c=>[c.id,c]));
  const effGroup = (it)=> (it.groupId && catsById[it.groupId]) ? it.groupId : "";

  // Buscar: si matchea categoría, muestra todo lo de esa categoría.
  let items=[], catIds=new Set();
  if(!q){
    items = itemsAll;
    catIds = new Set(items.map(effGroup).filter(Boolean));
    catsAll.forEach(c=>catIds.add(c.id)); // mostramos todas las categorías aunque estén vacías (sirve para drop)
  }else{
    const catMatches = catsAll.filter(c=>matchQuery(q, c.name));
    const catMatchIds = new Set(catMatches.map(c=>c.id));

    const itemMatches = itemsAll.filter(b => matchQuery(
      q,
      b.department, b.category,
      catsById[b.groupId]?.name||"",
      vendorsById[b.vendorId]?.name||"",
      b.unitType, String(b.units), String(b.unitCost),
      b.description
    ));

    const itemsInCatMatch = itemsAll.filter(it=>catMatchIds.has(effGroup(it)));

    const map = new Map();
    for(const it of [...itemMatches, ...itemsInCatMatch]) map.set(it.id, it);
    items = Array.from(map.values());

    for(const it of items) catIds.add(effGroup(it));
    catMatches.forEach(c=>catIds.add(c.id));
  }

  const cats = catsAll.filter(c=>catIds.has(c.id)).sort(sortByOrder);

  const itemsByGroup = new Map();
  for(const it of items){
    const gid = effGroup(it);
    if(!itemsByGroup.has(gid)) itemsByGroup.set(gid, []);
    itemsByGroup.get(gid).push(it);
  }
  for(const [gid, arr] of itemsByGroup.entries()) arr.sort(sortByOrder);

  const canDnD = !q;

  const renderItemRow = (b)=>{
    const vendorName = vendorsById[b.vendorId]?.name || "—";
    const total = Number(b.units||0) * Number(b.unitCost||0);
    const tip = escapeHtml(b.description||"");
    return `
      <tr class="itemRow" title="${tip}" data-drop="budget-item" data-id="${b.id}">
        <td class="dragCell"><span class="dragHandle" draggable="${canDnD}" data-drag="budget-item" data-id="${b.id}" title="${canDnD?"Arrastrar":"Desactivado con búsqueda"}">↕</span></td>
        <td>${escapeHtml(b.department||"—")}</td>
        <td>${escapeHtml(b.category||"—")}</td>
        <td>${escapeHtml(vendorName)}</td>
        <td>${escapeHtml(b.unitType||"—")}</td>
        <td>${Number(b.units||0)}</td>
        <td>$ ${money(b.unitCost||0)}</td>
        <td>$ ${money(total)}</td>
        <td class="actionsCell">
          <div class="actions">
            <button class="iconbtn accent" title="Editar" data-edit="${b.id}">${ICON.edit}</button>
            <button class="iconbtn danger" title="Borrar" data-del="${b.id}">${ICON.trash}</button>
          </div>
        </td>
      </tr>`;
  };

  const renderGroupHeader = (gid, title, count, sum, isRealCat)=>{
    const collapsed = isRealCat ? !!catsById[gid]?.collapsed : false;
    const caret = collapsed ? "▶" : "▼";
    const dropAttr = isRealCat ? `data-drop="budget-cat" data-id="${gid}"` : `data-drop="budget-uncat" data-id="__none__"`;
    const dragHandle = isRealCat ? `<span class="dragHandle" draggable="${canDnD}" data-drag="budget-cat" data-id="${gid}" title="${canDnD?"Arrastrar categoría":"Desactivado con búsqueda"}">↕</span>` : `<span class="dragHandle mutedHandle" title="Sin categoría">·</span>`;
    const toggle = isRealCat ? `<button class="iconbtn" title="${collapsed?"Expandir":"Colapsar"}" data-togglecat="${gid}">${caret}</button>` : "";
    const editDel = isRealCat ? `
      <div class="actions">
        <button class="iconbtn accent" title="Editar" data-editcat="${gid}">${ICON.edit}</button>
        <button class="iconbtn danger" title="Borrar" data-delcat="${gid}">${ICON.trash}</button>
      </div>` : "";
    return `
      <tr class="catRow" ${dropAttr}>
        <td class="dragCell">${dragHandle}</td>
        <td colspan="7">
          <div class="catTitle">
            ${toggle}
            <div class="catText">
              <div class="catName">${escapeHtml(title)}</div>
              <div class="small">${count} ítems · $ ${money(sum)}</div>
            </div>
          </div>
        </td>
        <td class="actionsCell">${editDel}</td>
      </tr>`;
  };

  const sumFor = (arr)=>arr.reduce((s,b)=>s + (Number(b.units||0)*Number(b.unitCost||0)),0);

  const uncatItems = itemsByGroup.get("") || [];
  const showUncat = uncatItems.length>0 || cats.length===0;

  view.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div>
          <h2>Presupuesto</h2>
          <div class="small">${canDnD ? "Arrastrá filas para reordenar / mover entre categorías." : "Con búsqueda activa no se puede reordenar (para evitar lío)."}</div>
        </div>
        <div class="row" style="min-width:520px;justify-content:flex-end">
          ${renderSearch("budget","Buscar depto / rubro / proveedor / categoría…")}
          <button class="btn" id="btnAddCat">+ Categoría</button>
          <button class="btn" id="btnAdd">+ Ítem</button>
        </div>
      </div>
    </div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th style="width:38px"></th>
            <th>Depto</th><th>Rubro</th><th>Proveedor</th><th>Tipo unidad</th><th>Unidades</th><th>$ Unitario</th><th>$ Total</th>
            <th class="actionsCell"></th>
          </tr>
        </thead>
        <tbody>
          ${showUncat ? renderGroupHeader("", "Sin categoría", uncatItems.length, sumFor(uncatItems), false) : ""}
          ${showUncat && uncatItems.length ? uncatItems.map(renderItemRow).join("") : ""}

          ${cats.map(c=>{
            const arr = (itemsByGroup.get(c.id) || []);
            const sum = sumFor(arr);
            const head = renderGroupHeader(c.id, c.name || "Categoría", arr.length, sum, true);
            if(c.collapsed) return head;
            return head + arr.map(renderItemRow).join("");
          }).join("")}
        </tbody>
      </table>
      ${(items.length || cats.length)? "" : `<div class="small">No hay ítems (o tu búsqueda no encontró nada).</div>`}
    </div>
  `;

  attachSearch("budget");

  $("#btnAdd").onclick = ()=>openBudgetItemDialog(null);
  $("#btnAddCat").onclick = ()=>openBudgetCatDialog(null);

  // Ítems
  view.querySelectorAll("[data-del]").forEach(btn=>{
    btn.onclick = ()=>{
      const rec = state.db.budget.find(x=>x.id===btn.dataset.del);
      if(rec && confirmDelete("este ítem de presupuesto")){
        rec.deleted=true; rec.updatedAt=nowISO();
        setDirty(true); route({preserveFocus:false});
      }
    };
  });
  view.querySelectorAll("[data-edit]").forEach(btn=>{
    btn.onclick = ()=>{
      const rec = state.db.budget.find(x=>x.id===btn.dataset.edit);
      if(rec) openBudgetItemDialog(rec);
    };
  });

  // Categorías
  view.querySelectorAll("[data-editcat]").forEach(btn=>{
    btn.onclick = ()=>{
      const rec = state.db.budget.find(x=>x.id===btn.dataset.editcat && x.deleted!==true && isCatRow(x));
      if(rec) openBudgetCatDialog(rec);
    };
  });
  view.querySelectorAll("[data-delcat]").forEach(btn=>{
    btn.onclick = ()=>{
      const cat = state.db.budget.find(x=>x.id===btn.dataset.delcat && x.deleted!==true && isCatRow(x));
      if(!cat) return;
      if(!confirmDelete(`la categoría "${cat.name||"sin nombre"}"`)) return;

      // Los ítems pasan a "Sin categoría"
      for(const it of state.db.budget){
        if(it && it.deleted!==true && !isCatRow(it) && it.groupId===cat.id){
          it.groupId = "";
          it.updatedAt = nowISO();
        }
      }
      cat.deleted = true;
      cat.updatedAt = nowISO();

      setDirty(true);
      route({preserveFocus:false});
    };
  });
  view.querySelectorAll("[data-togglecat]").forEach(btn=>{
    btn.onclick = ()=>{
      const cat = state.db.budget.find(x=>x.id===btn.dataset.togglecat && x.deleted!==true && isCatRow(x));
      if(!cat) return;
      cat.collapsed = !cat.collapsed;
      cat.updatedAt = nowISO();
      setDirty(true);
      route({preserveFocus:false});
    };
  });

  if(canDnD) attachDnD();

  function attachDnD(){
    view.querySelectorAll("[data-drag]").forEach(h=>{
      h.ondragstart = (ev)=>{
        const payload = { kind: h.dataset.drag, id: h.dataset.id };
        ev.dataTransfer.setData("text/plain", JSON.stringify(payload));
        ev.dataTransfer.effectAllowed = "move";
      };
    });

    view.querySelectorAll("tr[data-drop]").forEach(row=>{
      row.ondragover = (ev)=>{ ev.preventDefault(); row.classList.add("dropHintRow"); };
      row.ondragleave = ()=>row.classList.remove("dropHintRow");
      row.ondrop = (ev)=>{
        ev.preventDefault();
        row.classList.remove("dropHintRow");
        let payload=null;
        try{ payload = JSON.parse(ev.dataTransfer.getData("text/plain")||""); }catch{}
        if(!payload?.id || !payload?.kind) return;

        if(payload.kind==="budget-item"){
          const targetType = row.dataset.drop;
          const targetId = row.dataset.id || "";
          const beforeId = (targetType==="budget-item") ? targetId : "";
          let destGroupId = "";

          if(targetType==="budget-cat") destGroupId = targetId;
          if(targetType==="budget-uncat") destGroupId = "";
          if(targetType==="budget-item"){
            const tgt = state.db.budget.find(x=>x.id===targetId && x.deleted!==true && !isCatRow(x));
            if(tgt) destGroupId = effGroup(tgt);
          }

          moveBudgetItem(payload.id, destGroupId, beforeId);
          setDirty(true);
          route({preserveFocus:false});
        }

        if(payload.kind==="budget-cat" && row.dataset.drop==="budget-cat"){
          reorderBudgetCat(payload.id, row.dataset.id);
          setDirty(true);
          route({preserveFocus:false});
        }
      };
    });
  }

  function groupItems(gid){
    const catsNow = Object.fromEntries(visible(state.db.budget).filter(isCatRow).map(c=>[c.id,c]));
    const eff = (it)=> (it.groupId && catsNow[it.groupId]) ? it.groupId : "";
    return visible(state.db.budget)
      .filter(r=>!isCatRow(r) && eff(r)===gid)
      .sort(sortByOrder);
  }

  function moveBudgetItem(itemId, destGroupId, beforeId){
    const it = state.db.budget.find(x=>x.id===itemId && x.deleted!==true && !isCatRow(x));
    if(!it) return;

    const catsNow = Object.fromEntries(visible(state.db.budget).filter(isCatRow).map(c=>[c.id,c]));
    const eff = (r)=> (r.groupId && catsNow[r.groupId]) ? r.groupId : "";
    const srcGroup = eff(it);
    const dest = (destGroupId && catsNow[destGroupId]) ? destGroupId : "";

    // Reordena origen
    if(srcGroup !== dest){
      const src = groupItems(srcGroup).filter(x=>x.id!==it.id);
      renumberOrders(src);
    }

    it.groupId = dest;

    // Reordena destino
    let destArr = groupItems(dest).filter(x=>x.id!==it.id);
    const idx = beforeId ? destArr.findIndex(x=>x.id===beforeId) : -1;
    if(idx<0) destArr.push(it);
    else destArr.splice(idx,0,it);
    renumberOrders(destArr);
  }

  function reorderBudgetCat(movingId, targetId){
    if(movingId===targetId) return;
    const catsNow = visible(state.db.budget).filter(isCatRow).sort(sortByOrder);
    const moving = catsNow.find(c=>c.id===movingId);
    const target = catsNow.find(c=>c.id===targetId);
    if(!moving || !target) return;

    const arr = catsNow.filter(c=>c.id!==movingId);
    const idx = arr.findIndex(c=>c.id===targetId);
    if(idx<0) arr.push(moving);
    else arr.splice(idx,0,moving);
    renumberOrders(arr);
  }

  function openBudgetCatDialog(rec){
    const isEdit=!!rec;
    openDialog(isEdit?"Editar categoría":"Nueva categoría", `
      <div class="grid2">
        <div><label>Nombre</label><input id="d_name" value="${escapeHtml(rec?.name||"")}" placeholder="Ej: Rodaje / Post / Arte…"/></div>
        <div class="small">Arrastrá la categoría para cambiar su orden.</div>
      </div>
    `, ()=>{
      const name = $("#d_name").value.trim();
      if(!name) throw new Error("Poné un nombre.");
      if(isEdit){
        rec.name = name;
        rec.updatedAt = nowISO();
      }else{
        const max = visible(state.db.budget).filter(isCatRow).reduce((m,c)=>Math.max(m, Number(c.order||0)), 0);
        state.db.budget.push({
          id: uid("bc"),
          kind:"cat",
          name,
          order: (max||0)+1000,
          collapsed:false,
          updatedAt: nowISO(),
          deleted:false
        });
      }
      setDirty(true);
      route({preserveFocus:false});
    });
  }

  function openBudgetItemDialog(rec){
    const isEdit=!!rec;
    const vendorOpt = vendors.map(v=>`<option value="${v.id}" ${rec?.vendorId===v.id?"selected":""}>${escapeHtml(v.name)}</option>`).join("");
    const deptOpt = departments.map(d=>`<option ${rec?.department===d?"selected":""}>${escapeHtml(d)}</option>`).join("");
    const catsNow = visible(state.db.budget).filter(isCatRow).sort(sortByOrder);
    const groupOpt = [`<option value="">Sin categoría</option>`, ...catsNow.map(c=>`<option value="${c.id}" ${rec?.groupId===c.id?"selected":""}>${escapeHtml(c.name||"Categoría")}</option>`)].join("");

    openDialog(isEdit?"Editar ítem":"Nuevo ítem", `
      <div class="grid3">
        <div><label>Categoría</label><select id="d_group">${groupOpt}</select></div>
        <div><label>Depto</label><select id="d_department">${deptOpt}</select></div>
        <div><label>Rubro</label><input id="d_category" value="${escapeHtml(rec?.category||"")}" placeholder="Ej: Cámara"/></div>
      </div>

      <div class="grid3">
        <div><label>Proveedor (opcional)</label>
          <select id="d_vendor">
            <option value="">—</option>${vendorOpt}
          </select>
        </div>
        <div><label>Tipo unidad</label><input id="d_unitType" value="${escapeHtml(rec?.unitType||"")}" placeholder="Ej: Día / Jornada / Unidad"/></div>
        <div><label>Unidades</label><input id="d_units" type="number" step="0.01" value="${Number(rec?.units||0)}"/></div>
      </div>

      <div class="grid2">
        <div><label>$ Unitario</label><input id="d_unitCost" type="number" step="0.01" value="${Number(rec?.unitCost||0)}"/></div>
        <div><label>Orden</label><input id="d_order" type="number" step="1" value="${Number(rec?.order||0)}" placeholder="(auto)"/></div>
      </div>

      <div><label>Descripción (hover)</label><textarea id="d_description">${escapeHtml(rec?.description||"")}</textarea></div>
    `, ()=>{
      const payload = {
        groupId: $("#d_group").value || "",
        department: $("#d_department").value,
        category: $("#d_category").value.trim(),
        vendorId: $("#d_vendor").value || "",
        unitType: $("#d_unitType").value.trim(),
        units: Number($("#d_units").value||0),
        unitCost: Number($("#d_unitCost").value||0),
        description: $("#d_description").value.trim()
      };

      if(isEdit){
        Object.assign(rec, payload);
        rec.updatedAt=nowISO();
      }else{
        const gid = payload.groupId || "";
        const max = visible(state.db.budget)
          .filter(r=>!isCatRow(r) && (r.groupId||"")===gid)
          .reduce((m,r)=>Math.max(m, Number(r.order||0)), 0);
        state.db.budget.push({ id: uid("b"), updatedAt: nowISO(), deleted:false, order:(max||0)+1000, ...payload });
      }
      setDirty(true);
      route({preserveFocus:false});
    });
  }
}

/* ---------------- Gastos reales (con parciales) ---------------- */
function renderExpenses(){
  const q = (filters.expenses || "").trim();
  const vendors = visible(state.db.vendors);
  const vendorsById = Object.fromEntries(vendors.map(v=>[v.id,v]));
  const departments = state.db.catalog?.departments || [];

  const all = visible(state.db.expenses);
  const catsAll = all.filter(isCatRow).sort(sortByOrder);
  const itemsAll = all.filter(r=>!isCatRow(r));

  const catsById = Object.fromEntries(catsAll.map(c=>[c.id,c]));
  const effGroup = (it)=> (it.groupId && catsById[it.groupId]) ? it.groupId : "";

  // Buscar: si matchea categoría, muestra todo lo de esa categoría.
  let items=[], catIds=new Set();
  if(!q){
    items = itemsAll;
    catsAll.forEach(c=>catIds.add(c.id)); // mostramos todas las categorías aunque estén vacías (sirve para drop)
  }else{
    const catMatches = catsAll.filter(c=>matchQuery(q, c.name));
    const catMatchIds = new Set(catMatches.map(c=>c.id));

    const itemMatches = itemsAll.filter(e => matchQuery(
      q,
      e.date, e.dueDate, e.serviceDate,
      e.department, e.concept,
      catsById[e.groupId]?.name||"",
      vendorsById[e.vendorId]?.name||""
    ));

    const itemsInCatMatch = itemsAll.filter(it=>catMatchIds.has(effGroup(it)));

    const map = new Map();
    for(const it of [...itemMatches, ...itemsInCatMatch]) map.set(it.id, it);
    items = Array.from(map.values());

    for(const it of items) catIds.add(effGroup(it));
    catMatches.forEach(c=>catIds.add(c.id));
  }

  const cats = catsAll.filter(c=>catIds.has(c.id)).sort(sortByOrder);

  const itemsByGroup = new Map();
  for(const it of items){
    const gid = effGroup(it);
    if(!itemsByGroup.has(gid)) itemsByGroup.set(gid, []);
    itemsByGroup.get(gid).push(it);
  }
  for(const [gid, arr] of itemsByGroup.entries()) arr.sort(sortByOrder);

  const canDnD = !q;

  const renderItemRow = (e)=>{
    const vendorName = vendorsById[e.vendorId]?.name || "—";
    const paid = sumPaid(e.id);
    const rem = remainingForExpense(e);
    const st = expenseStatus(e);
    const badge = statusBadgeClass(st, e.dueDate);

    return `
      <tr class="itemRow" data-drop="exp-item" data-id="${e.id}">
        <td class="dragCell"><span class="dragHandle" draggable="${canDnD}" data-drag="exp-item" data-id="${e.id}" title="${canDnD?"Arrastrar":"Desactivado con búsqueda"}">↕</span></td>
        <td>${formatDate(e.date)}</td>
        <td>${escapeHtml(vendorName)}</td>
        <td>${escapeHtml(e.department||"—")}</td>
        <td>${escapeHtml(e.concept||"—")}</td>
        <td>$ ${money(e.amount||0)}</td>
        <td>${formatDate(e.serviceDate)}</td>
        <td>${formatDate(e.dueDate)}</td>
        <td>$ ${money(paid)}</td>
        <td>$ ${money(rem)}</td>
        <td><span class="badge ${badge}">${statusLabel(st)}</span></td>
        <td class="actionsCell">
          <div class="actions">
            ${rem>0 ? `<button class="iconbtn good" title="Registrar pago" data-pay="${e.id}">${ICON.pay}</button>` : ""}
            <button class="iconbtn accent" title="Editar" data-edit="${e.id}">${ICON.edit}</button>
            <button class="iconbtn danger" title="Borrar" data-del="${e.id}">${ICON.trash}</button>
          </div>
        </td>
      </tr>`;
  };

  const renderGroupHeader = (gid, title, count, sum, isRealCat)=>{
    const collapsed = isRealCat ? !!catsById[gid]?.collapsed : false;
    const caret = collapsed ? "▶" : "▼";
    const dropAttr = isRealCat ? `data-drop="exp-cat" data-id="${gid}"` : `data-drop="exp-uncat" data-id="__none__"`;
    const dragHandle = isRealCat ? `<span class="dragHandle" draggable="${canDnD}" data-drag="exp-cat" data-id="${gid}" title="${canDnD?"Arrastrar categoría":"Desactivado con búsqueda"}">↕</span>` : `<span class="dragHandle mutedHandle" title="Sin categoría">·</span>`;
    const toggle = isRealCat ? `<button class="iconbtn" title="${collapsed?"Expandir":"Colapsar"}" data-togglecat="${gid}">${caret}</button>` : "";
    const editDel = isRealCat ? `
      <div class="actions">
        <button class="iconbtn accent" title="Editar" data-editcat="${gid}">${ICON.edit}</button>
        <button class="iconbtn danger" title="Borrar" data-delcat="${gid}">${ICON.trash}</button>
      </div>` : "";
    return `
      <tr class="catRow" ${dropAttr}>
        <td class="dragCell">${dragHandle}</td>
        <td colspan="10">
          <div class="catTitle">
            ${toggle}
            <div class="catText">
              <div class="catName">${escapeHtml(title)}</div>
              <div class="small">${count} gastos · $ ${money(sum)}</div>
            </div>
          </div>
        </td>
        <td class="actionsCell">${editDel}</td>
      </tr>`;
  };

  const sumFor = (arr)=>arr.reduce((s,e)=>s + Number(e.amount||0),0);

  const uncatItems = itemsByGroup.get("") || [];
  const showUncat = uncatItems.length>0 || cats.length===0;

  view.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div>
          <h2>Gastos reales</h2>
          <div class="small">${canDnD ? "Arrastrá filas para reordenar / mover entre categorías." : "Con búsqueda activa no se puede reordenar."}</div>
        </div>
        <div class="row" style="min-width:520px;justify-content:flex-end">
          ${renderSearch("expenses","Buscar concepto / proveedor / depto / categoría…")}
          <button class="btn" id="btnAddCat">+ Categoría</button>
          <button class="btn" id="btnAdd">+ Gasto</button>
        </div>
      </div>
    </div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th style="width:38px"></th>
            <th>Fecha</th><th>Proveedor</th><th>Depto</th><th>Concepto</th>
            <th>Total</th><th>Ejecución</th><th>Vence</th><th>Pagado</th><th>Saldo</th><th>Estado</th>
            <th class="actionsCell"></th>
          </tr>
        </thead>
        <tbody>
          ${showUncat ? renderGroupHeader("", "Sin categoría", uncatItems.length, sumFor(uncatItems), false) : ""}
          ${showUncat && uncatItems.length ? uncatItems.map(renderItemRow).join("") : ""}

          ${cats.map(c=>{
            const arr = (itemsByGroup.get(c.id) || []);
            const sum = sumFor(arr);
            const head = renderGroupHeader(c.id, c.name || "Categoría", arr.length, sum, true);
            if(c.collapsed) return head;
            return head + arr.map(renderItemRow).join("");
          }).join("")}
        </tbody>
      </table>
      ${(items.length || cats.length)? "" : `<div class="small">No hay gastos (o tu búsqueda no encontró nada).</div>`}
    </div>
  `;

  attachSearch("expenses");
  $("#btnAdd").onclick = ()=>openExpenseDialog(null);
  $("#btnAddCat").onclick = ()=>openExpenseCatDialog(null);

  // Ítems
  view.querySelectorAll("[data-del]").forEach(btn=>{
    btn.onclick = ()=>{
      const rec = state.db.expenses.find(x=>x.id===btn.dataset.del && x.deleted!==true && !isCatRow(x));
      if(rec && confirmDelete("este gasto")){
        rec.deleted=true; rec.updatedAt=nowISO();
        for(const pl of paymentLinesForExpense(rec.id)){
          pl.deleted=true; pl.updatedAt=nowISO();
        }
        setDirty(true);
        route({preserveFocus:false});
      }
    };
  });

  view.querySelectorAll("[data-edit]").forEach(btn=>{
    btn.onclick = ()=>{
      const rec = state.db.expenses.find(x=>x.id===btn.dataset.edit && x.deleted!==true && !isCatRow(x));
      if(rec) openExpenseDialog(rec);
    };
  });

  view.querySelectorAll("[data-pay]").forEach(btn=>{
    btn.onclick = ()=>{
      const rec = state.db.expenses.find(x=>x.id===btn.dataset.pay && x.deleted!==true && !isCatRow(x));
      if(rec) openPayDialog(rec);
    };
  });

  // Categorías
  view.querySelectorAll("[data-editcat]").forEach(btn=>{
    btn.onclick = ()=>{
      const rec = state.db.expenses.find(x=>x.id===btn.dataset.editcat && x.deleted!==true && isCatRow(x));
      if(rec) openExpenseCatDialog(rec);
    };
  });
  view.querySelectorAll("[data-delcat]").forEach(btn=>{
    btn.onclick = ()=>{
      const cat = state.db.expenses.find(x=>x.id===btn.dataset.delcat && x.deleted!==true && isCatRow(x));
      if(!cat) return;
      if(!confirmDelete(`la categoría "${cat.name||"sin nombre"}"`)) return;

      for(const it of state.db.expenses){
        if(it && it.deleted!==true && !isCatRow(it) && it.groupId===cat.id){
          it.groupId = "";
          it.updatedAt = nowISO();
        }
      }
      cat.deleted = true;
      cat.updatedAt = nowISO();

      setDirty(true);
      route({preserveFocus:false});
    };
  });
  view.querySelectorAll("[data-togglecat]").forEach(btn=>{
    btn.onclick = ()=>{
      const cat = state.db.expenses.find(x=>x.id===btn.dataset.togglecat && x.deleted!==true && isCatRow(x));
      if(!cat) return;
      cat.collapsed = !cat.collapsed;
      cat.updatedAt = nowISO();
      setDirty(true);
      route({preserveFocus:false});
    };
  });

  if(canDnD) attachDnD();

  function attachDnD(){
    view.querySelectorAll("[data-drag]").forEach(h=>{
      h.ondragstart = (ev)=>{
        const payload = { kind: h.dataset.drag, id: h.dataset.id };
        ev.dataTransfer.setData("text/plain", JSON.stringify(payload));
        ev.dataTransfer.effectAllowed = "move";
      };
    });

    view.querySelectorAll("tr[data-drop]").forEach(row=>{
      row.ondragover = (ev)=>{ ev.preventDefault(); row.classList.add("dropHintRow"); };
      row.ondragleave = ()=>row.classList.remove("dropHintRow");
      row.ondrop = (ev)=>{
        ev.preventDefault();
        row.classList.remove("dropHintRow");
        let payload=null;
        try{ payload = JSON.parse(ev.dataTransfer.getData("text/plain")||""); }catch{}
        if(!payload?.id || !payload?.kind) return;

        if(payload.kind==="exp-item"){
          const targetType = row.dataset.drop;
          const targetId = row.dataset.id || "";
          const beforeId = (targetType==="exp-item") ? targetId : "";
          let destGroupId = "";

          if(targetType==="exp-cat") destGroupId = targetId;
          if(targetType==="exp-uncat") destGroupId = "";
          if(targetType==="exp-item"){
            const tgt = state.db.expenses.find(x=>x.id===targetId && x.deleted!==true && !isCatRow(x));
            if(tgt) destGroupId = effGroup(tgt);
          }

          moveExpenseItem(payload.id, destGroupId, beforeId);
          setDirty(true);
          route({preserveFocus:false});
        }

        if(payload.kind==="exp-cat" && row.dataset.drop==="exp-cat"){
          reorderExpenseCat(payload.id, row.dataset.id);
          setDirty(true);
          route({preserveFocus:false});
        }
      };
    });
  }

  function groupItems(gid){
    const catsNow = Object.fromEntries(visible(state.db.expenses).filter(isCatRow).map(c=>[c.id,c]));
    const eff = (it)=> (it.groupId && catsNow[it.groupId]) ? it.groupId : "";
    return visible(state.db.expenses)
      .filter(r=>!isCatRow(r) && eff(r)===gid)
      .sort(sortByOrder);
  }

  function moveExpenseItem(itemId, destGroupId, beforeId){
    const it = state.db.expenses.find(x=>x.id===itemId && x.deleted!==true && !isCatRow(x));
    if(!it) return;

    const catsNow = Object.fromEntries(visible(state.db.expenses).filter(isCatRow).map(c=>[c.id,c]));
    const eff = (r)=> (r.groupId && catsNow[r.groupId]) ? r.groupId : "";
    const srcGroup = eff(it);
    const dest = (destGroupId && catsNow[destGroupId]) ? destGroupId : "";

    if(srcGroup !== dest){
      const src = groupItems(srcGroup).filter(x=>x.id!==it.id);
      renumberOrders(src);
    }

    it.groupId = dest;

    let destArr = groupItems(dest).filter(x=>x.id!==it.id);
    const idx = beforeId ? destArr.findIndex(x=>x.id===beforeId) : -1;
    if(idx<0) destArr.push(it);
    else destArr.splice(idx,0,it);
    renumberOrders(destArr);
  }

  function reorderExpenseCat(movingId, targetId){
    if(movingId===targetId) return;
    const catsNow = visible(state.db.expenses).filter(isCatRow).sort(sortByOrder);
    const moving = catsNow.find(c=>c.id===movingId);
    const target = catsNow.find(c=>c.id===targetId);
    if(!moving || !target) return;

    const arr = catsNow.filter(c=>c.id!==movingId);
    const idx = arr.findIndex(c=>c.id===targetId);
    if(idx<0) arr.push(moving);
    else arr.splice(idx,0,moving);
    renumberOrders(arr);
  }

  function openExpenseCatDialog(rec){
    const isEdit=!!rec;
    openDialog(isEdit?"Editar categoría":"Nueva categoría", `
      <div class="grid2">
        <div><label>Nombre</label><input id="d_name" value="${escapeHtml(rec?.name||"")}" placeholder="Ej: Rodaje / Post / Arte…"/></div>
        <div class="small">Arrastrá la categoría para cambiar su orden.</div>
      </div>
    `, ()=>{
      const name = $("#d_name").value.trim();
      if(!name) throw new Error("Poné un nombre.");
      if(isEdit){
        rec.name = name;
        rec.updatedAt = nowISO();
      }else{
        const max = visible(state.db.expenses).filter(isCatRow).reduce((m,c)=>Math.max(m, Number(c.order||0)), 0);
        state.db.expenses.push({
          id: uid("ec"),
          kind:"cat",
          name,
          order: (max||0)+1000,
          collapsed:false,
          updatedAt: nowISO(),
          deleted:false
        });
      }
      setDirty(true);
      route({preserveFocus:false});
    });
  }

  function openExpenseDialog(rec){
    const isEdit=!!rec;
    const vendorOpt = vendors.map(v=>`<option value="${v.id}" ${rec?.vendorId===v.id?"selected":""}>${escapeHtml(v.name)}</option>`).join("");
    const deptOpt = departments.map(d=>`<option ${rec?.department===d?"selected":""}>${escapeHtml(d)}</option>`).join("");
    const catsNow = visible(state.db.expenses).filter(isCatRow).sort(sortByOrder);
    const groupOpt = [`<option value="">Sin categoría</option>`, ...catsNow.map(c=>`<option value="${c.id}" ${rec?.groupId===c.id?"selected":""}>${escapeHtml(c.name||"Categoría")}</option>`)].join("");

    const existingPays = rec ? paymentLinesForExpense(rec.id) : [];
    const paidSum = rec ? sumPaid(rec.id) : 0;
    const rem = rec ? remainingForExpense(rec) : 0;

    openDialog(isEdit?"Editar gasto":"Nuevo gasto", `
      <div class="grid3">
        <div><label>Categoría</label><select id="d_group">${groupOpt}</select></div>
        <div><label>Fecha</label><input id="d_date" type="date" value="${escapeHtml(rec?.date||todayISO())}"/></div>
        <div><label>Proveedor *</label><select id="d_vendor"><option value="">—</option>${vendorOpt}</select></div>
      </div>

      <div class="grid3">
        <div><label>Depto</label><select id="d_department">${deptOpt}</select></div>
        <div><label>Concepto</label><input id="d_concept" value="${escapeHtml(rec?.concept||"")}" /></div>
        <div><label>Total ($)</label><input id="d_amount" type="number" step="0.01" value="${Number(rec?.amount||0)}"/></div>
      </div>

      <div class="grid2">
        <div><label>Fecha ejecución</label><input id="d_serviceDate" type="date" value="${escapeHtml(rec?.serviceDate||"")}"/></div>
        <div><label>Vencimiento pago</label><input id="d_dueDate" type="date" value="${escapeHtml(rec?.dueDate||"")}"/></div>
      </div>

      <div><label>Factura/Comprobante (link)</label><input id="d_invoiceUrl" value="${escapeHtml(rec?.invoiceUrl||"")}" placeholder="https://..."/></div>

      <div><label>Notas</label><textarea id="d_notes">${escapeHtml(rec?.notes||"")}</textarea></div>

      ${isEdit ? `
        <div class="card" style="margin-top:10px">
          <div class="row" style="justify-content:space-between">
            <div><strong>Pagos de este gasto</strong><div class="small">Pagado: $ ${money(paidSum)} · Saldo: $ ${money(rem)}</div></div>
            ${rem>0 ? `<button type="button" class="btn" id="btnPayInside">Registrar pago</button>` : ``}
          </div>
          ${existingPays.length ? `
            <table>
              <thead><tr><th>Fecha</th><th>Método</th><th>Monto</th><th>Comprobante</th><th class="actionsCell"></th></tr></thead>
              <tbody>
                ${existingPays.map(pl=>{
                  const link = pl.receiptUrl ? `<a href="${pl.receiptUrl}" target="_blank" rel="noopener">Abrir</a>` : "—";
                  return `<tr>
                    <td>${formatDate(pl.paidAt)}</td>
                    <td>${escapeHtml(pl.method||"—")}</td>
                    <td>$ ${money(pl.amount||0)}</td>
                    <td>${link}</td>
                    <td class="actionsCell">
                      <div class="actions">
                        <button class="iconbtn accent" title="Editar" data-editpl="${pl.id}">${ICON.edit}</button>
                        <button class="iconbtn danger" title="Borrar" data-delpl="${pl.id}">${ICON.trash}</button>
                      </div>
                    </td>
                  </tr>`;
                }).join("")}
              </tbody>
            </table>
          ` : `<div class="small">No hay pagos todavía.</div>`}
        </div>
      ` : ``}
    `, ()=>{
      const vendorId = $("#d_vendor").value;
      if(!vendorId) throw new Error("En gastos reales el proveedor es obligatorio.");

      const payload = {
        groupId: $("#d_group").value || "",
        date: $("#d_date").value,
        vendorId,
        department: $("#d_department").value,
        concept: $("#d_concept").value.trim(),
        amount: Number($("#d_amount").value||0),
        serviceDate: $("#d_serviceDate").value,
        dueDate: $("#d_dueDate").value,
        invoiceUrl: $("#d_invoiceUrl").value.trim(),
        notes: $("#d_notes").value.trim()
      };

      if(isEdit){
        Object.assign(rec, payload);
        rec.updatedAt=nowISO();
      }else{
        const gid = payload.groupId || "";
        const max = visible(state.db.expenses)
          .filter(r=>!isCatRow(r) && (r.groupId||"")===gid)
          .reduce((m,r)=>Math.max(m, Number(r.order||0)), 0);
        state.db.expenses.push({ id: uid("e"), updatedAt: nowISO(), deleted:false, order:(max||0)+1000, ...payload });
      }

      setDirty(true);
      route({preserveFocus:false});
    });

    if(isEdit){
      const btnPayInside = $("#btnPayInside");
      if(btnPayInside) btnPayInside.onclick = ()=>openPayDialog(rec);

      dlgBody.querySelectorAll("[data-delpl]").forEach(btn=>{
        btn.onclick = ()=>{
          const pl = state.db.paymentLines.find(x=>x.id===btn.dataset.delpl);
          if(pl && confirmDelete("este pago")){
            pl.deleted=true; pl.updatedAt=nowISO();
            setDirty(true);
            route({preserveFocus:false});
          }
        };
      });

      dlgBody.querySelectorAll("[data-editpl]").forEach(btn=>{
        btn.onclick = ()=>{
          const pl = state.db.paymentLines.find(x=>x.id===btn.dataset.editpl);
          if(pl) openPaymentLineDialog(pl, rec);
        };
      });
    }
  }

  function openPayDialog(exp){
    const methods = ["Transferencia","Efectivo","Tarjeta","Cheque","Otro"];
    const methodOpt = methods.map(m=>`<option ${m===state.ui.lastPayMethod?"selected":""}>${m}</option>`).join("");

    openDialog("Registrar pago", `
      <div class="grid3">
        <div><label>Fecha</label><input id="p_date" type="date" value="${todayISO()}"/></div>
        <div><label>Método</label><select id="p_method">${methodOpt}</select></div>
        <div><label>Monto ($)</label><input id="p_amount" type="number" step="0.01" value="${Number(remainingForExpense(exp)||0)}"/></div>
      </div>
      <div class="grid2">
        <div><label>Comprobante (link)</label><input id="p_receiptUrl" placeholder="https://..." /></div>
        <div><label>Notas</label><input id="p_notes" /></div>
      </div>
    `, ()=>{
      const amount = Number($("#p_amount").value||0);
      if(amount<=0) throw new Error("Monto inválido.");
      const payload = {
        expenseId: exp.id,
        vendorId: exp.vendorId,
        paidAt: $("#p_date").value,
        method: $("#p_method").value,
        amount,
        receiptUrl: $("#p_receiptUrl").value.trim(),
        notes: $("#p_notes").value.trim()
      };
      state.ui.lastPayMethod = payload.method;

      state.db.paymentLines.push({ id: uid("pl"), updatedAt: nowISO(), deleted:false, ...payload });

      setDirty(true);
      route({preserveFocus:false});
    });
  }

  function openPaymentLineDialog(pl, exp){
    const isEdit=!!pl;
    const methods = ["Transferencia","Efectivo","Tarjeta","Cheque","Otro"];
    const methodOpt = methods.map(m=>`<option ${m===pl?.method?"selected":""}>${m}</option>`).join("");

    openDialog(isEdit?"Editar pago":"Nuevo pago", `
      <div class="grid3">
        <div><label>Fecha</label><input id="p_date" type="date" value="${escapeHtml(pl?.paidAt||todayISO())}"/></div>
        <div><label>Método</label><select id="p_method">${methodOpt}</select></div>
        <div><label>Monto ($)</label><input id="p_amount" type="number" step="0.01" value="${Number(pl?.amount||0)}"/></div>
      </div>
      <div class="grid2">
        <div><label>Comprobante (link)</label><input id="p_receiptUrl" value="${escapeHtml(pl?.receiptUrl||"")}" placeholder="https://..."/></div>
        <div><label>Notas</label><input id="p_notes" value="${escapeHtml(pl?.notes||"")}" /></div>
      </div>
    `, ()=>{
      const amount = Number($("#p_amount").value||0);
      if(amount<=0) throw new Error("Monto inválido.");

      const payload = {
        expenseId: exp.id,
        vendorId: exp.vendorId,
        paidAt: $("#p_date").value,
        method: $("#p_method").value,
        amount,
        receiptUrl: $("#p_receiptUrl").value.trim(),
        notes: $("#p_notes").value.trim()
      };

      Object.assign(pl, payload);
      pl.updatedAt=nowISO();

      setDirty(true);
      route({preserveFocus:false});
    });
  }
}

/* ---------------- Payments tab = pagos reales ---------------- */
function renderPayments(){
  const q = filters.payments || "";
  const vendorsById = Object.fromEntries(visible(state.db.vendors).map(v=>[v.id,v]));
  const expById = Object.fromEntries(visible(state.db.expenses).map(e=>[e.id,e]));

  const list = visible(state.db.paymentLines)
    .filter(pl => matchQuery(q, pl.paidAt, pl.method, String(pl.amount||0), vendorsById[pl.vendorId]?.name||"", expById[pl.expenseId]?.concept||""))
    .sort((a,b)=>(b.paidAt||"").localeCompare(a.paidAt||""));

  view.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div>
          <h2>Pagos</h2>
          <div class="small">Acá están los pagos reales (incluye parciales).</div>
        </div>
        <div class="row" style="min-width:420px;justify-content:flex-end">
          ${renderSearch("payments","Buscar proveedor / método / concepto…")}
        </div>
      </div>
    </div>

    <div class="card">
      <table>
        <thead><tr><th>Fecha</th><th>Proveedor</th><th>Método</th><th>Concepto</th><th>Monto</th><th>Comprobante</th><th class="actionsCell"></th></tr></thead>
        <tbody>
          ${list.map(pl=>{
            const vendorName = vendorsById[pl.vendorId]?.name || "—";
            const concept = expById[pl.expenseId]?.concept || "—";
            const link = pl.receiptUrl ? `<a href="${pl.receiptUrl}" target="_blank" rel="noopener">Abrir</a>` : "—";
            return `
              <tr>
                <td>${formatDate(pl.paidAt)}</td>
                <td>${escapeHtml(vendorName)}</td>
                <td>${escapeHtml(pl.method||"—")}</td>
                <td>${escapeHtml(concept)}</td>
                <td>$ ${money(pl.amount||0)}</td>
                <td>${link}</td>
                <td class="actionsCell">
                  <div class="actions">
                    <button class="iconbtn accent" title="Editar" data-edit="${pl.id}">${ICON.edit}</button>
                    <button class="iconbtn danger" title="Borrar" data-del="${pl.id}">${ICON.trash}</button>
                  </div>
                </td>
              </tr>`;
          }).join("")}
        </tbody>
      </table>
      ${list.length? "" : `<div class="small">No hay pagos (o tu búsqueda no encontró nada).</div>`}
    </div>
  `;

  attachSearch("payments");

  view.querySelectorAll("[data-del]").forEach(btn=>{
    btn.onclick = ()=>{
      const pl = state.db.paymentLines.find(x=>x.id===btn.dataset.del);
      if(pl && confirmDelete("este pago")){
        pl.deleted=true; pl.updatedAt=nowISO();
        setDirty(true);
        route({preserveFocus:false});
      }
    };
  });

  view.querySelectorAll("[data-edit]").forEach(btn=>{
    btn.onclick = ()=>{
      const pl = state.db.paymentLines.find(x=>x.id===btn.dataset.edit);
      if(pl) openPaymentLineDialog(pl);
    };
  });
}

function openPaymentLineDialog(pl){
  openDialog("Editar pago", `
    <div class="grid3">
      <div><label>Fecha pago</label><input id="d_paidAt" type="date" value="${escapeHtml(pl.paidAt||todayISO())}"/></div>
      <div><label>Método</label>
        <select id="d_method">
          ${["Transferencia","Efectivo","Cheque","Tarjeta","Otro"].map(m=>`<option ${pl.method===m?"selected":""}>${escapeHtml(m)}</option>`).join("")}
        </select>
      </div>
      <div><label>Monto</label><input id="d_amount" type="number" step="0.01" value="${Number(pl.amount||0)}"/></div>
    </div>
    <div class="grid2">
      <div><label>Comprobante (link)</label><input id="d_receiptUrl" value="${escapeHtml(pl.receiptUrl||"")}" placeholder="https://..."/></div>
      <div class="small">PDFs deshabilitados: usá link (Drive/Dropbox/etc.).</div>
    </div>
  `, ()=>{
    const exp = state.db.expenses.find(e=>e.id===pl.expenseId && e.deleted!==true && !isCatRow(e));
    if(!exp) throw new Error("Este pago está ligado a un gasto inexistente.");
    const alreadyPaidOther = sumPaid(exp.id) - Number(pl.amount||0);
    const newAmt = Number($("#d_amount").value||0);
    const max = Math.max(0, Number(exp.amount||0) - alreadyPaidOther);
    if(newAmt<=0) throw new Error("Monto inválido.");
    if(newAmt > max + 0.0001) throw new Error("Monto supera el saldo del gasto.");

    pl.paidAt = $("#d_paidAt").value;
    pl.method = $("#d_method").value;
    pl.amount = newAmt;
    pl.receiptUrl = $("#d_receiptUrl").value.trim();
    if("receiptDataUrl" in pl) delete pl.receiptDataUrl;
    pl.updatedAt = nowISO();

    setDirty(true);
    route({preserveFocus:false});
  });
}

/* ---------------- Calendario real (mes/semana/día) + drag&drop ---------------- */
function renderCalendar(){
  const q = filters.calendar || "";
  const vendorsById = Object.fromEntries(visible(state.db.vendors).map(v=>[v.id,v]));
  const mode = state.ui.calendarMode;
  const cursor = state.ui.calendarCursor;
  const selected = state.ui.calendarSelected;

  view.innerHTML = `
    <div class="card">
      <div class="calendar-toolbar">
        <div>
          <h2>Calendario</h2>
          <div class="small">Arrastrá un pago a otro día para mover su vencimiento.</div>
        </div>

        <div class="cal-controls">
          <button class="btn" id="prev">←</button>
          <div class="cal-title" id="calTitle"></div>
          <button class="btn" id="next">→</button>

          <button class="btn" id="mMonth">Mes</button>
          <button class="btn" id="mWeek">Semana</button>
          <button class="btn" id="mDay">Día</button>

          ${renderSearch("calendar","Buscar proveedor / concepto…")}
        </div>
      </div>
    </div>

    <div class="card" id="calBody"></div>
  `;

  attachSearch("calendar");

  $("#mMonth").onclick = ()=>{ state.ui.calendarMode="month"; route({preserveFocus:false}); };
  $("#mWeek").onclick  = ()=>{ state.ui.calendarMode="week";  route({preserveFocus:false}); };
  $("#mDay").onclick   = ()=>{ state.ui.calendarMode="day";   route({preserveFocus:false}); };

  $("#prev").onclick = ()=>shiftCalendar(-1);
  $("#next").onclick = ()=>shiftCalendar(+1);

  function shiftCalendar(dir){
    const d = parseISO(cursor) || new Date();
    if(mode==="month"){
      d.setMonth(d.getMonth()+dir);
      state.ui.calendarCursor = d.toISOString().slice(0,10);
    }else if(mode==="week"){
      state.ui.calendarCursor = plusDaysISO(cursor, dir*7);
    }else{
      state.ui.calendarCursor = plusDaysISO(cursor, dir*1);
      state.ui.calendarSelected = state.ui.calendarCursor;
    }
    route({preserveFocus:false});
  }

  const titleEl = $("#calTitle");
  const calBody = $("#calBody");

  if(mode==="month"){
    const d = parseISO(cursor) || new Date();
    titleEl.textContent = d.toLocaleString("es-AR",{ month:"long", year:"numeric" }).toUpperCase();
    calBody.innerHTML = renderMonthGrid(d.getFullYear(), d.getMonth());
    attachCalendarDnD();
  }else if(mode==="week"){
    const start = startOfWeekISO(cursor);
    const end = plusDaysISO(start, 6);
    titleEl.textContent = `SEMANA ${formatDate(start)} → ${formatDate(end)}`;
    calBody.innerHTML = renderSpanGrid(start, 7);
    attachCalendarDnD();
  }else{
    titleEl.textContent = `DÍA ${formatDate(state.ui.calendarCursor)}`;
    calBody.innerHTML = renderSpanGrid(state.ui.calendarCursor, 1);
    attachCalendarDnD();
  }

  function renderMonthGrid(year, monthIndex){
    const first = new Date(year, monthIndex, 1);
    const start = startOfWeekISO(first.toISOString().slice(0,10));
    const days = 42; // 6 semanas
    return renderSpanGrid(start, days, { monthIndex, year });
  }

  function renderSpanGrid(startISO, daysCount, monthCtx=null){
    const qtxt = (filters.calendar||"").trim().toLowerCase();

    const dows = ["Lun","Mar","Mié","Jue","Vie","Sáb","Dom"].map(x=>`<div class="cal-dow">${x}</div>`).join("");
    const cells = [];

    for(let i=0;i<daysCount;i++){
      const dateISO = plusDaysISO(startISO, i);
      const d = parseISO(dateISO);
      const out = monthCtx ? (d.getMonth()!==monthCtx.monthIndex || d.getFullYear()!==monthCtx.year) : false;

      const dueExpenses = expenseItems()
        .filter(e=>e.dueDate===dateISO)
        .map(e=>{
          const st = expenseStatus(e);
          const rem = remainingForExpense(e);
          return { e, st, rem };
        })
        .filter(x=>x.st!=="paid" && x.rem>0)
        .filter(x=>{
          if(!qtxt) return true;
          const vendor = vendorsById[x.e.vendorId]?.name || "";
          return `${x.e.concept||""} ${vendor} ${x.e.department||""}`.toLowerCase().includes(qtxt);
        })
        .sort((a,b)=>(deptIndex(a.e.department)-deptIndex(b.e.department)) || (a.e.concept||"").localeCompare(b.e.concept||""));

      const chips = dueExpenses.slice(0,5).map(x=>{
        const vendor = vendorsById[x.e.vendorId]?.name || "—";
        const cls = x.st==="partial" ? "partial" : (x.e.dueDate < todayISO() ? "over" : "");
        return `
          <div class="paychip ${cls}" draggable="true" data-exp="${x.e.id}">
            <div class="t">${escapeHtml(vendor)} · $ ${money(x.rem)}</div>
            <div class="s">${escapeHtml(x.e.concept||"—")}</div>
          </div>`;
      }).join("");

      const more = dueExpenses.length>5 ? `<div class="small">+${dueExpenses.length-5} más</div>` : "";

      cells.push(`
        <div class="daycell ${out?"out":""}" data-date="${dateISO}">
          <div class="daynum">${d.getDate()}</div>
          ${chips}${more}
        </div>
      `);
    }

    // Si es grilla mensual/semanal: mostramos headers de días
    const header = (daysCount===1) ? "" : `<div class="cal-grid" style="grid-template-columns:repeat(7,1fr)">${dows}</div>`;
    const gridCols = (daysCount===1) ? 1 : 7;
    return `
      ${header}
      <div class="cal-grid" style="grid-template-columns:repeat(${gridCols},1fr)">
        ${cells.join("")}
      </div>
    `;
  }

  function startOfWeekISO(iso){
    // lunes como inicio
    const d = parseISO(iso) || new Date();
    const day = d.getDay(); // 0 dom..6 sáb
    const diff = (day===0 ? -6 : 1-day);
    d.setDate(d.getDate()+diff);
    return d.toISOString().slice(0,10);
  }

  function attachCalendarDnD(){
    view.querySelectorAll(".paychip").forEach(chip=>{
      chip.ondragstart = (ev)=>{
        ev.dataTransfer.setData("text/plain", chip.dataset.exp);
      };
    });

    view.querySelectorAll(".daycell").forEach(cell=>{
      cell.ondragover = (ev)=>{ ev.preventDefault(); cell.classList.add("dropHint"); };
      cell.ondragleave = ()=>cell.classList.remove("dropHint");
      cell.ondrop = (ev)=>{
        ev.preventDefault();
        cell.classList.remove("dropHint");
        const expId = ev.dataTransfer.getData("text/plain");
        const dateISO = cell.dataset.date;
        const exp = state.db.expenses.find(e=>e.id===expId && e.deleted!==true);
        if(!exp) return;

        exp.dueDate = dateISO;
        exp.updatedAt = nowISO();
        setDirty(true);
        route({preserveFocus:false});
      };

      cell.onclick = ()=>{
        state.ui.calendarSelected = cell.dataset.date;
        state.ui.calendarCursor = cell.dataset.date;
        if(state.ui.calendarMode==="month") state.ui.calendarMode="day";
        route({preserveFocus:false});
      };
    });
  }
}

/* ---------------- Vendors ---------------- */
function renderVendors(){
  const q = filters.vendors || "";
  const list = visible(state.db.vendors).filter(v=>matchQuery(q, v.name, v.cuit, v.contact, v.email, v.phone));

  view.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div><h2>Proveedores</h2><div class="small">Editable + buscador.</div></div>
        <div class="row" style="min-width:420px;justify-content:flex-end">
          ${renderSearch("vendors","Buscar nombre / CUIT…")}
          <button class="btn" id="btnAdd">+ Proveedor</button>
        </div>
      </div>
    </div>

    <div class="card">
      <table>
        <thead><tr><th>Nombre</th><th>Contacto</th><th>CUIT</th><th>Email</th><th>Tel</th><th class="actionsCell"></th></tr></thead>
        <tbody>
          ${list.map(v=>`
            <tr>
              <td>${escapeHtml(v.name||"—")}</td>
              <td>${escapeHtml(v.contact||"—")}</td>
              <td>${escapeHtml(v.cuit||"—")}</td>
              <td>${escapeHtml(v.email||"—")}</td>
              <td>${escapeHtml(v.phone||"—")}</td>
              <td class="actionsCell">
                <div class="actions">
                  <button class="iconbtn accent" title="Editar" data-edit="${v.id}">${ICON.edit}</button>
                  <button class="iconbtn danger" title="Borrar" data-del="${v.id}">${ICON.trash}</button>
                </div>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      ${list.length? "" : `<div class="small">No hay proveedores (o tu búsqueda no encontró nada).</div>`}
    </div>
  `;

  attachSearch("vendors");

  $("#btnAdd").onclick = ()=>openVendorDialog(null);

  view.querySelectorAll("[data-del]").forEach(btn=>{
    btn.onclick = ()=>{
      const rec = state.db.vendors.find(x=>x.id===btn.dataset.del);
      if(rec && confirmDelete("este proveedor")){
        rec.deleted=true; rec.updatedAt=nowISO();
        setDirty(true);
        route({preserveFocus:false});
      }
    };
  });

  view.querySelectorAll("[data-edit]").forEach(btn=>{
    btn.onclick = ()=>{
      const rec = state.db.vendors.find(x=>x.id===btn.dataset.edit);
      if(rec) openVendorDialog(rec);
    };
  });

  function openVendorDialog(rec){
    const isEdit=!!rec;
    openDialog(isEdit?"Editar proveedor":"Nuevo proveedor", `
      <div class="grid2">
        <div><label>Nombre</label><input id="d_name" value="${escapeHtml(rec?.name||"")}" /></div>
        <div><label>Contacto</label><input id="d_contact" value="${escapeHtml(rec?.contact||"")}" /></div>
      </div>
      <div class="grid3">
        <div><label>CUIT</label><input id="d_cuit" value="${escapeHtml(rec?.cuit||"")}" /></div>
        <div><label>Email</label><input id="d_email" value="${escapeHtml(rec?.email||"")}" /></div>
        <div><label>Tel</label><input id="d_phone" value="${escapeHtml(rec?.phone||"")}" /></div>
      </div>
    `, ()=>{
      const payload = {
        name: $("#d_name").value.trim(),
        contact: $("#d_contact").value.trim(),
        cuit: $("#d_cuit").value.trim(),
        email: $("#d_email").value.trim(),
        phone: $("#d_phone").value.trim()
      };
      if(isEdit){
        Object.assign(rec, payload);
        rec.updatedAt=nowISO();
      }else{
        state.db.vendors.push({ id: uid("v"), updatedAt: nowISO(), deleted:false, ...payload });
      }
      setDirty(true);
      route({preserveFocus:false});
    });
  }
}

/* ---------------- Balances (saldos) ---------------- */
function renderBalances(){
  const q = filters.balances || "";
  const vendors = visible(state.db.vendors);
  const expenses = expenseItems();

  const rows = vendors.map(v=>{
    const vendExpenses = expenses.filter(e=>e.vendorId===v.id);
    const spent = vendExpenses.reduce((s,e)=>s+Number(e.amount||0),0);

    let pending=0, overdueCount=0, nextDue="";
    const today = todayISO();

    for(const e of vendExpenses){
      const rem = remainingForExpense(e);
      if(rem>0){
        pending += rem;
        if(e.dueDate && e.dueDate < today) overdueCount++;
        if(e.dueDate){
          if(!nextDue || e.dueDate < nextDue) nextDue = e.dueDate;
        }
      }
    }

    const paid = paymentSumForVendor(v.id);
    return { v, spent, paid, pending, overdueCount, nextDue };
  }).filter(r=>matchQuery(q, r.v.name, r.v.cuit, r.v.contact))
    .sort((a,b)=>(b.pending-a.pending) || (a.v.name||"").localeCompare(b.v.name||""));

  view.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div><h2>Saldos de proveedores</h2><div class="small">Pendiente = suma de saldos de gastos.</div></div>
        <div class="row" style="min-width:420px;justify-content:flex-end">
          ${renderSearch("balances","Buscar proveedor / CUIT…")}
        </div>
      </div>
    </div>

    <div class="card">
      <table>
        <thead><tr><th>Proveedor</th><th>Gastado</th><th>Pagado</th><th>Pendiente</th><th>Vencidos</th><th>Próx. venc.</th></tr></thead>
        <tbody>
          ${rows.map(r=>{
            const badge = r.pending>0 ? (r.overdueCount>0?"over":"due") : "paid";
            return `<tr>
              <td>${escapeHtml(r.v.name||"—")}</td>
              <td>$ ${money(r.spent)}</td>
              <td>$ ${money(r.paid)}</td>
              <td><span class="badge ${badge}">$ ${money(r.pending)}</span></td>
              <td>${r.overdueCount}</td>
              <td>${r.nextDue ? formatDate(r.nextDue) : "—"}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;

  attachSearch("balances");

  function paymentSumForVendor(vendorId){
    return visible(state.db.paymentLines).filter(pl=>pl.vendorId===vendorId).reduce((s,x)=>s+Number(x.amount||0),0);
  }
}

/* ---------------- Docs ---------------- */
function renderDocs(){
  const q = filters.docs || "";
  const docs = visible(state.db.documents)
    .filter(d=>matchQuery(q, d.date, d.type, d.name, d.url))
    .sort((a,b)=>(b.date||"").localeCompare(a.date||""));

  view.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div><h2>Comprobantes</h2><div class="small">Docs generales (contratos, etc.).</div></div>
        <div class="row" style="min-width:420px;justify-content:flex-end">
          ${renderSearch("docs","Buscar nombre / tipo…")}
          <button class="btn" id="btnAdd">+ Documento</button>
        </div>
      </div>
    </div>

    <div class="card">
      <table>
        <thead><tr><th>Fecha</th><th>Tipo</th><th>Nombre</th><th>Link</th><th class="actionsCell"></th></tr></thead>
        <tbody>
          ${docs.map(d=>`
            <tr>
              <td>${formatDate(d.date)}</td>
              <td>${escapeHtml(d.type||"—")}</td>
              <td>${escapeHtml(d.name||"—")}</td>
              <td>${d.url ? `<a href="${d.url}" target="_blank" rel="noopener">Abrir</a>` : "—"}</td>
              <td class="actionsCell">
                <div class="actions">
                  <button class="iconbtn accent" title="Editar" data-edit="${d.id}">${ICON.edit}</button>
                  <button class="iconbtn danger" title="Borrar" data-del="${d.id}">${ICON.trash}</button>
                </div>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      ${docs.length? "" : `<div class="small">No hay documentos (o tu búsqueda no encontró nada).</div>`}
    </div>
  `;

  attachSearch("docs");
  $("#btnAdd").onclick = ()=>openDocDialog(null);

  view.querySelectorAll("[data-del]").forEach(btn=>{
    btn.onclick = ()=>{
      const rec = state.db.documents.find(x=>x.id===btn.dataset.del);
      if(rec && confirmDelete("este documento")){
        rec.deleted=true; rec.updatedAt=nowISO();
        setDirty(true);
        route({preserveFocus:false});
      }
    };
  });

  view.querySelectorAll("[data-edit]").forEach(btn=>{
    btn.onclick = ()=>{
      const rec = state.db.documents.find(x=>x.id===btn.dataset.edit);
      if(rec) openDocDialog(rec);
    };
  });

  function openDocDialog(rec){
    const isEdit=!!rec;
    openDialog(isEdit?"Editar documento":"Nuevo documento", `
      <div class="grid3">
        <div><label>Fecha</label><input id="d_date" type="date" value="${escapeHtml(rec?.date||todayISO())}"/></div>
        <div><label>Tipo</label>
          <select id="d_type">
            ${["Factura","Recibo","Contrato","Remito","Otro"].map(t=>`<option ${rec?.type===t?"selected":""}>${escapeHtml(t)}</option>`).join("")}
          </select>
        </div>
        <div><label>URL</label><input id="d_url" value="${escapeHtml(rec?.url||"")}" placeholder="https://..."/></div>
      </div>
      <div><label>Nombre</label><input id="d_name" value="${escapeHtml(rec?.name||"")}" /></div>
    `, ()=>{
      const payload = { date: $("#d_date").value, type: $("#d_type").value, url: $("#d_url").value.trim(), name: $("#d_name").value.trim() };
      if(isEdit){
        Object.assign(rec, payload); rec.updatedAt=nowISO();
      }else{
        state.db.documents.push({ id: uid("d"), updatedAt: nowISO(), deleted:false, ...payload });
      }
      setDirty(true);
      route({preserveFocus:false});
    });
  }
}

/* ---------------- Config ---------------- */
function renderConfig(){
  view.innerHTML = `
    <div class="card">
      <h2>Config</h2>
      <div class="small">BIN precargado. Esto vive en el navegador (no en el bin).</div>

      <div class="grid2" style="margin-top:10px">
        <div><label>BIN_ID</label><input id="c_bin" value="${escapeHtml(state.config.binId||"")}" /></div>
        <div><label>Access Key</label><input id="c_access" value="${escapeHtml(state.config.accessKey||"")}" /></div>
      </div>

      <div class="grid2" style="margin-top:10px">
        <div><label>Master Key (opcional)</label><input id="c_master" value="${escapeHtml(state.config.masterKey||"")}" /></div>
        <div class="small">Auto-sync: pull ${AUTO_PULL_INTERVAL_MS/1000}s · push debounce ${AUTO_PUSH_DEBOUNCE_MS/1000}s</div>
      </div>

      <div class="row" style="margin-top:12px">
        <button class="btn primary" id="btnCfgSave">Guardar config</button>
        <button class="btn" id="btnCfgReload">Recargar desde JSONBin</button>
      </div>
    </div>
  `;
  $("#btnCfgSave").onclick = ()=>{
    saveConfig({ binId: $("#c_bin").value.trim(), accessKey: $("#c_access").value.trim(), masterKey: $("#c_master").value.trim() });
    alert("Config guardada ✅");
  };
  $("#btnCfgReload").onclick = async ()=>{
    await boot(true);
    alert("Recargado ✅");
  };
}

/* ---------------- Wire up buttons ---------------- */
$("#btnSync").onclick = async ()=>boot(true);
$("#btnSave").onclick = async ()=>{
  if(state.pushTimer) clearTimeout(state.pushTimer);
  await autoPush();
};

/* ---------------- Start ---------------- */
route({preserveFocus:false});
boot(false);
