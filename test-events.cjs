const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc } = require('firebase/firestore');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf-8'));
const app = initializeApp(config);
const dbNamed = getFirestore(app, config.firestoreDatabaseId);

async function main() {
  const ref = doc(dbNamed, 'sync', 'tkd_events');
  const snap = await getDoc(ref);
  console.log("Current tkd_events:", JSON.stringify(snap.data(), null, 2));
  process.exit(0);
}
main();
