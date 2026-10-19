#pragma once
#include <stdint.h>

// ============================================================================
// Configuracao do dispensador. TODOS os ajustes de hardware ficam aqui.
// Horarios de manha/tarde/noite, tempo aberto e automacao sao definidos no site
// (pagina Programacao) e chegam pela agenda.
// ============================================================================
namespace MedTechConfig {

constexpr char FIRMWARE_VERSION[] = "medtech-auto-2.1.0";

// Organizador semanal: um compartimento (servo) por dia.
// Indice 0 = segunda ... 6 = domingo (mesma ordem do site).
constexpr int NUM_COMPARTIMENTOS = 7;

//   canal: saida do PCA9685 (0..7)
//   fechado / aberto: angulo de referencia (0..180), convertido em pulso 110..510.
// VALORES PROVISORIOS: meca cada porta com o firmware MedTechCalibracao e
// ajuste aqui antes de usar com medicamentos.
struct Compartimento {
  uint8_t canal;
  uint8_t anguloFechado;
  uint8_t anguloAberto;
};
constexpr Compartimento COMPARTIMENTOS[NUM_COMPARTIMENTOS] = {
  {0, 0, 90},  // segunda
  {1, 0, 90},  // terca
  {2, 0, 90},  // quarta
  {3, 0, 90},  // quinta
  {4, 0, 90},  // sexta
  {5, 0, 90},  // sabado
  {6, 0, 90},  // domingo
};

// Tempo aberto: vem do site (padrao 60 s). Valores fora deste limite sao recusados.
constexpr uint16_t TEMPO_ABERTO_PADRAO_S = 60;
constexpr uint16_t TEMPO_ABERTO_MIN_S = 5;
constexpr uint16_t TEMPO_ABERTO_MAX_S = 300;

// Movimento suave: passo em graus e intervalo entre passos (sem delay longo).
constexpr uint8_t RAMPA_PASSO_GRAUS = 3;
constexpr uint32_t RAMPA_PASSO_MS = 20;

// Depois de fechar, segura a posicao por este tempo e corta o PWM do canal
// (evita forcar o servo parado se houver bloqueio mecanico).
constexpr uint32_t ASSENTAR_MS = 800;

// Politica de atraso: um horario so e executado ate este tempo depois da hora
// programada. Passado isso (ex.: queda de energia), e registrado como
// "nao aberto" e a gaveta NAO abre.
constexpr uint32_t TOLERANCIA_ATRASO_S = 10 * 60;

// Horarios mais antigos que isto sao ignorados (nem executados, nem registrados).
constexpr uint32_t JANELA_PASSADO_S = 12 * 3600;

// Sem internet, a ultima agenda valida continua em uso por este tempo.
// Depois disso a automacao para ate a proxima sincronizacao.
constexpr uint32_t VALIDADE_AGENDA_S = 24 * 3600;

// Consulta ao Supabase depois de um sucesso; falhas dobram a espera ate o maximo.
// 15 s: o botao "Liberar agora" do site responde rapido (~1-3 MB/h de dados).
constexpr uint32_t CONSULTA_MS = 15000;
constexpr uint32_t CONSULTA_MAX_MS = 300000;

// Diferenca maxima aceita entre o relogio do ESP32 e o do servidor.
constexpr int32_t DIFERENCA_RELOGIO_MAX_S = 120;

// Fuso de Brasilia, sem horario de verao (POSIX: UTC-3).
constexpr char FUSO_POSIX[] = "<-03>3";

// Dia da semana do relogio (tm_wday: 0 = domingo) -> indice do organizador (0 = segunda).
constexpr int indiceDoDia(int diaSemana) { return (diaSemana + 6) % 7; }

// ---- Verificacoes em tempo de compilacao ----
constexpr bool compartimentosValidos() {
  for (int i = 0; i < NUM_COMPARTIMENTOS; i++) {
    const Compartimento &c = COMPARTIMENTOS[i];
    if (c.canal > 7 || c.anguloFechado > 180 || c.anguloAberto > 180 || c.anguloFechado == c.anguloAberto) return false;
    for (int j = 0; j < i; j++)
      if (COMPARTIMENTOS[j].canal == c.canal) return false;
  }
  return true;
}
static_assert(NUM_COMPARTIMENTOS == 7, "O organizador tem um compartimento por dia da semana.");
static_assert(compartimentosValidos(), "Canal repetido, canal acima de 7 ou angulo invalido em COMPARTIMENTOS.");
static_assert(TOLERANCIA_ATRASO_S < JANELA_PASSADO_S, "A tolerancia precisa ser menor que a janela.");
static_assert(indiceDoDia(1) == 0 && indiceDoDia(0) == 6, "Segunda = servo 0, domingo = servo 6.");
}
