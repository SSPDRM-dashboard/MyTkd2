const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc } = require('firebase/firestore');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf-8'));
const app = initializeApp(config);
const db = getFirestore(app, config.firestoreDatabaseId);

async function main() {
  const eventsSnap = await getDoc(doc(db, 'sync', 'tkd_events'));
  if (eventsSnap.exists()) {
    await setDoc(doc(db, 'sync', 'tkd_events_v3'), eventsSnap.data());
    console.log("Migrated tkd_events to tkd_events_v3");
  }

  const currentEventSnap = await getDoc(doc(db, 'sync', 'tkd_current_event'));
  if (currentEventSnap.exists()) {
    await setDoc(doc(db, 'sync', 'tkd_current_event_v3'), currentEventSnap.data());
    console.log("Migrated tkd_current_event to tkd_current_event_v3");
  }
  process.exit(0);
}
main();
