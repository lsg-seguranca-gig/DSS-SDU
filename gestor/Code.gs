/**
 * DSS GIG — API (Apps Script) para Treinamentos Semanais de Segurança
 * Abas esperadas na planilha:
 * Funcionarios(Matricula, Nome, Setor, Ativo)
 * Treinamentos(SemanaISO, Titulo, URL, Ativo)
 * Registros(Timestamp, Matricula, Nome, Setor, SemanaISO, TituloVideo, URLVideo, AssinaturaPNG, DeviceInfo)
 */

// === PLANILHA ALVO (fixa) ===
const SPREADSHEET_ID = '1zmEC0-JC-F2zi9oaP3Ea5lUXCNexl3MFf4KnSPMZlOs';
const SHEET_FUNC = 'Funcionarios';
const SHEET_TREI = 'Treinamentos';
const SHEET_REG  = 'Registros';

// ================= UTILITÁRIOS =================

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheet(name) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error('Aba não encontrada: ' + name);
  return sh;
}

function getDataAsObjects(sheetName) {
  const sh = getSheet(sheetName);
  const rng = sh.getDataRange().getValues();
  if (rng.length < 2) return [];
  const headers = rng[0];

  return rng.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[String(h).trim()] = row[i]);
    return obj;
  });
}

// Lê da planilha com cache de 10 minutos via CacheService do Apps Script.
// Evita abrir e ler a planilha inteira a cada requisição quando os dados
// não mudaram — reduz drasticamente o tempo de resposta da API.
const CACHE_TTL = 600; // 10 minutos em segundos

function getCachedData(cacheKey, sheetName) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch(e) {}
  }
  const data = getDataAsObjects(sheetName);
  try {
    // CacheService suporta até 100 KB por entrada; se a serialização for maior
    // simplesmente não armazena no cache (lê direto da planilha na próxima vez).
    const serialized = JSON.stringify(data);
    if (serialized.length < 100000) cache.put(cacheKey, serialized, CACHE_TTL);
  } catch(e) {}
  return data;
}

// Invalida o cache de uma aba específica (chamado após escrita na planilha)
function invalidateCache(cacheKey) {
  try { CacheService.getScriptCache().remove(cacheKey); } catch(e) {}
}

function appendRow(sheetName, obj) {
  const sh = getSheet(sheetName);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const row = headers.map(h =>
    Object.prototype.hasOwnProperty.call(obj, h) ? obj[h] : ''
  );
  sh.appendRow(row);
}

// ================= NORMALIZAÇÕES =================

function normalizeMatricula(v) {
  return String(v || '').trim().replace(/\D/g, '');
}

function normalizeSemanaISO(v) {
  v = String(v || '').toUpperCase().trim();
  const match = v.match(/^(\d{4})-W?(\d{1,2})$/);
  if (!match) return v;
  return match[1] + '-W' + ('0' + match[2]).slice(-2);
}

function isAtivo(v) {
  return ['true', '1', 'sim', 'yes'].includes(
    String(v || '').toLowerCase().trim()
  );
}

// ================= DOMÍNIO =================

function getAllActiveWeeks(treinamentos) {
  const active = treinamentos.filter(t => isAtivo(t['Ativo']));
  return active.sort((a, b) =>
    String(b['SemanaISO']).localeCompare(String(a['SemanaISO']))
  );
}

function findFuncionarioByMatricula(matricula) {
  matricula = normalizeMatricula(matricula);
  const list = getDataAsObjects(SHEET_FUNC);

  return list.find(f =>
    normalizeMatricula(f['Matricula']) === matricula &&
    isAtivo(f['Ativo'])
  );
}

// ================= ENDPOINTS =================

function doGet(e) {
  try {
    const action = (e.parameter.action || '').toLowerCase();

    if (action === 'funcionario') {
      const matricula = e.parameter.matricula;
      if (!matricula)
        return respond({ ok: false, error: 'Informe ?matricula=' });

      const list = getCachedData('cache_funcionarios', SHEET_FUNC);
      const func = list.find(f =>
        normalizeMatricula(f['Matricula']) === normalizeMatricula(matricula) &&
        isAtivo(f['Ativo'])
      );
      if (!func) return respond({ ok: true, found: false });

      return respond({ ok: true, found: true, data: func });
    }

    if (action === 'treinamentos') {
      const treinamentos = getCachedData('cache_treinamentos', SHEET_TREI);
      const normalized = treinamentos.map(t => ({
        ...t,
        SemanaISO: normalizeSemanaISO(t['SemanaISO'])
      }));
      const recent = getAllActiveWeeks(normalized);
      return respond({ ok: true, data: recent });
    }

    if (action === 'registros') {
      const qMat = normalizeMatricula(e.parameter.matricula || '');
      const qNome = String(e.parameter.nome || '').trim().toLowerCase();
      const qSem = normalizeSemanaISO(e.parameter.semana || '');

      const regs = getCachedData('cache_registros', SHEET_REG).filter(r => {
        const m = normalizeMatricula(r['Matricula']);
        const n = String(r['Nome'] || '').toLowerCase();
        const s = normalizeSemanaISO(r['SemanaISO']);

        return (!qMat || m.includes(qMat)) &&
               (!qNome || n.includes(qNome)) &&
               (!qSem || s === qSem);
      });

      return respond({ ok: true, data: regs });
    }

    return respond({
      ok: true,
      msg: "DSS GIG API — use ?action=[funcionario|treinamentos|registros]"
    });

  } catch (err) {
    return respond({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    const action = (e.parameter.action || '').toLowerCase();
    const body = (e.postData && e.postData.contents)
      ? JSON.parse(e.postData.contents)
      : {};

    if (action === 'registrar') {

      let { matricula, semanaISO, tituloVideo, urlVideo, assinaturaPNG, deviceInfo } = body || {};

      matricula = normalizeMatricula(matricula);
      semanaISO = normalizeSemanaISO(semanaISO);

      if (!matricula || !semanaISO || !tituloVideo || !urlVideo || !assinaturaPNG) {
        return respond({
          ok: false,
          error: 'Campos obrigatórios: matricula, semanaISO, tituloVideo, urlVideo, assinaturaPNG'
        });
      }

      const func = findFuncionarioByMatricula(matricula);
      if (!func)
        return respond({ ok: false, error: 'Funcionário não encontrado ou inativo.' });

      const rowObj = {
        'Timestamp': new Date(),
        'Matricula': matricula,
        'Nome': func['Nome'],
        'Setor': func['Setor'],
        'SemanaISO': semanaISO,
        'TituloVideo': tituloVideo,
        'URLVideo': urlVideo,
        'AssinaturaPNG': assinaturaPNG,
        'DeviceInfo': deviceInfo || ''
      };

      appendRow(SHEET_REG, rowObj);
      invalidateCache('cache_registros'); // força releitura na próxima pesquisa
      return respond({ ok: true, message: 'Registro salvo.' });
    }

    if (action === 'addfuncionario') {
      return addFuncionario_(body);
    }

    return respond({
      ok: false,
      error: 'Defina ?action=registrar ou ?action=addFuncionario'
    });

  } catch (err) {
    return respond({ ok: false, error: String(err) });
  }
}

// ================= CADASTRO FUNCIONÁRIO =================

function addFuncionario_(payload) {

  let matricula = normalizeMatricula(payload.matricula);
  const nome = String(payload.nome || '').trim();
  const setor = String(payload.setor || '').trim();

  if (!matricula || !nome) {
    return respond({ ok: false, error: 'Matrícula e Nome são obrigatórios.' });
  }

  const sh = getSheet(SHEET_FUNC);
  const lock = LockService.getScriptLock();
  lock.tryLock(30 * 1000);

  try {
    const last = sh.getLastRow();

    if (last >= 2) {
      const values = sh.getRange(2, 1, last - 1, 1).getValues();
      const exists = values.some(r =>
        normalizeMatricula(r[0]) === matricula
      );

      if (exists) {
        return respond({ ok: false, error: 'Matrícula já cadastrada.' });
      }
    }

    const next = last + 1;
    sh.getRange(next, 1, 1, 4)
      .setValues([[matricula, nome, setor, true]]);

    invalidateCache('cache_funcionarios'); // força releitura na próxima pesquisa
    return respond({ ok: true });

  } catch (err) {
    return respond({ ok: false, error: String(err) });

  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}