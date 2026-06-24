const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc } = require('firebase/firestore');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf-8'));
const app = initializeApp(config);
const dbNamed = getFirestore(app, config.firestoreDatabaseId);

async function main() {
  const ref = doc(dbNamed, 'sync', 'tkd_bout_queue');
  const snap = await getDoc(ref);
  const queue = snap.data().value || [];
  const eventIds = new Set();
  queue.forEach(q => eventIds.add(q.data.eventId));
  console.log("Event IDs in bout queue:", Array.from(eventIds));
  process.exit(0);
}
main();
