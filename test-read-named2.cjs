const { initializeApp } = require('firebase/app');
const { getFirestore, collection, getDocs } = require('firebase/firestore');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf-8'));
const app = initializeApp(config);
const dbNamed = getFirestore(app, config.firestoreDatabaseId);

async function main() {
  const syncSnap = await getDocs(collection(dbNamed, 'sync'));
  console.log("Documents in 'sync' (Named DB):");
  syncSnap.forEach(doc => {
    // skip bout_queue because it is huge
    if (doc.id === 'tkd_bout_queue') return;
    console.log(" -", doc.id, JSON.stringify(doc.data()).slice(0, 500));
  });

  process.exit(0);
}
main();
