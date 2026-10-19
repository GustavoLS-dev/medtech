#pragma once
// Agenda e acionamento do organizador semanal.
//
// Em cada horario (dia + periodo) com medicamento, o compartimento do dia
// abre, fica aberto pelo tempo definido no site (padrao 60 s) e fecha.
//
// Regras de seguranca:
//  - so executa com automacao LIGADA no site, relogio sincronizado (NTP) e
//    conferido com o servidor, agenda valida (< 24 h sem sincronizar) e PCA9685 pronto;
//  - cada horario e gravado na flash ANTES de mover o servo: depois de uma
//    reinicializacao ele nunca e executado de novo;
//  - com internet, o servidor tambem confirma que o horario ainda nao foi tratado;
//  - horarios atrasados mais que TOLERANCIA_ATRASO_S nao abrem a gaveta;
//  - um servo por vez, movimento em rampa, sem delay() longo;
//  - a bomba nunca e acionada.
#include <time.h>
#include "hardware.h"
#include "api.h"

using namespace MedTechConfig;

enum class Fase : uint8_t { LIVRE, ABRINDO, ABERTO, FECHANDO, ASSENTANDO };

struct Acionamento {
  Fase fase = Fase::LIVRE;
  bool teste = false;        // TESTE manual ou fechamento de recuperacao: nao registra dose
  uint8_t indice = 0;        // compartimento do organizador (0 = segunda ... 6 = domingo)
  uint8_t periodo = SEM_PERIODO;
  uint32_t horario = 0;
  uint32_t tempoAbertoMs = TEMPO_ABERTO_PADRAO_S * 1000UL;
  int angulo = 0;
  uint32_t marco = 0;        // millis() do ultimo passo/mudanca de fase
} job;

bool relogioSincronizado = false;  // NTP respondeu desde o boot
char mensagem1[17] = "", mensagem2[17] = "";
uint32_t mensagemAte = 0;

const char *NOMES_DIAS[NUM_COMPARTIMENTOS] = {"Seg", "Ter", "Qua", "Qui", "Sex", "Sab", "Dom"};
const char *NOMES_PERIODOS[3] = {"Manha", "Tarde", "Noite"};

const char *nomePeriodo(uint8_t p) { return p <= NOITE ? NOMES_PERIODOS[p] : "-"; }

void avisar(const char *l1, const char *l2, uint32_t duracaoMs = 4000) {
  strlcpy(mensagem1, l1, sizeof(mensagem1));
  strlcpy(mensagem2, l2, sizeof(mensagem2));
  mensagemAte = millis() + duracaoMs;
  Hardware::lcdMostrar(mensagem1, mensagem2);
}

const Compartimento &dadosCompartimento(uint8_t indice) { return COMPARTIMENTOS[indice]; }

uint32_t tempoAbertoMs() {
  uint16_t s = agenda.valida ? agenda.tempoAbertoS : TEMPO_ABERTO_PADRAO_S;
  if (s < TEMPO_ABERTO_MIN_S || s > TEMPO_ABERTO_MAX_S) s = TEMPO_ABERTO_PADRAO_S;
  return s * 1000UL;
}

bool agendaEmUso(uint32_t agora) {
  return agenda.valida && agora >= agenda.recebidaEm && agora - agenda.recebidaEm <= VALIDADE_AGENDA_S;
}

// Motivo para nao abrir nada agora (nullptr = pode). Vale para horarios e pedidos.
const char *bloqueioAcionamento(uint32_t agora) {
  if (!Hardware::pcaPronto) return "PCA9685 sem resposta";
  if (!relogioSincronizado) return "relogio nao sincronizado";
  if (!relogioConferido) return "relogio nao conferido com o servidor";
  if (!agenda.valida) return "sem agenda valida";
  if (!agendaEmUso(agora)) return "agenda vencida (sem sincronizar ha mais de 24 h)";
  return nullptr;
}

// Horarios programados exigem tambem a automacao ligada no site.
// Pedidos "Liberar agora" nao: sao um comando explicito do usuario.
const char *bloqueioAutomacao(uint32_t agora) {
  const char *motivo = bloqueioAcionamento(agora);
  if (motivo) return motivo;
  if (!agenda.automacao) return "automacao desligada no site (pagina Programacao)";
  return nullptr;
}

// 00:00 (Brasilia) do dia atual + deslocamento, e o dia da semana desse dia.
uint32_t meiaNoite(uint32_t agora, int deslocamentoDias, int &diaSemana) {
  time_t t = agora;
  struct tm local;
  localtime_r(&t, &local);
  local.tm_hour = 0; local.tm_min = 0; local.tm_sec = 0;
  local.tm_mday += deslocamentoDias;
  local.tm_isdst = 0;
  time_t inicio = mktime(&local);  // normaliza a data e calcula tm_wday
  diaSemana = local.tm_wday;
  return uint32_t(inicio);
}

// Proximo horario da agenda (para LCD e STATUS). Devolve 0 se nao houver.
uint32_t proximoHorario(uint32_t agora, const Horario *&proximo) {
  uint32_t melhor = 0;
  for (int dia = 0; dia <= 7; dia++) {
    int semana;
    uint32_t inicio = meiaNoite(agora, dia, semana);
    for (int i = 0; i < agenda.total; i++) {
      const Horario &h = agenda.itens[i];
      if (h.diaSemana != semana) continue;
      uint32_t t = inicio + h.minutos * 60u;
      if (t > agora && (!melhor || t < melhor)) { melhor = t; proximo = &h; }
    }
    if (melhor) return melhor;
  }
  return 0;
}

// ---- Movimento ----
bool moverCompartimento(uint8_t indice, int angulo) {
  return Hardware::moverServo(dadosCompartimento(indice).canal, angulo);
}

void finalizar(EstadoRegistro estado, const char *detalhe) {
  uint32_t agora = time(nullptr);
  if (!job.teste) {
    gravarRegistro(job.horario, job.periodo, job.indice, estado);
    enfileirarEvento(estado == REG_ACIONADO ? EV_ACIONADO : EV_FALHA, job.periodo, job.horario, agora, detalhe);
  }
  job.fase = Fase::LIVRE;
}

void falharAcionamento(const char *detalhe) {
  Hardware::desligarServos();
  Serial.printf("[SERVO] Falha no compartimento %s: %s. Sinais desligados.\n", NOMES_DIAS[job.indice], detalhe);
  char l2[24];
  snprintf(l2, sizeof(l2), "Gaveta %s", NOMES_DIAS[job.indice]);
  avisar("Falha no servo", l2, 15000);
  finalizar(REG_FALHA, detalhe);
}

// Um passo da rampa em direcao ao alvo. Devolve true quando chegou.
bool passoRampa(int alvo) {
  if (millis() - job.marco < RAMPA_PASSO_MS) return false;
  job.marco = millis();
  if (job.angulo < alvo) job.angulo = min(alvo, job.angulo + RAMPA_PASSO_GRAUS);
  else job.angulo = max(alvo, job.angulo - RAMPA_PASSO_GRAUS);
  if (!moverCompartimento(job.indice, job.angulo)) { falharAcionamento("falha_i2c"); return false; }
  return job.angulo == alvo;
}

void abrirCompartimento(uint8_t indice) {
  const Compartimento &c = dadosCompartimento(indice);
  job.indice = indice;
  job.angulo = c.anguloFechado;
  job.tempoAbertoMs = tempoAbertoMs();
  job.marco = millis();
  job.fase = Fase::ABRINDO;
  char l2[24];
  snprintf(l2, sizeof(l2), "%s - %s", NOMES_DIAS[indice], nomePeriodo(job.periodo));
  avisar("Abrindo gaveta", job.teste ? "Teste manual" : l2, 600000);
  Serial.printf("[SERVO] Abrindo compartimento %s (canal %u, %u -> %u graus).\n", NOMES_DIAS[indice],
                c.canal, c.anguloFechado, c.anguloAberto);
  // Primeiro pulso na posicao fechada: o servo parte do repouso conhecido.
  if (!moverCompartimento(indice, job.angulo)) falharAcionamento("falha_i2c");
}

void fecharCompartimento() {
  job.fase = Fase::FECHANDO;
  job.marco = millis();
  avisar("Fechando gaveta", NOMES_DIAS[job.indice], 60000);
  Serial.printf("[SERVO] Fechando compartimento %s.\n", NOMES_DIAS[job.indice]);
}

// Chamada a cada volta do loop: avanca o movimento sem bloquear.
void atualizarAcionamento() {
  const Compartimento &c = dadosCompartimento(job.indice);
  switch (job.fase) {
    case Fase::LIVRE: return;
    case Fase::ABRINDO:
      if (passoRampa(c.anguloAberto)) {
        job.fase = Fase::ABERTO; job.marco = millis();
        Serial.printf("[SERVO] Aberto; fecha em %lu s.\n", (unsigned long)(job.tempoAbertoMs / 1000));
        char l2[24];
        snprintf(l2, sizeof(l2), "%s fecha em %lus", NOMES_DIAS[job.indice], (unsigned long)(job.tempoAbertoMs / 1000));
        avisar("Gaveta aberta", l2, job.tempoAbertoMs + 1000);
      }
      return;
    case Fase::ABERTO:
      if (millis() - job.marco >= job.tempoAbertoMs) fecharCompartimento();
      return;
    case Fase::FECHANDO:
      if (passoRampa(c.anguloFechado)) { job.fase = Fase::ASSENTANDO; job.marco = millis(); }
      return;
    case Fase::ASSENTANDO:
      if (millis() - job.marco < ASSENTAR_MS) return;
      if (!Hardware::desligarCanal(c.canal)) { falharAcionamento("falha_i2c"); return; }
      Serial.printf("[SERVO] Compartimento %s fechado; PWM desligado.%s\n", NOMES_DIAS[job.indice],
                    job.teste ? " (teste, sem registro)" : " Registrando no site.");
      avisar("Gaveta fechada", job.teste ? "Teste concluido" : "Registrando...", 5000);
      finalizar(REG_ACIONADO, nullptr);
      return;
  }
}

// Interrompe tudo (comando PARAR). Nao comanda retorno: a porta pode ficar aberta.
void pararAcionamento() {
  Hardware::desligarServos();
  if (job.fase != Fase::LIVRE) {
    Serial.println("[SERVO] Interrompido. Sinais desligados; confira a gaveta manualmente.");
    finalizar(REG_FALHA, "parado_manualmente");
  }
}

// ---- Execucao de um horario ----
void processarHorario(const Horario &h, uint32_t horario, bool pedido = false) {
  uint32_t agora = time(nullptr);
  uint8_t indice = indiceDoDia(h.diaSemana);
  Serial.printf("[%s] %s %s %02u:%02u (%u medicamento(s)): iniciando.\n", pedido ? "PEDIDO" : "AGENDA",
                NOMES_DIAS[indice], nomePeriodo(h.periodo), h.minutos / 60, h.minutos % 60, h.medicamentos);
  char l2[24];
  snprintf(l2, sizeof(l2), "%s - %s", NOMES_DIAS[indice], nomePeriodo(h.periodo));
  avisar(pedido ? "Pedido do site" : "Horario program.", l2, 30000);

  // 1. Grava ANTES de qualquer movimento: protege contra reinicio e repeticao.
  gravarRegistro(horario, h.periodo, indice, REG_EM_ANDAMENTO);

  // 2. Com internet, o servidor confirma que o horario ainda nao foi tratado,
  //    que a automacao continua ligada e que ha medicamento programado.
  Evento tentativa = {};
  tentativa.tipo = EV_TENTATIVA; tentativa.periodo = h.periodo; tentativa.horario = horario; tentativa.ocorridoEm = agora;
  bool prosseguir = false;
  Rpc r = registrarEvento(tentativa, prosseguir);
  if (r == Rpc::OK && !prosseguir) {
    Serial.println("[AGENDA] Servidor: este horario ja foi tratado. Gaveta nao sera aberta.");
    gravarRegistro(horario, h.periodo, indice, REG_IGNORADO);
    avisar("Ja processado", "Gaveta fechada");
    return;
  }
  if (r == Rpc::NEGADO || r == Rpc::RECUSADO || r == Rpc::RESPOSTA_INVALIDA) {
    // Ex.: automacao desligada ou medicamento removido no site depois da ultima consulta.
    Serial.printf("[AGENDA] Tentativa nao aceita (%s). Gaveta nao sera aberta.\n", nomeRpc(r));
    gravarRegistro(horario, h.periodo, indice, REG_IGNORADO);
    avisar("Nao autorizado", "Gaveta fechada");
    return;
  }
  if (r != Rpc::OK) {
    // Sem rede ou servidor indisponivel: segue com a agenda local e registra depois.
    Serial.printf("[AGENDA] Servidor indisponivel (%s): executando com a agenda local.\n", nomeRpc(r));
    enfileirarEvento(EV_TENTATIVA, h.periodo, horario, agora, "modo_offline");
  }

  // 3. Movimento (continua em atualizarAcionamento).
  job = Acionamento();
  job.teste = false;
  job.periodo = h.periodo;
  job.horario = horario;
  abrirCompartimento(indice);
}

// Pedido "Liberar agora": abre o compartimento de hoje e registra aquele periodo.
// O registro local (horario + periodo) impede que o horario normal abra de novo.
bool atenderPedido(uint32_t agora) {
  if (bloqueioAcionamento(agora)) return false;
  for (int i = 0; i < totalPedidos; i++) {
    const Pedido p = pedidos[i];
    // Remove da lista antes de executar: cada pedido e tentado uma unica vez.
    memmove(&pedidos[i], &pedidos[i + 1], sizeof(Pedido) * (totalPedidos - i - 1));
    totalPedidos--;
    if (buscarRegistro(p.horario, p.periodo)) return false;
    Horario h = {p.diaSemana, p.periodo, 0, 0, 0};
    struct tm local; time_t t = p.horario; localtime_r(&t, &local);
    h.minutos = local.tm_hour * 60 + local.tm_min;
    for (int j = 0; j < agenda.total; j++)
      if (agenda.itens[j].diaSemana == p.diaSemana && agenda.itens[j].periodo == p.periodo) h.medicamentos = agenda.itens[j].medicamentos;
    processarHorario(h, p.horario, true);
    return true;
  }
  return false;
}

// Procura horarios vencidos. Executa no maximo um por chamada.
void verificarAgenda() {
  if (job.fase != Fase::LIVRE) return;
  uint32_t agora = time(nullptr);
  if (atenderPedido(agora)) return;
  if (bloqueioAutomacao(agora)) return;
  if (!automacaoDesde) { automacaoDesde = agora; salvarAutomacaoDesde(); }

  const Horario *escolhido = nullptr;
  uint32_t horarioEscolhido = 0;
  for (int dia = -1; dia <= 0; dia++) {            // ontem e hoje (horarios perto da meia-noite)
    int semana;
    uint32_t inicio = meiaNoite(agora, dia, semana);
    for (int i = 0; i < agenda.total; i++) {
      const Horario &h = agenda.itens[i];
      if (h.diaSemana != semana) continue;
      uint32_t t = inicio + h.minutos * 60u;
      if (t > agora || agora - t > JANELA_PASSADO_S) continue;
      if (t < h.atualizadoEm) continue;              // horario anterior a ultima alteracao no site
      if (t < automacaoDesde) continue;              // automacao estava desligada nesse horario
      if (buscarRegistro(t, h.periodo)) continue;    // ja tratado
      if (agora - t > TOLERANCIA_ATRASO_S) {
        // Atraso maior que a tolerancia: registra e NAO abre.
        Serial.printf("[AGENDA] %s %s: horario passou da tolerancia; nao sera aberto.\n",
                      NOMES_DIAS[indiceDoDia(h.diaSemana)], nomePeriodo(h.periodo));
        gravarRegistro(t, h.periodo, indiceDoDia(h.diaSemana), REG_PERDIDO);
        enfileirarEvento(EV_PERDIDO, h.periodo, t, agora, "atraso_maior_que_tolerancia");
        continue;
      }
      if (!escolhido || t < horarioEscolhido) { escolhido = &h; horarioEscolhido = t; }
    }
  }
  if (escolhido) processarHorario(*escolhido, horarioEscolhido);
}

// Teste manual (comando TESTE n, n = 1 segunda ... 7 domingo): mesmo ciclo, sem registrar dose.
bool testarCompartimento(int n) {
  if (job.fase != Fase::LIVRE || !Hardware::pcaPronto || n < 1 || n > NUM_COMPARTIMENTOS) return false;
  job = Acionamento();
  job.teste = true;
  abrirCompartimento(uint8_t(n - 1));
  return true;
}

// Depois de um reinicio: horarios que estavam em andamento viram falha e o
// compartimento e fechado uma vez (volta a posicao de repouso).
void recuperarInterrompidos() {
  for (auto &r : registros) {
    if (r.estado != REG_EM_ANDAMENTO) continue;
    r.estado = REG_FALHA;
    salvarRegistros();
    uint8_t n = r.indice;
    Serial.printf("[BOOT] Compartimento %s estava em acionamento quando o aparelho reiniciou.\n",
                  n < NUM_COMPARTIMENTOS ? NOMES_DIAS[n] : "?");
    enfileirarEvento(EV_FALHA, r.periodo, r.horario, r.horario, "reinicio_durante_acionamento");
    // Nao se sabe se a gaveta chegou a abrir: comanda direto a posicao fechada
    // (sem rampa, para nao passar perto da posicao aberta) e corta o PWM depois.
    if (Hardware::pcaPronto && job.fase == Fase::LIVRE && n < NUM_COMPARTIMENTOS) {
      job = Acionamento();
      job.teste = true;  // o registro de falha ja foi feito acima
      job.indice = n;
      job.angulo = dadosCompartimento(n).anguloFechado;
      if (moverCompartimento(n, job.angulo)) {
        job.fase = Fase::ASSENTANDO;
        job.marco = millis();
        avisar("Verificar gaveta", "Reinicio acion.", 15000);
      } else {
        Hardware::desligarServos();
        job.fase = Fase::LIVRE;
      }
    }
  }
}
