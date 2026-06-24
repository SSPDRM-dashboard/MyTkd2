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
    console.log(" -", doc.id, JSON.stringify(doc.data()).slice(0, 100));
  });
  
  const matchSnap = await getDocs(collection(dbNamed, 'matchHistory'));
  console.log("matchHistory count (Named DB):", matchSnap.docs.length);

  process.exit(0);
}
main();
