const { initializeApp } = require('firebase/app');
const { getFirestore, doc, onSnapshot } = require('firebase/firestore');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf-8'));
const app = initializeApp(config);
const db = getFirestore(app, config.firestoreDatabaseId);

async function main() {
  onSnapshot(doc(db, 'sync', 'tkd_events_v3'), (snap) => {
    console.log(`[tkd_events_v3]`, snap.data()?.value?.length);
  });
  onSnapshot(doc(db, 'sync', 'tkd_current_event_v3'), (snap) => {
    console.log(`[tkd_current_event_v3]`, snap.data()?.value);
  });

  setTimeout(() => {
    console.log("Done listening v3.");
    process.exit(0);
  }, 10000);
}
main();
