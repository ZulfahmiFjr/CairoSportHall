#include <Arduino.h>
#include <WiFi.h>
#include <Firebase_ESP_Client.h>
// panggil lib jam internet bawaan esp32
#include <time.h>
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
// variabel buat nyimpen waktu cek jadwal terakhir
unsigned long waktuCekJadwalTerakhir = 0;
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
  // sinkronin jam internet pakai wib utc plus tujuh biar mantap
  configTime(7 * 3600, 0, "pool.ntp.org", "time.nist.gov");
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
    // timer jadwal jalan tiap enam puluh ribu milidetik alias semenit sekali
    if (waktuSekarang - waktuCekJadwalTerakhir >= 60000) {
      struct tm timeinfo;
      // pastiin ngambil jam lokalnyaa sukses dulu
      if (getLocalTime(&timeinfo)) {
        // narik data pengaturan jadwal sekaligus biar kenceng
        if (Firebase.RTDB.getJSON(&fbdo, "/jadwal")) {
          FirebaseJson &jsonJadwal = fbdo.jsonObject();
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
            // pastiin semuanyaa bener bener dapet datanyaa dan jadwalku lagi nyala buat hari ini
            if (dataAktif.success && dataAktif.boolValue && dataHari.success && dataHari.boolValue) {
              // logika nyalain relay
              if (dataJamNyala.success && dataMenitNyala.success && timeinfo.tm_hour == dataJamNyala.intValue && timeinfo.tm_min == dataMenitNyala.intValue) {
                Firebase.RTDB.setInt(&fbdoHeartbeat, "/stopkontak/relay" + String(i), 1);
              }
              // logika matiin relay
              if (dataJamMati.success && dataMenitMati.success && timeinfo.tm_hour == dataJamMati.intValue && timeinfo.tm_min == dataMenitMati.intValue) {
                Firebase.RTDB.setInt(&fbdoHeartbeat, "/stopkontak/relay" + String(i), 0);
              }
            }
          }
        }
      }
      waktuCekJadwalTerakhir = waktuSekarang;
    }
  }
}