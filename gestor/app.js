// A API fica na raiz do projeto (/api/gas), independentemente da pasta
// onde o HTML está hospedado (ex.: /gestor/). Por isso usamos caminho absoluto.
const API_BASE = "/api/gas";

  // Controlo de cache manual e chamadas de API
  function apiFetch(params, options){
    const url = API_BASE + '?' + params + '&_t=' + Date.now();
    return fetch(url, Object.assign({ cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } }, options || {}));
  }

  // Igual ao fetch(API_BASE + '?action=X', {method:'POST', ...}) que já existia
  // pelo projeto — helper para não repetir headers/JSON.stringify em cada chamada.
  function apiPost(action, payload){
    return fetch(API_BASE + '?action=' + encodeURIComponent(action), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
  }

  const LOGO_SRC = "/logo lsg.png";
  let LOGO_DATAURL = "";
  let registros = [];
  let registrosFiltrados = [];
  let feriasServidor = []; // Guarda as informações da planilha "Ferias" do Google Sheets

  /* ====================================================
   * LSG SKY CHEFS — LOGO EMBUTIDO (SVG) COMO FALLBACK GARANTIDO
   * Usado no PDF se lsg sky chefs logo.png não estiver acessível
   * ==================================================== */
  // window._LOGO_FALLBACK_B64 é resolvido no momento do uso (após lazy load via logo_b64.js)

  /* ====================================================
   * INSTRUTORES DO TREINAMENTO
   * As células de assinatura são desenhadas como campos em branco
   * pelo jsPDF (linha clássica de assinatura)
   * ==================================================== */
  const PDF_INSTRUTORES = [
    {
      nome: 'Vitor Hugo Teixeira da Silva',
      cargo: 'Supervisor de Segurança / LSA AVSEC / Ramp Safety Owner',
      matricula: '15623',
      assinatura: null
    },
    {
      nome: 'Francinele Ribeiro Machado',
      cargo: 'Assistente Administrativo / DLSA AVSEC / Ramp Safety Deputy',
      matricula: '16977',
      assinatura: null
  },
];

// Imagem de assinaturas dos instrutores embutida diretamente no código
// window._ASSINATURAS_IMG_B64 é resolvido no momento do uso (após lazy load via assin_b64.js)

// Pré-carregamento do logo assim que a página abre (para o PDF não precisar esperar)
let _logoLoadPromise = null;
function loadLogoAsDataURL(){
  if (_logoLoadPromise) return _logoLoadPromise;
  // Logo real já embutido como window._LOGO_FALLBACK_B64 — resolve imediatamente (sem esperar rede)
  LOGO_DATAURL = window._LOGO_FALLBACK_B64;
  _logoLoadPromise = Promise.resolve(LOGO_DATAURL);
  // Tentativa silenciosa de usar o ficheiro externo se disponível no servidor
  fetch(LOGO_SRC, { cache: 'force-cache' })
    .then(r => r.ok ? r.blob() : Promise.reject())
    .then(blob => new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    }))
    .then(dataUrl => { if (dataUrl) LOGO_DATAURL = dataUrl; })
    .catch(() => { /* logo embutido já está em LOGO_DATAURL */ });
  return _logoLoadPromise;
}
loadLogoAsDataURL();

document.getElementById('btnBuscar').addEventListener('click', buscar);
document.getElementById('btnPDF').addEventListener('click', gerarPDF);
document.getElementById('btnXLS').addEventListener('click', gerarXLS);
document.getElementById('btnAddFunc').addEventListener('click', novoFuncionarioViaPrompt);
document.getElementById('btnDelFunc').addEventListener('click', excluirFuncionarioViaPrompt);

['fMat','fNome','fDataInicio','fDataFinal','fSemanaTitulo'].forEach(id=>{
  const el = document.getElementById(id); 
  if(!el) return; 
  el.addEventListener('keydown', e=>{ if(e.key === 'Enter'){ e.preventDefault(); buscar(); } });
});

// Configuração dos Inputs de Data com suporte a Calendário Nativo
function setupDatePicker(textId, nativeId, calBtnId){
  const txt    = document.getElementById(textId);
  const native = document.getElementById(nativeId);
  const btn    = document.getElementById(calBtnId);
  if (!txt || !native || !btn) return;

  // Aplicar máscara dd/mm/aaaa dinamicamente ao digitar
  txt.addEventListener('input', function(){
    let v = this.value.replace(/\D/g, '');
    if (v.length > 8) v = v.slice(0, 8);
    if      (v.length >= 5) this.value = v.slice(0, 2) + '/' + v.slice(2, 4) + '/' + v.slice(4);
    else if (v.length >= 3) this.value = v.slice(0, 2) + '/' + v.slice(2);
    else                    this.value = v;
  });

  // Abrir o datepicker nativo invisível ao clicar no ícone do calendário
  btn.addEventListener('click', function(){
    const m = txt.value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) native.value = `${m[3]}-${m[2]}-${m[1]}`;
    native.showPicker ? native.showPicker() : native.click();
  });

  // Sincronizar o valor selecionado no nativo de volta para o input formatado
  native.addEventListener('change', function(){
    if (!this.value) return;
    const [y, mo, d] = this.value.split('-');
    txt.value = `${d}/${mo}/${y}`;
  });
}

setupDatePicker('fDataInicio', 'fDataInicioNative', 'btnCalInicio');
setupDatePicker('fDataFinal',  'fDataFinalNative',  'btnCalFinal');

['fDataInicio','fDataFinal'].forEach(id => {
  document.getElementById(id)?.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); buscar(); } });
});

// Gestão de chamadas paralelas de API em cache para evitar sobrecarga no servidor
const _apiCache = {};
function _cachedFetch(action){
  if (!_apiCache[action]) {
    _apiCache[action] = apiFetch('action=' + action)
      .then(r => r.ok ? r.json().catch(() => null) : null)
      .catch(() => null);
  }
  return _apiCache[action];
}

// Igual a _cachedFetch, mas devolve também se a chamada realmente teve
// sucesso (para não confundir "sem dados" com "a busca falhou").
const _apiCacheComStatus = {};
function _cachedFetchComStatus(action){
  if (!_apiCacheComStatus[action]) {
    _apiCacheComStatus[action] = apiFetch('action=' + action)
      .then(async r => {
        if (!r.ok) return { ok: false, json: null };
        const j = await r.json().catch(() => null);
        return { ok: !!(j && j.ok !== false), json: j };
      })
      .catch(() => ({ ok: false, json: null }));
  }
  return _apiCacheComStatus[action];
}

// NOTA: nenhuma chamada à API é feita automaticamente ao abrir a página.
// Os dados (treinamentos/registos/funcionários/férias) só são carregados
// quando o usuário interage com os filtros e clica em "Pesquisar"/"Atualizar".

// Descompactação das estruturas JSON retornadas pela API (GAS)
function _parseRows(json){
  if (Array.isArray(json))         return json;
  if (Array.isArray(json?.data))   return json.data;
  if (Array.isArray(json?.result)) return json.result;
  if (typeof json === 'object' && json){
    const v = Object.values(json).find(v => Array.isArray(v)); 
    if (v) return v;
  }
  return [];
}

// Auxiliar para a geração das opções (Dropdown) dos títulos e semanas
function _buildTituloOpts(mapaISO, prefixOpt){
  return prefixOpt + [...mapaISO.entries()]
    .sort((a,b)=>{ 
      const pa = dashParseSemanaISO(a[1]), pb = dashParseSemanaISO(b[1]); 
      if(pa.year !== pb.year) return pb.year - pa.year; 
      return pb.week - pa.week; 
    })
    .map(([t]) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
}

// Carrega o catálogo de Semanas/Títulos (treinamentos + registos) e popula
// os dropdowns "Título do Vídeo" (Principal), "Tema / Vídeo" (Dashboard) e
// o select oculto de Semana ISO do Dashboard. Esta é a ÚNICA carga
// automática feita ao abrir a página — os dados pesados (resultados da
// pesquisa, KPIs do Dashboard, férias) continuam sendo carregados apenas
// quando o usuário clicar em "Pesquisar"/"Atualizar".
//
// Os dropdowns usam "treinamentos" (catálogo oficial, leve — poucas dezenas
// de linhas) para aparecer quase instantaneamente. Em seguida, em segundo
// plano, complementamos com "registros" (pode ter semanas mais antigas que
// já saíram do catálogo) — mas SEM bloquear a exibição inicial, já que esse
// é o dataset pesado (1700+ linhas) que antes fazia o dropdown demorar
// dezenas de segundos para aparecer.
let _catalogoCarregado = false;
let _catalogoComplementado = false;

function _popularSelectsCatalogo(mapaISO, isoSet){
  if (mapaISO.size) {
    const opts = _buildTituloOpts(mapaISO, '');

    const selP = document.getElementById('fSemanaTitulo');
    const selAtualP = selP.value;
    selP.innerHTML = '<option value="">Selecione uma semana</option>' + opts;
    if (selAtualP && [...selP.options].some(o => o.value === selAtualP)) selP.value = selAtualP;

    const selD = document.getElementById('dashTitulo');
    const selAtualD = selD.value;
    selD.innerHTML = '<option value="">Selecione um título...</option>' + opts;
    if (selAtualD && [...selD.options].some(o => o.value === selAtualD)) selD.value = selAtualD;
  }

  if (isoSet.size) {
    const isoList = [...isoSet].sort(dashCompareSemanaISODesc);
    const selIso = document.getElementById('dashSemanaIso');
    if (selIso) selIso.innerHTML = '<option value="">Selecione...</option>' + isoList.map(sem => `<option value="${escapeHtml(sem)}">${escapeHtml(sem)}</option>`).join('');
  }
}

function _extrairTituloISO(rows, campoTitulo, mapaISO, isoSet){
  rows.forEach(r => {
    const t = String((campoTitulo ? r[campoTitulo] : (r.TituloVideo ?? r.Titulo ?? r.titulo)) ?? '').trim();
    const iso = String(r.SemanaISO ?? '').trim();
    if (t && !mapaISO.has(t)) mapaISO.set(t, iso);
    else if (t && iso && !mapaISO.get(t)) mapaISO.set(t, iso);
    if (iso) isoSet.add(iso);
  });
}

async function carregarCatalogoSemanas(){
  if (_catalogoCarregado) return;

  const normF = s => String(s??'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const exactos = ['Titulo','titulo','TITULO','Title','title','TituloVideo','titulovideo'];
  const mapaISO = new Map();
  const isoSet = new Set();

  // ── Etapa 1 (rápida): só o catálogo oficial de treinamentos ────────────
  try {
    const jTrein = await _cachedFetch('treinamentos');
    const rows1 = _parseRows(jTrein);
    const chaves = Object.keys(rows1[0]||{});
    const campo = exactos.find(c => chaves.includes(c)) ?? chaves.find(k => normF(k).includes('titul')) ?? null;
    if (campo) _extrairTituloISO(rows1, campo, mapaISO, isoSet);
  } catch(e){}

  _popularSelectsCatalogo(mapaISO, isoSet);
  _catalogoCarregado = mapaISO.size > 0;

  // ── Etapa 2 (em segundo plano): complementa com semanas antigas que só
  // existem em "registros" e não estão mais no catálogo. Não bloqueia nada
  // que já foi mostrado na etapa 1 — só adiciona opções extras se achar.
  if (_catalogoComplementado) return;
  _catalogoComplementado = true;
  try {
    const jRegs = await _cachedFetch('registros');
    const antesDoTamanho = mapaISO.size;
    _extrairTituloISO(_parseRows(jRegs), null, mapaISO, isoSet);
    if (mapaISO.size !== antesDoTamanho) _popularSelectsCatalogo(mapaISO, isoSet);
  } catch(e){}
}

// Carrega o catálogo imediatamente (fire-and-forget)
carregarCatalogoSemanas();

// Caso a primeira tentativa falhe (ex.: instabilidade de rede no momento do
// load), tenta novamente na primeira interação do usuário com os campos.
(function initFiltroTitulo(){
  const selP = document.getElementById('fSemanaTitulo');
  const selD = document.getElementById('dashTitulo');
  const btnP = document.getElementById('fSemanaTituloBtn'); // botão do dropdown customizado que substitui a interação direta com selP
  [selP, selD, btnP].forEach(sel => {
    if (!sel) return;
    sel.addEventListener('focus', carregarCatalogoSemanas, { once: true });
    sel.addEventListener('mousedown', carregarCatalogoSemanas, { once: true });
  });
})();

// ── Dropdown customizado para o <select id="fSemanaTitulo"> ───────────────
// O <select> nativo continua no DOM e funcionando normalmente por baixo
// (é nele que carregarCatalogoSemanas/_popularSelectsCatalogo escrevem as
// opções via innerHTML, e é dele que buscar() lê o .value) — só a interação
// visual passa a ser feita por este botão + lista, que são elementos HTML
// comuns e por isso acompanham corretamente qualquer zoom/escala aplicado
// por quem incorpora esta página (ex.: o hub "Central de Dashboards").
function enhanceSelectAsCustomDropdown(selectId, btnId, labelId, listId){
  const select = document.getElementById(selectId);
  const btn    = document.getElementById(btnId);
  const label  = document.getElementById(labelId);
  const list   = document.getElementById(listId);
  if (!select || !btn || !label || !list) return;

  function syncLabel(){
    const opt = select.options[select.selectedIndex];
    label.textContent = opt ? opt.textContent : '';
  }

  function buildList(){
    list.innerHTML = '';
    Array.from(select.options).forEach(opt => {
      const item = document.createElement('div');
      item.className = 'dss-custom-select-option' + (opt.value === select.value ? ' is-selected' : '');
      item.textContent = opt.textContent;
      item.setAttribute('role', 'option');
      item.dataset.value = opt.value;
      item.addEventListener('click', () => {
        select.value = opt.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        syncLabel();
        closeList();
      });
      list.appendChild(item);
    });
  }

  function openList(){ buildList(); list.classList.remove('hidden'); btn.setAttribute('aria-expanded', 'true'); }
  function closeList(){ list.classList.add('hidden'); btn.setAttribute('aria-expanded', 'false'); }

  btn.addEventListener('click', e => { e.stopPropagation(); list.classList.contains('hidden') ? openList() : closeList(); });
  document.addEventListener('click', e => { if (!list.contains(e.target) && e.target !== btn) closeList(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeList(); });

  // Sempre que carregarCatalogoSemanas/_popularSelectsCatalogo reescrever as
  // <option> do select nativo, atualiza a legenda exibida e (se estiver
  // aberta) reconstrói a lista customizada para refletir o novo conteúdo.
  new MutationObserver(() => { syncLabel(); if (!list.classList.contains('hidden')) buildList(); })
    .observe(select, { childList: true });

  syncLabel();
}

enhanceSelectAsCustomDropdown('fSemanaTitulo', 'fSemanaTituloBtn', 'fSemanaTituloLabel', 'fSemanaTituloList');

// ── Botão "Limpar Filtros" (aba Principal) ─────────────────────────────────
// Restaura os campos de pesquisa e a tabela de resultados ao estado inicial.
document.getElementById('btnLimparFiltros')?.addEventListener('click', () => {
  document.getElementById('fMat').value = '';
  document.getElementById('fNome').value = '';

  const selTitulo = document.getElementById('fSemanaTitulo');
  if (selTitulo) { selTitulo.value = ''; selTitulo.dispatchEvent(new Event('change', { bubbles: true })); }

  document.getElementById('fDataInicio').value = '';
  document.getElementById('fDataFinal').value = '';
  const dIniNat = document.getElementById('fDataInicioNative'); if (dIniNat) dIniNat.value = '';
  const dFimNat = document.getElementById('fDataFinalNative');  if (dFimNat) dFimNat.value = '';

  registros = [];
  registrosFiltrados = [];
  const tbody = document.getElementById('tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="px-6 py-10 text-center text-slate-400">Efetue uma pesquisa para visualizar os registos.</td></tr>';
  renderTemasAbordados('temasAbordados', []);
  renderPerguntasAbordadas('perguntasAbordadas', []);

  const status = document.getElementById('status');
  if (status) status.innerHTML = '';

  document.getElementById('fMat').focus();
});




// Lógica principal de pesquisa de registos
async function buscar(){
  const status = document.getElementById('status');
  const btnBuscar = document.getElementById('btnBuscar');
  const textoOriginalBuscar = btnBuscar ? btnBuscar.innerHTML : '';
  status.innerHTML = '<div class="text-sky-600 bg-sky-50 px-4 py-2.5 rounded-lg border border-sky-100">A pesquisar...</div>';
  if (btnBuscar) { btnBuscar.disabled = true; btnBuscar.innerHTML = '<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"></path></svg> A pesquisar...'; }

  const fMat = document.getElementById('fMat').value.trim();
  const fNome = document.getElementById('fNome').value.trim();
  const fTitulo = document.getElementById('fSemanaTitulo').value.trim();
  const fDataI = document.getElementById('fDataInicio').value;
  const fDataF = document.getElementById('fDataFinal').value;

  const qs = new URLSearchParams({ action: 'registros' });
  if (fMat) qs.append('matricula', fMat);
  if (fNome) qs.append('nome', fNome);
  if (fTitulo) qs.append('titulo', fTitulo);
  if (fDataI) qs.append('dataInicial', fDataI);
  if (fDataF) qs.append('dataFinal', fDataF);

  try {
    const res = await apiFetch(qs.toString());
    let data; 
    try { data = await res.json(); } catch { data = { ok: false, error: 'Resposta não-JSON do proxy' }; }
    if (!data.ok) throw new Error(data.error || 'Erro na pesquisa');
    registros = Array.isArray(data.data) ? data.data : [];

    // O backend (ação "registros" no Code.gs) já filtra por matrícula, nome,
    // título/semana e pelo intervalo de datas (dataInicial/dataFinal) antes
    // de devolver os registos — não é preciso (e chegou a ser prejudicial)
    // refazer esse filtro de datas aqui no navegador: a versão anterior
    // comparava o Timestamp usando um fuso (UTC) diferente do usado pelo
    // backend para montar o intervalo (horário local), o que descartava por
    // engano registos feitos à tarde/noite mesmo estando dentro do período
    // pesquisado — dava a impressão de que "buscar por data" não funcionava.
    let lista = registros;

    const mapa = new Map();
    for (const r of lista){
      const chave = `${r.Matricula ?? ''}__${r.SemanaISO ?? ''}__${r.TituloVideo ?? ''}`;
      const atual = mapa.get(chave);
      const novoTS = parseTimestamp(r.Timestamp);
      if (!atual) mapa.set(chave, r);
      else { 
        const antigoTS = parseTimestamp(atual.Timestamp); 
        if (novoTS && antigoTS && novoTS < antigoTS) mapa.set(chave, r); 
      }
    }

    registrosFiltrados = Array.from(mapa.values()).sort((a,b) => String(a.Nome ?? '').localeCompare(String(b.Nome ?? ''), 'pt-PT', { sensitivity: 'base' }));
    renderTabela(registrosFiltrados);
    status.innerHTML = '<div class="text-emerald-600 font-semibold bg-emerald-50 px-4 py-2.5 rounded-lg border border-emerald-100">Pesquisa concluída: ' + registrosFiltrados.length + ' registo(s) encontrado(s).</div>';

    // Exibir os Temas Abordados da(s) semana(s) presente(s) nos resultados
    try {
      const temas = await buscarAssuntosPorSemana(registrosFiltrados);
      renderTemasAbordados('temasAbordados', temas);
    } catch(e) {
      renderTemasAbordados('temasAbordados', []);
    }

    // Exibir as Perguntas do Quiz da(s) semana(s) presente(s) nos resultados
    try {
      const perguntasBlocos = await buscarPerguntasPorSemana(registrosFiltrados);
      renderPerguntasAbordadas('perguntasAbordadas', perguntasBlocos);
    } catch(e) {
      renderPerguntasAbordadas('perguntasAbordadas', []);
    }
  } catch(err){ 
    status.innerHTML = '<div class="text-rose-600 font-semibold bg-rose-50 px-4 py-2.5 rounded-lg border border-rose-100">Falha ao processar a consulta: ' + (err.message || '') + '</div>'; 
    renderTemasAbordados('temasAbordados', []);
    renderPerguntasAbordadas('perguntasAbordadas', []);
  } finally {
    if (btnBuscar) { btnBuscar.disabled = false; btnBuscar.innerHTML = textoOriginalBuscar; }
  }
}

// Renderização da tabela de registos no ecrã principal
function renderTabela(list){
  const tbody = document.getElementById('tbody');
  tbody.innerHTML = '';
  if (!list || list.length === 0){ 
    tbody.innerHTML = '<tr><td colspan="6" class="px-6 py-10 text-center text-slate-400">Sem registos encontrados para os filtros aplicados.</td></tr>'; 
    return; 
  }
  tbody.innerHTML = list.map(r => {
    const dataPart = formatTimestamp(r.Timestamp);
    return `
      <tr class="hover:bg-slate-50 transition-colors">
        <td class="px-6 py-4 whitespace-nowrap font-medium text-slate-900">${escapeHtml(r.Matricula ?? '')}</td>
        <td class="px-6 py-4 whitespace-nowrap">${escapeHtml(r.Nome ?? '')}</td>
        <td class="px-6 py-4 whitespace-nowrap">${escapeHtml(r.Setor ?? '')}</td>
        <td style="display:none">${escapeHtml(r.SemanaISO ?? '')}</td>
        <td class="px-6 py-4 max-w-xs truncate" title="${escapeHtml(r.TituloVideo ?? '')}">${escapeHtml(r.TituloVideo ?? '')}</td>
        <td class="px-6 py-4 whitespace-nowrap">${escapeHtml(dataPart)}</td>
      </tr>`;
  }).join('');
}

// ─── Lazy loaders: as bibliotecas de exportação só são baixadas quando ───
// ─── o usuário realmente clicar em "Exportar Excel" ou "Gerar PDF".    ───
// ─── Isso elimina ~1,4 MB de scripts bloqueantes do carregamento inicial. ─

function _loadScript(src){
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Falha ao carregar: ' + src));
    document.head.appendChild(s);
  });
}

async function _ensureXLSX(){
  if (window.XLSX) return;
  await _loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
}

// Rastreia se os scripts b64 já foram carregados com sucesso
let _b64Loaded = false;

async function _ensureJsPDF(){
  // Carrega jsPDF se ainda não disponível
  if (!window.jspdf) {
    await _loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js');
  }

  // autoTable deve ser carregado DEPOIS do jsPDF e só uma vez
  const testDoc = window.jspdf && new window.jspdf.jsPDF();
  if (!testDoc || typeof testDoc.autoTable !== 'function') {
    await _loadScript('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js');
  }

  // Carrega logo_b64.js e assin_b64.js da raiz do site
  // Usa caminhos absolutos a partir da raiz — os arquivos estão na raiz do repositório
  if (!_b64Loaded) {
    await Promise.all([
      _loadScriptForce('/gestor/logo_b64.js'),
      _loadScriptForce('/gestor/assin_b64.js'),
    ]);
    _b64Loaded = !!(window._LOGO_FALLBACK_B64 && window._ASSINATURAS_IMG_B64);
  }
}

// Versão de _loadScript que SEMPRE recarrega (remove tag anterior se existir)
// — necessário quando um script falhou na carga anterior
function _loadScriptForce(src){
  return new Promise((resolve, reject) => {
    // Remover tag antiga (pode ter falhado)
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) existing.remove();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Falha ao carregar: ' + src));
    document.head.appendChild(s);
  });
}

// Exportação em Excel (SheetJS)
async function gerarXLS(){
  const base = (registrosFiltrados && registrosFiltrados.length) ? registrosFiltrados : registros;
  if (!base || !base.length) { alert('Efetue uma pesquisa primeiro.'); return; }
  try { await _ensureXLSX(); } catch(e) { alert('Erro ao carregar biblioteca Excel: ' + e.message); return; }
  const ordenada = base === registros ? [...base].sort((a,b) => String(a.Nome ?? '').localeCompare(String(b.Nome ?? ''), 'pt-PT', { sensitivity: 'base' })) : base;
  const linhas = ordenada.map(r => ({
    'Matrícula': r.Matricula ?? '',
    'Colaborador': r.Nome ?? '',
    'Setor': r.Setor ?? '',
    'Semana (ISO)': r.SemanaISO ?? '',
    'Título do Vídeo': r.TituloVideo ?? '',
    'Data de Participação': formatTimestamp(r.Timestamp),
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(linhas);
  XLSX.utils.book_append_sheet(wb, ws, 'Pesquisa');
  XLSX.writeFile(wb, nomeArquivo('xlsx'));
}

async function fetchTreinamentos(){
  try {
    const data = await _cachedFetch('treinamentos');
    if (!data || !data.ok) return [];
    return _parseRows(data);
  } catch(e){
    return [];
  }
}

// Busca os "Assuntos" (Temas Abordados) cadastrados na aba Treinamentos para
// um conjunto de registos já filtrados (ex.: resultado de uma pesquisa).
// Reaproveita exatamente a mesma lógica de correspondência usada no PDF:
// tenta casar pelo Título do vídeo e, em último caso, pela Semana ISO.
// Retorna um array de blocos { titulo, semanaISO, assuntos }, um por semana
// distinta presente em `lista`, ordenados da mais recente para a mais antiga.
async function buscarAssuntosPorSemana(lista){
  if (!Array.isArray(lista) || !lista.length) return [];
  const titulos = [...new Set(lista.map(r => r.TituloVideo).filter(Boolean))];
  if (!titulos.length) return [];

  let tList = [];
  try { tList = await fetchTreinamentos(); } catch(e) { tList = []; }

  const blocks = titulos.map(tit => {
    const regsDoGrupo = lista.filter(r => (r.TituloVideo ?? '') === tit);
    const semanaISO = String(regsDoGrupo.find(r => r.SemanaISO)?.SemanaISO ?? '');
    let hit = (tList||[]).find(t => String(t['Titulo']).trim() === tit);
    if (!hit && semanaISO) hit = (tList||[]).find(t => normalizarSemanaISO(String(t['SemanaISO'])) === normalizarSemanaISO(semanaISO));
    const assuntos = hit && hit['Assuntos'] ? String(hit['Assuntos']) : '';
    return { titulo: tit, semanaISO, assuntos };
  }).filter(b => b.assuntos); // só mostrar blocos que de facto têm assuntos cadastrados

  blocks.sort((a, b) => dashCompareSemanaISODesc(a.semanaISO, b.semanaISO));
  return blocks;
}

// Renderiza os blocos de Assuntos num contentor (usado em Principal e Dashboard).
// Esconde o contentor quando não há nada a mostrar.
function renderTemasAbordados(containerId, blocks){
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!blocks || !blocks.length){
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.innerHTML = blocks.map(b => {
    const linhas = String(b.assuntos).replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n').map(s=>s.trim()).filter(Boolean);
    return `
      <div class="mb-4 last:mb-0">
        <p class="text-xs font-bold text-brand-700 uppercase tracking-wider mb-1.5">
          Temas Abordados — Semana ${escapeHtml(b.semanaISO || '')}${b.titulo ? ' · ' + escapeHtml(b.titulo) : ''}
        </p>
        <ul class="list-none text-sm text-slate-700">
          ${linhas.map(l => `<li style="margin-bottom:3px">- ${escapeHtml(l.replace(/^-\s*/, ''))}</li>`).join('')}
        </ul>
      </div>`;
  }).join('<hr class="my-3 border-brand-100">');
  el.classList.remove('hidden');
}

// ── Perguntas do Quiz — exibição na tela de resultados ──────────────────────
// Espelha exatamente o padrão de buscarAssuntosPorSemana/renderTemasAbordados
// acima, mas buscando as perguntas cadastradas na aba "Perguntas" para cada
// vídeo presente nos resultados da pesquisa. Usa a action 'perguntasgestor'
// (exclusiva do DSS Gestor) porque, ao contrário do lado do colaborador,
// aqui o gestor PODE ver qual é a resposta correta — é útil para auditar o
// conteúdo do quiz rapidamente sem precisar abrir o gerenciador.

const _perguntasCache = new Map(); // chave "semanaISO@@titulo" -> Promise<perguntas[]>

function _fetchPerguntasGestor(semanaISO, titulo){
  const chave = `${semanaISO}@@${titulo}`;
  if (!_perguntasCache.has(chave)) {
    const params = 'action=perguntasgestor&semana=' + encodeURIComponent(semanaISO) + '&titulo=' + encodeURIComponent(titulo);
    _perguntasCache.set(chave, apiFetch(params)
      .then(r => r.ok ? r.json().catch(() => null) : null)
      .then(j => (j && j.ok && Array.isArray(j.data)) ? j.data : [])
      .catch(() => []));
  }
  return _perguntasCache.get(chave);
}

// Limpa o cache de perguntas — chamado depois de qualquer alteração feita
// pelo gerenciador (adicionar/excluir), para não exibir dados desatualizados.
function _invalidarCachePerguntas(){ _perguntasCache.clear(); }

async function buscarPerguntasPorSemana(lista){
  if (!Array.isArray(lista) || !lista.length) return [];
  const titulos = [...new Set(lista.map(r => r.TituloVideo).filter(Boolean))];
  if (!titulos.length) return [];

  const blocks = await Promise.all(titulos.map(async tit => {
    const regsDoGrupo = lista.filter(r => (r.TituloVideo ?? '') === tit);
    const semanaISO = String(regsDoGrupo.find(r => r.SemanaISO)?.SemanaISO ?? '');
    if (!semanaISO) return null;
    const perguntas = await _fetchPerguntasGestor(semanaISO, tit);
    return perguntas.length ? { titulo: tit, semanaISO, perguntas } : null;
  }));

  const resultado = blocks.filter(Boolean);
  resultado.sort((a, b) => dashCompareSemanaISODesc(a.semanaISO, b.semanaISO));
  return resultado;
}

// Renderiza os blocos de Perguntas do Quiz num contentor (Principal e Dashboard).
function renderPerguntasAbordadas(containerId, blocks){
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!blocks || !blocks.length){
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.innerHTML = blocks.map(b => {
    const itens = b.perguntas.map((p, idx) => {
      const opcoes = [['A', p.OpcaoA], ['B', p.OpcaoB], ['C', p.OpcaoC], ['D', p.OpcaoD]]
        .filter(([, texto]) => texto !== undefined && texto !== null && String(texto).trim() !== '');
      const opcoesHtml = opcoes.map(([letra, texto]) => {
        const correta = letra === p.RespostaCorreta;
        return `<span class="dssg-pg-opt${correta ? ' dssg-pg-opt-correta' : ''}">${correta ? '✓ ' : ''}${escapeHtml(letra)}) ${escapeHtml(String(texto))}</span>`;
      }).join('');
      return `
        <li class="mb-2 last:mb-0">
          <p class="text-sm text-slate-700"><strong>${idx + 1}.</strong> ${escapeHtml(p.Pergunta || '')}</p>
          <div class="dssg-pg-opts">${opcoesHtml}</div>
        </li>`;
    }).join('');
    return `
      <div class="mb-4 last:mb-0">
        <p class="text-xs font-bold text-brand-700 uppercase tracking-wider mb-1.5">
          Perguntas do Quiz — Semana ${escapeHtml(b.semanaISO || '')}${b.titulo ? ' · ' + escapeHtml(b.titulo) : ''}
        </p>
        <ul class="list-none space-y-2">${itens}</ul>
      </div>`;
  }).join('<hr class="my-3 border-brand-100">');
  el.classList.remove('hidden');
}

// Auxiliares de Assinatura Digital e Parsing de URLs de Base64
const __dataUrlCache = new Map();
function isDataURLImage(v){ return (typeof v === 'string' && /^data:image\/(png|jpeg|jpg);base64,/i.test(v.trim())); }
async function urlToDataURL(url){ 
  try { 
    if(__dataUrlCache.has(url)) return __dataUrlCache.get(url); 
    const res = await fetch(url, { mode: 'cors' }); 
    const blob = await res.blob(); 
    const dataUrl = await new Promise((resolve) => { 
      const fr = new FileReader(); 
      fr.onload = () => resolve(fr.result); 
      fr.onerror = () => resolve(''); 
      fr.readAsDataURL(blob);
    }); 
    __dataUrlCache.set(url, dataUrl || ''); 
    return dataUrl || ''; 
  } catch(e){ 
    return ''; 
  } 
}

// Normaliza um valor que DEVERIA ser uma assinatura em base64 para uma data
// URL válida, tolerando variações comuns que fazem o valor escapar do
// isDataURLImage() acima e ser tratado (erradamente) como se fosse uma URL
// para buscar na internet — o que falha em silêncio, sem erro nenhum, e é
// exatamente o tipo de bug que já causou assinaturas "sumindo" antes.
// Tolera: espaços/quebras de linha extras, variação de maiúsculas no
// cabeçalho, subtipos de imagem diferentes (jpeg, etc.), e até o payload
// base64 puro salvo SEM o prefixo "data:image/...;base64," na frente.
function normalizarAssinaturaParaDataURL(v){
  if (typeof v !== 'string') return '';
  const s = v.trim().replace(/\s+/g, ''); // remove espaços/quebras de linha internos
  if (!s) return '';

  // Já é (ou é uma variação de) uma data URL de imagem válida
  const comPrefixo = s.match(/^data:image\/([a-z0-9.+-]+);?base64,(.*)$/i);
  if (comPrefixo) return 'data:image/png;base64,' + comPrefixo[2];

  // Não tem prefixo "data:" nenhum. Se NÃO parece um caminho/URL (não começa
  // com "/", "http://" ou "https://") e É uma string longa só de caracteres
  // válidos de base64, trata como o payload puro de uma imagem que, por
  // algum motivo, foi salvo sem o cabeçalho — reconstrói o prefixo em vez de
  // tentar (e falhar silenciosamente) buscar isso como se fosse uma URL.
  const pareceCaminhoOuUrl = /^(https?:)?\/\//i.test(s) || s.startsWith('/');
  if (!pareceCaminhoOuUrl && s.length > 200 && /^[A-Za-z0-9+/]+={0,2}$/.test(s)) {
    return 'data:image/png;base64,' + s;
  }

  return '';
}

async function ensureDataURLImage(v){ 
  if(!v) return ''; 
  const normalizado = normalizarAssinaturaParaDataURL(v);
  if (normalizado) return normalizado;
  // Só chega aqui se realmente parecer uma URL/caminho (ex.: a logo, que é
  // "/logo lsg.png") — nesse caso sim faz sentido buscar via fetch.
  const resultado = await urlToDataURL(v);
  if (!resultado) {
    console.warn('[PDF] valor de assinatura/imagem não reconhecido (nem data URL válida, nem URL buscável). Início do valor:', String(v).slice(0, 60));
  }
  return resultado;
}

// Carrega uma imagem (inclusive data URL) e só resolve DEPOIS que ela termina
// de decodificar — usar naturalWidth/drawImage antes disso resulta em canvas
// em branco, silenciosamente (sem erro), que foi a causa real das
// assinaturas "sumindo" tanto dos colaboradores quanto dos instrutores.
function _carregarImagemElemento(src){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}

// Processa a assinatura do colaborador no canvas (fundo branco + contraste),
// aguardando corretamente o carregamento da imagem antes de desenhar.
async function _processarAssinaturaCanvas(dataUrl){
  try {
    const imgEl = await _carregarImagemElemento(dataUrl);
    const nW = imgEl.naturalWidth  || 400;
    const nH = imgEl.naturalHeight || 160;
    const canvas = document.createElement('canvas');
    canvas.width  = nW;
    canvas.height = nH;
    const ctx = canvas.getContext('2d');
    // Sem preenchimento de fundo — mantém transparência, para a assinatura
    // se integrar bem tanto nas linhas brancas quanto nas cinzas da tabela.
    ctx.drawImage(imgEl, 0, 0);
    const imgData = ctx.getImageData(0, 0, nW, nH);
    const d = imgData.data;
    // "Caneta azul" única aplicada a TODO traço de assinatura no relatório —
    // não importa a cor com que foi originalmente salva (registros antigos
    // têm cores variadas, dependendo do modo claro/escuro em que a pessoa
    // assinou). Isso garante aparência visual consistente em 100% dos
    // relatórios, sem precisar alterar nenhum dado já salvo na planilha.
    const PEN_R = 29, PEN_G = 78, PEN_B = 216; // #1d4ed8 — azul caneta

    for (let i = 0; i < d.length; i += 4){
      // CRUCIAL: decide se o pixel é "traço" ou "fundo" pela OPACIDADE
      // (o que realmente indica se algo foi desenhado ali), nunca pelo
      // brilho da cor. A versão anterior checava o brilho — e por isso
      // apagava por completo qualquer traço salvo numa cor clara (como o
      // usado no modo escuro antes desta correção), tratando-o como se
      // fosse fundo. Esse foi um segundo motivo, além da cor em si, para as
      // assinaturas sumirem no relatório mesmo com o dado presente.
      if (d[i+3] < 10) {
        d[i+3] = 0; // realmente não há traço aqui — mantém transparente
        continue;
      }
      // Havia traço aqui — repinta de azul, preservando a opacidade
      // original (mantém o antialiasing suave das bordas do traço).
      d[i]   = PEN_R;
      d[i+1] = PEN_G;
      d[i+2] = PEN_B;
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas.toDataURL('image/png');
  } catch(e) {
    console.warn('Processamento de assinatura falhou, usando original:', e);
    return dataUrl;
  }
}

async function resolveRowSignatures(rows){ 
  const out = []; 
  let vazias = 0;
  for(const r of rows){ 
    const bruto = r._sig || r.AssinaturaPNG || '';
    let sig = await ensureDataURLImage(bruto); 
    if (sig && /^data:image\/(png|jpeg|jpg);base64,/i.test(sig)) {
      sig = await _processarAssinaturaCanvas(sig);
    }
    if (bruto && !sig) {
      // Havia algo salvo (a pessoa assinou), mas não conseguimos transformar
      // em imagem exibível — mostra a matrícula para facilitar o diagnóstico.
      vazias++;
      console.warn(`[PDF] assinatura da matrícula ${r.Matricula} não pôde ser processada (havia dado salvo, mas não virou imagem).`);
    }
    out.push({ ...r, _sig: sig }); 
  } 
  if (vazias > 0) console.warn(`[PDF] total de ${vazias} assinatura(s) com dado salvo mas que não puderam ser processadas/exibidas.`);
  return out; 
}

// Geração Inteligente do Relatório de Presenças em formato PDF (A4)
async function gerarPDF(){
  const btnPDF = document.getElementById('btnPDF');
  const status = document.getElementById('status');
  const textoOriginal = btnPDF ? btnPDF.innerHTML : '';
  try {
    if (btnPDF) { btnPDF.disabled = true; btnPDF.innerHTML = '<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"></path></svg> A gerar...'; }
    status.innerHTML = '<div class="text-amber-600 bg-amber-50 px-4 py-2 rounded-lg border border-amber-100">A carregar bibliotecas e recursos...</div>';
    await Promise.all([_ensureJsPDF(), loadLogoAsDataURL()]);
    const baseSource = (Array.isArray(registrosFiltrados) && registrosFiltrados.length) ? registrosFiltrados : registros;
    if (!baseSource || !baseSource.length){ alert('Sem dados disponíveis para gerar PDF.'); return; }
    const base = [...baseSource].sort((a,b) => String(a.Nome ?? '').localeCompare(String(b.Nome ?? ''), 'pt-PT', { sensitivity: 'base' }));

    // A busca da tela não traz mais as assinaturas (fica mais leve/rápida
    // para simples visualização). Aqui, só na hora de gerar o PDF — onde a
    // assinatura é essencial —, buscamos elas sob demanda, usando a lista de
    // matrículas que JÁ ESTÁ CONFIRMADA em `base` (a mesma que vai para o
    // relatório) — não relemos o formulário, para não depender de nada ter
    // mudado entre a pesquisa e o clique em "Gerar PDF".
    try {
      const matriculasBase = [...new Set(base.map(r => r.Matricula).filter(v => v !== null && v !== undefined && v !== ''))];
      // Derivar o(s) título(s)/semana(s) presentes neste relatório, para que a
      // busca de assinatura combine matrícula + semana/título — sem isso, o
      // filtro por matrícula sozinho traz TODO o histórico da pessoa (todas
      // as semanas que ela já participou), facilmente estourando o limite de
      // segurança de 200 registos e bloqueando a busca de assinatura.
      const titulosBase = [...new Set(base.map(r => r.TituloVideo).filter(Boolean))];
      const semanasBase = [...new Set(base.map(r => r.SemanaISO).filter(Boolean))];

      if (matriculasBase.length && matriculasBase.length <= 200) {
        const qsSig = new URLSearchParams({ action: 'registros', comAssinatura: '1' });
        qsSig.set('matriculas', matriculasBase.join(','));
        // Envia OS DOIS filtros (não mais um ou outro): o backend, no modo de
        // busca por lista de matrículas, aceita bater com QUALQUER um dos
        // dois. Isso cobre o caso de registros antigos em que um dos campos
        // (SemanaISO ou TituloVideo) ficou gravado de forma levemente
        // diferente do padrão — antes, se o campo escolhido não batesse, a
        // assinatura da pessoa simplesmente sumia do PDF sem aviso nenhum.
        if (semanasBase.length === 1) qsSig.set('semana', semanasBase[0]);
        if (titulosBase.length === 1) qsSig.set('titulo', titulosBase[0]);
        console.log('[PDF] filtro de assinatura:', { matriculas: matriculasBase.length, semanasBase, titulosBase });

        const resSig = await apiFetch(qsSig.toString());
        const dataSig = await resSig.json().catch(() => null);
        console.log('[PDF] busca de assinaturas:', dataSig && dataSig.ok ? `ok, ${dataSig.data.length} registo(s), ${dataSig.data.filter(r=>r.AssinaturaPNG).length} com assinatura` : dataSig);
        if (dataSig && dataSig.ok && Array.isArray(dataSig.data)) {
          // Casamento por Matrícula + Timestamp — não por SemanaISO/Título.
          // O Timestamp é gravado uma única vez, no momento do registro, e
          // nunca sofre os problemas de formatação/normalização que afetam
          // SemanaISO (ex.: variações no padrão "2026-W34") ou Título (perda
          // de acentuação ao longo da cadeia navegador → proxy → Apps
          // Script). Cada linha da planilha tem um Timestamp praticamente
          // único, então esse par identifica o registro exato de forma
          // muito mais confiável.
          const mapaSig = new Map();
          dataSig.data.forEach(r => {
            const chave = `${r.Matricula ?? ''}__${r.Timestamp ?? ''}`;
            if (r.AssinaturaPNG) mapaSig.set(chave, r.AssinaturaPNG);
          });
          let semAssinaturaCount = 0;
          base.forEach(r => {
            const chave = `${r.Matricula ?? ''}__${r.Timestamp ?? ''}`;
            if (mapaSig.has(chave)) r.AssinaturaPNG = mapaSig.get(chave);
            else if (!r.AssinaturaPNG) semAssinaturaCount++;
          });
          if (semAssinaturaCount > 0) {
            console.warn(`[PDF] ${semAssinaturaCount} registo(s) ainda sem assinatura encontrada após o casamento por Matrícula+Timestamp.`);
          }
        } else {
          console.warn('[PDF] busca de assinaturas não retornou ok:', dataSig);
        }
      } else if (matriculasBase.length > 200) {
        console.warn('[PDF] mais de 200 pessoas — assinaturas não serão buscadas automaticamente.');
      }
    } catch(e) { console.warn('Não foi possível carregar assinaturas para o PDF:', e); }

    // Fallback final: para qualquer registro que ainda não tenha assinatura
    // depois da busca em lote acima (por exemplo, se algum dado da linha
    // estiver com formatação inesperada e escapar até desse casamento),
    // tenta buscar individualmente por matrícula — sem depender de
    // semana/título baterem, cobrindo praticamente qualquer inconsistência.
    // Limitado a poucos casos de cada vez (a maioria dos relatórios não
    // deveria cair aqui de jeito nenhum); se sobrarem muitos, é sinal de um
    // problema maior nos dados, não algo para tentar resolver silenciosamente
    // com dezenas de chamadas extras.
    try {
      const semAssinatura = base.filter(r => !r.AssinaturaPNG && r.Matricula);
      if (semAssinatura.length && semAssinatura.length <= 20) {
        console.log(`[PDF] busca individual (fallback) de assinatura para ${semAssinatura.length} registo(s)...`);
        await Promise.all(semAssinatura.map(async (r) => {
          try {
            const qs = new URLSearchParams({
              action: 'registros', comAssinatura: '1', exato: '1',
              matricula: String(r.Matricula),
            });
            const res = await apiFetch(qs.toString());
            const data = await res.json().catch(() => null);
            if (data && data.ok && Array.isArray(data.data)) {
              const alvo = data.data.find(x => String(x.Timestamp ?? '') === String(r.Timestamp ?? ''));
              if (alvo && alvo.AssinaturaPNG) {
                r.AssinaturaPNG = alvo.AssinaturaPNG;
                console.log(`[PDF] assinatura recuperada via fallback individual — matrícula ${r.Matricula}.`);
              } else {
                console.warn(`[PDF] fallback individual não encontrou assinatura — matrícula ${r.Matricula}, Timestamp ${r.Timestamp}.`);
              }
            }
          } catch(e) {
            console.warn(`[PDF] falha no fallback individual — matrícula ${r.Matricula}:`, e);
          }
        }));
      } else if (semAssinatura.length > 20) {
        console.warn(`[PDF] ${semAssinatura.length} registo(s) sem assinatura — número alto demais para o fallback individual automático. Verifique os dados na aba Registros.`);
      }
    } catch(e) { console.warn('[PDF] falha no fallback individual de assinaturas:', e); }

    const titulos = [...new Set(base.map(r => r.TituloVideo).filter(Boolean))];
    const tituloSemana = titulos.length ? titulos.join('; ') : '-';

    const { jsPDF } = window.jspdf;
    const M_TOP = 28.35, M_BOTTOM = 28.35, M_LEFT = 14.17, M_RIGHT = 14.17;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4', compress: true });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const usableWidth = pageWidth - M_LEFT - M_RIGHT;
    const LOGO_W = 120, LOGO_H = 52, L_H = 14;

    // Montar um bloco "Semana / Temas Abordados" para cada Título de Vídeo
    // presente nos registos selecionados. Se mais de um vídeo (mais de uma
    // semana) tiver sido selecionado, cada um aparece em seu próprio bloco,
    // com os respectivos assuntos.
    let semanaBlocks = [];
    try {
      const tList = await fetchTreinamentos();
      const gruposTitulo = titulos.length ? titulos : [null];
      semanaBlocks = gruposTitulo.map(tit => {
        const regsDoGrupo = tit ? base.filter(r => (r.TituloVideo ?? '') === tit) : base;
        const semanaISO = String(regsDoGrupo.find(r => r.SemanaISO)?.SemanaISO ?? '');
        let hit = null;
        if (tit) hit = (tList||[]).find(t => String(t['Titulo']).trim() === tit);
        if (!hit && semanaISO) hit = (tList||[]).find(t => normalizarSemanaISO(String(t['SemanaISO'])) === normalizarSemanaISO(semanaISO));
        const assuntos = hit && hit['Assuntos'] ? String(hit['Assuntos']) : '';
        return { titulo: tit || tituloSemana, semanaISO, assuntos };
      });
      // Ordenar da semana mais recente para a mais antiga
      semanaBlocks.sort((a, b) => dashCompareSemanaISODesc(a.semanaISO, b.semanaISO));
    } catch(e){
      semanaBlocks = [{ titulo: tituloSemana, semanaISO: '', assuntos: '' }];
    }

    // Pré-calcular as linhas de cada bloco de assuntos (já com a quebra automática)
    semanaBlocks.forEach(b => {
      b.assuntosLines = [];
      if (b.assuntos) {
        const raw = b.assuntos.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const partes = raw.split('\n').map(s => s.trim()).filter(Boolean);
        b.assuntosLines = partes.flatMap(linha => doc.splitTextToSize(linha, usableWidth - 8));
      }
    });

    function drawHeader(pageNumber){
      // Logo embutido — sempre disponível, formato JPEG
      if (LOGO_DATAURL && LOGO_DATAURL.startsWith('data:image')) {
        try {
          const fmt = LOGO_DATAURL.includes('data:image/svg') ? 'SVG'
                    : LOGO_DATAURL.includes('data:image/png') ? 'PNG' : 'JPEG';
          doc.addImage(LOGO_DATAURL, fmt, pageWidth - M_RIGHT - LOGO_W, M_TOP, LOGO_W, LOGO_H);
        } catch(e) { console.warn('Logo PDF:', e.message); }
      }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.text('DIÁLOGO SEMANAL DE SEGURANÇA', M_LEFT, M_TOP + 20);
      if (pageNumber === 1){
        let y = M_TOP + 20 + 2 * L_H;
        semanaBlocks.forEach(b => {
          doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
          doc.text('Semana: ' + (b.titulo || '-'), M_LEFT, y);
          y += 2 * L_H;
          if (b.assuntosLines.length){
            doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
            doc.text('Temas Abordados:', M_LEFT, y);
            doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
            b.assuntosLines.forEach((linha, i) => {
              doc.text(linha, M_LEFT + 8, y + (i + 1) * L_H);
            });
            y += L_H + b.assuntosLines.length * L_H;
          }
          y += L_H; // espaçamento entre blocos de semana
        });
      }
    }

    function drawFooter(pageNumber, totalPagesText){
      const footerY = pageHeight - M_BOTTOM; 
      const generatedAt = new Date().toLocaleString('pt-PT');
      doc.setFont('helvetica', 'italic'); doc.setFontSize(9); doc.text('Gerado em: ' + generatedAt, M_LEFT, footerY - 4 * L_H);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
      doc.text('Caterair Serviços de Bordo e Hotelaria LTDA - Base GIG', M_LEFT, footerY - 3 * L_H);
      doc.text('CNPJ 33.375.601/0001-38', M_LEFT, footerY - 2 * L_H);
      doc.text('Rua P, S/N, Área de Apoio do Aeroporto Internacional do Rio de Janeiro - Ilha do Governador - RJ', M_LEFT, footerY - 1 * L_H);
      const pagText = `Página ${pageNumber} de ${totalPagesText}`.trim();
      doc.text(pagText, pageWidth / 2, footerY, { align: 'center' });
    }

    const columns = [
      { header: 'Matrícula', dataKey: 'Matricula' },
      { header: 'Colaborador', dataKey: 'Nome' },
      { header: 'Setor', dataKey: 'Setor' },
      { header: 'Data de Participação', dataKey: 'DataFmt' },
      { header: 'Assinatura', dataKey: '_sig' },
    ];

    status.innerHTML = '<div class="text-amber-600 bg-amber-50 px-4 py-2 rounded-lg border border-amber-100">A processar assinaturas dos colaboradores...</div>';
    let rows = base.map(r => ({ Matricula: r.Matricula??'', Nome: r.Nome??'', Setor: r.Setor??'', DataFmt: formatTimestamp(r.Timestamp)??'', _sig: r.AssinaturaPNG ?? '' }));
    rows = await resolveRowSignatures(rows);

    const totalPagesExp = '{total_pages_count_string}';

    // Calcular a altura total ocupada pelos blocos "Semana / Temas Abordados"
    // (deve usar exatamente o mesmo cálculo de incrementos usado em drawHeader)
    let alturaBlocosSemana = 0;
    semanaBlocks.forEach(b => {
      alturaBlocosSemana += 2 * L_H; // linha "Semana: X"
      if (b.assuntosLines.length){
        alturaBlocosSemana += L_H + b.assuntosLines.length * L_H; // "Temas Abordados:" + linhas
      }
      alturaBlocosSemana += L_H; // espaçamento entre blocos
    });

    let yStartFirstPage = M_TOP + 20 + 2 * L_H + alturaBlocosSemana + L_H;
    const yStartFirstPageMin = M_TOP + 20 + 6 * L_H; 
    if (yStartFirstPage < yStartFirstPageMin) yStartFirstPage = yStartFirstPageMin;
    const yStartOtherPages = M_TOP + LOGO_H + 5 * L_H;

    doc.autoTable({
      startY: yStartFirstPage,
      margin: { left: M_LEFT, right: M_RIGHT, top: yStartOtherPages, bottom: M_BOTTOM + 80 },
      pageBreak: 'auto',
      tableWidth: usableWidth,
      columns,
      body: rows,
      styles: { font: 'helvetica', fontSize: 10, cellPadding: 4, valign: 'middle', overflow: 'linebreak', minCellHeight: 52 },
      headStyles: { fillColor: [33, 150, 243], textColor: 255, halign: 'center' },
      columnStyles: {
        Matricula: { halign: 'left', cellWidth: 60 },
        Nome:      { halign: 'left' },
        Setor:     { halign: 'left', cellWidth: 110 },
        DataFmt:   { halign: 'left', cellWidth: 90 },
        _sig:      { halign: 'center', cellWidth: 130 }
      },
      didParseCell: (data) => {
        if (data.section === 'body' && data.column.dataKey === '_sig'){
          data.cell.text = [''];
          if (data.cell && data.cell.styles){ data.cell.styles.lineWidth = 0; }
        }
      },
      didDrawPage: (data) => {
        drawHeader(data.pageNumber);
        drawFooter(data.pageNumber, totalPagesExp);
        if (data.pageNumber > 1 && data.cursor && data.cursor.y < yStartOtherPages){ data.cursor.y = yStartOtherPages; }
      },
      didDrawCell: (data) => {
        if (data.section === 'body' && data.column && data.column.dataKey === '_sig'){
          const val = data.row?.raw?._sig || '';
          if (typeof val === 'string' && /^data:image\/(png|jpeg|jpg);base64,/i.test(val)){
            try {
              const finalImg = val.replace(/\s/g, '');
              const props = doc.getImageProperties(finalImg);
              const pad  = 3;
              const maxW = data.cell.width  - pad * 2;
              const maxH = data.cell.height - pad * 2;
              // Escalar para preencher a maior parte da célula mantendo proporção
              const scaleW = maxW / (props.width  * 72 / 96);
              const scaleH = maxH / (props.height * 72 / 96);
              const scale  = Math.min(scaleW, scaleH);
              const w = (props.width  * 72 / 96) * scale;
              const h = (props.height * 72 / 96) * scale;
              const x = data.cell.x + (data.cell.width  - w) / 2;
              const y = data.cell.y + (data.cell.height - h) / 2;
              doc.addImage(finalImg, 'PNG', x, y, w, h);
            } catch(e){ console.warn('Sig render:', e); }
          }
        }
      },
    });

    // Garante que estamos na última página absoluta para desenhar os instrutores
    const totalPages = doc.internal.getNumberOfPages();
    doc.setPage(totalPages);

    // Bloco de Instrutores
    if (window._ASSINATURAS_IMG_B64 && window._ASSINATURAS_IMG_B64.startsWith('data:image')) {
      try {
        const yAfterTable = doc.lastAutoTable.finalY ?? (pageHeight - M_BOTTOM - 140);
        const footerAreaH = M_BOTTOM + 4 * L_H + 20;

        // Calcular o tamanho de exibição a partir da resolução NATIVA da
        // imagem, em vez de simplesmente esticá-la para ocupar a largura
        // inteira da página. Esticar uma imagem além da sua resolução real
        // não acrescenta nitidez — só amplia o borrão. Aqui limitamos a
        // largura de exibição para manter pelo menos ~150 DPI efetivos.
        const props = doc.getImageProperties(window._ASSINATURAS_IMG_B64);
        const ratio = props.height / props.width;
        const DPI_ALVO = 150;
        const larguraParaQualidade = (props.width * 72) / DPI_ALVO; // em pontos PDF
        const imgW  = Math.min(usableWidth, larguraParaQualidade);
        const imgH  = imgW * ratio;

        let yImg = yAfterTable + 16;
        if (yImg + imgH > pageHeight - footerAreaH) {
          doc.addPage();
          const newPageNum = doc.internal.getNumberOfPages();
          doc.setPage(newPageNum);
          drawHeader(newPageNum);
          drawFooter(newPageNum, totalPagesExp);
          yImg = yStartOtherPages + 10;
        }

        const xImg = M_LEFT + (usableWidth - imgW) / 2; // centraliza horizontalmente
        doc.addImage(window._ASSINATURAS_IMG_B64, 'PNG', xImg, yImg, imgW, imgH);
      } catch(e) {
        console.warn('Erro ao renderizar imagem de assinaturas:', e);
      }
    }

    if (typeof doc.putTotalPages === 'function'){ doc.putTotalPages(totalPagesExp); }
    doc.save('Relatorio_Dialogo_Semanal_de_Seguranca.pdf');
    status.innerHTML = '<div class="text-emerald-600 bg-emerald-50 px-4 py-2 rounded-lg border border-emerald-100">PDF gerado com sucesso!</div>';
  } catch(err) {
    console.error('Erro ao gerar PDF:', err);
    status.innerHTML = '<div class="text-rose-600 bg-rose-50 px-4 py-2 rounded-lg border border-rose-100">Erro ao gerar PDF: ' + (err.message || 'Erro desconhecido') + '</div>';
  } finally {
    if (btnPDF) { btnPDF.disabled = false; btnPDF.innerHTML = textoOriginal; }
  }
}

// Prompt administrativo para cadastrar novos funcionários (pt-PT)
async function novoFuncionarioViaPrompt(){
  const status = document.getElementById('status');
  try {
    let mRaw = prompt('Nova matrícula (5 algarismos, apenas números):');
    if (mRaw === null) return; 
    mRaw = (mRaw ?? '').replace(/\D/g, '');
    while (!/^\d{5}$/.test(mRaw)){
      mRaw = prompt('Número de registo inválido. Forneça exatamente 5 dígitos (ex.: 12345):', mRaw);
      if (mRaw === null) return; 
      mRaw = (mRaw ?? '').replace(/\D/g, '');
    }
    const matricula = mRaw;
    let nome = prompt('Nome completo:'); 
    if (nome === null) return; 
    nome = (nome ?? '').trim();
    if (!nome){ alert('O nome do colaborador é obrigatório.'); return; }

    let setor = prompt('Setor (opcional):'); 
    if (setor === null) setor = ''; 
    setor = (setor ?? '').trim();

    const ok = confirm(`Confirmar cadastro do novo colaborador?\n\nMatrícula: ${matricula}\nNome: ${nome}\nSetor: ${setor ?? '-'}\nAtivo: SIM`);
    if (!ok){ status.innerHTML = '<div class="text-amber-600 bg-amber-50 px-4 py-2 rounded-lg border border-amber-100">Operação cancelada.</div>'; return; }

    const payload = { matricula, nome, setor, ativo: true };
    status.innerHTML = '<div class="text-amber-500 bg-amber-50 px-4 py-2 rounded-lg border border-amber-100">A submeter novo registo ao servidor...</div>';

    const res = await apiPost('addFuncionario', payload);
    let data; 
    try { data = await res.json(); } catch { data = { ok: false, error: 'Erro de formatação na resposta' }; }
    if (!data.ok) throw new Error(data.error ?? 'Falha ao incluir colaborador');
    status.innerHTML = '<div class="text-emerald-600 bg-emerald-50 px-4 py-2 rounded-lg border border-emerald-100">Colaborador inserido com sucesso!</div>';
  } catch(err){ 
    status.innerHTML = '<div class="text-rose-600 bg-rose-50 px-4 py-2 rounded-lg border border-rose-100">' + (err && err.message ? err.message : 'Erro ao processar criação de colaborador') + '</div>'; 
  }
}

// Prompt administrativo para excluir/deletar funcionário do banco de dados definitivamente
async function excluirFuncionarioViaPrompt(){
  const status = document.getElementById('status');
  try {
    let mRaw = prompt('Digite a matrícula (5 dígitos) do colaborador que deseja EXCLUIR definitivamente do banco de dados:');
    if (mRaw === null) return;
    mRaw = mRaw.replace(/\D/g, '');
    while (!/^\d{5}$/.test(mRaw)){
      mRaw = prompt('Matrícula inválida. Digite exatamente 5 números (ex.: 12345):', mRaw);
      if (mRaw === null) return;
      mRaw = mRaw.replace(/\D/g, '');
    }
    const matricula = mRaw;

    // Buscar localmente os dados do colaborador para confirmar exclusão
    await dashEnsureData();
    const colab = (DASH_funcionarios || []).find(f => afastNormMat(f.Matricula) === matricula);

    let confirmMsg = `Deseja realmente apagar em definitivo o colaborador com a matrícula ${matricula}?`;
    if (colab && colab.Nome) {
      confirmMsg = `Deseja realmente EXCLUIR em definitivo o colaborador abaixo do banco de dados?\n\nNome: ${colab.Nome}\nMatrícula: ${matricula}\nSetor: ${colab.Setor ?? '-'}\n\nNota: Esta ação irá apagar o registo do colaborador do Sheets.`;
    }

    const ok = confirm(confirmMsg);
    if (!ok){ status.innerHTML = '<div class="text-amber-600 bg-amber-50 px-4 py-2 rounded-lg border border-amber-100">Exclusão cancelada.</div>'; return; }

    status.innerHTML = '<div class="text-rose-500 bg-rose-50 px-4 py-2 rounded-lg border border-rose-100">A remover registo do Google Sheets...</div>';

    let success = false;
    let errorMsg = '';

    // Prova de exclusão primária: action=excluirFuncionario
    try {
      const res = await apiPost('excluirFuncionario', { matricula });
      const data = await res.json();
      if (data && data.ok) {
        success = true;
      } else {
        errorMsg = data.error || '';
      }
    } catch(e) {
      errorMsg = e.message;
    }

    // Fallback 1: action=deleteFuncionario
    if (!success) {
      try {
        const res = await apiPost('deleteFuncionario', { matricula });
        const data = await res.json();
        if (data && data.ok) {
          success = true;
        } else {
          errorMsg = data.error || errorMsg;
        }
      } catch(e) {
        errorMsg = e.message || errorMsg;
      }
    }

    // Fallback 2: action=excluirColaborador
    if (!success) {
      try {
        const res = await apiPost('excluirColaborador', { matricula });
        const data = await res.json();
        if (data && data.ok) {
          success = true;
        } else {
          errorMsg = data.error || errorMsg;
        }
      } catch(e) {
        errorMsg = e.message || errorMsg;
      }
    }

    if (!success) {
      throw new Error(errorMsg || 'Erro desconhecido na remoção do Sheets');
    }

    status.innerHTML = '<div class="text-emerald-600 bg-emerald-50 px-4 py-2 rounded-lg border border-emerald-100">Colaborador removido em definitivo do Sheets!</div>';

    // Limpar cache local para forçar recarregamento na próxima busca
    delete _apiCache['funcionarios'];
    DASH_funcionarios = null;
  } catch(err){
    status.innerHTML = '<div class="text-rose-600 bg-rose-50 px-4 py-2 rounded-lg border border-rose-100">' + (err && err.message ? err.message : 'Erro ao excluir colaborador') + '</div>';
  }
}

function escapeHtml(str){
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\x22/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function nomeArquivo(ext){ 
  const hoje = new Date(); 
  const pad = n => String(n).padStart(2, '0'); 
  return `DSS_GIG_Relatorio_${hoje.getFullYear()}-${pad(hoje.getMonth() + 1)}-${pad(hoje.getDate())}.${ext}`; 
}

function normalizarDataInput(v){
  if (!v) return null;
  v = String(v).trim();
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, dd, mm, yyyy] = m;
    return new Date(Date.UTC(+yyyy, +mm - 1, +dd, 0, 0, 0));
  }
  const m2 = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m2) {
    const [, yyyy, mm, dd] = m2;
    return new Date(Date.UTC(+yyyy, +mm - 1, +dd, 0, 0, 0));
  }
  return null;
}

function fimDoDia(dIniUTC){ 
  if(!dIniUTC) return null; 
  return new Date(dIniUTC.getTime() + 24 * 60 * 60 * 1000 - 1); 
}

function parseTimestamp(valor){ 
  if(!valor) return null; 
  let d = new Date(valor); 
  if(!Number.isNaN(d.getTime())) return d; 
  const rx = /(^\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/; 
  const m = String(valor).trim().match(rx); 
  if(m){ 
    const dd = +m[1], mm = +m[2], yy = +m[3]; 
    const hh = +(m[4]??0), mi = +(m[5]??0), ss = +(m[6]??0); 
    return new Date(yy, mm-1, dd, hh, mi, ss); 
  } 
  return null; 
}

function formatTimestamp(ts){ 
  const d = parseTimestamp(ts); 
  if(!d) return String(ts ?? ''); 
  const pad = n => String(n).padStart(2, '0'); 
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; 
}

/* ====== LÓGICA DO PAINEL DASHBOARD ====== */
let DASH_registrosAll = null, DASH_funcionarios = null, DASH_treinamentos = null;
let DASH_participantes = [], DASH_naoParticipantes = [];

/* ====== GESTÃO DE AUSÊNCIAS / FÉRIAS ====== */
let AFAST_set = new Set(); 

// Funções de Gestão de cache das ausências re-definidas para evitar erros de referência (ReferenceError)
function afastSalvar(){ 
  try { localStorage.setItem('dss_afast', JSON.stringify([...AFAST_set])); } catch(e){} 
}

// Gestão de renderização das listas de presenças e faltas no ecrã Dashboard
function dashRender(naoParticipantes, participantes, dispensados){
  const tbodyNP = document.getElementById('tbodyNP');
  const tbodyP  = document.getElementById('tbodyP');
  const tbodyD  = document.getElementById('tbodyDispensados');

  if (tbodyNP) {
    if (!naoParticipantes || !naoParticipantes.length)
      tbodyNP.innerHTML = '<tr><td colspan="3" class="px-4 py-8 text-center text-emerald-600 font-semibold bg-emerald-50">✅ Todos os colaboradores elegíveis participaram!</td></tr>';
    else
      tbodyNP.innerHTML = naoParticipantes.map(n => `
        <tr class="hover:bg-rose-50/40 transition-colors">
          <td class="px-4 py-3 font-semibold text-slate-900">${escapeHtml(n.Matricula??'')}</td>
          <td class="px-4 py-3">${escapeHtml(n.Nome??'')}</td>
          <td class="px-4 py-3">${escapeHtml(n.Setor??'')}</td>
        </tr>`).join('');
  }

  if (tbodyP) {
    if (!participantes || !participantes.length)
      tbodyP.innerHTML = '<tr><td colspan="4" class="px-4 py-8 text-center text-slate-400">Nenhum registo de participação processado.</td></tr>';
    else
      tbodyP.innerHTML = participantes.map(p => `
        <tr class="hover:bg-emerald-50/40 transition-colors">
          <td class="px-4 py-3 font-semibold text-slate-900">${escapeHtml(p.Matricula??'')}</td>
          <td class="px-4 py-3">${escapeHtml(p.Nome??'')}</td>
          <td class="px-4 py-3">${escapeHtml(p.Setor??'')}</td>
          <td class="px-4 py-3">${escapeHtml(formatTimestamp(p.Timestamp))}</td>
        </tr>`).join('');
  }

  if (tbodyD) {
    if (!dispensados || !dispensados.length)
      tbodyD.innerHTML = '<tr><td colspan="5" class="px-4 py-8 text-center text-slate-400">Nenhum colaborador dispensado nesta semana.</td></tr>';
    else {
      const fmtPeriodo = s => {
        if (!s) return '';
        // Converter ISO com timezone (2026-06-08T07:00:00.000Z) → dd/mm/aaaa
        return s.replace(/(\d{4})-(\d{2})-(\d{2})T[^\s]*/g, (_, y, m, d) => `${d}/${m}/${y}`)
                .replace(/(\d{4})-(\d{2})-(\d{2})/g, (_, y, m, d) => `${d}/${m}/${y}`);
      };
      tbodyD.innerHTML = dispensados.map(d => `
        <tr class="hover:bg-sky-50/40 transition-colors">
          <td class="px-4 py-3 font-semibold text-slate-900">${escapeHtml(d.Matricula??'')}</td>
          <td class="px-4 py-3">${escapeHtml(d.Nome??'')}</td>
          <td class="px-4 py-3">${escapeHtml(d.Setor??'')}</td>
          <td class="px-4 py-3 font-medium text-sky-700">${escapeHtml(d.Motivo??'')}</td>
          <td class="px-4 py-3 text-slate-500 text-xs">${escapeHtml(fmtPeriodo(d.Periodo??''))}</td>
        </tr>`).join('');
    }
  }
}

// Renderização e cálculo de dados estatísticos (KPIs) semanais
function dashKPIs({ total, part, nPart, nDisp, semana, titulo, registrosAll, funcAtivos }){
  const nDispSafe = nDisp ?? 0;
  const totalAll  = total + nDispSafe; // total geral = elegíveis + dispensados
  const pct    = total > 0 ? Math.round((part   / total) * 100) : 0;
  const pctNP  = total > 0 ? Math.round((nPart  / total) * 100) : 0;
  const pctD   = totalAll > 0 ? Math.round((nDispSafe / totalAll) * 100) : 0;

  document.getElementById('kpiTotalAtivos').textContent     = String(total ?? '-');
  document.getElementById('kpiParticiparam').textContent    = String(part  ?? '-');
  document.getElementById('kpiNaoParticiparam').textContent = String(nPart ?? '-');
  document.getElementById('kpiParticiparamPct').textContent = total ? `${pct}%` : '-';
  document.getElementById('kpiPctNum').textContent          = total ? `${pct}%` : '-';
  document.getElementById('kpiSemanaSel').textContent       = String(semana ?? '-');
  document.getElementById('kpiTituloSel').textContent       = String(titulo ?? '-');

  const kpiDisp = document.getElementById('kpiDispensados');
  if (kpiDisp) kpiDisp.textContent = String(nDispSafe);

  document.getElementById('barPart').style.width    = total ? `${pct}%`   : '0%';
  document.getElementById('barNaoPart').style.width = total ? `${pctNP}%` : '0%';
  const barDisp = document.getElementById('barDisp');
  if (barDisp) {
    barDisp.style.width = totalAll ? `${pctD}%` : '0%';
    barDisp.style.backgroundColor = '#38bdf8'; // sky-400 azul - garante a cor
  }

  // Gráfico de rosca: verde=participaram, vermelho=em falta, azul=dispensados
  const canvas = document.getElementById('kpiDonut');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    const cx = canvas.width / 2, cy = canvas.height / 2, r = 54, thick = 16;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const arc = (s, e, color) => {
      ctx.beginPath();
      ctx.arc(cx, cy, r, (s / 100) * 2 * Math.PI - Math.PI / 2, (e / 100) * 2 * Math.PI - Math.PI / 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = thick;
      ctx.lineCap = 'round';
      ctx.stroke();
    };

    // Fundo cinza
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.strokeStyle = '#f3f4f6';
    ctx.lineWidth = thick;
    ctx.stroke();

    // Calcular fatias relativas ao total geral (elegíveis + dispensados)
    if (totalAll > 0) {
      const pctPartAll = Math.round((part       / totalAll) * 100);
      const pctNPAll   = Math.round((nPart      / totalAll) * 100);
      const pctDAll    = Math.round((nDispSafe  / totalAll) * 100);
      let cursor = 0;
      if (pctNPAll  > 0){ arc(cursor, cursor + pctNPAll,  '#ef4444'); cursor += pctNPAll;  }
      if (pctPartAll > 0){ arc(cursor, cursor + pctPartAll, '#22c55e'); cursor += pctPartAll; }
      if (pctDAll   > 0){ arc(cursor, cursor + pctDAll,   '#38bdf8'); }
    }
  }

  // KPIs Secundários: Colaboradores sem nenhuma adesão (Nunca Participaram)
  const nuncaEl   = document.getElementById('kpiNuncaCount');
  const nuncaList = document.getElementById('kpiNuncaList');
  const regs = Array.isArray(registrosAll) ? registrosAll : [];
  const ativos = Array.isArray(funcAtivos) ? funcAtivos : [];

  const normMat = v => String(v??'').replace(/\D/g, '').padStart(5, '0');
  const jaParticiparam = new Set(regs.map(r => normMat(r.Matricula)));
  const nunca = ativos.filter(f =>
    !jaParticiparam.has(normMat(f.Matricula)) && !AFAST_set.has(afastNormMat(f.Matricula))
  ).sort((a,b) => String(a.Nome??'').localeCompare(String(b.Nome??''), 'pt-PT', { sensitivity: 'base' }));

  if (nuncaEl) nuncaEl.textContent = nunca.length || '0';
  if (nuncaList){
    if (!nunca.length){
      nuncaList.innerHTML = '<span class="text-xs font-semibold text-emerald-600 bg-emerald-50 px-2 py-1 rounded">✅ Todos os colaboradores ativos já participaram!</span>';
    } else {
      nuncaList.innerHTML = nunca.slice(0, 5).map(f =>
        `<div class="flex items-center gap-2 text-xs">
          <span class="w-4 h-4 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center font-bold">!</span>
          <span class="truncate flex-grow text-slate-700 font-medium">${escapeHtml(f.Nome??f.Matricula??'')}</span>
          <span class="text-slate-400 font-mono">${normMat(f.Matricula)}</span>
        </div>`
      ).join('') + (nunca.length > 5 ? `<div class="text-[10px] text-slate-400 mt-1">+ ${nunca.length - 5} colaboradores na lista</div>` : '');
    }
  }

  // Algoritmo de Assiduidade e Agilidade (Top 5 mais frequentes)
  const assiduosEl = document.getElementById('kpiAssiduosList');
  if (assiduosEl){
    const regsPorMatSemana = new Map();
    for (const r of regs){
      const mat = normMat(r.Matricula);
      const iso = String(r.SemanaISO??'');
      const ts  = parseTimestamp(r.Timestamp);
      if (!mat || !iso || !ts) continue;
      const chave = mat + '__' + iso;
      const atual = regsPorMatSemana.get(chave);
      if (!atual || ts < atual.ts) regsPorMatSemana.set(chave, { mat, iso, ts, nome: r.Nome??'' });
    }

    const contagem = new Map();
    for (const { mat, iso, ts, nome } of regsPorMatSemana.values()){
      const m = iso.match(/^(\d{4})-W\d{1,2}$/i);
      let segsDesdeInicio = 0;
      if (m){
        const ano = +m[1], sem = +m[2];
        const jan4 = new Date(ano, 0, 4);
        const segunda = new Date(jan4);
        segunda.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7) + (sem - 1) * 7);
        segsDesdeInicio = Math.max(0, (ts - segunda) / 1000);
      }
      const entry = contagem.get(mat) || { nome, totalSegs: 0, semanas: 0 };
      entry.totalSegs += segsDesdeInicio;
      entry.semanas   += 1;
      entry.nome = entry.nome || nome;
      contagem.set(mat, entry);
    }

    const ranking = [...contagem.entries()]
      .filter(([,v]) => v.semanas > 0)
      .sort((a,b) => {
        if (b[1].semanas !== a[1].semanas) return b[1].semanas - a[1].semanas;
        return (a[1].totalSegs / a[1].semanas) - (b[1].totalSegs / b[1].semanas);
      })
      .slice(0, 5);

    const rankBg = ['bg-amber-100 text-amber-800', 'bg-slate-200 text-slate-800', 'bg-orange-100 text-orange-800', 'bg-slate-100 text-slate-600', 'bg-slate-100 text-slate-600'];
    assiduosEl.innerHTML = ranking.length
      ? ranking.map(([mat, v], i) => {
          return `<div class="flex items-center gap-2 text-xs">
            <span class="w-4 h-4 rounded-full font-bold flex items-center justify-center text-[10px] ${rankBg[i]}">${i + 1}</span>
            <span class="truncate flex-grow text-slate-700 font-medium">${escapeHtml(v.nome || mat)}</span>
            <span class="text-brand-600 font-semibold bg-brand-50 px-1.5 py-0.5 rounded text-[10px]" title="${v.semanas} sessões concluídas">${v.semanas}✓</span>
          </div>`;
        }).join('')
      : '<span class="text-xs text-slate-400">Dados insuficientes para gerar classificação</span>';
  }
}

function afastCarregar(){ 
  try { 
    const d = localStorage.getItem('dss_afast'); 
    if(d){ JSON.parse(d).forEach(m => AFAST_set.add(m)); } 
  } catch(e){} 
}

function afastNormMat(v){ return String(v??'').replace(/\D/g, '').padStart(5, '0'); }

function mapFeriasRow(row) {
  const keys = Object.keys(row);
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const findVal = (possibleKeys) => {
    const foundKey = keys.find(k => possibleKeys.includes(norm(k)));
    return foundKey ? row[foundKey] : '';
  };
  return {
    Matricula:    String(findVal(['matricula','mat','numregisto']) || '').trim(),
    Funcionario:  String(findVal(['funcionario','nome','colaborador']) || '').trim(),
    Situacao:     String(findVal(['situacao','status','tipo','motivo']) || 'Férias').trim(),
    InicioFerias: String(findVal(['inicioferias','inicio','datainicio','datadeinicio','data_inicio','inicio_ferias']) || '').trim(),
    FimFerias:    String(findVal(['fimferias','fim','datafim','datadefim','data_fim','fim_ferias']) || '').trim()
  };
}

/* ----------------------------------------------------------------
 * Verifica se um funcionário está afastado considerando a semana ISO
 * - Situação "Afastado INSS" → sempre afastado (sem período)
 * - Situação "Férias" → afastado se a semana ISO cai dentro do período
 * ---------------------------------------------------------------- */
// ── funcEstaAfastadoNaSemana ─────────────────────────────────────────────────
// Verifica se um colaborador estava de férias ou afastado durante pelo menos
// UM DIA da semana indicada.
//
// IMPORTANTE: a planilha usa numeração sequencial própria (W24 ≠ semana ISO 24),
// por isso esta função aceita DATAS REAIS (segMs / domMs em UTC ms) em vez de
// tentar converter a SemanaISO internamente — isso evita o erro de semana que
// causava o cálculo incorreto de adesão.
// Situações suportadas: "Férias", "Dispensa Médica" (e legado "Afastado INSS").
// Todos os registros devem ter período (InicioFerias + FimFerias) obrigatório.
//   matricula  — string com a matrícula do colaborador
//   semanaNorm — string ISO normalizada (usado apenas como fallback)
//   segMs      — (opcional) timestamp UTC da segunda-feira da semana real
//   domMs      — (opcional) timestamp UTC do domingo da semana real
function funcEstaAfastadoNaSemana(matricula, semanaNorm, segMs, domMs){
  const mat = afastNormMat(matricula);
  const registros = feriasServidor.filter(f => afastNormMat(f.Matricula) === mat);
  if (!registros.length) return false;

  // Helper: parse de data em múltiplos formatos → UTC ms ou null
  const parseMs = s => {
    if (!s) return null;
    s = String(s).trim();
    const isoFull = s.match(/^(\d{4})-(\d{2})-(\d{2})T/);
    if (isoFull) return Date.UTC(+isoFull[1], +isoFull[2]-1, +isoFull[3]);
    const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (br) return Date.UTC(+br[3], +br[2]-1, +br[1]);
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return Date.UTC(+iso[1], +iso[2]-1, +iso[3]);
    return null;
  };

  // Calcular segundas e domingos a partir do título de treinamento se não fornecidos
  // Fallback para conversão ISO (menos preciso mas melhor do que nada)
  let wSeg = segMs, wDom = domMs;
  if (!wSeg || !wDom) {
    const monday = semanaISOToMonday(semanaNorm);
    if (monday) {
      wSeg = monday.getTime();
      wDom = monday.getTime() + 6 * 86400000;
    }
  }

  for (const f of registros){
    const sitNorm = String(f.Situacao || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();

    const dIniMs = parseMs(f.InicioFerias);
    const dFimMs = parseMs(f.FimFerias);

    if (!dIniMs && !dFimMs) {
      // Sem período → afastamento contínuo (INSS, etc.) → exclui sempre
      return true;
    }

    // Sobreposição: pelo menos 1 dia da semana cai no período de afastamento
    // Condição: início-afastamento <= domingo-semana E fim-afastamento >= segunda-semana
    const iniOk = !dIniMs || (wDom !== undefined && dIniMs <= wDom);
    const fimOk = !dFimMs || (wSeg !== undefined && dFimMs >= wSeg);
    if (iniOk && fimOk) return true;
  }
  return false;
}

/* ----------------------------------------------------------------
 * Renderiza a tabela de férias/ausências com botão de exclusão
 * ---------------------------------------------------------------- */
function afastRenderTags(){
  const badge  = document.getElementById('afastBadge');
  const tbody  = document.getElementById('tbodyAfastados');
  if (!tbody) return;

  const hoje = new Date();
  const hojeMs = Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate());

  const parseMs = s => {
    if (!s) return null; s = String(s).trim();
    const isoFull = s.match(/^(\d{4})-(\d{2})-(\d{2})T/);
    if (isoFull) return Date.UTC(+isoFull[1],+isoFull[2]-1,+isoFull[3]);
    const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (br) return Date.UTC(+br[3],+br[2]-1,+br[1]);
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return Date.UTC(+iso[1],+iso[2]-1,+iso[3]);
    return null;
  };

  // Classificar registros em ativos (período inclui hoje) e históricos (já encerrados)
  const comStatus = feriasServidor.map((f, idx) => {
    const dIniMs = parseMs(f.InicioFerias);
    const dFimMs = parseMs(f.FimFerias);
    let ativo = false;
    if (!dIniMs && !dFimMs) ativo = true;          // sem período → sempre ativo (INSS)
    else if (dIniMs && !dFimMs) ativo = hojeMs >= dIniMs;
    else if (!dIniMs && dFimMs) ativo = hojeMs <= dFimMs;
    else ativo = hojeMs >= dIniMs && hojeMs <= dFimMs;
    return { ...f, _idx: idx, _ativo: ativo };
  });

  const totalAtivos = comStatus.filter(f => f._ativo).length;
  if (badge) badge.textContent = `${totalAtivos} ativos / ${comStatus.length} total`;

  if (comStatus.length === 0){
    tbody.innerHTML = `<tr><td colspan="6" class="px-6 py-10 text-center text-slate-400 italic">
      Nenhum registo na aba <strong>Ferias</strong> do Google Sheets.<br>
      <span class="text-xs">Use o formulário acima para inserir o primeiro registo.</span>
    </td></tr>`;
    return;
  }

  const formatDate = s => {
    if (!s) return '';
    s = String(s).trim();
    const isoFull = s.match(/^(\d{4})-(\d{2})-(\d{2})T/);
    if (isoFull) return `${isoFull[3]}/${isoFull[2]}/${isoFull[1]}`;
    const isoSimple = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoSimple) return `${isoSimple[3]}/${isoSimple[2]}/${isoSimple[1]}`;
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) return s;
    return s;
  };

  // Ordenar: ativos primeiro, depois históricos por data mais recente
  const sorted = [...comStatus].sort((a, b) => {
    if (a._ativo !== b._ativo) return a._ativo ? -1 : 1;
    const aMs = parseMs(a.InicioFerias) || 0;
    const bMs = parseMs(b.InicioFerias) || 0;
    return bMs - aMs;
  });

  tbody.innerHTML = sorted.map((f) => {
    const mat      = afastNormMat(f.Matricula);
    const nome     = escapeHtml(f.Funcionario || '-');
    const sit      = escapeHtml(f.Situacao || 'Férias');
    const sitNorm  = sit.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    const isDispMed = sitNorm.includes('dispensa') || sitNorm.includes('medica') || sitNorm.includes('inss') || sitNorm.includes('afastado');
    const badgeClass = isDispMed
      ? 'bg-rose-100 text-rose-800 border-rose-200'
      : 'bg-amber-100 text-amber-800 border-amber-200';

    const dIni   = formatDate(f.InicioFerias);
    const dFim   = formatDate(f.FimFerias);
    const periodo = (dIni && dFim)
      ? `${dIni} a ${dFim}`
      : (dIni || dFim || '<em class="text-slate-400">Sem prazo definido</em>');

    const statusBadge = f._ativo
      ? '<span class="px-2 py-0.5 text-xs font-bold rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200">Ativo</span>'
      : '<span class="px-2 py-0.5 text-xs font-bold rounded-full bg-slate-100 text-slate-500 border border-slate-200">Encerrado</span>';

    // Botão excluir com aviso extra para registros encerrados
    const deleteBtn = f._ativo
      ? `<button type="button" data-idx="${f._idx}" class="btnAfastExcluir inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-rose-600 hover:text-white hover:bg-rose-500 border border-rose-200 hover:border-rose-500 rounded-lg transition-colors">
           <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
           Excluir
         </button>`
      : `<button type="button" data-idx="${f._idx}" class="btnAfastExcluir inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-slate-400 hover:text-white hover:bg-slate-400 border border-slate-200 hover:border-slate-400 rounded-lg transition-colors" title="⚠️ Não exclua registros históricos — eles garantem que o colaborador apareça como Dispensado nas semanas passadas">
           <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
           ⚠️ Histórico
         </button>`;

    return `<tr class="hover:bg-slate-50 transition-colors ${f._ativo ? '' : 'opacity-70'}">
      <td class="px-4 py-3 font-mono font-semibold text-slate-800">${mat}</td>
      <td class="px-4 py-3 font-medium text-slate-800">${nome}</td>
      <td class="px-4 py-3">
        <span class="px-2.5 py-1 text-xs font-semibold rounded-full border ${badgeClass}">${sit}</span>
      </td>
      <td class="px-4 py-3 text-sm text-slate-600">${periodo}</td>
      <td class="px-4 py-3">${statusBadge}</td>
      <td class="px-4 py-3 text-center">${deleteBtn}</td>
    </tr>`;
  }).join('');

  // Delegação de eventos para botões de exclusão
  tbody.querySelectorAll('.btnAfastExcluir').forEach(btn => {
    btn.addEventListener('click', function(){
      const idx = parseInt(this.dataset.idx);
      const reg = feriasServidor[idx];
      const isEncerrado = !sorted.find(s => s._idx === idx)?._ativo;
      if (isEncerrado) {
        if (!confirm(`⚠️ ATENÇÃO: Este registro já está encerrado.\n\nExcluir registros históricos fará o colaborador "${reg?.Funcionario || ''}" aparecer incorretamente como "Não Participou" nas semanas em que esteve afastado.\n\nTem certeza que deseja excluir mesmo assim?`)) return;
      }
      afastExcluir(idx);
    });
  });
}

/* ----------------------------------------------------------------
 * Inserir novo registo de férias/ausência no Google Sheets
 * ---------------------------------------------------------------- */
async function afastInserir(){
  const msgEl  = document.getElementById('afastStatusMsg');
  const btnIns = document.getElementById('btnAfastInserir');
  const mat    = document.getElementById('afastInputMat').value.replace(/\D/g,'').padStart(5,'0');
  const nome   = document.getElementById('afastInputNome').value.trim();
  const sit    = document.getElementById('afastInputSit').value;
  const ini    = document.getElementById('afastInputIni').value;  // yyyy-mm-dd
  const fim    = document.getElementById('afastInputFim').value;

  if (!mat || mat === '00000'){ msgEl.innerHTML = '<span class="text-rose-600">Matrícula inválida.</span>'; return; }
  if (!nome)                  { msgEl.innerHTML = '<span class="text-rose-600">Nome é obrigatório.</span>'; return; }
  // Datas obrigatórias para todas as situações
  if (!ini || !fim){ msgEl.innerHTML = '<span class="text-rose-600">Informe o Início e o Fim do período.</span>'; return; }

  // Converter datas para formato dd/mm/yyyy (padrão do Sheets)
  const fmtDate = s => {
    if (!s) return '';
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
  };

  const payload = {
    matricula:    mat,
    funcionario:  nome,
    situacao:     sit,
    inicioFerias: fmtDate(ini),
    fimFerias:    fmtDate(fim)
  };

  btnIns.disabled = true;
  msgEl.innerHTML = '<span class="text-amber-600">A inserir...</span>';
  try {
    const res  = await apiPost('addFerias', payload);
    const data = await res.json().catch(() => ({ ok: false, error: 'Resposta inválida' }));
    if (!data.ok) throw new Error(data.error || 'Falha no servidor');

    // Atualizar lista local imediatamente
    feriasServidor.push({
      Matricula: mat, Funcionario: nome, Situacao: sit,
      InicioFerias: fmtDate(ini),
      FimFerias:    fmtDate(fim)
    });
    AFAST_set.add(mat);
    afastRenderTags();
    msgEl.innerHTML = '<span class="text-emerald-600 font-semibold">✓ Inserido com sucesso!</span>';
    // Limpar formulário
    document.getElementById('afastInputMat').value  = '';
    document.getElementById('afastInputNome').value = '';
    document.getElementById('afastInputSit').value  = 'Férias';
    document.getElementById('afastInputIni').value  = '';
    document.getElementById('afastInputFim').value  = '';
    setTimeout(() => { msgEl.innerHTML = ''; }, 3000);
  } catch(e){
    msgEl.innerHTML = `<span class="text-rose-600">Erro: ${e.message}</span>`;
  } finally {
    btnIns.disabled = false;
  }
}

/* ----------------------------------------------------------------
 * Excluir registo de férias/ausência do Google Sheets
 * ---------------------------------------------------------------- */
async function afastExcluir(idx){
  const f = feriasServidor[idx];
  if (!f) return;
  const msgEl = document.getElementById('afastStatusMsg');

  // Verificar se o registro ainda está ativo
  const hoje = new Date();
  const hojeMs = Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate());
  const parseMs = s => {
    if (!s) return null; s = String(s).trim();
    const isoFull = s.match(/^(\d{4})-(\d{2})-(\d{2})T/);
    if (isoFull) return Date.UTC(+isoFull[1],+isoFull[2]-1,+isoFull[3]);
    const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (br) return Date.UTC(+br[3],+br[2]-1,+br[1]);
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return Date.UTC(+iso[1],+iso[2]-1,+iso[3]);
    return null;
  };
  const dFimMs = parseMs(f.FimFerias);
  const isEncerrado = dFimMs !== null && dFimMs < hojeMs;

  if (isEncerrado) {
    // Registro encerrado: apenas ocultar da view local, NÃO excluir do banco
    if (!confirm(
      `"${f.Funcionario || f.Matricula}" já está com período encerrado.\n\n` +
      `O registro histórico será mantido no banco de dados (necessário para o cálculo correto de dispensados nas semanas passadas).\n\n` +
      `Deseja apenas ocultá-lo desta lista?`
    )) return;
    feriasServidor.splice(idx, 1);
    AFAST_set.clear();
    feriasServidor.forEach(r => { const m = afastNormMat(r.Matricula); if (m !== '00000') AFAST_set.add(m); });
    afastRenderTags();
    if (msgEl) { msgEl.innerHTML = '<span class="text-sky-600 font-semibold">✓ Ocultado desta lista (registro mantido no histórico).</span>'; setTimeout(()=>{ msgEl.innerHTML=''; }, 4000); }
    return;
  }

  // Registro ativo: excluir do banco
  if (!confirm(`Excluir o registo ativo de "${f.Funcionario || f.Matricula}" (${f.Situacao})?\n\nEste colaborador voltará a ser considerado ativo no dashboard.`)) return;

  const mat = afastNormMat(f.Matricula);
  if (msgEl) msgEl.innerHTML = '<span class="text-amber-600">A excluir...</span>';

  try {
    let success = false;
    for (const action of ['deleteFerias','excluirFerias','removeFerias']){
      try {
        const res  = await apiPost(action, { matricula: mat, situacao: f.Situacao });
        const data = await res.json().catch(() => null);
        if (data && data.ok){ success = true; break; }
      } catch(e){ /* tenta próximo */ }
    }
    if (!success) throw new Error('Falha ao excluir no servidor.');

    feriasServidor.splice(idx, 1);
    AFAST_set.clear();
    feriasServidor.forEach(r => { const m = afastNormMat(r.Matricula); if (m !== '00000') AFAST_set.add(m); });
    afastRenderTags();
    if (msgEl) { msgEl.innerHTML = '<span class="text-emerald-600 font-semibold">✓ Excluído!</span>'; setTimeout(()=>{ msgEl.innerHTML=''; }, 3000); }
  } catch(e){
    if (msgEl) msgEl.innerHTML = `<span class="text-rose-600">Erro: ${e.message}</span>`;
  }
}

// Inicialização da área de Ausências
(function initAfast(){
  afastCarregar(); // restaura AFAST_set do localStorage (compatibilidade)
  // afastRenderTags() será chamado após dashEnsureData() no dashInit

  const panel   = document.getElementById('afastPanel');
  const chevron = document.getElementById('afastChevron');
  if (panel && chevron){
    panel.addEventListener('toggle', () => { chevron.textContent = panel.open ? '▲' : '▼'; });
  }

  // Painel de Histórico de Faltas Injustificadas — mesmo padrão de recolher/expandir
  const faltasPanel   = document.getElementById('faltasPanel');
  const faltasChevron = document.getElementById('faltasChevron');
  if (faltasPanel && faltasChevron){
    faltasPanel.addEventListener('toggle', () => { faltasChevron.textContent = faltasPanel.open ? '▲' : '▼'; });
  }

  // Botão inserir
  document.getElementById('btnAfastInserir')?.addEventListener('click', afastInserir);
  // Campos de Início e Fim são sempre visíveis — obrigatórios para todas as situações
})();

document.getElementById('btnDashAtualizar').addEventListener('click', dashAtualizar);
document.getElementById('btnDashXLSNP').addEventListener('click', dashGerarXLS_NP);
document.getElementById('btnDashXLSP').addEventListener('click', dashGerarXLS_P);

// Diagnóstico da API — testa todos os endpoints e mostra a resposta bruta
(function initDiag(){
  const btnDiag = document.getElementById('btnDiag');
  const btnDiagClear = document.getElementById('btnDiagClear');
  const diagBox = document.getElementById('diagBox');
  if (!btnDiag || !diagBox) return;

  btnDiag.addEventListener('click', async function(){
    diagBox.classList.remove('hidden');
    btnDiagClear.classList.remove('hidden');
    btnDiag.classList.add('hidden');
    diagBox.textContent = 'A testar endpoints da API...\n';

    const actions = ['treinamentos','registros','funcionarios','ferias','Ferias','ausencias','Ausencias','ferias_ativas'];
    for (const action of actions) {
      try {
        const res = await apiFetch('action=' + action);
        const txt = await res.text();
        let parsed;
        try { parsed = JSON.parse(txt); } catch { parsed = null; }
        const ok = parsed ? (parsed.ok ? '✅ OK' : '❌ ok=false') : '⚠️  não-JSON';
        const rows = parsed ? (_parseRows(parsed).length + ' linhas') : '';
        diagBox.textContent += `[${action}] ${ok} ${rows}\n`;
        if (parsed && !parsed.ok && parsed.error) diagBox.textContent += `  erro: ${parsed.error}\n`;
      } catch(e) {
        diagBox.textContent += `[${action}] ❌ FALHA: ${e.message}\n`;
      }
    }
    diagBox.textContent += '\nDiagnóstico concluído.';
  });

  btnDiagClear.addEventListener('click', function(){
    diagBox.classList.add('hidden');
    btnDiagClear.classList.add('hidden');
    btnDiag.classList.remove('hidden');
    diagBox.textContent = '';
  });
})();

document.getElementById('dashTitulo').addEventListener('change', function(){
  const titVal = this.value.trim();
  const hit = (DASH_treinamentos||[]).find(t => String(t.Titulo).trim() === titVal);
  document.getElementById('dashSemanaIso').value = (hit && hit.SemanaISO) ? String(hit.SemanaISO) : '';
});

// Inicialização "leve" do Dashboard: NÃO faz nenhuma chamada à API.
// Os dados só são carregados quando o usuário clicar em "Atualizar".
(function dashInitLight(){
  const dashStatus = document.getElementById('dashStatus');
  if (dashStatus) {
    dashStatus.innerHTML = '<div class="text-sky-600 bg-sky-50 px-4 py-2 rounded-lg border border-sky-100">Clique em <strong>Atualizar</strong> para carregar os dados do Dashboard.</div>';
  }
  const tbodyAfastados = document.getElementById('tbodyAfastados');
  if (tbodyAfastados) {
    tbodyAfastados.innerHTML = '<tr><td colspan="5" class="px-6 py-8 text-center text-slate-400">Clique em "Atualizar" para carregar os registos do Google Sheets.</td></tr>';
  }
})();

// Guarda quais fontes de dados falharam na última chamada a dashEnsureData(),
// para que a UI possa avisar o usuário em vez de mostrar "0%" silenciosamente
// quando, por exemplo, a busca de registros falhou/expirou.
let DASH_ULTIMAS_FALHAS = [];

async function dashEnsureData(){
  DASH_ULTIMAS_FALHAS = [];
  // Carregar tudo em paralelo (treinamentos, funcionarios, registros)
  const [rTrein, rFunc, rRegs] = await Promise.all([
    !DASH_treinamentos ? _cachedFetchComStatus('treinamentos') : Promise.resolve({ ok: true, json: null }),
    !DASH_funcionarios ? _cachedFetchComStatus('funcionarios') : Promise.resolve({ ok: true, json: null }),
    !DASH_registrosAll ? _cachedFetchComStatus('registros')    : Promise.resolve({ ok: true, json: null }),
  ]);
  if (!rTrein.ok) DASH_ULTIMAS_FALHAS.push('treinamentos');
  if (!rFunc.ok)  DASH_ULTIMAS_FALHAS.push('funcionários');
  if (!rRegs.ok)  DASH_ULTIMAS_FALHAS.push('registros');

  if (!DASH_treinamentos) DASH_treinamentos = _parseRows(rTrein.json);
  if (!DASH_funcionarios) DASH_funcionarios = _parseRows(rFunc.json);
  if (!DASH_registrosAll) DASH_registrosAll = _parseRows(rRegs.json);

  // Carregar férias — o backend já expõe uma action única e correta
  // (action=ferias, que trata graciosamente até o caso da aba não existir).
  // Antes fazíamos 10 chamadas em paralelo "adivinhando" o nome da aba —
  // isso sobrecarregava o GAS com requisições simultâneas desnecessárias e
  // contribuía para falhas intermitentes em TODAS as chamadas (inclusive
  // treinamentos/funcionários/registros, que competiam pelos mesmos
  // recursos). Mantemos só 1-2 aliases como rede de segurança.
  let feriasOk = false;
  for (const action of ['ferias', 'Ferias']) {
    try {
      const res = await apiFetch('action=' + action);
      const data = await res.json().catch(() => null);
      if (data && data.ok) {
        const rawRows = _parseRows(data);
        feriasServidor = rawRows.map(mapFeriasRow).filter(f => f.Matricula && f.Matricula !== '00000');
        feriasOk = true;
        console.info('[Férias] Carregado via action=' + action + ', ' + feriasServidor.length + ' registo(s)');
        break;
      }
    } catch(e) { /* tenta o próximo alias */ }
  }

  if (!feriasOk) {
    // Fallback final: derivar dos funcionários com campo Situacao
    const norm = s => String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
    const situacoesFerias = ['ferias','afastado','licenca','inss','afastamento','licenca medica','licenca maternidade'];
    const derived = (DASH_funcionarios || []).filter(f =>
      situacoesFerias.some(s => norm(f.Situacao || f.situacao || '').includes(s))
    ).map(f => ({
      Matricula: f.Matricula,
      Funcionario: f.Nome,
      Situacao: f.Situacao || f.situacao || 'Férias',
      InicioFerias: f.InicioFerias || f.inicioFerias || '',
      FimFerias: f.FimFerias || f.fimFerias || ''
    }));
    if (derived.length) {
      feriasServidor = derived;
      console.info('[Férias] Carregado via fallback (campo Situacao), ' + derived.length + ' registo(s)');
    } else {
      console.warn('[Férias] Nenhum dado encontrado. Verifique o nome da aba no Google Sheets (use Diagnóstico Bruto da API).');
    }
  }

  // Sincronizar conjunto local AFAST_set para o filtro do dashboard
  AFAST_set.clear();
  feriasServidor.forEach(f => {
    const m = afastNormMat(f.Matricula);
    if (m && m !== '00000') AFAST_set.add(m);
  });
}

async function dashPopularSelects(){
  const normF = s => String(s??'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const exactos = ['Titulo','titulo','TITULO','Title','title','TituloVideo','titulovideo'];
  const mapaISO = new Map();

  const rows1 = DASH_treinamentos || [];
  const chaves = Object.keys(rows1[0]||{});
  const campo = exactos.find(c => chaves.includes(c)) ?? chaves.find(k => normF(k).includes('titul')) ?? null;
  if (campo) rows1.forEach(r => { const t = String(r[campo]??'').trim(); if(t) mapaISO.set(t, String(r.SemanaISO??'').trim()); });

  const isoSet = new Set(rows1.map(r => String(r.SemanaISO||'')).filter(Boolean));

  const titSel = document.getElementById('dashTitulo');
  if (mapaISO.size){
    titSel.innerHTML = '<option value="">Selecione um título...</option>' + _buildTituloOpts(mapaISO, '');
  }

  const rows2 = DASH_registrosAll || [];
  rows2.forEach(r => { 
    const t = String(r.TituloVideo??r.Titulo??r.titulo??'').trim(); 
    const iso = String(r.SemanaISO??'').trim(); 
    if(t && !mapaISO.has(t)) mapaISO.set(t, iso); 
    else if(t && !mapaISO.get(t) && iso) mapaISO.set(t, iso); 
    if(iso) isoSet.add(iso); 
  });

  const selAtual = titSel.value;
  titSel.innerHTML = '<option value="">Selecione um título...</option>' + _buildTituloOpts(mapaISO, '');
  if (selAtual && [...titSel.options].some(o => o.value === selAtual)) titSel.value = selAtual;

  const isoList = [...isoSet].sort(dashCompareSemanaISODesc);
  document.getElementById('dashSemanaIso').innerHTML =
    '<option value="">Selecione...</option>' + isoList.map(sem => `<option value="${escapeHtml(sem)}">${escapeHtml(sem)}</option>`).join('');
}

function dashSugerirSemanaAtivaMaisRecente(){
  const ativos = (DASH_treinamentos||[]).filter(t => { 
    const v = String(t.Ativo??t.ativo??'').toLowerCase().trim(); 
    return v === 'true' || v === '1' || v === 'sim' || v === 'yes'; 
  });
  const lista = ativos.length ? ativos : (DASH_treinamentos||[]);
  let tituloSelecionado = null;
  if (lista && lista.length){
    const hasISO = lista.filter(t => t.SemanaISO && t.Titulo);
    if (hasISO.length){
      const maisRecente = hasISO.sort((a,b) => dashCompareSemanaISODesc(String(a.SemanaISO), String(b.SemanaISO)))[0];
      tituloSelecionado = String(maisRecente.Titulo);
    }
  }
  const titSel = document.getElementById('dashTitulo');
  if (tituloSelecionado){
    const opt = [...titSel.options].find(o => o.value === tituloSelecionado);
    if (opt) titSel.value = opt.value;
  } else if (titSel.options.length > 1){
    titSel.selectedIndex = 1;
  }

  const titVal = titSel.value;
  if (titVal){
    const hit = (DASH_treinamentos||[]).find(t => String(t.Titulo).trim() === titVal);
    if (hit && hit.SemanaISO) document.getElementById('dashSemanaIso').value = String(hit.SemanaISO);
  }
}

// Atualização de dados do dashboard com recarregamento limpo das fontes de dados
async function dashAtualizar(){
  const dashStatus = document.getElementById('dashStatus');
  const btnAtualizar = document.getElementById('btnDashAtualizar');
  const textoOriginalBtn = btnAtualizar ? btnAtualizar.innerHTML : '';

  // Capturar o título selecionado ANTES de limpar o cache
  const titSelecionadoAntes = document.getElementById('dashTitulo').value.trim();

  if (btnAtualizar) {
    btnAtualizar.disabled = true;
    btnAtualizar.innerHTML = '<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"></path></svg> A carregar...';
  }
  if (dashStatus) dashStatus.innerHTML = '<div class="text-sky-600 bg-sky-50 px-4 py-2 rounded-lg border border-sky-100">A carregar dados atualizados...</div>';

  try {
    // Limpar cache para forçar recarregamento
    delete _apiCache['treinamentos'];
    delete _apiCache['registros'];
    delete _apiCache['funcionarios'];
    delete _apiCacheComStatus['treinamentos'];
    delete _apiCacheComStatus['registros'];
    delete _apiCacheComStatus['funcionarios'];
    DASH_treinamentos = null;
    DASH_funcionarios = null;
    DASH_registrosAll = null;

    // Carregar todos os dados em paralelo
    await dashEnsureData();

    // Se alguma fonte falhou (ex.: timeout do Google Apps Script numa planilha
    // grande), não seguimos em frente fingindo que os dados são "0" — isso
    // induz o gestor a pensar que ninguém participou quando, na verdade, a
    // busca é que falhou. Avisamos e paramos aqui.
    if (DASH_ULTIMAS_FALHAS.length){
      if (dashStatus) dashStatus.innerHTML =
        '<div class="text-rose-600 bg-rose-50 px-4 py-2 rounded-lg border border-rose-100">' +
        '⚠️ Falha ao carregar: ' + DASH_ULTIMAS_FALHAS.join(', ') + '. ' +
        'Os dados abaixo podem estar incompletos — clique em "Atualizar" para tentar novamente.' +
        '</div>';
      return;
    }

    afastRenderTags(); // Atualizar tabela de férias após carregar

    await dashPopularSelects();

    // Tentar restaurar a seleção anterior; se não existir, sugerir a mais recente
    const sel = document.getElementById('dashTitulo');
    if (titSelecionadoAntes && [...sel.options].some(o => o.value === titSelecionadoAntes)) {
      sel.value = titSelecionadoAntes;
    } else {
      dashSugerirSemanaAtivaMaisRecente();
    }

    // Verificar se há um título selecionado para processar
    const titFinal = sel.value.trim();
    if (!titFinal) {
      if (dashStatus) dashStatus.innerHTML = '<div class="text-amber-600 bg-amber-50 px-4 py-2 rounded-lg border border-amber-100">Por favor, selecione um Tema para prosseguir.</div>';
      dashRender([], []);
      dashKPIs({ total: 0, part: 0, nPart: 0, semana: '-', titulo: '-', registrosAll: DASH_registrosAll||[], funcAtivos: (DASH_funcionarios||[]).filter(f => ativoValido(f.Ativo??f.ativo)) });
      return;
    }

    // Processar os dados com o título selecionado
    await dashProcessar(titFinal, dashStatus);
  } catch(e) {
    console.error('Erro ao atualizar dashboard:', e);
    if (dashStatus) dashStatus.innerHTML = '<div class="text-rose-600 bg-rose-50 px-4 py-2 rounded-lg border border-rose-100">Erro ao carregar dados. Tente novamente.</div>';
  } finally {
    if (btnAtualizar) {
      btnAtualizar.disabled = false;
      btnAtualizar.innerHTML = textoOriginalBtn || '<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Atualizar';
    }
  }
}

// Funções auxiliares do dashboard (definidas no escopo global para reutilização)
function normalizarMatricula(v){ return String(v ?? '').replace(/\D/g, '').padStart(5, '0'); }
function normalizarSemanaISO(s){ const m = String(s||'').match(/^(\d{4})-W?(\d{1,2})$/i); if(!m) return ''; return `${m[1]}-W${String(m[2]).padStart(2, '0')}`; }
function ativoValido(v){ return ['true','1','sim','yes'].includes(String(v ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()); }

// Converte uma Semana ISO (ex: "2026-W24") na data (UTC) da segunda-feira
// correspondente. Usado pelo filtro de Data Inicial/Final em "buscar()" para
// determinar quais semanas caem dentro do período informado.
function semanaISOToMonday(isoWeek){
  const m = String(isoWeek||'').match(/^(\d{4})-W(\d{1,2})$/i);
  if (!m) return null;
  const year = parseInt(m[1], 10), week = parseInt(m[2], 10);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dow = jan4.getUTCDay() || 7; // 1 (segunda) .. 7 (domingo)
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - dow + 1 + (week - 1) * 7);
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}

// Processar e renderizar os dados do dashboard para um título selecionado
async function dashProcessar(selTit, dashStatus) {
  let semanaAlvo = '';
  if (!semanaAlvo && selTit){
    const hit = (DASH_treinamentos||[]).find(t => String(t.Titulo).trim() === selTit);
    if (hit && hit.SemanaISO) semanaAlvo = String(hit.SemanaISO);
  }

  if (!semanaAlvo){
    dashStatus.innerHTML = '<div class="text-amber-600 bg-amber-50 px-4 py-2 rounded-lg border border-amber-100">Por favor, selecione um Tema para prosseguir.</div>';
    dashRender([], []);
    dashKPIs({ total: 0, part: 0, nPart: 0, semana: '-', titulo: '-', registrosAll: DASH_registrosAll||[], funcAtivos: (DASH_funcionarios||[]).filter(f => ativoValido(f.Ativo??f.ativo)) });
    renderTemasAbordados('dashTemasAbordados', []);
    renderPerguntasAbordadas('dashPerguntasAbordadas', []);
    return;
  }

  const semanaNorm = normalizarSemanaISO(semanaAlvo);
  const mapaPart = new Map();

  for (const r of (DASH_registrosAll||[])){
    if (normalizarSemanaISO(r.SemanaISO) !== semanaNorm) continue;
    const key = normalizarMatricula(r.Matricula);
    const ts = parseTimestamp(r.Timestamp);

    if (!mapaPart.has(key)){
      mapaPart.set(key, r);
    } else {
      const antigo = mapaPart.get(key);
      const tsAnt = parseTimestamp(antigo.Timestamp);
      if (ts && tsAnt && ts < tsAnt){
        mapaPart.set(key, r);
      }
    }
  }

  const participantes = [...mapaPart.values()];
  const funcAtivos = (DASH_funcionarios||[]).filter(f => ativoValido(f.Ativo ?? f.ativo));
  const setMatPart = new Set(participantes.map(p => normalizarMatricula(p.Matricula)));

  // Extrair datas reais da semana a partir do campo Titulo do treinamento
  // (ex: "15/06/2026 a 21/06/2026") — mais confiável que converter SemanaISO
  // porque a planilha usa numeração sequencial própria (não ISO 8601).
  const tituloTrein = (() => {
    const t = (DASH_treinamentos||[]).find(t => normalizarSemanaISO(t.SemanaISO) === semanaNorm);
    return t ? String(t.Titulo || '') : (selTit || '');
  })();
  const datasReais = (() => {
    const m = tituloTrein.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/g);
    if (!m || m.length < 2) return null;
    const toMs = s => { const p = s.split('/'); return Date.UTC(+p[2], +p[1]-1, +p[0]); };
    return { segMs: toMs(m[0]), domMs: toMs(m[1]) };
  })();
  const segMs = datasReais?.segMs;
  const domMs = datasReais?.domMs;

  // Classificar os não participantes em:
  //   • dispensados  — não participaram MAS estavam de férias/afastados na semana
  //   • naoPart      — não participaram SEM justificativa (faltaram mesmo)
  const dispensados = funcAtivos.filter(f =>
    !setMatPart.has(normalizarMatricula(f.Matricula)) &&
    funcEstaAfastadoNaSemana(f.Matricula, semanaNorm, segMs, domMs)
  );

  const naoPart = funcAtivos.filter(f =>
    !setMatPart.has(normalizarMatricula(f.Matricula)) &&
    !funcEstaAfastadoNaSemana(f.Matricula, semanaNorm, segMs, domMs)
  );

  const mapFunc = new Map(funcAtivos.map(f => [normalizarMatricula(f.Matricula), f]));

  const participantesFull = participantes.map(p => {
    const f = mapFunc.get(normalizarMatricula(p.Matricula)) || {};
    return {
      Matricula: normalizarMatricula(p.Matricula ?? f.Matricula ?? ''),
      Nome: p.Nome ?? f.Nome ?? '',
      Setor: p.Setor ?? f.Setor ?? '',
      Timestamp: p.Timestamp ?? ''
    };
  }).sort((a,b) => String(a.Nome ?? '').localeCompare(String(b.Nome ?? ''), 'pt-PT', { sensitivity: 'base' }));

  const naoParticipantesFull = naoPart.map(f => ({
    Matricula: normalizarMatricula(f.Matricula ?? ''),
    Nome: f.Nome ?? '',
    Setor: f.Setor ?? ''
  })).sort((a,b) => String(a.Nome ?? '').localeCompare(String(b.Nome ?? ''), 'pt-PT', { sensitivity: 'base' }));

  const dispensadosFull = dispensados.map(f => {
    // Obter informação do motivo do afastamento
    const mat = normalizarMatricula(f.Matricula ?? '');
    const regFerias = feriasServidor.filter(fr => afastNormMat(fr.Matricula) === mat);
    const motivo = regFerias.length ? String(regFerias[0].Situacao || 'Férias/Afastamento') : 'Férias/Afastamento';
    const periodo = regFerias.length ? [regFerias[0].InicioFerias, regFerias[0].FimFerias].filter(Boolean).join(' a ') : '';
    return {
      Matricula: mat,
      Nome: f.Nome ?? '',
      Setor: f.Setor ?? '',
      Motivo: motivo,
      Periodo: periodo
    };
  }).sort((a,b) => String(a.Nome ?? '').localeCompare(String(b.Nome ?? ''), 'pt-PT', { sensitivity: 'base' }));

  DASH_participantes    = participantesFull;
  DASH_naoParticipantes = naoParticipantesFull;

  // Total elegíveis = ativos - dispensados (férias/afastamento)
  // Esta é a base correta para o cálculo de adesão
  const total = funcAtivos.length - dispensados.length;
  const part  = participantesFull.length;
  const nPart = naoParticipantesFull.length;
  const nDisp = dispensadosFull.length;

  const tituloAlvo = tituloTrein || (selTit || '-');

  dashKPIs({ total, part, nPart, nDisp, semana: semanaNorm, titulo: tituloAlvo, registrosAll: DASH_registrosAll || [], funcAtivos });
  dashRender(naoParticipantesFull, participantesFull, dispensadosFull);
  dashStatus.innerHTML = `<div class="text-emerald-600 bg-emerald-50 px-4 py-2 rounded-lg border border-emerald-100">Painel atualizado para a semana: ${semanaNorm}</div>`;

  // Exibir os Temas Abordados da semana selecionada
  const treinoAlvo = (DASH_treinamentos||[]).find(t => normalizarSemanaISO(t.SemanaISO) === semanaNorm);
  const assuntos = treinoAlvo && treinoAlvo.Assuntos ? String(treinoAlvo.Assuntos) : '';
  renderTemasAbordados('dashTemasAbordados', assuntos ? [{ titulo: tituloAlvo, semanaISO: semanaNorm, assuntos }] : []);

  // Exibir as Perguntas do Quiz cadastradas para a semana selecionada
  try {
    const perguntas = await _fetchPerguntasGestor(semanaNorm, tituloAlvo);
    renderPerguntasAbordadas('dashPerguntasAbordadas', perguntas.length ? [{ titulo: tituloAlvo, semanaISO: semanaNorm, perguntas }] : []);
  } catch(e) {
    renderPerguntasAbordadas('dashPerguntasAbordadas', []);
  }

  // Calcular histórico de faltas injustificadas (todas as semanas)
  calcularHistoricoFaltas();
}

// ── Histórico de Faltas Injustificadas ───────────────────────────────────────
// Para cada semana registada nos Treinamentos, calcula quais funcionários ativos
// NÃO participaram e NÃO estavam de férias/afastados — ou seja, faltaram sem
// justificativa. Chamado a cada "Atualizar" do Dashboard.
async function calcularHistoricoFaltas(){
  const tbody = document.getElementById('tbodyHistoricoFaltas');
  const totalEl = document.getElementById('historicoFaltasTotal');
  if (!tbody) return;

  tbody.innerHTML = '<tr><td colspan="5" class="px-4 py-8 text-center text-slate-400">A calcular...</td></tr>';

  try {
    // Garantir dados carregados
    await dashEnsureData();

    const treinamentos = (DASH_treinamentos || []).filter(t => ativoValido(t.Ativo ?? t.ativo ?? 'true'));
    const registrosAll = DASH_registrosAll || [];
    const funcAtivos   = (DASH_funcionarios || []).filter(f => ativoValido(f.Ativo ?? f.ativo));
    const mapFunc      = new Map(funcAtivos.map(f => [normalizarMatricula(f.Matricula), f]));

    if (!treinamentos.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="px-4 py-8 text-center text-slate-400">Nenhum treinamento encontrado.</td></tr>';
      if (totalEl) totalEl.textContent = '0';
      return;
    }

    // Helper: dado um Titulo como "15/06/2026 a 21/06/2026", extrair datas
    const datasDoTitulo = titulo => {
      const matches = String(titulo || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/g);
      if (!matches || matches.length < 2) return null;
      const toMs = s => { const p = s.split('/'); return Date.UTC(+p[2], +p[1]-1, +p[0]); };
      return { ini: toMs(matches[0]), fim: toMs(matches[1]) };
    };

    const linhas = [];

    // Ordenar semanas da mais recente para a mais antiga
    const semanasSorted = [...treinamentos].sort((a, b) =>
      String(b.SemanaISO || '').localeCompare(String(a.SemanaISO || ''))
    );

    for (const trein of semanasSorted) {
      const semanaNorm = normalizarSemanaISO(String(trein.SemanaISO || ''));
      const titulo     = String(trein.Titulo || '');
      const datas      = datasDoTitulo(titulo);

      // Matrículas que participaram nesta semana
      const partNesta = new Set(
        registrosAll
          .filter(r => normalizarSemanaISO(String(r.SemanaISO || '')) === semanaNorm)
          .map(r => normalizarMatricula(r.Matricula))
      );

      for (const f of funcAtivos) {
        const mat = normalizarMatricula(f.Matricula);
        if (partNesta.has(mat)) continue;

        // Usar datas reais do Titulo — mais preciso que conversão ISO
        const afastado = datas
          ? funcEstaAfastadoNaSemana(mat, semanaNorm, datas.ini, datas.fim)
          : funcEstaAfastadoNaSemana(mat, semanaNorm);
        if (afastado) continue;

        linhas.push({ semanaISO: semanaNorm, titulo, matricula: mat, nome: f.Nome||'', setor: f.Setor||'' });
      }
    }

    if (totalEl) totalEl.textContent = String(linhas.length);

    // Guardar linhas globalmente para filtragem
    _historicoFaltasLinhas = linhas;

    // Popular dropdowns de filtro
    const semanas = [...new Set(linhas.map(l => l.semanaISO))].sort((a,b) => b.localeCompare(a));
    const setores = [...new Set(linhas.map(l => l.setor).filter(Boolean))].sort();
    const selSem  = document.getElementById('filtroHistSemana');
    const selSet  = document.getElementById('filtroHistSetor');
    if (selSem) {
      const cur = selSem.value;
      selSem.innerHTML = '<option value="">Todas as semanas</option>' + semanas.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
      if (cur && semanas.includes(cur)) selSem.value = cur;
    }
    if (selSet) {
      const cur = selSet.value;
      selSet.innerHTML = '<option value="">Todos os setores</option>' + setores.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
      if (cur && setores.includes(cur)) selSet.value = cur;
    }

    if (!linhas.length) {
      document.getElementById('tbodyHistoricoFaltas').innerHTML =
        '<tr><td colspan="5" class="px-4 py-8 text-center text-emerald-600 font-medium">✅ Nenhuma falta injustificada registada.</td></tr>';
      const countEl = document.getElementById('historicoFaltasFiltrado');
      if (countEl) countEl.textContent = '0 de 0';
      return;
    }

    // Renderizar com filtros actuais
    _renderHistoricoFiltrado();

  } catch(err) {
    console.error('[Histórico Faltas]', err);
    tbody.innerHTML = `<tr><td colspan="5" class="px-4 py-8 text-center text-rose-500">Erro ao calcular: ${escapeHtml(String(err.message || err))}</td></tr>`;
    if (totalEl) totalEl.textContent = '—';
  }
}

// Armazena todas as linhas do histórico para filtragem
let _historicoFaltasLinhas = [];

function _renderHistoricoFiltrado(){
  const tbody      = document.getElementById('tbodyHistoricoFaltas');
  const filtNome   = (document.getElementById('filtroHistNome')?.value || '').toLowerCase().trim();
  const filtSemana = document.getElementById('filtroHistSemana')?.value || '';
  const filtSetor  = document.getElementById('filtroHistSetor')?.value || '';
  const countEl   = document.getElementById('historicoFaltasFiltrado');
  if (!tbody) return;

  const filtradas = _historicoFaltasLinhas.filter(l => {
    if (filtSemana && l.semanaISO !== filtSemana) return false;
    if (filtSetor  && l.setor !== filtSetor)      return false;
    if (filtNome   && !l.nome.toLowerCase().includes(filtNome) && !l.matricula.includes(filtNome)) return false;
    return true;
  });

  if (countEl) countEl.textContent = `${filtradas.length} de ${_historicoFaltasLinhas.length}`;

  if (!filtradas.length){
    tbody.innerHTML = '<tr><td colspan="5" class="px-4 py-8 text-center text-slate-400">Nenhum resultado para os filtros aplicados.</td></tr>';
    return;
  }

  tbody.innerHTML = filtradas.map(l => `
    <tr class="hover:bg-amber-50/40 transition-colors">
      <td class="px-4 py-3 font-mono text-xs text-slate-500">${escapeHtml(l.semanaISO)}</td>
      <td class="px-4 py-3 text-xs text-slate-500">${escapeHtml(l.titulo)}</td>
      <td class="px-4 py-3 font-mono font-semibold text-slate-700">${escapeHtml(l.matricula)}</td>
      <td class="px-4 py-3 font-semibold text-slate-800">${escapeHtml(l.nome)}</td>
      <td class="px-4 py-3 text-slate-600">${escapeHtml(l.setor)}</td>
    </tr>`).join('');
}

// Inicializar listeners dos filtros do Histórico (chamado uma vez)
(function initHistoricoFiltros(){
  const btnLimpar = document.getElementById('btnFiltroHistLimpar');
  ['filtroHistNome','filtroHistSemana','filtroHistSetor'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', _renderHistoricoFiltrado);
    document.getElementById(id)?.addEventListener('change', _renderHistoricoFiltrado);
  });
  btnLimpar?.addEventListener('click', () => {
    const nEl = document.getElementById('filtroHistNome');
    const sEl = document.getElementById('filtroHistSemana');
    const stEl = document.getElementById('filtroHistSetor');
    if (nEl) nEl.value = '';
    if (sEl) sEl.value = '';
    if (stEl) stEl.value = '';
    _renderHistoricoFiltrado();
  });
})();

// Exportação Excel de Não Participantes do Dashboard
async function dashGerarXLS_NP(){
  const base = DASH_naoParticipantes || []; 
  if(!base.length){ alert('Não existem dados de ausentes para exportar.'); return; }
  try { await _ensureXLSX(); } catch(e) { alert('Erro ao carregar biblioteca Excel: ' + e.message); return; }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(base.map(r => ({ 'Matrícula': r.Matricula ?? '', 'Colaborador': r.Nome ?? '', 'Setor': r.Setor ?? '' })));
  XLSX.utils.book_append_sheet(wb, ws, 'Ausentes');
  XLSX.writeFile(wb, `DSS_GIG_NaoParticipantes_${(document.getElementById('kpiSemanaSel').textContent || 'semana')}.xlsx`);
}

// Exportação Excel de Participantes do Dashboard
async function dashGerarXLS_P(){
  const base = DASH_participantes || []; 
  if(!base.length){ alert('Não existem dados de presenças para exportar.'); return; }
  try { await _ensureXLSX(); } catch(e) { alert('Erro ao carregar biblioteca Excel: ' + e.message); return; }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(base.map(r => ({ 'Matrícula': r.Matricula ?? '', 'Colaborador': r.Nome ?? '', 'Setor': r.Setor ?? '', 'Data de Participação': formatTimestamp(r.Timestamp) })));
  XLSX.utils.book_append_sheet(wb, ws, 'Presencas');
  XLSX.writeFile(wb, `DSS_GIG_Participantes_${(document.getElementById('kpiSemanaSel').textContent || 'semana')}.xlsx`);
}

function dashCompareSemanaISODesc(a, b){ 
  const pa = dashParseSemanaISO(a), pb = dashParseSemanaISO(b); 
  if (pa.year !== pb.year) return pb.year - pa.year; 
  return pb.week - pa.week; 
}

function dashParseSemanaISO(s){ 
  const m = String(s||'').match(/^(\d{4})-W?(\d{1,2})$/i); 
  if(!m) return { year: 0, week: 0 }; 
  return { year: +m[1], week: +m[2] }; 
}

// ── Dark Mode ─────────────────────────────────────────────────
(function initDarkMode(){
  const btn       = document.getElementById('btnDarkMode');
  const iconDark  = document.getElementById('iconDark');
  const iconLight = document.getElementById('iconLight');
  const html      = document.documentElement;

  const apply = (dark) => {
    if (dark) {
      html.classList.add('dark');
      iconDark.classList.add('hidden');
      iconLight.classList.remove('hidden');
      btn.title = 'Mudar para modo claro';
    } else {
      html.classList.remove('dark');
      iconDark.classList.remove('hidden');
      iconLight.classList.add('hidden');
      btn.title = 'Mudar para modo escuro';
    }
    try { localStorage.setItem('dssgig_dark', dark ? '1' : '0'); } catch(e){}
  };

  // Preferência salva ou preferência do sistema
  let saved;
  try { saved = localStorage.getItem('dssgig_dark'); } catch(e){}
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  apply(saved !== null ? saved === '1' : prefersDark);

  btn.addEventListener('click', () => apply(!html.classList.contains('dark')));
})();

// ── Abas / Navegação ─────────────────────────────────────────
(function initTabs(){
  const btnPrincipal  = document.getElementById('tabPrincipal');
  const btnDashboard  = document.getElementById('tabDashboard');
  const secFiltros    = document.getElementById('cardFiltros');
  const secResultados = document.getElementById('cardResultados');
  const secDashboard  = document.getElementById('dashCard');

  function setActive(btnOn, btnOff){
    // Aba activa: destaque azul + sombra
    btnOn.classList.add('tab-active', 'bg-brand-500', 'text-white');
    btnOn.classList.remove('text-slate-600', 'hover:text-slate-900', 'bg-white');
    // Aba inactiva: discreta
    btnOff.classList.remove('tab-active', 'bg-brand-500', 'text-white', 'bg-white');
    btnOff.classList.add('text-slate-600', 'hover:text-slate-900');
  }

  function showPrincipal(){
    setActive(btnPrincipal, btnDashboard);
    secFiltros?.classList.remove('is-hidden');
    secResultados?.classList.remove('is-hidden');
    secDashboard?.classList.add('is-hidden');
  }

  function showDashboard(){
    setActive(btnDashboard, btnPrincipal);
    secFiltros?.classList.add('is-hidden');
    secResultados?.classList.add('is-hidden');
    secDashboard?.classList.remove('is-hidden');
  }

  showPrincipal();

  btnPrincipal.addEventListener('click', showPrincipal);
  btnDashboard.addEventListener('click', showDashboard);
  btnPrincipal.addEventListener('touchstart', e => { e.preventDefault(); showPrincipal(); }, { passive: false });
  btnDashboard.addEventListener('touchstart', e => { e.preventDefault(); showDashboard(); }, { passive: false });
})();

// ============================================================================
// MODAL: Gerenciar Perguntas do Quiz (Dashboard)
// Permite ao gestor inserir/remover as perguntas que aparecem no quiz de
// encerramento de cada vídeo semanal — conectado à aba "Perguntas" da
// planilha via as actions 'perguntasgestor' (GET), 'addpergunta' (POST) e
// 'excluirpergunta' (POST) do backend (code.gs).
// ============================================================================
(function initPerguntasModal(){
  const overlay      = document.getElementById('perguntasModalOverlay');
  const btnAbrir      = document.getElementById('btnGerenciarPerguntas');
  const btnFechar      = document.getElementById('btnFecharPerguntasModal');
  const selTitulo      = document.getElementById('pgModalTitulo');
  const statusEl       = document.getElementById('pgModalStatus');
  const listaEl        = document.getElementById('pgModalLista');
  const form           = document.getElementById('pgModalForm');
  if (!overlay || !btnAbrir) return; // markup ainda não presente — não quebra o resto da página

  let _treinosCache = null; // [{Titulo, SemanaISO}] — carregado ao abrir o modal

  function pgStatus(msg, tipo){
    if (!statusEl) return;
    if (!msg) { statusEl.innerHTML = ''; return; }
    const cls = tipo === 'erro' ? 'dssg-modal-status-err' : 'dssg-modal-status-ok';
    statusEl.innerHTML = `<div class="${cls}">${escapeHtml(msg)}</div>`;
  }

  async function popularSelectVideos(){
    selTitulo.innerHTML = '<option value="">Carregando vídeos...</option>';
    try {
      _treinosCache = await fetchTreinamentos();
    } catch(e) {
      _treinosCache = [];
    }
    const lista = (_treinosCache || [])
      .filter(t => t && t.Titulo)
      .sort((a, b) => dashCompareSemanaISODesc(String(a.SemanaISO||''), String(b.SemanaISO||'')));

    if (!lista.length) {
      selTitulo.innerHTML = '<option value="">Nenhum vídeo cadastrado</option>';
      return;
    }
    selTitulo.innerHTML = '<option value="">Selecione um vídeo...</option>' +
      lista.map(t => `<option value="${escapeHtml(String(t.Titulo))}" data-semana="${escapeHtml(String(t.SemanaISO||''))}">${escapeHtml(String(t.SemanaISO||''))} — ${escapeHtml(String(t.Titulo))}</option>`).join('');
  }

  function tituloSelecionadoInfo(){
    const opt = selTitulo.options[selTitulo.selectedIndex];
    if (!opt || !opt.value) return null;
    return { titulo: opt.value, semanaISO: opt.getAttribute('data-semana') || '' };
  }

  async function carregarListaPerguntas(){
    const info = tituloSelecionadoInfo();
    pgStatus('');
    if (!info) {
      listaEl.innerHTML = '<p class="dssg-pg-empty">Selecione um vídeo acima para ver as perguntas já cadastradas.</p>';
      return;
    }
    listaEl.innerHTML = '<p class="dssg-pg-empty">Carregando perguntas...</p>';
    try {
      const res = await apiFetch('action=perguntasgestor&semana=' + encodeURIComponent(info.semanaISO) + '&titulo=' + encodeURIComponent(info.titulo));
      const j = await res.json().catch(() => null);
      const perguntas = (j && j.ok && Array.isArray(j.data)) ? j.data : [];
      renderListaPerguntasModal(perguntas, info);
    } catch(e) {
      listaEl.innerHTML = '<p class="dssg-pg-empty">Falha ao carregar as perguntas. Tente novamente.</p>';
    }
  }

  function renderListaPerguntasModal(perguntas, info){
    if (!perguntas.length) {
      listaEl.innerHTML = '<p class="dssg-pg-empty">Nenhuma pergunta cadastrada para este vídeo ainda. Use o formulário abaixo para adicionar.</p>';
      return;
    }
    listaEl.innerHTML = perguntas.map(p => {
      const opcoes = [['A', p.OpcaoA], ['B', p.OpcaoB], ['C', p.OpcaoC], ['D', p.OpcaoD]]
        .filter(([, texto]) => texto !== undefined && texto !== null && String(texto).trim() !== '')
        .map(([letra, texto]) => `${letra}${letra === p.RespostaCorreta ? ' ✓' : ''}) ${texto}`)
        .join(' · ');
      return `
        <div class="dssg-pg-item" data-num="${escapeHtml(String(p.NumPergunta))}">
          <div>
            <p class="dssg-pg-item-texto"><span class="dssg-pg-item-num">${escapeHtml(String(p.NumPergunta))}.</span>${escapeHtml(String(p.Pergunta || ''))}</p>
            <p class="dssg-pg-item-resp">${escapeHtml(opcoes)}</p>
          </div>
          <button type="button" class="dssg-pg-item-del" data-num="${escapeHtml(String(p.NumPergunta))}">Excluir</button>
        </div>`;
    }).join('');

    listaEl.querySelectorAll('.dssg-pg-item-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const num = btn.getAttribute('data-num');
        if (!confirm(`Excluir a pergunta ${num}? Esta ação não pode ser desfeita.`)) return;
        btn.disabled = true;
        btn.textContent = '...';
        try {
          const res = await apiPost('excluirpergunta', { semanaISO: info.semanaISO, titulo: info.titulo, numPergunta: num });
          const j = await res.json().catch(() => null);
          if (j && j.ok) {
            pgStatus('Pergunta removida.', 'ok');
            _invalidarCachePerguntas();
            await carregarListaPerguntas();
          } else {
            pgStatus((j && j.error) || 'Falha ao excluir a pergunta.', 'erro');
            btn.disabled = false;
            btn.textContent = 'Excluir';
          }
        } catch(e) {
          pgStatus('Erro de conexão ao excluir a pergunta.', 'erro');
          btn.disabled = false;
          btn.textContent = 'Excluir';
        }
      });
    });
  }

  function resetForm(){
    form.reset();
    document.getElementById('pgCorretaA').checked = true;
  }

  function abrirModal(){
    overlay.classList.add('show');
    resetForm();
    pgStatus('');
    popularSelectVideos().then(() => {
      // Se o gestor já tiver um vídeo selecionado no Dashboard, pré-seleciona o mesmo
      const dashSel = document.getElementById('dashTitulo');
      if (dashSel && dashSel.value && [...selTitulo.options].some(o => o.value === dashSel.value)) {
        selTitulo.value = dashSel.value;
      }
      carregarListaPerguntas();
    });
  }

  function fecharModal(){
    overlay.classList.remove('show');
  }

  btnAbrir.addEventListener('click', abrirModal);
  btnFechar?.addEventListener('click', fecharModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) fecharModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.classList.contains('show')) fecharModal(); });

  selTitulo.addEventListener('change', carregarListaPerguntas);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const info = tituloSelecionadoInfo();
    if (!info) { pgStatus('Selecione um vídeo antes de adicionar uma pergunta.', 'erro'); return; }

    const pergunta = document.getElementById('pgFormPergunta').value.trim();
    const opcaoA   = document.getElementById('pgFormA').value.trim();
    const opcaoB   = document.getElementById('pgFormB').value.trim();
    const opcaoC   = document.getElementById('pgFormC').value.trim();
    const opcaoD   = document.getElementById('pgFormD').value.trim();
    const correta  = (form.querySelector('input[name="pgCorreta"]:checked') || {}).value || '';

    if (!pergunta || !opcaoA || !opcaoB) {
      pgStatus('Preencha a pergunta e ao menos as alternativas A e B.', 'erro');
      return;
    }
    const opcoesTexto = { A: opcaoA, B: opcaoB, C: opcaoC, D: opcaoD };
    if (!opcoesTexto[correta]) {
      pgStatus('A alternativa marcada como correta está vazia — preencha o texto dela.', 'erro');
      return;
    }

    const btn = document.getElementById('btnPgAdicionar');
    btn.disabled = true;
    const txtOriginal = btn.textContent;
    btn.textContent = 'Adicionando...';

    try {
      const res = await apiPost('addpergunta', {
        semanaISO: info.semanaISO,
        titulo: info.titulo,
        pergunta, opcaoA, opcaoB, opcaoC, opcaoD,
        respostaCorreta: correta,
        ativo: true,
      });
      const j = await res.json().catch(() => null);
      if (j && j.ok) {
        pgStatus('Pergunta adicionada com sucesso.', 'ok');
        resetForm();
        _invalidarCachePerguntas();
        await carregarListaPerguntas();
      } else {
        pgStatus((j && j.error) || 'Falha ao adicionar a pergunta.', 'erro');
      }
    } catch(e) {
      pgStatus('Erro de conexão ao adicionar a pergunta.', 'erro');
    } finally {
      btn.disabled = false;
      btn.textContent = txtOriginal;
    }
  });
})();
