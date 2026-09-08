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

// variabel buat nyimpen waktu detak jantung terakhir
unsigned long waktuDetakTerakhir = 0;

// variabel buat timer jeda coba nyambungin stream ulang biar ngga nyepam
unsigned long waktuCobaStreamTerakhir = 0;

// variabel baru buat nyimpen menit terakhir dicek biar ngga spam getjson jadwal
int menitTerakhirDicek = -1;

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
  // masukin data loginnyaa ke config biar esp32nyaa dapet izin masuk
  auth.user.email = FIREBASE_EMAIL;
  auth.user.password = FIREBASE_PASSWORD;
  // baris sakti biar library mobizt ngurusin token autentikasi
  config.token_status_callback = tokenStatusCallback;
  // jalanin firebasenyaa pakai data config sama auth yang baru
  Firebase.begin(&config, &auth);
  // ini buat reconnect wifi sama firebasenyaa otomatis kalau terputus
  Firebase.reconnectWiFi(true);
  // buka jalur stream websocket khusus ke stopkontak biar serba instan dan hemat kuota parah
  if (!Firebase.RTDB.beginStream(&fbdoStream, "/stopkontak")) {
    Serial.println("gagal pasang stream awal: " + fbdoStream.errorReason());
  }
}

void loop() {
  if (Firebase.ready()) {
    unsigned long waktuSekarang = millis();
    // baca stream sekalian pulihin otomatis kalau koneksinyaa beku atau putus
    if (!Firebase.RTDB.readStream(&fbdoStream)) {
      // kalau status http minus atau nol berarti jalurnyaa putus trus dikasih jeda tiga detik biar ngga rakus cpu
      if (fbdoStream.httpCode() <= 0 && (waktuSekarang - waktuCobaStreamTerakhir >= 3000)) {
        waktuCobaStreamTerakhir = waktuSekarang;
        Serial.println("stream beku atau putus, pasang ulang: " + fbdoStream.errorReason());
        Firebase.RTDB.beginStream(&fbdoStream, "/stopkontak");
      }
    } else if (fbdoStream.streamAvailable()) {
      String streamPath = fbdoStream.dataPath();
      // abaikan kalau yang berubah cuma data heartbeat kiriman alat sendiri
      if (streamPath != "/heartbeat") {
        // kalau perubahan datanyaa berupa satu relay spesifik kyak /relay1
        if (streamPath.startsWith("/relay")) {
          int relayIndex = streamPath.substring(6).toInt();
          if (relayIndex >= 1 && relayIndex <= 8) {
            int status = fbdoStream.intData();
            digitalWrite(relayPins[relayIndex - 1], status == 1 ? LOW : HIGH);
          }
        } else if (streamPath == "/") {
          // kalau datanyaa dikirim serentak satu objek json stopkontak
          if (fbdoStream.dataType() == "json") {
            FirebaseJson &json = fbdoStream.jsonObject();
            FirebaseJsonData jsonData;
            for (int i = 1; i <= 8; i++) {
              String key = "relay" + String(i);
              json.get(jsonData, key);
              if (jsonData.success) {
                int status = jsonData.intValue;
                digitalWrite(relayPins[i - 1], status == 1 ? LOW : HIGH);
              }
            }
          }
        }
      }
    }
    // ngecek timer lima detik buat ngirim heartbeat sekaligus ngecek jadwalnyaa
    if (waktuSekarang - waktuDetakTerakhir >= 5000) {
      Firebase.RTDB.setInt(&fbdoHeartbeat, "/stopkontak/heartbeat", waktuSekarang);
      waktuDetakTerakhir = waktuSekarang;
      struct tm timeinfo;
      // pastiin ngambil jam lokalnyaa sukses dulu
      if (getLocalTime(&timeinfo)) {
        // cuma eksekusi getjson jadwal pas menitnyaa udah berganti aja
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
                // logika otomatis nyalain relay
                if (dataJamNyala.success && dataMenitNyala.success && timeinfo.tm_hour == dataJamNyala.intValue && timeinfo.tm_min == dataMenitNyala.intValue) {
                  Firebase.RTDB.setInt(&fbdoHeartbeat, "/stopkontak/relay" + String(i), 1);
                }
                // logika otomatis matiin relay
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