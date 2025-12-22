/* LA CASONA - Admin. (GH Pages + JSONBin autosync)
   Cambios:
   - Fechas display dd/mm/aa
   - Presupuesto ordenado por Depto según catálogo
   - Confirmación al borrar (todas)
   - Plan con $
   - Tachito rojo + lápiz editar (acciones a la derecha)
   - Gastos reales incluye: fecha ejecución + vencimiento + estado pago + método + comprobante
   - Pagos muestra SOLO pagados (y se editan)
   - Buscador en todas las pestañas con data
   - Config real
   - Calendario (vencimientos) + Saldos por proveedor
   - Dashboard con Resumen y Plan vs Real por Depto + próximos a vencer (<=4 días) y vencidos
*/

const DEFAULT_BIN_ID = "6949ab15d0ea881f403a5807";
const DEFAULT_ACCESS_KEY = "$2a$10$nzjX1kWtm5vCMZj8qtlSoeP/kUp77ZWnpFE6kWIcnBqe1fDL1lkDi";

const AUTO_PULL_INTERVAL_MS = 6000;
const AUTO_PUSH_DEBOUNCE_MS = 1200;
const DUE_SOON_DAYS = 4;
const MAX_INLINE_PDF_BYTES = 350 * 1024;

const $ = (sel) => document.querySelector(sel);
const view = $("#view");
const dlg = $("#dlg");
const dlgTitle = $("#dlgTitle");
const dlgBody = $("#dlgBody");
const dlgOk = $("#dlgOk");

const LS_KEY = "lacasona_admin_config_v1";
const LS_DEVICE = "lacasona_admin_deviceId_v1";

const filters = {
  budget: "",
  expenses: "",
  vendors: "",
  calendar: "",
  payments: "",
  balances: "",
  docs: ""
};

const state = {
  config: loadConfig(),
  db: null,
  dirty: false,
  pushing: false,
  pullTimer: null,
  pushTimer: null
};

/* ---------------- Basics ---------------- */

function setStatus(s){
  const el = $("#syncStatus");
  if(el) el.textContent = s || "";
}

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
    return {
      binId: raw?.binId || DEFAULT_BIN_ID,
      accessKey: raw?.accessKey || DEFAULT_ACCESS_KEY,
      masterKey: raw?.masterKey || ""
    };
  }catch{
    return { binId: DEFAULT_BIN_ID, accessKey: DEFAULT_ACCESS_KEY, masterKey:"" };
  }
}

function saveConfig(cfg){
  localStorage.setItem(LS_KEY, JSON.stringify(cfg));
  state.config = cfg;
}

function uid(prefix="id"){
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`;
}
function nowISO(){ return new Date().toISOString(); }
function todayISO(){ return new Date().toISOString().slice(0,10); }

function money(n){
  const x = Number(n||0);
  return x.toLocaleString("es-AR", { maximumFractionDigits: 2 });
}

function escapeHtml(s){
  return String(s||"")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;");
}

function parseISO(dateStr){
  if(!dateStr) return null;
  const t = Date.parse(dateStr);
  return Number.isFinite(t) ? new Date(t) : null;
}

function formatDate(dateStr){
  // display dd/mm/aa
  if(!dateStr) return "—";
  const d = parseISO(dateStr);
  if(!d) return "—";
  const dd = String(d.getDate()).padStart(2,"0");
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

function daysBetween(dateStr){
  if(!dateStr) return null;
  const a = parseISO(dateStr);
  if(!a) return null;
  const ms = Date.now() - a.getTime();
  return Math.floor(ms / (1000*60*60*24));
}

function plusDaysISO(iso, days){
  const d = parseISO(iso);
  if(!d) return "";
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0,10);
}

function confirmDelete(label="este ítem"){
  return window.confirm(`¿Borrar ${label}? Esta acción no se puede deshacer.`);
}

/* Icons */
const ICON = {
  trash: "🗑️",
  edit: "✏️",
  pay: "💸"
};

/* ---------------- Data normalization ---------------- */

function tstamp(s){ return s ? (Date.parse(s) || 0) : 0; }

function ensureMeta(db){
  db._meta = db._meta || {};
  if(!db._meta.deviceId) db._meta.deviceId = getDeviceId();
  if(typeof db._meta.revision !== "number") db._meta.revision = 0;
  if(!db._meta.updatedAt) db._meta.updatedAt = "";
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
    if(!r || typeof r !== "object") return r;
    if(!r.id) return r;
    if(!r.updatedAt) r.updatedAt = nowISO();
    if(typeof r.deleted !== "boolean") r.deleted = false;
    return r;
  });
}

function normalizeDb(db){
  ensureMeta(db);
  db.schemaVersion = db.schemaVersion || 1;

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

  db.vendors   = normalizeCollection(db.vendors);
  db.budget    = normalizeCollection(db.budget);
  db.expenses  = normalizeCollection(db.expenses);
  db.payments  = normalizeCollection(db.payments);
  db.documents = normalizeCollection(db.documents);
  db.audit     = Array.isArray(db.audit) ? db.audit : [];

  return db;
}

function visible(arr){ return (arr||[]).filter(x=>x && x.deleted !== true); }

function deptIndex(dept){
  const list = state.db?.catalog?.departments || [];
  const i = list.indexOf(dept);
  return i === -1 ? 999 : i;
}

/* ---------------- JSONBin ---------------- */

async function jsonbinFetch(method, path, body){
  const binId = state.config.binId?.trim();
  if(!binId) throw new Error("Falta BIN_ID.");

  const url = `https://api.jsonbin.io/v3${path}`;
  const headers = { "Content-Type": "application/json" };
  if(state.config.accessKey) headers["X-Access-Key"] = state.config.accessKey;
  if(state.config.masterKey) headers["X-Master-Key"] = state.config.masterKey;

  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try{ json = text ? JSON.parse(text) : null; }catch{}

  if(!res.ok){
    const msg = json?.message || json?.error || text || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

async function pullLatest(){
  const binId = state.config.binId.trim();
  return await jsonbinFetch("GET", `/b/${binId}/latest?meta=false`, null);
}
async function pushLatest(db){
  const binId = state.config.binId.trim();
  return await jsonbinFetch("PUT", `/b/${binId}`, db);
}

/* ---------------- Merge ---------------- */

function mergeCollection(localArr, remoteArr){
  const map = new Map();
  const ingest = (rec) => {
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

    vendors:   mergeCollection(L.vendors,   R.vendors),
    budget:    mergeCollection(L.budget,    R.budget),
    expenses:  mergeCollection(L.expenses,  R.expenses),
    payments:  mergeCollection(L.payments,  R.payments),
    documents: mergeCollection(L.documents, R.documents),

    audit: [...(L.audit||[]), ...(R.audit||[])]
  });

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
  state.pushTimer = setTimeout(() => autoPush().catch(()=>{}), AUTO_PUSH_DEBOUNCE_MS);
  setStatus("Cambios…");
}

async function autoPush(){
  if(!state.db || state.pushing) return;
  state.pushing = true;

  try{
    setStatus("Guardando…");

    let remote = null;
    try{ remote = await pullLatest(); }catch{}

    if(remote) state.db = mergeDb(state.db, remote);

    bumpMeta(state.db);
    state.db.audit.unshift({ at: nowISO(), what:"autosave", by:getDeviceId() });

    await pushLatest(state.db);

    setDirty(false);
    setStatus("Sincronizado");
  }catch(e){
    setStatus(`Error: ${String(e.message||e).slice(0,80)}… (guardado local)`);
    console.warn(e);
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
        route();
        setStatus("Sincronizado");
        return;
      }

      const rStamp = remote?._meta?.updatedAt || "";
      const lStamp = state.db?._meta?.updatedAt || "";

      if(rStamp && rStamp === lStamp) return;

      if(!state.dirty){
        state.db = normalizeDb(remote);
        setDirty(false);
        route();
        setStatus("Actualizado");
        return;
      }

      state.db = mergeDb(state.db, remote);
      setDirty(true);
      route();
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
      setDirty(false);
    }
    setStatus("Sincronizado");
  }catch{
    setStatus("Offline (usando local)");
  }finally{
    startAutoPull();
    route();
  }
}

/* ---------------- Shared UI helpers ---------------- */

function openDialog(title, bodyHtml, onOk){
  dlgTitle.textContent = title;
  dlgBody.innerHTML = bodyHtml;
  dlgOk.onclick = async (ev) => {
    ev.preventDefault();
    try{ await onOk(); dlg.close(); }
    catch(e){ alert(e.message || e); }
  };
  dlg.showModal();
}

function renderSearch(routeKey, placeholder="Buscar…"){
  return `
    <input class="search" id="q" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(filters[routeKey]||"")}" />
  `;
}

function attachSearch(routeKey){
  const input = $("#q");
  if(!input) return;
  input.oninput = () => {
    filters[routeKey] = input.value;
    route();
  };
}

function matchQuery(q, ...fields){
  q = (q||"").trim().toLowerCase();
  if(!q) return true;
  const hay = fields.join(" ").toLowerCase();
  return hay.includes(q);
}

/* ---------------- Routes ---------------- */

function ensureDb(){
  if(state.db) return true;
  view.innerHTML = `
    <div class="card">
      <h2>Sin datos todavía</h2>
      <p class="small">Estoy intentando cargar desde JSONBin.</p>
      <div class="row">
        <button class="btn" id="retry">Reintentar</button>
      </div>
    </div>`;
  $("#retry").onclick = () => boot(true);
  return false;
}

function route(){
  const hash = location.hash || "#/dashboard";
  const r = hash.replace("#/","").split("?")[0];

  document.querySelectorAll(".sidebar a").forEach(a=>{
    a.classList.toggle("active", a.dataset.route === r);
  });

  if(r === "config") return renderConfig();
  if(!ensureDb()) return;

  if(r === "dashboard") return renderDashboard();
  if(r === "budget") return renderBudget();
  if(r === "expenses") return renderExpenses();
  if(r === "vendors") return renderVendors();
  if(r === "calendar") return renderCalendar();
  if(r === "payments") return renderPayments();
  if(r === "balances") return renderBalances();
  if(r === "docs") return renderDocs();

  return renderDashboard();
}

/* ---------------- Data linkage (expense -> payment) ---------------- */

function findPaymentByExpenseId(expenseId){
  return state.db.payments.find(p => p.expenseId === expenseId && p.deleted !== true);
}

function upsertPaymentFromExpense(exp){
  // Crea/actualiza un pago ligado al gasto (obligación)
  let pay = findPaymentByExpenseId(exp.id);
  if(!pay){
    pay = {
      id: uid("p"),
      expenseId: exp.id,
      deleted: false
    };
    state.db.payments.push(pay);
  }

  pay.vendorId = exp.vendorId || "";
  pay.amount = Number(exp.amount||0);
  pay.concept = exp.concept || "";
  pay.serviceDate = exp.serviceDate || exp.date || "";
  pay.dueDate = exp.dueDate || "";
  pay.status = exp.payStatus || "pending"; // pending/paid
  pay.paidAt = exp.paidAt || "";
  pay.method = exp.payMethod || "";
  pay.receiptUrl = exp.receiptUrl || "";
  pay.receiptDataUrl = exp.receiptDataUrl || "";
  pay.updatedAt = nowISO();
}

/* ---------------- Dashboard ---------------- */

function calcPlannedByDept(){
  const planned = new Map();
  for(const b of visible(state.db.budget)){
    const dept = b.department || "Otros";
    planned.set(dept, (planned.get(dept)||0) + Number(b.planned||0));
  }
  return planned;
}

function calcActualByDept(){
  const actual = new Map();
  for(const e of visible(state.db.expenses)){
    const dept = e.department || "Otros";
    actual.set(dept, (actual.get(dept)||0) + Number(e.amount||0));
  }
  return actual;
}

function renderDashboard(){
  const budget = visible(state.db.budget);
  const expenses = visible(state.db.expenses);
  const payments = visible(state.db.payments);

  const plannedTotal = budget.reduce((s,x)=>s+Number(x.planned||0),0);
  const actualTotal = expenses.reduce((s,x)=>s+Number(x.amount||0),0);
  const diff = actualTotal - plannedTotal;

  const today = todayISO();
  const dueSoonLimit = plusDaysISO(today, DUE_SOON_DAYS);

  const dueSoonOrOver = payments
    .filter(p => (p.status||"pending") !== "paid")
    .filter(p => p.dueDate)
    .filter(p => p.dueDate <= dueSoonLimit) // incluye vencidos (porque también <=)
    .sort((a,b)=> (a.dueDate||"9999-12-31").localeCompare(b.dueDate||"9999-12-31"));

  const plannedByDept = calcPlannedByDept();
  const actualByDept = calcActualByDept();
  const depts = (state.db.catalog?.departments || []).slice().sort((a,b)=>deptIndex(a)-deptIndex(b));

  const deptRows = depts
    .map(dept=>{
      const p = plannedByDept.get(dept)||0;
      const a = actualByDept.get(dept)||0;
      if(p===0 && a===0) return null;
      const d = a - p;
      return { dept, p, a, d };
    })
    .filter(Boolean);

  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <div>
          <h2>LA CASONA <span class="muted">- Admin.</span></h2>
          <div class="small">
            Inicio: ${formatDate(state.db.project?.startDate)} ·
            Días: ${escapeHtml(state.db.project?.numDays || 10)} ·
            Moneda: ${escapeHtml(state.db.project?.currency || "ARS")}
          </div>
        </div>
        <span class="badge">rev ${state.db._meta?.revision || 0}</span>
      </div>
    </div>

    <div class="card">
      <h3>Resumen</h3>
      <div class="kpi">
        <div class="box"><div class="small">Plan (presupuesto)</div><div class="val">$ ${money(plannedTotal)}</div></div>
        <div class="box"><div class="small">Real (gastos)</div><div class="val">$ ${money(actualTotal)}</div></div>
        <div class="box"><div class="small">Desvío (real - plan)</div><div class="val">$ ${money(diff)}</div></div>
        <div class="box"><div class="small">Próximos/vencidos (≤${DUE_SOON_DAYS}d)</div><div class="val">${dueSoonOrOver.length}</div></div>
      </div>
    </div>

    <div class="card">
      <h3>Plan vs Real por Depto</h3>
      ${deptRows.length ? `
        <table>
          <thead><tr><th>Depto</th><th>Plan</th><th>Real</th><th>Desvío</th></tr></thead>
          <tbody>
            ${deptRows.map(r=>{
              const badge = r.d > 0 ? "over" : (r.d < 0 ? "paid" : "");
              return `
                <tr>
                  <td>${escapeHtml(r.dept)}</td>
                  <td>$ ${money(r.p)}</td>
                  <td>$ ${money(r.a)}</td>
                  <td><span class="badge ${badge}">$ ${money(r.d)}</span></td>
                </tr>`;
            }).join("")}
          </tbody>
        </table>
      ` : `<div class="small">Todavía no hay movimiento suficiente para armar el resumen por depto.</div>`}
    </div>

    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h3>Vencen pronto (≤${DUE_SOON_DAYS} días) y vencidos</h3>
        <button class="btn" id="goCalendar">Ver calendario</button>
      </div>
      ${renderDueTable(dueSoonOrOver.slice(0,10))}
    </div>
  `;

  $("#goCalendar").onclick = ()=> location.hash = "#/calendar";
}

function renderDueTable(list){
  if(!list.length) return `<div class="small">Nada por vencer (o todavía no cargaste vencimientos).</div>`;

  const vendorsById = Object.fromEntries(visible(state.db.vendors).map(v=>[v.id,v]));
  const today = todayISO();
  const soonLimit = plusDaysISO(today, DUE_SOON_DAYS);

  return `
    <table>
      <thead><tr><th>Vence</th><th>Proveedor</th><th>Concepto</th><th>Monto</th><th>Estado</th></tr></thead>
      <tbody>
        ${list.map(p=>{
          const v = vendorsById[p.vendorId]?.name || "—";
          const isOver = p.dueDate < today;
          const isSoon = !isOver && p.dueDate <= soonLimit;
          const badge = isOver ? "over" : (isSoon ? "due" : "");
          const label = isOver ? "vencido" : (isSoon ? "vence pronto" : "pendiente");
          return `
            <tr>
              <td>${formatDate(p.dueDate)}</td>
              <td>${escapeHtml(v)}</td>
              <td>${escapeHtml(p.concept||"—")}</td>
              <td>$ ${money(p.amount||0)}</td>
              <td><span class="badge ${badge}">${label}</span></td>
            </tr>`;
        }).join("")}
      </tbody>
    </table>
  `;
}

/* ---------------- Presupuesto ---------------- */

function renderBudget(){
  const q = filters.budget || "";
  const departments = state.db.catalog?.departments || [];

  const list = visible(state.db.budget)
    .filter(b => matchQuery(q, b.department, b.category, b.item, b.notes))
    .sort((a,b)=>{
      const da = deptIndex(a.department);
      const db = deptIndex(b.department);
      if(da !== db) return da - db;
      return (a.category||"").localeCompare(b.category||"") || (a.item||"").localeCompare(b.item||"");
    });

  view.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div>
          <h2>Presupuesto (Plan)</h2>
          <div class="small">Ordenado por Depto según el desplegable.</div>
        </div>
        <div class="row" style="min-width:420px;justify-content:flex-end">
          ${renderSearch("budget","Buscar depto / rubro / ítem…")}
          <button class="btn" id="btnAdd">+ Ítem</button>
        </div>
      </div>
    </div>

    <div class="card">
      <table>
        <thead>
          <tr><th>Depto</th><th>Rubro</th><th>Ítem</th><th>Plan</th><th>Notas</th><th class="actionsCell"></th></tr>
        </thead>
        <tbody>
          ${list.map(b=>`
            <tr>
              <td>${escapeHtml(b.department||"—")}</td>
              <td>${escapeHtml(b.category||"—")}</td>
              <td>${escapeHtml(b.item||"—")}</td>
              <td>$ ${money(b.planned||0)}</td>
              <td class="small">${escapeHtml(b.notes||"")}</td>
              <td class="actionsCell">
                <div class="actions">
                  <button class="iconbtn accent" title="Editar" data-edit="${b.id}">${ICON.edit}</button>
                  <button class="iconbtn danger" title="Borrar" data-del="${b.id}">${ICON.trash}</button>
                </div>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      ${list.length? "" : `<div class="small">No hay ítems (o tu búsqueda no encontró nada).</div>`}
    </div>
  `;

  attachSearch("budget");

  $("#btnAdd").onclick = () => openDialog("Nuevo ítem de presupuesto", `
    <div class="grid2">
      <div><label>Depto</label><select id="d_department">${departments.map(d=>`<option>${escapeHtml(d)}</option>`).join("")}</select></div>
      <div><label>Rubro</label><input id="d_category" placeholder="Ej: Alquiler cámaras"/></div>
    </div>
    <div class="grid2">
      <div><label>Ítem</label><input id="d_item" placeholder="Ej: FX6 (2 días)"/></div>
      <div><label>Plan ($)</label><input id="d_planned" type="number" step="0.01" placeholder="0"/></div>
    </div>
    <div><label>Notas</label><textarea id="d_notes"></textarea></div>
  `, () => {
    const rec = {
      id: uid("b"),
      updatedAt: nowISO(),
      deleted: false,
      department: $("#d_department").value,
      category: $("#d_category").value.trim(),
      item: $("#d_item").value.trim(),
      planned: Number($("#d_planned").value||0),
      notes: $("#d_notes").value.trim()
    };
    state.db.budget.push(rec);
    setDirty(true);
    renderBudget();
  });

  view.querySelectorAll("[data-del]").forEach(btn=>{
    btn.onclick = () => {
      const id = btn.dataset.del;
      const rec = state.db.budget.find(x=>x.id===id);
      if(rec && confirmDelete("este ítem de presupuesto")){
        rec.deleted = true;
        rec.updatedAt = nowISO();
        setDirty(true);
        renderBudget();
      }
    };
  });

  view.querySelectorAll("[data-edit]").forEach(btn=>{
    btn.onclick = () => {
      const id = btn.dataset.edit;
      const rec = state.db.budget.find(x=>x.id===id);
      if(!rec) return;

      openDialog("Editar ítem de presupuesto", `
        <div class="grid2">
          <div><label>Depto</label><select id="d_department">${departments.map(d=>`<option ${d===rec.department?"selected":""}>${escapeHtml(d)}</option>`).join("")}</select></div>
          <div><label>Rubro</label><input id="d_category" value="${escapeHtml(rec.category||"")}"/></div>
        </div>
        <div class="grid2">
          <div><label>Ítem</label><input id="d_item" value="${escapeHtml(rec.item||"")}"/></div>
          <div><label>Plan ($)</label><input id="d_planned" type="number" step="0.01" value="${Number(rec.planned||0)}"/></div>
        </div>
        <div><label>Notas</label><textarea id="d_notes">${escapeHtml(rec.notes||"")}</textarea></div>
      `, () => {
        rec.department = $("#d_department").value;
        rec.category = $("#d_category").value.trim();
        rec.item = $("#d_item").value.trim();
        rec.planned = Number($("#d_planned").value||0);
        rec.notes = $("#d_notes").value.trim();
        rec.updatedAt = nowISO();
        setDirty(true);
        renderBudget();
      });
    };
  });
}

/* ---------------- Proveedores ---------------- */

function renderVendors(){
  const q = filters.vendors || "";
  const list = visible(state.db.vendors).filter(v => matchQuery(q, v.name, v.contact, v.cuit, v.email, v.phone, v.notes));

  view.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div>
          <h2>Proveedores</h2>
          <div class="small">Editable + buscador.</div>
        </div>
        <div class="row" style="min-width:420px;justify-content:flex-end">
          ${renderSearch("vendors","Buscar nombre / CUIT / contacto…")}
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

  $("#btnAdd").onclick = () => openDialog("Nuevo proveedor", `
    <div class="grid2">
      <div><label>Nombre</label><input id="d_name" placeholder="Ej: Camauer"/></div>
      <div><label>Contacto</label><input id="d_contact" placeholder="Nombre y apellido"/></div>
    </div>
    <div class="grid3">
      <div><label>CUIT</label><input id="d_cuit" placeholder="00-00000000-0"/></div>
      <div><label>Email</label><input id="d_email" type="email" placeholder="mail@..." /></div>
      <div><label>Tel</label><input id="d_phone" placeholder="+54 11 ..." /></div>
    </div>
    <div><label>Notas</label><textarea id="d_notes"></textarea></div>
  `, () => {
    const rec = {
      id: uid("v"),
      updatedAt: nowISO(),
      deleted: false,
      name: $("#d_name").value.trim(),
      contact: $("#d_contact").value.trim(),
      cuit: $("#d_cuit").value.trim(),
      email: $("#d_email").value.trim(),
      phone: $("#d_phone").value.trim(),
      notes: $("#d_notes").value.trim()
    };
    state.db.vendors.push(rec);
    setDirty(true);
    renderVendors();
  });

  view.querySelectorAll("[data-del]").forEach(btn=>{
    btn.onclick = () => {
      const id = btn.dataset.del;
      const rec = state.db.vendors.find(x=>x.id===id);
      if(rec && confirmDelete("este proveedor")){
        rec.deleted = true;
        rec.updatedAt = nowISO();
        setDirty(true);
        renderVendors();
      }
    };
  });

  view.querySelectorAll("[data-edit]").forEach(btn=>{
    btn.onclick = () => {
      const id = btn.dataset.edit;
      const rec = state.db.vendors.find(x=>x.id===id);
      if(!rec) return;

      openDialog("Editar proveedor", `
        <div class="grid2">
          <div><label>Nombre</label><input id="d_name" value="${escapeHtml(rec.name||"")}"/></div>
          <div><label>Contacto</label><input id="d_contact" value="${escapeHtml(rec.contact||"")}"/></div>
        </div>
        <div class="grid3">
          <div><label>CUIT</label><input id="d_cuit" value="${escapeHtml(rec.cuit||"")}"/></div>
          <div><label>Email</label><input id="d_email" type="email" value="${escapeHtml(rec.email||"")}" /></div>
          <div><label>Tel</label><input id="d_phone" value="${escapeHtml(rec.phone||"")}" /></div>
        </div>
        <div><label>Notas</label><textarea id="d_notes">${escapeHtml(rec.notes||"")}</textarea></div>
      `, () => {
        rec.name = $("#d_name").value.trim();
        rec.contact = $("#d_contact").value.trim();
        rec.cuit = $("#d_cuit").value.trim();
        rec.email = $("#d_email").value.trim();
        rec.phone = $("#d_phone").value.trim();
        rec.notes = $("#d_notes").value.trim();
        rec.updatedAt = nowISO();
        setDirty(true);
        renderVendors();
      });
    };
  });
}

/* ---------------- Gastos Reales (con info de pago) ---------------- */

function renderExpenses(){
  const q = filters.expenses || "";
  const vendors = visible(state.db.vendors);
  const vendorsById = Object.fromEntries(vendors.map(v=>[v.id,v]));
  const departments = state.db.catalog?.departments || [];

  const list = visible(state.db.expenses)
    .filter(e => matchQuery(q,
      e.date, e.serviceDate, e.dueDate, e.department, e.concept, e.notes,
      vendorsById[e.vendorId]?.name || "",
      e.payStatus, e.payMethod
    ))
    .sort((a,b)=> (b.date||"").localeCompare(a.date||"")); // últimos arriba

  view.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div>
          <h2>Gastos reales</h2>
          <div class="small">Acá cargás ejecución + vencimiento + pago + comprobante.</div>
        </div>
        <div class="row" style="min-width:420px;justify-content:flex-end">
          ${renderSearch("expenses","Buscar proveedor / concepto / fechas…")}
          <button class="btn" id="btnAdd">+ Gasto</button>
        </div>
      </div>
    </div>

    <div class="card">
      <table>
        <thead><tr>
          <th>Fecha</th><th>Proveedor</th><th>Depto</th><th>Concepto</th><th>Monto</th>
          <th>Ejecución</th><th>Vence</th><th>Pago</th><th class="actionsCell"></th>
        </tr></thead>
        <tbody>
          ${list.map(e=>{
            const v = vendorsById[e.vendorId]?.name || "—";
            const status = e.payStatus || "pending";
            const badge = status==="paid" ? "paid" : (e.dueDate && e.dueDate < todayISO() ? "over" : "due");
            const label = status==="paid" ? "pagado" : "pendiente";
            return `
              <tr>
                <td>${formatDate(e.date)}</td>
                <td>${escapeHtml(v)}</td>
                <td>${escapeHtml(e.department||"—")}</td>
                <td>${escapeHtml(e.concept||"—")}</td>
                <td>$ ${money(e.amount||0)}</td>
                <td>${formatDate(e.serviceDate)}</td>
                <td>${formatDate(e.dueDate)}</td>
                <td><span class="badge ${badge}">${label}</span></td>
                <td class="actionsCell">
                  <div class="actions">
                    ${status!=="paid" ? `<button class="iconbtn good" title="Marcar pagado" data-pay="${e.id}">${ICON.pay}</button>` : ""}
                    <button class="iconbtn accent" title="Editar" data-edit="${e.id}">${ICON.edit}</button>
                    <button class="iconbtn danger" title="Borrar" data-del="${e.id}">${ICON.trash}</button>
                  </div>
                </td>
              </tr>`;
          }).join("")}
        </tbody>
      </table>
      ${list.length? "" : `<div class="small">No hay gastos (o tu búsqueda no encontró nada).</div>`}
    </div>
  `;

  attachSearch("expenses");

  $("#btnAdd").onclick = () => openExpenseDialog(null);

  view.querySelectorAll("[data-del]").forEach(btn=>{
    btn.onclick = () => {
      const id = btn.dataset.del;
      const rec = state.db.expenses.find(x=>x.id===id);
      if(!rec) return;
      if(confirmDelete("este gasto")){
        rec.deleted = true;
        rec.updatedAt = nowISO();

        const pay = findPaymentByExpenseId(id);
        if(pay){
          pay.deleted = true;
          pay.updatedAt = nowISO();
        }

        setDirty(true);
        renderExpenses();
      }
    };
  });

  view.querySelectorAll("[data-edit]").forEach(btn=>{
    btn.onclick = () => {
      const id = btn.dataset.edit;
      const rec = state.db.expenses.find(x=>x.id===id);
      if(rec) openExpenseDialog(rec);
    };
  });

  view.querySelectorAll("[data-pay]").forEach(btn=>{
    btn.onclick = () => {
      const id = btn.dataset.pay;
      const rec = state.db.expenses.find(x=>x.id===id);
      if(!rec) return;
      openPayOnlyDialogFromExpense(rec);
    };
  });
}

function openExpenseDialog(rec){
  const isEdit = !!rec;
  const vendors = visible(state.db.vendors);
  const vendorsOpt = vendors.map(v=>`<option value="${v.id}" ${rec?.vendorId===v.id?"selected":""}>${escapeHtml(v.name)}</option>`).join("");
  const departments = state.db.catalog?.departments || [];
  const deptOpt = departments.map(d=>`<option ${rec?.department===d?"selected":""}>${escapeHtml(d)}</option>`).join("");

  openDialog(isEdit ? "Editar gasto real" : "Nuevo gasto real", `
    <div class="grid3">
      <div><label>Fecha (carga)</label><input id="d_date" type="date" value="${escapeHtml(rec?.date||todayISO())}"/></div>
      <div><label>Proveedor</label>
        <select id="d_vendor"><option value="">—</option>${vendorsOpt}</select>
      </div>
      <div><label>Depto</label><select id="d_department">${deptOpt}</select></div>
    </div>

    <div class="grid2">
      <div><label>Concepto</label><input id="d_concept" value="${escapeHtml(rec?.concept||"")}" placeholder="Ej: Catering día 3"/></div>
      <div><label>Monto</label><input id="d_amount" type="number" step="0.01" value="${Number(rec?.amount||0)}"/></div>
    </div>

    <div class="grid2">
      <div><label>Fecha de ejecución (servicio)</label><input id="d_serviceDate" type="date" value="${escapeHtml(rec?.serviceDate||"")}"/></div>
      <div><label>Vencimiento (pago)</label><input id="d_dueDate" type="date" value="${escapeHtml(rec?.dueDate||"")}"/></div>
    </div>

    <div class="grid3">
      <div><label>Estado pago</label>
        <select id="d_payStatus">
          <option value="pending" ${rec?.payStatus!=="paid"?"selected":""}>Pendiente</option>
          <option value="paid" ${rec?.payStatus==="paid"?"selected":""}>Pagado</option>
        </select>
      </div>
      <div><label>Fecha pago</label><input id="d_paidAt" type="date" value="${escapeHtml(rec?.paidAt||"")}"/></div>
      <div><label>Método</label>
        <select id="d_payMethod">
          ${["","Transferencia","Efectivo","Cheque","Tarjeta","Otro"].map(m=>`<option ${rec?.payMethod===m?"selected":""}>${escapeHtml(m)}</option>`).join("")}
        </select>
      </div>
    </div>

    <div class="grid2">
      <div><label>Comprobante (URL)</label><input id="d_receiptUrl" value="${escapeHtml(rec?.receiptUrl||"")}" placeholder="https://..."/></div>
      <div>
        <label>Adjuntar PDF (opcional, chico)</label>
        <input id="d_receiptFile" type="file" accept="application/pdf"/>
        <div class="small">Si pesa mucho, usá URL. Base64 infla el bin.</div>
      </div>
    </div>

    <div><label>Notas</label><textarea id="d_notes">${escapeHtml(rec?.notes||"")}</textarea></div>
  `, async () => {
    const file = $("#d_receiptFile").files?.[0] || null;

    let receiptDataUrl = rec?.receiptDataUrl || "";
    if(file){
      if(file.size > MAX_INLINE_PDF_BYTES){
        alert("Ese PDF es grande. Usá URL para el comprobante.");
      }else{
        receiptDataUrl = await fileToDataUrl(file);
      }
    }

    const payload = {
      date: $("#d_date").value,
      vendorId: $("#d_vendor").value,
      department: $("#d_department").value,
      concept: $("#d_concept").value.trim(),
      amount: Number($("#d_amount").value||0),
      serviceDate: $("#d_serviceDate").value,
      dueDate: $("#d_dueDate").value,
      payStatus: $("#d_payStatus").value,
      paidAt: $("#d_paidAt").value,
      payMethod: $("#d_payMethod").value,
      receiptUrl: $("#d_receiptUrl").value.trim(),
      receiptDataUrl,
      notes: $("#d_notes").value.trim()
    };

    if(isEdit){
      Object.assign(rec, payload);
      rec.updatedAt = nowISO();
      upsertPaymentFromExpense(rec);
    }else{
      const newRec = {
        id: uid("e"),
        updatedAt: nowISO(),
        deleted: false,
        ...payload
      };
      state.db.expenses.push(newRec);
      upsertPaymentFromExpense(newRec);
    }

    setDirty(true);
    renderExpenses();
  });
}

function openPayOnlyDialogFromExpense(rec){
  openDialog("Marcar pagado", `
    <div class="grid3">
      <div><label>Fecha pago</label><input id="d_paidAt" type="date" value="${escapeHtml(rec.paidAt||todayISO())}"/></div>
      <div><label>Método</label>
        <select id="d_payMethod">
          ${["Transferencia","Efectivo","Cheque","Tarjeta","Otro"].map(m=>`<option ${rec.payMethod===m?"selected":""}>${escapeHtml(m)}</option>`).join("")}
        </select>
      </div>
      <div><label>Comprobante (URL)</label><input id="d_receiptUrl" value="${escapeHtml(rec.receiptUrl||"")}" placeholder="https://..."/></div>
    </div>
    <div>
      <label>Adjuntar PDF (opcional, chico)</label>
      <input id="d_receiptFile" type="file" accept="application/pdf"/>
      <div class="small">Si pesa mucho, usá URL.</div>
    </div>
  `, async () => {
    const file = $("#d_receiptFile").files?.[0] || null;
    let receiptDataUrl = rec.receiptDataUrl || "";
    if(file){
      if(file.size > MAX_INLINE_PDF_BYTES) alert("PDF grande. Usá URL.");
      else receiptDataUrl = await fileToDataUrl(file);
    }

    rec.payStatus = "paid";
    rec.paidAt = $("#d_paidAt").value;
    rec.payMethod = $("#d_payMethod").value;
    rec.receiptUrl = $("#d_receiptUrl").value.trim();
    rec.receiptDataUrl = receiptDataUrl;
    rec.updatedAt = nowISO();

    upsertPaymentFromExpense(rec);

    setDirty(true);
    renderExpenses();
  });
}

/* ---------------- Calendario ---------------- */

function renderCalendar(){
  const q = filters.calendar || "";
  const vendorsById = Object.fromEntries(visible(state.db.vendors).map(v=>[v.id,v]));
  const today = todayISO();
  const soonLimit = plusDaysISO(today, DUE_SOON_DAYS);

  const list = visible(state.db.payments)
    .filter(p => p.dueDate) // calendario = con vencimiento
    .filter(p => matchQuery(q,
      p.dueDate, p.serviceDate, p.concept, p.method, p.status,
      vendorsById[p.vendorId]?.name || ""
    ))
    .sort((a,b)=> (a.dueDate||"9999-12-31").localeCompare(b.dueDate||"9999-12-31"));

  view.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div>
          <h2>Calendario de pagos</h2>
          <div class="small">Vencidos y próximos a vencer (≤${DUE_SOON_DAYS} días).</div>
        </div>
        <div class="row" style="min-width:420px;justify-content:flex-end">
          ${renderSearch("calendar","Buscar proveedor / concepto / fecha…")}
        </div>
      </div>
    </div>

    <div class="card">
      <table>
        <thead><tr>
          <th>Vence</th><th>Proveedor</th><th>Concepto</th><th>Monto</th><th>Estado</th><th class="actionsCell"></th>
        </tr></thead>
        <tbody>
          ${list.map(p=>{
            const v = vendorsById[p.vendorId]?.name || "—";
            const isPaid = (p.status||"pending")==="paid";
            const isOver = !isPaid && p.dueDate < today;
            const isSoon = !isPaid && !isOver && p.dueDate <= soonLimit;
            const badge = isPaid ? "paid" : (isOver ? "over" : (isSoon ? "due" : ""));
            const label = isPaid ? "pagado" : (isOver ? "vencido" : (isSoon ? "vence pronto" : "pendiente"));

            return `
              <tr>
                <td>${formatDate(p.dueDate)}</td>
                <td>${escapeHtml(v)}</td>
                <td>${escapeHtml(p.concept||"—")}</td>
                <td>$ ${money(p.amount||0)}</td>
                <td><span class="badge ${badge}">${label}</span></td>
                <td class="actionsCell">
                  <div class="actions">
                    ${!isPaid ? `<button class="iconbtn good" title="Marcar pagado" data-markpaid="${p.id}">${ICON.pay}</button>` : ""}
                    <button class="iconbtn accent" title="Editar" data-edit="${p.id}">${ICON.edit}</button>
                    <button class="iconbtn danger" title="Borrar" data-del="${p.id}">${ICON.trash}</button>
                  </div>
                </td>
              </tr>`;
          }).join("")}
        </tbody>
      </table>
      ${list.length? "" : `<div class="small">No hay pagos con vencimiento (o tu búsqueda no encontró nada).</div>`}
    </div>
  `;

  attachSearch("calendar");

  view.querySelectorAll("[data-del]").forEach(btn=>{
    btn.onclick = () => {
      const id = btn.dataset.del;
      const rec = state.db.payments.find(x=>x.id===id);
      if(rec && confirmDelete("este pago")){
        rec.deleted = true;
        rec.updatedAt = nowISO();
        setDirty(true);
        renderCalendar();
      }
    };
  });

  view.querySelectorAll("[data-edit]").forEach(btn=>{
    btn.onclick = () => {
      const id = btn.dataset.edit;
      const rec = state.db.payments.find(x=>x.id===id);
      if(rec) openPaymentDialog(rec);
    };
  });

  view.querySelectorAll("[data-markpaid]").forEach(btn=>{
    btn.onclick = () => {
      const id = btn.dataset.markpaid;
      const rec = state.db.payments.find(x=>x.id===id);
      if(rec) openMarkPaidDialog(rec);
    };
  });
}

function openPaymentDialog(rec){
  const vendors = visible(state.db.vendors);
  openDialog("Editar pago", `
    <div class="grid3">
      <div><label>Proveedor</label>
        <select id="d_vendor">
          <option value="">—</option>
          ${vendors.map(v=>`<option value="${v.id}" ${rec.vendorId===v.id?"selected":""}>${escapeHtml(v.name)}</option>`).join("")}
        </select>
      </div>
      <div><label>Ejecución</label><input id="d_serviceDate" type="date" value="${escapeHtml(rec.serviceDate||"")}"/></div>
      <div><label>Vence</label><input id="d_dueDate" type="date" value="${escapeHtml(rec.dueDate||"")}"/></div>
    </div>

    <div class="grid2">
      <div><label>Concepto</label><input id="d_concept" value="${escapeHtml(rec.concept||"")}"/></div>
      <div><label>Monto</label><input id="d_amount" type="number" step="0.01" value="${Number(rec.amount||0)}"/></div>
    </div>

    <div class="grid3">
      <div><label>Estado</label>
        <select id="d_status">
          <option value="pending" ${(rec.status||"pending")!=="paid"?"selected":""}>Pendiente</option>
          <option value="paid" ${(rec.status||"pending")==="paid"?"selected":""}>Pagado</option>
        </select>
      </div>
      <div><label>Fecha pago</label><input id="d_paidAt" type="date" value="${escapeHtml(rec.paidAt||"")}"/></div>
      <div><label>Método</label>
        <select id="d_method">
          ${["","Transferencia","Efectivo","Cheque","Tarjeta","Otro"].map(m=>`<option ${rec.method===m?"selected":""}>${escapeHtml(m)}</option>`).join("")}
        </select>
      </div>
    </div>

    <div class="grid2">
      <div><label>Comprobante (URL)</label><input id="d_receiptUrl" value="${escapeHtml(rec.receiptUrl||"")}" placeholder="https://..."/></div>
      <div>
        <label>Adjuntar PDF (opcional, chico)</label>
        <input id="d_receiptFile" type="file" accept="application/pdf"/>
      </div>
    </div>
  `, async () => {
    const file = $("#d_receiptFile").files?.[0] || null;
    let receiptDataUrl = rec.receiptDataUrl || "";
    if(file){
      if(file.size > MAX_INLINE_PDF_BYTES) alert("PDF grande. Usá URL.");
      else receiptDataUrl = await fileToDataUrl(file);
    }

    rec.vendorId = $("#d_vendor").value;
    rec.serviceDate = $("#d_serviceDate").value;
    rec.dueDate = $("#d_dueDate").value;
    rec.concept = $("#d_concept").value.trim();
    rec.amount = Number($("#d_amount").value||0);
    rec.status = $("#d_status").value;
    rec.paidAt = $("#d_paidAt").value;
    rec.method = $("#d_method").value;
    rec.receiptUrl = $("#d_receiptUrl").value.trim();
    rec.receiptDataUrl = receiptDataUrl;
    rec.updatedAt = nowISO();

    // Si viene de un expense, lo reflejamos
    if(rec.expenseId){
      const exp = state.db.expenses.find(e=>e.id===rec.expenseId && e.deleted!==true);
      if(exp){
        exp.vendorId = rec.vendorId;
        exp.serviceDate = rec.serviceDate;
        exp.dueDate = rec.dueDate;
        exp.concept = rec.concept;
        exp.amount = rec.amount;
        exp.payStatus = rec.status;
        exp.paidAt = rec.paidAt;
        exp.payMethod = rec.method;
        exp.receiptUrl = rec.receiptUrl;
        exp.receiptDataUrl = rec.receiptDataUrl;
        exp.updatedAt = nowISO();
      }
    }

    setDirty(true);
    renderCalendar();
  });
}

function openMarkPaidDialog(pay){
  openDialog("Marcar pagado", `
    <div class="grid3">
      <div><label>Fecha pago</label><input id="d_paidAt" type="date" value="${escapeHtml(pay.paidAt||todayISO())}"/></div>
      <div><label>Método</label>
        <select id="d_method">
          ${["Transferencia","Efectivo","Cheque","Tarjeta","Otro"].map(m=>`<option ${pay.method===m?"selected":""}>${escapeHtml(m)}</option>`).join("")}
        </select>
      </div>
      <div><label>Comprobante (URL)</label><input id="d_receiptUrl" value="${escapeHtml(pay.receiptUrl||"")}" placeholder="https://..."/></div>
    </div>
    <div>
      <label>Adjuntar PDF (opcional, chico)</label>
      <input id="d_receiptFile" type="file" accept="application/pdf"/>
    </div>
  `, async () => {
    const file = $("#d_receiptFile").files?.[0] || null;
    let receiptDataUrl = pay.receiptDataUrl || "";
    if(file){
      if(file.size > MAX_INLINE_PDF_BYTES) alert("PDF grande. Usá URL.");
      else receiptDataUrl = await fileToDataUrl(file);
    }

    pay.status = "paid";
    pay.paidAt = $("#d_paidAt").value;
    pay.method = $("#d_method").value;
    pay.receiptUrl = $("#d_receiptUrl").value.trim();
    pay.receiptDataUrl = receiptDataUrl;
    pay.updatedAt = nowISO();

    // espejo a expense si existe
    if(pay.expenseId){
      const exp = state.db.expenses.find(e=>e.id===pay.expenseId && e.deleted!==true);
      if(exp){
        exp.payStatus = "paid";
        exp.paidAt = pay.paidAt;
        exp.payMethod = pay.method;
        exp.receiptUrl = pay.receiptUrl;
        exp.receiptDataUrl = pay.receiptDataUrl;
        exp.updatedAt = nowISO();
      }
    }

    setDirty(true);
    renderCalendar();
  });
}

/* ---------------- Pagos (solo pagados) ---------------- */

function renderPayments(){
  const q = filters.payments || "";
  const vendorsById = Object.fromEntries(visible(state.db.vendors).map(v=>[v.id,v]));

  const list = visible(state.db.payments)
    .filter(p => (p.status||"pending")==="paid")
    .filter(p => matchQuery(q,
      p.paidAt, p.concept, p.method,
      vendorsById[p.vendorId]?.name || ""
    ))
    .sort((a,b)=> (b.paidAt||"").localeCompare(a.paidAt||""));

  view.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div>
          <h2>Pagos</h2>
          <div class="small">Solo pagos realizados (proveedor + método + comprobante).</div>
        </div>
        <div class="row" style="min-width:420px;justify-content:flex-end">
          ${renderSearch("payments","Buscar proveedor / método / concepto…")}
        </div>
      </div>
    </div>

    <div class="card">
      <table>
        <thead><tr>
          <th>Fecha pago</th><th>Proveedor</th><th>Método</th><th>Concepto</th><th>Monto</th><th>Comprobante</th><th class="actionsCell"></th>
        </tr></thead>
        <tbody>
          ${list.map(p=>{
            const v = vendorsById[p.vendorId]?.name || "—";
            const link = p.receiptUrl ? `<a href="${p.receiptUrl}" target="_blank" rel="noopener">Abrir</a>` : (p.receiptDataUrl ? `<a href="${p.receiptDataUrl}" target="_blank" rel="noopener">Abrir</a>` : "—");
            return `
              <tr>
                <td>${formatDate(p.paidAt)}</td>
                <td>${escapeHtml(v)}</td>
                <td>${escapeHtml(p.method||"—")}</td>
                <td>${escapeHtml(p.concept||"—")}</td>
                <td>$ ${money(p.amount||0)}</td>
                <td>${link}</td>
                <td class="actionsCell">
                  <div class="actions">
                    <button class="iconbtn accent" title="Editar" data-edit="${p.id}">${ICON.edit}</button>
                    <button class="iconbtn danger" title="Borrar" data-del="${p.id}">${ICON.trash}</button>
                  </div>
                </td>
              </tr>`;
          }).join("")}
        </tbody>
      </table>
      ${list.length? "" : `<div class="small">No hay pagos realizados (o tu búsqueda no encontró nada).</div>`}
    </div>
  `;

  attachSearch("payments");

  view.querySelectorAll("[data-del]").forEach(btn=>{
    btn.onclick = () => {
      const id = btn.dataset.del;
      const rec = state.db.payments.find(x=>x.id===id);
      if(rec && confirmDelete("este pago")){
        rec.deleted = true;
        rec.updatedAt = nowISO();
        setDirty(true);
        renderPayments();
      }
    };
  });

  view.querySelectorAll("[data-edit]").forEach(btn=>{
    btn.onclick = () => {
      const id = btn.dataset.edit;
      const rec = state.db.payments.find(x=>x.id===id);
      if(rec) openPaymentDialog(rec);
    };
  });
}

/* ---------------- Saldos de proveedores ---------------- */

function renderBalances(){
  const q = filters.balances || "";
  const vendors = visible(state.db.vendors);
  const expenses = visible(state.db.expenses);
  const payments = visible(state.db.payments);

  const byVendor = new Map();
  for(const v of vendors){
    byVendor.set(v.id, { vendor:v, spent:0, paid:0, pending:0, overdue:0, nextDue:"" });
  }

  for(const e of expenses){
    const bucket = byVendor.get(e.vendorId);
    if(bucket) bucket.spent += Number(e.amount||0);
  }

  const today = todayISO();
  for(const p of payments){
    const bucket = byVendor.get(p.vendorId);
    if(!bucket) continue;
    if((p.status||"pending")==="paid"){
      bucket.paid += Number(p.amount||0);
    }else{
      bucket.pending += Number(p.amount||0);
      if(p.dueDate && p.dueDate < today) bucket.overdue += 1;
      if(p.dueDate){
        if(!bucket.nextDue || p.dueDate < bucket.nextDue) bucket.nextDue = p.dueDate;
      }
    }
  }

  const rows = Array.from(byVendor.values())
    .filter(x => matchQuery(q, x.vendor.name, x.vendor.cuit, x.vendor.contact))
    .sort((a,b)=> (b.pending - a.pending) || (a.vendor.name||"").localeCompare(b.vendor.name||""));

  view.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div>
          <h2>Saldos de proveedores</h2>
          <div class="small">Pendiente = lo que falta pagar (según vencimientos cargados).</div>
        </div>
        <div class="row" style="min-width:420px;justify-content:flex-end">
          ${renderSearch("balances","Buscar proveedor / CUIT…")}
        </div>
      </div>
    </div>

    <div class="card">
      <table>
        <thead><tr>
          <th>Proveedor</th><th>Gastado</th><th>Pagado</th><th>Pendiente</th><th>Vencidos</th><th>Próx. venc.</th>
        </tr></thead>
        <tbody>
          ${rows.map(r=>{
            const badge = r.pending > 0 ? (r.overdue>0 ? "over" : "due") : "paid";
            return `
              <tr>
                <td>${escapeHtml(r.vendor.name||"—")}</td>
                <td>$ ${money(r.spent)}</td>
                <td>$ ${money(r.paid)}</td>
                <td><span class="badge ${badge}">$ ${money(r.pending)}</span></td>
                <td>${r.overdue}</td>
                <td>${r.nextDue ? formatDate(r.nextDue) : "—"}</td>
              </tr>`;
          }).join("")}
        </tbody>
      </table>
      ${rows.length? "" : `<div class="small">No hay proveedores (o tu búsqueda no encontró nada).</div>`}
    </div>
  `;

  attachSearch("balances");
}

/* ---------------- Comprobantes (general) ---------------- */

function renderDocs(){
  const q = filters.docs || "";
  const docs = visible(state.db.documents)
    .filter(d => matchQuery(q, d.date, d.type, d.name, d.url))
    .sort((a,b)=> (b.date||"").localeCompare(a.date||""));

  view.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div>
          <h2>Comprobantes</h2>
          <div class="small">Para docs generales. Los comprobantes de pagos están en Gastos/Pagos.</div>
        </div>
        <div class="row" style="min-width:420px;justify-content:flex-end">
          ${renderSearch("docs","Buscar nombre / tipo / fecha…")}
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

  $("#btnAdd").onclick = () => openDialog("Nuevo documento", `
    <div class="grid3">
      <div><label>Fecha</label><input id="d_date" type="date" value="${todayISO()}"/></div>
      <div><label>Tipo</label>
        <select id="d_type">
          <option>Factura</option>
          <option>Recibo</option>
          <option>Contrato</option>
          <option>Remito</option>
          <option>Otro</option>
        </select>
      </div>
      <div><label>URL</label><input id="d_url" placeholder="https://..."/></div>
    </div>
    <div><label>Nombre</label><input id="d_name" placeholder="Ej: Contrato locación"/></div>
  `, () => {
    const rec = {
      id: uid("d"),
      updatedAt: nowISO(),
      deleted: false,
      date: $("#d_date").value,
      type: $("#d_type").value,
      name: $("#d_name").value.trim(),
      url: $("#d_url").value.trim()
    };
    state.db.documents.push(rec);
    setDirty(true);
    renderDocs();
  });

  view.querySelectorAll("[data-del]").forEach(btn=>{
    btn.onclick = () => {
      const id = btn.dataset.del;
      const rec = state.db.documents.find(x=>x.id===id);
      if(rec && confirmDelete("este documento")){
        rec.deleted = true;
        rec.updatedAt = nowISO();
        setDirty(true);
        renderDocs();
      }
    };
  });

  view.querySelectorAll("[data-edit]").forEach(btn=>{
    btn.onclick = () => {
      const id = btn.dataset.edit;
      const rec = state.db.documents.find(x=>x.id===id);
      if(!rec) return;

      openDialog("Editar documento", `
        <div class="grid3">
          <div><label>Fecha</label><input id="d_date" type="date" value="${escapeHtml(rec.date||"")}"/></div>
          <div><label>Tipo</label>
            <select id="d_type">
              ${["Factura","Recibo","Contrato","Remito","Otro"].map(t=>`<option ${rec.type===t?"selected":""}>${escapeHtml(t)}</option>`).join("")}
            </select>
          </div>
          <div><label>URL</label><input id="d_url" value="${escapeHtml(rec.url||"")}" /></div>
        </div>
        <div><label>Nombre</label><input id="d_name" value="${escapeHtml(rec.name||"")}" /></div>
      `, () => {
        rec.date = $("#d_date").value;
        rec.type = $("#d_type").value;
        rec.url = $("#d_url").value.trim();
        rec.name = $("#d_name").value.trim();
        rec.updatedAt = nowISO();
        setDirty(true);
        renderDocs();
      });
    };
  });
}

/* ---------------- Config (arreglada) ---------------- */

function renderConfig(){
  view.innerHTML = `
    <div class="card">
      <h2>Config</h2>
      <div class="small">Uso interno: BIN_ID y Access Key vienen precargados, pero podés cambiarlos por navegador.</div>

      <div class="grid2" style="margin-top:10px">
        <div>
          <label>BIN_ID</label>
          <input id="c_bin" value="${escapeHtml(state.config.binId||"")}" />
        </div>
        <div>
          <label>Access Key</label>
          <input id="c_access" value="${escapeHtml(state.config.accessKey||"")}" />
        </div>
      </div>

      <div class="grid2" style="margin-top:10px">
        <div>
          <label>Master Key (opcional)</label>
          <input id="c_master" value="${escapeHtml(state.config.masterKey||"")}" />
        </div>
        <div>
          <label>Auto-sync</label>
          <div class="small">Pull: ${AUTO_PULL_INTERVAL_MS/1000}s · Push debounce: ${AUTO_PUSH_DEBOUNCE_MS/1000}s · Due soon: ${DUE_SOON_DAYS}d</div>
        </div>
      </div>

      <div class="row" style="margin-top:12px">
        <button class="btn primary" id="btnCfgSave">Guardar config</button>
        <button class="btn" id="btnCfgReload">Recargar desde JSONBin</button>
      </div>
    </div>
  `;

  $("#btnCfgSave").onclick = () => {
    saveConfig({
      binId: $("#c_bin").value.trim(),
      accessKey: $("#c_access").value.trim(),
      masterKey: $("#c_master").value.trim()
    });
    alert("Config guardada en este navegador ✅");
  };

  $("#btnCfgReload").onclick = async () => {
    await boot(true);
    alert("Recargado ✅");
  };
}

/* ---------------- File helpers ---------------- */

function fileToDataUrl(file){
  return new Promise((resolve,reject)=>{
    const r = new FileReader();
    r.onerror = ()=>reject(new Error("No pude leer el archivo."));
    r.onload = ()=>resolve(String(r.result||""));
    r.readAsDataURL(file);
  });
}

/* ---------------- Wire up ---------------- */

window.addEventListener("hashchange", route);

$("#btnSync").onclick = async () => { await boot(true); };
$("#btnSave").onclick = async () => {
  if(state.pushTimer) clearTimeout(state.pushTimer);
  await autoPush();
};

route();
boot(false);
