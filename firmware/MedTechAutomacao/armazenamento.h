#pragma once
// Dados que precisam sobreviver a uma reinicializacao, gravados na flash (NVS):
//   agenda     ultima agenda valida recebida do Supabase (inclui a automacao do site)
//   registros  horarios ja tratados (impede acionamento duplicado)
//   fila       eventos ainda nao enviados ao servidor
//   auto_desde momento em que a automacao foi ligada no site
#include <Preferences.h>
#include "config.h"

using MedTechConfig::NUM_COMPARTIMENTOS;

constexpr uint8_t VERSAO_DADOS = 3;  // mude se as estruturas abaixo mudarem
constexpr int MAX_HORARIOS_AGENDA = 21;  // 7 dias x 3 periodos
constexpr int MAX_REGISTROS = 128;
constexpr int MAX_FILA = 24;

// ---- Agenda ----
enum Periodo : uint8_t { MANHA = 0, TARDE = 1, NOITE = 2, SEM_PERIODO = 0xFF };

// Sem bytes de preenchimento: agendasIguais() compara a memoria com memcmp.
struct Horario {
  uint32_t atualizadoEm; // epoch da ultima alteracao no site que afeta este horario
  uint16_t minutos;      // minutos desde 00:00 (Brasilia)
  uint8_t diaSemana;     // 0 = domingo ... 6 = sabado (padrao do relogio e do banco)
  uint8_t periodo;       // Periodo
  uint8_t medicamentos;  // quantos medicamentos o horario tem
  uint8_t solidos;       // capsulas: abrem a gaveta do dia
  uint8_t liquidos;      // liquidos: ligam a bomba
  uint8_t reservado;
};
static_assert(sizeof(Horario) == 12, "Horario nao pode ter preenchimento.");

struct Agenda {
  uint8_t versao;
  bool valida;
  bool automacao;          // ligada/desligada no site
  uint16_t tempoAbertoS;   // tempo com a gaveta aberta (site)
  uint16_t tempoBombaS;    // tempo com a bomba ligada (site)
  uint32_t recebidaEm;     // epoch da ultima sincronizacao com sucesso
  uint8_t total;
  Horario itens[MAX_HORARIOS_AGENDA];
};

// ---- Horarios ja tratados ----
enum EstadoRegistro : uint8_t {
  REG_VAZIO = 0,
  REG_EM_ANDAMENTO = 1,  // gravado ANTES de mover o servo
  REG_ACIONADO = 2,
  REG_FALHA = 3,
  REG_PERDIDO = 4,       // passou da tolerancia; gaveta nao aberta
  REG_IGNORADO = 5       // servidor informou que o horario ja foi tratado (ou recusou)
};

struct Registro {
  uint32_t horario;      // epoch do horario programado
  uint8_t periodo;
  uint8_t indice;        // compartimento do organizador (0 = segunda)
  uint8_t estado;
};

// ---- Eventos pendentes de envio ----
enum TipoEvento : uint8_t { EV_BOOT, EV_ERRO, EV_TENTATIVA, EV_ACIONADO, EV_FALHA, EV_PERDIDO };

struct Evento {
  uint8_t tipo;
  uint8_t periodo;       // SEM_PERIODO para eventos do aparelho (boot/erro)
  uint32_t horario;      // 0 para eventos do aparelho
  uint32_t ocorridoEm;
  char detalhe[32];
  char pedido[37];       // id do pedido "Liberar agora" de um medicamento; vazio nos demais
};

struct Fila {
  uint8_t versao;
  uint8_t total;
  Evento itens[MAX_FILA];
};

Preferences prefs;
Agenda agenda = {};
Registro registros[MAX_REGISTROS] = {};
Fila fila = {};
uint32_t automacaoDesde = 0;  // horarios anteriores a isto nao sao executados nem marcados como perdidos

template <typename T>
bool lerBlob(const char *chave, T &destino) {
  return prefs.getBytesLength(chave) == sizeof(T) && prefs.getBytes(chave, &destino, sizeof(T)) == sizeof(T);
}

void salvarAgenda() { prefs.putBytes("agenda", &agenda, sizeof(agenda)); }
void salvarRegistros() { prefs.putBytes("registros", registros, sizeof(registros)); }
void salvarFila() { prefs.putBytes("fila", &fila, sizeof(fila)); }
void salvarAutomacaoDesde() { prefs.putULong("auto_desde", automacaoDesde); }

void carregarArmazenamento() {
  prefs.begin("medtech", false);
  if (!lerBlob("agenda", agenda) || agenda.versao != VERSAO_DADOS || agenda.total > MAX_HORARIOS_AGENDA) agenda = {};
  agenda.versao = VERSAO_DADOS;
  if (!lerBlob("registros", registros)) memset(registros, 0, sizeof(registros));
  if (!lerBlob("fila", fila) || fila.versao != VERSAO_DADOS || fila.total > MAX_FILA) fila = {};
  fila.versao = VERSAO_DADOS;
  automacaoDesde = prefs.getULong("auto_desde", 0);
}

// ---- Registros ----
Registro *buscarRegistro(uint32_t horario, uint8_t periodo) {
  for (auto &r : registros)
    if (r.estado != REG_VAZIO && r.horario == horario && r.periodo == periodo) return &r;
  return nullptr;
}

// Grava (ou atualiza) o estado de um horario. Reaproveita a posicao mais antiga.
void gravarRegistro(uint32_t horario, uint8_t periodo, uint8_t indice, EstadoRegistro estado) {
  Registro *r = buscarRegistro(horario, periodo);
  if (!r) {
    r = &registros[0];
    for (auto &c : registros) {
      if (c.estado == REG_VAZIO) { r = &c; break; }
      if (c.horario < r->horario) r = &c;
    }
  }
  *r = {horario, periodo, indice, uint8_t(estado)};
  salvarRegistros();
}

// ---- Fila de eventos ----
void enfileirarEvento(TipoEvento tipo, uint8_t periodo, uint32_t horario, uint32_t ocorridoEm, const char *detalhe,
                      const char *pedido = nullptr) {
  if (fila.total >= MAX_FILA) {
    // Fila cheia (muito tempo sem internet): descarta o evento mais antigo.
    memmove(&fila.itens[0], &fila.itens[1], sizeof(Evento) * (MAX_FILA - 1));
    fila.total = MAX_FILA - 1;
    Serial.println("[FILA] Cheia: evento mais antigo descartado.");
  }
  Evento &e = fila.itens[fila.total++];
  e = {};
  e.tipo = tipo; e.periodo = periodo; e.horario = horario; e.ocorridoEm = ocorridoEm;
  strlcpy(e.detalhe, detalhe ? detalhe : "", sizeof(e.detalhe));
  strlcpy(e.pedido, pedido ? pedido : "", sizeof(e.pedido));
  salvarFila();
}

void removerPrimeiroEvento() {
  if (fila.total == 0) return;
  memmove(&fila.itens[0], &fila.itens[1], sizeof(Evento) * (fila.total - 1));
  fila.total--;
  salvarFila();
}
