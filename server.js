const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  maxHttpBufferSize: 5e6 // Permite envio de imagens de até 5MB
});
const fs = require('fs');
const path = require('path');

// Porta dinâmica para funcionar localmente (3000) e no Render (process.env.PORT)
const PORT = process.env.PORT || 3000;

// Caminho do banco de dados JSON e código de acesso corporativo
const DB_PATH = path.join(__dirname, 'db.json');
const CODIGO_ACESSO_EMPRESA = process.env.CHAT_PASSWORD || 'xyz2026';

// Salas padrão da Empresa XYZ
const salasDisponiveis = ['Geral', 'Tecnologia', 'Projetos', 'RH & Avisos'];

// Armazena os usuários conectados em memória: { socketId: { id, nome, email, sala } }
const usuariosConectados = {};

// Serve arquivos estáticos da pasta public
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Funções auxiliares para ler e salvar no db.json
function lerBanco() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      fs.writeFileSync(DB_PATH, JSON.stringify({ mensagens: [] }, null, 2));
    }
    const conteudo = fs.readFileSync(DB_PATH, 'utf-8');
    const dados = JSON.parse(conteudo);
    if (!Array.isArray(dados.mensagens)) {
      dados.mensagens = [];
    }
    return dados;
  } catch (erro) {
    console.error('Erro ao ler db.json:', erro);
    return { mensagens: [] };
  }
}

function salvarMensagemNoBanco(novaMensagem) {
  try {
    const db = lerBanco();
    db.mensagens.push(novaMensagem);
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  } catch (erro) {
    console.error('Erro ao salvar no db.json:', erro);
  }
}

// Filtra histórico de uma sala específica (inclui mensagens antigas sem sala na 'Geral')
function obterHistoricoSala(sala) {
  const db = lerBanco();
  return db.mensagens.filter((m) => {
    if (m.tipo === 'privada') return false;
    const salaMsg = m.sala || 'Geral';
    return salaMsg === sala;
  });
}

// Filtra histórico de mensagens privadas entre dois funcionários
function obterHistoricoPrivado(usuarioA, usuarioB) {
  const db = lerBanco();
  return db.mensagens.filter(
    (m) =>
      m.tipo === 'privada' &&
      ((m.de === usuarioA && m.para === usuarioB) ||
        (m.de === usuarioB && m.para === usuarioA))
  );
}

function listarUsuariosOnline() {
  return Object.values(usuariosConectados).map((u) => ({
    id: u.id,
    nome: u.nome,
    sala: u.sala
  }));
}

function formatarHora() {
  return new Date().toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit'
  });
}

io.on('connection', (socket) => {
  console.log(`Nova conexão estabelecida: ${socket.id}`);

  // 1. Autenticação do funcionário
  socket.on('autenticar', ({ nome, email, codigo }) => {
    const nomeLimpo = (nome || '').trim();
    const emailLimpo = (email || '').trim().toLowerCase();
    const codigoLimpo = (codigo || '').trim();

    if (!nomeLimpo || !emailLimpo || !codigoLimpo) {
      return socket.emit('erro autenticacao', 'Preencha todos os campos obrigatórios.');
    }

    if (!emailLimpo.includes('@') || !emailLimpo.includes('.')) {
      return socket.emit('erro autenticacao', 'Informe um e-mail corporativo válido.');
    }

    if (codigoLimpo !== CODIGO_ACESSO_EMPRESA) {
      return socket.emit('erro autenticacao', 'Código de acesso da Empresa XYZ incorreto.');
    }

    const nomeJaEmUso = Object.values(usuariosConectados).some(
      (u) => u.nome.toLowerCase() === nomeLimpo.toLowerCase()
    );

    if (nomeJaEmUso) {
      return socket.emit('erro autenticacao', 'Já existe um colaborador online com esse nome.');
    }

    const salaInicial = 'Geral';
    usuariosConectados[socket.id] = {
      id: socket.id,
      nome: nomeLimpo,
      email: emailLimpo,
      sala: salaInicial
    };

    socket.join(salaInicial);

    // Envia dados iniciais ao usuário autenticado
    socket.emit('autenticado', {
      usuario: usuariosConectados[socket.id],
      salas: salasDisponiveis,
      historico: obterHistoricoSala(salaInicial)
    });

    // Atualiza lista de online para todos e avisa entrada na sala
    io.emit('usuarios online', listarUsuariosOnline());
    io.to(salaInicial).emit('system message', `${nomeLimpo} entrou na sala #${salaInicial}`);
  });

  // 2. Troca de sala
  socket.on('entrar sala', (novaSala) => {
    const usuario = usuariosConectados[socket.id];
    if (!usuario || !salasDisponiveis.includes(novaSala)) return;

    const salaAnterior = usuario.sala;
    if (salaAnterior !== novaSala) {
      socket.leave(salaAnterior);
      io.to(salaAnterior).emit('system message', `${usuario.nome} saiu da sala #${salaAnterior}`);

      usuario.sala = novaSala;
      socket.join(novaSala);
      io.to(novaSala).emit('system message', `${usuario.nome} entrou na sala #${novaSala}`);
      io.emit('usuarios online', listarUsuariosOnline());
    }

    socket.emit('historico sala', {
      sala: novaSala,
      mensagens: obterHistoricoSala(novaSala)
    });
  });

  // 3. Criação de nova sala
  socket.on('criar sala', (nomeSala) => {
    const usuario = usuariosConectados[socket.id];
    if (!usuario) return;

    const salaFormatada = (nomeSala || '').trim();
    if (salaFormatada.length < 2 || salaFormatada.length > 25) {
      return socket.emit('erro chat', 'O nome da sala deve ter entre 2 e 25 caracteres.');
    }

    const jaExiste = salasDisponiveis.some(
      (s) => s.toLowerCase() === salaFormatada.toLowerCase()
    );

    if (jaExiste) {
      return socket.emit('erro chat', 'Essa sala já existe.');
    }

    salasDisponiveis.push(salaFormatada);
    io.emit('atualizar salas', salasDisponiveis);
    io.emit('system message', `${usuario.nome} criou a sala #${salaFormatada}`);
  });

  // 4. Mensagem em sala pública (Texto e/ou Imagem)
  socket.on('chat message', (data) => {
    const usuario = usuariosConectados[socket.id];
    if (!usuario) {
      return socket.emit('erro chat', 'Sessão expirada. Faça login novamente.');
    }

    const texto = (data?.mensagem || '').trim();
    const imagem = data?.imagem || null;

    if (!texto && !imagem) {
      return socket.emit('erro chat', 'Digite uma mensagem ou selecione uma imagem.');
    }

    const registroMensagem = {
      id: Date.now(),
      tipo: 'sala',
      sala: usuario.sala,
      nome: usuario.nome,
      mensagem: texto,
      imagem: imagem,
      hora: formatarHora()
    };

    salvarMensagemNoBanco(registroMensagem);
    io.to(usuario.sala).emit('chat message', registroMensagem);
  });

  // 5. Carregar histórico de conversa privada
  socket.on('abrir privado', (nomeDestinatario) => {
    const usuario = usuariosConectados[socket.id];
    if (!usuario || !nomeDestinatario) return;

    socket.emit('historico privado', {
      com: nomeDestinatario,
      mensagens: obterHistoricoPrivado(usuario.nome, nomeDestinatario)
    });
  });

  // 6. Envio de mensagem privada (Texto e/ou Imagem)
  socket.on('private message', ({ para, mensagem, imagem }) => {
    const usuario = usuariosConectados[socket.id];
    if (!usuario) {
      return socket.emit('erro chat', 'Sessão expirada. Faça login novamente.');
    }

    const texto = (mensagem || '').trim();
    const imagemAnexada = imagem || null;

    if ((!texto && !imagemAnexada) || !para) {
      return socket.emit('erro chat', 'Selecione um destinatário e envie uma mensagem ou imagem.');
    }

    const registroPrivado = {
      id: Date.now(),
      tipo: 'privada',
      de: usuario.nome,
      para: para,
      nome: usuario.nome,
      mensagem: texto,
      imagem: imagemAnexada,
      hora: formatarHora()
    };

    salvarMensagemNoBanco(registroPrivado);

    // Envia de volta para o remetente
    socket.emit('private message', registroPrivado);

    // Envia para o destinatário se estiver online
    const destinatarioSocket = Object.values(usuariosConectados).find(
      (u) => u.nome === para
    );
    if (destinatarioSocket && destinatarioSocket.id !== socket.id) {
      io.to(destinatarioSocket.id).emit('private message', registroPrivado);
    }
  });

  // 7. Desconexão
  socket.on('disconnect', () => {
    const usuario = usuariosConectados[socket.id];
    if (usuario) {
      io.to(usuario.sala).emit('system message', `${usuario.nome} desconectou-se do chat`);
      delete usuariosConectados[socket.id];
      io.emit('usuarios online', listarUsuariosOnline());
    }
    console.log(`Cliente desconectado: ${socket.id}`);
  });
});

http.listen(PORT, () => {
  console.log(`Servidor da Empresa XYZ rodando na porta ${PORT} - http://localhost:${PORT}`);
});