/* Admin Producción · GH Pages + JSONBin (autosync)
   - Lee latest: GET /b/<BIN_ID>/latest?meta=false  (meta=false está soportado) 
   - Update: PUT /b/<BIN_ID> con X-Access-Key o X-Master-Key
*/

const DEFAULT_BIN_ID = "6949ab15d0ea881f403a5807";
const DEFAULT_ACCESS_KEY = "$2a$10$nzjX1kWtm5vCMZj8qtlSoeP/kUp77ZWnpFE6kWIcnBqe1fDL1lkDi";

const AUTO_PULL_INTERVAL_MS = 6000;       // cada 6s revisa si hay cambios remotos
const AUTO_PUSH_DEBOUNCE_MS = 1200;       // guarda 1.2s después del último cambio

const $ = (sel) => document.querySelector(sel);
const view = $("#view");
const dlg = $("#dlg");
const dlgTitle = $("#dlgTitle");
const dlgBody = $("#dlgBody");
const dlgOk = $("#dlgOk");

const LS_KEY = "prodAdmin10_config_v2";
const LS_DEVICE = "prodAdmin10_deviceId_v1";

const state = {
  config: loadConfig(),
  db: null,
  dirty: false,
  pushing: false,
  pullTimer: null,
  pushTimer: null
};

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
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    return {
      binId: raw?.binId || DEFAULT_BIN_ID,
      accessKey: raw?.accessKey || DEFAULT_ACCESS_KEY,
      masterKey: raw?.masterKey || "" // opcional
    };
  } catch {
    return { binId: DEFAULT_BIN_ID, accessKey: DEFAULT_ACCESS_KEY, masterKey: "" };
  }
}

function saveConfig(cfg){
  localStorage.setItem(LS_KEY, JSON.stringify(cfg));
  state.config = cfg;
}

function uid(prefix="id"){
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`;
}

function nowISO(){
  return new Date().toISOString();
}

function money(n){
  const x = Number(n||0);
  return x.toLocaleString("es-AR", { maximumFractionDigits: 2 });
}

function daysBetween(dateStr){
  if(!dateStr) return null;
  const a = new Date(dateStr);
  const b = new Date();
  const ms = b - a;
  return Math.floor(ms / (1000*60*60*24));
}

function t(s){
  return s ? (Date.parse(s) || 0) : 0;
}

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

  db.vendors   = normalizeCollection(db.vendors);
  db.budget    = normalizeCollection(db.budget);
  db.expenses  = normalizeCollection(db.expenses);
  db.payments  = normalizeCollection(db.payments);
  db.documents = normalizeCollection(db.documents);

  db.catalog = db.catalog || {};
  db.catalog.departments = db.catalog.departments || [
    "Producción","Dirección","Foto / Cámara","Eléctrica / Grip","Arte","Vestuario","Maquillaje",
    "Sonido","Locaciones / Permisos","Transporte","Catering","Casting","Post / Edición","VFX",
    "Música / SFX","Seguros / Legales","Otros"
  ];
  db.project = db.project || { name:"Producción · 10 días", currency:"ARS", startDate:"", numDays:10 };
  return db;
}

/* ---------------- JSONBin ---------------- */

async function jsonbinFetch(method, path, body){
  const binId = state.config.binId?.trim();
  if(!binId) remindConfig();
  const url = `https://api.jsonbin.io/v3${path}`;

  const headers = { "Content-Type": "application/json" };
  if(state.config.accessKey) headers["X-Access-Key"] = state.config.accessKey;
  if(state.config.masterKey) headers["X-Master-Key"] = state.config.masterKey;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  if(!res.ok){
    const msg = json?.message || json?.error || text || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

async function pullLatest(){
  const binId = state.config.binId.trim();
  // meta=false como query param está soportado en Read API
  return await jsonbinFetch("GET", `/b/${binId}/latest?meta=false`, null);
}

async function pushLatest(db){
  const binId = state.config.binId.trim();
  return await jsonbinFetch("PUT", `/b/${binId}`, db);
}

/* ---------------- Merge (multi-device) ---------------- */

function mergeCollection(localArr, remoteArr){
  const map = new Map();

  const ingest = (rec) => {
    if(!rec || !rec.id) return;
    const prev = map.get(rec.id);
    if(!prev){
      map.set(rec.id, rec);
      return;
    }
    // gana el más nuevo por updatedAt
    if(t(rec.updatedAt) >= t(prev.updatedAt)) map.set(rec.id, rec);
  };

  (remoteArr || []).forEach(ingest);
  (localArr  || []).forEach(ingest);

  // mantenemos tombstones para que no “reviva” algo borrado
  return Array.from(map.values());
}

function mergeDb(local, remote){
  const L = normalizeDb(structuredClone(local));
  const R = normalizeDb(structuredClone(remote));

  const merged = normalizeDb({
    schemaVersion: Math.max(L.schemaVersion||1, R.schemaVersion||1),
    project: { ...(R.project||{}), ...(L.project||{}) },          // local pisa si cambiaste nombres/fechas
    catalog: { ...(R.catalog||{}), ...(L.catalog||{}) },
    vendors:   mergeCollection(L.vendors,   R.vendors),
    budget:    mergeCollection(L.budget,    R.budget),
    expenses:  mergeCollection(L.expenses,  R.expenses),
    payments:  mergeCollection(L.payments,  R.payments),
    documents: mergeCollection(L.documents, R.documents),
    audit:     [...(L.audit||[]), ...(R.audit||[])]
  });

  // meta: el “dueño” del merge es quien guarda
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
  if(!state.db) return;
  if(state.pushing) return;
  state.pushing = true;

  try{
    setStatus("Guardando…");

    // Pull antes de push para minimizar “pisadas”
    let remote = null;
    try { remote = await pullLatest(); } catch {}

    if(remote){
      state.db = mergeDb(state.db, remote);
    }

    bumpMeta(state.db);
    state.db.audit = state.db.audit || [];
    state.db.audit.unshift({ at: nowISO(), what:"autosave", by:getDeviceId() });

    await pushLatest(state.db);

    setDirty(false);
    setStatus("Sincronizado");
  }catch(e){
    // si te quedás sin requests o excedés tamaño, JSONBin lo devuelve como error
    setStatus(`Error: ${shortErr(e.message)} (guardado local)`);
    console.warn(e);
  }finally{
    state.pushing = false;
  }
}

function startAutoPull(){
  if(state.pullTimer) return;
  state.pullTimer = setInterval(async ()=>{
    if(!state.config.binId) return;
    if(state.pushing) return;

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

      // hay cambios locales y remotos: merge + push
      state.db = mergeDb(state.db, remote);
      setDirty(true); // dispara autoPush por debounce
      route();
      setStatus("Merge…");
    }catch(e){
      setStatus("Offline");
    }
  }, AUTO_PULL_INTERVAL_MS);
}

function shortErr(s){
  const x = String(s||"");
  if(x.length > 80) return x.slice(0,77) + "…";
  return x;
}

/* ---------------- UI / App ---------------- */

function remindConfig(){
  throw new Error("Config inválida (BIN_ID / Key).");
}

function ensureDb(){
  if(state.db) return true;
  view.innerHTML = `
    <div class="card">
      <h2>Sin datos todavía</h2>
      <p class="small">Estoy intentando cargar desde JSONBin automáticamente.</p>
      <div class="row">
        <button class="btn" id="retry">Reintentar sync</button>
        <button class="btn" id="createLocal">Crear proyecto local (no recomendado)</button>
      </div>
    </div>`;
  $("#retry").onclick = () => boot(true);
  $("#createLocal").onclick = async () => {
    const tpl = await fetch("./data/template.project.json").then(r=>r.json());
    state.db = normalizeDb(tpl);
    bumpMeta(state.db);
    setDirty(true);
    location.hash = "#/dashboard";
  };
  return false;
}

function route(){
  const hash = location.hash || "#/dashboard";
  const r = hash.replace("#/","").split("?")[0];

  document.querySelectorAll(".sidebar a").forEach(a=>{
    a.classList.toggle("active", a.dataset.route === r);
  });

  if(!ensureDb()) return;

  if(r === "dashboard") return renderDashboard();
  if(r === "budget") return renderBudget();
  if(r === "expenses") return renderExpenses();
  if(r === "vendors") return renderVendors();
  if(r === "payments") return renderPayments();
  if(r === "docs") return renderDocs();
  return renderDashboard();
}

/* --------- Renderers --------- */

function visible(arr){ return (arr||[]).filter(x=>x && x.deleted !== true); }

function renderDashboard(){
  const budget = visible(state.db.budget);
  const expenses = visible(state.db.expenses);
  const payments = visible(state.db.payments);

  const planned = budget.reduce((s,x)=>s+Number(x.planned||0),0);
  const actual = expenses.reduce((s,x)=>s+Number(x.amount||0),0);
  const diff = actual - planned;

  const today = new Date().toISOString().slice(0,10);
  const due = payments.filter(p => (p.status||"pending")!=="paid");
  const overdue = due.filter(p => (p.dueDate||"9999-12-31") < today);

  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <div>
          <h2>${escapeHtml(state.db.project?.name || "Proyecto")}</h2>
          <div class="small">
            Inicio: ${escapeHtml(state.db.project?.startDate || "—")} ·
            Días: ${escapeHtml(state.db.project?.numDays || 10)} ·
            Moneda: ${escapeHtml(state.db.project?.currency || "ARS")}
          </div>
        </div>
        <span class="badge">rev ${state.db._meta?.revision || 0}</span>
      </div>
    </div>

    <div class="card">
      <h3>KPIs</h3>
      <div class="kpi">
        <div class="box"><div class="small">Plan</div><div class="val">${money(planned)}</div></div>
        <div class="box"><div class="small">Real</div><div class="val">${money(actual)}</div></div>
        <div class="box"><div class="small">Desvío</div><div class="val">${money(diff)}</div></div>
        <div class="box"><div class="small">Vencidos</div><div class="val">${overdue.length}</div></div>
      </div>
      <p class="small">Si el desvío da positivo, el presupuesto se está tomando un taxi sin vos.</p>
    </div>

    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h3>Vencidos (top)</h3>
        <button class="btn" id="goPayments">Ver pagos</button>
      </div>
      ${renderPaymentsTableMini(overdue.slice(0,8))}
    </div>
  `;
  $("#goPayments").onclick = ()=> location.hash = "#/payments";
}

function renderPaymentsTableMini(list){
  if(!list.length) return `<div class="small">Nada vencido. Inusual, pero acepto.</div>`;
  const vendorsById = Object.fromEntries(visible(state.db.vendors).map(v=>[v.id,v]));
  const today = new Date().toISOString().slice(0,10);

  const rows = list.map(p=>{
    const v = vendorsById[p.vendorId]?.name || "—";
    const isOver = (p.dueDate||"9999-12-31") < today;
    const badge = p.status==="paid" ? "paid" : (isOver ? "over" : "due");
    return `<tr>
      <td>${p.dueDate||"—"}</td>
      <td>${escapeHtml(v)}</td>
      <td>${escapeHtml(p.concept||"—")}</td>
      <td>${money(p.amount||0)}</td>
      <td><span class="badge ${badge}">${escapeHtml(p.status||"pending")}</span></td>
    </tr>`;
  }).join("");

  return `<table>
    <thead><tr><th>Vence</th><th>Proveedor</th><th>Concepto</th><th>Monto</th><th>Estado</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderBudget(){
  const budget = visible(state.db.budget);
  const departments = state.db.catalog?.departments || [];
  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2>Presupuesto (Plan)</h2>
        <div class="row">
          <button class="btn" id="btnAdd">+ Ítem</button>
          <button class="btn" id="btnExport">Exportar JSON</button>
          <button class="btn" id="btnImport">Importar JSON</button>
        </div>
      </div>
      <div class="small">Auto-sync activado.</div>
    </div>

    <div class="card">
      <table>
        <thead>
          <tr><th>Depto</th><th>Rubro</th><th>Ítem</th><th>Plan</th><th>Notas</th><th></th></tr>
        </thead>
        <tbody>
          ${budget.map(b=>`
            <tr>
              <td>${escapeHtml(b.department||"—")}</td>
              <td>${escapeHtml(b.category||"—")}</td>
              <td>${escapeHtml(b.item||"—")}</td>
              <td>${money(b.planned||0)}</td>
              <td class="small">${escapeHtml(b.notes||"")}</td>
              <td><button class="btn" data-del="${b.id}">Borrar</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      ${budget.length? "" : `<div class="small">No hay ítems todavía.</div>`}
    </div>
  `;

  $("#btnAdd").onclick = () => openDialog("Nuevo ítem de presupuesto", `
    <div class="grid2">
      <div><label>Depto</label><select id="d_department">${departments.map(d=>`<option>${escapeHtml(d)}</option>`).join("")}</select></div>
      <div><label>Rubro</label><input id="d_category" placeholder="Ej: Alquiler cámaras"/></div>
    </div>
    <div class="grid2">
      <div><label>Ítem</label><input id="d_item" placeholder="Ej: Sony FX6 (2 días)"/></div>
      <div><label>Monto plan</label><input id="d_planned" type="number" step="0.01" placeholder="0"/></div>
    </div>
    <div><label>Notas</label><textarea id="d_notes" placeholder="Observaciones"></textarea></div>
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

  view.querySelectorAll("button[data-del]").forEach(btn=>{
    btn.onclick = () => {
      const id = btn.dataset.del;
      const rec = state.db.budget.find(x=>x.id===id);
      if(rec){
        rec.deleted = true;
        rec.updatedAt = nowISO();
        setDirty(true);
        renderBudget();
      }
    };
  });

  $("#btnExport").onclick = exportJson;
  $("#btnImport").onclick = importJson;
}

function renderExpenses(){
  const expenses = visible(state.db.expenses);
  const vendors = visible(state.db.vendors);
  const departments = state.db.catalog?.departments || [];
  const vendorsById = Object.fromEntries(vendors.map(v=>[v.id,v]));

  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2>Gastos reales</h2>
        <button class="btn" id="btnAdd">+ Gasto</button>
      </div>
      <div class="small">Auto-sync activado.</div>
    </div>

    <div class="card">
      <table>
        <thead><tr><th>Fecha</th><th>Proveedor</th><th>Depto</th><th>Concepto</th><th>Monto</th><th></th></tr></thead>
        <tbody>
          ${expenses.map(e=>`
            <tr>
              <td>${escapeHtml(e.date||"—")}</td>
              <td>${escapeHtml(vendorsById[e.vendorId]?.name || "—")}</td>
              <td>${escapeHtml(e.department||"—")}</td>
              <td>${escapeHtml(e.concept||"—")}</td>
              <td>${money(e.amount||0)}</td>
              <td><button class="btn" data-del="${e.id}">Borrar</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      ${expenses.length? "" : `<div class="small">No hay gastos cargados.</div>`}
    </div>
  `;

  $("#btnAdd").onclick = () => openDialog("Nuevo gasto real", `
    <div class="grid3">
      <div><label>Fecha</label><input id="d_date" type="date"/></div>
      <div><label>Proveedor</label>
        <select id="d_vendor">
          <option value="">—</option>
          ${vendors.map(v=>`<option value="${v.id}">${escapeHtml(v.name)}</option>`).join("")}
        </select>
      </div>
      <div><label>Depto</label>
        <select id="d_department">${departments.map(d=>`<option>${escapeHtml(d)}</option>`).join("")}</select>
      </div>
    </div>
    <div class="grid2">
      <div><label>Concepto</label><input id="d_concept" placeholder="Ej: Catering día 3"/></div>
      <div><label>Monto</label><input id="d_amount" type="number" step="0.01" placeholder="0"/></div>
    </div>
    <div><label>Notas</label><textarea id="d_notes"></textarea></div>
  `, () => {
    const rec = {
      id: uid("e"),
      updatedAt: nowISO(),
      deleted: false,
      date: $("#d_date").value,
      vendorId: $("#d_vendor").value,
      department: $("#d_department").value,
      concept: $("#d_concept").value.trim(),
      amount: Number($("#d_amount").value||0),
      notes: $("#d_notes").value.trim()
    };
    state.db.expenses.push(rec);
    setDirty(true);
    renderExpenses();
  });

  view.querySelectorAll("button[data-del]").forEach(btn=>{
    btn.onclick = () => {
      const id = btn.dataset.del;
      const rec = state.db.expenses.find(x=>x.id===id);
      if(rec){
        rec.deleted = true;
        rec.updatedAt = nowISO();
        setDirty(true);
        renderExpenses();
      }
    };
  });
}

function renderVendors(){
  const vendors = visible(state.db.vendors);
  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2>Proveedores</h2>
        <button class="btn" id="btnAdd">+ Proveedor</button>
      </div>
      <div class="small">Auto-sync activado.</div>
    </div>

    <div class="card">
      <table>
        <thead><tr><th>Nombre</th><th>Contacto</th><th>CUIT</th><th>Email</th><th>Tel</th><th></th></tr></thead>
        <tbody>
          ${vendors.map(v=>`
            <tr>
              <td>${escapeHtml(v.name||"—")}</td>
              <td>${escapeHtml(v.contact||"—")}</td>
              <td>${escapeHtml(v.cuit||"—")}</td>
              <td>${escapeHtml(v.email||"—")}</td>
              <td>${escapeHtml(v.phone||"—")}</td>
              <td><button class="btn" data-del="${v.id}">Borrar</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      ${vendors.length? "" : `<div class="small">No hay proveedores cargados.</div>`}
    </div>
  `;

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

  view.querySelectorAll("button[data-del]").forEach(btn=>{
    btn.onclick = () => {
      const id = btn.dataset.del;
      const rec = state.db.vendors.find(x=>x.id===id);
      if(rec){
        rec.deleted = true;
        rec.updatedAt = nowISO();
        setDirty(true);
        renderVendors();
      }
    };
  });
}

function renderPayments(){
  const payments = visible(state.db.payments);
  const vendors = visible(state.db.vendors);
  const vendorsById = Object.fromEntries(vendors.map(v=>[v.id,v]));
  const today = new Date().toISOString().slice(0,10);

  const pending = payments.filter(p => (p.status||"pending")!=="paid");
  const overdue = pending.filter(p => (p.dueDate||"9999-12-31") < today);

  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <div>
          <h2>Pagos</h2>
          <div class="small">Cronograma + “facturó / no facturó” + antigüedad de servicio.</div>
        </div>
        <button class="btn" id="btnAdd">+ Pago</button>
      </div>
      <div class="row">
        <span class="badge">Pendientes: ${pending.length}</span>
        <span class="badge over">Vencidos: ${overdue.length}</span>
      </div>
    </div>

    <div class="card">
      <table>
        <thead><tr><th>Servicio</th><th>Vence</th><th>Proveedor</th><th>Concepto</th><th>Monto</th><th>Factura</th><th>Estado</th><th></th></tr></thead>
        <tbody>
          ${payments.map(p=>{
            const v = vendorsById[p.vendorId]?.name || "—";
            const age = p.serviceDate ? daysBetween(p.serviceDate) : null;
            const invoice = p.invoiceNumber ? `#${escapeHtml(p.invoiceNumber)}` : (p.invoiced ? "Sí" : "No");
            const isOver = (p.status||"pending")!=="paid" && (p.dueDate||"9999-12-31") < today;
            const badge = p.status==="paid" ? "paid" : (isOver ? "over" : "due");
            const extra = (p.serviceDate && !p.invoiced) ? ` <span class="small">(${age} días sin facturar)</span>` : "";
            return `
              <tr>
                <td>${escapeHtml(p.serviceDate||"—")}${extra}</td>
                <td>${escapeHtml(p.dueDate||"—")}</td>
                <td>${escapeHtml(v)}</td>
                <td>${escapeHtml(p.concept||"—")}</td>
                <td>${money(p.amount||0)}</td>
                <td>${invoice}</td>
                <td><span class="badge ${badge}">${escapeHtml(p.status||"pending")}</span></td>
                <td>
                  <button class="btn" data-pay="${p.id}" data-action="togglePaid">${p.status==="paid"?"Pendiente":"Pagado"}</button>
                  <button class="btn" data-pay="${p.id}" data-action="del">Borrar</button>
                </td>
              </tr>`;
          }).join("")}
        </tbody>
      </table>
      ${payments.length? "" : `<div class="small">No hay pagos cargados.</div>`}
    </div>
  `;

  $("#btnAdd").onclick = () => openDialog("Nuevo pago", `
    <div class="grid3">
      <div><label>Proveedor</label>
        <select id="d_vendor">
          <option value="">—</option>
          ${vendors.map(v=>`<option value="${v.id}">${escapeHtml(v.name)}</option>`).join("")}
        </select>
      </div>
      <div><label>Servicio (fecha ejecución)</label><input id="d_serviceDate" type="date"/></div>
      <div><label>Vence</label><input id="d_dueDate" type="date"/></div>
    </div>
    <div class="grid2">
      <div><label>Concepto</label><input id="d_concept" placeholder="Ej: Alquiler luces día 2-4"/></div>
      <div><label>Monto</label><input id="d_amount" type="number" step="0.01"/></div>
    </div>
    <div class="grid3">
      <div><label>¿Facturó?</label>
        <select id="d_invoiced">
          <option value="false">No</option>
          <option value="true">Sí</option>
        </select>
      </div>
      <div><label>Nro Factura</label><input id="d_invoiceNumber" placeholder="0001-00001234"/></div>
      <div><label>Estado</label>
        <select id="d_status">
          <option value="pending">Pendiente</option>
          <option value="paid">Pagado</option>
        </select>
      </div>
    </div>
    <div><label>Notas</label><textarea id="d_notes"></textarea></div>
  `, () => {
    const rec = {
      id: uid("p"),
      updatedAt: nowISO(),
      deleted: false,
      vendorId: $("#d_vendor").value,
      serviceDate: $("#d_serviceDate").value,
      dueDate: $("#d_dueDate").value,
      concept: $("#d_concept").value.trim(),
      amount: Number($("#d_amount").value||0),
      invoiced: $("#d_invoiced").value === "true",
      invoiceNumber: $("#d_invoiceNumber").value.trim(),
      status: $("#d_status").value,
      notes: $("#d_notes").value.trim()
    };
    state.db.payments.push(rec);
    setDirty(true);
    renderPayments();
  });

  view.querySelectorAll("button[data-pay]").forEach(btn=>{
    btn.onclick = () => {
      const id = btn.dataset.pay;
      const act = btn.dataset.action;
      const rec = state.db.payments.find(p=>p.id===id);
      if(!rec) return;

      if(act==="del"){
        rec.deleted = true;
        rec.updatedAt = nowISO();
        setDirty(true);
        return renderPayments();
      }

      if(act==="togglePaid"){
        rec.status = (rec.status==="paid") ? "pending" : "paid";
        if(rec.status==="paid") rec.paidAt = new Date().toISOString().slice(0,10);
        rec.updatedAt = nowISO();
        setDirty(true);
        return renderPayments();
      }
    };
  });
}

function renderDocs(){
  const docs = visible(state.db.documents);
  const vendorsById = Object.fromEntries(visible(state.db.vendors).map(v=>[v.id,v]));

  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <div>
          <h2>Comprobantes</h2>
          <div class="small">Recomendado: guardá PDFs como link (Drive) y acá dejás el acceso.</div>
        </div>
        <button class="btn" id="btnAdd">+ Documento</button>
      </div>
    </div>

    <div class="card">
      <table>
        <thead><tr><th>Fecha</th><th>Proveedor</th><th>Tipo</th><th>Nombre</th><th>Link</th><th></th></tr></thead>
        <tbody>
          ${docs.map(d=>`
            <tr>
              <td>${escapeHtml(d.date||"—")}</td>
              <td>${escapeHtml(vendorsById[d.vendorId]?.name || "—")}</td>
              <td>${escapeHtml(d.type||"—")}</td>
              <td>${escapeHtml(d.name||"—")}</td>
              <td>${d.url ? `<a href="${d.url}" target="_blank" rel="noopener">Abrir</a>` : "—"}</td>
              <td><button class="btn" data-del="${d.id}">Borrar</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      ${docs.length? "" : `<div class="small">No hay documentos cargados.</div>`}
    </div>
  `;

  $("#btnAdd").onclick = () => openDialog("Nuevo documento (PDF por link)", `
    <div class="grid3">
      <div><label>Fecha</label><input id="d_date" type="date"/></div>
      <div><label>Proveedor</label>
        <select id="d_vendor">
          <option value="">—</option>
          ${visible(state.db.vendors).map(v=>`<option value="${v.id}">${escapeHtml(v.name)}</option>`).join("")}
        </select>
      </div>
      <div><label>Tipo</label>
        <select id="d_type">
          <option>Factura</option>
          <option>Recibo</option>
          <option>Contrato</option>
          <option>Remito</option>
          <option>Otro</option>
        </select>
      </div>
    </div>
    <div class="grid2">
      <div><label>Nombre</label><input id="d_name" placeholder="Ej: Factura Camauer día 2"/></div>
      <div><label>URL</label><input id="d_url" placeholder="https://..."/></div>
    </div>
  `, () => {
    const rec = {
      id: uid("d"),
      updatedAt: nowISO(),
      deleted: false,
      date: $("#d_date").value,
      vendorId: $("#d_vendor").value,
      type: $("#d_type").value,
      name: $("#d_name").value.trim(),
      url: $("#d_url").value.trim()
    };
    state.db.documents.push(rec);
    setDirty(true);
    renderDocs();
  });

  view.querySelectorAll("button[data-del]").forEach(btn=>{
    btn.onclick = () => {
      const id = btn.dataset.del;
      const rec = state.db.documents.find(x=>x.id===id);
      if(rec){
        rec.deleted = true;
        rec.updatedAt = nowISO();
        setDirty(true);
        renderDocs();
      }
    };
  });
}

/* --------- Dialog / Helpers --------- */

function openDialog(title, bodyHtml, onOk){
  dlgTitle.textContent = title;
  dlgBody.innerHTML = bodyHtml;
  dlgOk.onclick = async (ev) => {
    ev.preventDefault();
    try{
      await onOk();
      dlg.close();
    }catch(e){
      alert(e.message);
    }
  };
  dlg.showModal();
}

function escapeHtml(s){
  return String(s||"")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;");
}

function exportJson(){
  if(!state.db) return;
  const blob = new Blob([JSON.stringify(state.db, null, 2)], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${(state.db.project?.name||"proyecto").replaceAll(" ","_")}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function importJson(){
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json";
  input.onchange = async () => {
    const f = input.files?.[0];
    if(!f) return;
    const txt = await f.text();
    const obj = normalizeDb(JSON.parse(txt));
    state.db = obj;
    bumpMeta(state.db);
    setDirty(true);
    route();
  };
  input.click();
}

/* ---------------- Boot ---------------- */

async function boot(force=false){
  setStatus("Conectando…");
  try{
    if(force || !state.db){
      const remote = await pullLatest();
      state.db = normalizeDb(remote);
      setDirty(false);
      route();
    }
    setStatus("Sincronizado");
  }catch(e){
    setStatus("Offline (usando local)");
    route();
  }finally{
    startAutoPull();
  }
}

window.addEventListener("hashchange", route);

$("#btnSync").onclick = async () => {
  await boot(true);
};

$("#btnSave").onclick = async () => {
  // Forzar guardado inmediato
  if(state.pushTimer) clearTimeout(state.pushTimer);
  await autoPush();
};

route();
boot(false);
