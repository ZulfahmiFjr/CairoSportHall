#include <Arduino.h>
#include <WiFi.h>
#include <Firebase_ESP_Client.h>
#include <Preferences.h>
#include <time.h>

#include "addons/TokenHelper.h"
#include "addons/RTDBHelper.h"
#include "secrets.h"

FirebaseData fbdoCommandStream;
FirebaseData fbdoJadwalStream;
FirebaseData fbdoHeartbeat;
FirebaseData fbdoWork;
FirebaseAuth auth;
FirebaseConfig config;
Preferences schedulePrefs;

const int relayPins[8] = {2, 12, 14, 27, 26, 25, 33, 32};

const unsigned long WIFI_BOOT_WAIT_MS = 20000;
const unsigned long WIFI_RECONNECT_INTERVAL_MS = 5000;
const unsigned long HEARTBEAT_INTERVAL_MS = 2000;
const unsigned long LEGACY_HEARTBEAT_INTERVAL_MS = 6000;
const unsigned long AUTO_HEAL_STABLE_INTERVAL_MS = 15000;
const unsigned long AUTO_HEAL_RECOVERY_INTERVAL_MS = 3000;
const unsigned long SCHEDULE_SYNC_INTERVAL_MS = 180000;
const unsigned long FIREBASE_STUCK_RESTART_MS = 900000;
const unsigned long STREAM_RETRY_MIN_MS = 1000;
const unsigned long STREAM_RETRY_MAX_MS = 15000;

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
int lastAckSeq[8] = {0, 0, 0, 0, 0, 0, 0, 0};
bool relayDirty[8] = {false, false, false, false, false, false, false, false};

bool commandStreamTerpasang = false;
bool jadwalStreamTerpasang = false;
unsigned long waktuDetakTerakhir = 0;
unsigned long waktuLegacyDetakTerakhir = 0;
unsigned long waktuWifiPutus = 0;
unsigned long waktuFirebaseTidakSiap = 0;
unsigned long waktuAutoHealTerakhir = 0;
unsigned long waktuSyncJadwalTerakhir = 0;
unsigned long waktuRetryCommandStream = 0;
unsigned long waktuRetryJadwalStream = 0;
unsigned long jedaRetryCommandStream = STREAM_RETRY_MIN_MS;
unsigned long jedaRetryJadwalStream = STREAM_RETRY_MIN_MS;
int menitTerakhirDicek = -1;

int currentSequence() {
  time_t now = time(nullptr);
  if (now > 1700000000 && now < 2147483000) return (int)now;
  return (int)(millis() / 1000);
}

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
  return nextDelay > STREAM_RETRY_MAX_MS ? STREAM_RETRY_MAX_MS : nextDelay;
}

bool hasDirtyRelay() {
  for (int i = 0; i < 8; i++) {
    if (relayDirty[i]) return true;
  }
  return false;
}

void resetCommandStream() {
  if (commandStreamTerpasang) Firebase.RTDB.endStream(&fbdoCommandStream);
  commandStreamTerpasang = false;
}

void resetJadwalStream() {
  if (jadwalStreamTerpasang) Firebase.RTDB.endStream(&fbdoJadwalStream);
  jadwalStreamTerpasang = false;
}

void setRelayPin(int relayNumber, int state) {
  int cleanState = state == 1 ? 1 : 0;
  relayStateCache[relayNumber - 1] = cleanState;
  digitalWrite(relayPins[relayNumber - 1], cleanState == 1 ? LOW : HIGH);
}

bool writeRelayStatus(int relayNumber, int state, int ackSeq) {
  if (!Firebase.ready()) return false;

  FirebaseJson statusJson;
  statusJson.set("state", state == 1 ? 1 : 0);
  statusJson.set("ackSeq", ackSeq);
  statusJson.set("updatedAt", currentSequence());

  bool okStatus = Firebase.RTDB.setJSON(&fbdoWork, "/status/relay" + String(relayNumber), &statusJson);
  bool okLegacy = Firebase.RTDB.setInt(&fbdoWork, "/stopkontak/relay" + String(relayNumber), state == 1 ? 1 : 0);
  return okStatus && okLegacy;
}

bool writeCommandMirror(int relayNumber, int state, int seq) {
  if (!Firebase.ready()) return false;

  FirebaseJson commandJson;
  commandJson.set("state", state == 1 ? 1 : 0);
  commandJson.set("seq", seq);
  commandJson.set("updatedAt", currentSequence());
  commandJson.set("source", "esp32-schedule");
  return Firebase.RTDB.setJSON(&fbdoWork, "/command/relay" + String(relayNumber), &commandJson);
}

void applyRelayState(int relayNumber, int state, int seq, bool mirrorCommand) {
  if (relayNumber < 1 || relayNumber > 8) return;
  int cleanState = state == 1 ? 1 : 0;
  int cleanSeq = seq > 0 ? seq : currentSequence();

  setRelayPin(relayNumber, cleanState);
  lastAckSeq[relayNumber - 1] = cleanSeq;

  bool ok = writeRelayStatus(relayNumber, cleanState, cleanSeq);
  relayDirty[relayNumber - 1] = !ok;

  if (mirrorCommand) {
    writeCommandMirror(relayNumber, cleanState, cleanSeq);
  }
}

void flushDirtyRelayStates() {
  if (!Firebase.ready()) return;
  for (int i = 0; i < 8; i++) {
    if (relayDirty[i] && writeRelayStatus(i + 1, relayStateCache[i], lastAckSeq[i])) {
      relayDirty[i] = false;
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

void applyCommandFromJson(int relayNumber, FirebaseJson &json, const String &basePath) {
  FirebaseJsonData stateData, seqData;
  json.get(stateData, basePath + "/state");
  json.get(seqData, basePath + "/seq");

  if (!stateData.success) return;
  int state = stateData.intValue == 1 ? 1 : 0;
  int seq = seqData.success ? seqData.intValue : currentSequence();

  if (seq > lastAckSeq[relayNumber - 1] || state != relayStateCache[relayNumber - 1]) {
    applyRelayState(relayNumber, state, seq, false);
  }
}

void syncCommandsFromFirebase() {
  if (!Firebase.ready()) return;
  if (Firebase.RTDB.getJSON(&fbdoWork, "/command")) {
    FirebaseJson &jsonCommand = fbdoWork.jsonObject();
    for (int i = 1; i <= 8; i++) {
      applyCommandFromJson(i, jsonCommand, "relay" + String(i));
    }
  } else if (Firebase.RTDB.getJSON(&fbdoWork, "/stopkontak")) {
    FirebaseJson &jsonLegacy = fbdoWork.jsonObject();
    for (int i = 1; i <= 8; i++) {
      FirebaseJsonData dataAwal;
      jsonLegacy.get(dataAwal, "relay" + String(i));
      if (dataAwal.success) {
        applyRelayState(i, dataAwal.intValue == 1 ? 1 : 0, currentSequence(), true);
      }
    }
  }
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

void publishDeviceOnline() {
  if (!Firebase.ready()) return;
  Firebase.RTDB.setBool(&fbdoWork, "/status/online", true);
  Firebase.RTDB.setInt(&fbdoWork, "/status/lastSeen", currentSequence());
}

void ensureStreams(unsigned long now) {
  if (!commandStreamTerpasang && now - waktuRetryCommandStream >= jedaRetryCommandStream) {
    waktuRetryCommandStream = now;
    if (Firebase.RTDB.beginStream(&fbdoCommandStream, "/command")) {
      commandStreamTerpasang = true;
      jedaRetryCommandStream = STREAM_RETRY_MIN_MS;
      Serial.println("stream command aktif");
      publishDeviceOnline();
      syncCommandsFromFirebase();
      waktuAutoHealTerakhir = 0;
    } else {
      Serial.println("gagal stream command: " + fbdoCommandStream.errorReason());
      jedaRetryCommandStream = nextBackoff(jedaRetryCommandStream);
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

void handleCommandStream(unsigned long now) {
  if (!commandStreamTerpasang) return;
  if (!Firebase.RTDB.readStream(&fbdoCommandStream)) {
    if (now - waktuRetryCommandStream >= STREAM_RETRY_MIN_MS) {
      Serial.println("stream command putus: " + fbdoCommandStream.errorReason());
      resetCommandStream();
      waktuRetryCommandStream = now;
    }
    return;
  }

  if (!fbdoCommandStream.streamAvailable()) return;
  String streamPath = fbdoCommandStream.dataPath();

  if (streamPath.startsWith("/relay") && streamPath.endsWith("/state")) {
    int slashPos = streamPath.indexOf('/', 1);
    int relayNumber = streamPath.substring(6, slashPos).toInt();
    if (relayNumber >= 1 && relayNumber <= 8) {
      syncCommandsFromFirebase();
      return;
    }
  }

  syncCommandsFromFirebase();
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

    int seq = currentSequence();
    if (jadwal.jamNyala >= 0 && jadwal.menitNyala >= 0 &&
        timeinfo.tm_hour == jadwal.jamNyala && timeinfo.tm_min == jadwal.menitNyala) {
      applyRelayState(i + 1, 1, seq, true);
    }

    if (jadwal.jamMati >= 0 && jadwal.menitMati >= 0 &&
        timeinfo.tm_hour == jadwal.jamMati && timeinfo.tm_min == jadwal.menitMati) {
      applyRelayState(i + 1, 0, seq, true);
    }
  }

  menitTerakhirDicek = timeinfo.tm_min;
}

void runHeartbeat(unsigned long now) {
  if (!commandStreamTerpasang || now - waktuDetakTerakhir < HEARTBEAT_INTERVAL_MS) return;
  Firebase.RTDB.setInt(&fbdoHeartbeat, "/status/heartbeat", currentSequence());
  Firebase.RTDB.setInt(&fbdoHeartbeat, "/status/lastSeen", currentSequence());
  waktuDetakTerakhir = now;

  if (now - waktuLegacyDetakTerakhir >= LEGACY_HEARTBEAT_INTERVAL_MS) {
    Firebase.RTDB.setInt(&fbdoHeartbeat, "/stopkontak/heartbeat", now);
    waktuLegacyDetakTerakhir = now;
  }
}

void runAutoHeal(unsigned long now) {
  if (!commandStreamTerpasang) return;
  unsigned long interval = hasDirtyRelay() ? AUTO_HEAL_RECOVERY_INTERVAL_MS : AUTO_HEAL_STABLE_INTERVAL_MS;
  if (now - waktuAutoHealTerakhir < interval) return;
  waktuAutoHealTerakhir = now;
  flushDirtyRelayStates();
  syncCommandsFromFirebase();
}

void handleWifi(unsigned long now) {
  if (WiFi.status() == WL_CONNECTED) {
    waktuWifiPutus = 0;
    return;
  }

  resetCommandStream();
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
  unsigned long startWifi = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startWifi < WIFI_BOOT_WAIT_MS) {
    delay(500);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("konek mantapp!");
  } else {
    Serial.println("wifi belum konek, lanjut mode retry");
  }

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
  handleCommandStream(now);
  handleJadwalStream(now);
  runHeartbeat(now);
  runAutoHeal(now);

  if (now - waktuSyncJadwalTerakhir >= SCHEDULE_SYNC_INTERVAL_MS) {
    syncJadwalFromFirebase();
  }

  delay(1);
}
