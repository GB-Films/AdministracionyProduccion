/* =========
   Menú data-driven (fácil de editar)
========= */

const MENU = {
  title: "Accesos rápidos",
  subtitle: "Elegí una sección para ver opciones y abrir información.",
  items: [
    {
      id: "proveedores",
      title: "Instructivo Proveedores",
      desc: "Alta, contratos y facturación.",
      badge: "Proveedores",
      badgeAlt: false,
      children: {
        title: "Instructivo Proveedores",
        subtitle: "Elegí una opción.",
        items: [
          { id: "alta", title: "Alta como Proveedores", desc: "Paso a paso (placeholder por ahora).", badge: "Abrir", modal: { title: "Alta como Proveedores", kicker: "Proveedores", body: placeholderText("Alta como Proveedores") } },
          { id: "contratos", title: "Contratos", desc: "Modelos, firma y flujo (placeholder).", badge: "Abrir", modal: { title: "Contratos", kicker: "Proveedores", body: placeholderText("Contratos") } },
          { id: "facturacion", title: "Facturación", desc: "Requisitos y envío (placeholder).", badge: "Abrir", modal: { title: "Facturación", kicker: "Proveedores", body: placeholderText("Facturación") } },
        ]
      }
    },
    {
      id: "produccion",
      title: "Instructivo Jefes/as de Producción",
      desc: "Rendición, mail y accesos a nubes.",
      badge: "Producción",
      badgeAlt: true,
      children: {
        title: "Instructivo Jefes/as de Producción",
        subtitle: "Elegí una opción.",
        items: [
          { id: "rendicion", title: "Como Realizar Rendición", desc: "Checklist (placeholder).", badge: "Abrir", modal: { title: "Como Realizar Rendición", kicker: "Producción", body: placeholderText("Como Realizar Rendición") } },
          { id: "mail", title: "Armado Mail Rendición", desc: "Plantilla (placeholder).", badge: "Abrir", modal: { title: "Armado Mail Rendición", kicker: "Producción", body: placeholderText("Armado Mail Rendición") } },
          { id: "nubes", title: "Links a Nubes", desc: "Accesos rápidos (placeholder).", badge: "Abrir", modal: { title: "Links a Nubes", kicker: "Producción", body: placeholderLinks() } },
        ]
      }
    },
    {
      id: "empresa",
      title: "Datos empresa",
      desc: "Copiá datos individuales o todo junto.",
      badge: "Copiar",
      badgeAlt: false,
      action: "companyData"
    }
  ]
};

/* =========
   Estado + DOM
========= */
const menuGrid = document.getElementById("menuGrid");
const screenTitle = document.getElementById("screenTitle");
const screenSubtitle = document.getElementById("screenSubtitle");
const backBtn = document.getElementById("backBtn");
const homeBtn = document.getElementById("homeBtn");

const overlay = document.getElementById("modalOverlay");
const modalClose = document.getElementById("modalClose");
const modalTitle = document.getElementById("modalTitle");
const modalKicker = document.getElementById("modalKicker");
const modalBody = document.getElementById("modalBody");
const modalPrimary = document.getElementById("modalPrimary");
const modalSecondary = document.getElementById("modalSecondary");
const toast = document.getElementById("toast");

let stack = [MENU]; // stack de pantallas

/* =========
   Render
========= */
function renderCurrent(){
  const current = stack[stack.length - 1];
  screenTitle.textContent = current.title || "Menú";
  screenSubtitle.textContent = current.subtitle || "";

  backBtn.classList.toggle("hidden", stack.length <= 1);

  menuGrid.innerHTML = "";
  (current.items || []).forEach(item => {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "tile";
    tile.innerHTML = `
      <div class="tileTop">
        <div class="tileTitle">${escapeHtml(item.title)}</div>
        <div class="badge ${item.badgeAlt ? "alt" : ""}">${escapeHtml(item.badge || "Abrir")}</div>
      </div>
      <div class="tileDesc">${escapeHtml(item.desc || "")}</div>
    `;

    tile.addEventListener("click", () => onItemClick(item));
    menuGrid.appendChild(tile);
  });
}

function onItemClick(item){
  // Caso: abre submenú
  if (item.children){
    stack.push(item.children);
    renderCurrent();
    return;
  }

  // Caso: acción datos empresa
  if (item.action === "companyData"){
    openCompanyDataModal();
    return;
  }

  // Caso: modal genérico
  if (item.modal){
    openModal({
      title: item.modal.title,
      kicker: item.modal.kicker,
      bodyHtml: item.modal.body
    });
    return;
  }

  // Fallback
  openModal({
    title: item.title,
    kicker: "Info",
    bodyHtml: placeholderText(item.title)
  });
}

/* =========
   Modal
========= */
function openModal({ title, kicker, bodyHtml, primary, secondary }){
  modalTitle.textContent = title || "Detalle";
  modalKicker.textContent = kicker || "Detalle";
  modalBody.innerHTML = bodyHtml || "<p>Sin contenido.</p>";

  setupModalButtons(primary, secondary);

  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeModal(){
  overlay.classList.add("hidden");
  overlay.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  modalBody.innerHTML = "";
  setupModalButtons(null, null);
}

function setupModalButtons(primary, secondary){
  // Primary
  if (primary && typeof primary.onClick === "function"){
    modalPrimary.classList.remove("hidden");
    modalPrimary.textContent = primary.label || "Acción";
    modalPrimary.onclick = primary.onClick;
  } else {
    modalPrimary.classList.add("hidden");
    modalPrimary.onclick = null;
  }

  // Secondary
  if (secondary && typeof secondary.onClick === "function"){
    modalSecondary.classList.remove("hidden");
    modalSecondary.textContent = secondary.label || "Cerrar";
    modalSecondary.onclick = secondary.onClick;
  } else {
    modalSecondary.classList.add("hidden");
    modalSecondary.onclick = null;
  }
}

/* =========
   Datos empresa (copiar uno o todos)
========= */
const COMPANY = [
  { key: "Razón Social", value: "Gran Berta SRL" },
  { key: "CUIT", value: "33715736549" },
  { key: "IVA", value: "Responsable Inscripto" }
];

function openCompanyDataModal(){
  const rows = COMPANY.map((row, idx) => `
    <div class="dataRow">
      <div class="dataLeft">
        <div class="dataKey">${escapeHtml(row.key)}</div>
        <div class="dataVal" id="val-${idx}">${escapeHtml(row.value)}</div>
      </div>
      <button class="copyBtn" type="button" data-copy="${idx}">Copiar</button>
    </div>
  `).join("");

  const body = `
    <p>Copiá un dato puntual o llevate todo junto en un solo copy/paste.</p>
    <div class="dataGrid">${rows}</div>
  `;

  openModal({
    title: "Datos empresa",
    kicker: "Empresa",
    bodyHtml: body,
    primary: {
      label: "Copiar todo",
      onClick: async () => {
        const all = COMPANY.map(r => `${r.key}: ${r.value}`).join("\n");
        await copyText(all);
        showToast("Copiado: todos los datos");
      }
    },
    secondary: {
      label: "Cerrar",
      onClick: closeModal
    }
  });

  // Delegación de eventos para botones copiar
  modalBody.querySelectorAll("[data-copy]").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      const i = Number(e.currentTarget.getAttribute("data-copy"));
      const row = COMPANY[i];
      await copyText(row.value);
      showToast(`Copiado: ${row.key}`);
    });
  });
}

/* =========
   Helpers
========= */
function placeholderText(sectionTitle){
  return `
    <p><strong>${escapeHtml(sectionTitle)}</strong></p>
    <p>Este contenido es de prueba por ahora. Acá después pegamos el instructivo real, links, PDFs o lo que necesites.</p>
    <p style="color: #8a97b3; margin-top: 10px;">(Sí, es placeholder. Mejor eso que inventar cosas y después llorar.)</p>
  `;
}

function placeholderLinks(){
  return `
    <p>Acá podés poner links a Drive, Dropbox, Frame.io, etc.</p>
    <div class="dataGrid">
      <div class="dataRow">
        <div class="dataLeft">
          <div class="dataKey">Carpeta principal</div>
          <div class="dataVal">https://ejemplo.com/carpeta</div>
        </div>
        <button class="copyBtn" type="button" data-copylink="0">Copiar link</button>
      </div>

      <div class="dataRow">
        <div class="dataLeft">
          <div class="dataKey">Planillas</div>
          <div class="dataVal">https://ejemplo.com/planillas</div>
        </div>
        <button class="copyBtn" type="button" data-copylink="1">Copiar link</button>
      </div>
    </div>
  `;
}

async function copyText(text){
  try{
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback viejo pero útil
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
}

let toastTimer = null;
function showToast(message){
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 2000);
}

function escapeHtml(str){
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* =========
   Navegación
========= */
backBtn.addEventListener("click", () => {
  if (stack.length > 1) stack.pop();
  renderCurrent();
});

homeBtn.addEventListener("click", () => {
  stack = [MENU];
  renderCurrent();
  closeModal();
});

/* =========
   Cerrar modal
========= */
modalClose.addEventListener("click", closeModal);
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !overlay.classList.contains("hidden")) closeModal();
});

/* =========
   Init
========= */
renderCurrent();

// Soporte copiar links placeholder (si abrís el modal de nubes)
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-copylink]");
  if (!btn) return;
  const row = btn.closest(".dataRow");
  const val = row?.querySelector(".dataVal")?.textContent?.trim();
  if (val){
    await copyText(val);
    showToast("Copiado: link");
  }
});
