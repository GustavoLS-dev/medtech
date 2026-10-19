#pragma once
// Comunicacao com o Supabase (supabase/02 e 03):
//   medtech_device_agenda       registra o contato e devolve a agenda do organizador
//   medtech_device_slot_report  registra eventos por horario (idempotente pelo event_uid)
// HTTPS com certificado raiz verificado; nunca setInsecure().
// Nada de token, chave, cabecalhos ou corpo das mensagens no Serial.
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "armazenamento.h"

enum class Rpc { OK, REDE, NEGADO, RECUSADO, SERVIDOR, RESPOSTA_INVALIDA };

// Pedidos "Liberar agora" feitos no site (so em memoria: valem por 2 min no servidor).
struct Pedido {
  uint8_t diaSemana;  // 0 = domingo ... 6 = sabado
  uint8_t periodo;
  uint32_t horario;   // epoch do horario de hoje daquele periodo
};
constexpr int MAX_PEDIDOS = 3;
Pedido pedidos[MAX_PEDIDOS];
uint8_t totalPedidos = 0;

constexpr size_t MAX_RESPOSTA = 8192;
int32_t diferencaRelogio = 0;   // relogio local - relogio do servidor (s)
bool relogioConferido = false;  // diferenca dentro do limite na ultima sincronizacao

const char *nomeRpc(Rpc r) {
  switch (r) {
    case Rpc::OK: return "ok";
    case Rpc::REDE: return "sem rede/TLS";
    case Rpc::NEGADO: return "aparelho nao autorizado";
    case Rpc::RECUSADO: return "recusado pelo servidor";
    case Rpc::SERVIDOR: return "erro temporario do servidor";
    default: return "resposta fora do contrato";
  }
}

// Guarda a resposta com limite de tamanho, mesmo sem Content-Length.
class RespostaLimitada : public Stream {
 public:
  String &texto; bool excedeu = false;
  explicit RespostaLimitada(String &s) : texto(s) {}
  size_t write(uint8_t c) override {
    if (texto.length() >= MAX_RESPOSTA) { excedeu = true; return 0; }
    texto += char(c); return 1;
  }
  using Print::write;
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  void flush() override {}
};

Rpc chamarRpc(const char *funcao, JsonDocument &corpo, JsonDocument &resposta) {
  if (WiFi.status() != WL_CONNECTED) return Rpc::REDE;
  WiFiClientSecure tls;
  tls.setCACert(ROOT_CA_PEM);
  tls.setHandshakeTimeout(15);
  HTTPClient http;
  http.setConnectTimeout(8000);
  http.setTimeout(10000);
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);  // nao entregar a chave a outro host
  if (!http.begin(tls, String(SUPABASE_URL) + "/rest/v1/rpc/" + funcao)) return Rpc::REDE;
  http.addHeader("apikey", SUPABASE_PUBLIC_KEY);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Accept", "application/json");
  http.addHeader("Accept-Encoding", "identity");

  String texto;
  serializeJson(corpo, texto);
  int status = http.POST(texto);
  texto = "";
  Serial.printf("[API] %s: HTTP %d\n", funcao, status);

  Rpc resultado;
  if (status < 0) resultado = Rpc::REDE;
  else if (status == 401 || status == 403) resultado = Rpc::NEGADO;
  else if (status == 429 || status >= 500) resultado = Rpc::SERVIDOR;
  else if (status != 200) resultado = Rpc::RECUSADO;
  else if (http.getSize() > int(MAX_RESPOSTA)) resultado = Rpc::RESPOSTA_INVALIDA;
  else {
    texto.reserve(1024);
    RespostaLimitada destino(texto);
    int recebido = http.writeToStream(&destino);
    if (recebido < 0) resultado = Rpc::REDE;
    else if (destino.excedeu || deserializeJson(resposta, texto, DeserializationOption::NestingLimit(6))) resultado = Rpc::RESPOSTA_INVALIDA;
    else resultado = Rpc::OK;
  }
  http.end();
  return resultado;
}

// ---- Validacao da agenda recebida ----
bool lerHorario(const char *t, uint16_t &minutos) {
  if (!t || strlen(t) != 5 || t[2] != ':') return false;
  for (int i : {0, 1, 3, 4}) if (t[i] < '0' || t[i] > '9') return false;
  int h = (t[0] - '0') * 10 + (t[1] - '0'), m = (t[3] - '0') * 10 + (t[4] - '0');
  if (h > 23 || m > 59) return false;
  minutos = h * 60 + m;
  return true;
}

const char *codigoPeriodo(uint8_t p) {
  static const char *codigos[] = {"morning", "afternoon", "night"};
  return p <= NOITE ? codigos[p] : "";
}

bool lerPeriodo(const char *texto, uint8_t &periodo) {
  for (uint8_t p = MANHA; p <= NOITE; p++)
    if (texto && !strcmp(texto, codigoPeriodo(p))) { periodo = p; return true; }
  return false;
}

// Converte a resposta em Agenda. Qualquer campo fora do contrato invalida
// a resposta inteira: a agenda anterior continua em uso.
bool converterAgenda(JsonDocument &doc, Agenda &nova) {
  if (!doc["timezone"].is<const char *>() || strcmp(doc["timezone"].as<const char *>(), "America/Sao_Paulo") != 0) return false;
  if (!doc["server_time"].is<int64_t>() || !doc["automation_enabled"].is<bool>() ||
      !doc["open_seconds"].is<int>() || !doc["slots"].is<JsonArray>()) return false;
  int tempo = doc["open_seconds"];
  if (tempo < MedTechConfig::TEMPO_ABERTO_MIN_S || tempo > MedTechConfig::TEMPO_ABERTO_MAX_S) return false;
  JsonArray horarios = doc["slots"].as<JsonArray>();
  if (horarios.size() > MAX_HORARIOS_AGENDA) return false;

  nova = {};
  nova.versao = VERSAO_DADOS;
  nova.automacao = doc["automation_enabled"];
  nova.tempoAbertoS = uint16_t(tempo);
  for (JsonObject h : horarios) {
    if (!h["weekday"].is<int>() || !h["medications"].is<int>() || !h["updated_at"].is<int64_t>()) return false;
    int dia = h["weekday"], meds = h["medications"];
    uint8_t periodo; uint16_t minutos;
    if (dia < 0 || dia > 6 || meds < 1 || meds > 255) return false;
    if (!lerPeriodo(h["period"].as<const char *>(), periodo) || !lerHorario(h["time"].as<const char *>(), minutos)) return false;
    for (int i = 0; i < nova.total; i++)
      if (nova.itens[i].diaSemana == dia && nova.itens[i].periodo == periodo) return false;  // repetido
    nova.itens[nova.total++] = {uint8_t(dia), periodo, minutos, uint8_t(meds), uint32_t(h["updated_at"].as<int64_t>())};
  }
  return true;
}

// Le os pedidos da resposta. Campo ausente (banco sem o 03) = nenhum pedido.
bool converterPedidos(JsonDocument &doc, Pedido *destino, uint8_t &total) {
  total = 0;
  if (doc["requests"].isNull()) return true;
  if (!doc["requests"].is<JsonArray>()) return false;
  for (JsonObject p : doc["requests"].as<JsonArray>()) {
    if (!p["weekday"].is<int>() || !p["scheduled_for"].is<int64_t>()) return false;
    int dia = p["weekday"];
    int64_t horario = p["scheduled_for"];
    uint8_t periodo;
    if (dia < 0 || dia > 6 || horario <= 0 || horario % 60 != 0 || !lerPeriodo(p["period"].as<const char *>(), periodo)) return false;
    if (total < MAX_PEDIDOS) destino[total++] = {uint8_t(dia), periodo, uint32_t(horario)};
  }
  return true;
}

bool agendasIguais(const Agenda &a, const Agenda &b) {
  return a.valida == b.valida && a.automacao == b.automacao && a.tempoAbertoS == b.tempoAbertoS &&
         a.total == b.total && memcmp(a.itens, b.itens, sizeof(Horario) * a.total) == 0;
}

// Consulta a agenda. Devolve o resultado para o loop decidir a espera.
Rpc sincronizarAgenda(bool &mudou) {
  mudou = false;
  JsonDocument corpo, resposta;
  corpo["p_token"] = DEVICE_TOKEN;
  corpo["p_firmware"] = MedTechConfig::FIRMWARE_VERSION;
  Rpc r = chamarRpc("medtech_device_agenda", corpo, resposta);

  if (r == Rpc::NEGADO) {
    // Chave trocada ou aparelho desvinculado: para de usar a agenda antiga.
    if (agenda.valida) { agenda = {}; agenda.versao = VERSAO_DADOS; salvarAgenda(); mudou = true; }
    totalPedidos = 0;
    return r;
  }
  if (r != Rpc::OK) return r;

  Agenda nova;
  Pedido novosPedidos[MAX_PEDIDOS];
  uint8_t novosTotal = 0;
  if (!converterAgenda(resposta, nova) || !converterPedidos(resposta, novosPedidos, novosTotal)) return Rpc::RESPOSTA_INVALIDA;
  memcpy(pedidos, novosPedidos, sizeof(Pedido) * novosTotal);
  totalPedidos = novosTotal;

  uint32_t agora = time(nullptr);
  diferencaRelogio = int32_t(int64_t(agora) - resposta["server_time"].as<int64_t>());
  relogioConferido = abs(diferencaRelogio) <= MedTechConfig::DIFERENCA_RELOGIO_MAX_S;

  // Automacao acabou de ser ligada no site: horarios anteriores nao contam como perdidos.
  if (nova.automacao && !(agenda.valida && agenda.automacao)) {
    automacaoDesde = agora;
    salvarAutomacaoDesde();
  }

  nova.valida = true;
  nova.recebidaEm = agora;
  mudou = !agendasIguais(nova, agenda);
  // Grava na flash quando a agenda muda ou a cada 10 min (validade offline apos reiniciar).
  bool gravar = mudou || agora - agenda.recebidaEm >= 600;
  agenda = nova;
  if (gravar) salvarAgenda();
  return r;
}

// ---- Eventos ----
const char *tipoEvento(uint8_t tipo) {
  static const char *nomes[] = {"boot", "error", "attempt", "actuated", "failed", "missed"};
  return tipo <= EV_PERDIDO ? nomes[tipo] : "error";
}

// Identificador estavel: o mesmo evento sempre gera o mesmo uid, entao um
// reenvio depois de falha de rede nao e gravado duas vezes no servidor.
void uidEvento(const Evento &e, char *uid, size_t tamanho) {
  static const char letras[] = "beaxfm";
  static const char periodos[] = "mtn";
  if (e.horario) snprintf(uid, tamanho, "slot-%lu-%c-%c", (unsigned long)e.horario, periodos[e.periodo % 3], letras[e.tipo]);
  else snprintf(uid, tamanho, "dev-%lu-%c", (unsigned long)e.ocorridoEm, letras[e.tipo]);
}

// Envia um evento. "prosseguir" so e verdadeiro quando o servidor criou o
// horario agora (tentativa nova, com automacao ligada e medicamentos).
Rpc registrarEvento(const Evento &e, bool &prosseguir) {
  prosseguir = false;
  char uid[48];
  uidEvento(e, uid, sizeof(uid));
  JsonDocument corpo, resposta;
  corpo["p_token"] = DEVICE_TOKEN;
  corpo["p_event_uid"] = uid;
  corpo["p_event_type"] = tipoEvento(e.tipo);
  char quando[25];
  time_t ocorrido = e.ocorridoEm;
  strftime(quando, sizeof(quando), "%Y-%m-%dT%H:%M:%SZ", gmtime(&ocorrido));
  corpo["p_occurred_at"] = quando;
  if (e.horario) {
    time_t programado = e.horario;
    char horario[25];
    strftime(horario, sizeof(horario), "%Y-%m-%dT%H:%M:%SZ", gmtime(&programado));
    corpo["p_period"] = codigoPeriodo(e.periodo);
    corpo["p_scheduled_for"] = horario;
  }
  if (e.detalhe[0]) corpo["p_detail"] = e.detalhe;

  Rpc r = chamarRpc("medtech_device_slot_report", corpo, resposta);
  if (r == Rpc::OK) {
    if (!resposta["status"].is<const char *>() || !resposta["proceed"].is<bool>()) return Rpc::RESPOSTA_INVALIDA;
    prosseguir = resposta["proceed"].as<bool>() && strcmp(resposta["status"].as<const char *>(), "recorded") == 0;
  }
  return r;
}
