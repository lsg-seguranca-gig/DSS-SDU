// DSS GIG — Colaborador (colab.js)
// Toda a lógica de identificação, listagem de vídeos, player e registro.

const API_BASE = '/api/gas';

let funcionario = null;
let treinamentos = [];
let selectedVideo = null;
let player = null;
let signaturePad = null;
let videoEnded = false;
let ytReady = false;

// ─── Controle de reprodução ("blindagem" do vídeo) ─────────────────────────────
let maxWatchedSeconds = 0;   // ponto máximo do vídeo já assistido de fato (não pode "pular" além disso)
let watchedAccumSeconds = 0; // soma do tempo efetivamente reproduzido (enviado ao backend como evidência)
let lastPollTs = null;       // timestamp do último tick do monitor de reprodução
let watchPollTimer = null;   // referência do setInterval que faz o monitoramento
const SEEK_TOLERANCE = 1.5;  // segundos de tolerância antes de considerar "avanço indevido"

// ─── Checkpoint de atenção ("Continuar vídeo?") ────────────────────────────────
const CHECKPOINT_INTERVAL_SECONDS = 120; // a cada 2 minutos
let checkpointBuckets = new Set();       // marcos de tempo já exibidos, para não repetir

// ─── Quiz de encerramento (perguntas do vídeo) ─────────────────────────────────
let respostasQuizAtual = []; // últimas respostas aprovadas, reenviadas no registro final

// ─── Utilitários ──────────────────────────────────────────────────────────────

function extractYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1);
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const m = url.match(/embed\/([\w\-]+)/);
    if (m) return m[1];
  } catch (e) {}
  return null;
}

function normMat(v) {
  return String(v || '').replace(/\D/g, '').padStart(5, '0');
}

// Entende múltiplos formatos: "dd/mm/aaaa" (texto digitado) e formatos ISO
// ("aaaa-mm-dd" ou "aaaa-mm-ddTHH:mm:ss.sssZ" — o que a API devolve quando a
// célula da planilha foi reconhecida como Data em vez de texto puro). Sem
// isso, um período de férias com célula-Data faz o funcionário ficar
// bloqueado para sempre, mesmo depois de as férias terminarem.
function parseDateBR(s) {
  if (!s) return null;
  s = String(s).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
  const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) return new Date(Date.UTC(+br[3], +br[2] - 1, +br[1]));
  return null;
}

function isoParaSegunda(iso) {
  const m = String(iso || '').match(/^(\d{4})-W(\d{1,2})$/i);
  if (!m) return null;
  const jan4 = new Date(Date.UTC(+m[1], 0, 4));
  const dow = jan4.getUTCDay() || 7;
  const seg = new Date(jan4);
  seg.setUTCDate(jan4.getUTCDate() - dow + 1 + (+m[2] - 1) * 7);
  return seg;
}

function isoParaDomingo(iso) {
  const seg = isoParaSegunda(iso);
  if (!seg) return null;
  const dom = new Date(seg);
  dom.setUTCDate(seg.getUTCDate() + 6);
  return dom;
}

// Retorna a semana ISO da data atual no formato "AAAA-WNN"
function getSemanaAtualISO() {
  const hoje = new Date();
  // Janeiro 4 sempre cai na semana 1 (norma ISO 8601)
  const jan4 = new Date(Date.UTC(hoje.getUTCFullYear(), 0, 4));
  const dow = jan4.getUTCDay() || 7;
  const seg1 = new Date(jan4);
  seg1.setUTCDate(jan4.getUTCDate() - dow + 1);

  const hojeUTC = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate()));
  const diffDias = Math.round((hojeUTC - seg1) / 86400000);
  let semana = Math.floor(diffDias / 7) + 1;
  let ano = hoje.getUTCFullYear();

  // Ajuste de ano (semana 53 pode pertencer ao próximo ano)
  if (semana < 1) { ano--; semana = 52; }
  if (semana > 52) {
    const jan4Prox = new Date(Date.UTC(ano + 1, 0, 4));
    const dow2 = jan4Prox.getUTCDay() || 7;
    const seg1Prox = new Date(jan4Prox);
    seg1Prox.setUTCDate(jan4Prox.getUTCDate() - dow2 + 1);
    if (hojeUTC >= seg1Prox) { ano++; semana = 1; }
  }

  return `${ano}-W${String(semana).padStart(2, '0')}`;
}

function semanaEmFerias(semanaISO, inicioFerias, fimFerias) {
  const seg = isoParaSegunda(semanaISO);
  const dom = isoParaDomingo(semanaISO);
  if (!seg || !dom) return true;
  const ini = parseDateBR(inicioFerias);
  const fim = parseDateBR(fimFerias);
  if (!ini && !fim) return true;
  if (ini && !fim) return dom >= ini;
  if (!ini && fim) return seg <= fim;
  return seg <= fim && dom >= ini;
}

// ─── Chamadas à API ───────────────────────────────────────────────────────────

async function apiFetch(params) {
  const res = await fetch(API_BASE + '?' + params + '&_t=' + Date.now());
  try { return await res.json(); }
  catch { return { ok: false, error: 'Resposta inválida', status: res.status }; }
}

async function fetchFuncionario(m) {
  return apiFetch('action=funcionario&matricula=' + encodeURIComponent(m));
}

// Combina, numa única chamada ao GAS, tudo que a identificação do colaborador
// precisa: dados do funcionário, férias/afastamentos dele, catálogo de
// treinamentos e os registros de participação dele. Substitui as 4 chamadas
// separadas que existiam antes (1 sequencial + 3 em paralelo), reduzindo o
// número de idas-e-voltas de rede — cada uma delas paga um custo fixo de
// latência, então menos chamadas = identificação mais rápida.
async function fetchIdentificarColaborador(m) {
  return apiFetch('action=identificarColaborador&matricula=' + encodeURIComponent(m));
}

async function fetchTreinamentos() {
  return apiFetch('action=treinamentos');
}

async function fetchRegistros(m) {
  return apiFetch('action=registros&matricula=' + encodeURIComponent(m) + '&exato=1');
}

async function fetchFeriasList() {
  try { return await apiFetch('action=getFeriasList'); }
  catch { return { ok: false }; }
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function showInfo(html) {
  const el = document.getElementById('funcInfo');
  el.innerHTML = html;
  el.classList.remove('hidden');
}

function hideInfo() {
  const el = document.getElementById('funcInfo');
  el.innerHTML = '';
  el.classList.add('hidden');
}

function alertCard(type, html) {
  const styles = {
    ok:   'bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-700 text-emerald-800 dark:text-emerald-200',
    warn: 'bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 text-amber-800 dark:text-amber-200',
    error:'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 text-red-800 dark:text-red-200',
    block:'bg-red-50 dark:bg-red-900/40 border-2 border-red-400 dark:border-red-600 text-red-900 dark:text-red-200',
  };
  return `<div class="px-4 py-3 rounded-xl text-sm font-medium ${styles[type] || styles.warn}">${html}</div>`;
}

// ─── Dark Mode ────────────────────────────────────────────────────────────────

(function initDarkMode() {
  const html = document.documentElement;
  const sun  = document.getElementById('iconSun');
  const moon = document.getElementById('iconMoon');

  // Cores da caneta: mantido apenas o valor escuro — ver explicação abaixo.
  // Cor da caneta — azul, para ficar visualmente consistente com o "azul
  // caneta" usado no relatório em PDF (ver _processarAssinaturaCanvas no
  // app.js do DSS Gestor). Fixa, independente do modo claro/escuro do app.
  const PEN_COLOR = '#1d4ed8';

  // IMPORTANTE: a cor da caneta e o fundo do canvas de assinatura são fixos
  // (tinta escura sobre fundo branco), independente do modo escuro do app.
  // Motivo: o canvas.toDataURL() exportado NUNCA inclui o fundo definido via
  // CSS (canvas.style.background) — só o que foi de fato desenhado no
  // canvas. Antes, no modo escuro, a caneta ficava clara para contrastar
  // com o fundo escuro *da tela*, e isso funcionava perfeitamente enquanto o
  // colaborador via a própria assinatura sendo desenhada — só que a imagem
  // exportada saía com um traço claro sobre fundo TRANSPARENTE. Assim que
  // essa assinatura era impressa numa página branca (o relatório em PDF),
  // ficava praticamente invisível — mesmo a pessoa tendo assinado
  // normalmente e vendo a própria assinatura perfeitamente na tela dela.
  function getPenColor() {
    return PEN_COLOR; // sempre azul — nunca varia com o modo claro/escuro
  }

  function setDark(dark) {
    html.classList.toggle('dark', dark);
    sun.classList.toggle('hidden', !dark);
    moon.classList.toggle('hidden', dark);
    try { localStorage.setItem('dssgig_dark', dark ? '1' : '0'); } catch (e) {}

    // A cor da caneta e o fundo do canvas de assinatura NÃO acompanham o
    // modo escuro — ver explicação acima em getPenColor().
    if (signaturePad) {
      signaturePad.penColor = getPenColor();
    }
    const canvas = document.getElementById('signaturePad');
    if (canvas) {
      canvas.style.background = '#ffffff';
    }
  }

  let saved = '0';
  try { saved = localStorage.getItem('dssgig_dark') || '0'; } catch (e) {}
  setDark(saved === '1');

  document.getElementById('btnDarkMode').addEventListener('click', () => {
    setDark(!html.classList.contains('dark'));
  });

  // Expor getPenColor para uso na inicialização do SignaturePad
  window._getPenColor = getPenColor;
})();

// ─── YouTube API ──────────────────────────────────────────────────────────────

// Callback global chamado pelo script da YouTube IFrame API
window.onYouTubeIframeAPIReady = function () {
  ytReady = true;
};

// Alterna o visual do overlay entre "play" e "pause"/"escondido", mas o botão em
// si (a área clicável) NUNCA é removida do DOM (nunca usa display:none) — assim
// nenhum toque chega diretamente ao iframe do YouTube, o que bloqueia os gestos
// nativos do player (ex: duplo toque para avançar/retroceder 10s).
function updatePlayOverlay(playing) {
  const btn = document.getElementById('btnPlayOverlay');
  const iconWrap = document.getElementById('playIconWrap');
  if (!btn || !iconWrap) return;
  if (playing) {
    btn.classList.remove('bg-black/30', 'hover:bg-black/20');
    iconWrap.classList.add('opacity-0', 'pointer-events-none');
  } else {
    btn.classList.add('bg-black/30', 'hover:bg-black/20');
    iconWrap.classList.remove('opacity-0', 'pointer-events-none');
  }
}

// Trava a velocidade de reprodução em 1x — reverte qualquer alteração,
// mesmo que provocada por atalho de teclado ou script externo.
function onPlayerRateChange(e) {
  if (e.data !== 1 && player && player.setPlaybackRate) {
    player.setPlaybackRate(1);
  }
}

// Inicia o monitor de reprodução assim que o player está pronto. Roda a cada
// ~400ms enquanto o vídeo está tocando e faz duas coisas:
//  1) Bloqueia avanço indevido (arraste de barra externa, atalhos, DevTools):
//     se currentTime saltar além do que já foi assistido + tolerância, volta
//     o vídeo para o ponto máximo já assistido.
//  2) Acumula o tempo efetivamente assistido, para enviar como evidência ao
//     backend no momento do registro (ver payload em btnRegistrar).
function onPlayerReady() {
  if (watchPollTimer) clearInterval(watchPollTimer);
  lastPollTs = null;

  watchPollTimer = setInterval(() => {
    if (!player || typeof player.getPlayerState !== 'function') return;
    if (player.getPlayerState() !== YT.PlayerState.PLAYING) { lastPollTs = null; return; }

    const now = performance.now();
    const t = player.getCurrentTime();

    if (t > maxWatchedSeconds + SEEK_TOLERANCE) {
      // Avanço indevido detectado — devolve ao ponto máximo já assistido.
      player.seekTo(maxWatchedSeconds, true);
    } else {
      if (lastPollTs !== null) {
        const delta = (now - lastPollTs) / 1000;
        if (delta > 0 && delta < 1.5) watchedAccumSeconds += delta;
      }
      if (t > maxWatchedSeconds) maxWatchedSeconds = t;

      // Checkpoint de atenção: a cada CHECKPOINT_INTERVAL_SECONDS, pausa e
      // pergunta se o colaborador quer continuar. Evita disparar nos
      // segundos finais do vídeo (duracao - t <= 5), onde não faz sentido.
      const duracao = (typeof player.getDuration === 'function') ? player.getDuration() : 0;
      const bucket = Math.floor(t / CHECKPOINT_INTERVAL_SECONDS);
      if (bucket > 0 && !checkpointBuckets.has(bucket) && (!duracao || duracao - t > 5)) {
        checkpointBuckets.add(bucket);
        player.pauseVideo();
        showCheckpointModal();
      }
    }
    lastPollTs = now;
  }, 400);
}

function onPlayerStateChange(e) {
  const playBtn = document.getElementById('btnPlayOverlay');
  if (!playBtn) return;

  if (e.data === YT.PlayerState.PLAYING) {
    updatePlayOverlay(true);
  } else if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.CUED) {
    updatePlayOverlay(false);
    lastPollTs = null;
  }

  if (e.data === YT.PlayerState.ENDED) {
    videoEnded = true;
    updatePlayOverlay(false);
    lastPollTs = null;
    iniciarEtapaPosVideo();
  }
}

// ─── Etapa pós-vídeo: quiz (se o vídeo tiver perguntas cadastradas) e assinatura ─

// Revela o bloco de assinatura e inicializa o pad — extraído do antigo handler
// de ENDED para poder ser chamado tanto direto (vídeo sem quiz) quanto depois
// de o colaborador acertar as perguntas do quiz.
function liberarAssinatura() {
  // Mostrar o bloco ANTES de medir o canvas, para que offsetWidth seja correto
  const signBlock = document.getElementById('signatureBlock');
  signBlock.classList.remove('hidden');
  document.getElementById('btnRegistrar').classList.remove('hidden');

  // Inicializar o pad de assinatura com tamanho correto
  const canvas = document.getElementById('signaturePad');
  // Forçar largura explícita pelo offsetWidth (só funciona após display:block)
  const containerWidth = canvas.parentElement ? canvas.parentElement.clientWidth - 4 : 600;
  canvas.width  = containerWidth > 0 ? containerWidth : 600;
  canvas.height = 280;

  // Aguardar SignaturePad estar disponível (pode ainda não ter carregado)
  const initPad = () => {
    if (typeof SignaturePad === 'undefined') {
      setTimeout(initPad, 100);
      return;
    }
    // Fundo branco e tinta escura fixos, independente do modo escuro do app —
    // ver explicação detalhada junto de getPenColor() no initDarkMode().
    canvas.style.background = '#ffffff';
    const corCaneta = window._getPenColor ? window._getPenColor() : '#1d4ed8';

    if (!signaturePad) {
      signaturePad = new SignaturePad(canvas, {
        minWidth: 1,
        maxWidth: 3,
        penColor: corCaneta,
        backgroundColor: 'rgba(0,0,0,0)',
      });
    } else {
      signaturePad.penColor = corCaneta;
      signaturePad.clear();
    }
  };
  initPad();

  // Rolar suavemente até a assinatura
  signBlock.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Monta o HTML de uma pergunta dentro do bloco de quiz (ver #quizBlock no HTML)
function renderQuiz(perguntas) {
  const cont = document.getElementById('quizPerguntas');
  cont.innerHTML = '';
  perguntas.forEach((p, idx) => {
    const opcoes = [['A', p.OpcaoA], ['B', p.OpcaoB], ['C', p.OpcaoC], ['D', p.OpcaoD]]
      .filter(([, texto]) => texto !== undefined && texto !== null && String(texto).trim() !== '');

    const card = document.createElement('div');
    card.className = 'quiz-card';
    card.dataset.num = p.NumPergunta;

    const opcoesHtml = opcoes.map(([letra, texto]) => `
      <label class="quiz-option">
        <input type="radio" name="quiz_${p.NumPergunta}" value="${letra}">
        <span>${letra}) ${texto}</span>
      </label>`).join('');

    card.innerHTML = `<p class="quiz-question">${idx + 1}. ${p.Pergunta}</p>${opcoesHtml}`;
    cont.appendChild(card);
  });
}

// Chamada assim que o vídeo termina: busca as perguntas cadastradas para este
// vídeo (SemanaISO + Titulo). Se não houver nenhuma, segue direto para a
// assinatura — assim vídeos antigos, sem quiz configurado, continuam funcionando.
async function iniciarEtapaPosVideo() {
  const quizBlock = document.getElementById('quizBlock');
  const feedback  = document.getElementById('quizFeedback');
  if (feedback) feedback.innerHTML = '';

  let perguntas = [];
  try {
    const resp = await apiFetch(
      'action=perguntas&semana=' + encodeURIComponent(selectedVideo.SemanaISO) +
      '&titulo=' + encodeURIComponent(selectedVideo.Titulo)
    );
    if (resp && resp.ok && Array.isArray(resp.data)) perguntas = resp.data;
  } catch (err) { perguntas = []; }

  if (!perguntas.length) {
    quizBlock?.classList.add('hidden');
    liberarAssinatura();
    return;
  }

  renderQuiz(perguntas);
  quizBlock.classList.remove('hidden');
  quizBlock.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.getElementById('btnConfirmarQuiz')?.addEventListener('click', async () => {
  const feedback = document.getElementById('quizFeedback');
  const btn = document.getElementById('btnConfirmarQuiz');
  const cards = document.querySelectorAll('#quizPerguntas .quiz-card');

  const respostas = [];
  let faltando = false;
  cards.forEach(card => {
    card.classList.remove('is-wrong', 'is-right');
    const marcada = card.querySelector('input[type="radio"]:checked');
    if (!marcada) { faltando = true; return; }
    respostas.push({ numPergunta: card.dataset.num, resposta: marcada.value });
  });

  if (faltando) {
    feedback.innerHTML = '<p class="quiz-feedback-error">Responda todas as perguntas antes de confirmar.</p>';
    return;
  }

  btn.disabled = true;
  const txtOriginal = btn.textContent;
  btn.textContent = 'Verificando...';

  try {
    const res = await fetch(API_BASE + '?action=validarquiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        semanaISO: selectedVideo.SemanaISO,
        tituloVideo: selectedVideo.Titulo,
        respostas,
      }),
    });
    const data = await res.json();

    if (data && data.ok && data.aprovado) {
      respostasQuizAtual = respostas; // reenviado no payload de 'registrar' como segunda checagem
      feedback.innerHTML = '<p class="quiz-feedback-ok">Respostas corretas! Assine abaixo para concluir.</p>';
      document.getElementById('quizBlock').classList.add('hidden');
      liberarAssinatura();
    } else if (data && data.ok) {
      // Marca visualmente as perguntas erradas, sem nunca revelar a resposta certa
      (data.resultados || []).forEach(r => {
        const card = document.querySelector(`#quizPerguntas .quiz-card[data-num="${r.numPergunta}"]`);
        if (card) card.classList.add(r.correta ? 'is-right' : 'is-wrong');
      });
      feedback.innerHTML = `<p class="quiz-feedback-error">Você acertou ${data.corretas} de ${data.total}. Revise as perguntas destacadas e tente novamente.</p>`;
    } else {
      feedback.innerHTML = '<p class="quiz-feedback-error">Falha ao verificar as respostas. Tente novamente.</p>';
    }
  } catch (err) {
    feedback.innerHTML = '<p class="quiz-feedback-error">Erro de conexão ao verificar as respostas.</p>';
  } finally {
    btn.disabled = false;
    btn.textContent = txtOriginal;
  }
});

// ─── Pausa automática ao sair da aba/app ──────────────────────────────────────
// Evita o cenário relatado: colaborador deixa o vídeo "rodando" numa aba
// enquanto faz outra atividade. Assim que a aba perde o foco, o vídeo pausa.

function pausarSeEstiverTocando() {
  if (player && typeof player.getPlayerState === 'function' && player.getPlayerState() === YT.PlayerState.PLAYING) {
    player.pauseVideo();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pausarSeEstiverTocando();
});
window.addEventListener('blur', pausarSeEstiverTocando);

// Impede o menu de contexto (clique direito / toque longo) sobre o player,
// que em alguns navegadores oferece atalho "Assistir no YouTube".
document.getElementById('playerWrapper')?.addEventListener('contextmenu', e => e.preventDefault());

// ─── Tela cheia + orientação paisagem (celular) ───────────────────────────────

function checkOrientationHint() {
  const hint = document.getElementById('avisoGirar');
  if (!hint) return;
  const emFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
  const emRetrato = window.matchMedia('(orientation: portrait)').matches;
  hint.classList.toggle('show', emFullscreen && emRetrato);
}

async function toggleFullscreenLandscape() {
  const wrapper = document.getElementById('playerWrapper');
  if (!wrapper) return;
  const jaEmFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);

  if (!jaEmFullscreen) {
    try {
      if (wrapper.requestFullscreen) await wrapper.requestFullscreen();
      else if (wrapper.webkitRequestFullscreen) wrapper.webkitRequestFullscreen();
    } catch (err) {
      console.warn('Tela cheia não suportada neste navegador.', err);
    }
    try {
      // Gira automaticamente para paisagem — funciona em Chrome/Android.
      // Não suportado no Safari/iOS: nesses casos, o aviso "gire o celular"
      // (checkOrientationHint) orienta o usuário a girar manualmente.
      if (screen.orientation && screen.orientation.lock) {
        await screen.orientation.lock('landscape');
      }
    } catch (err) { /* orientação não travável — segue com o aviso visual */ }
    checkOrientationHint();
  } else {
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  }
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) {
    try { screen.orientation && screen.orientation.unlock && screen.orientation.unlock(); } catch (err) {}
    document.getElementById('avisoGirar')?.classList.remove('show');
  } else {
    checkOrientationHint();
  }
});
document.addEventListener('webkitfullscreenchange', checkOrientationHint);
window.matchMedia('(orientation: portrait)').addEventListener('change', checkOrientationHint);

document.getElementById('btnFullscreen')?.addEventListener('click', toggleFullscreenLandscape);

// ─── Checkpoint de atenção: "Continuar vídeo?" a cada 2 minutos ──────────────

function showCheckpointModal() {
  const el = document.getElementById('checkpointModal');
  if (!el) return;
  el.classList.add('show');
  // Reforço via estilo inline: garante que o modal apareça mesmo que o
  // navegador do colaborador esteja servindo um colab.css antigo em cache
  // (estilo inline sempre vence sobre uma regra externa do CSS).
  el.style.cssText =
    'position:absolute;inset:0;z-index:99999;display:flex;align-items:center;' +
    'justify-content:center;background:rgba(15,23,42,.88);padding:20px;text-align:center;';
}
function hideCheckpointModal() {
  const el = document.getElementById('checkpointModal');
  if (!el) return;
  el.classList.remove('show');
  el.style.display = 'none';
}

document.getElementById('btnCheckpointSim')?.addEventListener('click', () => {
  hideCheckpointModal();
  if (player && typeof player.playVideo === 'function') player.playVideo();
});
document.getElementById('btnCheckpointNao')?.addEventListener('click', () => {
  hideCheckpointModal();
  // O vídeo permanece pausado — o colaborador retoma quando quiser, pelo
  // botão de play. O próximo checkpoint só volta a contar a partir daí.
});

// ─── Seleção e carregamento do vídeo ─────────────────────────────────────────

function selectVideo(idx) {
  selectedVideo = treinamentos[idx];
  videoEnded = false;

  // Zera o controle de avanço/tempo assistido para o novo vídeo (o objeto
  // `player` é reaproveitado entre vídeos via loadVideoById, então esses
  // acumuladores precisam ser resetados manualmente aqui).
  maxWatchedSeconds = 0;
  watchedAccumSeconds = 0;
  lastPollTs = null;
  checkpointBuckets = new Set();
  respostasQuizAtual = [];
  hideCheckpointModal();
  document.getElementById('quizBlock')?.classList.add('hidden');

  document.getElementById('videoTitle').textContent = selectedVideo.Titulo;
  document.getElementById('semanaISO').textContent = selectedVideo.SemanaISO;
  document.getElementById('btnRegistrar').classList.add('hidden');
  document.getElementById('signatureBlock').classList.add('hidden');
  document.getElementById('mensagem').innerHTML = '';
  document.getElementById('btnRegistrar').disabled = false;

  const vid = extractYouTubeId(selectedVideo.URL);
  if (!vid) {
    document.getElementById('mensagem').innerHTML = alertCard('error', 'URL do vídeo inválida.');
    return;
  }

  const loadPlayer = () => {
    if (player) {
      player.loadVideoById(vid);
      return;
    }
    if (!window.YT || !YT.Player) {
      setTimeout(loadPlayer, 250);
      return;
    }
    player = new YT.Player('ytplayer', {
      height: '100%',
      width: '100%',
      videoId: vid,
      playerVars: { controls: 0, disablekb: 1, fs: 0, rel: 0, modestbranding: 1, playsinline: 1 },
      events: {
        onReady: onPlayerReady,
        onStateChange: onPlayerStateChange,
        onPlaybackRateChange: onPlayerRateChange,
      },
    });
  };
  loadPlayer();

  const playBtn = document.getElementById('btnPlayOverlay');
  updatePlayOverlay(false);
  // Alterna play/pause — este botão permanece sempre a camada mais alta sobre o
  // iframe (ver updatePlayOverlay), então é ele que recebe o toque, nunca o YouTube.
  playBtn.onclick = () => {
    if (!player || typeof player.getPlayerState !== 'function') return;
    if (player.getPlayerState() === YT.PlayerState.PLAYING) player.pauseVideo();
    else player.playVideo();
  };

  document.getElementById('secPlayer').classList.remove('hidden');
  document.getElementById('secPlayer').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─── Renderização da lista de vídeos ─────────────────────────────────────────

function renderListaVideos(list) {
  const c = document.getElementById('listaVideos');
  c.innerHTML = '';

  if (!list || list.length === 0) {
    c.innerHTML = alertCard('ok',
      '<span class="text-lg mr-2">✅</span> Você já está em dia! Não há vídeos pendentes para esta semana.');
    return;
  }

  list.forEach((t, idx) => {
    const card = document.createElement('div');
    card.className = [
      'flex items-center justify-between gap-4 p-4',
      'bg-slate-50 dark:bg-slate-700/50 hover:bg-slate-100 dark:hover:bg-slate-700',
      'border border-slate-200 dark:border-slate-600 rounded-xl transition-colors',
    ].join(' ');

    card.innerHTML = `
      <div class="min-w-0">
        <p class="text-xs font-semibold text-brand-600 dark:text-brand-400 mb-0.5">
          Semana ${t.SemanaISO}
        </p>
        <h3 class="font-semibold text-slate-800 dark:text-white text-sm leading-snug truncate">${t.Titulo}</h3>
      </div>
      <button data-idx="${idx}"
        class="shrink-0 bg-brand-500 hover:bg-brand-600 active:bg-brand-700 text-white font-semibold py-2 px-4 rounded-xl text-sm transition-all shadow-sm hover:shadow-md flex items-center gap-1.5 whitespace-nowrap">
        <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><polygon points="5,3 19,12 5,21"/></svg>
        Assistir
      </button>`;

    card.querySelector('button').addEventListener('click', () => selectVideo(idx));
    c.appendChild(card);
  });
}

// ─── Botão Buscar ─────────────────────────────────────────────────────────────

document.getElementById('btnBuscar').addEventListener('click', async () => {
  const m = document.getElementById('matricula').value.trim();
  hideInfo();
  document.getElementById('secVideos').classList.add('hidden');
  document.getElementById('secPlayer').classList.add('hidden');

  if (!m) {
    showInfo(alertCard('warn', 'Informe a matrícula.'));
    return;
  }

  // Estado de carregamento
  const btnBuscar = document.getElementById('btnBuscar');
  const txtOriginal = btnBuscar.innerHTML;
  btnBuscar.disabled = true;
  btnBuscar.innerHTML = `<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
  </svg> A buscar...`;

  try {
    // 1+2. Identificar funcionário e já trazer férias/treinamentos/registros
    // dele numa ÚNICA chamada ao backend (antes eram 4 chamadas separadas).
    const resp = await fetchIdentificarColaborador(m);
    if (!resp || !resp.ok) {
      const d = resp && resp.error ? ` (${resp.error})` : '';
      showInfo(alertCard('error', `Falha ao consultar funcionário${d}.`));
      return;
    }
    if (resp.found === false) {
      showInfo(alertCard('error', 'Funcionário não encontrado ou inativo.'));
      return;
    }

    funcionario = resp.funcionario;
    const matNorm = normMat(funcionario.Matricula);
    // Usuário especial do desenvolvedor: identificado pela matrícula literal
    // "TESTE" que o backend sempre devolve nesse caso (ver identificarcolaborador
    // em code.gs). Usado para pular o filtro de "semana vigente" logo abaixo,
    // já que o backend já manda só o vídeo mais recente para ele.
    const isTesteUser = String(funcionario.Matricula || '').trim().toUpperCase() === 'TESTE';

    // Mantém o mesmo formato das antigas respostas separadas, para não
    // precisar reescrever a lógica abaixo que já consumia fResp/tResp/rResp.
    const fResp = { ok: true, data: resp.ferias      || [] };
    const tResp = { ok: true, data: resp.treinamentos || [] };
    const rResp = { ok: true, data: resp.registros    || [] };

    // 3. Processar registros de férias/afastamento deste colaborador
    let listaFerias = [];
    if (fResp && fResp.ok && Array.isArray(fResp.data)) {
      listaFerias = fResp.data.filter(f => normMat(f.Matricula) === matNorm);
    }

    // Verificar se está de férias/afastamento HOJE — bloqueia acesso total
    const hoje = new Date();
    hoje.setUTCHours(0, 0, 0, 0);
    const feriaHoje = listaFerias.find(f => {
      const ini = parseDateBR(f.InicioFerias);
      const fim = parseDateBR(f.FimFerias);
      if (!ini && !fim) return true;           // sem período = sempre bloqueado
      if (ini && !fim) return hoje >= ini;
      if (!ini && fim) return hoje <= fim;
      return hoje >= ini && hoje <= fim;
    });

    if (feriaHoje) {
      const sit = (feriaHoje.Situacao || 'Férias / Afastamento').toUpperCase();
      // Formata a partir do Date já interpretado (ini/fim, calculados acima),
      // para exibir sempre dd/mm/aaaa — mesmo quando o valor original vier em
      // formato ISO (célula de planilha do tipo Data).
      const fmtDia = d => d ? String(d.getUTCDate()).padStart(2,'0') + '/' + String(d.getUTCMonth()+1).padStart(2,'0') + '/' + d.getUTCFullYear() : '';
      const iniFmt = fmtDia(parseDateBR(feriaHoje.InicioFerias));
      const fimFmt = fmtDia(parseDateBR(feriaHoje.FimFerias));
      const periodo = (iniFmt || fimFmt) ? ` (${iniFmt || '?'}${fimFmt ? ' a ' + fimFmt : ''})` : '';
      showInfo(`
        <div class="flex flex-col items-center gap-3 text-center py-2">
          <span class="text-4xl">🚫</span>
          <p class="font-extrabold text-red-700 dark:text-red-400 text-sm uppercase tracking-wide leading-snug">
            Você não está autorizado a acessar<br>esta plataforma neste período.
          </p>
          <p class="text-xs font-semibold text-red-600 dark:text-red-400">
            Motivo: ${sit}${periodo}
          </p>
        </div>`);
      return;
    }

    // 4. Saudação
    showInfo(alertCard('ok',
      `Olá, <strong>${funcionario.Nome}</strong> — Setor: <strong>${funcionario.Setor || '-'}</strong>` +
      (isTesteUser ? ' <span style="margin-left:6px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.03em;background:#fbbf24;color:#451a03;padding:2px 8px;border-radius:999px;">Modo teste</span>' : '')));

    if (!tResp || !tResp.ok) {
      const d = tResp && tResp.error ? ` (${tResp.error})` : '';
      showInfo(alertCard('error', `Falha ao carregar vídeos${d}.`));
      return;
    }

    let todosTreinamentos = tResp.data || [];

    // 5. Remover vídeos cujo período coincide com QUALQUER registro de
    //    férias/afastamento. Usa as datas do Titulo como fonte primária
    //    (a planilha usa numeração sequencial própria, não ISO 8601).
    if (listaFerias.length > 0) {
      todosTreinamentos = todosTreinamentos.filter(t => {
        const cobertaPorFerias = listaFerias.some(f => {
          const ini = parseDateBR(f.InicioFerias);
          const fim = parseDateBR(f.FimFerias);
          if (!ini && !fim) return true;

          // Extrair datas do Titulo (fonte primária)
          const matches = String(t.Titulo || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/g);
          if (matches && matches.length >= 2) {
            const toDate = s => { const p = s.split('/'); return new Date(Date.UTC(+p[2],+p[1]-1,+p[0])); };
            const tSeg = toDate(matches[0]);
            const tDom = toDate(matches[1]);
            if (ini && !fim) return tDom >= ini;
            if (!ini && fim) return tSeg <= fim;
            return tSeg <= fim && tDom >= ini;
          }

          // Fallback: usar SemanaISO como ISO 8601
          return semanaEmFerias(t.SemanaISO, f.InicioFerias, f.FimFerias);
        });
        return !cobertaPorFerias;
      });
    }

    // 6. Exibir APENAS o vídeo da semana vigente.
    //    IMPORTANTE: a planilha usa numeração sequencial própria (W05, W06...),
    //    NÃO a norma ISO 8601. Por isso usamos exclusivamente as datas do campo
    //    Titulo (ex: "15/06/2026 a 21/06/2026") para determinar a semana vigente.
    //    Exceção: o usuário TESTE pula esse filtro — o backend já entrega só o
    //    vídeo mais recente, e ele precisa poder testá-lo mesmo que a semana
    //    vigente (por data) ainda não tenha começado ou já tenha passado.
    if (!isTesteUser) {
      const agora = new Date();
      const hojeMs = Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate());

      todosTreinamentos = todosTreinamentos.filter(t => {
        // Extrair as duas datas dd/mm/aaaa do Titulo
        const matches = String(t.Titulo || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/g);
        if (matches && matches.length >= 2) {
          const toMs = s => { const p = s.split('/'); return Date.UTC(+p[2], +p[1]-1, +p[0]); };
          const ini = toMs(matches[0]);
          const fim = toMs(matches[1]);
          return hojeMs >= ini && hojeMs <= fim;
        }
        // Fallback: se o Titulo não tiver datas, usa o SemanaISO como ISO 8601
        const seg = isoParaSegunda(t.SemanaISO);
        const dom = isoParaDomingo(t.SemanaISO);
        if (seg && dom) return hojeMs >= seg.getTime() && hojeMs <= dom.getTime();
        return false;
      });
    }

    // 6. Remover vídeos já assistidos e registrados
    if (!rResp || !rResp.ok) {
      showInfo(alertCard('ok',
        `Olá, <strong>${funcionario.Nome}</strong> — Setor: <strong>${funcionario.Setor || '-'}</strong>`) +
        alertCard('warn', 'Não foi possível verificar vídeos já assistidos. Mostrando todos disponíveis.'));
      treinamentos = todosTreinamentos;
    } else {
      const registros = rResp.data || [];
      // Chave única por semana ISO + título do vídeo
      const watchedKey = new Set(registros.map(r => `${r.SemanaISO}@@${r.TituloVideo}`));
      treinamentos = todosTreinamentos.filter(t => !watchedKey.has(`${t.SemanaISO}@@${t.Titulo}`));
    }

    renderListaVideos(treinamentos);
    document.getElementById('secVideos').classList.remove('hidden');
    document.getElementById('secVideos').scrollIntoView({ behavior: 'smooth', block: 'start' });

  } finally {
    btnBuscar.disabled = false;
    btnBuscar.innerHTML = txtOriginal;
  }
});

// Buscar ao pressionar Enter na matrícula
document.getElementById('matricula').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btnBuscar').click();
});

// ─── Redimensionamento do canvas de assinatura ────────────────────────────────
// Quando o utilizador roda o telemóvel ou redimensiona a janela, o canvas
// precisa de ser ajustado — caso contrário a assinatura fica distorcida.
(function initSignatureResize() {
  const canvas = document.getElementById('signaturePad');
  if (!canvas) return;

  let resizeTimer;
  const resizeCanvas = () => {
    if (!signaturePad) return;
    const parent = canvas.parentElement;
    const newW = parent ? parent.clientWidth - 4 : 600;
    if (newW > 0 && canvas.width !== newW) {
      // Copia o conteúdo atual do canvas para um canvas temporário ANTES de
      // redimensionar — tudo de forma SÍNCRONA, sem passar por
      // toDataURL()+Image+onload (que é assíncrono). Esse caminho antigo
      // deixava uma janela de tempo em que o canvas ficava
      // COMPLETAMENTE EM BRANCO (redimensionar um <canvas> apaga o
      // conteúdo dele, é assim que a própria plataforma funciona) até a
      // imagem terminar de recarregar. Se o colaborador clicasse em
      // "Registrar" bem nesse intervalo — algo bem comum no celular, já
      // que o evento de resize dispara sozinho ao esconder a barra de
      // endereço ou fechar o teclado virtual — a assinatura enviada era um
      // PNG tecnicamente válido, mas em branco. Passava por toda validação
      // (o botão só bloqueia se o canvas estava vazio ANTES desse
      // redimensionamento) e por isso nunca gerava nenhum erro — só uma
      // assinatura ausente no relatório, sem nenhuma pista do motivo.
      const temp = document.createElement('canvas');
      temp.width  = canvas.width;
      temp.height = canvas.height;
      temp.getContext('2d').drawImage(canvas, 0, 0);
      const estavaVazio = signaturePad.isEmpty();

      canvas.width  = newW;
      canvas.height = 280;

      if (!estavaVazio) {
        const ctx = canvas.getContext('2d');
        ctx.drawImage(temp, 0, 0, temp.width, temp.height, 0, 0, canvas.width, canvas.height);
        // Sincroniza o estado interno do SignaturePad com o que acabamos de
        // desenhar manualmente — necessário para isEmpty()/toDataURL()
        // continuarem corretos a partir daqui.
        signaturePad.fromDataURL(canvas.toDataURL());
      } else {
        signaturePad.clear();
      }
    }
  };

  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resizeCanvas, 150);
  });
})();



document.getElementById('btnTrocarVideo').addEventListener('click', () => {
  if (player) { try { player.stopVideo(); } catch (e) {} }
  document.getElementById('secPlayer').classList.add('hidden');
  document.getElementById('btnRegistrar').classList.add('hidden');
  document.getElementById('signatureBlock').classList.add('hidden');
  document.getElementById('quizBlock')?.classList.add('hidden');
  hideCheckpointModal();
  document.getElementById('mensagem').innerHTML = '';
  selectedVideo = null;
  videoEnded = false;
  document.getElementById('secVideos').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ─── Botão Limpar Assinatura ──────────────────────────────────────────────────

document.getElementById('btnLimpar').addEventListener('click', () => {
  if (signaturePad) signaturePad.clear();
});

// ─── Botão Registrar ──────────────────────────────────────────────────────────

document.getElementById('btnRegistrar').addEventListener('click', async () => {
  const msg = document.getElementById('mensagem');
  msg.innerHTML = '';

  if (!funcionario || !selectedVideo) {
    msg.innerHTML = alertCard('error', 'Dados incompletos. Recarregue a página e tente novamente.');
    return;
  }
  if (!videoEnded) {
    msg.innerHTML = alertCard('warn', 'O vídeo ainda não foi concluído. Assista até o final.');
    return;
  }
  if (!signaturePad || signaturePad.isEmpty()) {
    msg.innerHTML = alertCard('warn', 'Por favor, assine no quadro antes de registrar.');
    document.getElementById('signatureBlock').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  const btnReg = document.getElementById('btnRegistrar');

  // Segunda camada de proteção (defesa em profundidade): confere de novo,
  // bem no último instante antes de capturar a imagem, que o canvas ainda
  // não está vazio. A checagem lá em cima já cobre o caso comum, mas esta
  // aqui protege contra qualquer outra situação inesperada que zere o canvas
  // entre aquela checagem e este ponto.
  if (!signaturePad || signaturePad.isEmpty()) {
    msg.innerHTML = alertCard('warn', 'A assinatura não foi capturada corretamente. Assine novamente e tente registrar de novo.');
    document.getElementById('signatureBlock').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  const txtOriginal = btnReg.innerHTML;
  btnReg.disabled = true;
  btnReg.innerHTML = `<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
  </svg> A registrar...`;

  const payload = {
    matricula: String(funcionario.Matricula),
    semanaISO: String(selectedVideo.SemanaISO),
    tituloVideo: String(selectedVideo.Titulo),
    urlVideo: String(selectedVideo.URL),
    assinaturaPNG: signaturePad.toDataURL('image/png'),
    deviceInfo: navigator.userAgent,
    // Evidência de que o vídeo foi assistido de fato pela plataforma — o backend
    // (code.gs) valida isso antes de aceitar o registro, não confia só no flag
    // `videoEnded` do frontend, que poderia ser manipulado.
    tempoAssistidoSegundos: Math.round(watchedAccumSeconds),
    duracaoSegundos: (player && typeof player.getDuration === 'function') ? Math.round(player.getDuration()) : null,
    // Reenviado para o backend confirmar de novo (segunda checagem, defesa em
    // profundidade) — a primeira validação já ocorreu em 'validarquiz'.
    respostasQuiz: respostasQuizAtual,
  };

  try {
    const res = await fetch(API_BASE + '?action=registrar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    let data;
    try { data = await res.json(); }
    catch { data = { ok: false, error: 'Resposta inválida do servidor.' }; }

    if (data.ok) {
      msg.innerHTML = `
        <div class="flex flex-col items-center gap-3 text-center py-4 px-6 bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-700 rounded-xl">
          <span class="text-4xl">✅</span>
          <p class="font-bold text-emerald-800 dark:text-emerald-200">Registro realizado com sucesso!</p>
          <p class="text-xs text-emerald-700 dark:text-emerald-300">
            Obrigado, <strong>${funcionario.Nome}</strong>. Sua participação foi registrada.
          </p>
        </div>`;

      // Remover da lista local e re-renderizar
      treinamentos = treinamentos.filter(t =>
        !(t.SemanaISO === selectedVideo.SemanaISO && t.Titulo === selectedVideo.Titulo));
      renderListaVideos(treinamentos);
      document.getElementById('secPlayer').classList.add('hidden');
      document.getElementById('secVideos').classList.remove('hidden');

      // Rolar até a mensagem
      msg.scrollIntoView({ behavior: 'smooth', block: 'center' });

    } else {
      msg.innerHTML = alertCard('error', 'Falha ao registrar: ' + (data.error || 'Erro desconhecido.'));
      btnReg.disabled = false;
      btnReg.innerHTML = txtOriginal;
    }

  } catch (err) {
    msg.innerHTML = alertCard('error', 'Erro de conexão ao salvar o registro. Verifique sua internet e tente novamente.');
    btnReg.disabled = false;
    btnReg.innerHTML = txtOriginal;
  }
});
