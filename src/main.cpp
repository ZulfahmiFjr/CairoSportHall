#include <Arduino.h>
#include <WiFi.h>
#include <Firebase_ESP_Client.h>
// mobizt
#include "addons/TokenHelper.h"
#include "addons/RTDBHelper.h"
// wifinyaa esp32 nih
#define WIFI_SSID "anon"
#define WIFI_PASSWORD "12345678"
// copasin aja dari file index.html
#define API_KEY "AIzaSyCIPJKs36oEABoh_tRbMEpOELhGyx-Bq40"
#define DATABASE_URL "cairosporthall-default-rtdb.asia-southeast1.firebasedatabase.app"
FirebaseData fbdo;
FirebaseData fbdoHeartbeat;
FirebaseAuth auth;
FirebaseConfig config;
// daftarpin esp32 buat disambungin kerelay in1 sampe in8
const int relayPins[8] = {2, 12, 14, 27, 26, 25, 33, 32};
// variabel buat nyimpen waktu detak jantung terakhir
unsigned long waktuDetakTerakhir = 0;
void setup() {
  Serial.begin(115200);
  // setel semuapin jadi tukang ngeluarinsetrum kyak output gitu
  for(int i = 0; i < 8; i++) {
    pinMode(relayPins[i], OUTPUT);
    // karna relaynyaa tipenyaa lowtrigger trus biar mati diawal mending dikasih high
    digitalWrite(relayPins[i], HIGH);
  }
  // nyambungin ke wifi
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("nyambungin ke wifi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("konek mantapp!");
  // nyiapin firebasenyaa
  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;
  config.signer.test_mode = true;
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);
}
void loop() {
  if (Firebase.ready()) {
    unsigned long waktuSekarang = millis();
    // ngirim status kehidupan esp32 tiap lima detik sekali pakai path stopkontak biar ngga diblokir rules
    if (waktuSekarang - waktuDetakTerakhir >= 5000) {
      Firebase.RTDB.setInt(&fbdoHeartbeat, "/stopkontak/heartbeat", waktuSekarang);
      waktuDetakTerakhir = waktuSekarang;
    }
    // ngecekin data firebase buat delapan tombolnyaa berurutan
    for (int i = 1; i <= 8; i++) {
      String path = "/stopkontak/relay" + String(i);
      if (Firebase.RTDB.getInt(&fbdo, path)) {
        int status = fbdo.intData();
        // logika kebalik kyak low trigger gitu
        if (status == 1) {
          digitalWrite(relayPins[i-1], LOW); // bikin nyala
        } else {
          digitalWrite(relayPins[i-1], HIGH); // bikin mati
        }
      }
    }
    delay(500); // kasih jeda dikit biar esp32nyaa ngga capek kerja terus
  }
}