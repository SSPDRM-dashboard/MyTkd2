const { initializeApp } = require('firebase/app');
const { getFirestore, doc, onSnapshot } = require('firebase/firestore');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf-8'));
const app = initializeApp(config);
const dbNamed = getFirestore(app, config.firestoreDatabaseId);

async function main() {
  const ref = doc(dbNamed, 'sync', 'tkd_events');
  onSnapshot(ref, (snap) => {
    if (snap.exists()) {
      console.log(`[${new Date().toISOString()}] tkd_events changed, count:`, snap.data().value?.length);
    } else {
      console.log(`[${new Date().toISOString()}] tkd_events deleted!`);
    }
  });

  // Keep alive for 15 seconds
  setTimeout(() => {
    console.log("Done listening.");
    process.exit(0);
  }, 15000);
}
main();
