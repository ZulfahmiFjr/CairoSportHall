#include <Arduino.h>
#include <WiFi.h>
#include <Firebase_ESP_Client.h>
// mobizt
#include "addons/TokenHelper.h"
#include "addons/RTDBHelper.h"
// wifinyaa esp32 nih
#define WIFI_SSID "zahira"
#define WIFI_PASSWORD "qwerty123"
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
// variabel buat nyimpen waktu cek firebase terakhir
unsigned long waktuCekFirebaseTerakhir = 0;
void setup() {
  Serial.begin(115200);
  // setel semua pin jadi tukang ngeluarin setrum kyak output gitu
  for(int i = 0; i < 8; i++) {
    pinMode(relayPins[i], OUTPUT);
    // karna relaynyaa tipenyaa low trigger trus biar mati diawal mending dikasih high
    digitalWrite(relayPins[i], HIGH);
  }
  // nyambungin ke wifi
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  // perintah ini penting banget biar wifinyaa ngga masuk mode hemat daya trus bikin delay parah
  WiFi.setSleep(false);
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
  // ini buat reconnect wifi sama firebasenyaa otomatis kalau terputus
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
    // ngecekin firebase tiap lima ratus milidetik kyak pengganti delay gitu
    if (waktuSekarang - waktuCekFirebaseTerakhir >= 500) {
      // narik datanyaa sekaligus pakai getjson biar ngga lag trus dipecahpecah buat masingmasing relay
      if (Firebase.RTDB.getJSON(&fbdo, "/stopkontak")) {
        FirebaseJson &json = fbdo.jsonObject();
        FirebaseJsonData jsonData;
        for (int i = 1; i <= 8; i++) {
          String key = "relay" + String(i);
          json.get(jsonData, key);
          if (jsonData.success) {
            int status = jsonData.intValue;
            // logika kebalik kyak low trigger gitu
            if (status == 1) {
              digitalWrite(relayPins[i-1], LOW); // bikin nyala
            } else {
              digitalWrite(relayPins[i-1], HIGH); // bikin mati
            }
          }
        }
      }
      waktuCekFirebaseTerakhir = waktuSekarang;
    }
  }
}