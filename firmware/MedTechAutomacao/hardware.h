#pragma once
// Hardware: PCA9685 (servos), rele da bomba e LCD 16x2.
// PCA9685 por acesso direto aos registradores (mesmo codigo do MedTechCalibracao),
// sem biblioteca adicional. Nenhum pulso e emitido na inicializacao.
#include <Arduino.h>
#include <Wire.h>
#include <LiquidCrystal.h>
#include "hardware_pins.h"
#include "config.h"

namespace Hardware {
using namespace MedTechHardware;

LiquidCrystal lcd(LCD_RS, LCD_E, LCD_D4, LCD_D5, LCD_D6, LCD_D7);
bool pcaPronto = false;
char lcdLinha1[17] = "", lcdLinha2[17] = "";

// ---- Bomba: sempre desligada. Nao existe funcao que a ligue. ----
inline void bombaDesligada() {
  digitalWrite(RELE, RELE_DESLIGADO);
}

inline void iniciarRele() {
  // Nivel inativo antes e depois de configurar a saida.
  digitalWrite(RELE, RELE_DESLIGADO);
  pinMode(RELE, OUTPUT);
  digitalWrite(RELE, RELE_DESLIGADO);
}

// ---- LCD ----
// Ruido eletrico (servos, Wi-Fi, fios longos) pode tirar o LCD de sincronia no
// modo 4 bits e embaralhar as letras. Por isso o display e reiniciado a cada
// texto novo e redesenhado a cada 30 s, mesmo sem mudanca.
constexpr uint32_t LCD_REDESENHO_MS = 30000;
uint32_t lcdUltimoDesenho = 0;

inline void lcdMostrar(const char *linha1, const char *linha2) {
  bool igual = !strncmp(linha1, lcdLinha1, 16) && !strncmp(linha2, lcdLinha2, 16);
  if (igual && millis() - lcdUltimoDesenho < LCD_REDESENHO_MS) return;  // evita piscar
  strncpy(lcdLinha1, linha1, 16); lcdLinha1[16] = 0;
  strncpy(lcdLinha2, linha2, 16); lcdLinha2[16] = 0;
  lcd.begin(16, 2);  // ressincroniza o modo 4 bits
  lcd.clear();
  lcd.setCursor(0, 0); lcd.print(lcdLinha1);
  lcd.setCursor(0, 1); lcd.print(lcdLinha2);
  lcdUltimoDesenho = millis();
}

// ---- PCA9685 ----
bool escrever(uint8_t reg, const uint8_t *dados, size_t n) {
  Wire.beginTransmission(PCA_ADDRESS);
  Wire.write(reg); Wire.write(dados, n);
  return Wire.endTransmission() == 0;
}
bool escreverByte(uint8_t reg, uint8_t dado) { return escrever(reg, &dado, 1); }

// FULL OFF no canal: sem pulso. O servo fica sem forca (nao volta a nenhum angulo).
bool desligarCanal(uint8_t canal) {
  const uint8_t off[] = {0, 0, 0, 0x10};
  return escrever(0x06 + 4 * canal, off, 4);
}

bool desligarServos() {
  bool ok = true;
  for (uint8_t c = 0; c < 16; ++c)
    if (!desligarCanal(c)) ok = false;
  return ok;
}

bool iniciarPca() {
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setTimeOut(20);
  // Todos os canais em FULL OFF antes de configurar o oscilador.
  pcaPronto = desligarServos() && escreverByte(0x00, 0x10)  // sleep
           && escreverByte(0xFE, 121)                       // prescale: 25 MHz / (4096 * 122) ~ 50 Hz
           && escreverByte(0x00, 0x20);                      // acorda, auto-incremento
  if (pcaPronto) {
    delay(5);
    pcaPronto = escreverByte(0x00, 0xA0) && desligarServos();
  }
  return pcaPronto;
}

// Converte o angulo de referencia (0..180) em pulso PULSO_MIN..PULSO_MAX e envia.
bool moverServo(uint8_t canal, int angulo) {
  if (!pcaPronto || canal > 7 || angulo < 0 || angulo > 180) return false;
  uint16_t pulso = PULSO_MIN + long(angulo) * (PULSO_MAX - PULSO_MIN) / 180;
  const uint8_t pwm[] = {0, 0, uint8_t(pulso & 0xFF), uint8_t(pulso >> 8)};
  return escrever(0x06 + 4 * canal, pwm, 4);
}
}  // namespace Hardware
