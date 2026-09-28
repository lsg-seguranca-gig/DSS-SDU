/**
 * DSS SDU — API (Apps Script) para Treinamentos Semanais de Segurança
 * Abas esperadas na planilha:
 * Funcionarios (Matricula, Nome, Setor, Ativo)
 * Treinamentos (SemanaISO, Titulo, URL, Ativo [, Assuntos])
 * Registros    (Timestamp, Matricula, Nome, Setor, SemanaISO, TituloVideo, URLVideo, AssinaturaPNG, DeviceInfo)
 * Ferias       (Matricula, Funcionario, Situacao, InicioFerias, FimFerias)
 * Perguntas    (SemanaISO, Titulo, NumPergunta, Pergunta, OpcaoA, OpcaoB, OpcaoC, OpcaoD, RespostaCorreta, Ativo)
 *              -> criada automaticamente na primeira pergunta cadastrada pelo Gestor.
 */

// === PLANILHA ALVO (fixa) ===
const SPREADSHEET_ID = '1gUo8Txdwdv_o8-1Zq6xwJEmLUmCyuskCX81ypOIYgQ8';
const SHEET_FUNC   = 'Funcionarios';
const SHEET_TREI   = 'Treinamentos';
const SHEET_REG    = 'Registros';
const SHEET_FERIAS = 'Ferias';
const SHEET_PERG   = 'Perguntas';

const PERGUNTAS_HEADER = ['SemanaISO', 'Titulo', 'NumPergunta', 'Pergunta',
  'OpcaoA', 'OpcaoB', 'OpcaoC', 'OpcaoD', 'RespostaCorreta', 'Ativo'];

// Percentual mínimo do vídeo que precisa ter sido realmente reproduzido
// (tempoAssistidoSegundos / duracaoSegundos) para o registro ser aceito.
// Só é aplicado quando o front envia as duas informações.
const MIN_ASSISTIDO_PCT = 0.8;

// Login de ADMINISTRADOR (teste): ao digitar a palavra TESTE no lugar da matrícula
// (maiúsculas/minúsculas e espaços são ignorados), o colaborador entra como
// administrador e o vídeo mais recente da semana fica SEMPRE disponível
// (sem bloqueio por férias, sem esconder vídeo já assistido).
// O admin NUNCA é gravado na planilha Registros e NUNCA aparece nos relatórios
// do DSS Gestor (dashboard, listas, PDF, Excel).
// Para desativar este login, mude para false.
const ENABLE_USUARIO_TESTE = true;
const MATRICULA_TESTE = 'TESTE';

function isAdminTeste_(v) {
  return ENABLE_USUARIO_TESTE &&
    String(v || '').trim().toUpperCase() === MATRICULA_TESTE;
}

// ================= UTILITÁRIOS =================

function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheet(name) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error('Aba não encontrada: ' + name);
  return sh;
}

function getDataAsObjects(sheetName) {
  const sh  = getSheet(sheetName);
  const rng = sh.getDataRange().getValues();
  if (rng.length < 2) return [];
  const headers = rng[0];
  return rng.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[String(h).trim()] = row[i]);
    return obj;
  });
}

function appendRow(sheetName, obj) {
  const sh      = getSheet(sheetName);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const row     = headers.map(h =>
    Object.prototype.hasOwnProperty.call(obj, h) ? obj[h] : ''
  );
  sh.appendRow(row);
}

// ================= NORMALIZAÇÕES =================

function normalizeMatricula(v) {
  const s = String(v || '').trim().replace(/\D/g, '');
  return s ? s.padStart(5, '0') : '';
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

function computeRecentWeeks(treinamentos) {
  const active = treinamentos.filter(t => isAtivo(t['Ativo']));
  const sorted = active.sort((a, b) =>
    String(b['SemanaISO']).localeCompare(String(a['SemanaISO']))
  );
  return sorted.slice(0, 3);
}

function findFuncionarioByMatricula(matricula) {
  if (isAdminTeste_(matricula)) return undefined; // admin não é funcionário
  matricula = normalizeMatricula(matricula);
  const list = getDataAsObjects(SHEET_FUNC);
  return list.find(f =>
    normalizeMatricula(f['Matricula']) === matricula &&
    isAtivo(f['Ativo'])
  );
}

// ================= FÉRIAS / AFASTAMENTOS =================

/**
 * Garante que a aba Ferias tenha o cabeçalho correto nas 5 colunas.
 * Cria automaticamente se a aba estiver vazia.
 */
function ensureFeriasHeader_(sh) {
  if (sh.getLastRow() === 0) {
    sh.appendRow(['Matricula', 'Funcionario', 'Situacao', 'InicioFerias', 'FimFerias']);
  }
}

/**
 * Retorna TODAS as linhas da aba Ferias como array de objetos.
 * Lê as 5 colunas: Matricula, Funcionario, Situacao, InicioFerias, FimFerias.
 * Resposta usada pelo HTML do colaborador para checar bloqueio.
 */
function getFeriasList_() {
  const sh      = getSheet(SHEET_FERIAS);
  const lastRow = sh.getLastRow();

  // Aba vazia ou só cabeçalho
  if (lastRow < 2) return [];

  const numCols = Math.min(sh.getLastColumn(), 5);
  const values  = sh.getRange(2, 1, lastRow - 1, numCols).getValues();

  // Formata uma célula de data para dd/mm/aaaa (trata Date objects e strings)
  function fmtDateCell(v) {
    if (!v) return '';
    if (v instanceof Date) {
      const pad = n => String(n).padStart(2, '0');
      return pad(v.getDate()) + '/' + pad(v.getMonth() + 1) + '/' + v.getFullYear();
    }
    const s = String(v).trim();
    // Já está em dd/mm/aaaa
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;
    // Tenta ISO yyyy-mm-dd
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return iso[3] + '/' + iso[2] + '/' + iso[1];
    return s;
  }

  return values
    .filter(r => normalizeMatricula(r[0]).length > 0)
    .map(r => ({
      Matricula:    normalizeMatricula(r[0]),
      Funcionario:  String(r[1] || '').trim(),
      Situacao:     String(r[2] || '').trim(),
      InicioFerias: fmtDateCell(r[3]),
      FimFerias:    fmtDateCell(r[4])
    }));
}

/**
 * Salva (insere ou atualiza) um registro na aba Ferias.
 * Colunas: A=Matricula  B=Funcionario  C=Situacao  D=InicioFerias  E=FimFerias
 */
function salvarFerias_(body) {
  const matricula    = normalizeMatricula(body.matricula);
  const funcionario  = String(body.funcionario  || '').trim();
  const situacao     = String(body.situacao     || '').trim();
  const inicioFerias = String(body.inicioFerias || '').trim();
  const fimFerias    = String(body.fimFerias    || '').trim();

  if (!matricula) return respond({ ok: false, error: 'Matrícula obrigatória.' });
  if (!situacao)  return respond({ ok: false, error: 'Situação obrigatória (Férias ou Afastado INSS).' });

  const lock = LockService.getScriptLock();
  lock.tryLock(15000);

  try {
    const sh = getSheet(SHEET_FERIAS);
    ensureFeriasHeader_(sh);

    const lastRow = sh.getLastRow();
    let linhaExistente = -1;

    if (lastRow >= 2) {
      const colA = sh.getRange(2, 1, lastRow - 1, 1).getValues();
      for (let i = 0; i < colA.length; i++) {
        if (normalizeMatricula(colA[i][0]) === matricula) {
          linhaExistente = i + 2; // +2: linha 1 é o cabeçalho
          break;
        }
      }
    }

    const rowData = [matricula, funcionario, situacao, inicioFerias, fimFerias];

    if (linhaExistente > 0) {
      sh.getRange(linhaExistente, 1, 1, 5).setValues([rowData]);
    } else {
      sh.appendRow(rowData);
    }

    return respond({ ok: true });

  } catch (err) {
    return respond({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/**
 * Remove a linha do funcionário da aba Ferias pela matrícula.
 * Body esperado (POST ?action=removerFerias): { matricula }
 */
function removeFerias_(body) {
  const matricula = normalizeMatricula(
    (typeof body === 'object' ? body.matricula : body) || ''
  );

  if (!matricula) return respond({ ok: false, error: 'Matrícula obrigatória.' });

  const lock = LockService.getScriptLock();
  lock.tryLock(15000);

  try {
    const sh      = getSheet(SHEET_FERIAS);
    const lastRow = sh.getLastRow();

    if (lastRow < 2) return respond({ ok: true, removed: false, msg: 'Lista já vazia.' });

    const colA    = sh.getRange(2, 1, lastRow - 1, 1).getValues();
    let removed   = false;

    // Percorre de baixo para cima para não deslocar índices ao deletar
    for (let i = colA.length - 1; i >= 0; i--) {
      if (normalizeMatricula(colA[i][0]) === matricula) {
        sh.deleteRow(i + 2);
        removed = true;
      }
    }

    return respond({ ok: true, removed });

  } catch (err) {
    return respond({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/**
 * Remove TODOS os registros da aba Ferias, mantendo apenas o cabeçalho.
 */
function clearFerias_() {
  const lock = LockService.getScriptLock();
  lock.tryLock(15000);

  try {
    const sh      = getSheet(SHEET_FERIAS);
    const lastRow = sh.getLastRow();
    if (lastRow >= 2) sh.deleteRows(2, lastRow - 1);
    return respond({ ok: true });
  } catch (err) {
    return respond({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// ================= DATAS (filtros do Gestor) =================

// Aceita "dd/mm/aaaa" ou "aaaa-mm-dd". Retorna Date no fuso do script.
// fimDoDia=true -> 23:59:59.999 do dia.
function parseDataFiltro_(s, fimDoDia) {
  s = String(s || '').trim();
  if (!s) return null;
  let d, m, y;
  let mt = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mt) { d = +mt[1]; m = +mt[2]; y = +mt[3]; }
  else {
    mt = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!mt) return null;
    y = +mt[1]; m = +mt[2]; d = +mt[3];
  }
  return fimDoDia ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d, 0, 0, 0, 0);
}

function fmtTimestamp_(ts) {
  const pad = n => String(n).padStart(2, '0');
  return `${pad(ts.getDate())}/${pad(ts.getMonth()+1)}/${ts.getFullYear()} ` +
         `${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}`;
}

// ================= PERGUNTAS (QUIZ) =================

function ensurePerguntasSheet_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sh = ss.getSheetByName(SHEET_PERG);
  if (!sh) sh = ss.insertSheet(SHEET_PERG);
  if (sh.getLastRow() === 0) sh.appendRow(PERGUNTAS_HEADER);
  return sh;
}

function mesmoVideo_(row, semanaISO, titulo) {
  return normalizeSemanaISO(row['SemanaISO']) === normalizeSemanaISO(semanaISO) &&
         String(row['Titulo'] || '').trim() === String(titulo || '').trim();
}

// Lê as perguntas de um vídeo. Se a aba ainda não existe, devolve [].
function getPerguntas_(semanaISO, titulo, apenasAtivas) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  if (!ss.getSheetByName(SHEET_PERG)) return [];
  return getDataAsObjects(SHEET_PERG)
    .filter(p => String(p['Pergunta'] || '').trim() !== '')
    .filter(p => mesmoVideo_(p, semanaISO, titulo))
    .filter(p => !apenasAtivas || isAtivo(p['Ativo']))
    .sort((a, b) => Number(a['NumPergunta']) - Number(b['NumPergunta']));
}

// Corrige as respostas. Retorna null se o vídeo não tem perguntas ativas.
// respostas = [{ numPergunta, resposta }]  (perguntas sem resposta contam como erradas)
function avaliarQuiz_(semanaISO, titulo, respostas) {
  const perguntas = getPerguntas_(semanaISO, titulo, true);
  if (!perguntas.length) return null;

  const mapa = {};
  (Array.isArray(respostas) ? respostas : []).forEach(r => {
    if (r) mapa[String(r.numPergunta)] = String(r.resposta || '').trim().toUpperCase();
  });

  const resultados = perguntas.map(p => {
    const num = String(p['NumPergunta']);
    const certa = String(p['RespostaCorreta'] || '').trim().toUpperCase();
    return { numPergunta: num, correta: !!certa && mapa[num] === certa };
  });
  const corretas = resultados.filter(r => r.correta).length;
  return {
    total: perguntas.length,
    corretas,
    resultados,
    aprovado: corretas === perguntas.length
  };
}

function validarQuiz_(body) {
  const { semanaISO, tituloVideo, respostas } = body || {};
  const av = avaliarQuiz_(semanaISO, tituloVideo, respostas);
  if (!av) return respond({ ok: true, aprovado: true, corretas: 0, total: 0, resultados: [] });
  return respond({
    ok: true,
    aprovado: av.aprovado,
    corretas: av.corretas,
    total: av.total,
    resultados: av.resultados   // nunca revela a alternativa correta
  });
}

function addPergunta_(body) {
  const semanaISO = normalizeSemanaISO(body.semanaISO);
  const titulo    = String(body.titulo || '').trim();
  const pergunta  = String(body.pergunta || '').trim();
  const op = {
    A: String(body.opcaoA || '').trim(),
    B: String(body.opcaoB || '').trim(),
    C: String(body.opcaoC || '').trim(),
    D: String(body.opcaoD || '').trim()
  };
  const correta = String(body.respostaCorreta || '').trim().toUpperCase();
  const ativo   = body.ativo === undefined ? true : (body.ativo === true || isAtivo(body.ativo));

  if (!semanaISO || !titulo) return respond({ ok: false, error: 'Vídeo (semana e título) obrigatório.' });
  if (!pergunta || !op.A || !op.B) return respond({ ok: false, error: 'Preencha a pergunta e ao menos as alternativas A e B.' });
  if (!op[correta]) return respond({ ok: false, error: 'A alternativa correta precisa ser A, B, C ou D e estar preenchida.' });

  const lock = LockService.getScriptLock();
  lock.tryLock(15000);
  try {
    ensurePerguntasSheet_();
    const existentes = getPerguntas_(semanaISO, titulo, false);
    const proximo = existentes.reduce((mx, p) => Math.max(mx, Number(p['NumPergunta']) || 0), 0) + 1;

    appendRow(SHEET_PERG, {
      'SemanaISO': semanaISO,
      'Titulo': titulo,
      'NumPergunta': proximo,
      'Pergunta': pergunta,
      'OpcaoA': op.A, 'OpcaoB': op.B, 'OpcaoC': op.C, 'OpcaoD': op.D,
      'RespostaCorreta': correta,
      'Ativo': ativo
    });
    return respond({ ok: true, numPergunta: proximo });
  } catch (err) {
    return respond({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function excluirPergunta_(body) {
  const semanaISO = normalizeSemanaISO(body.semanaISO);
  const titulo    = String(body.titulo || '').trim();
  const num       = String(body.numPergunta || '').trim();
  if (!semanaISO || !titulo || !num) {
    return respond({ ok: false, error: 'Informe semanaISO, titulo e numPergunta.' });
  }

  const lock = LockService.getScriptLock();
  lock.tryLock(15000);
  try {
    const sh = ensurePerguntasSheet_();
    const last = sh.getLastRow();
    if (last < 2) return respond({ ok: false, error: 'Pergunta não encontrada.' });

    const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim());
    const iSem = headers.indexOf('SemanaISO'), iTit = headers.indexOf('Titulo'), iNum = headers.indexOf('NumPergunta');
    const values = sh.getRange(2, 1, last - 1, headers.length).getValues();

    for (let i = values.length - 1; i >= 0; i--) {
      const r = values[i];
      if (normalizeSemanaISO(r[iSem]) === semanaISO &&
          String(r[iTit] || '').trim() === titulo &&
          String(r[iNum]).trim() === num) {
        sh.deleteRow(i + 2);
        return respond({ ok: true });
      }
    }
    return respond({ ok: false, error: 'Pergunta não encontrada.' });
  } catch (err) {
    return respond({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// ================= REGISTROS (consulta) =================

function consultarRegistros_(p) {
  const qMat   = normalizeMatricula(p.matricula || '');
  const exato  = !!p.exato;
  const qNome  = String(p.nome || '').trim().toLowerCase();
  const qSem   = normalizeSemanaISO(p.semana || '');
  const qTit   = String(p.titulo || '').trim();
  const dIni   = parseDataFiltro_(p.dataInicial, false);
  const dFim   = parseDataFiltro_(p.dataFinal, true);
  const comAss = !!p.comAssinatura;

  const listaMat = String(p.matriculas || '')
    .split(',').map(normalizeMatricula).filter(Boolean);
  const setMat = listaMat.length ? new Set(listaMat) : null;

  const out = [];
  getDataAsObjects(SHEET_REG).forEach(r => {
    // Defesa extra: linhas do administrador nunca saem nos relatórios
    if (String(r['Matricula'] || '').trim().toUpperCase() === MATRICULA_TESTE) return;
    const rm = normalizeMatricula(r['Matricula']);
    const rn = String(r['Nome'] || '').toLowerCase();
    const rs = normalizeSemanaISO(r['SemanaISO']);
    const rt = String(r['TituloVideo'] || '').trim();

    if (setMat) {
      // Busca por lista de matrículas (usada para puxar assinaturas do PDF):
      // combina matrícula + (semana OU título)
      if (!setMat.has(rm)) return;
      if ((qSem || qTit) && !((qSem && rs === qSem) || (qTit && rt === qTit))) return;
    } else {
      if (qMat && !(exato ? rm === qMat : rm.includes(qMat))) return;
      if (qNome && !rn.includes(qNome)) return;
      if (qSem && rs !== qSem) return;
      if (qTit && rt !== qTit) return;
    }

    const ts = r['Timestamp'];
    if (ts instanceof Date) {
      if (dIni && ts < dIni) return;
      if (dFim && ts > dFim) return;
      r['Timestamp'] = fmtTimestamp_(ts);
    } else {
      if (dIni || dFim) return; // sem data válida não dá para filtrar por período
      if (ts) r['Timestamp'] = String(ts);
    }

    if (!comAss) delete r['AssinaturaPNG']; // leitura leve; assinatura só sob demanda
    out.push(r);
  });
  return out;
}

// ================= ENDPOINTS =================

function doGet(e) {
  try {
    const action = (e.parameter.action || '').toLowerCase();

    // -- funcionario ----------------------------------------------------------
    if (action === 'funcionario') {
      const matricula = e.parameter.matricula;
      if (!matricula) return respond({ ok: false, error: 'Informe ?matricula=' });
      const func = findFuncionarioByMatricula(matricula);
      if (!func) return respond({ ok: true, found: false });
      return respond({ ok: true, found: true, data: func, funcionario: func });
    }

    // -- identificarColaborador: tudo que a tela do colaborador precisa -------
    if (action === 'identificarcolaborador') {
      const raw = String(e.parameter.matricula || '').trim();

      // Login de administrador: sempre libera o vídeo mais recente da semana,
      // sem férias e sem histórico de registros (por isso nunca some da lista)
      if (isAdminTeste_(raw)) {
        const todos = getDataAsObjects(SHEET_TREI)
          .map(t => ({ ...t, SemanaISO: normalizeSemanaISO(t['SemanaISO']) }));
        return respond({
          ok: true, found: true,
          funcionario: { Matricula: MATRICULA_TESTE, Nome: 'Administrador', Setor: 'TESTE' },
          ferias: [],
          treinamentos: computeRecentWeeks(todos).slice(0, 1),
          registros: []
        });
      }

      const matricula = normalizeMatricula(raw);
      if (!matricula) return respond({ ok: false, error: 'Informe ?matricula=' });

      const func = findFuncionarioByMatricula(matricula);
      if (!func) return respond({ ok: true, found: false });

      const treinamentos = computeRecentWeeks(
        getDataAsObjects(SHEET_TREI).map(t => ({
          ...t, SemanaISO: normalizeSemanaISO(t['SemanaISO'])
        }))
      );

      let ferias = [];
      try {
        ferias = getFeriasList_().filter(f => f.Matricula === matricula);
      } catch (err) { ferias = []; }

      // Só o que o front usa (sem a assinatura em base64, que é pesada)
      const registros = getDataAsObjects(SHEET_REG)
        .filter(r => normalizeMatricula(r['Matricula']) === matricula)
        .map(r => ({
          Matricula:   matricula,
          SemanaISO:   normalizeSemanaISO(r['SemanaISO']),
          TituloVideo: r['TituloVideo']
        }));

      return respond({
        ok: true, found: true,
        funcionario: {
          Matricula: normalizeMatricula(func['Matricula']),
          Nome:  func['Nome'],
          Setor: func['Setor']
        },
        ferias, treinamentos, registros
      });
    }

    // -- treinamentos (3 semanas mais recentes ativas) ------------------------
    if (action === 'treinamentos') {
      const treinamentos = getDataAsObjects(SHEET_TREI).map(t => ({
        ...t, SemanaISO: normalizeSemanaISO(t['SemanaISO'])
      }));
      return respond({ ok: true, data: computeRecentWeeks(treinamentos) });
    }

    // -- treinamentostodos (sem limite de semanas) ----------------------------
    if (action === 'treinamentostodos') {
      const treinamentos = getDataAsObjects(SHEET_TREI)
        .map(t => ({ ...t, SemanaISO: normalizeSemanaISO(t['SemanaISO']) }))
        .sort((a, b) => String(b['SemanaISO']).localeCompare(String(a['SemanaISO'])));
      return respond({ ok: true, data: treinamentos });
    }

    // -- registros ------------------------------------------------------------
    // Params: matricula, matriculas (csv), nome, semana, titulo,
    //         dataInicial, dataFinal, exato=1, comAssinatura=1
    if (action === 'registros') {
      return respond({ ok: true, data: consultarRegistros_(e.parameter) });
    }

    // -- funcionarios (lista completa ativos) ---------------------------------
    if (action === 'funcionarios') {
      const funcionarios = getDataAsObjects(SHEET_FUNC)
        .filter(f => isAtivo(f['Ativo']))
        .filter(f => String(f['Matricula'] || '').trim().toUpperCase() !== MATRICULA_TESTE)
        .map(f => ({
          Matricula: normalizeMatricula(f['Matricula']),
          Nome:  f['Nome'],
          Setor: f['Setor'],
          Ativo: true
        }));
      return respond({ ok: true, data: funcionarios });
    }

    // -- getferiaslist / ferias — lista completa com os 5 campos --------------
    // 'ferias' é o nome usado pelo painel do Gestor; se a aba não existir,
    // devolve lista vazia em vez de erro.
    if (action === 'getferiaslist' || action === 'ferias') {
      try {
        return respond({ ok: true, data: getFeriasList_() });
      } catch (err) {
        if (action === 'ferias') return respond({ ok: true, data: [] });
        throw err;
      }
    }

    // -- perguntas (colaborador) — SEM a resposta correta ---------------------
    if (action === 'perguntas') {
      const data = getPerguntas_(e.parameter.semana, e.parameter.titulo, true)
        .map(p => ({
          NumPergunta: p['NumPergunta'],
          Pergunta:    p['Pergunta'],
          OpcaoA: p['OpcaoA'], OpcaoB: p['OpcaoB'],
          OpcaoC: p['OpcaoC'], OpcaoD: p['OpcaoD']
        }));
      return respond({ ok: true, data });
    }

    // -- perguntasgestor — COM a resposta correta (auditoria) -----------------
    if (action === 'perguntasgestor') {
      return respond({ ok: true, data: getPerguntas_(e.parameter.semana, e.parameter.titulo, false) });
    }

    return respond({
      ok: true,
      msg: 'DSS SDU API — use ?action=[funcionario|identificarColaborador|treinamentos|registros|funcionarios|ferias|getferiaslist|perguntas|perguntasgestor]'
    });

  } catch (err) {
    return respond({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    const action = (e.parameter.action || '').toLowerCase();
    const body   = (e.postData && e.postData.contents)
      ? JSON.parse(e.postData.contents)
      : {};

    // -- registrar participação -----------------------------------------------
    if (action === 'registrar') {
      let { matricula, semanaISO, tituloVideo, urlVideo, assinaturaPNG, deviceInfo,
            tempoAssistidoSegundos, duracaoSegundos, respostasQuiz } = body || {};

      // Administrador: responde ok, mas NÃO grava na planilha (não entra em relatórios)
      if (isAdminTeste_(matricula)) {
        return respond({ ok: true, message: 'Registro de administrador (não gravado).' });
      }

      matricula = normalizeMatricula(matricula);
      semanaISO = normalizeSemanaISO(semanaISO);

      if (!matricula || !semanaISO || !tituloVideo || !urlVideo || !assinaturaPNG) {
        return respond({
          ok: false,
          error: 'Campos obrigatórios: matricula, semanaISO, tituloVideo, urlVideo, assinaturaPNG'
        });
      }

      const func = findFuncionarioByMatricula(matricula);
      if (!func) return respond({ ok: false, error: 'Funcionário não encontrado ou inativo.' });

      // Evidência de que o vídeo foi realmente reproduzido (não confia só no front)
      const tempo   = Number(tempoAssistidoSegundos);
      const duracao = Number(duracaoSegundos);
      if (duracao > 0 && isFinite(tempo) && tempo < duracao * MIN_ASSISTIDO_PCT) {
        return respond({
          ok: false,
          error: 'O vídeo não foi assistido por tempo suficiente. Assista ao vídeo completo e tente novamente.'
        });
      }

      // Segunda checagem do quiz (a primeira foi em 'validarquiz')
      const av = avaliarQuiz_(semanaISO, tituloVideo, respostasQuiz);
      if (av && !av.aprovado) {
        return respond({ ok: false, error: 'As respostas do questionário não foram aprovadas.' });
      }

      appendRow(SHEET_REG, {
        'Timestamp':     new Date(),
        'Matricula':     matricula,
        'Nome':          func['Nome'],
        'Setor':         func['Setor'],
        'SemanaISO':     semanaISO,
        'TituloVideo':   tituloVideo,
        'URLVideo':      urlVideo,
        'AssinaturaPNG': assinaturaPNG,
        'DeviceInfo':    deviceInfo || ''
      });
      return respond({ ok: true, message: 'Registro salvo.' });
    }

    // -- validarQuiz — corrige as respostas sem revelar o gabarito ------------
    if (action === 'validarquiz') {
      return validarQuiz_(body);
    }

    // -- addPergunta / excluirPergunta (painel do Gestor) ---------------------
    if (action === 'addpergunta') {
      return addPergunta_(body);
    }
    if (action === 'excluirpergunta') {
      return excluirPergunta_(body);
    }

    // -- addFuncionario (Cadastro / Exclusão de Colaboradores) ----------------
    // Aceita também as ações de exclusão direta que o front-end possa enviar
    if (action === 'addfuncionario' || action === 'excluirfuncionario' || action === 'deletefuncionario' || action === 'excluircolaborador') {
      if (action !== 'addfuncionario') {
        body.ativo = false; // Força a deleção física e real
      }
      return addFuncionario_(body);
    }

    // -- salvarFerias — insere ou atualiza registro de férias/afastamento -----
    if (action === 'salvarferias') {
      return salvarFerias_(body);
    }

    // -- removerFerias — remove funcionário da lista --------------------------
    if (action === 'removeferias' || action === 'deleteferias' || action === 'excluirferias') {
      return removeFerias_(body);
    }

    // -- clearFerias — limpa toda a aba Ferias --------------------------------
    if (action === 'clearferias') {
      return clearFerias_();
    }

    // -- addFerias — mantido por retrocompatibilidade -------------------------
    if (action === 'addferias') {
      return salvarFerias_({
        matricula:    body.matricula,
        funcionario:  body.funcionario  || '',
        situacao:     body.situacao     || 'Afastado INSS',
        inicioFerias: body.inicioFerias || '',
        fimFerias:    body.fimFerias    || ''
      });
    }

    return respond({
      ok: false,
      error: 'Action inválida. Use: registrar | validarQuiz | addPergunta | excluirPergunta | addFuncionario | salvarFerias | removeFerias | clearFerias'
    });

  } catch (err) {
    return respond({ ok: false, error: String(err) });
  }
}

// ================= CADASTRO E EXCLUSÃO DE COLABORADORES =================

function addFuncionario_(payload) {
  const matricula = normalizeMatricula(payload.matricula);
  const nome      = String(payload.nome  || '').trim();
  const setor     = String(payload.setor || '').trim();
  
  // Deteta se o parâmetro 'ativo' foi enviado (pode vir como Booleano ou String)
  const ativo = payload.ativo !== undefined ? payload.ativo : true;

  if (!matricula) {
    return respond({ ok: false, error: 'Matrícula é obrigatória.' });
  }

  const sh   = getSheet(SHEET_FUNC);
  const lock = LockService.getScriptLock();
  lock.tryLock(30 * 1000);

  try {
    const last = sh.getLastRow();
    let rowIdx = -1;

    // Localizar se a matrícula já existe na planilha Funcionarios
    if (last >= 2) {
      const values = sh.getRange(2, 1, last - 1, 1).getValues();
      for (let i = 0; i < values.length; i++) {
        if (normalizeMatricula(values[i][0]) === matricula) {
          rowIdx = i + 2; // Linha real no Sheets (índice base 0 + 2 do cabeçalho)
          break;
        }
      }
    }

    // CASO DE EXCLUSÃO (ativo === false): Remove o colaborador apenas da aba Funcionarios de forma física e real
    if (ativo === false || String(ativo).toLowerCase() === 'false') {
      if (rowIdx > 0) {
        sh.deleteRow(rowIdx); // Elimina a linha correspondente de forma definitiva da aba Funcionarios
        return respond({ ok: true, message: 'Colaborador excluído com sucesso da aba Funcionários.' });
      } else {
        return respond({ ok: false, error: 'Colaborador não localizado para exclusão.' });
      }
    }

    // CASO DE CADASTRO OU REATIVAÇÃO (ativo === true)
    if (rowIdx > 0) {
      // Se já existe, atualizamos os dados de nome/setor e garantimos que fique ativo (Reativação/Atualização)
      sh.getRange(rowIdx, 2, 1, 3).setValues([[nome, setor, true]]);
      return respond({ ok: true, message: 'Cadastro do colaborador atualizado e reativado.' });
    } else {
      // Se não existe, cria um novo registo no fim da folha
      if (!nome) {
        return respond({ ok: false, error: 'O nome do colaborador é obrigatório para um novo cadastro.' });
      }
      sh.getRange(last + 1, 1, 1, 4).setValues([[matricula, nome, setor, true]]);
      return respond({ ok: true, message: 'Colaborador cadastrado com sucesso.' });
    }

  } catch (err) {
    return respond({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}