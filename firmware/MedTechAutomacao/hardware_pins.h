#pragma once
// Pinagem preservada dos firmwares MedTechComunicacao e MedTechCalibracao.
// Nao altere sem conferir a fiacao fisica. Sem conflitos entre si:
// LCD 14/27/26/25/33/32, rele 18, I2C 21/22, buzzer 23.
namespace MedTechHardware {
constexpr int LCD_RS = 14, LCD_E = 27, LCD_D4 = 26, LCD_D5 = 25, LCD_D6 = 33, LCD_D7 = 32;
constexpr int RELE = 18;
constexpr int BUZZER = 23;            // + do buzzer (direto ou pela base do transistor); - no GND
constexpr int RELE_LIGADO = LOW;      // bomba ligada (so durante a fase BOMBEANDO)
constexpr int RELE_DESLIGADO = HIGH;
constexpr int SDA_PIN = 21, SCL_PIN = 22;
constexpr int PCA_ADDRESS = 0x40;
constexpr int PULSO_MIN = 110, PULSO_MAX = 510, SERVO_HZ = 50;
}
