// ============================================================================
// MedTech — automacao do dispensador (ESP32 classico + PCA9685 + LCD 16x2)
//
// Organizador semanal: um compartimento por dia (servo 0 = segunda ... 6 = domingo)
// e tres periodos por dia (manha, tarde, noite). Consulta a agenda no Supabase
// a cada 30 s e, no horario de cada periodo, abre o compartimento do dia pelo
// tempo definido no site (padrao 60 s) e fecha. A bomba NUNCA e acionada.
//
// Arquivos:
//   config.h        compartimentos, canais, angulos, tempos e limites
//   hardware_pins.h pinagem (preservada dos firmwares anteriores)
//   secrets.h       Wi-Fi, chave publica e token do aparelho (fora do Git)
//   hardware.h      PCA9685, rele e LCD
//   armazenamento.h agenda, horarios tratados e fila de eventos na flash
//   api.h           HTTPS com o Supabase
//   acionamento.h   regras da agenda e movimento dos servos
//
// A automacao e ligada e desligada no site (pagina Programacao), sem comandos
// no terminal. O Monitor Serial serve so para diagnostico (STATUS, TESTE n, PARAR).
// ============================================================================
#include <Arduino.h>
#include <WiFi.h>
#include <time.h>
#include <esp_sntp.h>
#include "hardware_pins.h"
#include "config.h"
#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "Copie secrets.example.h para secrets.h e preencha a configuracao local."
#endif
#include "hardware.h"
#include "armazenamento.h"
#include "api.h"
#include "acionamento.h"

constexpr uint32_t WIFI_RETRY_MS = 15000;
constexpr uint32_t EPOCH_MINIMO = 1704067200;  // 2024-01-01: antes disso o relogio nao foi acertado

bool configurado = false, wifiConectado = false, bootRegistrado = false;
bool primeiraConsulta = true, ultimaConsultaOk = false;
uint32_t ultimaConsulta = 0, esperaConsulta = CONSULTA_MS, ultimaTentativaWifi = 0;
uint32_t proximoEnvioFila = 0, ultimaVerificacao = 0, ultimoLcd = 0;

void aoSincronizarHora(struct timeval *) { relogioSincronizado = true; }

bool horaValida() { return relogioSincronizado && time(nullptr) > EPOCH_MINIMO; }

// ---- Configuracao local (mesmas regras do MedTechComunicacao) ----
bool marcador(const char *valor) {
  return !valor[0] || strstr(valor, "PREENCHA") || strstr(valor, "SEU-PROJETO");
}

bool configuracaoValida() {
  if (marcador(WIFI_SSID) || marcador(SUPABASE_URL) || marcador(SUPABASE_PUBLIC_KEY) ||
      marcador(DEVICE_TOKEN) || marcador(ROOT_CA_PEM)) return false;
  if (String(WIFI_PASSWORD).indexOf("PREENCHA") >= 0) return false;  // vazia so em rede aberta
  String base(SUPABASE_URL);
  if (!base.startsWith("https://") || base.endsWith("/") || base.indexOf('@') >= 0 || base.indexOf('?') >= 0) return false;
  if (strstr(SUPABASE_PUBLIC_KEY, "sb_secret_") || strlen(DEVICE_TOKEN) != 64) return false;
  for (size_t i = 0; i < 64; i++)
    if (!((DEVICE_TOKEN[i] >= '0' && DEVICE_TOKEN[i] <= '9') || (DEVICE_TOKEN[i] >= 'a' && DEVICE_TOKEN[i] <= 'f'))) return false;
  String raiz(ROOT_CA_PEM);
  return raiz.indexOf("-----BEGIN CERTIFICATE-----") >= 0 && raiz.indexOf("-----END CERTIFICATE-----") >= 0;
}

// ---- Diagnostico ----
void imprimirAgenda() {
  if (!agenda.valida) { Serial.println("[AGENDA] Nenhuma agenda valida."); return; }
  Serial.printf("[AGENDA] %u horario(s) na semana; automacao %s no site; gaveta aberta por %u s.\n",
                agenda.total, agenda.automacao ? "LIGADA" : "DESLIGADA", agenda.tempoAbertoS);
  for (int i = 0; i < agenda.total; i++) {
    const Horario &h = agenda.itens[i];
    uint8_t indice = indiceDoDia(h.diaSemana);
    Serial.printf("  %s %-5s %02u:%02u  servo %u  %u medicamento(s)\n", NOMES_DIAS[indice], nomePeriodo(h.periodo),
                  h.minutos / 60, h.minutos % 60, dadosCompartimento(indice).canal, h.medicamentos);
  }
}

void imprimirStatus() {
  uint32_t agora = time(nullptr);
  const char *bloqueio = bloqueioAutomacao(agora);
  Serial.printf("[STATUS] Firmware %s | Wi-Fi %s | relogio %s", MedTechConfig::FIRMWARE_VERSION,
                wifiConectado ? "conectado" : "desconectado", horaValida() ? "sincronizado" : "NAO sincronizado");
  if (horaValida()) {
    char texto[20]; time_t t = agora; strftime(texto, sizeof(texto), "%d/%m %H:%M:%S", localtime(&t));
    Serial.printf(" (%s, diferenca do servidor %ld s)", texto, (long)diferencaRelogio);
  }
  Serial.println();
  Serial.printf("[STATUS] Automacao %s (site) | PCA9685 %s | eventos na fila: %u\n",
                agenda.valida && agenda.automacao ? "LIGADA" : "DESLIGADA", Hardware::pcaPronto ? "ok" : "SEM RESPOSTA", fila.total);
  if (agenda.valida && horaValida())
    Serial.printf("[STATUS] Ultima agenda recebida ha %lu s (validade %lu s).\n",
                  (unsigned long)(agora - agenda.recebidaEm), (unsigned long)VALIDADE_AGENDA_S);
  Serial.printf("[STATUS] %s\n", bloqueio ? bloqueio : "Pronto para executar horarios.");
  const Horario *h = nullptr;
  uint32_t proximo = horaValida() ? proximoHorario(agora, h) : 0;
  if (proximo && h) {
    char texto[20]; time_t t = proximo; strftime(texto, sizeof(texto), "%d/%m %H:%M", localtime(&t));
    Serial.printf("[STATUS] Proximo horario: %s, %s (compartimento %s).\n", texto, nomePeriodo(h->periodo),
                  NOMES_DIAS[indiceDoDia(h->diaSemana)]);
  }
  imprimirAgenda();
  Serial.println("[STATUS] Bomba: sempre desligada neste firmware.");
}

void imprimirAjuda() {
  Serial.println("Comandos (diagnostico): AJUDA | STATUS | TESTE <1..7> | PARAR | SINCRONIZAR");
  Serial.println("  TESTE n      abre e fecha o compartimento do dia n (1 = segunda ... 7 = domingo), sem registrar dose.");
  Serial.println("  PARAR        corta o sinal de todos os servos (a gaveta pode ficar aberta).");
  Serial.println("  A automacao e ligada e desligada no site, pagina Programacao.");
}

// ---- Comandos do Monitor Serial ----
char linha[48];
size_t tamanhoLinha = 0;

void executarComando(const char *cmd) {
  int n; char extra;
  if (!strcmp(cmd, "AJUDA")) imprimirAjuda();
  else if (!strcmp(cmd, "STATUS")) imprimirStatus();
  else if (!strcmp(cmd, "PARAR")) { pararAcionamento(); Serial.println("[CMD] Sinais dos servos desligados."); }
  else if (!strncmp(cmd, "AUTO", 4)) {
    Serial.println("[CMD] A automacao agora e ligada e desligada no site (pagina Programacao).");
  } else if (!strcmp(cmd, "SINCRONIZAR")) { primeiraConsulta = true; Serial.println("[CMD] Consulta agendada."); }
  else if (sscanf(cmd, "TESTE %d %c", &n, &extra) == 1) {
    if (testarCompartimento(n)) Serial.printf("[CMD] Teste do compartimento %d iniciado.\n", n);
    else Serial.printf("[CMD] Recusado: use 1 (segunda) a %d (domingo), com PCA9685 pronto e nenhum movimento em andamento.\n", NUM_COMPARTIMENTOS);
  } else Serial.println("[CMD] Comando desconhecido. Digite AJUDA.");
}

void lerSerial() {
  while (Serial.available()) {
    char c = char(Serial.read());
    if (c == '\r' || c == '\n') {
      if (tamanhoLinha) { linha[tamanhoLinha] = 0; executarComando(linha); }
      tamanhoLinha = 0;
    } else if (c >= 32 && c <= 126 && tamanhoLinha < sizeof(linha) - 1) {
      linha[tamanhoLinha++] = toupper(c);
    }
  }
}

// ---- Rede ----
void cuidarWifi() {
  bool conectado = WiFi.status() == WL_CONNECTED;
  if (conectado && !wifiConectado) {
    Serial.println("[WiFi] Conectado.");
    primeiraConsulta = true;
  } else if (!conectado && wifiConectado) {
    Serial.println("[WiFi] Conexao perdida. A agenda salva continua valendo por ate 24 h.");
  }
  wifiConectado = conectado;
  if (!conectado && millis() - ultimaTentativaWifi >= WIFI_RETRY_MS) {
    ultimaTentativaWifi = millis();
    WiFi.reconnect();
  }
}

void consultarAgenda() {
  bool mudou = false;
  Rpc r = sincronizarAgenda(mudou);
  ultimaConsulta = millis();
  primeiraConsulta = false;
  ultimaConsultaOk = r == Rpc::OK;

  if (r == Rpc::OK) {
    esperaConsulta = CONSULTA_MS;
    if (!relogioConferido)
      Serial.printf("[HORA] Relogio difere do servidor em %ld s: automacao bloqueada ate corrigir.\n", (long)diferencaRelogio);
    if (mudou) {
      imprimirAgenda();
      char l2[24]; snprintf(l2, sizeof(l2), "%u horario(s)", agenda.total);
      avisar("Agenda atualiz.", l2);
    }
    return;
  }
  esperaConsulta = min(esperaConsulta * 2, CONSULTA_MAX_MS);
  Serial.printf("[API] Agenda nao atualizada: %s. Nova tentativa em %lu s.\n", nomeRpc(r), (unsigned long)(esperaConsulta / 1000));
  if (r == Rpc::NEGADO) {
    Serial.println("[API] Chave recusada: agenda local apagada. Gere uma chave no site e atualize secrets.h.");
    avisar("Nao autorizado", "Gere nova chave", 10000);
  } else {
    avisar("Falha comunic.", agendaEmUso(time(nullptr)) ? "Usando agenda" : "Sem agenda");
  }
}

void enviarFila() {
  if (fila.total == 0 || int32_t(millis() - proximoEnvioFila) < 0) return;
  bool prosseguir;
  Rpc r = registrarEvento(fila.itens[0], prosseguir);
  if (r == Rpc::OK) {
    removerPrimeiroEvento();
    // 2,5 s entre envios: abaixo do limite de 30 eventos/min do servidor.
    proximoEnvioFila = millis() + 2500;
  } else if (r == Rpc::RECUSADO || r == Rpc::RESPOSTA_INVALIDA) {
    Serial.printf("[FILA] Evento descartado: %s.\n", nomeRpc(r));
    removerPrimeiroEvento();
  } else {
    proximoEnvioFila = millis() + 30000;
  }
}

// ---- LCD em repouso ----
void atualizarLcd() {
  if (int32_t(millis() - mensagemAte) < 0 || millis() - ultimoLcd < 1000) return;
  ultimoLcd = millis();
  uint32_t agora = time(nullptr);
  const char *l1 = !configurado ? "Config pendente"
                 : !wifiConectado ? "Sem WiFi"
                 : !horaValida() ? "Sincron. hora"
                 : !ultimaConsultaOk ? "Falha comunic."
                 : "Sistema conect.";
  char l2[24];  // o LCD mostra so os 16 primeiros
  if (!Hardware::pcaPronto) strlcpy(l2, "Falha PCA9685", sizeof(l2));
  else if (!horaValida()) strlcpy(l2, "Aguardando hora", sizeof(l2));
  else if (!agenda.valida) strlcpy(l2, "Sem agenda", sizeof(l2));
  else if (!agendaEmUso(agora)) strlcpy(l2, "Agenda vencida", sizeof(l2));
  else if (!agenda.automacao) strlcpy(l2, "Auto DESLIGADA", sizeof(l2));
  else {
    const Horario *h = nullptr;
    uint32_t proximo = proximoHorario(agora, h);
    if (proximo && h) {
      // Ex.: "Prox Seg 08:00 M"
      struct tm local; time_t t = proximo; localtime_r(&t, &local);
      snprintf(l2, sizeof(l2), "Prox %s %02d:%02d %c", NOMES_DIAS[indiceDoDia(h->diaSemana)],
               local.tm_hour, local.tm_min, nomePeriodo(h->periodo)[0]);
    } else strlcpy(l2, "Sem horarios", sizeof(l2));
  }
  Hardware::lcdMostrar(l1, l2);
}

void setup() {
  Hardware::iniciarRele();  // primeira operacao: bomba desligada
  Serial.begin(115200);
  Hardware::lcd.begin(16, 2);
  Hardware::lcdMostrar("MedTech", "Iniciando");
  Serial.printf("\n[MedTech] %s. Bomba sempre desligada.\n", MedTechConfig::FIRMWARE_VERSION);

  carregarArmazenamento();
  if (Hardware::iniciarPca()) Serial.println("[PCA] PCA9685 pronto; todos os canais sem sinal.");
  else {
    Serial.println("[PCA] PCA9685 nao respondeu em 0x40 (SDA 21, SCL 22). Servos inativos.");
    avisar("Falha PCA9685", "Servos inativos", 10000);
  }
  recuperarInterrompidos();
  Serial.printf("[MedTech] Automacao %s no site (ultima agenda salva). Digite AJUDA para os comandos.\n",
                agenda.valida && agenda.automacao ? "LIGADA" : "DESLIGADA");

  configurado = configuracaoValida();
  if (!configurado) {
    Serial.println("[CONFIG] Preencha secrets.h: Wi-Fi, chave publica, token (64 hex) e raiz TLS. TESTE continua disponivel.");
    return;
  }
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  ultimaTentativaWifi = millis();
  Hardware::lcdMostrar("MedTech", "Conectando WiFi");
  Serial.println("[WiFi] Conectando; credenciais omitidas.");

  sntp_set_time_sync_notification_cb(aoSincronizarHora);
  configTzTime(MedTechConfig::FUSO_POSIX, "pool.ntp.org", "time.google.com");
}

void loop() {
  Hardware::bombaDesligada();
  lerSerial();
  atualizarAcionamento();
  // Nenhuma chamada HTTP enquanto um servo esta em movimento ou aberto.
  if (job.fase != Fase::LIVRE) { delay(2); return; }
  if (!configurado) { atualizarLcd(); delay(20); return; }

  cuidarWifi();
  if (wifiConectado && horaValida()) {
    if (!bootRegistrado) {
      bootRegistrado = true;
      uint32_t agora = time(nullptr);
      enfileirarEvento(EV_BOOT, SEM_PERIODO, 0, agora, MedTechConfig::FIRMWARE_VERSION);
      if (!Hardware::pcaPronto) enfileirarEvento(EV_ERRO, SEM_PERIODO, 0, agora + 1, "falha_i2c");
    }
    if (primeiraConsulta || millis() - ultimaConsulta >= esperaConsulta) consultarAgenda();
    else enviarFila();
  }
  if (millis() - ultimaVerificacao >= 1000) {
    ultimaVerificacao = millis();
    verificarAgenda();
  }
  atualizarLcd();
  delay(5);
}
