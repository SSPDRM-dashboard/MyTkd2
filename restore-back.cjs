const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc } = require('firebase/firestore');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf-8'));
const app = initializeApp(config);
const db = getFirestore(app, config.firestoreDatabaseId);

async function main() {
  const snap = await getDoc(doc(db, 'sync', 'tkd_events_v2'));
  const data = snap.data();
  if (data && data.value && data.value.length > 0) {
    await setDoc(doc(db, 'sync', 'tkd_events'), data);
    console.log("Restored tkd_events from tkd_events_v2", data.value.length);
  } else {
    console.log("tkd_events_v2 is empty??");
  }
  process.exit(0);
}
main();
