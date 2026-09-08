#include <Arduino.h>
#include <WiFi.h>
#include <Firebase_ESP_Client.h>

// panggil lib jam internet bawaan esp32
#include <time.h>

// mobizt
#include "addons/TokenHelper.h"
#include "addons/RTDBHelper.h"

// panggil file rahasia yang udah dibikin
#include "secrets.h"

// siapin objek data firebase khusus buat stream dan heartbeat
FirebaseData fbdoStream;
FirebaseData fbdoHeartbeat;
FirebaseData fbdoJadwal;
FirebaseAuth auth;
FirebaseConfig config;

// daftarpin esp32 buat disambungin kerelay in1 sampe in8
const int relayPins[8] = {2, 12, 14, 27, 26, 25, 33, 32};

// variabel status stream biar ngga bentrok diawal
bool streamTerpasang = false;

// variabel buat nyimpen waktu detak jantung terakhir
unsigned long waktuDetakTerakhir = 0;

// variabel timer jeda pasang ulang stream
unsigned long waktuCobaStreamTerakhir = 0;

// variabel buat nyimpen menit terakhir dicek
int menitTerakhirDicek = -1;

void setup() {
  Serial.begin(115200);
  for(int i = 0; i < 8; i++) {
    pinMode(relayPins[i], OUTPUT);
    digitalWrite(relayPins[i], HIGH);
  }
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  WiFi.setSleep(false);
  Serial.print("nyambungin ke wifi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("konek mantapp!");
  configTime(7 * 3600, 0, "pool.ntp.org", "time.nist.gov");
  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;
  auth.user.email = FIREBASE_EMAIL;
  auth.user.password = FIREBASE_PASSWORD;
  config.token_status_callback = tokenStatusCallback;
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);
}

void loop() {
  // pantau status wifi seketika biar ngga ada soket bengong saat hotspot mati
  if (WiFi.status() != WL_CONNECTED) {
    if (streamTerpasang) {
      streamTerpasang = false;
      Firebase.RTDB.endStream(&fbdoStream);
    }
    return;
  }
  if (Firebase.ready()) {
    unsigned long waktuSekarang = millis();
    // pasang stream seketika pas wifi nyambung trus sinkronkan fisik relay sebelum kirim detak jantung
    if (!streamTerpasang) {
      if (Firebase.RTDB.beginStream(&fbdoStream, "/stopkontak")) {
        streamTerpasang = true;
        Serial.println("jalur stream aktif dan sinkronisasi!");
        // tarik data kondisi terbaru dan terapkan ke relay fisik dengan proteksi digitalread
        if (Firebase.RTDB.getJSON(&fbdoJadwal, "/stopkontak")) {
          FirebaseJson &jsonAwal = fbdoJadwal.jsonObject();
          FirebaseJsonData dataAwal;
          for (int i = 1; i <= 8; i++) {
            jsonAwal.get(dataAwal, "relay" + String(i));
            if (dataAwal.success) {
              int targetState = dataAwal.intValue == 1 ? LOW : HIGH;
              if (digitalRead(relayPins[i - 1]) != targetState) {
                digitalWrite(relayPins[i - 1], targetState);
              }
            }
          }
        }
        // tembak heartbeat pertama tepat setelah relay fisik sukses sinkron
        Firebase.RTDB.setInt(&fbdoHeartbeat, "/stopkontak/heartbeat", waktuSekarang);
        waktuDetakTerakhir = waktuSekarang;
      } else {
        Serial.println("gagal pasang stream: " + fbdoStream.errorReason());
      }
    }
    // baca event stream realtime
    if (streamTerpasang) {
      if (!Firebase.RTDB.readStream(&fbdoStream)) {
        if (fbdoStream.httpCode() <= 0 && (waktuSekarang - waktuCobaStreamTerakhir >= 3000)) {
          waktuCobaStreamTerakhir = waktuSekarang;
          streamTerpasang = false;
        }
      } else if (fbdoStream.streamAvailable()) {
        String streamPath = fbdoStream.dataPath();
        if (streamPath != "/heartbeat") {
          if (streamPath.startsWith("/relay")) {
            int relayIndex = streamPath.substring(6).toInt();
            if (relayIndex >= 1 && relayIndex <= 8) {
              int targetState = fbdoStream.intData() == 1 ? LOW : HIGH;
              if (digitalRead(relayPins[relayIndex - 1]) != targetState) {
                digitalWrite(relayPins[relayIndex - 1], targetState);
              }
            }
          } else if (streamPath == "/") {
            if (fbdoStream.dataType() == "json") {
              FirebaseJson &json = fbdoStream.jsonObject();
              FirebaseJsonData jsonData;
              for (int i = 1; i <= 8; i++) {
                String key = "relay" + String(i);
                json.get(jsonData, key);
                if (jsonData.success) {
                  int targetState = jsonData.intValue == 1 ? LOW : HIGH;
                  if (digitalRead(relayPins[i - 1]) != targetState) {
                    digitalWrite(relayPins[i - 1], targetState);
                  }
                }
              }
            }
          }
        }
      }
    }
    // detak jantung periodik cuma boleh jalan kalau stream sudah terpasang
    if (streamTerpasang && (waktuSekarang - waktuDetakTerakhir >= 3000)) {
      Firebase.RTDB.setInt(&fbdoHeartbeat, "/stopkontak/heartbeat", waktuSekarang);
      waktuDetakTerakhir = waktuSekarang;
      struct tm timeinfo;
      if (getLocalTime(&timeinfo)) {
        if (timeinfo.tm_min != menitTerakhirDicek) {
          if (Firebase.RTDB.getJSON(&fbdoJadwal, "/jadwal")) {
            FirebaseJson &jsonJadwal = fbdoJadwal.jsonObject();
            FirebaseJsonData dataAktif, dataJamNyala, dataMenitNyala, dataJamMati, dataMenitMati, dataHari;
            for (int i = 1; i <= 8; i++) {
              String pathBase = "relay" + String(i);
              jsonJadwal.get(dataAktif, pathBase + "/aktif");
              jsonJadwal.get(dataJamNyala, pathBase + "/jamNyala");
              jsonJadwal.get(dataMenitNyala, pathBase + "/menitNyala");
              jsonJadwal.get(dataJamMati, pathBase + "/jamMati");
              jsonJadwal.get(dataMenitMati, pathBase + "/menitMati");
              String pathHari = pathBase + "/hari" + String(timeinfo.tm_wday);
              jsonJadwal.get(dataHari, pathHari);
              if (dataAktif.success && dataAktif.boolValue && dataHari.success && dataHari.boolValue) {
                if (dataJamNyala.success && dataMenitNyala.success && timeinfo.tm_hour == dataJamNyala.intValue && timeinfo.tm_min == dataMenitNyala.intValue) {
                  Firebase.RTDB.setInt(&fbdoHeartbeat, "/stopkontak/relay" + String(i), 1);
                }
                if (dataJamMati.success && dataMenitMati.success && timeinfo.tm_hour == dataJamMati.intValue && timeinfo.tm_min == dataMenitMati.intValue) {
                  Firebase.RTDB.setInt(&fbdoHeartbeat, "/stopkontak/relay" + String(i), 0);
                }
              }
            }
            menitTerakhirDicek = timeinfo.tm_min;
          }
        }
      }
    }
  }
}