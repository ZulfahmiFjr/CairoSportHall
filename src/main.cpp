#include <Arduino.h>
#include <WiFi.h>
#include <Firebase_ESP_Client.h>

// Mobizt
#include "addons/TokenHelper.h"
#include "addons/RTDBHelper.h"

// wifi yg dipake esp32
#define WIFI_SSID "anon"
#define WIFI_PASSWORD "12345678"

// copas dari file index.html
#define API_KEY "AIzaSyCIPJKs36oEABoh_tRbMEpOELhGyx-Bq40"
#define DATABASE_URL "https://cairosporthall-default-rtdb.asia-southeast1.firebasedatabase.app"

FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

// daftar pin ESP32 buat disambung ke relay IN1 sampai IN8
const int relayPins[8] = {13, 12, 14, 27, 26, 25, 33, 32};

void setup() {
  Serial.begin(115200);
  // setel semua pin jadi tukang ngeluarin setrum (output)
  for(int i = 0; i < 8; i++) {
    pinMode(relayPins[i], OUTPUT);
    // karnaa relaynyaa low trigger, dikasih high biar mati di awal
    digitalWrite(relayPins[i], HIGH);
  }
  // konek ke WiFi
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Konek ke WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("Konek Mantap!");
  // siapin Firebasenyaa
  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;
  config.signer.test_mode = true;
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);
}

void loop() {
  if (Firebase.ready()) {
    // ngecek mading firebase buat masing masing 8 tombolnyaa
    for (int i = 1; i <= 8; i++) {
      String path = "/stopkontak/relay" + String(i);
      if (Firebase.RTDB.getInt(&fbdo, path)) {
        int status = fbdo.intData();
        // logika kebalik buat low trigger
        if (status == 1) {
          digitalWrite(relayPins[i-1], LOW); // cetek nyala
        } else {
          digitalWrite(relayPins[i-1], HIGH); // cetek mati
        }
      }
    }
    delay(500); // kasih jeda biar ESP32nyaa ngga kerja teruss
  }
}