require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');
const { Mistral } = require('@mistralai/mistralai');
const Groq = require('groq-sdk');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY    = process.env.ANON_KEY;
const SERVICE_KEY = process.env.SERVICE_KEY;
const MISTRAL_KEY = process.env.MISTRAL_KEY;
const GROQ_KEY    = process.env.GROQ_KEY;

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY || !MISTRAL_KEY || !GROQ_KEY) {
  console.error('❌ Variáveis de ambiente faltando. Verifique o .env');
  process.exit(1);
}

const supabaseAuth = createClient(SUPABASE_URL, ANON_KEY);
const supabase     = createClient(SUPABASE_URL, SERVICE_KEY);
const mistral      = new Mistral({ apiKey: MISTRAL_KEY });
const groq         = new Groq({ apiKey: GROQ_KEY });

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    executablePath: '/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  },
  takeoverOnConflict: true
});

const sessoes             = new Map();
const mensagensProcessadas = new Set();

// ─── EVENTS ───────────────────────────────────────────────────────────────────

client.on('qr', (qr) => qrcode.generate(qr, { small: true }));

client.on('ready', () => {
  console.log('🟢 Nort Finance online!');
  iniciarScheduler();
});

client.on('message', async (msg) => {
  if (msg.isStatus || msg.from === 'status@broadcast') return;

  const msgId = msg.id._serialized;
  if (mensagensProcessadas.has(msgId)) return;
  mensagensProcessadas.add(msgId);
  if (mensagensProcessadas.size > 500) mensagensProcessadas.clear();

  const tel   = msg.from;
  const estado = sessoes.get(tel) || { step: 'inicio' };

  const { data: user } = await supabase
    .from('profiles').select('*').eq('phone', tel).single();

  // usuário logado + mídia
  if (user && (msg.type === 'audio' || msg.type === 'ptt')) { await handleAudio(msg, user); return; }
  if (user && msg.type === 'image') { await handleImagem(msg, user); return; }

  const texto     = msg.body?.trim() || '';
  const textoLower = texto.toLowerCase();

  if (user) { await handleComandos(msg, user, texto); return; }

  // ── ONBOARDING ──────────────────────────────────────────────────────────────

  if (estado.step === 'inicio') {
    sessoes.set(tel, { step: 'tem_conta' });
    await msg.reply(
      '👋 Olá! Bem-vinda ao *Nort Finance* pelo WhatsApp.\n\n' +
      'Você já tem uma conta no app?\n\n1️⃣ Sim, já tenho\n2️⃣ Não, quero criar'
    );
    return;
  }

  if (estado.step === 'tem_conta') {
    if (texto === '1' || textoLower.includes('sim')) {
      sessoes.set(tel, { step: 'login_email', tentativas: 0 });
      await msg.reply('✅ Ótimo!\n\n⚠️ _Não use senha do banco ou email principal._\n\nQual é seu *email*?');
    } else if (texto === '2' || /n[aã]o/i.test(textoLower)) {
      sessoes.set(tel, { step: 'cadastro_nome' });
      await msg.reply('🆕 Vamos criar sua conta!\n\nQual é o seu *nome*?');
    } else {
      await msg.reply('Responde *1* (já tenho conta) ou *2* (criar conta). 😊');
    }
    return;
  }

  if (estado.step === 'login_email') {
    sessoes.set(tel, { ...estado, step: 'login_senha', email: texto });
    await msg.reply('🔒 Agora sua *senha*:');
    return;
  }

  if (estado.step === 'login_senha') {
    await msg.reply('⏳ Verificando...');
    const tentativas = (estado.tentativas || 0) + 1;
    const { data: authData, error: authError } = await supabaseAuth.auth.signInWithPassword({
      email: estado.email, password: texto
    });
    if (authError || !authData?.user) {
      if (tentativas >= 2) {
        sessoes.set(tel, { step: 'tem_conta' });
        await msg.reply('❌ Não consegui logar.\n\n1️⃣ Tentar outro email\n2️⃣ Criar conta nova');
      } else {
        sessoes.set(tel, { ...estado, step: 'login_email', tentativas });
        await msg.reply(`❌ Email ou senha incorretos (${tentativas}/2).\n\nTenta de novo — manda o *email*:`);
      }
      return;
    }
    await vincularEResponder(msg, tel, authData.user.id);
    return;
  }

  if (estado.step === 'cadastro_nome') {
    sessoes.set(tel, { step: 'cadastro_email', nome: texto });
    await msg.reply(`Legal, *${texto}*! 👋\n\nQual vai ser seu *email*?`);
    return;
  }

  if (estado.step === 'cadastro_email') {
    sessoes.set(tel, { ...estado, step: 'cadastro_senha', email: texto });
    await msg.reply('🔒 Crie uma *senha* (mínimo 6 caracteres):\n\n_Anota — vai precisar no app também._');
    return;
  }

  if (estado.step === 'cadastro_senha') {
    const { nome, email } = estado;
    if (texto.length < 6) { await msg.reply('⚠️ Mínimo 6 caracteres. Tenta de novo:'); return; }
    await msg.reply('⏳ Criando conta...');
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email, password: texto, email_confirm: true, user_metadata: { name: nome }
    });
    if (authError) {
      if (authError.message.includes('already')) {
        sessoes.set(tel, { step: 'login_email', tentativas: 0 });
        await msg.reply('⚠️ Esse email já tem conta. Vou te logar — manda o *email*:');
      } else {
        sessoes.delete(tel);
        await msg.reply('❌ Erro: ' + authError.message);
      }
      return;
    }
    await vincularEResponder(msg, tel, authData.user.id);
    return;
  }
});

// ─── SCHEDULER DE LEMBRETES ───────────────────────────────────────────────────

function iniciarScheduler() {
  cron.schedule('* * * * *', async () => {
    const agora = new Date().toISOString();
    const { data: lembretes, error } = await supabase
      .from('reminders')
      .select('id, phone, message')
      .eq('status', 'scheduled')
      .lte('remind_at', agora);

    if (error) { console.error('Scheduler erro:', error.message); return; }

    for (const l of lembretes || []) {
      try {
        await client.sendMessage(l.phone, `⏰ *Lembrete!*\n\n${l.message}`);
        await supabase.from('reminders')
          .update({ status: 'sent', sent_at: new Date().toISOString() })
          .eq('id', l.id);
        console.log(`✅ Lembrete enviado: ${l.id}`);
      } catch (err) {
        console.error(`Erro lembrete ${l.id}:`, err.message);
      }
    }
  });
  console.log('🔔 Scheduler de lembretes ativo (1/min)');
}

// ─── ÁUDIO ────────────────────────────────────────────────────────────────────

async function handleAudio(msg, user) {
  await msg.reply('🎙️ Transcrevendo...');
  const tmpPath = path.join('/tmp', `audio_${Date.now()}.ogg`);
  try {
    const media = await msg.downloadMedia();
    if (!media?.data) { await msg.reply('❌ Não consegui baixar o áudio.'); return; }
    fs.writeFileSync(tmpPath, Buffer.from(media.data, 'base64'));
    const result = await groq.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-large-v3-turbo',
      language: 'pt',
      response_format: 'text'
    });
    fs.unlinkSync(tmpPath);
    const texto = (typeof result === 'string' ? result : result.text)?.trim();
    if (!texto) { await msg.reply('❌ Não entendi o áudio. Tenta em texto.'); return; }
    await msg.reply(`🎙️ _"${texto}"_\n\n⏳ Processando...`);
    await rotearTexto(msg, user, texto);
  } catch (err) {
    console.error('Erro áudio:', err.message);
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    await msg.reply('❌ Erro ao processar áudio.');
  }
}

// ─── IMAGEM ───────────────────────────────────────────────────────────────────

async function handleImagem(msg, user) {
  const caption = msg.body?.trim()?.toLowerCase() || '';
  const ehConsulta = ehConsultaCompra(caption) ||
    /\b(quanto|preço|caro|barato|vale|compro|parcelar)\b/i.test(caption);

  await msg.reply(ehConsulta ? '🛍️ Analisando produto...' : '🖼️ Analisando imagem...');
  try {
    const media = await msg.downloadMedia();
    if (!media?.data) { await msg.reply('❌ Não consegui baixar.'); return; }

    const hoje = new Date().toISOString().split('T')[0];
    const response = await groq.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${media.mimetype};base64,${media.data}` } },
          { type: 'text', text: `Analise a imagem. Responda APENAS JSON sem markdown.
CASO 1 (comprovante/recibo já pago): {"tipo":"comprovante","transacoes":[{"type":"expense","amount":numero,"title":"descricao","date":"YYYY-MM-DD","pending":false}]}
CASO 2 (produto/anuncio para comprar): {"tipo":"produto","descricao":"nome","preco":numero_ou_null}
Se não identificar: {"tipo":"desconhecido"}
Hoje: ${hoje}` }
        ]
      }],
      max_tokens: 500
    });

    const raw = response.choices[0].message.content.trim();
    const resultado = JSON.parse(raw.replace(/```json|```/g, '').trim());

    if (resultado.tipo === 'produto' || ehConsulta) {
      await handleConsultaCompra(msg, user, resultado.descricao || caption || 'produto', resultado.preco || null);
    } else if (resultado.tipo === 'comprovante' && resultado.transacoes?.length) {
      await salvarLancamentos(msg, user, resultado.transacoes);
    } else {
      await msg.reply('🤔 Não identifiquei. Comprovante: manda mais nítido. Produto: escreve _"quero comprar [nome] por R$ [valor]"_');
    }
  } catch (err) {
    console.error('Erro imagem:', err.message);
    if (err.status === 429) await msg.reply('⏳ Muitas requisições. Espera 30s.');
    else await msg.reply('❌ Erro ao processar imagem.');
  }
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────

async function vincularEResponder(msg, tel, userId) {
  const { error } = await supabase.from('profiles').update({ phone: tel }).eq('id', userId);
  if (error) { sessoes.delete(tel); await msg.reply('❌ Erro ao vincular.'); return; }
  sessoes.delete(tel);
  const { data: perfil } = await supabase.from('profiles').select('name').eq('id', userId).single();
  await msg.reply(`✅ Tudo certo, *${perfil?.name || 'usuária'}*!\n\n` + menuPrincipal());
}

// ─── MENU ─────────────────────────────────────────────────────────────────────

function menuPrincipal() {
  return (
    '💡 *Nort Finance*\n\n' +
    '1️⃣ Saldo\n' +
    '2️⃣ Lançar transação\n' +
    '3️⃣ Pendentes\n' +
    '4️⃣ Despesas fixas\n' +
    '5️⃣ Parceladas\n' +
    '6️⃣ Metas\n' +
    '7️⃣ Desvincular\n' +
    '0️⃣ Menu\n\n' +
    '_Texto, 🎙️ áudio ou 🖼️ foto_'
  );
}

// ─── DETECÇÃO DE INTENÇÃO ─────────────────────────────────────────────────────

function ehLembrete(texto) {
  return /\b(me lembr[ae]|lembr[ae][-\s]me|lembrete|me avis[ae]|me notifiqu?e)\b/i.test(texto);
}

function ehConsultaCompra(texto) {
  const pergunta  = /\b(posso|consigo|dá pra|da pra|tem como|faz sentido|vale a pena|compensa|dou conta)\b/i.test(texto);
  const intencao  = /\b(quero comprar|quero gastar|quero parcelar|tô pensando|to pensando|tô querendo|to querendo|penso em|vou comprar|pretendo comprar)\b/i.test(texto);
  const acaoFutura = /\b(comprar|gastar|parcelar|pagar)\b/i.test(texto);
  return intencao || (pergunta && acaoFutura);
}

function ehCriacaoMeta(texto) {
  return /\b(quero juntar|vou juntar|preciso juntar|meta de|quero economizar|vou economizar|quero guardar|vou guardar)\b.*\d/i.test(texto);
}

function ehCriacaoFixa(texto) {
  return /\b(todo mês|toda semana|mensalmente|sempre pago|sempre gasto|conta fixa|despesa fixa|receita fixa)\b.*\d/i.test(texto);
}

function ehLancamentoPassado(texto) {
  return /\b(gastei|paguei|comprei|recebi|ganhei|caiu|saiu|custou|cobrou|quitei)\b/i.test(texto) && /\d/.test(texto);
}

// ─── TIMEZONE HELPERS ─────────────────────────────────────────────────────────

const TIMEZONE_MAP = {
  'belém': 'America/Belem', 'belem': 'America/Belem', 'pará': 'America/Belem', 'para': 'America/Belem',
  'são paulo': 'America/Sao_Paulo', 'sao paulo': 'America/Sao_Paulo', 'sp': 'America/Sao_Paulo',
  'rio': 'America/Sao_Paulo', 'rio de janeiro': 'America/Sao_Paulo', 'rj': 'America/Sao_Paulo',
  'belo horizonte': 'America/Sao_Paulo', 'bh': 'America/Sao_Paulo',
  'curitiba': 'America/Sao_Paulo', 'porto alegre': 'America/Sao_Paulo',
  'florianópolis': 'America/Sao_Paulo', 'florianopolis': 'America/Sao_Paulo',
  'brasília': 'America/Sao_Paulo', 'brasilia': 'America/Sao_Paulo', 'df': 'America/Sao_Paulo',
  'salvador': 'America/Sao_Paulo', 'fortaleza': 'America/Fortaleza',
  'recife': 'America/Recife', 'natal': 'America/Recife',
  'maceió': 'America/Maceio', 'maceio': 'America/Maceio',
  'manaus': 'America/Manaus', 'amazonas': 'America/Manaus',
  'porto velho': 'America/Porto_Velho', 'cuiabá': 'America/Cuiaba', 'cuiaba': 'America/Cuiaba',
  'campo grande': 'America/Campo_Grande', 'ms': 'America/Campo_Grande',
  'macapá': 'America/Belem', 'macapa': 'America/Belem',
  'goiânia': 'America/Sao_Paulo', 'goiania': 'America/Sao_Paulo',
  'rio branco': 'America/Rio_Branco', 'acre': 'America/Rio_Branco',
};

function cidadeParaTimezone(texto) {
  const t = texto.toLowerCase().trim();
  for (const [chave, tz] of Object.entries(TIMEZONE_MAP)) {
    if (t.includes(chave)) return tz;
  }
  return null;
}

function getOffsetMinutes(tz) {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false,
      year: 'numeric', month: 'numeric', day: 'numeric'
    }).formatToParts(now);
    const get = (t) => parseInt(parts.find(p => p.type === t)?.value || '0');
    const h = get('hour') === 24 ? 0 : get('hour');
    const local = new Date(Date.UTC(get('year'), get('month') - 1, get('day'), h, get('minute')));
    const utc   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes()));
    return Math.round((local - utc) / 60000);
  } catch { return -180; }
}

function formatarHoraLocal(isoString, timezone = 'America/Belem') {
  try {
    return new Date(isoString).toLocaleString('pt-BR', {
      timeZone: timezone, day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
  } catch { return new Date(isoString).toLocaleString('pt-BR'); }
}

// ─── PARSER DE TEMPO NATURAL ──────────────────────────────────────────────────

function parsearTempo(texto, timezone = 'America/Belem') {
  const agora = new Date();
  const offsetMin = getOffsetMinutes(timezone);

  const localAgora = new Date(agora.getTime() + offsetMin * 60000);
  const lAno = localAgora.getUTCFullYear();
  const lMes = localAgora.getUTCMonth();
  const lDia = localAgora.getUTCDate();

  function localParaUTC(ano, mes, dia, hora, minuto) {
    const d = new Date(Date.UTC(ano, mes, dia, hora, minuto, 0, 0));
    d.setMinutes(d.getMinutes() - offsetMin);
    return d;
  }

  // "daqui a X min/h/d" ou "em X min/h/d"
  let m = texto.match(/(?:daqui\s+a|em)\s+(\d+)\s*(min(?:utos?)?|h(?:oras?)?|d(?:ias?)?)/i);
  if (m) {
    const v = parseInt(m[1]);
    const u = m[2][0].toLowerCase();
    const d = new Date(agora);
    if (u === 'm') d.setMinutes(d.getMinutes() + v);
    else if (u === 'h') d.setHours(d.getHours() + v);
    else if (u === 'd') d.setDate(d.getDate() + v);
    return d.toISOString();
  }

  // "amanhã às HH:MM"
  m = texto.match(/amanh[ãa](?:\s+(?:às?|as))?\s+(\d{1,2})(?:[h:](\d{2})?)?/i);
  if (m) {
    return localParaUTC(lAno, lMes, lDia + 1, parseInt(m[1]), parseInt(m[2] || 0)).toISOString();
  }

  // "hoje às HH:MM"
  m = texto.match(/hoje(?:\s+(?:às?|as))?\s+(\d{1,2})(?:[h:](\d{2})?)?/i);
  if (m) {
    return localParaUTC(lAno, lMes, lDia, parseInt(m[1]), parseInt(m[2] || 0)).toISOString();
  }

  // "DD/MM às HH"
  m = texto.match(/(\d{1,2})\/(\d{1,2})(?:\s+(?:às?|as))?\s+(\d{1,2})(?:[h:](\d{2})?)?/i);
  if (m) {
    let d = localParaUTC(lAno, parseInt(m[2]) - 1, parseInt(m[1]), parseInt(m[3]), parseInt(m[4] || 0));
    if (d < agora) d = localParaUTC(lAno + 1, parseInt(m[2]) - 1, parseInt(m[1]), parseInt(m[3]), parseInt(m[4] || 0));
    return d.toISOString();
  }

  return null;
}

// ─── ROTEADOR CENTRAL ─────────────────────────────────────────────────────────

async function rotearTexto(msg, user, texto) {
  if (ehLembrete(texto))        { await handleLembrete(msg, user, texto); return; }
  if (ehConsultaCompra(texto))  { await handleConsultaCompra(msg, user, texto); return; }
  if (ehCriacaoMeta(texto))     { await handleCriarMetaNatural(msg, user, texto); return; }
  if (ehCriacaoFixa(texto))     { await handleCriarFixaNatural(msg, user, texto); return; }
  if (/\b(contribui|guardei|separei|poupei)\b.*\d/i.test(texto)) {
    await handleContribuirMetaNatural(msg, user, texto); return;
  }
  if (/\b(confirmei|caiu|chegou|entrou)\b/i.test(texto) && !/\b(gastei|paguei|comprei)\b/i.test(texto)) {
    await handleConfirmarPendenteNatural(msg, user, texto); return;
  }
  if (/\b(paguei|quitei)\b/i.test(texto) && !/\d/.test(texto)) {
    await handlePagarFixa(msg, user, texto); return;
  }
  if (ehLancamentoPassado(texto)) {
    await msg.reply('⏳ Processando...');
    await processarLancamentoTexto(msg, user, texto);
    return;
  }
  // fallback numérico sem pergunta
  const temPergunta = /\b(posso|quero|consigo|dá pra|da pra|vale|compensa|faz sentido)\b/i.test(texto);
  if (/\d/.test(texto) && !temPergunta) {
    const lista = await parsearLancamentos(texto);
    if (!lista.every(t => t.error)) {
      await msg.reply('⏳ Processando...');
      await salvarLancamentos(msg, user, lista);
      return;
    }
  }
  await msg.reply(`Oi, ${user.name}! 👋\n\n` + menuPrincipal());
}

async function handleComandos(msg, user, texto) {
  const tel       = msg.from;
  const estado    = sessoes.get(tel) || {};
  const textoLower = texto.toLowerCase();

  // estados de formulário ativos
  if (estado.step === 'aguardando_cidade') { await handleCidadeResposta(msg, user, texto); return; }
  if (estado.step === 'lancamento')    { await handleLancamento(msg, user, texto); return; }
  if (estado.step === 'fixa_nova')     { await handleFixaNova(msg, user, texto); return; }
  if (estado.step === 'parcelada_nova'){ await handleParceladaNova(msg, user, texto); return; }
  if (estado.step === 'meta_nova')     { await handleMetaNova(msg, user, texto); return; }
  if (estado.step === 'meta_contribuir'){ await handleMetaContribuir(msg, user, texto); return; }

  // comandos de menu
  if (texto === '1' || textoLower === 'saldo') {
    await handleSaldo(msg, user); return;
  }
  if (texto === '2' || textoLower === 'lançar') {
    sessoes.set(tel, { step: 'lancamento' });
    await msg.reply(
      '📝 *Lançamento*\n\nEscreve como quiser:\n\n' +
      '_"gastei 44 na farmácia no débito"_\n' +
      '_"recebi 800 de freela no pix"_\n' +
      '_"uber 15 ontem"_\n\n' +
      '💳 Métodos: pix · débito · crédito · dinheiro · parcelado\n' +
      '🎙️ Áudio ou 🖼️ foto também.\n\n*0* cancela.'
    );
    return;
  }
  if (texto === '3' || textoLower === 'pendentes')  { await handleVerPendentes(msg, user); return; }
  if (texto === '4' || textoLower === 'fixas')      { await handleFixas(msg, user); return; }
  if (texto === '5' || textoLower === 'parceladas') { await handleParceladas(msg, user); return; }
  if (texto === '6' || textoLower === 'metas')      { await handleMetas(msg, user); return; }
  if (texto === '7' || textoLower === 'desvincular') {
    await supabase.from('profiles').update({ phone: null }).eq('id', user.id);
    sessoes.delete(tel);
    await msg.reply('🔓 WhatsApp desvinculado.'); return;
  }
  if (texto === '0' || textoLower === 'menu') {
    sessoes.delete(tel); await msg.reply(menuPrincipal()); return;
  }

  // linguagem natural
  await rotearTexto(msg, user, texto);
}

// ─── LEMBRETE ─────────────────────────────────────────────────────────────────

async function handleLembrete(msg, user, texto) {
  const tz = user.timezone || 'America/Belem';

  // Se nunca confirmou timezone, pergunta a cidade primeiro e guarda o lembrete pendente
  if (!user.timezone_confirmed) {
    sessoes.set(msg.from, { step: 'aguardando_cidade', pendingLembrete: texto });
    await msg.reply(
      '📍 Antes de agendar, me diz em qual cidade você está!\n\n' +
      '_Ex: Belém, São Paulo, Manaus, Recife..._\n\n' +
      '_Só preciso saber uma vez pra acertar o horário pra você._'
    );
    return;
  }

  await agendarLembrete(msg, user, texto, tz);
}

async function handleCidadeResposta(msg, user, texto) {
  const estado = sessoes.get(msg.from) || {};
  sessoes.delete(msg.from);

  const tz = cidadeParaTimezone(texto);
  if (!tz) {
    await msg.reply(
      '🤔 Não reconheci essa cidade. Tenta com o nome completo:\n\n' +
      '_Ex: Belém, São Paulo, Fortaleza, Manaus, Brasília..._'
    );
    sessoes.set(msg.from, { step: 'aguardando_cidade', pendingLembrete: estado.pendingLembrete });
    return;
  }

  await supabase.from('profiles').update({ timezone: tz, timezone_confirmed: true }).eq('id', user.id);
  user.timezone = tz;
  user.timezone_confirmed = true;

  const cidadeNome = texto.trim();
  await msg.reply(`✅ Anotei! Vou usar o horário de *${cidadeNome}* pra seus lembretes.`);

  // retoma o lembrete que estava pendente
  if (estado.pendingLembrete) {
    await agendarLembrete(msg, user, estado.pendingLembrete, tz);
  }
}

async function agendarLembrete(msg, user, texto, tz) {
  const quando = parsearTempo(texto, tz);
  if (!quando) {
    await msg.reply(
      '🤔 Não entendi quando. Exemplos:\n\n' +
      '_"me lembra daqui a 2h de..."_\n' +
      '_"me lembra amanhã às 9h de..."_\n' +
      '_"me lembra 15/05 às 14h de..."_'
    );
    return;
  }

  // extrai só o conteúdo do lembrete
  const mensagem = texto
    .replace(/\b(me lembr[ae]|lembr[ae][-\s]me|lembrete|me avis[ae]|me notifiqu?e)\b/gi, '')
    .replace(/(?:daqui\s+a|em)\s+\d+\s*\w+/i, '')
    .replace(/amanh[ãa](?:\s+(?:às?|as))?\s+\d{1,2}(?:[h:]\d{2})?/i, '')
    .replace(/hoje(?:\s+(?:às?|as))?\s+\d{1,2}(?:[h:]\d{2})?/i, '')
    .replace(/\d{1,2}\/\d{1,2}(?:\s+(?:às?|as))?\s+\d{1,2}(?:[h:]\d{2})?/i, '')
    .replace(/^\s*(de|que|pra|para)\s*/i, '')
    .trim();

  if (!mensagem) {
    await msg.reply('⚠️ Me diz o que é pra lembrar. Ex: _"me lembra daqui a 1h de tomar remédio"_');
    return;
  }

  const { error } = await supabase.from('reminders').insert({
    user_id: user.id,
    phone: msg.from,
    message: mensagem,
    remind_at: quando,
    status: 'scheduled'
  });

  if (error) { console.error('Erro lembrete:', error); await msg.reply('❌ Erro ao agendar.'); return; }

  const horaFormatada = formatarHoraLocal(quando, tz);
  await msg.reply(`✅ Lembrete agendado!\n\n📅 ${horaFormatada}\n💬 _"${mensagem}"_`);
}

// ─── LANÇAMENTOS ──────────────────────────────────────────────────────────────

async function parsearLancamentos(textoLivre) {
  const hoje  = new Date().toISOString().split('T')[0];
  const ontem = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  try {
    const response = await mistral.chat.complete({
      model: 'mistral-small-latest',
      messages: [
        {
          role: 'system',
          content: `Você extrai transações financeiras de textos em português brasileiro informal.

REGRA CRÍTICA: Se o texto é PERGUNTA ou INTENÇÃO FUTURA (posso, quero, consigo, dá pra, vale a pena, vou comprar, pretendo, penso em) → retorne [{"error":"é pergunta"}].
Apenas extraia se o texto descreve algo QUE JÁ ACONTECEU (gastei, paguei, comprei, recebi, ganhei, custou, cobrou).

Responda APENAS array JSON sem markdown:
[{"type":"expense|income","amount":numero,"title":"descrição curta","date":"YYYY-MM-DD","pending":false,"category":"nome","payment_method":"método"}]

CATEGORIAS — escolha uma:
Para expense: Alimentação, Transporte, Lazer, Assinaturas, Estudo, Emergências, Parcelados
Para income: Salário

Mapeamento de categorias:
- comida, almoço, jantar, mercado, lanche, ifood, café, restaurante, padaria → Alimentação
- uber, 99, gasolina, ônibus, combustível, estacionamento → Transporte
- cinema, show, bar, festa, viagem, jogo, diversão → Lazer
- netflix, spotify, amazon, disney, assinatura mensal → Assinaturas
- curso, livro, mensalidade escolar, material, faculdade → Estudo
- hospital, urgência, imprevisto, conserto urgente, remédio, farmácia → Emergências
- parcelamento, parcela, prestação → Parcelados
- salário, holerite, freela, venda, renda, pagamento → Salário
- dúvida: use Alimentação (expense) ou Salário (income)

MÉTODO DE PAGAMENTO — escolha um:
pix · debit · credit · cash · installment
Mapeamento:
- "pix" → pix (padrão se não informado)
- "débito", "no débito" → debit
- "crédito", "cartão" → credit
- "dinheiro", "espécie" → cash
- "parcelado", "parcelei" → installment

Exemplos:
"gastei 100 na limpeza no débito" → [{"type":"expense","amount":100,"title":"Limpeza","date":"${hoje}","pending":false,"category":"Emergências","payment_method":"debit"}]
"recebi 500 de freela" → [{"type":"income","amount":500,"title":"Freela","date":"${hoje}","pending":false,"category":"Salário","payment_method":"pix"}]
"uber 15 ontem" → [{"type":"expense","amount":15,"title":"Uber","date":"${ontem}","pending":false,"category":"Transporte","payment_method":"pix"}]
"netflix 45 no crédito" → [{"type":"expense","amount":45,"title":"Netflix","date":"${hoje}","pending":false,"category":"Assinaturas","payment_method":"credit"}]
"posso gastar 2600?" → [{"error":"é pergunta"}]

Sem valor ou é pergunta → [{"error":"não extraível"}]
"ontem" → ${ontem}, sem data → ${hoje}
"ainda não recebi" → pending: true`
        },
        { role: 'user', content: textoLivre }
      ]
    });

    const raw    = response.choices[0].message.content.trim();
    console.log('Mistral:', raw);
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    console.error('Erro Mistral:', err.message);
    return [{ error: 'falha no parse' }];
  }
}

async function salvarLancamentos(msg, user, lista) {
  // busca categorias do usuário
  const { data: categorias } = await supabase
    .from('categories').select('id, name, type').eq('user_id', user.id);

  const mapaCat = {};
  (categorias || []).forEach(c => { mapaCat[c.name.toLowerCase()] = c.id; });

  const metodoMap = { pix: 'pix', debit: 'debit', credit: 'credit', cash: 'cash', installment: 'installment' };
  const emojiMetodo = { pix: '💰', debit: '💳', credit: '💳', cash: '💵', installment: '📊' };

  const salvas = [], pendentes = [], erros = [];

  for (const dado of lista) {
    if (dado.error) continue;
    const { type, amount, title, date, pending, category, payment_method } = dado;
    if (!amount || amount <= 0) { erros.push(title || '?'); continue; }

    // resolve category_id com múltiplos fallbacks
    let category_id = null;
    if (category) {
      category_id = mapaCat[category.toLowerCase()] || null;
      if (!category_id) {
        // tenta correspondência parcial
        const encontrada = (categorias || []).find(c =>
          c.name.toLowerCase().includes(category.toLowerCase()) ||
          category.toLowerCase().includes(c.name.toLowerCase())
        );
        if (encontrada) category_id = encontrada.id;
      }
      if (!category_id) {
        // fallback: primeira categoria do tipo correto
        const primeira = (categorias || []).find(c => c.type === type);
        if (primeira) category_id = primeira.id;
      }
    }

    const metodo = metodoMap[payment_method] || 'pix';

    const { error } = await supabase.from('transactions').insert({
      user_id: user.id, type,
      title: title || 'Sem descrição',
      amount,
      date: date || new Date().toISOString().split('T')[0],
      payment_method: metodo,
      category_id,
      notes: pending ? 'pendente' : null
    });

    if (error) { console.error('Erro insert:', error); erros.push(title); }
    else {
      const item = { type, amount, title, category, metodo };
      if (pending) pendentes.push(item); else salvas.push(item);
    }
  }

  let resposta = '';
  if (salvas.length > 0) {
    resposta += `✅ *${salvas.length} lançamento${salvas.length > 1 ? 's' : ''} salvo${salvas.length > 1 ? 's' : ''}:*\n`;
    for (const t of salvas) {
      const cat    = t.category ? ` _(${t.category})_` : '';
      const emoji  = emojiMetodo[t.metodo] || '';
      resposta += `${t.type === 'income' ? '💚' : '🔴'} ${t.title} — R$ ${parseFloat(t.amount).toFixed(2)} ${emoji}${cat}\n`;
    }
  }
  if (pendentes.length > 0) {
    resposta += `\n⏳ *Pendente${pendentes.length > 1 ? 's' : ''}:*\n`;
    for (const t of pendentes) {
      resposta += `💛 ${t.title} — R$ ${parseFloat(t.amount).toFixed(2)}\n`;
    }
    resposta += `_Quando receber: "confirmei o [valor]" ou *3*._\n`;
  }
  if (erros.length > 0) resposta += `\n⚠️ Não entendi: ${erros.join(', ')}\n`;
  resposta += `\n_*1* para ver o saldo._`;
  await msg.reply(resposta.trim());
}

async function processarLancamentoTexto(msg, user, texto) {
  const lista = await parsearLancamentos(texto);
  if (lista.some(t => t.error === 'é pergunta')) { await handleConsultaCompra(msg, user, texto); return; }
  if (lista.every(t => t.error)) { await msg.reply('🤔 Não entendi. Tenta com o valor, ex: _"gastei 45 no mercado"_'); return; }
  await salvarLancamentos(msg, user, lista);
}

async function handleLancamento(msg, user, texto) {
  sessoes.delete(msg.from);
  if (texto === '0') { await msg.reply('Cancelado. ' + menuPrincipal()); return; }
  await msg.reply('⏳ Processando...');
  await processarLancamentoTexto(msg, user, texto);
}

// ─── SALDO ────────────────────────────────────────────────────────────────────

async function handleSaldo(msg, user) {
  const hoje       = new Date();
  const primeiroDia = new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString().split('T')[0];
  const ultimoDia  = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).toISOString().split('T')[0];

  // tudo ANTES do mês atual = saldo inicial
  const { data: txAnt } = await supabase
    .from('transactions').select('type, amount, notes')
    .eq('user_id', user.id).is('deleted_at', null)
    .lt('date', primeiroDia)
    .or('notes.is.null,notes.like.fixa:%');

  const recAnt  = (txAnt || []).filter(t => t.type === 'income').reduce((a, t) => a + parseFloat(t.amount), 0);
  const despAnt = (txAnt || []).filter(t => t.type === 'expense').reduce((a, t) => a + parseFloat(t.amount), 0);
  const saldoInicial = recAnt - despAnt;

  // transações do mês atual
  const { data: tx, error } = await supabase
    .from('transactions').select('type, amount, title, notes')
    .eq('user_id', user.id).is('deleted_at', null)
    .gte('date', primeiroDia).lte('date', ultimoDia);
  if (error) { await msg.reply('❌ Erro.'); return; }

  const confirmados = (tx || []).filter(t => t.notes !== 'pendente');
  const pendentes   = (tx || []).filter(t => t.notes === 'pendente');
  const recMes  = confirmados.filter(t => t.type === 'income').reduce((a, t) => a + parseFloat(t.amount), 0);
  const despMes = confirmados.filter(t => t.type === 'expense').reduce((a, t) => a + parseFloat(t.amount), 0);
  const saldoAtual = saldoInicial + recMes - despMes;

  // fixas do mês
  const { data: fixas } = await supabase
    .from('recurring_rules').select('id, title, amount, type, day_of_month')
    .eq('user_id', user.id).eq('active', true)
    .gte('next_due_date', primeiroDia).lte('next_due_date', ultimoDia);

  const fixasPagas    = new Set((tx || []).filter(t => t.notes?.startsWith('fixa:')).map(t => t.notes.replace('fixa:', '')));
  const fixasPendentes = (fixas || []).filter(f => !fixasPagas.has(f.id));

  const mesNome = hoje.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

  let resposta = `💰 *Saldo em conta:* R$ ${saldoAtual.toFixed(2)}\n`;
  resposta += `━━━━━━━━━━━━\n\n`;
  resposta += `📊 *${mesNome}*\n`;
  resposta += `💼 Início do mês: R$ ${saldoInicial.toFixed(2)}\n`;
  resposta += `✅ Entradas: R$ ${recMes.toFixed(2)}\n`;
  resposta += `❌ Saídas: R$ ${despMes.toFixed(2)}\n`;
  resposta += `━━━━━━━━━━━━\n`;
  resposta += `${saldoAtual >= 0 ? '💚' : '🔴'} Saldo atual: R$ ${saldoAtual.toFixed(2)}\n`;
  resposta += `_${confirmados.length} lançamentos no mês_`;

  if (pendentes.length > 0) {
    const total = pendentes.filter(t => t.type === 'income').reduce((a, t) => a + parseFloat(t.amount), 0);
    resposta += `\n\n⏳ A receber: R$ ${total.toFixed(2)} — *3* para ver`;
  }

  if (fixasPendentes.length > 0) {
    const totalFixas = fixasPendentes.filter(f => f.type === 'expense').reduce((a, f) => a + parseFloat(f.amount), 0);
    resposta += `\n\n⚠️ *Fixas pendentes:*\n`;
    fixasPendentes.forEach(f => { resposta += `🔴 ${f.title} — R$ ${parseFloat(f.amount).toFixed(2)} (dia ${f.day_of_month})\n`; });
    if (totalFixas > 0) resposta += `_Projetado pós-fixas: R$ ${(saldoAtual - totalFixas).toFixed(2)}_\n`;
    resposta += `_"paguei [nome]" para registrar_`;
  }

  await msg.reply(resposta);
}

// ─── PENDENTES ────────────────────────────────────────────────────────────────

async function handleVerPendentes(msg, user) {
  const { data, error } = await supabase
    .from('transactions').select('id, type, amount, title, date')
    .eq('user_id', user.id).eq('notes', 'pendente').is('deleted_at', null)
    .order('date', { ascending: false });
  if (error) { await msg.reply('❌ Erro.'); return; }
  if (!data?.length) { await msg.reply('✅ Nenhum pendente!'); return; }

  let r = `⏳ *Pendentes (${data.length}):*\n\n`;
  data.forEach((t, i) => {
    const d = new Date(t.date + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    r += `${i + 1}. ${t.type === 'income' ? '💛' : '🔴'} ${t.title} — R$ ${parseFloat(t.amount).toFixed(2)} _(${d})_\n`;
  });
  const total = data.filter(t => t.type === 'income').reduce((a, t) => a + parseFloat(t.amount), 0);
  if (total > 0) r += `\n💛 *A receber: R$ ${total.toFixed(2)}*\n`;
  r += `\n_"confirmei o [valor]"_ ou _"confirmei tudo"_`;
  await msg.reply(r);
}

async function handleConfirmarPendenteNatural(msg, user, texto) {
  if (/confirmei tudo|recebi tudo|caiu tudo/i.test(texto)) {
    await supabase.from('transactions').update({ notes: null }).eq('user_id', user.id).eq('notes', 'pendente');
    await msg.reply('✅ Todos os pendentes confirmados!');
    return;
  }
  const matchValor = texto.match(/\d+([.,]\d{1,2})?/);
  const valor = matchValor ? parseFloat(matchValor[0].replace(',', '.')) : null;

  const { data } = await supabase.from('transactions').select('id, title, amount')
    .eq('user_id', user.id).eq('notes', 'pendente').is('deleted_at', null);
  if (!data?.length) { await msg.reply('✅ Nenhum pendente.'); return; }

  let alvo = null;
  if (valor) alvo = data.find(t => Math.abs(parseFloat(t.amount) - valor) < 0.02);
  if (!alvo)  alvo = data.find(t => texto.toLowerCase().includes(t.title.toLowerCase()));
  if (!alvo && data.length === 1) alvo = data[0];
  if (!alvo) { await msg.reply('🤔 Qual pendente? Use *3* para ver a lista.'); return; }

  await supabase.from('transactions').update({ notes: null }).eq('id', alvo.id);
  await msg.reply(`✅ *${alvo.title}* — R$ ${parseFloat(alvo.amount).toFixed(2)} confirmado!\n\n_*1* para ver o saldo._`);
}

// ─── DESPESAS FIXAS ───────────────────────────────────────────────────────────

async function handleFixas(msg, user) {
  const tel = msg.from;
  const hoje = new Date();
  const p1 = new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString().split('T')[0];
  const pN = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).toISOString().split('T')[0];

  const { data: fixas } = await supabase
    .from('recurring_rules').select('id, title, amount, type, day_of_month')
    .eq('user_id', user.id).eq('active', true).order('day_of_month');

  const { data: txMes } = await supabase.from('transactions').select('notes')
    .eq('user_id', user.id).is('deleted_at', null).gte('date', p1).lte('date', pN).like('notes', 'fixa:%');
  const pagas = new Set((txMes || []).map(t => t.notes.replace('fixa:', '')));

  let r = '🔁 *Fixas:*\n\n';
  if (!fixas?.length) {
    r += '_Nenhuma cadastrada._\n\n';
  } else {
    fixas.forEach((f, i) => {
      const emoji  = f.type === 'income' ? '💚' : '🔴';
      const status = pagas.has(f.id) ? '✅' : '⏳';
      r += `${i + 1}. ${emoji} ${f.title} — R$ ${parseFloat(f.amount).toFixed(2)} dia ${f.day_of_month} ${status}\n`;
    });
    r += '\n';
  }
  r += '*N* nova: _"nome | valor | dia | tipo"_\n_Ex: "Netflix | 45.90 | 15 | despesa"_\n\n*P* pagar: _"paguei [nome]"_\n*C* cancelar: _"cancelar [número]"_\n*0* menu.';
  sessoes.set(tel, { step: 'fixa_nova', fixas: fixas || [] });
  await msg.reply(r);
}

async function handleFixaNova(msg, user, texto) {
  const tel   = msg.from;
  const estado = sessoes.get(tel) || {};
  if (texto === '0') { sessoes.delete(tel); await msg.reply(menuPrincipal()); return; }

  if (/^cancelar/i.test(texto)) {
    const num = parseInt(texto.replace(/\D/g, ''));
    const alvo = (estado.fixas || [])[num - 1];
    if (!alvo) { await msg.reply('⚠️ Número inválido.'); return; }
    await supabase.from('recurring_rules').update({ active: false }).eq('id', alvo.id);
    sessoes.delete(tel);
    await msg.reply(`✅ *${alvo.title}* removida.\n\n` + menuPrincipal());
    return;
  }

  const partes = texto.split('|').map(p => p.trim());
  if (partes.length < 3) { await msg.reply('⚠️ Formato: _"nome | valor | dia | tipo"_'); return; }
  const [title, valorRaw, diaRaw, tipoRaw] = partes;
  const amount       = parseFloat(valorRaw.replace(',', '.'));
  const day_of_month = parseInt(diaRaw);
  const type         = /receita/i.test(tipoRaw || '') ? 'income' : 'expense';

  if (isNaN(amount) || amount <= 0) { await msg.reply('⚠️ Valor inválido.'); return; }
  if (isNaN(day_of_month) || day_of_month < 1 || day_of_month > 31) { await msg.reply('⚠️ Dia inválido (1–31).'); return; }

  const hoje = new Date();
  let proximo = new Date(hoje.getFullYear(), hoje.getMonth(), day_of_month);
  if (proximo <= hoje) proximo = new Date(hoje.getFullYear(), hoje.getMonth() + 1, day_of_month);

  const { error } = await supabase.from('recurring_rules').insert({
    user_id: user.id, title, amount, type, cadence: 'monthly',
    day_of_month, next_due_date: proximo.toISOString().split('T')[0], active: true
  });
  sessoes.delete(tel);
  if (error) { await msg.reply('❌ Erro.'); return; }
  await msg.reply(`✅ ${type === 'income' ? '💚' : '🔴'} *${title}* — R$ ${amount.toFixed(2)} todo dia ${day_of_month}\n\n_"paguei ${title}"_ para registrar.\n\n` + menuPrincipal());
}

async function handlePagarFixa(msg, user, texto) {
  const { data: fixas } = await supabase.from('recurring_rules').select('id, title, amount, type, day_of_month')
    .eq('user_id', user.id).eq('active', true);
  if (!fixas?.length) { await msg.reply('Sem fixas cadastradas. Use *4*.'); return; }

  let alvo = fixas.find(f => texto.toLowerCase().includes(f.title.toLowerCase()));
  if (!alvo && fixas.length === 1) alvo = fixas[0];
  if (!alvo) {
    let lista = '🔁 *Qual fixa você pagou?*\n\n';
    fixas.forEach((f, i) => { lista += `${i + 1}. ${f.title} — R$ ${parseFloat(f.amount).toFixed(2)}\n`; });
    lista += '\n_"paguei [nome ou número]"_';
    await msg.reply(lista); return;
  }

  const hoje = new Date().toISOString().split('T')[0];
  await supabase.from('transactions').insert({
    user_id: user.id, type: alvo.type, title: alvo.title, amount: alvo.amount,
    date: hoje, payment_method: 'pix', notes: `fixa:${alvo.id}`
  });

  const prox = new Date();
  prox.setMonth(prox.getMonth() + 1);
  await supabase.from('recurring_rules').update({
    next_due_date: new Date(prox.getFullYear(), prox.getMonth(), alvo.day_of_month).toISOString().split('T')[0]
  }).eq('id', alvo.id);

  await msg.reply(`✅ ${alvo.type === 'income' ? '💚' : '🔴'} *${alvo.title}* registrado!\n\n_*1* para ver o saldo._`);
}

async function handleCriarFixaNatural(msg, user, texto) {
  await msg.reply('🔁 Cadastrando...');
  try {
    const r = await mistral.chat.complete({
      model: 'mistral-small-latest',
      messages: [
        { role: 'system', content: 'Extraia dados de uma despesa/receita fixa mensal. Responda APENAS JSON sem markdown:\n{"title":"nome","amount":numero,"day_of_month":1_a_31,"type":"expense|income"}\nSem dia → 1. Sem tipo → expense.' },
        { role: 'user', content: texto }
      ]
    });
    const d = JSON.parse(r.choices[0].message.content.trim().replace(/```json|```/g, '').trim());
    if (!d.title || !d.amount) { await msg.reply('🤔 Não entendi. Use *4* para criar manualmente.'); return; }

    const hoje = new Date();
    let prox = new Date(hoje.getFullYear(), hoje.getMonth(), d.day_of_month || 1);
    if (prox <= hoje) prox = new Date(hoje.getFullYear(), hoje.getMonth() + 1, d.day_of_month || 1);

    await supabase.from('recurring_rules').insert({
      user_id: user.id, title: d.title, amount: d.amount,
      type: d.type || 'expense', cadence: 'monthly',
      day_of_month: d.day_of_month || 1, next_due_date: prox.toISOString().split('T')[0], active: true
    });
    const emoji = d.type === 'income' ? '💚' : '🔴';
    await msg.reply(`✅ ${emoji} *${d.title}* — R$ ${parseFloat(d.amount).toFixed(2)} todo dia ${d.day_of_month || 1}\n\n_"paguei ${d.title}"_ quando pagar.`);
  } catch (err) {
    console.error('Erro fixa natural:', err.message);
    await msg.reply('🤔 Não entendi. Use *4*.');
  }
}

// ─── METAS ────────────────────────────────────────────────────────────────────

async function handleMetas(msg, user) {
  const tel = msg.from;
  const { data: metas } = await supabase
    .from('goals').select('id, title, target_amount, current_amount, deadline')
    .eq('user_id', user.id).is('deleted_at', null).order('created_at', { ascending: false });

  let r = '🎯 *Metas:*\n\n';
  if (!metas?.length) {
    r += '_Nenhuma ainda._\n\nDica: manda _"quero juntar R$ 2000 para viagem"_ e crio direto!\n\n';
  } else {
    metas.forEach((m, i) => {
      const atual = parseFloat(m.current_amount);
      const alvo  = parseFloat(m.target_amount);
      const pct   = Math.min(Math.round((atual / alvo) * 100), 100);
      const barra = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
      const prazo = m.deadline
        ? ` — ${new Date(m.deadline + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })}`
        : '';
      r += `${i + 1}. 🎯 *${m.title}*${prazo}\n[${barra}] ${pct}% — R$ ${atual.toFixed(2)}/${alvo.toFixed(2)}\n\n`;
    });
  }
  r += '*N* nova: _"nome | valor | DD/MM/AAAA (opcional)"_\n_Ex: "Viagem Peru | 3000 | 31/12/2026"_\n\n*C* contribuir: _"contribuir [número] [valor]"_\n\n*0* menu.';
  sessoes.set(tel, { step: 'meta_nova', metas: metas || [] });
  await msg.reply(r);
}

async function handleMetaNova(msg, user, texto) {
  const tel   = msg.from;
  const estado = sessoes.get(tel) || {};
  if (texto === '0') { sessoes.delete(tel); await msg.reply(menuPrincipal()); return; }

  if (/^contribuir/i.test(texto)) {
    sessoes.set(tel, { step: 'meta_contribuir', metas: estado.metas });
    await handleMetaContribuir(msg, user, texto); return;
  }

  const partes = texto.split('|').map(p => p.trim());
  if (partes.length < 2) { await msg.reply('⚠️ Formato: _"nome | valor | DD/MM/AAAA (opcional)"_'); return; }
  const [title, valorRaw, dataRaw] = partes;
  const target_amount = parseFloat(valorRaw.replace(',', '.'));
  if (isNaN(target_amount) || target_amount <= 0) { await msg.reply('⚠️ Valor inválido.'); return; }

  let deadline = null;
  if (dataRaw) {
    const [dia, mes, ano] = dataRaw.split('/');
    if (dia && mes && ano) deadline = `${ano}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
  }

  const { error } = await supabase.from('goals').insert({ user_id: user.id, title, target_amount, current_amount: 0, deadline });
  sessoes.delete(tel);
  if (error) { await msg.reply('❌ Erro.'); return; }
  await msg.reply(`✅ 🎯 *${title}* — R$ ${target_amount.toFixed(2)}${deadline ? ` até ${dataRaw}` : ''}\n\n_"contribui [valor] pra meta ${title}"_ para adicionar.\n\n` + menuPrincipal());
}

async function handleMetaContribuir(msg, user, texto) {
  const estado = sessoes.get(msg.from) || {};
  sessoes.delete(msg.from);
  if (texto === '0') { await msg.reply(menuPrincipal()); return; }

  const match = texto.match(/contribuir\s+(\d+)\s+([\d.,]+)/i);
  if (!match) { await msg.reply('⚠️ Formato: _"contribuir [número] [valor]"_'); return; }

  const meta  = (estado.metas || [])[parseInt(match[1]) - 1];
  const valor = parseFloat(match[2].replace(',', '.'));
  if (!meta)                  { await msg.reply('⚠️ Número inválido. Use *6*.'); return; }
  if (isNaN(valor) || valor <= 0) { await msg.reply('⚠️ Valor inválido.'); return; }

  await supabase.from('goal_contributions').insert({
    goal_id: meta.id, user_id: user.id,
    date: new Date().toISOString().split('T')[0], amount: valor
  });

  const { data: m } = await supabase.from('goals').select('current_amount, target_amount, title').eq('id', meta.id).single();
  const atual = parseFloat(m?.current_amount || 0);
  const alvo  = parseFloat(m?.target_amount || meta.target_amount);
  const pct   = Math.min(Math.round((atual / alvo) * 100), 100);
  const barra = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));

  await msg.reply(
    `✅ R$ ${valor.toFixed(2)} na meta *${m?.title || meta.title}*!\n[${barra}] ${pct}%\nR$ ${atual.toFixed(2)} / R$ ${alvo.toFixed(2)}` +
    (pct >= 100 ? '\n\n🎉 *Meta concluída!*' : `\n_Faltam R$ ${(alvo - atual).toFixed(2)}_`) +
    '\n\n' + menuPrincipal()
  );
}

async function handleCriarMetaNatural(msg, user, texto) {
  await msg.reply('🎯 Criando meta...');
  try {
    const hoje = new Date().toISOString().split('T')[0];
    const r = await mistral.chat.complete({
      model: 'mistral-small-latest',
      messages: [
        { role: 'system', content: `Extraia dados de uma meta financeira. Responda APENAS JSON sem markdown:\n{"title":"nome","target_amount":numero,"deadline":"YYYY-MM-DD ou null"}\nHoje: ${hoje}. Se mencionar mês/ano, calcule a data.` },
        { role: 'user', content: texto }
      ]
    });
    const d = JSON.parse(r.choices[0].message.content.trim().replace(/```json|```/g, '').trim());
    if (!d.title || !d.target_amount) { await msg.reply('🤔 Não entendi. Use *6*.'); return; }

    await supabase.from('goals').insert({
      user_id: user.id, title: d.title,
      target_amount: d.target_amount, current_amount: 0, deadline: d.deadline || null
    });
    await msg.reply(
      `✅ 🎯 *${d.title}* — R$ ${parseFloat(d.target_amount).toFixed(2)}` +
      (d.deadline ? `\n📅 Prazo: ${new Date(d.deadline + 'T12:00:00').toLocaleDateString('pt-BR')}` : '') +
      `\n\n_"contribui [valor] pra meta ${d.title}"_ para adicionar.`
    );
  } catch (err) {
    console.error('Erro meta natural:', err.message);
    await msg.reply('🤔 Não entendi. Use *6*.');
  }
}

async function handleContribuirMetaNatural(msg, user, texto) {
  const { data: metas } = await supabase
    .from('goals').select('id, title, target_amount, current_amount')
    .eq('user_id', user.id).is('deleted_at', null);
  if (!metas?.length) { await msg.reply('Sem metas ainda. Manda _"quero juntar R$ X para [nome]"_.'); return; }

  const matchValor = texto.match(/\d+([.,]\d{1,2})?/);
  const valor = matchValor ? parseFloat(matchValor[0].replace(',', '.')) : null;
  if (!valor || valor <= 0) { await msg.reply('⚠️ Não identifiquei o valor. Tenta _"contribui 200 pra meta Viagem"_.'); return; }

  let meta = metas.find(m => texto.toLowerCase().includes(m.title.toLowerCase()));
  if (!meta && metas.length === 1) meta = metas[0];
  if (!meta) {
    let lista = '🎯 *Qual meta?*\n\n';
    metas.forEach((m, i) => { lista += `${i + 1}. ${m.title} — R$ ${parseFloat(m.current_amount).toFixed(2)}/${parseFloat(m.target_amount).toFixed(2)}\n`; });
    await msg.reply(lista + `\n_"contribuir [número] ${valor}"_`); return;
  }

  await supabase.from('goal_contributions').insert({
    goal_id: meta.id, user_id: user.id,
    date: new Date().toISOString().split('T')[0], amount: valor
  });

  const { data: m } = await supabase.from('goals').select('current_amount, target_amount').eq('id', meta.id).single();
  const atual = parseFloat(m?.current_amount || 0);
  const alvo  = parseFloat(m?.target_amount || meta.target_amount);
  const pct   = Math.min(Math.round((atual / alvo) * 100), 100);
  const barra = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));

  await msg.reply(
    `✅ R$ ${valor.toFixed(2)} na meta *${meta.title}*!\n[${barra}] ${pct}%\nR$ ${atual.toFixed(2)} / R$ ${alvo.toFixed(2)}` +
    (pct >= 100 ? '\n\n🎉 *Meta concluída!*' : `\n_Faltam R$ ${(alvo - atual).toFixed(2)}_`)
  );
}

// ─── PARCELADAS ───────────────────────────────────────────────────────────────

async function handleParceladas(msg, user) {
  const tel = msg.from;
  const { data: planos } = await supabase
    .from('installment_plans')
    .select('id, title, total_amount, installments_count, first_due_date, installments(status)')
    .eq('user_id', user.id).is('deleted_at', null).order('created_at', { ascending: false });

  let r = '💳 *Parceladas:*\n\n';
  if (!planos?.length) {
    r += '_Nenhuma._\n\n';
  } else {
    planos.forEach((p, i) => {
      const pagas  = (p.installments || []).filter(x => x.status === 'paid').length;
      const restam = p.installments_count - pagas;
      const parcela = parseFloat(p.total_amount) / p.installments_count;
      r += `${i + 1}. 💳 *${p.title}* — R$ ${parcela.toFixed(2)}/mês — ${pagas}/${p.installments_count} pagas (${restam} restam)\n\n`;
    });
  }
  r += '*N* nova: _"nome | total | parcelas | DD/MM/AAAA"_\n_Ex: "Celular | 1200 | 12 | 10/04/2026"_\n\n*0* menu.';
  sessoes.set(tel, { step: 'parcelada_nova' });
  await msg.reply(r);
}

async function handleParceladaNova(msg, user, texto) {
  sessoes.delete(msg.from);
  if (texto === '0') { await msg.reply(menuPrincipal()); return; }

  const partes = texto.split('|').map(p => p.trim());
  if (partes.length < 4) { await msg.reply('⚠️ Formato: _"nome | total | parcelas | DD/MM/AAAA"_'); return; }

  const [title, valorRaw, numRaw, dataRaw] = partes;
  const total_amount      = parseFloat(valorRaw.replace(',', '.'));
  const installments_count = parseInt(numRaw);
  const [dia, mes, ano]   = dataRaw.split('/');
  const first_due_date    = `${ano}-${mes?.padStart(2, '0')}-${dia?.padStart(2, '0')}`;

  if (isNaN(total_amount) || total_amount <= 0) { await msg.reply('⚠️ Valor inválido.'); return; }
  if (isNaN(installments_count) || installments_count < 2) { await msg.reply('⚠️ Mínimo 2 parcelas.'); return; }
  if (!ano || !mes || !dia) { await msg.reply('⚠️ Data inválida. Use DD/MM/AAAA.'); return; }

  const valorParcela = total_amount / installments_count;
  const { data: plano, error } = await supabase.from('installment_plans').insert({
    user_id: user.id, title, total_amount, installments_count, first_due_date, payment_method: 'credit'
  }).select().single();
  if (error) { await msg.reply('❌ Erro.'); return; }

  const parcelas = [];
  for (let i = 0; i < installments_count; i++) {
    const venc = new Date(`${first_due_date}T12:00:00`);
    venc.setMonth(venc.getMonth() + i);
    parcelas.push({
      plan_id: plano.id, user_id: user.id,
      installment_number: i + 1,
      due_date: venc.toISOString().split('T')[0],
      amount: valorParcela, status: 'pending'
    });
  }
  const { error: errP } = await supabase.from('installments').insert(parcelas);
  if (errP) { await msg.reply('❌ Erro ao gerar parcelas.'); return; }

  await msg.reply(`✅ 💳 *${title}* — ${installments_count}x R$ ${valorParcela.toFixed(2)}\n1ª parcela: ${dia}/${mes}/${ano}\n\n` + menuPrincipal());
}

// ─── CONSULTOR DE COMPRAS ─────────────────────────────────────────────────────

async function buscarContextoFinanceiro(user) {
  const hoje = new Date();
  const p1   = new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString().split('T')[0];
  const pN   = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).toISOString().split('T')[0];

  const { data: txAnt } = await supabase
    .from('transactions').select('type, amount, notes')
    .eq('user_id', user.id).is('deleted_at', null)
    .lt('date', p1).or('notes.is.null,notes.like.fixa:%');

  const recAnt  = (txAnt || []).filter(t => t.type === 'income').reduce((a, t) => a + parseFloat(t.amount), 0);
  const despAnt = (txAnt || []).filter(t => t.type === 'expense').reduce((a, t) => a + parseFloat(t.amount), 0);
  const saldoInicial = recAnt - despAnt;

  const { data: tx } = await supabase
    .from('transactions').select('type, amount, notes')
    .eq('user_id', user.id).is('deleted_at', null).gte('date', p1).lte('date', pN);

  const confirmados = (tx || []).filter(t => t.notes !== 'pendente');
  const recMes  = confirmados.filter(t => t.type === 'income').reduce((a, t) => a + parseFloat(t.amount), 0);
  const despMes = confirmados.filter(t => t.type === 'expense').reduce((a, t) => a + parseFloat(t.amount), 0);
  const saldo   = saldoInicial + recMes - despMes;

  const { data: fixas } = await supabase
    .from('recurring_rules').select('id, title, amount, type, day_of_month')
    .eq('user_id', user.id).eq('active', true).gte('next_due_date', p1).lte('next_due_date', pN);

  const fixasPagas     = new Set((tx || []).filter(t => t.notes?.startsWith('fixa:')).map(t => t.notes.replace('fixa:', '')));
  const fixasPendentes = (fixas || []).filter(f => !fixasPagas.has(f.id));
  const totalFixasPend = fixasPendentes.filter(f => f.type === 'expense').reduce((a, f) => a + parseFloat(f.amount), 0);

  const em3M = new Date(hoje.getFullYear(), hoje.getMonth() + 3, 0).toISOString().split('T')[0];
  const { data: parcelas } = await supabase
    .from('installments').select('amount')
    .eq('user_id', user.id).eq('status', 'pending').lte('due_date', em3M);

  const totalParcelas = (parcelas || []).reduce((a, p) => a + parseFloat(p.amount), 0);
  const qtdParcelas   = (parcelas || []).length;

  const ini3M = new Date(hoje.getFullYear(), hoje.getMonth() - 2, 1).toISOString().split('T')[0];
  const { data: recentes } = await supabase
    .from('transactions').select('amount')
    .eq('user_id', user.id).eq('type', 'income').is('deleted_at', null).is('notes', null)
    .gte('date', ini3M);
  const rendaMedia = (recentes || []).reduce((a, t) => a + parseFloat(t.amount), 0) / 3;

  const { data: metas } = await supabase
    .from('goals').select('title, target_amount, current_amount, deadline')
    .eq('user_id', user.id).is('deleted_at', null);

  const metasAtivas = (metas || []).map(m => ({
    title: m.title,
    falta: Math.max(0, parseFloat(m.target_amount) - parseFloat(m.current_amount)),
    pct: Math.min(100, Math.round((parseFloat(m.current_amount) / parseFloat(m.target_amount)) * 100)),
    deadline: m.deadline
  }));

  return { saldo, saldoReal: saldo - totalFixasPend, totalFixasPend, rendaMedia, recMes, totalParcelas, qtdParcelas, metasAtivas };
}

async function handleConsultaCompra(msg, user, descricao, precoExtraido = null) {
  await msg.reply('🤔 Analisando...');
  const ctx = await buscarContextoFinanceiro(user);

  let preco = precoExtraido;
  if (!preco) {
    const m = descricao.match(/R?\$?\s*([\d.,]+)/);
    if (m) { preco = parseFloat(m[1].replace('.', '').replace(',', '.')); if (preco < 5) preco = null; }
  }

  const rendaRef       = ctx.rendaMedia > 0 ? ctx.rendaMedia : (ctx.recMes || 1);
  const mediaParcelaMes = ctx.qtdParcelas > 0 ? (ctx.totalParcelas / 3) : 0;
  const espacoDisp     = Math.max(0, rendaRef * 0.30 - mediaParcelaMes);

  let contexto = `${user.name} pergunta sobre: "${descricao}"${preco ? ` (R$ ${preco.toFixed(2)})` : ''}\n`;
  contexto += `Saldo em conta: R$ ${ctx.saldo.toFixed(2)} | Saldo livre (pós-fixas): R$ ${ctx.saldoReal.toFixed(2)}\n`;
  contexto += `Renda média mensal: R$ ${rendaRef.toFixed(2)}\n`;
  if (ctx.totalFixasPend > 0) contexto += `Fixas pendentes: R$ ${ctx.totalFixasPend.toFixed(2)}\n`;
  contexto += `Comprometido com parcelas: R$ ${mediaParcelaMes.toFixed(2)}/mês | Espaço disponível: R$ ${espacoDisp.toFixed(2)}/mês\n`;

  if (ctx.metasAtivas.length > 0) {
    contexto += 'Metas: ' + ctx.metasAtivas.map(m => {
      const prazo = m.deadline ? ` (prazo ${new Date(m.deadline + 'T12:00:00').toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' })})` : '';
      return `${m.title} ${m.pct}% — faltam R$ ${m.falta.toFixed(2)}${prazo}`;
    }).join(', ') + '\n';
  }

  if (preco && preco > 0) {
    contexto += '\nParcelamento:\n';
    for (const n of [3, 6, 12]) {
      const parc = preco / n;
      contexto += `${n}x R$ ${parc.toFixed(2)} (${((parc / rendaRef) * 100).toFixed(0)}% renda)\n`;
    }
  }

  try {
    const r = await mistral.chat.complete({
      model: 'mistral-small-latest',
      messages: [
        {
          role: 'system',
          content: `Você é o consultor financeiro pessoal de ${user.name}. Tom de amigo que entende de dinheiro — informal, direto, honesto e empático. Nunca sarcástico, nunca agressivo. Responde via WhatsApp, em prosa natural, sem bullet points ou markdown.

Estrutura (4 a 6 frases em parágrafo corrido):
1. Lê a situação com 1–2 números reais do contexto (saldo, renda, espaço disponível)
2. Analisa a compra: cabe à vista? Se parcelado, qual opção é mais saudável? Representa quanto da renda?
3. Se tiver meta ativa que pode ser afetada, menciona pelo nome com impacto concreto
4. Sugere alternativa quando fizer sentido (esperar X meses, parcelar em Y vezes)
5. Fecha com recomendação clara em uma linha: "Compra à vista", "Parcela em Nx", "Espera até [mês]" ou "Não compra agora"

Regras: use números reais, seja específico, trate ${user.name} como adulta que decide — mostra o trade-off sem mandar. Se a situação tiver folgada, libera com segurança. Se tiver apertada, seja honesta com gentileza.`
        },
        { role: 'user', content: contexto }
      ]
    });
    await msg.reply(r.choices[0].message.content.trim());
  } catch (err) {
    console.error('Erro consultor:', err.message);
    await msg.reply('❌ Erro ao consultar.');
  }
}

// ─── START ────────────────────────────────────────────────────────────────────

client.initialize();
