const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc } = require('firebase/firestore');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf-8'));
const app = initializeApp(config);
const dbNamed = getFirestore(app, config.firestoreDatabaseId);

async function main() {
  const ref = doc(dbNamed, 'sync', 'tkd_events');
  for (let i=0; i<5; i++) {
    const snap = await getDoc(ref);
    const data = snap.data();
    console.log(`[${new Date().toISOString()}] count:`, data.value.length);
    await new Promise(r => setTimeout(r, 2000));
  }
  process.exit(0);
}
main();
