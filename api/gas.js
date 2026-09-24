/**
 * Vercel Serverless Function — /api/gas
 * Proxy entre o gestor.html e o Google Apps Script (GAS).
 *
 * ⚙️  Configure a variável de ambiente no painel da Vercel:
 *     GAS_URL = https://script.google.com/macros/s/SEU_DEPLOYMENT_ID/exec
 *
 * Suporta GET (com query params) e POST (com body JSON).
 *
 * ── Por que o redirect manual? ──────────────────────────────────────────────
 * O Google Apps Script SEMPRE responde com um redirect 302 antes de retornar
 * o JSON final. O fetch nativo do Node.js segue o redirect automaticamente em
 * GET, mas em POST converte para GET (comportamento padrão HTTP). Além disso,
 * alguns ambientes Vercel bloqueiam redirects cross-origin silenciosamente.
 * A solução mais robusta é desabilitar o redirect automático (redirect:'manual'),
 * capturar o Location header e fazer uma segunda requisição GET para a URL final.
 *
 * ── Por que cache de borda (Cache-Control) nas leituras? ────────────────────
 * Cada requisição GET obriga o proxy a fazer DUAS chamadas de rede sequenciais
 * ao Google (redirect + resposta final), e se o cache do Apps Script tiver
 * expirado, o Google ainda releva a planilha inteira antes de responder. Essa
 * soma ocasionalmente ultrapassa os 60s (o teto do plano Hobby da Vercel), e
 * a função é encerrada à força — o que aparece para o usuário como uma
 * resposta "não-JSON".
 *
 * Para reduzir quantas vezes essa cadeia lenta é sequer acionada, marcamos as
 * respostas de LEITURA (GET) bem-sucedidas com Cache-Control s-maxage: a CDN
 * da própria Vercel passa a servir buscas repetidas (mesma semana/vídeo,
 * comum quando vários gestores olham o mesmo período) direto do edge, sem
 * acordar o Apps Script. Escritas (POST) NUNCA são cacheadas — continuam
 * sempre indo direto ao Google.
 */

const GAS_URL = process.env.GAS_URL;

// Tempo (segundos) que a CDN da Vercel pode servir uma resposta de leitura
// sem revalidar com o Google. Ajuste conforme a tolerância a dados "levemente
// desatualizados" — 120s é um bom equilíbrio: reduz muito a carga sem deixar
// o dashboard visivelmente desatualizado.
const EDGE_CACHE_SECONDS = 120;

// Ações de escrita — NUNCA devem ser cacheadas, mesmo que por engano
// cheguem como GET no futuro.
const ACTIONS_ESCRITA = new Set([
  'registrar', 'addfuncionario', 'excluirfuncionario', 'deletefuncionario',
  'excluircolaborador', 'addferias', 'deleteferias', 'excluirferias',
  'removeferias', 'addpergunta', 'excluirpergunta', 'deletepergunta',
  'removepergunta', 'validarquiz',
]);

// Tempo máximo (ms) por tentativa — cobre as duas requisições sequenciais
// (redirect + resposta final). Escolhido para permitir 2 tentativas dentro
// do limite de 60s da função na Vercel (2 × 25s = 50s), com margem de
// sobra para overhead de rede/serialização.
const TIMEOUT_TENTATIVA_MS = 25000;

// Ações de LEITURA que envolvem identidade/controle de acesso — mesmo sendo
// GET, nunca são cacheadas na CDN. Se ficassem no cache por até
// EDGE_CACHE_SECONDS, um funcionário excluído pelo Gestor ainda poderia
// "logar" no Colaborador por até 2 minutos, servido do cache, mesmo com a
// planilha já atualizada. As demais leituras (registros/treinamentos/ferias)
// não têm essa implicação e continuam se beneficiando do cache.
const ACTIONS_SEM_CACHE_EDGE = new Set(['funcionario', 'identificarcolaborador']);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Faz uma tentativa completa de chamada ao GAS (com o passo de seguir o
// redirect manualmente). Lança erro se algo der errado — quem chama decide
// se tenta de novo.
//
// timeoutMs cobre a tentativa INTEIRA (as duas requisições sequenciais: a do
// redirect + a final) — sem isso, um travamento do Google consumia sozinho
// os 60s inteiros da função na Vercel, sem sobrar tempo para a 2ª tentativa,
// e a função era encerrada à força pela plataforma em vez de responder com
// um erro claro.
async function chamarGasUmaVez(targetUrl, req, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let firstRes;
    if (req.method === 'POST') {
      firstRes = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body || {}),
        redirect: 'manual',
        signal: controller.signal,
      });
    } else {
      firstRes = await fetch(targetUrl, { method: 'GET', redirect: 'manual', signal: controller.signal });
    }

    let finalText;
    if (firstRes.status >= 300 && firstRes.status < 400) {
      const location = firstRes.headers.get('location');
      if (!location) throw new Error(`GAS retornou ${firstRes.status} sem header Location.`);
      const secondRes = await fetch(location, { method: 'GET', redirect: 'follow', signal: controller.signal });
      finalText = await secondRes.text();
    } else {
      finalText = await firstRes.text();
    }

    try {
      return JSON.parse(finalText);
    } catch (parseErr) {
      // Loga um trecho do que realmente veio (ex.: página de erro/login em
      // HTML do próprio Google — comum quando a publicação do Apps Script
      // expira ou perde permissão) para facilitar o diagnóstico nos logs da
      // Vercel. Nunca repassado ao cliente, só para quem for depurar.
      console.error('[gas] resposta não era JSON. Trecho recebido:', String(finalText).slice(0, 300));
      throw new Error('Resposta não-JSON do Apps Script.');
    }
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  // ── CORS ───────────────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ── Valida configuração ────────────────────────────────────────────────────
  if (!GAS_URL) {
    return res.status(500).json({
      ok: false,
      error: 'Variável de ambiente GAS_URL não configurada no Vercel.'
    });
  }

  try {
    const action = (req.query.action || '').toLowerCase();

    // ── Monta a URL alvo com todos os query params ─────────────────────────
    const params = new URLSearchParams(req.query);
    const gasBase = String(GAS_URL).replace(/\/+$/, ''); // tolera GAS_URL configurada com "/" no final
    const targetUrl = `${gasBase}?${params.toString()}`;

    console.log(`[gas] ${req.method} action=${action} → ${targetUrl}`);

    // ── Chama o GAS ──────────────────────────────────────────────────────
    // Retentativa automática só é segura para leituras (GET/idempotentes).
    // Para POST (ex.: salvar um registro de participação), NUNCA reenviamos
    // sozinhos: se a 1ª tentativa já tiver sido processada pelo GAS e só a
    // RESPOSTA tiver se perdido no caminho, reenviar criaria uma linha
    // duplicada na planilha — pior do que mostrar um erro para o usuário.
    const podeTentarNovamente = req.method !== 'POST';
    const maxTentativas = podeTentarNovamente ? 2 : 1;

    let json;
    let ultimoErro;
    for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
      try {
        json = await chamarGasUmaVez(targetUrl, req, TIMEOUT_TENTATIVA_MS);
        ultimoErro = null;
        break;
      } catch (err) {
        ultimoErro = err;
        const foiTimeout = err.name === 'AbortError';
        console.warn(`[gas] tentativa ${tentativa} falhou${foiTimeout ? ' (tempo limite excedido)' : ''}: ${err.message || err}`);
        if (tentativa < maxTentativas) await sleep(400);
      }
    }

    if (ultimoErro) {
      console.error('[gas] falhou:', ultimoErro);
      const foiTimeout = ultimoErro.name === 'AbortError';
      const msg = req.method === 'POST'
        ? (foiTimeout
            ? 'Tempo limite excedido ao aguardar confirmação do Google. Antes de tentar de novo, verifique na planilha se o registro já não foi gravado — para evitar duplicidade.'
            : 'Não foi possível confirmar se os dados foram salvos (falha na resposta do Google, não no envio). Antes de tentar de novo, verifique na planilha se o registro já não foi gravado — para evitar duplicidade.')
        : (foiTimeout
            ? 'O Google Apps Script demorou demais para responder. Tente novamente em instantes.'
            : 'GAS retornou resposta não-JSON após retentativa. Verifique se o script está publicado corretamente.');
      return res.status(502).json({ ok: false, error: msg });
    }

    // ── Cache de borda (CDN da Vercel) só para leituras bem-sucedidas ───────
    // Buscas repetidas com os MESMOS parâmetros (ex.: mesma semana/vídeo no
    // Dashboard) passam a ser servidas direto pela CDN, sem acordar o Apps
    // Script — reduz quantas vezes a cadeia lenta (redirect duplo + releitura
    // da planilha) é sequer acionada. Nunca aplicado a POST/ações de escrita.
    const podeCachear = req.method === 'GET'
      && !ACTIONS_ESCRITA.has(action)
      && !ACTIONS_SEM_CACHE_EDGE.has(action)
      && json && json.ok !== false;
    if (podeCachear) {
      res.setHeader(
        'Cache-Control',
        `public, s-maxage=${EDGE_CACHE_SECONDS}, stale-while-revalidate=${EDGE_CACHE_SECONDS * 2}`
      );
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }

    return res.status(200).json(json);

  } catch (err) {
    console.error('[gas] erro:', err);
    return res.status(502).json({
      ok: false,
      error: 'Falha ao contactar o Google Apps Script: ' + String(err.message || err)
    });
  }
}
