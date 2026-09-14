#include <Arduino.h>
#include <WiFi.h>
#include <Firebase_ESP_Client.h>
#include <Preferences.h>
#include <time.h>

// mobizt
#include "addons/TokenHelper.h"
#include "addons/RTDBHelper.h"

// panggil file rahasia yang udah dibikin
#include "secrets.h"

FirebaseData fbdoStopkontakStream;
FirebaseData fbdoJadwalStream;
FirebaseData fbdoHeartbeat;
FirebaseData fbdoWork;
FirebaseAuth auth;
FirebaseConfig config;
Preferences schedulePrefs;

const int relayPins[8] = {2, 12, 14, 27, 26, 25, 33, 32};

const unsigned long WIFI_RECONNECT_INTERVAL_MS = 15000;
const unsigned long HEARTBEAT_INTERVAL_MS = 5000;
const unsigned long AUTO_HEAL_STABLE_INTERVAL_MS = 30000;
const unsigned long AUTO_HEAL_RECOVERY_INTERVAL_MS = 5000;
const unsigned long SCHEDULE_SYNC_INTERVAL_MS = 300000;
const unsigned long FIREBASE_STUCK_RESTART_MS = 900000;
const unsigned long STREAM_RETRY_MIN_MS = 3000;
const unsigned long STREAM_RETRY_MAX_MS = 30000;

struct RelaySchedule {
  bool aktif = false;
  int jamNyala = -1;
  int menitNyala = -1;
  int jamMati = -1;
  int menitMati = -1;
  bool hari[7] = {false, false, false, false, false, false, false};
};

RelaySchedule jadwalCache[8];
int relayStateCache[8] = {0, 0, 0, 0, 0, 0, 0, 0};
bool relayDirty[8] = {false, false, false, false, false, false, false, false};

bool stopkontakStreamTerpasang = false;
bool jadwalStreamTerpasang = false;
unsigned long waktuDetakTerakhir = 0;
unsigned long waktuWifiPutus = 0;
unsigned long waktuFirebaseTidakSiap = 0;
unsigned long waktuAutoHealTerakhir = 0;
unsigned long waktuSyncJadwalTerakhir = 0;
unsigned long waktuRetryStopkontakStream = 0;
unsigned long waktuRetryJadwalStream = 0;
unsigned long jedaRetryStopkontakStream = STREAM_RETRY_MIN_MS;
unsigned long jedaRetryJadwalStream = STREAM_RETRY_MIN_MS;
int menitTerakhirDicek = -1;

bool sameSchedule(const RelaySchedule &a, const RelaySchedule &b) {
  if (a.aktif != b.aktif || a.jamNyala != b.jamNyala || a.menitNyala != b.menitNyala ||
      a.jamMati != b.jamMati || a.menitMati != b.menitMati) {
    return false;
  }
  for (int i = 0; i < 7; i++) {
    if (a.hari[i] != b.hari[i]) return false;
  }
  return true;
}

void saveScheduleToFlash(int relayIndex) {
  String key = "sch" + String(relayIndex + 1);
  schedulePrefs.putBytes(key.c_str(), &jadwalCache[relayIndex], sizeof(RelaySchedule));
}

void loadScheduleCache() {
  for (int i = 0; i < 8; i++) {
    String key = "sch" + String(i + 1);
    if (schedulePrefs.getBytesLength(key.c_str()) == sizeof(RelaySchedule)) {
      schedulePrefs.getBytes(key.c_str(), &jadwalCache[i], sizeof(RelaySchedule));
    }
  }
}

unsigned long nextBackoff(unsigned long currentDelay) {
  unsigned long nextDelay = currentDelay * 2;
  if (nextDelay > STREAM_RETRY_MAX_MS) return STREAM_RETRY_MAX_MS;
  return nextDelay;
}

void resetStopkontakStream() {
  if (stopkontakStreamTerpasang) Firebase.RTDB.endStream(&fbdoStopkontakStream);
  stopkontakStreamTerpasang = false;
}

void resetJadwalStream() {
  if (jadwalStreamTerpasang) Firebase.RTDB.endStream(&fbdoJadwalStream);
  jadwalStreamTerpasang = false;
}

bool writeRelayStateToFirebase(int relayNumber, int state) {
  if (!Firebase.ready()) return false;
  return Firebase.RTDB.setInt(&fbdoWork, "/stopkontak/relay" + String(relayNumber), state);
}

void applyRelayState(int relayNumber, int state, bool syncDatabase, bool markDirtyOnFail) {
  if (relayNumber < 1 || relayNumber > 8) return;
  int cleanState = state == 1 ? 1 : 0;
  relayStateCache[relayNumber - 1] = cleanState;
  digitalWrite(relayPins[relayNumber - 1], cleanState == 1 ? LOW : HIGH);

  if (syncDatabase) {
    bool ok = writeRelayStateToFirebase(relayNumber, cleanState);
    relayDirty[relayNumber - 1] = markDirtyOnFail && !ok;
  } else if (markDirtyOnFail) {
    relayDirty[relayNumber - 1] = true;
  }
}

void flushDirtyRelayStates() {
  if (!Firebase.ready()) return;
  for (int i = 0; i < 8; i++) {
    if (relayDirty[i] && writeRelayStateToFirebase(i + 1, relayStateCache[i])) {
      relayDirty[i] = false;
    }
  }
}

void syncStopkontakFromFirebase() {
  flushDirtyRelayStates();
  if (Firebase.RTDB.getJSON(&fbdoWork, "/stopkontak")) {
    FirebaseJson &jsonAwal = fbdoWork.jsonObject();
    for (int i = 1; i <= 8; i++) {
      FirebaseJsonData dataAwal;
      jsonAwal.get(dataAwal, "relay" + String(i));
      if (dataAwal.success && !relayDirty[i - 1]) {
        applyRelayState(i, dataAwal.intValue == 1 ? 1 : 0, false, false);
      }
    }
  }
}

bool readBoolField(FirebaseJson &json, const String &path, bool fallback) {
  FirebaseJsonData data;
  json.get(data, path);
  return data.success ? data.boolValue : fallback;
}

int readIntField(FirebaseJson &json, const String &path, int fallback) {
  FirebaseJsonData data;
  json.get(data, path);
  return data.success ? data.intValue : fallback;
}

void syncJadwalFromFirebase() {
  if (!Firebase.ready()) return;
  if (Firebase.RTDB.getJSON(&fbdoWork, "/jadwal")) {
    FirebaseJson &jsonJadwal = fbdoWork.jsonObject();
    for (int i = 0; i < 8; i++) {
      RelaySchedule nextSchedule;
      String basePath = "relay" + String(i + 1);
      nextSchedule.aktif = readBoolField(jsonJadwal, basePath + "/aktif", false);
      nextSchedule.jamNyala = readIntField(jsonJadwal, basePath + "/jamNyala", -1);
      nextSchedule.menitNyala = readIntField(jsonJadwal, basePath + "/menitNyala", -1);
      nextSchedule.jamMati = readIntField(jsonJadwal, basePath + "/jamMati", -1);
      nextSchedule.menitMati = readIntField(jsonJadwal, basePath + "/menitMati", -1);
      for (int d = 0; d < 7; d++) {
        nextSchedule.hari[d] = readBoolField(jsonJadwal, basePath + "/hari" + String(d), false);
      }
      if (!sameSchedule(jadwalCache[i], nextSchedule)) {
        jadwalCache[i] = nextSchedule;
        saveScheduleToFlash(i);
      }
    }
    waktuSyncJadwalTerakhir = millis();
  }
}

void ensureStreams(unsigned long now) {
  if (!stopkontakStreamTerpasang && now - waktuRetryStopkontakStream >= jedaRetryStopkontakStream) {
    waktuRetryStopkontakStream = now;
    if (Firebase.RTDB.beginStream(&fbdoStopkontakStream, "/stopkontak")) {
      stopkontakStreamTerpasang = true;
      jedaRetryStopkontakStream = STREAM_RETRY_MIN_MS;
      Serial.println("stream stopkontak aktif");
      syncStopkontakFromFirebase();
      waktuAutoHealTerakhir = 0;
    } else {
      Serial.println("gagal stream stopkontak: " + fbdoStopkontakStream.errorReason());
      jedaRetryStopkontakStream = nextBackoff(jedaRetryStopkontakStream);
    }
  }

  if (!jadwalStreamTerpasang && now - waktuRetryJadwalStream >= jedaRetryJadwalStream) {
    waktuRetryJadwalStream = now;
    if (Firebase.RTDB.beginStream(&fbdoJadwalStream, "/jadwal")) {
      jadwalStreamTerpasang = true;
      jedaRetryJadwalStream = STREAM_RETRY_MIN_MS;
      Serial.println("stream jadwal aktif");
      syncJadwalFromFirebase();
    } else {
      Serial.println("gagal stream jadwal: " + fbdoJadwalStream.errorReason());
      jedaRetryJadwalStream = nextBackoff(jedaRetryJadwalStream);
    }
  }
}

void handleStopkontakStream(unsigned long now) {
  if (!stopkontakStreamTerpasang) return;
  if (!Firebase.RTDB.readStream(&fbdoStopkontakStream)) {
    if (now - waktuRetryStopkontakStream >= STREAM_RETRY_MIN_MS) {
      Serial.println("stream stopkontak putus: " + fbdoStopkontakStream.errorReason());
      resetStopkontakStream();
      waktuRetryStopkontakStream = now;
    }
    return;
  }

  if (!fbdoStopkontakStream.streamAvailable()) return;
  String streamPath = fbdoStopkontakStream.dataPath();
  if (streamPath == "/heartbeat") return;

  if (streamPath.startsWith("/relay")) {
    int relayIndex = streamPath.substring(6).toInt();
    if (relayIndex >= 1 && relayIndex <= 8) {
      applyRelayState(relayIndex, fbdoStopkontakStream.intData() == 1 ? 1 : 0, false, false);
    }
  } else if (streamPath == "/" && fbdoStopkontakStream.dataType() == "json") {
    FirebaseJson &json = fbdoStopkontakStream.jsonObject();
    for (int i = 1; i <= 8; i++) {
      FirebaseJsonData jsonData;
      json.get(jsonData, "relay" + String(i));
      if (jsonData.success) {
        applyRelayState(i, jsonData.intValue == 1 ? 1 : 0, false, false);
      }
    }
  }
}

void handleJadwalStream(unsigned long now) {
  if (!jadwalStreamTerpasang) return;
  if (!Firebase.RTDB.readStream(&fbdoJadwalStream)) {
    if (now - waktuRetryJadwalStream >= STREAM_RETRY_MIN_MS) {
      Serial.println("stream jadwal putus: " + fbdoJadwalStream.errorReason());
      resetJadwalStream();
      waktuRetryJadwalStream = now;
    }
    return;
  }

  if (fbdoJadwalStream.streamAvailable()) {
    syncJadwalFromFirebase();
  }
}

void runScheduleEngine() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo)) return;
  if (timeinfo.tm_year < 124) return;
  if (timeinfo.tm_min == menitTerakhirDicek) return;

  for (int i = 0; i < 8; i++) {
    RelaySchedule &jadwal = jadwalCache[i];
    if (!jadwal.aktif || !jadwal.hari[timeinfo.tm_wday]) continue;

    if (jadwal.jamNyala >= 0 && jadwal.menitNyala >= 0 &&
        timeinfo.tm_hour == jadwal.jamNyala && timeinfo.tm_min == jadwal.menitNyala) {
      applyRelayState(i + 1, 1, Firebase.ready(), true);
    }

    if (jadwal.jamMati >= 0 && jadwal.menitMati >= 0 &&
        timeinfo.tm_hour == jadwal.jamMati && timeinfo.tm_min == jadwal.menitMati) {
      applyRelayState(i + 1, 0, Firebase.ready(), true);
    }
  }

  menitTerakhirDicek = timeinfo.tm_min;
}

void runHeartbeat(unsigned long now) {
  if (!stopkontakStreamTerpasang || now - waktuDetakTerakhir < HEARTBEAT_INTERVAL_MS) return;
  Firebase.RTDB.setInt(&fbdoHeartbeat, "/stopkontak/heartbeat", now);
  waktuDetakTerakhir = now;
}

void runAutoHeal(unsigned long now) {
  if (!stopkontakStreamTerpasang) return;
  unsigned long interval = relayDirty[0] || relayDirty[1] || relayDirty[2] || relayDirty[3] ||
                           relayDirty[4] || relayDirty[5] || relayDirty[6] || relayDirty[7]
                           ? AUTO_HEAL_RECOVERY_INTERVAL_MS
                           : AUTO_HEAL_STABLE_INTERVAL_MS;
  if (now - waktuAutoHealTerakhir < interval) return;
  waktuAutoHealTerakhir = now;
  flushDirtyRelayStates();
  syncStopkontakFromFirebase();
}

void handleWifi(unsigned long now) {
  if (WiFi.status() == WL_CONNECTED) {
    waktuWifiPutus = 0;
    return;
  }

  resetStopkontakStream();
  resetJadwalStream();
  if (waktuWifiPutus == 0) waktuWifiPutus = now;

  if (now - waktuWifiPutus >= WIFI_RECONNECT_INTERVAL_MS) {
    WiFi.disconnect();
    WiFi.reconnect();
    waktuWifiPutus = now;
  }
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < 8; i++) {
    pinMode(relayPins[i], OUTPUT);
    digitalWrite(relayPins[i], HIGH);
  }

  schedulePrefs.begin("cairo", false);
  loadScheduleCache();

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
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
  unsigned long now = millis();
  handleWifi(now);
  runScheduleEngine();

  if (WiFi.status() != WL_CONNECTED) {
    delay(5);
    return;
  }

  if (!Firebase.ready()) {
    if (waktuFirebaseTidakSiap == 0) waktuFirebaseTidakSiap = now;
    if (now - waktuFirebaseTidakSiap > FIREBASE_STUCK_RESTART_MS) {
      ESP.restart();
    }
    delay(5);
    return;
  }

  waktuFirebaseTidakSiap = 0;
  ensureStreams(now);
  handleStopkontakStream(now);
  handleJadwalStream(now);
  runHeartbeat(now);
  runAutoHeal(now);

  if (now - waktuSyncJadwalTerakhir >= SCHEDULE_SYNC_INTERVAL_MS) {
    syncJadwalFromFirebase();
  }

  delay(1);
}
